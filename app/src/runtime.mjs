// The runtime: turns on each crew member's brain, its computer on demand, the jev gate and pit stops, Pitcrew tools,
// schedules, kill switch.
import { writeFileSync, chownSync, readFileSync, statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { posix } from "node:path";
import { execFs } from "./execfs.mjs";
import { one, all, run, now, uid, json, getSetting, setSetting, audit, pruneLabels } from "./db.mjs";
import { getSecret } from "./auth.mjs";
import { jev, redact, jevSystemOne, secretKind } from "./jev.mjs";
import { checkoutWhy, confirmationOf } from "./sites.mjs";
import { siteVerdict, siteTag, applySiteChoice, recordVisit } from "./domains.mjs";
import { getBot, listBots, instructions, dynamicTools, normaliseSpec, createBot } from "./crew.mjs";
import { brainFor, computerFor, allComputers, allBrains, readPlanLimits, botDir, ensureDirs, usageLog, toolManifest, PW_OUT, PW_SETTLE_MS } from "./computer.mjs";
import { providerReady, estimateCost, recordChatgptLimits, chatgptLimits } from "./providers.mjs";
import { validateSurface } from "./surfaces.mjs";
import { snapshot, changes } from "./snapshot.mjs";
import { imageFrom, saveShot, startShotSweeper } from "./shots.mjs";

// ---------- live bus (SSE) ----------
// Transcript events go only to clients watching that thread (?thread=); a delta per token to every tab adds up.
const clients = new Map(); // res → thread id it watches, or null
const SCOPED = new Set(["event", "delta", "activity", "context", "jev"]);
export const SSE_CAP = 1 << 20;
// A client that stopped reading would buffer every event in memory; past the cap it's dropped and EventSource reconnects.
const push = (c, s) => { if (c.writableLength > SSE_CAP) { clients.delete(c); c.destroy(); } else c.write(s); };
export const bus = {
  add(res, thread = null) { clients.set(res, thread); res.on("close", () => clients.delete(res)); },
  emit(type, data) {
    const scoped = SCOPED.has(type); let s;
    for (const [c, th] of clients) if (!scoped || th === data.threadId) push(c, (s ??= `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  },
};
setInterval(() => { for (const c of clients.keys()) push(c, ": ping\n\n"); }, 25000).unref();

// ---------- state ----------
const active = new Map();   // our thread id → { turnId, codexTurnId, base, total, last }
const byCodex = new Map();  // codex thread id → our thread id
const queues = new Map();   // our thread id → [message]
const waits = new Map();    // pitstop id → resolve(decision)
const leases = new Map();   // bot id → { since, waiters: [] }
const items = new Map();    // codex item id → item (for file-change paths)
const turnWaiters = new Map(); // our thread id → [resolve] for the next finished turn (delegation)
const usage = new Map();    // codex thread id → last total usage
const snapshots = new Map(); // codex thread id → { url, text, lines } from the last browser snapshot the agent saw (noteSnapshot)

export const getThread = (id) => one("SELECT * FROM threads WHERE id=?", id);
export const isRunning = (threadId) => active.has(threadId);
const isBusy = (c) => [...active.keys()].some((t) => getThread(t)?.bot_id === c.bot.id) || one("SELECT 1 FROM pitstops WHERE bot_id=? AND status='pending' AND kind!='hire'", c.bot.id);

// `live` rides on the SSE payload only (the pit stop or surface row), so an open thread draws it without a refetch.
function addEvent(threadId, turnId, kind, data, live = null) {
  const r = run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", threadId, turnId ?? null, kind, JSON.stringify(data), now());
  run("UPDATE threads SET updated_at=? WHERE id=?", now(), threadId);
  bus.emit("event", { id: Number(r.lastInsertRowid), threadId, turnId, kind, data, ts: now(), ...live });
}
// A thread's status is only its live state (idle | running | needs). How a run ended belongs to the turn.
function setThreadStatus(threadId, status) {
  run("UPDATE threads SET status=?, updated_at=? WHERE id=?", status, now(), threadId);
  const t = getThread(threadId);
  bus.emit("thread", { id: threadId, botId: t?.bot_id, status });
}

// Names an untitled thread from its first message, locally: no extra model call, and the text goes nowhere new.
export const UNTITLED = "New thread";
export function titleFrom(text, attachments = []) {
  let s = String(text || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!s) return attachments.length ? `Shared ${attachments[0].split("/").pop().replace(/^[a-z0-9]+-/, "")}`.slice(0, 60) : UNTITLED;
  const sentence = /^(.{12,}?[.?!])(\s|$)/.exec(s)?.[1];
  if (sentence && sentence.length <= 60) s = sentence;
  if (s.length > 60) s = `${s.slice(0, 58).replace(/\s+\S*$/, "")}…`;
  return s[0].toUpperCase() + s.slice(1);
}
// A greeting says nothing about what the thread is for, so the thread waits for its first real message.
const SMALL_TALK = /^(hi+|hey+|hello+|yo|sup|hola|namaste|good (morning|afternoon|evening|night)|thanks?( you)?|ty|ok(ay)?|cool|test(ing)?|ping|are you there|you there)[\s!.?,]*$/i;
export const isSmallTalk = (text) => SMALL_TALK.test(String(text || "").trim());
function nameThread(t, text, attachments) {
  if (t.title !== UNTITLED || (isSmallTalk(text) && !attachments.length)) return;
  const title = titleFrom(text, attachments);
  if (title === UNTITLED) return;
  run("UPDATE threads SET title=? WHERE id=?", title, t.id);
  bus.emit("thread", { id: t.id, botId: t.bot_id, status: t.status, title });
}

// Monday 00:00 in Asia/Kolkata (UTC+5:30, no DST).
const IST = 330 * 60000;
export function weekStart(t = now()) {
  const d = new Date(t + IST); const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - IST;
}
export const weekSpend = (botId) => one("SELECT COALESCE(SUM(cost_usd),0) s FROM turns WHERE bot_id=? AND started_at>=?", botId, weekStart()).s;

// ---------- brain and computer hooks ----------
const brainHooks = {
  onNotify: (br, method, p) => onNotify(br, method, p),
  onRequest: (br, method, p) => onRequest(br, method, p),
  onBrainExit: (br, code, errTail) => {
    for (const [tid] of active) if (getThread(tid)?.bot_id === br.bot.id) finishTurn(tid, "failed", `The crew member's brain stopped (exit ${code}).`);
    if (code && code !== 143 && code !== 137 && code !== null) addSystemForBot(br.bot.id, `Brain stopped unexpectedly (exit ${code}). ${errTail.split("\n").filter(Boolean).slice(-1)[0] || ""}`.trim());
  },
};
export const computerHooks = {
  isBusy,
  getBot,
  paused: () => getSetting("paused") === "1",
  onState: (c) => {
    bus.emit("computer", { botId: c.bot.id, up: c.up, desktop: c.desktopUp, startedAt: c.startedAt });
    // The desktop the driver held is gone; a lease on it would block the crew with no screen to hand back from.
    if (!c.up && leases.has(c.bot.id)) releaseLease(c.bot.id, "computer.lease_released", "The computer stopped while you had control, so control went back to the crew.");
  },
  onComputerBoot: (botId) => { for (const [tid, a] of active) if (getThread(tid)?.bot_id === botId) bus.emit("activity", { threadId: tid, botId, text: "Computer up" }); },
};
function addSystemForBot(botId, text) {
  const t = one("SELECT id FROM threads WHERE bot_id=? ORDER BY updated_at DESC LIMIT 1", botId);
  if (t) addEvent(t.id, null, "system", { text, tone: "bad" });
}
export const computer = (bot) => computerFor(bot, computerHooks);
export const brain = (bot) => brainFor(bot, brainHooks);
const isThinking = (botId) => [...active.keys()].some((t) => getThread(t)?.bot_id === botId);

// ---------- turns ----------
export async function sendMessage(threadId, { text, attachments = [], mode = "auto", trigger = "driver", display = null }) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error("No such thread"), { status: 404 });
  text = String(text || "").slice(0, 20000);
  if (!text.trim() && !attachments.length) throw Object.assign(new Error("Say something"), { status: 400 });
  nameThread(t, text, attachments);
  addEvent(threadId, null, "user", { text, attachments, via: trigger, ...(display ? { display } : {}) });
  const a = active.get(threadId);
  if (a) {
    if (mode === "queue") { (queues.get(threadId) || queues.set(threadId, []).get(threadId)).push({ text, attachments, trigger }); addEvent(threadId, null, "system", { text: "Queued for after this run." }); return { queued: true }; }
    await brain(getBot(t.bot_id)).request("turn/steer", { threadId: t.codex_id, expectedTurnId: a.codexTurnId, input: toInput(t.bot_id, text, attachments) });
    return { steered: true };
  }
  startTurn(threadId, text, attachments, trigger).catch((e) => {
    if (e.silent) return;
    addEvent(threadId, null, "error", { text: e.message });
    setThreadStatus(threadId, "idle");
  });
  return { started: true };
}

// Images are read here and sent inline: the brain can't see the computer's disk.
function toInput(botId, text, attachments) {
  const input = [];
  const isImg = (f) => /\.(png|jpe?g|webp|gif)$/i.test(f);
  const body = attachments.length ? `${text}\n\nAttached files (in /bot/work on your computer): ${attachments.join(", ")}` : text;
  if (body.trim()) input.push({ type: "text", text: body, text_elements: [] });
  for (const f of attachments.filter(isImg)) {
    try {
      const buf = readFileSync(`${botDir(botId)}/work/${f}`);
      if (buf.length < 8 << 20) input.push({ type: "image", url: `data:image/${f.split(".").pop().toLowerCase().replace("jpg", "jpeg")};base64,${buf.toString("base64")}` });
    } catch {}
  }
  return input;
}

const ENVS = [{ environmentId: "computer", cwd: "/bot/work" }];
// Why a member can't start a run now, or null. Delegation checks it first, so the Chief gets a reason instead of a wait.
export function blockedReason(b) {
  if (getSetting("paused") === "1") return "The crew is stopped (kill switch). Resume the crew in Settings first.";
  if (weekSpend(b.id) >= b.weekly_cap_usd) return `${b.name} has reached this week's cap ($${b.weekly_cap_usd.toFixed(2)}). Raise the cap to continue.`;
  if (!providerReady(b.provider)) return `${b.name} uses ${b.provider === "openai" ? "the ChatGPT plan" : b.provider}, which isn't connected. Add it in Settings → Providers.`;
  return null;
}
async function startTurn(threadId, text, attachments, trigger) {
  const t = getThread(threadId), b = getBot(t.bot_id);
  const why = blockedReason(b);
  if (why) throw new Error(why);
  const warm = warmPlan(threadId);
  if (warm) computer(b).prewarm(warm.desktop);
  const turnId = uid("tu");
  active.set(threadId, { turnId, codexTurnId: null, base: null, total: null, last: null, usageFrom: logSize(b.id) });
  run("INSERT INTO turns(id,thread_id,bot_id,status,trigger,provider,model,started_at) VALUES(?,?,?,?,?,?,?,?)", turnId, threadId, b.id, "starting", trigger, b.provider, b.model, now());
  setThreadStatus(threadId, "running");
  try {
    const c = brain(b);
    await c.ensure();
    const mems = all("SELECT id,text FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at LIMIT 60", b.id);
    const common = { model: b.model, modelProvider: b.provider, cwd: "/bot/work", developerInstructions: instructions(b, mems) };
    let codexId = t.codex_id;
    if (!codexId) {
      const st = await c.request("thread/start", { ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", environments: ENVS, dynamicTools: dynamicTools(b, await toolManifest()) }, 120000);
      codexId = st.thread.id;
      run("UPDATE threads SET codex_id=? WHERE id=?", codexId, threadId);
      c.loaded.add(codexId);
    } else if (!c.loaded.has(codexId)) {
      await c.request("thread/resume", { threadId: codexId, ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", excludeTurns: true }, 120000);
      c.loaded.add(codexId);
    }
    // Developer instructions reach Codex only at start/resume (which just sent the current list); memories saved since
    // go in as turn context, persisted in the thread's history.
    if (!c.mems.has(codexId)) c.mems.set(codexId, memMap(mems));
    const memDelta = memoryDelta(c.mems.get(codexId), mems);
    byCodex.set(codexId, threadId);
    const a0 = active.get(threadId);
    if (a0) try { a0.snap = snapshot(b.id); } catch {}
    const carry = getThread(threadId).carry;
    if (carry) run("UPDATE threads SET carry=NULL WHERE id=?", threadId);
    // Every turn names the computer environment, so commands never run in the brain itself.
    const r = await c.request("turn/start", { threadId: codexId, environments: ENVS, input: toInput(b.id, carry ? `${carry}\n\n---\n\n${text}` : text, attachments), responsesapiClientMetadata: { pitcrew_turn: turnId },
      ...(memDelta ? { additionalContext: { pitcrew_memory: { kind: "application", value: memDelta } } } : {}) }, 120000);
    if (memDelta) c.mems.set(codexId, memMap(mems));
    const a = active.get(threadId);
    if (a) a.codexTurnId = r.turn.id;
    run("UPDATE turns SET codex_turn_id=?, status='running' WHERE id=?", r.turn.id, turnId);
  } catch (e) {
    finishTurn(threadId, "failed", e.message);
    throw Object.assign(new Error(e.message), { silent: true });
  }
}

const memMap = (mems) => new Map(mems.map((m) => [m.id, m.text]));
// What changed in a member's memory since this thread was last told, or null. Rendered by Codex as a developer
// message (<pitcrew_memory>) at that point in the thread, so the cached prefix stays intact.
export function memoryDelta(seen, mems) {
  if (!seen) return null;
  const changed = mems.filter((m) => seen.get(m.id) !== m.text).map((m) => `- [${m.id}] ${m.text}`);
  const ids = new Set(mems.map((m) => m.id)), gone = [...seen.keys()].filter((id) => !ids.has(id));
  if (!changed.length && !gone.length) return null;
  return [`Your memory changed since this thread was told (this replaces older entries with the same id):`, ...changed, ...(gone.length ? [`Forgotten: ${gone.map((id) => `[${id}]`).join(", ")}`] : [])].join("\n");
}

// Which stage of the computer the next turn likely needs, from the thread's last 3 turns: stage 1 (exec-server, ~20 MiB)
// if any ran a command or used the browser/screen, the desktop (~470 MiB) only if the last one did. One indexed query per turn.
const EXEC_TOOLS = new Set(["commandExecution", "browser", "computer"]);
export function warmPlan(threadId) {
  const recent = all("SELECT id FROM turns WHERE thread_id=? ORDER BY started_at DESC LIMIT 3", threadId).map((t) => t.id);
  if (!recent.length) return null;
  const used = all(`SELECT turn_id, json_extract(data,'$.type') type FROM events WHERE thread_id=? AND kind='tool' AND turn_id IN (${recent.map(() => "?").join(",")})`, threadId, ...recent);
  if (!used.some((u) => EXEC_TOOLS.has(u.type))) return null;
  return { desktop: used.some((u) => u.turn_id === recent[0] && (u.type === "browser" || u.type === "computer")) };
}

// Opening a thread in the UI starts its member's brain (~0.3-0.6 s cold), so the first message doesn't wait on it.
export function prewarmBrain(threadId) {
  const t = getThread(threadId), b = t && getBot(t.bot_id);
  if (b && !b.archived && getSetting("paused") !== "1") brain(b).prewarm();
}

async function finishTurn(threadId, status, error) {
  const a = active.get(threadId);
  if (!a) return;
  active.delete(threadId);
  const t = getThread(threadId), b = getBot(t.bot_id);
  const u = a.total && a.base ? { input: a.total.inputTokens - a.base.inputTokens, cached: a.total.cachedInputTokens - a.base.cachedInputTokens, output: a.total.outputTokens - a.base.outputTokens } : { input: 0, cached: 0, output: 0 };
  const billed = billedUsage(b.id, a.turnId, a.usageFrom);
  if (billed) Object.assign(u, { input: billed.input, cached: billed.cached, output: billed.output });
  const cost = billed?.cost != null ? { usd: billed.cost, basis: "billed" } : await estimateCost(b.provider, b.model, u).catch(() => ({ usd: 0, basis: "unknown" }));
  run("UPDATE turns SET status=?, error=?, ended_at=?, input_tokens=?, cached_tokens=?, output_tokens=?, cost_usd=?, cost_basis=? WHERE id=?",
    status, error || null, now(), u.input, u.cached, u.output, cost.usd, cost.basis, a.turnId);
  if (error) addEvent(threadId, a.turnId, "error", { text: error });
  // What changed on disk during this turn, however it was changed.
  if (a.snap) try {
    const ch = changes(b.id, a.snap, snapshot(b.id));
    if (ch.length) {
      run("UPDATE turns SET changes=? WHERE id=?", JSON.stringify(ch), a.turnId);
      addEvent(threadId, a.turnId, "changes", { turnId: a.turnId, botId: b.id, count: ch.length, files: ch.slice(0, 12).map((c) => ({ path: c.path, status: c.status, lines: c.lines })) });
    }
  } catch {}
  setThreadStatus(threadId, "idle");
  bus.emit("turn", { threadId, turnId: a.turnId, status, cost: cost.usd, botId: b.id });
  for (const w of turnWaiters.get(threadId)?.splice(0) || []) w({ turnId: a.turnId, status, cost: cost.usd });
  const next = queues.get(threadId)?.shift();
  if (next) startTurn(threadId, next.text, next.attachments, next.trigger).catch((e) => { if (!e.silent) addEvent(threadId, null, "error", { text: e.message }); });
}

// The brain's LLM proxy logs each model request's provider-reported usage and cost, keyed by turn.
// Read once per finished turn, from the log's size when the turn started: the file only grows, so a full read would too.
const logSize = (botId) => { try { return statSync(usageLog(botId)).size; } catch { return 0; } };
export function billedUsage(botId, turnId, from = 0) {
  let lines = [];
  try {
    const fd = openSync(usageLog(botId), "r");
    try { const size = fstatSync(fd).size, at = from <= size ? from : 0, buf = Buffer.alloc(size - at); readSync(fd, buf, 0, buf.length, at); lines = buf.toString("utf8").split("\n").filter((l) => l.includes(turnId)).map((l) => JSON.parse(l)); }
    finally { closeSync(fd); }
  } catch { return null; }
  if (!lines.length) return null;
  const sum = (k) => lines.reduce((s, x) => s + (x[k] || 0), 0);
  return { input: sum("input"), cached: sum("cached"), output: sum("output"), cost: lines.every((x) => typeof x.cost === "number") ? sum("cost") : null, requests: lines.length };
}

export async function interrupt(threadId) {
  const t = getThread(threadId), a = active.get(threadId);
  if (!t || !a) return false;
  const c = brain(getBot(t.bot_id));
  if (a.codexTurnId && c.up) await c.request("turn/interrupt", { threadId: t.codex_id, turnId: a.codexTurnId }).catch(() => {});
  else finishTurn(threadId, "interrupted");
  return true;
}
export async function compact(threadId) {
  const t = getThread(threadId);
  if (!t?.codex_id) throw Object.assign(new Error("Nothing to compact yet"), { status: 400 });
  if (active.has(threadId)) throw Object.assign(new Error("Wait for the run to finish"), { status: 409 });
  const b = getBot(t.bot_id), c = brain(b);
  await c.ensure();
  if (!c.loaded.has(t.codex_id)) { await c.request("thread/resume", { threadId: t.codex_id, model: b.model, modelProvider: b.provider, excludeTurns: true }); c.loaded.add(t.codex_id); }
  byCodex.set(t.codex_id, threadId);
  await c.request("thread/compact/start", { threadId: t.codex_id });
  addEvent(threadId, null, "system", { text: "Compacting the thread…" });
}

// ---------- notifications ----------
const short = (s, n = 160) => { s = typeof s === "string" ? s : JSON.stringify(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function toolTitle(it) {
  switch (it.type) {
    case "commandExecution": return `$ ${short(String(it.command || "").replace(/^\/bin\/(ba)?sh -l?c /, ""), 200)}`;
    case "mcpToolCall": return `${it.server === "browser" ? it.tool.replace(/^browser_/, "") : `${it.server}.${it.tool}`} ${short(summariseArgs(it.arguments), 140)}`;
    case "dynamicToolCall": return `${it.tool}`;
    case "fileChange": return `Edited ${(it.changes || []).map((c) => c.path).join(", ").slice(0, 200)}`;
    case "webSearch": return `Searched “${short(it.query, 120)}”`;
    default: return it.type;
  }
}
function summariseArgs(a) {
  if (!a || typeof a !== "object") return "";
  const pick = a.element || a.target || a.field || a.purpose || a.url || a.text || a.ref || "";
  return pick ? String(pick) : Object.entries(a).map(([k, v]) => `${k}=${short(v, 40)}`).join(" ");
}
function mcpResultText(it) {
  const c = it.result?.content || it.result?.contentItems || [];
  return (Array.isArray(c) ? c : []).filter((x) => x.type === "text").map((x) => x.text).join("\n").slice(0, 1500);
}

function onNotify(c, method, p) {
  if (method === "account/rateLimits/updated") return recordChatgptLimits(p.rateLimits);
  const threadId = p.threadId ? byCodex.get(p.threadId) : null;
  if (!threadId) return;
  const a = active.get(threadId);
  switch (method) {
    case "item/agentMessage/delta": bus.emit("delta", { threadId, itemId: p.itemId, text: p.delta }); break;
    case "item/started": {
      const it = p.item; items.set(it.id, it);
      // Browser and pixel tools announce themselves from their own handler, with the grounded element.
      if (["commandExecution", "mcpToolCall", "fileChange", "webSearch"].includes(it.type) || (it.type === "dynamicToolCall" && !/^(browser|computer)_/.test(it.tool)))
        bus.emit("activity", { threadId, botId: c.bot.id, text: toolTitle(it) });
      break;
    }
    case "item/completed": {
      const it = p.item; items.delete(it.id);
      if (it.type === "agentMessage" && it.text?.trim()) addEvent(threadId, a?.turnId, "agent", { text: it.text, itemId: it.id });
      else if (it.type === "commandExecution") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, exitCode: it.exitCode ?? null, output: String(it.aggregatedOutput || "").slice(-1500) });
      else if (it.type === "mcpToolCall") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, output: mcpResultText(it), error: it.error?.message || null });
      else if (it.type === "fileChange") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status });
      else if (it.type === "webSearch") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: "completed" });
      else if (it.type === "contextCompaction") addEvent(threadId, a?.turnId, "system", { text: "Thread compacted." });
      break;
    }
    case "thread/tokenUsage/updated": {
      const tu = p.tokenUsage;
      if (a) { if (!a.base) a.base = usage.get(p.threadId) || subtract(tu.total, tu.last); a.total = tu.total; }
      usage.set(p.threadId, tu.total);
      run("UPDATE threads SET ctx_tokens=?, ctx_window=? WHERE id=?", tu.last.inputTokens, tu.modelContextWindow, threadId);
      bus.emit("context", { threadId, tokens: tu.last.inputTokens, window: tu.modelContextWindow });
      break;
    }
    case "turn/completed": if (a) finishTurn(threadId, p.turn.status, p.turn.status === "failed" ? (p.turn.error?.message || "The run failed") : null); break;
    case "error": if (!p.willRetry) addEvent(threadId, a?.turnId, "error", { text: short(p.error?.message || "Model error", 500) }); break;
    case "thread/compacted": addEvent(threadId, null, "system", { text: "Thread compacted." }); break;
  }
}
// Telemetry page: reads the plan's usage from OpenAI at most once a minute (single flight), else the last reading.
let limitsRead = { at: 0, p: null };
export async function planLimits() {
  if (providerReady("openai") && Date.now() - limitsRead.at > 60000) {
    limitsRead = { at: Date.now(), p: readPlanLimits().then(recordChatgptLimits, (e) => console.error("plan limits:", e.message)) };
  }
  await limitsRead.p;
  return { connected: providerReady("openai"), ...chatgptLimits() };
}
const subtract = (x, y) => Object.fromEntries(Object.keys(x).map((k) => [k, (x[k] || 0) - (y?.[k] || 0)]));

