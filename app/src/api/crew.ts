// Crew members: their card and settings, hiring and retiring, memory, schedules, projects and computers.
import { Hono } from "hono";
import { z } from "zod";
import { all, run, now, uid, audit } from "../db.js";
import { httpErr } from "../auth.js";
import * as R from "../runtime/index.js";
import { getBot, updateBot, normaliseSpec, createBot } from "../crew.js";
import { listProjects, openProject } from "../code.js";
import { memberChanged, listMemories, remember, forget } from "../engram.js";
import { memberLinked } from "../engramStore.js";
import { learnedFor, undoLearned } from "../runtime/learned.js";
import { signedIn, type Env } from "../http/guard.js";
import { readJson, jsonBody, raw, text, trimmed, flag, field } from "../http/body.js";
import { botCard, LEARNED, liveLearned } from "./views.js";
import { ledgerOverview, tablePreview } from "../ledger.js";
import { json } from "../db.js";
import type { LearnedRow, PitstopRow } from "../models.js";

const Memory = z.object({ text: trimmed(500) });
const MemoryEdit = z.object({ text: text(500) });
const ForgetSource = z.object({ source: raw });
const Schedule = z.object({ threadId: field((v) => v || null), spec: text(), prompt: text() });
const ScheduleEdit = z.object({ enabled: z.boolean().optional(), spec: z.string().max(100).optional(), prompt: z.string().max(2000).optional() });
const Project = z.object({ path: text() });
const HandBack = z.object({ note: text() });

const member = (id: string) => { const b = getBot(id); if (!b) throw httpErr(404, "No such crew member"); return b; };

