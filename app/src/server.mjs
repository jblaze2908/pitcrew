// Pitcrew control plane: HTTP API, static web app, SSE stream and the live-view bridge.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { readFileSync, existsSync, statSync, createReadStream, realpathSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { one, all, run, now, uid, json, getSetting, setSetting, audit } from "./db.mjs";
import * as A from "./auth.mjs";
import * as P from "./providers.mjs";
import * as R from "./runtime.mjs";
import { getBot, listBots, ensureChief, updateBot, normaliseSpec, createBot } from "./crew.mjs";
import { objectText } from "./snapshot.mjs";
import { serveShot, SHOT_NAME } from "./shots.mjs";
import { send, serveFile as serveCached, warm } from "./delivery.mjs";
import { listProjects, openProject, proxyCode, startCodeSweeper, reapCode } from "./code.mjs";
import { listSites, setSite, removeSite, MODES } from "./domains.mjs";
import { botDir, listFiles, reapOrphans, startIdleSweeper, allComputers, allBrains, startBootSocket, toolManifest } from "./computer.mjs";

const PORT = Number(process.env.PORT || 8330);
const WEB = new URL("../web/", import.meta.url).pathname;
const NOVNC = process.env.NOVNC_DIR || "/usr/share/novnc";
const HOST = process.env.PITCREW_HOST || "pitcrew.example.com";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const cookie = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
const authed = (req) => A.sessionValid(cookie(req, "pc_s"));
async function body(req, limit = 1 << 20) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw A.httpErr(413, "Too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}
const jbody = async (req) => { const b = await body(req); try { return b.length ? JSON.parse(b) : {}; } catch { throw A.httpErr(400, "Bad JSON"); } };
const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `https://${req.headers.host}` || req.headers.origin === `http://${req.headers.host}`;

// ---------- view models ----------
function mood(b, threads, pending, up) {
  if (pending.some((p) => p.bot_id === b.id)) return "needs";
  if (threads.some((t) => t.status === "running")) return "working";
  const last = one("SELECT status FROM turns WHERE bot_id=? ORDER BY started_at DESC LIMIT 1", b.id)?.status;
  if (last === "failed") return "failed";
  if (!up) return "sleep";
  return last === "completed" ? "done" : "idle";
}
// /api/state needs at most 9 threads a member (wall, sidebar, thread panel); the crew view asks for all of them.
function botCard(b, pending, limit = -1) {
  const threads = all("SELECT id,title,status,created_at,updated_at,pinned FROM threads WHERE bot_id=? AND archived=0 ORDER BY pinned DESC, updated_at DESC LIMIT ?", b.id, limit);
  const c = allComputers().find((x) => x.bot.id === b.id), br = allBrains().find((x) => x.bot.id === b.id);
  return { ...b, threads, mood: mood(b, threads, pending, !!c?.up || !!br?.up), spend: R.weekSpend(b.id), computer: { up: !!c?.up, desktop: !!c?.desktopUp, startedAt: c?.startedAt ?? null, lease: R.leaseHeld(b.id) } };
}
const pitRow = R.pitRow;
const LEARNED = `SELECT l.rowid id, l.*, ${R.LEARN_AFTER} need, b.name bot_name FROM learned l JOIN bots b ON b.id=l.bot_id`;
// A learned pattern only acts while the member's policy allows its effect; hide the ones a policy change switched off.
const liveLearned = (rows) => rows.filter((l) => getBot(l.bot_id)?.policy[l.effect] === "allow");
function state() {
  const pending = all("SELECT * FROM pitstops WHERE status='pending' ORDER BY created_at").map(pitRow);
  const dayStart = (() => { const d = new Date(now() + 330 * 60000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 330 * 60000; })();
  return {
    driverName: getSetting("driver_name", "Driver"), paused: getSetting("paused") === "1", defaultProvider: getSetting("default_provider", "openrouter"), plainVoice: getSetting("plain_voice") === "1",
    bots: listBots().map((b) => botCard(b, pending, 12)), pitstops: pending, providers: P.providerStatus(),
    today: one("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", dayStart),
    week: one("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", R.weekStart()),
    weekCap: one("SELECT COALESCE(SUM(weekly_cap_usd),0) c FROM bots WHERE archived=0").c,
    computersUp: allComputers().filter((c) => c.up).length,
  };
}
function threadView(id) {
  const t = R.getThread(id);
  if (!t) throw A.httpErr(404, "No such thread");
  const events = all("SELECT * FROM events WHERE thread_id=? ORDER BY id DESC LIMIT 400", id).reverse().map((e) => ({ ...e, data: json(e.data, {}) }));
  const pitIds = events.filter((e) => e.kind === "pitstop").map((e) => e.data.id);
  const surfIds = events.filter((e) => e.kind === "surface").map((e) => e.data.id);
  const pits = pitIds.length ? all(`SELECT * FROM pitstops WHERE id IN (${pitIds.map(() => "?").join(",")})`, ...pitIds).map(pitRow) : [];
  const surfaces = surfIds.length ? all(`SELECT id,title,spec,saved FROM surfaces WHERE id IN (${surfIds.map(() => "?").join(",")})`, ...surfIds).map((s) => ({ ...s, spec: json(s.spec) })) : [];
  return { thread: { ...t, running: R.isRunning(id) }, bot: getBot(t.bot_id), events, pitstops: pits, surfaces };
}
function telemetry() {
  const ws = R.weekStart();
  return {
    bots: listBots().map((b) => ({ id: b.id, name: b.name, hue: b.hue, shape: b.shape, cap: b.weekly_cap_usd, spend: R.weekSpend(b.id),
      runs: one("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND started_at>=?", b.id, ws).n,
      failed: one("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND started_at>=? AND status='failed'", b.id, ws).n })),
    runs: all("SELECT t.*, th.title thread_title, b.name bot_name, b.hue FROM turns t JOIN threads th ON th.id=t.thread_id JOIN bots b ON b.id=t.bot_id ORDER BY t.started_at DESC LIMIT 150"),
    pitstops: one("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='denied') denied, SUM(status='expired') expired, COALESCE(SUM(CASE WHEN decided_at IS NOT NULL AND status!='expired' THEN decided_at-created_at END),0) wait_ms FROM pitstops WHERE created_at>=?", ws),
    handled: one("SELECT COUNT(*) n FROM turns WHERE status='completed' AND started_at>=?", ws).n,
    byModel: all("SELECT provider, model, COUNT(*) runs, SUM(cost_usd) usd, SUM(input_tokens) input, SUM(output_tokens) output FROM turns WHERE started_at>=? GROUP BY provider, model ORDER BY usd DESC", ws),
  };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn, ...opts });

route("GET", "/api/session", () => ({ setup: A.setupDone(), authed: false }), { open: true });
route("POST", "/api/setup", async (req, res) => {
  const b = await jbody(req);
  A.setupPassword(b.token, b.password);
  if (b.driverName) setSetting("driver_name", String(b.driverName).slice(0, 40));
  login(res); return { ok: true };
}, { open: true });
route("POST", "/api/login", async (req, res) => { const b = await jbody(req); A.checkPassword(b.password); login(res); audit("driver", "login"); return { ok: true }; }, { open: true });
route("POST", "/api/logout", (req, res) => { A.endSession(cookie(req, "pc_s")); res.setHeader("Set-Cookie", "pc_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"); return { ok: true }; });
route("POST", "/api/password", async (req) => { const b = await jbody(req); A.checkPassword(b.current); A.setPassword(b.next); A.endAllSessions(); audit("driver", "password.changed"); return { ok: true, relogin: true }; });
function login(res) { res.setHeader("Set-Cookie", `pc_s=${A.newSession()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Strict`); }

route("GET", "/api/state", () => state());
// ?thread=<id> also subscribes to that thread's transcript (events, deltas, activity, context); the rest is global.
route("GET", "/api/stream", (req, res) => {
  const thread = new URL(req.url, "http://x").searchParams.get("thread");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": hi\n\n"); R.bus.add(res, /^[\w-]{1,64}$/.test(thread || "") ? thread : null); return null;
});
route("PATCH", "/api/settings", async (req) => {
  const b = await jbody(req);
  if (b.driverName !== undefined) setSetting("driver_name", String(b.driverName).trim().slice(0, 40) || "Driver");
  if (["openrouter", "aigateway", "openai"].includes(b.defaultProvider)) setSetting("default_provider", b.defaultProvider);
  if (b.plainVoice !== undefined) setSetting("plain_voice", b.plainVoice ? "1" : "0");
  audit("driver", "settings.updated", { fields: Object.keys(b) });
  return state();
});