// ---------- grounding ----------
// Playwright MCP acts on bare refs ("e44"). Resolve them against the snapshot the agent itself read, so jev judges
// 'button "Submit order"' on httpbin.org, not "e44". Runs once per browser action; the lookup is a line scan.
// Playwright MCP writes the snapshot it takes after each action to a file (PW_OUT, see computer.mjs) and returns only a
// link, so read that file too: otherwise refs from any page but the last explicit snapshot ground to nothing.
const SNAP_LINK = /^### Snapshot\n- \[Snapshot\]\(([^)\s]+\.yml)\)$/m, SNAP_INLINE = /^### Snapshot\n```yaml\n([\s\S]*?)\n```$/m;
const linkPath = (link) => { const abs = link && posix.resolve("/bot/work", link); return abs?.startsWith(`${PW_OUT}/`) ? abs : null; };
// The snapshot a response carries: inline (explicit browser_snapshot) or in the linked file (one local read per action).
function snapshotOf(botId, text) {
  const inline = SNAP_INLINE.exec(text)?.[1];
  if (inline != null) return inline;
  const abs = linkPath(SNAP_LINK.exec(text)?.[1]);
  const r = abs && execFs(botId, "fs/readFile", { path: `file://${abs}` });
  return r?.result ? Buffer.from(r.result.dataBase64, "base64").toString("utf8") : null;
}
// text is the diff base (what the agent last saw); lines are ref lines for grounding. A scoped or unseen snapshot
// (target/depth, browser_read) adds refs but keeps the diff base, which stays valid only on the same page.
function noteSnapshot(codexId, snap, url, { scoped = false, seen = true } = {}) {
  if (!snap?.includes("[ref=")) return;
  const prev = snapshots.get(codexId), same = prev && prev.url === url, lines = snap.split("\n").filter((l) => l.includes("[ref="));
  if (scoped || !seen) snapshots.set(codexId, { url, text: same ? prev.text : null, lines: same ? [...new Set([...lines, ...prev.lines])] : lines });
  else snapshots.set(codexId, { url, text: snap, lines });
}

