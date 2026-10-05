// Threads and the front door: asking, routing and rerouting, messages, uploads, surfaces and plans.
import { Hono } from "hono";
import { z } from "zod";
import { one, all, run, now, uid, json, audit } from "../db.js";
import { httpErr } from "../auth.js";
import * as R from "../runtime/index.js";
import { routeMessage, SURE, namedMembers, type Candidate } from "../router.js";
import { getBot, listBots } from "../crew.js";
import { signedIn, type Env } from "../http/guard.js";
import { readBody, jsonBody, raw, text, trimmed, flag, truthy, given, field, pick } from "../http/body.js";
import { AUTONOMY, newThreadAutonomy, type Autonomy } from "../runtime/autonomy.js";
import { addEvent } from "../runtime/threads.js";
import { threadView } from "./views.js";
import { resolveSurface } from "../ledger.js";
import { nameFromConversation } from "../runtime/titles.js";
import type { Ask, Origin, PlanStatus, RoutePick } from "../../shared/types.js";
import type { SurfaceRow, ThreadRow } from "../models.js";

const NewThread = z.object({ botId: raw, title: text(120, "New thread") });
const AskBody = z.object({ text: trimmed(20000), botId: raw, dry: raw, crew: raw });
const Reroute = z.object({ botId: raw });
const AUTONOMY_NOTE: Record<Autonomy, string> = {
  ask: "Ask first: this thread asks before sending, paying, signing in, installing, sharing, deleting or opening a new site.",
  handsfree: "Hands-free: this thread only stops for paying, signing in, sending, sharing, deleting, and sites that look like another or aren't https, or anything that might break a house rule.",
  yolo: "YOLO: this thread runs without pit stops, paying and sending included. Only the safety check's hard blocks, blocked sites and anything that might break a house rule still stop it.",
};
const ThreadEdit = z.object({ title: truthy((v) => String(v).slice(0, 120)), archived: given((v) => (v ? 1 : 0)), pinned: given((v) => (v ? 1 : 0)), autonomy: pick(AUTONOMY, undefined) });
const Message = z.object({ text: raw, attachments: field((v): string[] => (Array.isArray(v) ? v.filter((a) => /^uploads\/[\w.-]+$/.test(a)) : [])), mode: raw,
  edit: z.object({ image: z.string().max(300), mask: z.string().max(300).nullish(), marked: z.string().max(300).nullish(), model: z.string().max(120).nullish(),
    pins: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), note: z.string().max(200) })).max(9).optional() }).nullish() });
const SurfaceAction = z.object({ action: raw, values: field((v): Record<string, unknown> => (v && typeof v === "object" ? v : {})) });
const Save = z.object({ saved: flag });
const SideBody = z.object({ question: trimmed(2000), history: field((v): { q: string; a: string }[] => (Array.isArray(v) ? v.slice(-4).map((h) => ({ q: String(h?.q || "").slice(0, 500), a: String(h?.a || "").slice(0, 800) })) : [])) });
const REWIND_MODES = ["both", "chat", "files"] as const;
const rewindMode = (v: unknown): R.RewindMode => (REWIND_MODES as readonly unknown[]).includes(v) ? v as R.RewindMode : "both";
const RewindBody = z.object({ mode: pick(REWIND_MODES, "both") });