// Providers
route("GET", "/api/providers", () => P.providerStatus());
route("PUT", "/api/providers/:p/key", async (req, res, { p }) => { const b = await jbody(req); return P.setKey(p, b.key); });
route("DELETE", "/api/providers/:p/key", (req, res, { p }) => { P.removeKey(p); return P.providerStatus(); });
route("POST", "/api/providers/:p/test", async (req, res, { p }) => { const { getSecret } = await import("./auth.mjs"); const k = getSecret(p); if (!k) throw A.httpErr(400, "No key saved"); return P.testKey(p, k); });
route("POST", "/api/providers/openai/login", () => P.startChatgptLogin());
route("POST", "/api/providers/openai/cancel", () => { P.cancelChatgptLogin(); return P.providerStatus(); });
route("POST", "/api/providers/openai/signout", () => { P.signOutChatgpt(); return P.providerStatus(); });
route("GET", "/api/models", async (req) => {
  const u = new URL(req.url, "http://x"); const q = (u.searchParams.get("q") || "").toLowerCase();
  const list = await P.models(u.searchParams.get("provider") || "openrouter");
  return list.filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q)).slice(0, 60);
});

// Crew
route("GET", "/api/bots/:id", (req, res, { id }) => {
  const b = getBot(id); if (!b) throw A.httpErr(404, "No such crew member");
  const pending = all("SELECT * FROM pitstops WHERE status='pending'");
  return { bot: botCard(b, pending), memory: all("SELECT * FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at DESC", id),
    schedules: all("SELECT * FROM schedules WHERE bot_id=? ORDER BY created_at DESC", id), rules: all("SELECT * FROM rules WHERE bot_id=? AND revoked_at IS NULL ORDER BY created_at DESC", id), learned: liveLearned(all(`${LEARNED} WHERE l.bot_id=? ORDER BY l.updated_at DESC`, id)) };
});
route("PATCH", "/api/bots/:id", async (req, res, { id }) => updateBot(id, await jbody(req)));
route("POST", "/api/bots/:id/archive", (req, res, { id }) => {
  const b = getBot(id); if (!b || b.kind === "chief") throw A.httpErr(400, "The Crew Chief can't be retired");
  run("UPDATE bots SET archived=1 WHERE id=?", id); run("UPDATE schedules SET enabled=0 WHERE bot_id=?", id); audit("driver", "crew.retired", { id }); return { ok: true };
});
// Manual hire: the driver filled the form and pressed Hire on the review screen; that is the HITL step.
route("POST", "/api/hire", async (req) => { const b = await jbody(req); const s = normaliseSpec(b); const bot = createBot(s); if (s.schedule?.spec && s.schedule.prompt) R.addSchedule(bot.id, null, s.schedule.spec, s.schedule.prompt); return bot; });