// What a browser action's result carries instead of Playwright's file link. One function, one mode: the call's own
// `snapshot` argument, else PITCREW_SNAPSHOT_MODE.
//   link: Playwright's own result (the agent spends a step on browser_snapshot). none: no snapshot.
//   full: the new snapshot, capped at SNAP_MAX.
//   diff (default): what changed since the snapshot this thread last saw. Full on a new page, a first view, a small
//         page (< SNAP_SMALL), or a diff over half the page (refs renumbered, page re-rendered).
// An explicit browser_snapshot is always full, capped at SNAP_MAX_EXPLICIT. Runs once per browser action: O(lines).
export const SNAP_MAX = 8000, SNAP_MAX_EXPLICIT = 12000, SNAP_SMALL = 2000, SNAP_MODES = ["diff", "full", "none"];
const SNAP_MODE = process.env.PITCREW_SNAPSHOT_MODE || "diff";
export function shapeSnapshot(text, snap, { prev = null, url = null, mode = SNAP_MODE } = {}) {
  const m = SNAP_LINK.exec(text) || SNAP_INLINE.exec(text);
  const link = m?.[0].includes("](") ? m[1] : null, file = linkPath(link);
  if (!m || snap == null || (link && mode === "link")) return text;
  let section = null;
  if (link && mode === "none") section = `### Snapshot\nNot included (snapshot: "none")${file ? `; it's in ${file}` : ""}.`;
  else if (link && mode === "diff" && prev?.text != null && prev.url === url && snap.length >= SNAP_SMALL) {
    const d = snapshotDiff(prev.text.split("\n"), snap.split("\n"));
    if (d == null) section = "### Snapshot\nNo change since your last snapshot of this page; its refs still hold.";
    else if (d.length <= snap.length / 2) section = `### Snapshot changes\nSince your last snapshot of this page (+ new, - gone; collapsed lines and their refs are as before):\n${fence(d, "", file, SNAP_MAX)}`;
  }
  return text.replace(m[0], () => section ?? `### Snapshot\n${fence(snap, "yaml", file, link ? SNAP_MAX : SNAP_MAX_EXPLICIT)}`);
}
function fence(s, lang, file, max) {
  if (s.length <= max) return `\`\`\`${lang}\n${s}\n\`\`\``;
  const cut = s.slice(0, s.lastIndexOf("\n", max) + 1 || max).trimEnd(), kb = (x) => (x.length / 1024).toFixed(0);
  return `\`\`\`${lang}\n${cut}\n\`\`\`\nTruncated: showing ${kb(cut)} of ${kb(s)} KB${file ? ` (full snapshot: ${file})` : ""}. Find the rest with browser_find, or browser_snapshot with target (a ref) or depth.`;
}
// Ordered line diff for snapshots, O(lines): a line also in the old snapshot (counted) is unchanged; gone lines print
// where they stood. Unchanged runs collapse to a count, keeping each change's parent line for context. null: no change.
export function snapshotDiff(before, after) {
  const pos = new Map(), used = new Set(), ind = (l) => /^\s*/.exec(l)[0].length;
  before.forEach((l, j) => (pos.get(l) || pos.set(l, []).get(l)).push(j));
  const match = after.map((l) => { const j = pos.get(l)?.shift(); if (j != null) used.add(j); return j ?? -1; });
  const gone = before.map((_, j) => j).filter((j) => !used.has(j) && before[j].trim());
  const next = new Array(after.length + 1).fill(before.length); // old position of the next unchanged line, so "-" precedes its "+"
  for (let i = after.length - 1; i >= 0; i--) next[i] = match[i] >= 0 ? match[i] : next[i + 1];
  const ops = []; let g = 0;
  after.forEach((l, i) => {
    while (g < gone.length && gone[g] < next[i]) ops.push({ t: "-", s: before[gone[g++]] });
    ops.push({ t: match[i] >= 0 || !l.trim() ? " " : "+", s: l });
  });
  while (g < gone.length) ops.push({ t: "-", s: before[gone[g++]] });
  if (!ops.some((o) => o.t !== " ")) return null;
  const keep = new Set(), stack = []; // unchanged lines on the path from the root, for each change's parent
  ops.forEach((o, k) => {
    const d = ind(o.s);
    if (o.t === " ") { while (stack.length && ind(ops[stack[stack.length - 1]].s) >= d) stack.pop(); stack.push(k); return; }
    for (let p = stack.length - 1; p >= 0; p--) if (ind(ops[stack[p]].s) < d) { keep.add(stack[p]); break; }
  });
  const out = []; let run = 0;
  const flush = () => { if (run) out.push(`  … ${run} unchanged line${run === 1 ? "" : "s"}`); run = 0; };
  ops.forEach((o, k) => { if (o.t === " " && !keep.has(k)) { run++; return; } flush(); out.push(`${o.t} ${o.s}`); });
  flush();
  return out.join("\n");
}
// One line saying what an action did, so the agent can check it without reading the page: from the result's own Page,
// Open tabs, Modal state and Events sections, plus the URL the agent last saw and the tab count before the call.
export function verifyLine(tool, text, { before = null, tabsBefore = null } = {}) {
  const url = /^- Page URL: (.*)$/m.exec(text)?.[1], title = /^- Page Title: (.*)$/m.exec(text)?.[1];
  const parts = [`${tool.replace(/^browser_/, "")} ${/^### Error$/m.test(text) ? "failed" : "done"}`];
  if (url) parts.push(before && before !== url ? `navigated ${before} → ${url}` : `${before ? "same page" : "on"} ${url}`);
  if (title) parts.push(`title "${title}"`);
  const tabs = readTabs(text)?.count;
  if (tabs && tabsBefore && tabs !== tabsBefore) parts.push(`${tabs > tabsBefore ? "new tab opened" : "tab closed"} (${tabs} open)`);
  const modal = /^### Modal state\n- (.*)$/m.exec(text)?.[1];
  if (modal) parts.push(`modal: ${modal}`);
  for (const d of text.matchAll(/^- (Download(?:ing|ed) file .*)$/gm)) parts.push(d[1]);
  const http = /^- HTTP status: (.*)$/m.exec(text)?.[1], errors = +(/^- Console: (\d+) errors/m.exec(text)?.[1] || 0);
  if (http) parts.push(`HTTP ${http}`);
  if (errors) parts.push(`console: ${errors} error${errors === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// browser_read: the page's accessibility snapshot as compact markdown. Fixed code over Playwright's own snapshot, so
// no page JS runs; the main landmark is preferred when it has real content. One pass over the snapshot's lines.
export const READ_MAX = 12000;
const unq = (s) => { if (!/^".*"$/.test(s)) return s; try { return JSON.parse(s); } catch { return s.slice(1, -1); } };
export function snapshotToText(yaml) {
  let lines = String(yaml || "").split("\n");
  const ind = (l) => /^\s*/.exec(l)[0].length, end = (i) => { let j = i + 1; while (j < lines.length && ind(lines[j]) > ind(lines[i])) j++; return j; };
  const mi = lines.findIndex((l) => /^\s*- main\b/.test(l));
  if (mi >= 0 && lines.slice(mi, end(mi)).join("\n").length > 400) lines = lines.slice(mi + 1, end(mi));
  const out = []; let bullet = false, named = "";
  const push = (s) => { s = String(s).trim(); if (!s || s === named) return; named = ""; if (bullet) { s = `- ${s}`; bullet = false; } if (out[out.length - 1] !== s) out.push(s); };
  // A form control swallows its visible label text, whether that text comes just before or just after it.
  const control = (s, nm) => { if (nm && out[out.length - 1] === nm) out.pop(); push(s); named = nm; };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- (.*)$/.exec(lines[i]); if (!m) continue;
    const p = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?\s?(.*)$/.exec(m[1]);
    if (!p) { if (!m[1].startsWith("/")) push(unq(m[1])); continue; }
    const [, role, raw, attrs, rest] = p, name = raw ? unq(`"${raw}"`) : "", txt = unq(rest.trim()), label = name || txt;
    const skip = () => { i = end(i) - 1; };
    if (role === "heading") { out.push(""); push(`${"#".repeat(Math.min(6, +(/\[level=(\d)\]/.exec(attrs)?.[1] || 2)))} ${label}`); }
    else if (role === "link") { const u = lines.slice(i + 1, end(i)).map((l) => /^\s*- \/url: (.*)$/.exec(l)?.[1]).find(Boolean); if (label) push(u ? `[${label}](${unq(u)})` : label); skip(); }
    else if (role === "listitem") { if (label) push(`- ${label}`); else bullet = true; }
    else if (role === "row") { const cells = lines.slice(i + 1, end(i)).filter((l) => ind(l) === ind(lines[i]) + 2).map((l) => /^\s*- (?:cell|gridcell|columnheader|rowheader)(?: "((?:[^"\\]|\\.)*)")?[^:]*:?\s?(.*)$/.exec(l)).filter(Boolean).map((c) => (c[1] ? unq(`"${c[1]}"`) : unq(c[2].trim())).replace(/\|/g, "\\|")); push(cells.length ? `| ${cells.join(" | ")} |` : label); skip(); }
    else if (role === "button") { if (label) push(`[button: ${label}]`); skip(); }
    else if (/^(textbox|searchbox|spinbutton)$/.test(role)) control(`[${role}${name ? ` ${name}` : ""}${txt ? `: ${txt}` : ""}]`, name);
    else if (/^(checkbox|radio|switch)$/.test(role)) control(`[${/\[checked\]/.test(attrs) ? "x" : " "}] ${label}`, name);
    else if (/^(combobox|listbox)$/.test(role)) { const v = txt || lines.slice(i + 1, end(i)).map((l) => /^\s*- option "((?:[^"\\]|\\.)*)".*\[selected\]/.exec(l)?.[1]).find(Boolean); control(`[select${name ? ` ${name}` : ""}${v ? `: ${unq(`"${v}"`)}` : ""}]`, name); skip(); }
    else if (role === "img") { if (name) push(`![${name}]`); skip(); }
    else if (role === "separator") push("---");
    else if (/^(dialog|alertdialog|alert)$/.test(role)) push(`[${role}${label ? `: ${label}` : ""}]`);
    else if (!/^(banner|navigation|contentinfo|complementary|region|main|form|group|list|table|rowgroup|document|article|menu|menubar|tablist|toolbar|tree|grid)$/.test(role) || txt) push(label);
  }
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length <= READ_MAX) return s;
  return `${s.slice(0, s.lastIndexOf("\n", READ_MAX))}\n\nTruncated at ${(READ_MAX / 1024).toFixed(0)} of ${(s.length / 1024).toFixed(0)} KB. Pass target (a ref from browser_snapshot) to read one part.`;
}
const CONSEQUENTIAL_PAY = /\b(pay|buy|purchase|place order|checkout|check out|transfer|subscribe|donate|confirm payment)\b/i;
const CONSEQUENTIAL_SEND = /\b(submit|send|post|publish|reply|confirm|sign up|register|book|reserve|apply|delete|remove|unsubscribe|cancel (my )?(order|subscription|account))\b/i;
// Snapshot lines carry attributes for the model ([cursor=pointer], [active]); people only need role and name.
export const tidyElement = (s) => String(s || "").replace(/\s*\[[a-z-]+(=[^\]]*)?\]/g, "").replace(/:\s*$/, "").trim();
const roleOf = (element) => /^([a-z]+)\b/.exec(element || "")?.[1] || null;
const hostOf = (url) => { try { return url ? new URL(url).hostname : ""; } catch { return ""; } };
export function ground(snap, tool, args) {
  const find = (ref) => snap?.lines.find((l) => l.includes(`[ref=${ref}]`))?.replace(/\[ref=[^\]]+\]/, "").replace(/^\s*-\s*/, "").trim().slice(0, 160);
  const refs = [args.target, args.ref, ...(Array.isArray(args.fields) ? args.fields.map((f) => f.target || f.ref) : [])].filter(Boolean);
  const elements = refs.map((r) => ({ ref: r, element: find(r) || "(not in the last snapshot)" }));
  const why = checkoutWhy({ url: snap?.url, title: snap?.title, lines: snap?.lines });
  const grounded = { ...args, page_url: snap?.url || null, ...(snap?.title ? { page_title: snap.title } : {}), ...(why ? { page_checkout: why } : {}), ...(elements.length ? { grounded_elements: elements } : {}) };
  let effect = null;
  const label = elements.map((e) => tidyElement(e.element)).join(" ");
  // A plain link click is navigation; links that pay, send or delete still get their consequential class.
  if (/^browser_(click|press_key|select_option)$/.test(tool) && elements.length)
    effect = CONSEQUENTIAL_PAY.test(label) ? "pay" : CONSEQUENTIAL_SEND.test(label) ? "send" : tool === "browser_click" && elements.every((e) => roleOf(e.element) === "link") ? "browse" : null;
  return { grounded, effect, label };
}

// ---------- the gate ----------
function signature(call) {
  if (call.kind === "shell") return `cmd:${String(call.command).replace(/^\/bin\/(ba)?sh -l?c /, "").replace(/^['"]/, "").trim().split(/\s+/).slice(0, 2).join(" ")}`;
  if (call.kind === "mcp") return `mcp:${call.server}/${call.tool}`;
  return `${call.kind}:*`;
}
// What one decision generalises to. Browser actions key on site and element role, so approving a link click on
// example.com says nothing about its buttons or another site. Ungrounded and pixel actions generalise to nothing.
export function pattern(call) {
  if (call.kind === "mcp" && call.server === "computer") return null;
  if (call.kind === "mcp" && call.server === "browser") {
    const a = call.arguments || {}, host = hostOf(a.page_url), roles = (a.grounded_elements || []).map((e) => roleOf(e.element));
    if (!host || !roles.length || roles.includes(null)) return null;
    return `browser:${call.tool.replace(/^browser_/, "")}:${host}:${[...new Set(roles)].sort().join("+")}`;
  }
  return signature(call);
}
export function describePattern(p) {
  const m = /^browser:([^:]+):([^:]+):(.+)$/.exec(p || "");
  if (m) return `${m[1].replace(/_/g, " ")} ${m[3].replace(/\+/g, " or ")} on ${m[2]}`;
  return String(p || "").replace(/^cmd:/, "run ").replace(/^mcp:/, "").replace("/", " ");
}
// Standing approvals hold only for the effect they were granted for: "always" on a link click never covers a Send.
function ruleFor(botId, threadId, matches, effect) {
  return matches.filter(Boolean).map((m) => one("SELECT * FROM rules WHERE bot_id=? AND match=? AND effect=? AND revoked_at IS NULL AND (thread_id IS NULL OR thread_id=?)", botId, m, effect, threadId)).find(Boolean);
}

// Learning from pit stops: after LEARN_AFTER approvals in a row (no denial since) of one pattern with one effect, the
// crew stops asking. It only lifts jev's uncertainty escalations: the effect must be one the member's policy already
// allows, judged by a real classifier (not a fail-closed verdict). Sign-in, send, pay, delete and share never qualify.
export const LEARN_AFTER = 2;
const learnable = (policy, effect, by) => policy?.[effect] === "allow" && /^(jev|judge):/.test(by || "");
function learnedTrust(b, pat, v) {
  if (!pat || !learnable(b.policy, v.effect, v.by)) return null;
  const r = one("SELECT * FROM learned WHERE bot_id=? AND pattern=? AND effect=?", b.id, pat, v.effect);
  return r?.streak >= LEARN_AFTER ? r : null;
}
function learn(ps, detail, status) {
  const ok = status === "approved";
  run(`INSERT INTO learned(bot_id,pattern,effect,label,approvals,denials,streak,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(bot_id,pattern,effect) DO UPDATE SET approvals=approvals+excluded.approvals, denials=denials+excluded.denials,
      streak=CASE WHEN excluded.denials>0 THEN 0 ELSE streak+1 END, label=excluded.label, updated_at=excluded.updated_at`,
    ps.bot_id, detail.pattern, ps.effect, describePattern(detail.pattern), ok ? 1 : 0, ok ? 0 : 1, ok ? 1 : 0, now());
  const r = one("SELECT streak FROM learned WHERE bot_id=? AND pattern=? AND effect=?", ps.bot_id, detail.pattern, ps.effect);
  if (ok && r.streak === LEARN_AFTER && ps.thread_id)
    addEvent(ps.thread_id, null, "system", { text: `Learned: “${describePattern(detail.pattern)}” won't ask again (you approved it ${LEARN_AFTER} times in a row). Undo it under Rules.` });
}
// Shown on a pending pit stop: how far this pattern is from being learned, or null if it can't be.
export function learnProgress(ps) {
  const d = json(ps.detail, {}), v = json(ps.jev, {});
  if (!d.pattern || ps.kind === "hire" || !learnable(getBot(ps.bot_id)?.policy, ps.effect, v.by)) return null;
  const r = one("SELECT streak FROM learned WHERE bot_id=? AND pattern=? AND effect=?", ps.bot_id, d.pattern, ps.effect);
  return { label: describePattern(d.pattern), streak: r?.streak || 0, need: LEARN_AFTER };
}

// While the driver holds the screen, the crew asks for it back through a pit stop instead of waiting blind.
async function waitLease(botId, threadId, call) {
  const l = leases.get(botId);
  if (!l) return true;
  // One ask per lease: every call that lands while it's open waits on the same pit stop.
  l.ask ??= pitStop({ botId, threadId, kind: "lease", effect: "ask", title: `${getBot(botId)?.name || "The crew"} needs the computer back`, detail: { server: call.server, tool: call.tool } })
    .then((d) => { if (d === "approved") releaseLease(botId, "computer.lease_granted"); else if (leases.get(botId) === l) l.ask = null; return d === "approved"; });
  return Promise.race([new Promise((res) => l.waiters.push(res)), l.ask]);
}

// Decides one tool call. Returns true to run it. The site policy first (browser and pixel tools), then rules and
// standing approvals, then jev, then the driver.
async function gate(c, threadId, call, pit) {
  const b = getBot(c.bot.id);
  if (call.kind === "mcp" && ["browser", "computer"].includes(call.server) && !(await waitLease(b.id, threadId, call))) return false;
  const site = await siteStep(b, threadId, call);
  if (!site) return false;
  const policy = site.policy, sig = signature(call), pat = pattern(call), browser = call.kind === "mcp" && call.server === "browser";
  // A fully allowed site skips jev, except for anything that looks like paying (checkout pages never count as full).
  if (browser && site.full && call.effect !== "pay" && !/^(card|cvv)$/.test(secretKind(JSON.stringify(call.arguments?.grounded_elements || [])) || ""))
    return logDecision(threadId, b.id, { decision: "allow", effect: call.effect || "browse", reason: `${site.site.domain} is fully allowed`, by: "site" }, call);
  const v = await jev(call, { policy, apiKey: getSecret("openrouter") || "missing" });
  if (v.decision === "block") { logDecision(threadId, b.id, v, call); addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Blocked by jev: ${v.reason}. Nothing ran.`, tone: "bad" }); return false; }
  if (v.decision === "allow") { const lid = uid("jl"), ok = logDecision(threadId, b.id, v, call, { id: lid }); shadowVerify(lid, call, v, policy); return ok; }
  // A standing approval covers repeats of the same action, but never money, deletion or sharing. Browser approvals
  // match only by their host-bearing pattern, so one granted on a.example never covers b.example; on a checkout page
  // nothing stands in for the driver on pay or send.
  const effect = v.effect === "unknown" ? "ask" : v.effect;
  const standing = site.checkout && ["pay", "send"].includes(effect) ? null : standingRule(b.id, threadId, call, effect);
  if (standing && !["pay", "delete", "share"].includes(v.effect)) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `rule:${standing.label}`, source: "standing" });
  const learned = site.checkout ? null : learnedTrust(b, pat, v);
  if (learned) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `learned:${pat} (${learned.approvals} approvals)`, source: "learned" });
  // Logged before the pit stop opens, so decide() always finds the label row to fill in.
  const id = uid("ps");
  logDecision(threadId, b.id, v, call, { decision: "ask", pitstop: id });
  // Sign-in, payment, send and share pit stops name the exact registrable domain and https, so the driver checks the site.
  const sensitive = ["signin", "pay", "send", "share"].includes(v.effect) || !!secretKind((call.arguments?.grounded_elements || []).map((e) => e.element).join(" "));
  const verify = site.site?.domain && (sensitive || site.checkout) ? ` · verify: ${siteTag(site.site)}${site.checkout ? ` · checkout page (${site.checkout})` : ""}` : "";
  const siteDetail = site.site?.domain ? { site: { domain: site.site.domain, host: site.site.host, https: site.site.https, checkout: site.checkout || null } } : {};
  const decision = await pitStop({ id, botId: b.id, threadId, kind: pit.kind, effect, title: `${pit.title}${verify}`, detail: { ...pit.detail, ...siteDetail, signature: sig, pattern: pat }, jev: v });
  return decision === "approved";
}
export const standingRule = (botId, threadId, call, effect) => ruleFor(botId, threadId, call.kind === "mcp" && call.server === "browser" ? [pattern(call)] : [pattern(call), signature(call)], effect);

// ---------- site policy at the gate ----------
// Browser and pixel actions pass the member's per-domain policy first: blocked or private targets are refused, an
// unknown domain waits on one "open this site?" pit stop (shared by every action that lands on it meanwhile), and the
// rest go on with that page's effective policy. Observing an undecided page (snapshot, screenshot) doesn't ask.
// Per call: in-memory lookups (domains.mjs); a pit stop only for an undecided domain.
const refusals = new Map(); // thread id → why the last browser action was refused, for the agent's tool result
const siteAsks = new Map(); // bot|thread|domain → pending pit stop
const takeRefusal = (threadId) => { const r = refusals.get(threadId); refusals.delete(threadId); return r; };
export async function siteStep(b, threadId, call) {
  if (call.kind !== "mcp" || !["browser", "computer"].includes(call.server)) return { policy: b.policy };
  const a = call.arguments || {};
  const navigating = call.tool === "browser_navigate" || (call.tool === "browser_tabs" && a.action === "new" && !!a.url);
  const observing = !navigating && (call.server === "computer" ? /^(screenshot|scroll)$/.test(call.tool) : /^browser_(snapshot|take_screenshot|wait_for|console_messages|tabs|resize|navigate_back)$/.test(call.tool));
  const opts = { navigating, typing: /^browser_(type|fill_form|press_key)$|^(type|key)$/.test(call.tool), pageCheckout: a.page_checkout, title: a.page_title };
  const url = navigating ? a.url : a.page_url;
  let sv = siteVerdict(b, threadId, url, opts);
  if (sv.action === "go" || (observing && sv.action === "ask")) return sv;
  if (sv.action === "ask") {
    const key = `${b.id}|${threadId}|${sv.site.domain}`;
    if (!siteAsks.has(key)) siteAsks.set(key, pitStop({ botId: b.id, threadId, kind: "site", effect: sv.warn ? "ask" : "browse", title: sv.title, detail: sv.detail }).finally(() => siteAsks.delete(key)));
    const d = await siteAsks.get(key);
    sv = d === "approved" ? siteVerdict(b, threadId, url, opts) : { action: "refuse", site: sv.site, why: `the driver didn't allow ${sv.site.domain}${d === "expired" ? " (the pit stop expired)" : ""}` };
    if (sv.action === "go") return sv;
  }
  refusals.set(threadId, `Not done: ${sv.why}. Don't try to reach it another way; tell the driver if you need it.`);
  audit("jev", "site.refused", { botId: b.id, threadId, tool: call.tool, host: sv.site?.host || null, why: sv.why });
  addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Not opened: ${sv.why}.`, tone: "bad" });
  return null;
}

// After every browser action: if it landed on a blocked or private site (redirect, link, popup), go back or close that
// tab at once; an undecided domain is flagged (its next action waits on the driver); a page that reads like an order or
// payment confirmation raises a bad-tone system event and an audit entry, once per page. Per action: a regex pass over
// the title and snapshot (capped at 60 KB), plus one browser call only when a blocked landing has to be undone.
const confirmSeen = new Map(); // thread id → last confirmation (url|phrase) alerted
export async function afterAction(b, threadId, codexId, mcp, { tool, text, snap, url, before = null, tabsBefore = null }) {
  const title = /^- Page Title: (.*)$/m.exec(text || "")?.[1] || null, notes = [];
  const seen = snapshots.get(codexId);
  if (seen && seen.url === url) seen.title = title;
  if (url && url !== before) {
    const sv = siteVerdict(b, threadId, url, {});
    if (sv.action === "refuse") {
      const tabs = readTabs(text)?.count, newTab = !!(tabs && tabsBefore && tabs > tabsBefore);
      try { await mcp.request("tools/call", newTab ? { name: "browser_tabs", arguments: { action: "close" } } : { name: "browser_navigate_back", arguments: {} }, 30000); } catch {}
      snapshots.delete(codexId);
      audit("jev", "site.left", { botId: b.id, threadId, tool, host: sv.site?.host || null, why: sv.why, closedTab: newTab });
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Left ${sv.site?.host || "a page"}: ${sv.why}.`, tone: "bad" });
      notes.push(`Blocked: that landed on ${sv.site?.host || url}, and ${sv.why}. ${newTab ? "The new tab was closed" : "The browser went back"}; take a fresh snapshot, and don't try to reach it another way.`);
    } else if (sv.action === "ask") notes.push(`Note: ${sv.site.domain} isn't approved for you yet; your next action on it waits for the driver.`);
    else if (sv.site?.domain && !sv.local) recordVisit(b.id, sv.site.domain);
  }
  const phrase = confirmationOf(`${title || ""}\n${String(snap || "").slice(0, 60000)}`)?.slice(0, 80);
  if (phrase && url && confirmSeen.get(threadId) !== `${url}|${phrase}`) {
    confirmSeen.set(threadId, `${url}|${phrase}`);
    const host = hostOf(url);
    audit("jev", "page.confirmation", { botId: b.id, threadId, tool, host, phrase });
    addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `${b.name} is on what looks like an order or payment confirmation on ${host} (“${phrase}”). Check that this was meant to happen.`, tone: "bad" });
  }
  return notes.join("\n") || null;
}