export const crewRoutes = new Hono<Env>()
  .get("/api/bots/:id", signedIn, async (c) => {
    const id = c.req.param("id"), b = member(id);
    const pending = all<PitstopRow>("SELECT * FROM pitstops WHERE status='pending'");
    // A linked member's memories are read from Engram (one GET per view); Pitcrew's own stay as they were.
    let memory: unknown[], memoryIn = "pitcrew", memoryError: string | null = null;
    if (memberLinked(b)) {
      memoryIn = "engram";
      try { memory = (await listMemories(b)).map((m) => ({ id: m.id, bot_id: id, text: m.text, source: m.source, created_at: m.created_at, updated_at: m.created_at })); }
      catch (e: any) { memory = []; memoryError = e.message; }
    } else memory = all("SELECT * FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at DESC", id);
    return c.json({ bot: botCard(b, pending), memory, memoryIn, memoryError,
      schedules: all("SELECT * FROM schedules WHERE bot_id=? ORDER BY created_at DESC", id), rules: all("SELECT * FROM rules WHERE bot_id=? AND revoked_at IS NULL ORDER BY created_at DESC", id), learned: liveLearned(all<LearnedRow>(`${LEARNED} WHERE l.bot_id=? ORDER BY l.updated_at DESC`, id)) });
  })
  // The patch is normalised by updateBot itself (crew.ts), field by field.
  .patch("/api/bots/:id", signedIn, async (c) => { const patch = await readJson(c), b = updateBot(c.req.param("id"), patch); if ("private" in patch || "engram_scope" in patch || "engram_household" in patch) memberChanged(b); return c.json(b); })
  .post("/api/bots/:id/archive", signedIn, (c) => {
    const id = c.req.param("id"), b = getBot(id); if (!b || b.kind === "chief") throw httpErr(400, "The Crew Chief can't be retired");
    run("UPDATE bots SET archived=1 WHERE id=?", id); run("UPDATE schedules SET enabled=0 WHERE bot_id=?", id); audit("driver", "crew.retired", { id }); return c.json({ ok: true });
  })
  // Manual hire: the driver filled the form and pressed Hire on the review screen; that is the HITL step.
  .post("/api/hire", signedIn, async (c) => { const s = normaliseSpec(await readJson(c)); const bot = createBot(s); if (s.schedule?.spec && s.schedule.prompt) R.addSchedule(bot.id, null, s.schedule.spec, s.schedule.prompt); memberChanged(bot); return c.json(bot); })
  .get("/api/bots/:id/projects", signedIn, (c) => { const id = c.req.param("id"); member(id); return c.json(listProjects(id)); })
  .post("/api/bots/:id/projects/open", signedIn, async (c) => { const id = c.req.param("id"); member(id); const b = await jsonBody(c, Project); const r = await openProject(id, b.path); audit("driver", "code.opened", { botId: id, path: r.project.path }); return c.json(r); })
  // What data a member keeps: its ledgers (tables, rows, columns) and the dashboards it built on them.
  .get("/api/bots/:id/data", signedIn, async (c) => {
    const id = c.req.param("id"); member(id);
    const dashboards = all<{ id: string; title: string; saved: number; thread_id: string; created_at: number; spec: string }>("SELECT id,title,saved,thread_id,created_at,spec FROM surfaces WHERE bot_id=? AND json_extract(spec,'$.source') IS NOT NULL ORDER BY created_at DESC", id)
      .map(({ spec, ...s }) => { const x = json<{ source?: string; queries?: Record<string, string> }>(spec, {}); return { ...s, source: x.source || "", queries: Object.keys(x.queries || {}) }; });
    return c.json({ ledgers: await ledgerOverview(id), dashboards });
  })
  .get("/api/bots/:id/data/table", signedIn, async (c) => { const id = c.req.param("id"); member(id); return c.json(await tablePreview(id, c.req.query("source") || "", c.req.query("table") || "")); })
  .get("/api/bots/:id/threads", signedIn, (c) => { const id = c.req.param("id"); member(id); return c.json(R.findThreads(id, c.req.query("q") || "", { limit: 30 })); })

  // Memory and schedules
  .post("/api/bots/:id/memory", signedIn, async (c) => {
    const id = c.req.param("id"), b = await jsonBody(c, Memory), bot = member(id); if (!b.text) throw httpErr(400, "Empty");
    if (memberLinked(bot)) { const r = await remember(bot, b.text, { by: "driver" }); return c.json({ id: r.id, status: r.status }); }
    const mid = uid("me"); run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", mid, id, b.text, "driver", now(), now()); return c.json({ id: mid }); })
  .patch("/api/memory/:id", signedIn, async (c) => { const b = await jsonBody(c, MemoryEdit); run("UPDATE memory SET text=?, updated_at=? WHERE id=?", b.text, now(), c.req.param("id")); return c.json({ ok: true }); })
  .post("/api/memory/:id/forget", signedIn, (c) => { const id = c.req.param("id"); run("UPDATE memory SET forgotten_at=? WHERE id=?", now(), id); audit("driver", "memory.forgotten", { id }); return c.json({ ok: true }); })
  .post("/api/bots/:id/memory/:mid/forget", signedIn, async (c) => {
    const id = c.req.param("id"), mid = c.req.param("mid"), b = member(id);
    if (memberLinked(b)) { await forget(b, mid, "driver"); return c.json({ ok: true }); }
    run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), mid, id); audit("driver", "memory.forgotten", { id: mid }); return c.json({ ok: true });
  })
  // "Learned this run" card: what a turn remembered, and undoing a new one.
  .get("/api/turns/:id/learned", signedIn, (c) => c.json({ items: learnedFor(c.req.param("id")) }))
  .post("/api/turns/:id/learned/:mid/undo", signedIn, async (c) => c.json({ items: await undoLearned(c.req.param("id"), c.req.param("mid")) }))
  .post("/api/bots/:id/memory/forget-source", signedIn, async (c) => { const id = c.req.param("id"), b = await jsonBody(c, ForgetSource); const r = run("UPDATE memory SET forgotten_at=? WHERE bot_id=? AND source=? AND forgotten_at IS NULL", now(), id, String(b.source)); audit("driver", "memory.forgot_source", { id, source: b.source }); return c.json({ forgotten: Number(r.changes) }); })
  .post("/api/bots/:id/schedules", signedIn, async (c) => { const b = await jsonBody(c, Schedule); try { return c.json(R.addSchedule(c.req.param("id"), b.threadId as string | null, b.spec, b.prompt)); } catch (e: any) { throw httpErr(400, e.message); } })
  .patch("/api/schedules/:id", signedIn, async (c) => { const b = await jsonBody(c, ScheduleEdit); try { return c.json(R.updateSchedule(c.req.param("id"), null, b, "driver")); } catch (e: any) { throw httpErr(400, e.message); } })
  .delete("/api/schedules/:id", signedIn, (c) => { try { R.deleteSchedule(c.req.param("id"), null, "driver"); return c.json({ ok: true }); } catch (e: any) { throw httpErr(404, e.message); } })

  // Computers. Watching needs the desktop, so "start" from the UI boots both stages.
  .post("/api/bots/:id/computer/start", signedIn, async (c) => { const b = member(c.req.param("id")); await R.computer(b).desktop(); return c.json({ ok: true }); })
  .post("/api/bots/:id/computer/stop", signedIn, async (c) => { const b = getBot(c.req.param("id")); if (b) await R.computer(b).stop(); return c.json({ ok: true }); })
  .post("/api/bots/:id/computer/take", signedIn, (c) => { R.takeControl(c.req.param("id")); return c.json({ ok: true }); })
  .post("/api/bots/:id/computer/handback", signedIn, async (c) => { const b = await jsonBody(c, HandBack); R.handBack(c.req.param("id"), b.note); return c.json({ ok: true }); });