// Threads
route("POST", "/api/threads", async (req) => {
  const b = await jbody(req); if (!getBot(b.botId)) throw A.httpErr(404, "No such crew member");
  const id = uid("th"); run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", id, b.botId, String(b.title || "New thread").slice(0, 120), now(), now());
  return { id };
});
route("GET", "/api/threads/:id", (req, res, { id }) => { const v = threadView(id); R.prewarmBrain(id); return v; });
route("GET", "/api/bots/:id/projects", (req, res, { id }) => { if (!getBot(id)) throw A.httpErr(404, "No such crew member"); return listProjects(id); });
route("POST", "/api/bots/:id/projects/open", async (req, res, { id }) => { if (!getBot(id)) throw A.httpErr(404, "No such crew member"); const b = await jbody(req); const r = await openProject(id, String(b.path || "")); audit("driver", "code.opened", { botId: id, path: r.project.path }); return r; });
route("GET", "/api/bots/:id/threads", (req, res, { id }) => { if (!getBot(id)) throw A.httpErr(404, "No such crew member"); return R.findThreads(id, new URL(req.url, "http://x").searchParams.get("q") || "", { limit: 30 }); });
route("PATCH", "/api/threads/:id", async (req, res, { id }) => {
  const b = await jbody(req);
  if (b.title) run("UPDATE threads SET title=? WHERE id=?", String(b.title).slice(0, 120), id);
  if (b.archived !== undefined) run("UPDATE threads SET archived=? WHERE id=?", b.archived ? 1 : 0, id);
  return { ok: true };
});
route("POST", "/api/threads/:id/messages", async (req, res, { id }) => { const b = await jbody(req); return R.sendMessage(id, { text: b.text, attachments: Array.isArray(b.attachments) ? b.attachments.filter((a) => /^uploads\/[\w.-]+$/.test(a)) : [], mode: b.mode }); });
route("POST", "/api/threads/:id/interrupt", async (req, res, { id }) => ({ ok: await R.interrupt(id) }));
route("POST", "/api/threads/:id/compact", async (req, res, { id }) => { await R.compact(id); return { ok: true }; });
route("POST", "/api/threads/:id/fresh", (req, res, { id }) => {
  const t = R.getThread(id); if (!t) throw A.httpErr(404, "No such thread");
  const last = one("SELECT data FROM events WHERE thread_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", id);
  const nid = uid("th");
  run("INSERT INTO threads(id,bot_id,title,carry,created_at,updated_at) VALUES(?,?,?,?,?,?)", nid, t.bot_id, `${t.title} (cont.)`.slice(0, 120),
    `Context carried from the thread "${t.title}". Its last reply was:\n${(json(last?.data, {}).text || "(none)").slice(0, 6000)}`, now(), now());
  return { id: nid };
});
route("POST", "/api/threads/:id/upload", async (req, res, { id }) => {
  if (!R.getThread(id)) throw A.httpErr(404, "No such thread");
  const name = new URL(req.url, "http://x").searchParams.get("name") || "file";
  return { path: R.saveUpload(id, name, await body(req, 20 << 20)) };
});