// Shadow jev: a background second opinion on every rule-allowed browser or shell call, stored on that call's label row
// (jev_labels.shadow). The gate never awaits it, so it adds no latency; it costs one remote jev call per rule allow, with
// at most SHADOW_MAX in flight (the rest are dropped, not queued). PITCREW_JEV_SHADOW=0 turns it off.
const SHADOW = process.env.PITCREW_JEV_SHADOW !== "0", SHADOW_MAX = Number(process.env.PITCREW_JEV_SHADOW_MAX || 4);
let shadowing = 0;
export function shadowVerify(labelId, call, v, policy) {
  if (!SHADOW || !["rule", "policy"].includes(v.by) || shadowing >= SHADOW_MAX || !(call.kind === "shell" || (call.kind === "mcp" && call.server === "browser"))) return null;
  shadowing++;
  return jevSystemOne(call, { apiKey: getSecret("openrouter") || "missing", policy }).then((j) => {
    const decision = j.by === "fail-closed" ? null : j.decision === "allow" && (policy[j.effect] ?? "ask") === "allow" ? "allow" : j.decision === "block" ? "block" : "ask";
    run("UPDATE jev_labels SET shadow=? WHERE id=?", JSON.stringify({ effect: j.effect, decision, by: j.by, ms: j.ms ?? null, agree: decision == null ? null : decision === v.decision, sameEffect: j.effect === v.effect }), labelId);
  }).catch(() => {}).finally(() => { shadowing--; });
}
// Every gate decision lands in the audit log and jev_labels, so "why did this run without asking?" always has an answer.
// Per gate call: one redaction walk and two small INSERTs. v is the rules'/jev's verdict; the options are what overrode it.
const labelSource = (by) => (by === "fail-closed" ? "fail-closed" : /^(jev|judge):/.test(by || "") ? "jev" : "rule");
export function logDecision(threadId, botId, v, call, { decision = v.decision, by = v.by, source = labelSource(v.by), pitstop = null, id = uid("jl") } = {}) {
  const safe = redact(call);
  audit("jev", `gate.${decision}`, { threadId, effect: v.effect, by, reason: v.reason, ms: v.ms ?? null, call: gateSummary(safe), ...(pitstop ? { pitstop } : {}) });
  const verdict = { effect: v.effect, decision: v.decision, reason: v.reason, by: v.by, model: /^(jev|judge):/.test(v.by || "") ? v.by.replace(/^\w+:/, "") : null, ms: v.ms ?? null, answers: v.answers ?? null, probabilities: v.probabilities ?? null };
  run("INSERT INTO jev_labels(id,ts,bot_id,thread_id,source,call,verdict,decision,pitstop_id) VALUES(?,?,?,?,?,?,?,?,?)", id, now(), botId, threadId ?? null, source,
    JSON.stringify({ ...safe, host: hostOf(call.arguments?.page_url) || null }), JSON.stringify(verdict), decision, pitstop);
  if (decision === "allow") bus.emit("jev", { threadId, effect: v.effect, by, ms: v.ms ?? null });
  return decision === "allow";
}
const gateSummary = (c) => (c.kind === "shell" ? { kind: "shell", command: String(c.command).slice(0, 300) } : { kind: c.kind, server: c.server, tool: c.tool, args: JSON.stringify(c.arguments || {}).slice(0, 300) });

