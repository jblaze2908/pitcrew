// A finished crew reply: prose and inline <Surface> blocks (shared/pui.ts). Each surface is validated and stored like a
// render_surface call and the reply becomes alternating agent and surface events, so everything downstream (previews,
// QUIET folding, Library, the Wall) sees plain text and surface ids. Runs once per completed agentMessage.
import { one, run, now, uid } from "../db.js";
import { validateSurface } from "../surfaces.js";
import { resolveSurface } from "../ledger.js";
import { splitReply } from "../../shared/pui.js";
import { addEvent } from "./threads.js";
import { active } from "./state.js";

/** Validates and stores one surface (an id updates the member's own surface in place); the driver sees a surface event. */
export function saveSurface(botId: string, threadId: string, turnId: string | null | undefined, given: unknown, raw: Record<string, any>) {
  const v = validateSurface(raw);
  if (!v.ok) return { ok: false as const, errors: v.errors };
  const prev = given ? one<{ id: string; saved: number }>("SELECT id, saved FROM surfaces WHERE id=? AND bot_id=?", String(given), botId) : null;
  if (given && !prev) return { ok: false as const, errors: [`No surface ${given} of yours to update; leave out id to make a new one.`] };
  const id = prev?.id || uid("sf");
  if (prev) run("UPDATE surfaces SET title=?, spec=? WHERE id=?", raw.title, JSON.stringify(raw), id);
  else run("INSERT INTO surfaces(id,thread_id,bot_id,title,spec,created_at) VALUES(?,?,?,?,?,?)", id, threadId, botId, raw.title, JSON.stringify(raw), now());
  addEvent(threadId, turnId, "surface", { id, title: raw.title, ...(prev ? { updated: true } : {}) });
  return { ok: true as const, id, updated: !!prev, actions: v.actions || [], saved: prev?.saved ?? 0 };
}

// One automatic fix per thread until a reply renders clean, so a member that keeps getting it wrong can't loop.
const fixing = new Set<string>();

/** Records a completed reply. Synchronous, so its events land before the turn's end; query checks follow async. */
export function addReply(botId: string, threadId: string, turnId: string | null | undefined, text: string, itemId: string) {
  if (!text.includes("<Surface")) { addEvent(threadId, turnId, "agent", { text, itemId }); return; }
  const { segments, errors } = splitReply(text);
  if (!segments.some((s) => s.kind === "surface")) { addEvent(threadId, turnId, "agent", { text, itemId }); return; }
  const problems = [...errors], saved: { id: string; title: string }[] = [];
  for (const seg of segments) {
    if (seg.kind === "md") { const t = seg.text.trim(); if (t) addEvent(threadId, turnId, "agent", { text: t, itemId }); continue; }
    const { id, ...spec } = seg.surface;
    const label = spec.title ? `"${spec.title}"` : "a surface";
    if (!seg.complete) { problems.push(`${label} was never closed with </Surface>`); continue; }
    const r = saveSurface(botId, threadId, turnId, id, spec);
    if (r.ok) saved.push({ id: r.id, title: String(spec.title) }); else problems.push(...r.errors.map((e) => `${label}: ${e}`));
  }
  void checkQueries(botId, saved).then((qs) => {
    const all = [...problems, ...qs];
    if (!all.length) { fixing.delete(threadId); return; }
    if (problems.length) addEvent(threadId, turnId, "system", { text: `A surface didn't render: ${problems[0]}` });
    if (fixing.has(threadId)) return;
    fixing.add(threadId);
    const note = `Your reply's surface had problems. Fix them and show it again${saved.length ? ` (id=${saved[0].id} updates it in place)` : ""}:\n${all.slice(0, 15).join("\n")}`;
    tell(threadId, note).catch(() => {});
  });
}

// A bound surface's queries run once now, so a bad column or an empty result gets fixed instead of seen later.
async function checkQueries(botId: string, saved: { id: string; title: string }[]) {
  const out: string[] = [];
  for (const s of saved) {
    const row = one<{ spec: string }>("SELECT spec FROM surfaces WHERE id=?", s.id);
    const spec = row && JSON.parse(row.spec);
    if (!spec?.queries) continue;
    const shown = await resolveSurface({ id: s.id, spec }, botId).catch(() => null);
    for (const e of shown?.data?.errors || []) out.push(`"${s.title}" query ${e}`);
  }
  return out;
}

// Into the running turn if there is one, else as the next message (queued behind a turn that is just ending).
async function tell(threadId: string, note: string) {
  const T = await import("./turns.js");
  if (active.has(threadId)) { try { if (await T.steerNote(threadId, note)) return; } catch { /* the turn ended under us */ } }
  await T.sendMessage(threadId, { text: `[Pitcrew] ${note}`, mode: "queue", trigger: "surface", display: "Fixing a surface that didn't render" });
}