// Surfaces (generative UI)
route("POST", "/api/surfaces/:id/action", async (req, res, { id }) => {
  const s = one("SELECT * FROM surfaces WHERE id=?", id); if (!s) throw A.httpErr(404, "No such surface");
  const b = await jbody(req);
  const values = b.values && typeof b.values === "object" ? b.values : {};
  const text = `[Surface "${s.title}" → action ${String(b.action).slice(0, 64)}]\n${JSON.stringify(values, null, 1).slice(0, 8000)}`;
  audit("driver", "surface.action", { id, action: b.action });
  const display = `Sent from “${s.title}”: ${Object.entries(values).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 400) || String(b.action).slice(0, 64)}`;
  return R.sendMessage(s.thread_id, { text, mode: "auto", trigger: "surface", display });
});
route("POST", "/api/surfaces/:id/save", async (req, res, { id }) => { const b = await jbody(req); run("UPDATE surfaces SET saved=? WHERE id=?", b.saved ? 1 : 0, id); return { ok: true }; });
route("GET", "/api/surfaces", () => all("SELECT s.id,s.title,s.spec,s.thread_id,s.bot_id,s.created_at,b.name bot_name,b.hue FROM surfaces s JOIN bots b ON b.id=s.bot_id WHERE s.saved=1 ORDER BY s.created_at DESC").map((s) => ({ ...s, spec: json(s.spec) })));