export const pitRow = (p) => p && { ...p, detail: json(p.detail, {}), jev: json(p.jev, {}), learn: p.status === "pending" ? learnProgress(p) : null };
export function pitStop({ id = uid("ps"), botId, threadId, kind, effect, title, detail, jev: v = {}, expiresMin = 30 }) {
  // Work another member asked for says so wherever the pit stop shows (wall, pit stops, phone).
  const o = threadId && json(getThread(threadId)?.origin);
  if (o?.kind === "delegated") title = `${title} · for ${getBot(o.fromBot)?.name || "another member"}`;
  run("INSERT INTO pitstops(id,bot_id,thread_id,turn_id,kind,effect,title,detail,jev,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id, botId, threadId, threadId ? active.get(threadId)?.turnId ?? null : null, kind, effect, title, JSON.stringify(detail), JSON.stringify(v), now(), now() + expiresMin * 60000);
  const row = pitRow(one("SELECT * FROM pitstops WHERE id=?", id));
  if (threadId) { addEvent(threadId, active.get(threadId)?.turnId, "pitstop", { id }, { pitstop: row }); setThreadStatus(threadId, "needs"); }
  bus.emit("pitstop", { id, botId, threadId, status: "pending", pitstop: row });
  audit("jev", "pitstop.opened", { id, botId, kind, effect, title });
  if (kind === "hire") return Promise.resolve("pending");
  return new Promise((resolve) => {
    waits.set(id, resolve);
    setTimeout(() => decide(id, "expired", {}), expiresMin * 60000).unref();
  });
}

export async function decide(id, decision, { scope = "once", note = "", spec = null } = {}) {
  const ps = one("SELECT * FROM pitstops WHERE id=?", id);
  if (!ps || ps.status !== "pending") return ps;
  const status = decision === "approve" || decision === "approved" ? "approved" : decision === "expired" ? "expired" : "denied";
  if (ps.kind === "hire" && status === "approved") {
    const s = normaliseSpec({ ...json(ps.detail, {}).spec, ...(spec || {}) });
    const bot = createBot(s);
    if (s.schedule?.spec && s.schedule.prompt) { try { addSchedule(bot.id, null, s.schedule.spec, s.schedule.prompt); } catch {} }
    note = `Hired ${bot.name}`;
  }
  const detail = json(ps.detail, {});
  const match = detail.pattern || detail.signature;
  if (status === "approved" && ["thread", "always"].includes(scope) && match && !["pay", "delete", "share"].includes(ps.effect)) {
    run("INSERT INTO rules(id,bot_id,thread_id,effect,match,label,created_at) VALUES(?,?,?,?,?,?,?)", uid("ru"), ps.bot_id, scope === "thread" ? ps.thread_id : null, ps.effect, match, `${describePattern(match)}${scope === "thread" ? " (this thread)" : ""}`, now());
  }
  if (ps.kind === "site") applySiteChoice(ps, status, scope);
  if (detail.pattern && ps.kind !== "hire" && (status === "approved" || status === "denied") && note !== "Kill switch" && learnable(getBot(ps.bot_id)?.policy, ps.effect, json(ps.jev, {}).by)) learn(ps, detail, status);
  run("UPDATE pitstops SET status=?, scope=?, note=?, decided_at=? WHERE id=?", status, scope, String(note).slice(0, 500), now(), id);
  // A kill-switch denial judges nothing about the call, so it trains as no answer.
  const label = note === "Kill switch" ? "expired" : status;
  run("UPDATE jev_labels SET driver_decision=?, driver_scope=? WHERE pitstop_id=?", label, label === "expired" ? null : scope, id);
  audit(status === "expired" ? "system" : "driver", `pitstop.${status}`, { id, scope, title: ps.title });
  const row = one("SELECT * FROM pitstops WHERE id=?", id);
  bus.emit("pitstop", { id, botId: ps.bot_id, threadId: ps.thread_id, status, pitstop: pitRow(row) });
  if (ps.thread_id && active.has(ps.thread_id)) setThreadStatus(ps.thread_id, "running");
  if (ps.thread_id && status === "expired") addEvent(ps.thread_id, null, "system", { text: `Pit stop expired after 30 minutes: nothing was done. (${ps.title})` });
  waits.get(id)?.(status); waits.delete(id);
  return row;
}

async function onRequest(c, method, p) {
  const threadId = byCodex.get(p.threadId);
  if (!threadId) return method === "item/tool/call" ? { success: false, contentItems: [{ type: "inputText", text: "Unknown thread" }] } : { decision: "decline" };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const call = { kind: "shell", command: p.command, cwd: p.cwd };
      const ok = await gate(c, threadId, call, { kind: "command", title: `Run: ${short(String(p.command).replace(/^\/bin\/(ba)?sh -l?c /, ""), 180)}`, detail: { command: p.command, cwd: p.cwd, reason: p.reason || null } });
      return { decision: ok ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths = (items.get(p.itemId)?.changes || []).map((x) => x.path);
      const inside = paths.length && paths.every((x) => x.startsWith("/bot/work/") || !x.startsWith("/"));
      if (inside) return { decision: "accept" };
      const ok = await pitStop({ botId: c.bot.id, threadId, kind: "file", effect: "write", title: `Edit files outside the workspace: ${paths.join(", ").slice(0, 160) || "unknown"}`, detail: { paths, reason: p.reason || null, signature: "file:outside" } });
      return { decision: ok === "approved" ? "accept" : "decline" };
    }
    case "mcpServer/elicitation/request": {
      const tool = /tool "([^"]+)"/.exec(p.message || "")?.[1];
      const args = p._meta?.tool_params || {};
      if (!tool) {
        const ok = await pitStop({ botId: c.bot.id, threadId, kind: "mcp", effect: "ask", title: `${p.serverName} asks: ${short(p.message, 160)}`, detail: { server: p.serverName, message: p.message } });
        return ok === "approved" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
      }
      // Only the driver's own MCP connectors reach here now; browser and pixel tools are Pitcrew tools (runtimeTool).
      const ok = await gate(c, threadId, { kind: "mcp", server: p.serverName, tool, arguments: args }, { kind: "mcp", title: `${p.serverName}: ${tool.replace(/_/g, " ")} ${short(summariseArgs(args), 140)}`, detail: { server: p.serverName, tool, args } });
      return ok ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
    }
    case "item/tool/call": return dynamicTool(c, threadId, p);
    case "item/permissions/requestApproval": return { decision: "decline" };
    default: return undefined;
  }
}

