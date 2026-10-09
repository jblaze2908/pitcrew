// The Crew Chief as crew manager (a workspace admin with HITL): it reads how every member is set up and doing, and
// proposes SOUL, profile, model and policy changes, retirements and file deletions (the driver approves each), and tidies the crew's suggestions. It never changes another member directly. Private members show their
// setup only: their memory, runs and threads stay with the driver. Per call: a few indexed reads per member.
import { readdirSync, lstatSync, statSync, realpathSync, rmSync } from "node:fs";
import { join, normalize, dirname, basename } from "node:path";
import { one, all, run, now, audit } from "../db.js";
import { getBot, listBots, soulOf, SOUL_MAX, updateBot, retireBot, normaliseSpec, STARTING_POLICY } from "../crew.js";
import { DEFAULT_MODEL } from "../providers.js";
import { botDir } from "../computer.js";
import { memberChanged } from "../engram.js";
import { listSkills } from "./skills.js";
import type { Bot } from "../../shared/types.js";

const findMember = (name: string) => listBots().find((x) => x.kind !== "chief" && (x.name.toLowerCase() === name.toLowerCase() || x.id === name));

export function crewOverview(memberName?: string) {
  const bots = listBots().filter((x) => x.kind !== "chief" && (!memberName || x.name.toLowerCase() === memberName.toLowerCase() || x.id === memberName));
  if (!bots.length) return null;
  const week = now() - 7 * 86400000;
  return bots.map((b) => {
    const skills = listSkills(b.id);
    const lines = [`## ${b.name}${b.private ? " (private)" : ""}: ${b.job || "no job set"}`,
      `SOUL${b.soul?.trim() ? "" : " (default, from job and voice)"}: ${soulOf(b).replace(/\n/g, " ").slice(0, 600)}`,
      b.house_rules?.trim() ? `House rules: ${b.house_rules.replace(/\n/g, "; ").slice(0, 300)}` : "House rules: none",
      `Skills (${skills.length}): ${skills.map((s) => `${s.name} (${s.uses ? `${s.uses} loads` : "never loaded"}${s.stale ? ", stale" : ""})`).join(", ") || "none"}`];
    if (!b.private) {
      const mem = one<{ n: number; c: number }>("SELECT COUNT(*) n, COALESCE(SUM(length(text)),0) c FROM memory WHERE bot_id=? AND forgotten_at IS NULL", b.id)!;
      const runs = all<{ status: string; trigger: string; started_at: number; ended_at: number | null; input_tokens: number }>("SELECT status,trigger,started_at,ended_at,input_tokens FROM turns WHERE bot_id=? ORDER BY started_at DESC LIMIT 5", b.id);
      const retros = one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND trigger='retro' AND started_at>?", b.id, week)!.n;
      const ideas = one<{ n: number }>("SELECT COUNT(*) n FROM improvements WHERE bot_id=? AND status='open'", b.id)!.n;
      lines.push(`Agent memory: ${mem.n} notes, ${mem.c} / 3000 chars`,
        `Last runs: ${runs.map((r) => `${r.trigger} ${r.status} ${r.ended_at ? Math.round((r.ended_at - r.started_at) / 1000) : "?"}s ${Math.round(r.input_tokens / 1000)}k`).join("; ") || "none"}`,
        `Retros this week: ${retros}; open suggestions: ${ideas}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

// A SOUL rewrite for the driver to approve (pit stop kind "soul"); approving applies it (pitstops.ts).
export function soulProposal(memberName: string, soul: string, why: string) {
  // The Chief may propose its own SOUL too; the driver approves it like any other (retirement still never applies to it).
  const n = memberName.trim().toLowerCase();
  const b = findMember(memberName) || listBots().find((x) => x.kind === "chief" && (x.id === n || x.name.toLowerCase() === n || n === "crew chief" || n === "chief"));
  if (!b) return { error: `No crew member called "${memberName}".` };
  const text = soul.trim();
  if (!text) return { error: "The SOUL is empty." };
  if (text.length > SOUL_MAX) return { error: `A SOUL is at most ${SOUL_MAX} chars (this is ${text.length}).` };
  return { bot: b, detail: { member: b.id, memberName: b.name, before: b.soul || "", soul: text, why: why.slice(0, 600) } };
}
export function applySoul(detail: { member?: string; soul?: string }) {
  if (detail.member && typeof detail.soul === "string" && getBot(detail.member)) { updateBot(detail.member, { soul: detail.soul } as any); audit("driver", "soul.applied", { botId: detail.member }); }
}

// A retirement for the driver to approve (pit stop kind "retire"); approving retires the member (pitstops.ts).
export function retireProposal(memberName: string, why: string) {
  const b = findMember(memberName);
  if (!b) return { error: `No crew member called "${memberName}".` };
  if (!why.trim()) return { error: "Say why: the evidence the member is no longer needed." };
  const schedules = one<{ n: number }>("SELECT COUNT(*) n FROM schedules WHERE bot_id=? AND enabled=1", b.id)!.n;
  return { bot: b, detail: { member: b.id, memberName: b.name, job: b.job || "", schedules, why: why.trim().slice(0, 600) } };
}
export function applyRetire(detail: { member?: string }) {
  if (detail.member) retireBot(detail.member, "driver");
}

// What the Chief may change on a member. Privacy, household access and connectors stay the driver's own settings:
// each widens what data a member (or the Chief) can reach. The SOUL has its own tool (propose_soul).
const EDITABLE = ["name", "job", "house_rules", "hue", "shape", "personality", "provider", "model", "weekly_cap_usd", "policy", "engram_scope"];
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
// A profile change for the driver to approve (pit stop kind "member"): normalised the way updateBot will apply it, and
// trimmed to the fields that actually change, so the card shows exactly what approving does.
export function memberChange(memberName: string, changes: unknown, why: string) {
  const b = findMember(memberName);
  if (!b) return { error: `No crew member called "${memberName}".` };
  if (!why.trim()) return { error: "Say why: the evidence for the change." };
  const ch = (changes && typeof changes === "object" ? changes : {}) as Record<string, any>;
  const refused = Object.keys(ch).filter((k) => !EDITABLE.includes(k));
  if (refused.length) return { error: `Not yours to change: ${refused.join(", ")}.${refused.includes("soul") ? " For the SOUL use propose_soul." : ""} You can change ${EDITABLE.join(", ")}. Privacy, household access and connectors stay with the driver.` };
  const n = normaliseSpec({ ...b, ...ch, personality: { ...b.personality, ...(ch.personality || {}) } });
  if ("provider" in ch && !("model" in ch) && n.provider !== b.provider) n.model = DEFAULT_MODEL[n.provider];
  const patch: Record<string, any> = {}, diff: { field: string; before: string; after: string }[] = [];
  const set = (field: string, before: unknown, after: unknown) => { if (show(before) !== show(after)) { patch[field] = after; diff.push({ field, before: show(before), after: show(after) }); } };
  for (const k of ["name", "job", "hue", "shape", "provider", "model", "weekly_cap_usd", "engram_scope"] as const)
    if (k in ch || (k === "model" && "provider" in ch)) set(k, (b as any)[k], (n as any)[k]);
  if ("personality" in ch) set("personality", b.personality, n.personality);
  if ("house_rules" in ch) set("house_rules", b.house_rules, String(ch.house_rules ?? "").trim().slice(0, 3000));
  // Same rule updateBot enforces: known effects, allow/ask only, and never allow for delete, share or pay.
  const policy: Record<string, string> = {};
  for (const [k, v] of Object.entries(ch.policy || {}) as [string, any][]) {
    if (!(k in STARTING_POLICY) || !["allow", "ask"].includes(v)) return { error: `Policy ${k}=${v}: use a known effect (${Object.keys(STARTING_POLICY).join(", ")}) with allow or ask.` };
    if (v === "allow" && ["delete", "share", "pay"].includes(k)) return { error: `${k} always asks the driver; it can't be set to allow.` };
    if ((b.policy as Record<string, string>)[k] !== v) { policy[k] = v; diff.push({ field: `policy.${k}`, before: (b.policy as Record<string, string>)[k], after: v }); }
  }
  if (Object.keys(policy).length) patch.policy = policy;
  if (!diff.length) return { error: "Nothing would change." };
  return { bot: b, detail: { member: b.id, memberName: b.name, patch, diff, why: why.trim().slice(0, 600) } };
}
export function applyMemberChange(detail: { member?: string; patch?: Record<string, unknown> }) {
  if (!detail.member || !detail.patch || !getBot(detail.member)) return;
  const b = updateBot(detail.member, detail.patch);
  if ("engram_scope" in detail.patch) memberChanged(b);
}

// A member's workspace (/bot/work on its computer, botDir/work on the host). Private members' files stay with the driver.
function workBase(b: Bot) { try { return realpathSync(`${botDir(b.id)}/work`); } catch { return null; } }
// Resolves rel inside base without following a final symlink, so deleting a link never deletes its target.
function inWork(base: string, rel: string) {
  const r = normalize(String(rel).replace(/^\/bot\/work\/?/, "").replace(/^\/+/, ""));
  if (!r || r === "." || r.split("/").some((seg) => seg === ".." || seg === ".git")) return null;
  let parent: string; try { parent = realpathSync(dirname(join(base, r))); } catch { return null; }
  if (parent !== base && !parent.startsWith(base + "/")) return null;
  const full = join(parent, basename(r));
  try { const st = lstatSync(full); return { path: full.slice(base.length + 1), full, dir: st.isDirectory(), size: st.size }; } catch { return null; }
}
// One directory of a member's workspace, for the Chief to pick what to clean up. Per call: one readdir and a stat per entry.
export function memberFiles(memberName: string, path = "") {
  const b = findMember(memberName);
  if (!b) return { error: `No crew member called "${memberName}".` };
  if (b.private) return { error: `${b.name} is private; its files stay with the driver.` };
  const base = workBase(b); if (!base) return { error: `${b.name} has no workspace yet.` };
  const at = path.trim() ? inWork(base, path) : { path: "", full: base, dir: true, size: 0 };
  if (!at?.dir) return { error: `No folder ${path} in ${b.name}'s workspace.` };
  const ents = readdirSync(at.full, { withFileTypes: true }).filter((e) => e.name !== ".git").slice(0, 300).map((e) => {
    let st: import("node:fs").Stats | null = null; try { st = statSync(join(at.full, e.name)); } catch {}
    return e.isDirectory() ? `${e.name}/` : `${e.name} · ${st?.size ?? 0} B · ${st ? new Date(st.mtimeMs).toISOString().slice(0, 10) : "?"}`;
  });
  return { text: `${b.name}:/bot/work/${at.path}\n${ents.join("\n") || "(empty)"}` };
}
// A deletion for the driver to approve (pit stop kind "files"); approving deletes them, folders with their contents.
export function fileDeletion(memberName: string, paths: unknown, why: string) {
  const b = findMember(memberName);
  if (!b) return { error: `No crew member called "${memberName}".` };
  if (b.private) return { error: `${b.name} is private; its files stay with the driver.` };
  if (!why.trim()) return { error: "Say why the files should go." };
  const list = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean);
  if (!list.length || list.length > 50) return { error: "Pass 1 to 50 paths inside the member's /bot/work." };
  const base = workBase(b); if (!base) return { error: `${b.name} has no workspace yet.` };
  const found = list.map((p) => ({ p, at: inWork(base, p) }));
  const bad = found.filter((x) => !x.at).map((x) => x.p);
  if (bad.length) return { error: `Not in ${b.name}'s workspace (or not deletable: the workspace itself, .git): ${bad.join(", ")}` };
  return { bot: b, detail: { member: b.id, memberName: b.name, paths: found.map((x) => ({ path: x.at!.path, dir: x.at!.dir, size: x.at!.size })), why: why.trim().slice(0, 600) } };
}
// Re-resolved at approval: whatever moved or went in the meantime is skipped, never chased.
export function applyFileDeletion(detail: { member?: string; paths?: { path: string }[] }) {
  const b = detail.member ? getBot(detail.member) : undefined; if (!b) return;
  const base = workBase(b); if (!base) return;
  const done: string[] = [];
  for (const { path } of detail.paths || []) { const at = inWork(base, path); if (at) { rmSync(at.full, { recursive: true, force: true }); done.push(at.path); } }
  audit("driver", "files.deleted", { botId: b.id, paths: done });
}

// Folds one open suggestion into another (its evidence and votes move over) or adds evidence; accepting and dismissing
// stay with the driver.
export function triageSuggestion(id: string, { mergeInto = null, note = "" }: { mergeInto?: string | null; note?: string }) {
  const s = one<{ id: string; evidence: string; votes: number; title: string }>("SELECT id,evidence,votes,title FROM improvements WHERE id=? AND status='open'", id);
  if (!s) return "No open suggestion with that id.";
  if (mergeInto) {
    const t = one<{ id: string; evidence: string }>("SELECT id,evidence FROM improvements WHERE id=? AND status='open'", mergeInto);
    if (!t || t.id === s.id) return "No other open suggestion with that id to merge into.";
    run("UPDATE improvements SET votes=votes+?, evidence=?, updated_at=? WHERE id=?", s.votes, `${t.evidence}\n— merged “${s.title}”: ${s.evidence}`.slice(-4000), now(), t.id);
    run("UPDATE improvements SET status='merged', updated_at=? WHERE id=?", now(), s.id);
    return `Merged into ${t.id}.`;
  }
  if (!note.trim()) return "Pass merge_into or a note.";
  run("UPDATE improvements SET evidence=?, updated_at=? WHERE id=?", `${s.evidence}\n— Chief: ${note.trim()}`.slice(-4000), now(), s.id);
  return "Note added.";
}
export const openSuggestions = () => all<{ id: string; title: string; area: string; votes: number; bot_id: string }>("SELECT id,title,area,votes,bot_id FROM improvements WHERE status='open' ORDER BY votes DESC, updated_at DESC LIMIT 40");