// Pit stops and rules
route("GET", "/api/pitstops", (req) => {
  const st = new URL(req.url, "http://x").searchParams.get("status");
  return st === "pending" ? all("SELECT * FROM pitstops WHERE status='pending' ORDER BY created_at").map(pitRow) : all("SELECT * FROM pitstops ORDER BY created_at DESC LIMIT 200").map(pitRow);
});
route("POST", "/api/pitstops/:id/decide", async (req, res, { id }) => { const b = await jbody(req); return pitRow(await R.decide(id, b.decision === "approve" ? "approve" : "deny", { scope: ["once", "thread", "always", "site", "full", "block"].includes(b.scope) ? b.scope : "once", note: b.note || "", spec: b.spec || null })); });
route("POST", "/api/pitstops/batch", async (req) => {
  const b = await jbody(req);
  const out = [];
  for (const id of (b.ids || []).slice(0, 50)) {
    const ps = one("SELECT kind FROM pitstops WHERE id=?", id);
    if (ps && ps.kind !== "hire") out.push(await R.decide(id, b.decision === "approve" ? "approve" : "deny", { scope: "once", note: "batch" }));
  }
  return { decided: out.length };
});
// Sites: per-domain policy, global (scope=global) or per crew member (scope=<bot id>).
const siteScope = (scope) => { if (scope === "global" || getBot(String(scope || ""))) return String(scope); throw A.httpErr(400, "scope is global or a crew member id"); };
route("GET", "/api/sites", (req) => { const scope = siteScope(new URL(req.url, "http://x").searchParams.get("scope")); return { scope, modes: MODES, sites: listSites(scope) }; });
route("PUT", "/api/sites", async (req) => { const b = await jbody(req); return setSite(siteScope(b.scope), b.domain, b.mode, b.overrides); });
route("DELETE", "/api/sites", (req) => { const q = new URL(req.url, "http://x").searchParams; return removeSite(siteScope(q.get("scope")), String(q.get("domain") || "")); });
route("GET", "/api/rules", () => all("SELECT r.*, b.name bot_name FROM rules r JOIN bots b ON b.id=r.bot_id WHERE r.revoked_at IS NULL ORDER BY r.created_at DESC"));
route("POST", "/api/rules/:id/revoke", (req, res, { id }) => { run("UPDATE rules SET revoked_at=? WHERE id=?", now(), id); audit("driver", "rule.revoked", { id }); return { ok: true }; });
route("GET", "/api/learned", () => liveLearned(all(`${LEARNED} ORDER BY l.updated_at DESC LIMIT 200`)));
// "Ask again": the pattern starts over and needs a fresh run of approvals; its history stays for the audit trail.
route("POST", "/api/learned/:id/reset", (req, res, { id }) => { run("UPDATE learned SET streak=0, updated_at=? WHERE rowid=?", now(), Number(id)); audit("driver", "learned.reset", { id }); return { ok: true }; });