// ---------- dynamic tools ----------
const say = (text, success = true) => ({ success, contentItems: [{ type: "inputText", text }] });
async function dynamicTool(c, threadId, p) {
  const b = getBot(c.bot.id), a = p.arguments || {};
  switch (p.tool) {
    case "render_surface": {
      const v = validateSurface(a);
      if (!v.ok) return say(`VALIDATION_FAILED. Fix these and call render_surface again:\n${v.errors.join("\n")}`, false);
      const id = uid("sf");
      run("INSERT INTO surfaces(id,thread_id,bot_id,title,spec,created_at) VALUES(?,?,?,?,?,?)", id, threadId, b.id, a.title, JSON.stringify(a), now());
      addEvent(threadId, active.get(threadId)?.turnId, "surface", { id, title: a.title }, { surface: { id, title: a.title, spec: a, saved: 0 } });
      return say(`Rendered surface ${id} for the driver.${v.actions.length ? ` Its actions (${v.actions.join(", ")}) will come back to you as a message.` : ""}`);
    }
    case "share_screenshot": {
      const caption = String(a.caption || "").trim().slice(0, 300);
      if (!caption) return say("Give the screenshot a caption", false);
      const screen = a.source === "screen";
      const sa = screen ? {} : { type: "jpeg", ...(a.full_page ? { fullPage: true } : {}), ...(a.element && (a.ref || a.target) ? { element: String(a.element), target: String(a.ref || a.target) } : {}) }; // 0.0.82 names it target
      // Through runtimeTool, so the lease, the gate and the tool log apply as for any screenshot.
      const r = await runtimeTool(c, threadId, { ...p, tool: screen ? "computer_screenshot" : "browser_take_screenshot", arguments: sa });
      if (!r.success) return r;
      const img = imageFrom(r, b.id);
      const shot = img && (await saveShot(b.id, computer(b).name, img));
      if (!shot) return say("The screenshot was taken but couldn't be saved for the driver.", false);
      addEvent(threadId, active.get(threadId)?.turnId, "shot", { botId: b.id, file: shot.file, caption, bytes: shot.bytes });
      audit("crew", "screenshot.shared", { botId: b.id, threadId, file: shot.file, bytes: shot.bytes, original: shot.original });
      return say("Shared with the driver in this chat.");
    }
    case "remember": {
      const text = String(a.text || "").trim().slice(0, 500);
      if (!text) return say("Nothing to remember", false);
      const id = a.id && one("SELECT 1 FROM memory WHERE id=? AND bot_id=?", a.id, b.id) ? a.id : uid("me");
      if (id === a.id) run("UPDATE memory SET text=?, updated_at=? WHERE id=?", text, now(), id);
      else run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.id, text, `thread:${threadId}`, now(), now());
      c.mems.get(p.threadId)?.set(id, text); // this thread already knows; other threads get it on their next turn
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Remembered: ${text}` });
      return say(`Saved as [${id}].`);
    }
    case "forget": {
      run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), String(a.id), b.id);
      c.mems.get(p.threadId)?.delete(String(a.id));
      return say("Forgotten.");
    }
    case "schedule_task": {
      try {
        const s = addSchedule(b.id, threadId, String(a.when || ""), String(a.prompt || ""));
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Scheduled “${s.prompt.slice(0, 80)}” ${s.spec} (next ${new Date(s.next_run + IST).toISOString().slice(0, 16).replace("T", " ")} IST)` });
        return say(`Scheduled ${s.id}: ${s.spec}.`);
      } catch (e) { return say(e.message, false); }
    }
    case "find_threads": {
      const found = findThreads(b.id, a.query, { exclude: threadId, limit: Math.min(Number(a.limit) || 8, 20) });
      if (!found.length) return say(`No other threads match "${String(a.query || "").slice(0, 80)}".`);
      const day = (t) => new Date(t + IST).toISOString().slice(0, 16).replace("T", " ");
      return say(found.map((t) => `- [${t.title}](${threadLink(t.id)}) · last active ${day(t.updated_at)} IST${t.archived ? " · archived" : ""}${t.of ? ` · matched ${t.matched}/${t.of} terms` : ""}${t.snippet ? `\n  ${t.snippet}` : ""}`).join("\n")
        + "\n\nGive the driver the matching thread as a markdown link exactly as written above.");
    }
    case "ask_crew_member": return askCrew(b, threadId, a);
    case "plan": return planTool(b, threadId, a);
    case "propose_crew_member": {
      if (b.kind !== "chief") return say("Only the Crew Chief can propose crew members.", false);
      const spec = normaliseSpec(a);
      pitStop({ botId: b.id, threadId, kind: "hire", effect: "hire", title: `Hire ${spec.name}: ${spec.job.slice(0, 120)}`, detail: { spec }, expiresMin: 7 * 24 * 60 });
      return say(`Proposal sent. ${getSetting("driver_name", "The driver")} reviews it as a HIRE pit stop; don't create anything else for it.`);
    }
    default:
      if (/^(browser|computer)_/.test(p.tool)) return runtimeTool(c, threadId, p);
      return say(`Unknown tool ${p.tool}`, false);
  }
}

// ---------- delegation ----------
// The Crew Chief asks another member and waits for the answer. The member works in its own thread under its own policy,
// cap and computer; none of the Chief's authority travels with the question. One level deep: only the Chief has the tool.
const ASK_WAIT_MS = 10 * 60000;
const nextTurn = (threadId) => new Promise((resolve) => (turnWaiters.get(threadId) || turnWaiters.set(threadId, []).get(threadId)).push(resolve));
const lastAgentText = (threadId, turnId) => json(one("SELECT data FROM events WHERE thread_id=? AND turn_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", threadId, turnId)?.data, {}).text || "";
export function findMember(q, exceptId) {
  const s = String(q || "").trim().toLowerCase();
  const crew = listBots().filter((x) => x.id !== exceptId);
  return crew.find((x) => x.id === q) || crew.find((x) => x.name.toLowerCase() === s) || crew.find((x) => s && x.name.toLowerCase().startsWith(s)) || null;
}
async function askCrew(from, threadId, a) {
  const driver = getSetting("driver_name", "the driver");
  if (from.kind !== "chief") return say("Only the Crew Chief can ask other crew members.", false);
  const to = findMember(a.member, from.id);
  if (!to) return say(`No crew member called "${short(a.member, 60)}". Your crew: ${listBots().filter((x) => x.id !== from.id).map((x) => x.name).join(", ")}.`, false);
  if (to.private) return say(`${to.name} is private: only ${driver} talks to it. Suggest ${driver} asks ${to.name} directly.`, false);
  const question = String(a.question || "").trim().slice(0, 4000);
  if (!question) return say("Pass the question.", false);
  const why = blockedReason(to);
  if (why) return say(`Couldn't ask ${to.name}: ${why}`, false);
  const id = uid("dg"), toThread = uid("th");
  run("INSERT INTO threads(id,bot_id,title,origin,created_at,updated_at) VALUES(?,?,?,?,?,?)", toThread, to.id, `From ${from.name}: ${short(question, 80)}`, JSON.stringify({ kind: "delegated", fromBot: from.id, fromThread: threadId, delegationId: id }), now(), now());
  run("INSERT INTO delegations(id,from_bot,from_thread,to_bot,to_thread,question,status,created_at) VALUES(?,?,?,?,?,?,?,?)", id, from.id, threadId, to.id, toThread, question, "asking", now());
  const card = { id, toBot: to.id, toName: to.name, toThread, question: short(question, 300) };
  addEvent(threadId, active.get(threadId)?.turnId, "delegation", { ...card, status: "asking" });
  audit(from.id, "delegation.asked", { id, to: to.id, fromThread: threadId, toThread });
  const done = nextTurn(toThread);
  // Recorded whenever it ends, also after the Chief stopped waiting.
  done.then((r) => {
    const answer = lastAgentText(toThread, r.turnId), status = r.status === "completed" ? "answered" : "failed";
    run("UPDATE delegations SET status=?, answer=?, cost_usd=?, ended_at=? WHERE id=?", status, answer, r.cost, now(), id);
    addEvent(threadId, null, "delegation", { ...card, status, answer: short(answer, 4000), cost: r.cost });
    audit(to.id, "delegation.ended", { id, status, cost: r.cost });
  });
  await sendMessage(toThread, { text: `${from.name} is asking you this for ${driver}. Answer it fully in your reply; your reply goes back to ${from.name}. Anything that needs ${driver}'s approval still comes to them as a pit stop.\n\n${question}`, trigger: "delegation", display: question });
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), ASK_WAIT_MS).unref())]);
  if (!r) return say(`${to.name} is still working after 10 minutes. Their answer will appear in this thread when it's ready, and in theirs: ${threadLink(toThread)}. Tell ${driver} that.`);
  const answer = lastAgentText(toThread, r.turnId);
  if (r.status !== "completed") return say(`${to.name}'s run ended ${r.status}${answer ? `. Last thing they said:\n${answer}` : ""}. Their thread: ${threadLink(toThread)}`, false);
  return say(`${to.name} answered (their thread: ${threadLink(toThread)}):\n\n${answer || "(no text reply)"}`);
}