// Front door: one message, routed to the member whose job covers it. Unsure → the driver picks from the top candidates.
function openRouted(botId: string, text: string, origin: Origin) {
  const id = uid("th");
  run("INSERT INTO threads(id,bot_id,title,origin,autonomy,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, botId, "New thread", JSON.stringify(origin), newThreadAutonomy(), now(), now());
  return R.sendMessage(id, { text }).then(() => ({ threadId: id, botId }));
}

type ListRow = { id: string; bot_id: string; title: string; status: string; pinned: number; archived: number; created_at: number; updated_at: number };
/** The Threads page: every member's threads, newest first, with the last thing said. One query for the rows, one for
 *  their last lines; a search runs findThreads once per member (crews are small). */
function listAll(q: string, bot: string | null, archived: boolean) {
  let rows: (ListRow & { snippet?: string })[];
  if (q.trim()) {
    const bots = bot ? listBots().filter((b) => b.id === bot) : listBots();
    const hits = bots.flatMap((b) => R.findThreads(b.id, q, { limit: 50 }).map((f) => ({ ...f, bot_id: b.id })));
    const ids = hits.map((h) => h.id);
    const meta = ids.length ? new Map(all<ListRow>(`SELECT id,bot_id,title,status,pinned,archived,created_at,updated_at FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).map((r) => [r.id, r])) : new Map();
    rows = hits.map((h) => ({ ...meta.get(h.id)!, snippet: h.snippet || undefined })).filter((r) => r.id && !!r.archived === archived);
  } else rows = all<ListRow>(`SELECT id,bot_id,title,status,pinned,archived,created_at,updated_at FROM threads WHERE archived=?${bot ? " AND bot_id=?" : ""} ORDER BY updated_at DESC LIMIT 300`, archived ? 1 : 0, ...(bot ? [bot] : []));
  const need = rows.filter((r) => !r.snippet).map((r) => r.id);
  if (need.length) {
    const last = all<{ thread_id: string; data: string }>(`SELECT thread_id, data FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind IN ('agent','user') AND thread_id IN (${need.map(() => "?").join(",")}) GROUP BY thread_id)`, ...need);
    const by = new Map(last.map((l) => [l.thread_id, String(json(l.data, {}).text || "").replace(/[*_`#>]+|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 180)]));
    for (const r of rows) if (!r.snippet) r.snippet = by.get(r.id) || "";
  }
  return rows;
}

export const threadRoutes = new Hono<Env>()
  .get("/api/threads", signedIn, (c) => c.json(listAll(c.req.query("q") || "", c.req.query("bot") || null, c.req.query("archived") === "1")))
  .post("/api/threads", signedIn, async (c) => {
    const b = await jsonBody(c, NewThread); if (!getBot(b.botId as string)) throw httpErr(404, "No such crew member");
    const id = uid("th"); run("INSERT INTO threads(id,bot_id,title,autonomy,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.botId as string, b.title, newThreadAutonomy(), now(), now());
    return c.json({ id });
  })
  .post("/api/ask", signedIn, async (c) => {
    const b = await jsonBody(c, AskBody), text = b.text;
    if (!text) throw httpErr(400, "Say something");
    if (b.botId) {
      const to = getBot(b.botId as string); if (!to || to.archived) throw httpErr(404, "No such crew member");
      audit("driver", "ask.routed", { botId: to.id, by: "driver" });
      return c.json(await openRouted(to.id, text, { kind: "routed", by: "driver" }));
    }
    // dry: routing only, no thread. A dry run may pass a hypothetical crew ([{name, job}]) to try the router before hiring.
    const crew: Candidate[] = b.dry && Array.isArray(b.crew) ? [listBots().find((x) => x.kind === "chief")!, ...b.crew.slice(0, 20).map((x, i) => ({ id: `try${i}`, kind: "specialist", name: String(x.name).slice(0, 60), job: String(x.job || "").slice(0, 300) }))] : listBots();
    const named = namedMembers(text, crew);
    const pick: RoutePick = named.length > 1 ? { botId: crew.find((x) => x.kind === "chief")!.id, confidence: null, alternatives: [], by: "names" }
      : named.length === 1 ? { botId: named[0].id, confidence: null, alternatives: [], by: "named" } : await routeMessage(text, crew);
    pick.named = named.map((x) => x.id);
    if (b.dry) return c.json({ ...pick, name: crew.find((x) => x.id === pick.botId)?.name, alternatives: pick.alternatives.map((a) => ({ ...a, name: crew.find((x) => x.id === a.botId)?.name })) });
    const sure = pick.confidence == null || pick.confidence >= SURE || !pick.alternatives.length;
    audit("driver", "ask.routed", { botId: pick.botId, by: pick.by, confidence: pick.confidence, ms: pick.ms, asked: !sure });
    if (!sure) return c.json({ choose: [pick.botId, ...pick.alternatives.map((a) => a.botId)] });
    return c.json(await openRouted(pick.botId, text, { kind: "routed", by: pick.by, confidence: pick.confidence }));
  })
  // Your asks on the Pit wall: the latest front-door threads with their live state and a short answer. Per wall render:
  // one indexed query, then two small reads per row (8 rows max).
  .get("/api/asks", signedIn, (c) => c.json(all<Pick<ThreadRow, "id" | "bot_id" | "title" | "status" | "origin" | "updated_at">>(`SELECT id,bot_id,title,status,origin,updated_at FROM threads WHERE archived=0 AND origin LIKE '{"kind":"routed"%' ORDER BY updated_at DESC LIMIT 8`).map((t): Ask => {
    const last = json(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", t.id)?.data, {});
    const plan = one<{ id: string; status: PlanStatus }>("SELECT id,status FROM plans WHERE thread_id=? ORDER BY created_at DESC LIMIT 1", t.id);
    const items = plan ? all<{ owner_bot: string; status: string }>("SELECT owner_bot,status FROM plan_items WHERE plan_id=? AND status!='cancelled'", plan.id) : [];
    return { id: t.id, botId: t.bot_id, title: t.title, status: t.status, running: R.isRunning(t.id), updatedAt: t.updated_at, origin: json(t.origin, {}), answer: last.text ? last.text.slice(0, 280) : null,
      plan: plan && { status: plan.status, members: [...new Set(items.map((i) => i.owner_bot))], done: items.filter((i) => i.status === "done").length, total: items.length } };
  })))
  .post("/api/plans/:id/stop", signedIn, (c) => c.json({ ok: R.stopPlan(c.req.param("id")) }))
  // "Change": the message moves to another member; the first thread stops and is archived. Audited, so routing accuracy can be measured.
  .post("/api/threads/:id/reroute", signedIn, async (c) => {
    const id = c.req.param("id"), b = await jsonBody(c, Reroute), t = R.getThread(id), to = getBot(b.botId as string);
    if (!t) throw httpErr(404, "No such thread");
    if (!to || to.archived) throw httpErr(404, "No such crew member");
    const first = json(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id LIMIT 1", id)?.data, {});
    if (!first.text) throw httpErr(400, "Nothing to move");
    await R.interrupt(id).catch(() => {});
    run("UPDATE threads SET archived=1 WHERE id=?", id);
    audit("driver", "ask.rerouted", { threadId: id, from: t.bot_id, to: to.id });
    return c.json(await openRouted(to.id, first.text, { kind: "routed", by: "driver", from: t.bot_id }));
  })
  // Opening a thread is the driver seeing it: its finished runs leave "Since you last looked" (runtime/inbox.ts).
  .get("/api/threads/:id", signedIn, async (c) => { const id = c.req.param("id"), v = await threadView(id); R.markSeen(id); R.prewarmBrain(id); return c.json(v); })
  // An open thread whose run just ended while the driver was looking at it.
  .post("/api/threads/:id/seen", signedIn, (c) => c.json({ ok: R.markSeen(c.req.param("id")) }))
  // Side question: answered from the thread's record and returned only to this browser; nothing is stored or audited.
  .post("/api/threads/:id/side", signedIn, async (c) => { const b = await jsonBody(c, SideBody); return c.json(await R.sideAsk(c.req.param("id"), b.question, b.history)); })
  .patch("/api/threads/:id", signedIn, async (c) => {
    const id = c.req.param("id"), b = await jsonBody(c, ThreadEdit);
    if (b.title !== undefined) run("UPDATE threads SET title=?, title_auto=0 WHERE id=?", b.title, id);
    if (b.archived !== undefined) run("UPDATE threads SET archived=? WHERE id=?", b.archived, id);
    if (b.pinned !== undefined) run("UPDATE threads SET pinned=? WHERE id=?", b.pinned, id);
    if (b.autonomy !== undefined && R.getThread(id) && R.getThread(id)!.autonomy !== b.autonomy) {
      run("UPDATE threads SET autonomy=? WHERE id=?", b.autonomy, id);
      audit("driver", "thread.autonomy", { id, autonomy: b.autonomy });
      addEvent(id, null, "system", { text: AUTONOMY_NOTE[b.autonomy] });
    }
    return c.json({ ok: true });
  })
  .post("/api/threads/:id/messages", signedIn, async (c) => { const b = await jsonBody(c, Message); return c.json(await R.sendMessage(c.req.param("id"), { text: b.text, attachments: b.attachments, mode: b.mode as string, edit: b.edit ?? null })); })
  // "Use this": the driver's pick among an image's versions. A note in the thread, so every client draws it.
  .post("/api/images/:id/keep", signedIn, (c) => {
    const im = one<{ id: string; thread_id: string | null; path: string; kept_at: number | null }>("SELECT id,thread_id,path,kept_at FROM images WHERE id=?", c.req.param("id"));
    if (!im) throw httpErr(404, "No such image");
    if (!im.kept_at) { run("UPDATE images SET kept_at=? WHERE id=?", now(), im.id); if (im.thread_id) addEvent(im.thread_id, null, "system", { text: `Kept ${im.path.split("/").pop()}`, kept: im.id }); }
    audit("driver", "image.kept", { id: im.id });
    return c.json({ ok: true });
  })
  .delete("/api/threads/:id/queue/:qid", signedIn, (c) => c.json(R.removeQueued(c.req.param("id"), c.req.param("qid"))))
  .post("/api/threads/:id/queue/:qid/send-now", signedIn, async (c) => c.json(await R.sendQueuedNow(c.req.param("id"), c.req.param("qid"))))
  .post("/api/threads/:id/interrupt", signedIn, async (c) => c.json({ ok: await R.interrupt(c.req.param("id")) }))
  .post("/api/threads/:id/refresh", signedIn, (c) => { const id = c.req.param("id"); if (!R.getThread(id)) throw httpErr(404, "No such thread"); return c.json(R.refresh(id)); })
  // Hands the title back to the conversation: named now by titles.ts from the latest asks (the thread may have moved on),
  // and kept automatic until renamed by hand again.
  .post("/api/threads/:id/retitle", signedIn, async (c) => {
    const id = c.req.param("id"); if (!R.getThread(id)) throw httpErr(404, "No such thread");
    run("UPDATE threads SET title_auto=1 WHERE id=?", id);
    return c.json({ title: (await nameFromConversation(id, { latest: true })) ?? R.getThread(id)!.title });
  })
  .post("/api/threads/:id/compact", signedIn, async (c) => { await R.compact(c.req.param("id")); return c.json({ ok: true }); })
  // Rewind (runtime/rewind.ts): what would change back, then the driver's go. No crew tool reaches these.
  .get("/api/turns/:id/rewind", signedIn, (c) => { const { boundary: _, ...p } = R.rewindPlan(c.req.param("id"), rewindMode(c.req.query("mode"))); return c.json(p); })
  .post("/api/turns/:id/rewind", signedIn, async (c) => { const b = await jsonBody(c, RewindBody); return c.json(await R.rewind(c.req.param("id"), rewindMode(b.mode))); })
  .post("/api/threads/:id/fresh", signedIn, (c) => {
    const id = c.req.param("id"), t = R.getThread(id); if (!t) throw httpErr(404, "No such thread");
    const last = one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", id);
    const nid = uid("th");
    run("INSERT INTO threads(id,bot_id,title,carry,autonomy,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", nid, t.bot_id, `${t.title} (cont.)`.slice(0, 120),
      `Context carried from the thread "${t.title}". Its last reply was:\n${(json(last?.data, {}).text || "(none)").slice(0, 6000)}`, newThreadAutonomy(), now(), now());
    return c.json({ id: nid });
  })
  .post("/api/threads/:id/upload", signedIn, async (c) => {
    const id = c.req.param("id");
    if (!R.getThread(id)) throw httpErr(404, "No such thread");
    const name = c.req.query("name") || "file";
    return c.json({ path: R.saveUpload(id, name, await readBody(c, 20 << 20)) });
  })

  // Surfaces (generative UI)
  .post("/api/surfaces/:id/action", signedIn, async (c) => {
    const id = c.req.param("id"), s = one<SurfaceRow>("SELECT * FROM surfaces WHERE id=?", id); if (!s) throw httpErr(404, "No such surface");
    const b = await jsonBody(c, SurfaceAction), values = b.values;
    const text = `[Surface "${s.title}" → action ${String(b.action).slice(0, 64)}]\n${JSON.stringify(values, null, 1).slice(0, 8000)}`;
    audit("driver", "surface.action", { id, action: b.action });
    const display = `Sent from “${s.title}”: ${Object.entries(values).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 400) || String(b.action).slice(0, 64)}`;
    return c.json(await R.sendMessage(s.thread_id, { text, mode: "auto", trigger: "surface", display }));
  })
  .post("/api/surfaces/:id/save", signedIn, async (c) => { const b = await jsonBody(c, Save); run("UPDATE surfaces SET saved=? WHERE id=?", b.saved ? 1 : 0, c.req.param("id")); return c.json({ ok: true }); })
  // The crew's harness suggestions (runtime/retro.ts): open ones for the Wall; the driver accepts or dismisses each.
  .get("/api/improvements", signedIn, (c) => c.json(all("SELECT i.*, b.name bot_name FROM improvements i JOIN bots b ON b.id=i.bot_id WHERE i.status=? ORDER BY i.votes DESC, i.updated_at DESC LIMIT 50", c.req.query("status") || "open")))
  .post("/api/improvements/:id", signedIn, async (c) => {
    const b = await jsonBody(c, z.object({ status: pick(["accepted", "dismissed", "open"] as const, "open") }));
    run("UPDATE improvements SET status=?, updated_at=? WHERE id=?", b.status, now(), c.req.param("id")); audit("driver", `improvement.${b.status}`, { id: c.req.param("id") });
    return c.json({ ok: true });
  })
  // Kept surfaces (Library); ?bound=1 only the dashboards bound to a ledger (the Wall).
  .get("/api/surfaces", signedIn, async (c) => c.json(await Promise.all(all<SurfaceRow & { bot_name: string; hue: string }>(`SELECT s.id,s.title,s.spec,s.thread_id,s.bot_id,s.created_at,b.name bot_name,b.hue FROM surfaces s JOIN bots b ON b.id=s.bot_id WHERE s.saved=1${c.req.query("bound") ? " AND json_extract(s.spec,'$.source') IS NOT NULL" : ""} ORDER BY s.created_at DESC`).map((s) => resolveSurface({ ...s, spec: json(s.spec) })))))
  // One surface as the driver sees it now: a bound dashboard's refresh.
  .get("/api/surfaces/:id", signedIn, async (c) => {
    const s = one<SurfaceRow>("SELECT id,title,spec,saved,bot_id FROM surfaces WHERE id=?", c.req.param("id"));
    if (!s) throw httpErr(404, "No such surface");
    return c.json(await resolveSurface({ ...s, spec: json(s.spec) }));
  });