// Memory and schedules
route("POST", "/api/bots/:id/memory", async (req, res, { id }) => { const b = await jbody(req); const text = String(b.text || "").trim().slice(0, 500); if (!text) throw A.httpErr(400, "Empty"); const mid = uid("me"); run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", mid, id, text, "driver", now(), now()); return { id: mid }; });
route("PATCH", "/api/memory/:id", async (req, res, { id }) => { const b = await jbody(req); run("UPDATE memory SET text=?, updated_at=? WHERE id=?", String(b.text || "").slice(0, 500), now(), id); return { ok: true }; });
route("POST", "/api/memory/:id/forget", (req, res, { id }) => { run("UPDATE memory SET forgotten_at=? WHERE id=?", now(), id); audit("driver", "memory.forgotten", { id }); return { ok: true }; });
route("POST", "/api/bots/:id/memory/forget-source", async (req, res, { id }) => { const b = await jbody(req); const r = run("UPDATE memory SET forgotten_at=? WHERE bot_id=? AND source=? AND forgotten_at IS NULL", now(), id, String(b.source)); audit("driver", "memory.forgot_source", { id, source: b.source }); return { forgotten: Number(r.changes) }; });
route("POST", "/api/bots/:id/schedules", async (req, res, { id }) => { const b = await jbody(req); try { return R.addSchedule(id, b.threadId || null, String(b.spec || ""), String(b.prompt || "")); } catch (e) { throw A.httpErr(400, e.message); } });
route("PATCH", "/api/schedules/:id", async (req, res, { id }) => { const b = await jbody(req); run("UPDATE schedules SET enabled=? WHERE id=?", b.enabled ? 1 : 0, id); audit("driver", "schedule.toggled", { id, enabled: !!b.enabled }); return { ok: true }; });

// Computers
// Watching needs the desktop, so "start" from the UI boots both stages.
route("POST", "/api/bots/:id/computer/start", async (req, res, { id }) => { const b = getBot(id); if (!b) throw A.httpErr(404, "No such crew member"); await R.computer(b).desktop(); return { ok: true }; });
route("POST", "/api/bots/:id/computer/stop", async (req, res, { id }) => { const b = getBot(id); if (b) await R.computer(b).stop(); return { ok: true }; });
route("POST", "/api/bots/:id/computer/take", (req, res, { id }) => { R.takeControl(id); return { ok: true }; });
route("POST", "/api/bots/:id/computer/handback", async (req, res, { id }) => { const b = await jbody(req); R.handBack(id, String(b.note || "")); return { ok: true }; });

// Kill switch
route("POST", "/api/kill", () => R.killSwitch());
route("POST", "/api/resume", () => { R.resumeCrew(); return state(); });

// Telemetry, library, export
route("GET", "/api/telemetry", async () => ({ ...telemetry(), openrouter: await P.openrouterUsage() }));
route("GET", "/api/library", () => listBots().map((b) => ({ id: b.id, name: b.name, hue: b.hue, shape: b.shape, files: listFiles(b.id) })));
route("GET", "/api/export", (req, res) => {
  const dump = { exportedAt: new Date().toISOString(), note: "Pitcrew export. Provider keys and auth tokens are never included.",
    settings: all("SELECT key,value FROM settings WHERE key!='password'"), bots: all("SELECT * FROM bots"), threads: all("SELECT * FROM threads"), turns: all("SELECT * FROM turns"),
    events: all("SELECT * FROM events"), pitstops: all("SELECT * FROM pitstops"), rules: all("SELECT * FROM rules"), learned: all("SELECT * FROM learned"), memory: all("SELECT * FROM memory"),
    schedules: all("SELECT * FROM schedules"), surfaces: all("SELECT * FROM surfaces"), audit: all("SELECT * FROM audit") };
  audit("driver", "export");
  send(res, 200, JSON.stringify(dump), { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="pitcrew-export-${new Date().toISOString().slice(0, 10)}.json"` });
  return null;
});
route("GET", "/api/audit", () => all("SELECT * FROM audit ORDER BY id DESC LIMIT 300"));

// Files view: browse a crew member's workspace on the host's disk (works with the computer off) and diff each turn.
function workPath(botId, rel) {
  let base, full;
  try { base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(join(base, normalize(String(rel || "").replace(/^\/+/, "")))); } catch { return null; }
  return full === base || full.startsWith(base + "/") ? { base, full } : null;
}
route("GET", "/api/bots/:id/fs", (req, res, { id }) => {
  if (!getBot(id)) throw A.httpErr(404, "No such crew member");
  const rel = new URL(req.url, "http://x").searchParams.get("path") || "";
  const w = workPath(id, rel); if (!w) throw A.httpErr(404, "Not found");
  const st = statSync(w.full);
  if (st.isDirectory()) {
    const entries = readdirSync(w.full, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isFile()).map((e) => { let s = null; try { s = statSync(join(w.full, e.name)); } catch {} return { name: e.name, dir: e.isDirectory(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }; })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)).slice(0, 1000);
    return { type: "dir", path: w.full.slice(w.base.length + 1), entries };
  }
  const out = { type: "file", path: w.full.slice(w.base.length + 1), size: st.size, mtime: st.mtimeMs, image: /\.(png|jpe?g|webp|gif)$/i.test(w.full) };
  if (!out.image && st.size <= 1 << 20) { const buf = readFileSync(w.full); if (!buf.subarray(0, 8000).includes(0)) out.text = buf.toString("utf8"); }
  return out;
});
route("GET", "/api/bots/:id/changes", (req, res, { id }) => all("SELECT t.id, t.thread_id, t.started_at, t.changes, th.title thread_title FROM turns t JOIN threads th ON th.id=t.thread_id WHERE t.bot_id=? AND t.changes IS NOT NULL ORDER BY t.started_at DESC LIMIT 40", id).map((r) => ({ ...r, changes: json(r.changes, []) })));
route("GET", "/api/turns/:id/diff", (req, res, { id }) => {
  const t = one("SELECT bot_id, changes FROM turns WHERE id=?", id); if (!t) throw A.httpErr(404, "No such run");
  const path = new URL(req.url, "http://x").searchParams.get("path");
  const c = json(t.changes, []).find((x) => x.path === path); if (!c) throw A.httpErr(404, "Not changed in this run");
  return { ...c, beforeText: c.before ? objectText(t.bot_id, c.before) : "", afterText: c.after ? objectText(t.bot_id, c.after) : "" };
});

// Files from a crew member's workspace, served as downloads only (never rendered inline).
function serveFile(req, res, botId, rel) {
  if (!getBot(botId)) return send(res, 404, "Not found");
  let base, full;
  try { base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(join(base, normalize(decodeURIComponent(rel)))); } catch { return send(res, 404, "Not found"); }
  if (!full.startsWith(base + "/") || !statSync(full).isFile()) return send(res, 404, "Not found");
  // Images may render inline (thumbnails); everything else is a download. Inline responses are sandboxed.
  const IMG = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
  const inline = new URL(req.url, "http://x").searchParams.get("inline") === "1" && IMG[extname(full).toLowerCase()];
  res.writeHead(200, inline
    ? { "Content-Type": inline, "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Length": statSync(full).size }
    : { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${full.split("/").pop().replace(/[^\w.-]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Content-Length": statSync(full).size });
  createReadStream(full).pipe(res);
}

// App files revalidate on every load (no-cache + ETag, so a deploy shows at once); vendored noVNC keeps a day.
function serveStatic(req, res, path) {
  let root = WEB, rel = path;
  if (path.startsWith("/novnc/")) { root = NOVNC; rel = path.slice(6); }
  if (!/^\/[\w./-]*$/.test(rel) || rel.includes("..")) return send(res, 404, "Not found");
  let full = join(root, rel);
  if (root === WEB && (rel === "/" || !existsSync(full) || !extname(rel))) full = join(WEB, "index.html");
  if (!serveCached(req, res, full, root === NOVNC ? "public, max-age=86400" : "no-cache")) send(res, 404, "Not found");
}

const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname.startsWith("/code/")) return proxyCode(req, res); // token-authed, sandboxed: see code.mjs
    const fm = /^\/files\/([\w-]+)\/(.+)$/.exec(url.pathname);
    if (fm) return authed(req) ? serveFile(req, res, fm[1], fm[2]) : send(res, 401, "Sign in");
    const sm = /^\/shots\/([\w-]+)\/([^/]+)$/.exec(url.pathname);
    if (sm) return !authed(req) ? send(res, 401, "Sign in") : getBot(sm[1]) && SHOT_NAME.test(sm[2]) ? serveShot(res, sm[1], sm[2]) : send(res, 404, "Not found");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (req.method !== "GET" && (!sameOrigin(req) || req.headers["x-pitcrew"] !== "1")) throw A.httpErr(403, "Cross-site request refused");
      if (!r.open && !authed(req)) throw A.httpErr(401, "Sign in");
      const out = await r.fn(req, res, m.groups || {});
      if (url.pathname === "/api/session") return send(res, 200, { setup: A.setupDone(), authed: authed(req) });
      if (out !== null && !res.headersSent) send(res, 200, out ?? { ok: true });
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, e.stack);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the pit wall." : e.message });
  }
});

// Live view: noVNC speaks WebSocket; the computer's x11vnc listens on a unix socket in its bot dir. Bridge them here, behind auth.
server.on("upgrade", (req, sock) => {
  const m = /^\/live\/([\w-]+)\/ws$/.exec(new URL(req.url, "http://x").pathname);
  if (!m || !authed(req) || !sameOrigin(req) || !getBot(m[1]) || !req.headers["sec-websocket-key"]) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const path = `${botDir(m[1])}/run/vnc.sock`;
  // A socket file can outlive its computer (a deploy restarts them); only a running desktop has a live one.
  if (!existsSync(path) || !allComputers().find((c) => c.bot.id === m[1])?.desktopUp) { sock.end("HTTP/1.1 409 Conflict\r\n\r\n"); return; }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const proto = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).includes("binary") ? "Sec-WebSocket-Protocol: binary\r\n" : "";
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
  const comp = allComputers().find((c) => c.bot.id === m[1]);
  if (comp) comp.viewers++;
  const vnc = connect(path);
  const frame = (op, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
    sock.write(Buffer.concat([head, payload]));
  };
  vnc.on("data", (d) => frame(2, d));
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked) return sock.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { frame(8, Buffer.alloc(0)); return sock.end(); }
      if (op === 9) frame(10, data);
      else if (op === 2 || op === 0 || op === 1) vnc.write(data);
    }
  });
  const close = () => { if (comp && comp.viewers > 0) { comp.viewers--; comp.lastActive = Date.now(); } vnc.destroy(); sock.destroy(); };
  vnc.on("close", close); vnc.on("error", close); sock.on("close", close); sock.on("error", close);
});

ensureChief();
A.ensureSetupToken();
R.bootRuntime();
await reapOrphans();
await reapCode();
startCodeSweeper();
startIdleSweeper(R.isBusy, R.isThinking);
startBootSocket(R.computerHooks);
toolManifest().then((m) => console.log(`tool manifest: ${m.browser.length} browser, ${m.computer.length} pixel`)).catch((e) => console.error("tool manifest failed:", e.message));
server.listen(PORT, () => { console.log(`pitcrew control plane on :${PORT} (${HOST})`); for (const f of readdirSync(WEB, { recursive: true })) warm(join(WEB, f)); });