// ---------- plans (prototype, behind the "plans" setting) ----------
// The Crew Chief edits a todo; Pitcrew starts every item whose `after` items are done, hands it their results, records
// what comes back and wakes the Chief after each item. Starting, waiting and passing results is code, not the model.
const PLAN = { budget: 1, chiefRuns: 12, reopens: 2, items: 20, itemWaitMs: 10 * 60000 };
const planRow = (id) => { const p = one("SELECT * FROM plans WHERE id=?", id); return p && { ...p, constraints: json(p.constraints, []), checks: json(p.checks, null) }; };
const activePlan = (threadId) => { const p = one("SELECT id FROM plans WHERE thread_id=? AND status='running' ORDER BY created_at DESC LIMIT 1", threadId); return p && planRow(p.id); };
const planItems = (planId) => all("SELECT * FROM plan_items WHERE plan_id=? ORDER BY seq", planId).map((i) => ({ ...i, after: json(i.after, []), result: json(i.result, null), history: json(i.history, []) }));
const ownerOf = (q, chief) => (/^(crew )?chief$/i.test(String(q || "").trim()) || q === chief.id ? chief : findMember(q, chief.id));
function planSpend(p) {
  const items = one("SELECT COALESCE(SUM(cost_usd),0) s FROM plan_items WHERE plan_id=?", p.id).s;
  const chief = one("SELECT COALESCE(SUM(cost_usd),0) s, COUNT(*) n FROM turns WHERE thread_id=? AND started_at>=? AND trigger='plan'", p.thread_id, p.created_at);
  return { usd: items + chief.s, chiefRuns: chief.n };
}
function planText(p, items = planItems(p.id)) {
  const mark = { todo: "[ ]", doing: "[~]", done: "[x]", failed: "[!]", cancelled: "[-]" };
  return items.map((i) => `${mark[i.status] || "[?]"} ${i.key} · ${getBot(i.owner_bot)?.name}: ${short(i.task, 160)}${i.after.length ? ` (after ${i.after.join(", ")})` : ""}${i.reopened ? ` · reopened ×${i.reopened}` : ""}${i.result?.answer ? `\n    → ${short(i.result.answer, 300)}` : ""}`).join("\n");
}
function emitPlan(p) {
  const items = planItems(p.id), spend = planSpend(p);
  addEvent(p.thread_id, null, "plan", { id: p.id, goal: p.goal, constraints: p.constraints, status: p.status, answer: p.answer, checks: p.checks, budget: p.budget_usd, spend: spend.usd, chiefRuns: spend.chiefRuns,
    items: items.map((i) => ({ key: i.key, owner: i.owner_bot, ownerName: getBot(i.owner_bot)?.name, task: short(i.task, 300), status: i.status, after: i.after, why: i.why, reopened: i.reopened, toThread: i.to_thread, cost: i.cost_usd, result: i.result && { answer: short(i.result.answer, 600), assumed: short(i.result.assumed || "", 300), unchecked: short(i.result.unchecked || "", 300) } })) });
}
// Splits a member's reply into the handoff shape the plan asks for; a reply without the sections is all answer.
export function parseHandoff(text) {
  const t = String(text || ""), heads = [["data", /from my data/i], ["assumed", /assumed/i], ["unchecked", /couldn[’']?t check/i]];
  const marks = heads.map(([k, re]) => { const m = new RegExp(`^[\\s>*_#-]*(?:${re.source})[*_:\\s]*:?[*_]*\\s*`, "im").exec(t); return m && { k, at: m.index, end: m.index + m[0].length }; }).filter(Boolean).sort((a, b) => a.at - b.at);
  const out = { answer: (marks.length ? t.slice(0, marks[0].at) : t).trim(), data: "", assumed: "", unchecked: "" };
  marks.forEach((m, i) => { out[m.k] = t.slice(m.end, marks[i + 1]?.at ?? t.length).trim(); });
  return out;
}
function wakeChief(p, text, display) {
  const spend = planSpend(p);
  if (spend.chiefRuns >= PLAN.chiefRuns) { addEvent(p.thread_id, null, "system", { text: `Plan paused: the Crew Chief has run ${PLAN.chiefRuns} times on it. Send a message to let it continue.`, tone: "bad" }); return; }
  const q = queues.get(p.thread_id), last = q?.at(-1);
  if (active.has(p.thread_id) && last?.trigger === "plan") { last.text += `\n\n${text}`; return; }
  sendMessage(p.thread_id, { text, trigger: "plan", mode: "queue", display }).catch((e) => addEvent(p.thread_id, null, "error", { text: e.message }));
}
function dispatchPlan(planId) {
  const p = planRow(planId);
  if (!p || p.status !== "running") return;
  const items = planItems(p.id), done = new Set(items.filter((i) => i.status === "done").map((i) => i.key));
  for (const it of items.filter((i) => i.status === "todo" && i.after.every((k) => done.has(k)))) {
    if (planSpend(p).usd >= p.budget_usd) { addEvent(p.thread_id, null, "system", { text: `Plan budget reached ($${p.budget_usd.toFixed(2)}); ${it.key} didn't start.`, tone: "bad" }); return; }
    startItem(p, it, items);
  }
}
async function startItem(p, it, items) {
  const chief = getBot(one("SELECT bot_id FROM threads WHERE id=?", p.thread_id).bot_id), owner = getBot(it.owner_bot), driver = getSetting("driver_name", "the driver");
  const end = (status, result, cost = 0) => {
    if (one("SELECT status FROM plan_items WHERE id=?", it.id)?.status === "cancelled") { run("UPDATE plan_items SET cost_usd=cost_usd+? WHERE id=?", cost, it.id); return; }
    run("UPDATE plan_items SET status=?, result=?, cost_usd=cost_usd+?, ended_at=? WHERE id=?", status, JSON.stringify(result), cost, now(), it.id);
    const fresh = planRow(p.id); emitPlan(fresh);
    if (fresh.status !== "running") return;
    dispatchPlan(p.id);
    const r = result || {}, running = planItems(p.id).filter((i) => i.status === "doing").map((i) => i.key);
    wakeChief(fresh, [`Plan update from Pitcrew: "${it.key}" (${owner.name}) ${status === "done" ? "finished" : "did not finish"}.`, `Answer: ${r.answer || "(none)"}`,
      r.data && `From their data: ${r.data}`, r.assumed && `Assumed: ${r.assumed}`, r.unchecked && `Couldn't check: ${r.unchecked}`,
      `Todo now:\n${planText(fresh)}`, `Constraints:\n${fresh.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      running.length ? `Still running: ${running.join(", ")}. If nothing needs to change, reply "waiting".` : "Nothing is running. Reopen or add items, or finish."].filter(Boolean).join("\n\n"), `Plan update: ${it.key} ${status === "done" ? "done" : "didn't finish"}`);
  };
  const why = blockedReason(owner);
  if (why) return end("failed", { answer: why });
  const toThread = uid("th"), inputs = it.after.map((k) => items.find((x) => x.key === k)).filter(Boolean);
  run("INSERT INTO threads(id,bot_id,title,origin,created_at,updated_at) VALUES(?,?,?,?,?,?)", toThread, owner.id, `Plan · ${short(it.task, 80)}`, JSON.stringify({ kind: "delegated", fromBot: chief.id, fromThread: p.thread_id, planId: p.id, itemKey: it.key }), now(), now());
  run("UPDATE plan_items SET status='doing', to_thread=?, started_at=? WHERE id=?", toThread, now(), it.id);
  emitPlan(planRow(p.id));
  const text = [`${chief.name} is running a plan for ${driver} and needs this from you.`, `Goal: ${p.goal}`, `Your task: ${it.task}`,
    inputs.length ? `Results from earlier steps you can build on:\n${inputs.map((x) => `- ${x.key} (${getBot(x.owner_bot)?.name}): ${x.result?.answer}${x.result?.assumed ? `\n  (they assumed: ${x.result.assumed})` : ""}`).join("\n")}` : "",
    `Reply with your answer, then end with three short sections titled exactly:\nFrom my data: what came from your own memory, logins or tools.\nAssumed: anything you assumed or estimated, or "nothing".\nCouldn't check: what you couldn't verify, or "nothing".\nDon't add costs, allowances or facts you weren't given; anything estimated goes under Assumed.`].filter(Boolean).join("\n\n");
  const doneP = nextTurn(toThread);
  await sendMessage(toThread, { text, trigger: "delegation", display: it.task }).catch(() => {});
  const r = await Promise.race([doneP, new Promise((res) => setTimeout(() => res(null), PLAN.itemWaitMs).unref())]);
  if (!r) return end("failed", { answer: `${owner.name} didn't finish within ${PLAN.itemWaitMs / 60000} minutes.` });
  const reply = lastAgentText(toThread, r.turnId);
  end(r.status === "completed" ? "done" : "failed", r.status === "completed" ? parseHandoff(reply) : { answer: `Run ended ${r.status}. ${short(reply, 400)}` }, r.cost || 0);
}
function planTool(chief, threadId, a) {
  if (json(getThread(threadId)?.origin)?.kind === "delegated") return say("Plans are run from the Crew Chief's own thread, not from a plan step.", false);
  let p = activePlan(threadId);
  const errs = [];
  if (!p) {
    if (!a.goal || !Array.isArray(a.add) || !a.add.length) return say("Start a plan with goal, constraints and add.", false);
    const id = uid("pl");
    run("INSERT INTO plans(id,thread_id,goal,constraints,status,budget_usd,created_at) VALUES(?,?,?,?,?,?,?)", id, threadId, String(a.goal).slice(0, 1000), JSON.stringify((a.constraints || []).map((c) => String(c).slice(0, 300)).slice(0, 10)), "running", PLAN.budget, now());
    audit(chief.id, "plan.started", { id, threadId });
    p = planRow(id);
  }
  const items = planItems(p.id), byKey = new Map(items.map((i) => [i.key, i]));
  let seq = items.length;
  for (const x of a.add || []) {
    const key = String(x.key || "").trim().slice(0, 40), owner = ownerOf(x.member, chief);
    if (!key || byKey.has(key)) { errs.push(`add ${key || "?"}: key missing or already used (reopen it instead)`); continue; }
    if (!owner) { errs.push(`add ${key}: no crew member called "${short(x.member, 40)}"`); continue; }
    if (owner.private) { errs.push(`add ${key}: ${owner.name} is private; only ${getSetting("driver_name", "the driver")} talks to it`); continue; }
    if (seq >= PLAN.items) { errs.push(`add ${key}: a plan holds at most ${PLAN.items} items`); continue; }
    const after = (x.after || []).map(String).filter((k) => byKey.has(k) || (a.add || []).some((y) => y.key === k));
    const row = { id: uid("pi"), key }; byKey.set(key, row);
    run("INSERT INTO plan_items(id,plan_id,seq,key,owner_bot,task,after,status) VALUES(?,?,?,?,?,?,?,?)", row.id, p.id, seq++, key, owner.id, String(x.task || "").slice(0, 2000), JSON.stringify(after), "todo");
  }
  for (const x of a.reopen || []) {
    const it = byKey.get(String(x.key));
    if (!it?.status) { errs.push(`reopen ${x.key}: no such item`); continue; }
    if (it.status === "doing") { errs.push(`reopen ${x.key}: still running`); continue; }
    if (it.reopened >= PLAN.reopens) { errs.push(`reopen ${x.key}: already reopened ${PLAN.reopens} times; ask ${getSetting("driver_name", "the driver")} before going again`); continue; }
    run("UPDATE plan_items SET status='todo', task=?, why=?, reopened=reopened+1, history=?, result=NULL WHERE id=?", String(x.task).slice(0, 2000), String(x.why || "").slice(0, 300), JSON.stringify([...it.history, { task: it.task, result: it.result }]), it.id);
  }
  // Cancelling a running item stops its run; marked cancelled first so its ending doesn't wake the Chief as a result.
  for (const k of a.cancel || []) {
    const it = byKey.get(String(k));
    if (!it?.status || ["done", "cancelled"].includes(it.status)) continue;
    run("UPDATE plan_items SET status='cancelled', ended_at=? WHERE id=?", now(), it.id);
    if (it.status === "doing" && it.to_thread) interrupt(it.to_thread).catch(() => {});
  }
  if (a.finish) {
    const checks = (a.finish.constraints || []).map((c) => ({ text: String(c.text || "").slice(0, 300), status: ["met", "unmet", "untested"].includes(c.status) ? c.status : "untested", note: String(c.note || "").slice(0, 300) }));
    const missing = p.constraints.filter((c) => !checks.some((k) => k.text.trim().toLowerCase() === c.trim().toLowerCase()));
    if (missing.length) return say(`Not finished: mark every constraint, word for word. Missing: ${missing.join(" | ")}`, false);
    if (planItems(p.id).some((i) => i.status === "doing")) return say("Not finished: items are still running. Cancel them (that stops them) or wait.", false);
    run("UPDATE plan_items SET status='cancelled' WHERE plan_id=? AND status='todo'", p.id);
    run("UPDATE plans SET status='done', answer=?, checks=?, ended_at=? WHERE id=?", String(a.finish.answer).slice(0, 4000), JSON.stringify(checks), now(), p.id);
    audit(chief.id, "plan.finished", { id: p.id, spend: planSpend(p).usd });
    emitPlan(planRow(p.id));
    return say("Plan finished. Now tell the driver the answer in plain words, saying which constraints were met, unmet or untested and anything that rests on an assumption.");
  }
  emitPlan(planRow(p.id));
  dispatchPlan(p.id);
  return say(`${errs.length ? `Not applied:\n- ${errs.join("\n- ")}\n\n` : ""}Todo now:\n${planText(planRow(p.id))}\n\nPitcrew runs ready items and wakes you after each one ends. End this turn now unless you have more to change.`, !errs.length || errs.length < (a.add || []).length + (a.reopen || []).length);
}

// Browser and pixel tools run on the crew member's computer, booting it (and its desktop) on first use.
// The gate sees the grounded element; the computer's MCP server sees only the model's own arguments.
// browser_read is ours: a gated browser_snapshot turned into text, so it runs no page JS.
async function runtimeTool(br, threadId, p) {
  const b = getBot(br.bot.id), turnId = active.get(threadId)?.turnId, t0 = Date.now();
  const kind = p.tool.startsWith("browser_") ? "browser" : "computer", reading = p.tool === "browser_read";
  if (/^browser_(evaluate|run_code)/.test(p.tool)) return say("Page JavaScript isn't available. Use the element tools (click, type, fill_form, snapshot).", false);
  // `snapshot` (what the result shows of the page afterwards) is ours; Playwright never sees it.
  const { snapshot: snapArg, ...given } = p.arguments || {};
  const tool = reading ? "browser_snapshot" : kind === "browser" ? p.tool : p.tool.replace(/^computer_/, "");
  const args = reading ? (given.target ? { target: String(given.target) } : {}) : tool === "browser_take_screenshot" && !given.type && !given.filename ? { ...given, type: "jpeg" } : given;
  const g = kind === "browser" ? ground(snapshots.get(p.threadId), tool, args) : { grounded: pixelContext(args, snapshots.get(p.threadId)), effect: null, label: "" };
  const host = hostOf(g.grounded.page_url);
  const title = `${reading ? "read" : tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(g.label || summariseArgs(args), 140)}${host ? ` on ${host}` : ""}`.trim();
  bus.emit("activity", { threadId, botId: b.id, text: title });
  const ok = await gate(br, threadId, { kind: "mcp", server: kind, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) }, { kind: "mcp", title, detail: { server: kind, tool, args: g.grounded } });
  const timing = { gate: Date.now() - t0 }; // includes a lease wait and jev's remote check (p50 336 ms for browser, measured)
  if (!ok) { addEvent(threadId, turnId, "tool", { type: kind, title, status: "declined", timing }); return say(takeRefusal(threadId) || "Not done: this action was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const comp = computer(b);
  try {
    if (!comp.desktopUp) bus.emit("activity", { threadId, botId: b.id, text: comp.up ? "Starting the desktop…" : "Starting the computer…" });
    let t = Date.now();
    const mcp = await comp.mcp(kind);
    comp.touch();
    timing.boot = Date.now() - t; t = Date.now();
    if (kind === "browser" && tool !== "browser_tabs") await frontTab(mcp);
    if (kind === "browser" && comp.viewers > 0 && /^browser_(click|select_option)$/.test(tool) && args.target) await glideTo(mcp, args);
    const tabsBefore = tabCounts.get(mcp);
    timing.prep = Date.now() - t; t = Date.now();
    const r = await mcp.request("tools/call", { name: tool, arguments: kind === "computer" ? { ...args, _watched: comp.viewers > 0 } : args }, 120000);
    timing.run = Date.now() - t;
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    let out = text;
    if (kind === "browser") {
      const prev = snapshots.get(p.threadId), url = /^- Page URL: (\S+)/m.exec(text)?.[1] || prev?.url || null, snap = snapshotOf(b.id, text);
      const mode = SNAP_MODES.includes(snapArg) ? snapArg : undefined;
      if (reading) out = snap == null ? text : `${pageHead(text)}\n\n${snapshotToText(snap)}`;
      else out = `${SNAP_LINK.test(text) ? `${verifyLine(tool, text, { before: prev?.url, tabsBefore })}\n` : ""}${shapeSnapshot(text, snap, { prev, url, mode })}`;
      noteSnapshot(p.threadId, snap, url, { scoped: !!(args.target || args.depth), seen: !reading && mode !== "none" });
      const post = await afterAction(b, threadId, p.threadId, mcp, { tool, text, snap, url, before: prev?.url, tabsBefore });
      if (post) out = `${post}\n\n${out}`;
      const tb = readTabs(text); if (tb) tabCounts.set(mcp, tb.count);
    }
    addEvent(threadId, turnId, "tool", { type: kind, title, status: r.isError ? "failed" : "completed", output: text.slice(0, 1500), timing });
    return { success: !r.isError, contentItems: toContentItems([{ type: "text", text: out }, ...content.filter((x) => x.type !== "text")], { codeMode: String(p.callId || "").startsWith("exec-") }) };
  } catch (e) {
    addEvent(threadId, turnId, "tool", { type: kind, title, status: "failed", error: e.message });
    return say(`The computer couldn't run ${tool}: ${e.message}`, false);
  }
}
// Pixel actions carry the browser page the agent last saw (URL, title, checkout signal) plus its own `target` words, so
// the site policy and jev judge them in context. The screen may have moved on since; there's no OCR in the image.
const pixelContext = (args, snap) => (snap?.url ? { ...args, page_url: snap.url, ...(snap.title ? { page_title: snap.title } : {}), ...((w) => (w ? { page_checkout: w } : {}))(checkoutWhy({ url: snap.url, title: snap.title, lines: snap.lines })) } : args);
const pageHead = (text) => { const t = /^- Page Title: (.*)$/m.exec(text)?.[1], u = /^- Page URL: (.*)$/m.exec(text)?.[1]; return `Page: ${[t, u && `(${u})`].filter(Boolean).join(" ") || "unknown"}`; };

// Codex hands a dynamic tool's result to an exec script (nested call ids "exec-…") as ONE string, its text and image
// data URLs joined by newlines (codex-rs tools/src/tool_output.rs, 0.156). So there an image result is the bare data URL,
// which image(result) shows. Text items never carry base64: unknown blocks become a placeholder, not JSON.
const noBase64 = (s) => String(s).replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, "[base64 data omitted]").replace(/[A-Za-z0-9+/]{2000,}={0,2}/g, "[base64 data omitted]");
export function toContentItems(content, { codeMode = false } = {}) {
  const items = content.map((x) => x.type === "image" ? { type: "inputImage", imageUrl: `data:${x.mimeType || "image/png"};base64,${x.data}` }
    : { type: "inputText", text: noBase64(x.type === "text" ? x.text : x.type === "resource" && typeof x.resource?.text === "string" ? x.resource.text : `[${x.type} content omitted]`) });
  const images = items.filter((x) => x.type === "inputImage");
  return codeMode && images.length ? images.slice(0, 1) : items;
}

// ---------- tab focus ----------
// Playwright drives its own current tab, which needn't be Chrome's foreground one (a popup opened, the driver switched
// tabs in the live view, or a fresh MCP session adopted tab 0). Then the live view shows another tab, and Chrome throttles
// the background tab's animation frames, so clicks wait on stability checks and time out. Before each action, bring the
// agent's tab to the front. Costs two local MCP calls, only while more than one tab is open.
const tabCounts = new WeakMap(); // browser MCP session → tab count from its last response
export function readTabs(text) {
  const tabs = new Map();
  for (const m of String(text).matchAll(/^- (\d+):( \(current\))? \[/gm)) tabs.set(+m[1], tabs.get(+m[1]) || !!m[2]);
  if (!tabs.size) return /^### Page$/m.test(text) ? { count: 1, current: 0 } : null;
  const current = [...tabs].find(([, cur]) => cur)?.[0];
  return { count: Math.max(...tabs.keys()) + 1, current: current ?? 0 };
}
export async function frontTab(mcp) {
  if (tabCounts.get(mcp) === 1) return;
  try {
    const call = (args) => mcp.request("tools/call", { name: "browser_tabs", arguments: args }, 15000);
    const t = readTabs(((await call({ action: "list" })).content || []).map((x) => x.text || "").join("\n"));
    tabCounts.set(mcp, t?.count ?? 1);
    if (t?.count > 1) await call({ action: "select", index: t.current });
  } catch {}
}

// While the driver watches, move the pointer onto the element first and let the live-view pointer finish its glide,
// so the press lands where the pointer already is instead of mid-flight. Unwatched runs skip it.
// The glide (pointer.js, 250 ms) starts when the hover moves the mouse; the hover's own settle wait has used part of it.
const GLIDE_MS = 250;
async function glideTo(mcp, args) {
  try { await mcp.request("tools/call", { name: "browser_hover", arguments: { element: args.element || "target", target: args.target } }, 15000); } catch {}
  await new Promise((r) => setTimeout(r, Math.max(0, GLIDE_MS - PW_SETTLE_MS)));
}

// ---------- finding past threads ----------
// Ranks a crew member's own threads by how many query terms appear in the title (weighted) and the transcript.
// One indexed scan of that member's user/agent events per call; calls are rare (a tool call or a search box).
const HOST = process.env.PITCREW_HOST || "pitcrew.example.com";
export function findThreads(botId, query, { exclude = null, limit = 8 } = {}) {
  const terms = [...new Set(String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))].slice(0, 8);
  const threads = all("SELECT id,title,archived,created_at,updated_at FROM threads WHERE bot_id=? AND id IS NOT ? ORDER BY updated_at DESC", botId, exclude);
  if (!terms.length) return threads.slice(0, limit).map((t) => ({ ...t, score: 0, snippet: "" }));
  const byId = new Map(threads.map((t) => [t.id, { ...t, hits: new Set(), score: 0, snippet: "" }]));
  const like = terms.map(() => "lower(data) LIKE ?").join(" OR ");
  for (const e of all(`SELECT thread_id, data FROM events WHERE kind IN ('user','agent') AND thread_id IN (SELECT id FROM threads WHERE bot_id=?) AND (${like})`, botId, ...terms.map((t) => `%${t}%`))) {
    const t = byId.get(e.thread_id); if (!t) continue;
    const text = String(json(e.data, {}).text || ""), low = text.toLowerCase();
    for (const term of terms) if (low.includes(term)) {
      t.hits.add(term); t.score += 1;
      if (!t.snippet) { const i = low.indexOf(term); t.snippet = `${i > 60 ? "…" : ""}${text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, " ").trim()}…`; }
    }
  }
  for (const t of byId.values()) for (const term of terms) if (t.title.toLowerCase().includes(term)) { t.hits.add(term); t.score += 5; }
  return [...byId.values()].filter((t) => t.hits.size).sort((a, b) => b.hits.size - a.hits.size || b.score - a.score || b.updated_at - a.updated_at)
    .slice(0, limit).map(({ hits, ...t }) => ({ ...t, matched: hits.size, of: terms.length }));
}
export const threadLink = (id) => `https://${HOST}/#/t/${id}`;

// ---------- schedules ----------
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export function nextRun(spec, from = now()) {
  let m;
  if ((m = /^every (\d+) (minute|minutes|hour|hours)$/i.exec(spec))) {
    const ms = +m[1] * (m[2].startsWith("hour") ? 3600000 : 60000);
    if (ms < 15 * 60000) throw new Error("Schedules run at most every 15 minutes");
    return from + ms;
  }
  const at = (d, hh, mm) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - IST;
  if ((m = /^daily (\d{1,2}):(\d{2})$/i.exec(spec))) {
    const d = new Date(from + IST); let t = at(d, +m[1], +m[2]);
    if (t <= from) t += 86400000;
    return t;
  }
  if ((m = /^weekly (mon|tue|wed|thu|fri|sat|sun) (\d{1,2}):(\d{2})$/i.exec(spec))) {
    const d = new Date(from + IST); const today = (d.getUTCDay() + 6) % 7, want = DOW.indexOf(m[1].toLowerCase());
    let t = at(d, +m[2], +m[3]) + ((want - today + 7) % 7) * 86400000;
    if (t <= from) t += 7 * 86400000;
    return t;
  }
  throw new Error('Use "daily HH:MM", "weekly mon HH:MM" or "every N minutes|hours"');
}
export function addSchedule(botId, threadId, spec, prompt) {
  spec = spec.trim().toLowerCase();
  if (!prompt.trim()) throw new Error("A schedule needs a prompt");
  const next = nextRun(spec);
  const id = uid("sc");
  run("INSERT INTO schedules(id,bot_id,thread_id,spec,prompt,next_run,created_at) VALUES(?,?,?,?,?,?,?)", id, botId, threadId, spec, prompt.trim().slice(0, 2000), next, now());
  audit("crew", "schedule.added", { id, botId, spec });
  return one("SELECT * FROM schedules WHERE id=?", id);
}
let nextPrune = 0;
function tickSchedules() {
  // Rides the schedule tick (30 s) but deletes at most hourly; the ts index keeps it a range scan.
  if (now() >= nextPrune) { nextPrune = now() + 3600000; pruneLabels(); }
  if (getSetting("paused") === "1") return;
  for (const s of all("SELECT * FROM schedules WHERE enabled=1 AND next_run<=?", now())) {
    run("UPDATE schedules SET last_run=?, next_run=? WHERE id=?", now(), nextRun(s.spec), s.id);
    let threadId = s.thread_id && getThread(s.thread_id) ? s.thread_id : one("SELECT id FROM threads WHERE bot_id=? AND pinned=1 AND archived=0 LIMIT 1", s.bot_id)?.id;
    if (!threadId) { threadId = uid("th"); run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", threadId, s.bot_id, "Scheduled work", 1, now(), now()); }
    sendMessage(threadId, { text: `[Scheduled: ${s.spec}] ${s.prompt}`, mode: "queue", trigger: "schedule" }).catch((e) => addEvent(threadId, null, "error", { text: e.message }));
  }
}

// ---------- screen lease ----------
export function takeControl(botId) { if (!leases.has(botId)) leases.set(botId, { since: now(), waiters: [] }); audit("driver", "computer.take_control", { botId }); bus.emit("lease", { botId, held: true }); }
function releaseLease(botId, action, why) {
  const l = leases.get(botId);
  if (!l) return;
  leases.delete(botId);
  l.waiters.forEach((w) => w(true));
  audit("driver", action, { botId });
  bus.emit("lease", { botId, held: false });
  for (const ps of all("SELECT id FROM pitstops WHERE bot_id=? AND kind='lease' AND status='pending'", botId)) decide(ps.id, "approve", { note: "Control handed back" });
  if (why) for (const [tid, a] of active) if (getThread(tid)?.bot_id === botId) addEvent(tid, a.turnId, "system", { text: why });
}
export function handBack(botId, note = "") {
  releaseLease(botId, "computer.hand_back");
  if (note.trim()) for (const [tid] of active) if (getThread(tid)?.bot_id === botId) sendMessage(tid, { text: `I handed the computer back. ${note}`, mode: "auto" }).catch(() => {});
}
export const leaseHeld = (botId) => leases.has(botId);

// ---------- kill switch ----------
export async function killSwitch() {
  setSetting("paused", "1");
  const inFlight = [...active.keys()].map((t) => ({ threadId: t, title: getThread(t)?.title }));
  for (const ps of all("SELECT id FROM pitstops WHERE status='pending' AND kind!='hire'")) await decide(ps.id, "deny", { note: "Kill switch" });
  await Promise.all([...active.keys()].map((t) => interrupt(t)));
  await Promise.all([...allComputers().map((c) => c.stop()), ...allBrains().map((x) => x.stop())]);
  audit("driver", "killswitch", { inFlight });
  bus.emit("paused", { paused: true });
  return { inFlight };
}
export function resumeCrew() { setSetting("paused", "0"); audit("driver", "crew.resumed"); bus.emit("paused", { paused: false }); }

// ---------- boot ----------
export function bootRuntime() {
  // Pit stops from a previous process can't be answered: their Codex requests died with the computers.
  for (const ps of all("SELECT id,thread_id FROM pitstops WHERE status='pending' AND kind!='hire'")) run("UPDATE pitstops SET status='expired', note='Control plane restarted', decided_at=? WHERE id=?", now(), ps.id);
  run("UPDATE turns SET status='failed', error='Control plane restarted', ended_at=? WHERE status IN ('starting','running')", now());
  run("UPDATE threads SET status='idle' WHERE status!='idle'"); // also clears pre-v1.2 'done'/'failed' thread states
  // Name threads left untitled (from before naming existed, or still on small talk) from their first real message.
  for (const t of all("SELECT id FROM threads WHERE title=?", UNTITLED)) {
    const first = all("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id LIMIT 20", t.id).map((e) => json(e.data, {})).find((d) => !isSmallTalk(d.text) || d.attachments?.length);
    if (first) { const title = titleFrom(first.text, first.attachments || []); if (title !== UNTITLED) run("UPDATE threads SET title=? WHERE id=?", title, t.id); }
  }
  setInterval(tickSchedules, 30000).unref();
  startShotSweeper();
}
export { isBusy, isThinking };

export function saveUpload(threadId, name, buf) {
  const t = getThread(threadId);
  const safe = String(name).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
  const rel = `uploads/${Date.now().toString(36)}-${safe}`;
  ensureDirs(t.bot_id);
  writeFileSync(`${botDir(t.bot_id)}/work/${rel}`, buf);
  chownSync(`${botDir(t.bot_id)}/work/${rel}`, 1500, 1500);
  return rel;
}
export { listBots };
