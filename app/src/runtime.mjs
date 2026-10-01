// The runtime: turns on each crew member's brain, its computer on demand, the jev gate and pit stops, Pitcrew tools,
// schedules, kill switch.
import { writeFileSync, chownSync, readFileSync, statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { posix } from "node:path";
import { execFs } from "./execfs.mjs";
import { one, all, run, now, uid, json, getSetting, setSetting, audit, pruneLabels } from "./db.mjs";
import { getSecret } from "./auth.mjs";
import { jev, redact } from "./jev.mjs";
import { getBot, listBots, instructions, dynamicTools, normaliseSpec, createBot } from "./crew.mjs";
import { brainFor, computerFor, allComputers, allBrains, botDir, ensureDirs, usageLog, toolManifest, PW_OUT } from "./computer.mjs";
import { providerReady, estimateCost } from "./providers.mjs";
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
const usage = new Map();    // codex thread id → last total usage
const snapshots = new Map(); // codex thread id → { url, lines } from the last browser snapshot the agent saw

export const getThread = (id) => one("SELECT * FROM threads WHERE id=?", id);
export const isRunning = (threadId) => active.has(threadId);
const isBusy = (c) => [...active.keys()].some((t) => getThread(t)?.bot_id === c.bot.id) || one("SELECT 1 FROM pitstops WHERE bot_id=? AND status='pending' AND kind!='hire'", c.bot.id);

// `live` rides on the SSE payload only (the pit stop or surface row), so an open thread draws it without a refetch.
function addEvent(threadId, turnId, kind, data, live = null) {
  const r = run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", threadId, turnId, kind, JSON.stringify(data), now());
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
async function startTurn(threadId, text, attachments, trigger) {
  const t = getThread(threadId), b = getBot(t.bot_id);
  if (getSetting("paused") === "1") throw new Error("The crew is stopped (kill switch). Resume the crew in Settings first.");
  if (weekSpend(b.id) >= b.weekly_cap_usd) throw new Error(`${b.name} has reached this week's cap ($${b.weekly_cap_usd.toFixed(2)}). Raise the cap to continue.`);
  if (!providerReady(b.provider)) throw new Error(`${b.name} uses ${b.provider === "openai" ? "the ChatGPT plan" : b.provider}, which isn't connected. Add it in Settings → Providers.`);
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
    byCodex.set(codexId, threadId);
    const a0 = active.get(threadId);
    if (a0) try { a0.snap = snapshot(b.id); } catch {}
    const carry = getThread(threadId).carry;
    if (carry) run("UPDATE threads SET carry=NULL WHERE id=?", threadId);
    // Every turn names the computer environment, so commands never run in the brain itself.
    const r = await c.request("turn/start", { threadId: codexId, environments: ENVS, input: toInput(b.id, carry ? `${carry}\n\n---\n\n${text}` : text, attachments), responsesapiClientMetadata: { pitcrew_turn: turnId } }, 120000);
    const a = active.get(threadId);
    if (a) a.codexTurnId = r.turn.id;
    run("UPDATE turns SET codex_turn_id=?, status='running' WHERE id=?", r.turn.id, turnId);
  } catch (e) {
    finishTurn(threadId, "failed", e.message);
    throw Object.assign(new Error(e.message), { silent: true });
  }
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
const subtract = (x, y) => Object.fromEntries(Object.keys(x).map((k) => [k, (x[k] || 0) - (y?.[k] || 0)]));

// ---------- grounding ----------
// Playwright MCP acts on bare refs ("e44"). Resolve them against the snapshot the agent itself read, so jev judges
// 'button "Submit order"' on httpbin.org, not "e44". Runs once per browser action; the lookup is a line scan.
// Playwright MCP writes the snapshot it takes after each action to a file (PW_OUT, see computer.mjs) and returns only a
// link, so read that file too: otherwise refs from any page but the last explicit snapshot ground to nothing.
function keepSnapshot(botId, codexId, text) {
  let refs = text;
  if (!text.includes("[ref=")) {
    const link = /\[Snapshot\]\(([^)\s]+\.yml)\)/.exec(text)?.[1];
    const abs = link && posix.resolve("/bot/work", link);
    if (!abs?.startsWith(`${PW_OUT}/`)) return;
    const r = execFs(botId, "fs/readFile", { path: `file://${abs}` });
    if (!r.result) return;
    refs = Buffer.from(r.result.dataBase64, "base64").toString("utf8");
  }
  if (!refs.includes("[ref=")) return;
  snapshots.set(codexId, { url: /Page URL: (\S+)/.exec(text)?.[1] || snapshots.get(codexId)?.url || null, lines: refs.split("\n").filter((l) => l.includes("[ref=")) });
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
  const grounded = { ...args, page_url: snap?.url || null, ...(elements.length ? { grounded_elements: elements } : {}) };
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

// Decides one tool call. Returns true to run it. Rules and standing approvals first, then jev, then the driver.
async function gate(c, threadId, call, pit) {
  const b = getBot(c.bot.id);
  if (call.kind === "mcp" && ["browser", "computer"].includes(call.server) && !(await waitLease(b.id, threadId, call))) return false;
  const sig = signature(call), pat = pattern(call);
  const v = await jev(call, { policy: b.policy, apiKey: getSecret("openrouter") || "missing" });
  if (v.decision === "block") { logDecision(threadId, b.id, v, call); addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Blocked by jev: ${v.reason}. Nothing ran.`, tone: "bad" }); return false; }
  if (v.decision === "allow") return logDecision(threadId, b.id, v, call);
  // A standing approval covers repeats of the same action, but never money, deletion or sharing.
  const standing = ruleFor(b.id, threadId, [pat, sig], v.effect === "unknown" ? "ask" : v.effect);
  if (standing && !["pay", "delete", "share"].includes(v.effect)) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `rule:${standing.label}`, source: "standing" });
  const learned = learnedTrust(b, pat, v);
  if (learned) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `learned:${pat} (${learned.approvals} approvals)`, source: "learned" });
  // Logged before the pit stop opens, so decide() always finds the label row to fill in.
  const id = uid("ps");
  logDecision(threadId, b.id, v, call, { decision: "ask", pitstop: id });
  const decision = await pitStop({ id, botId: b.id, threadId, kind: pit.kind, effect: v.effect === "unknown" ? "ask" : v.effect, title: pit.title, detail: { ...pit.detail, signature: sig, pattern: pat }, jev: v });
  return decision === "approved";
}
// Every gate decision lands in the audit log and jev_labels, so "why did this run without asking?" always has an answer.
// Per gate call: one redaction walk and two small INSERTs. v is the rules'/jev's verdict; the options are what overrode it.
const labelSource = (by) => (by === "fail-closed" ? "fail-closed" : /^(jev|judge):/.test(by || "") ? "jev" : "rule");
export function logDecision(threadId, botId, v, call, { decision = v.decision, by = v.by, source = labelSource(v.by), pitstop = null } = {}) {
  const safe = redact(call);
  audit("jev", `gate.${decision}`, { threadId, effect: v.effect, by, reason: v.reason, ms: v.ms ?? null, call: gateSummary(safe), ...(pitstop ? { pitstop } : {}) });
  const verdict = { effect: v.effect, decision: v.decision, reason: v.reason, by: v.by, model: /^(jev|judge):/.test(v.by || "") ? v.by.replace(/^\w+:/, "") : null, ms: v.ms ?? null, answers: v.answers ?? null, probabilities: v.probabilities ?? null };
  run("INSERT INTO jev_labels(id,ts,bot_id,thread_id,source,call,verdict,decision,pitstop_id) VALUES(?,?,?,?,?,?,?,?,?)", uid("jl"), now(), botId, threadId ?? null, source,
    JSON.stringify({ ...safe, host: hostOf(call.arguments?.page_url) || null }), JSON.stringify(verdict), decision, pitstop);
  if (decision === "allow") bus.emit("jev", { threadId, effect: v.effect, by, ms: v.ms ?? null });
  return decision === "allow";
}
const gateSummary = (c) => (c.kind === "shell" ? { kind: "shell", command: String(c.command).slice(0, 300) } : { kind: c.kind, server: c.server, tool: c.tool, args: JSON.stringify(c.arguments || {}).slice(0, 300) });

export const pitRow = (p) => p && { ...p, detail: json(p.detail, {}), jev: json(p.jev, {}), learn: p.status === "pending" ? learnProgress(p) : null };
export function pitStop({ id = uid("ps"), botId, threadId, kind, effect, title, detail, jev: v = {}, expiresMin = 30 }) {
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
      const sa = screen ? {} : { type: "jpeg", ...(a.full_page ? { fullPage: true } : {}), ...(a.element && a.ref ? { element: String(a.element), ref: String(a.ref) } : {}) };
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
      if (a.id && one("SELECT 1 FROM memory WHERE id=? AND bot_id=?", a.id, b.id)) run("UPDATE memory SET text=?, updated_at=? WHERE id=?", text, now(), a.id);
      else run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("me"), b.id, text, `thread:${threadId}`, now(), now());
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Remembered: ${text}` });
      return say("Saved.");
    }
    case "forget": {
      run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), String(a.id), b.id);
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

// Browser and pixel tools run on the crew member's computer, booting it (and its desktop) on first use.
// The gate sees the grounded element; the computer's MCP server sees only the model's own arguments.
async function runtimeTool(br, threadId, p) {
  const b = getBot(br.bot.id), args = p.arguments || {}, turnId = active.get(threadId)?.turnId, t0 = Date.now();
  const kind = p.tool.startsWith("browser_") ? "browser" : "computer";
  const tool = kind === "browser" ? p.tool : p.tool.replace(/^computer_/, "");
  if (/^browser_(evaluate|run_code)/.test(p.tool)) return say("Page JavaScript isn't available. Use the element tools (click, type, fill_form, snapshot).", false);
  const g = kind === "browser" ? ground(snapshots.get(p.threadId), p.tool, args) : { grounded: args, effect: null, label: "" };
  const host = hostOf(g.grounded.page_url);
  const title = `${tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(g.label || summariseArgs(args), 140)}${host ? ` on ${host}` : ""}`.trim();
  bus.emit("activity", { threadId, botId: b.id, text: title });
  const ok = await gate(br, threadId, { kind: "mcp", server: kind, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) }, { kind: "mcp", title, detail: { server: kind, tool, args: g.grounded } });
  const timing = { gate: Date.now() - t0 }; // includes a lease wait and jev's remote check (p50 336 ms for browser, measured)
  if (!ok) { addEvent(threadId, turnId, "tool", { type: kind, title, status: "declined", timing }); return say("Not done: this action was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const comp = computer(b);
  try {
    if (!comp.desktopUp) bus.emit("activity", { threadId, botId: b.id, text: comp.up ? "Starting the desktop…" : "Starting the computer…" });
    let t = Date.now();
    const mcp = await comp.mcp(kind);
    comp.touch();
    timing.boot = Date.now() - t; t = Date.now();
    if (kind === "browser" && tool !== "browser_tabs") await frontTab(mcp);
    if (kind === "browser" && comp.viewers > 0 && /^browser_(click|select_option)$/.test(tool) && args.target) await glideTo(mcp, args);
    timing.prep = Date.now() - t; t = Date.now();
    const r = await mcp.request("tools/call", { name: tool, arguments: kind === "computer" ? { ...args, _watched: comp.viewers > 0 } : args }, 120000);
    timing.run = Date.now() - t;
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    if (kind === "browser") { keepSnapshot(b.id, p.threadId, text); const t = readTabs(text); if (t) tabCounts.set(mcp, t.count); }
    addEvent(threadId, turnId, "tool", { type: kind, title, status: r.isError ? "failed" : "completed", output: text.slice(0, 1500), timing });
    return { success: !r.isError, contentItems: content.map((x) => x.type === "image" ? { type: "inputImage", imageUrl: `data:${x.mimeType || "image/png"};base64,${x.data}` } : { type: "inputText", text: x.type === "text" ? x.text : JSON.stringify(x).slice(0, 4000) }) };
  } catch (e) {
    addEvent(threadId, turnId, "tool", { type: kind, title, status: "failed", error: e.message });
    return say(`The computer couldn't run ${tool}: ${e.message}`, false);
  }
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
// so the press lands where the pointer already is instead of mid-flight. Unwatched runs skip it (~0.6 s per click).
const GLIDE_MS = 520;
async function glideTo(mcp, args) {
  try { await mcp.request("tools/call", { name: "browser_hover", arguments: { element: args.element || "target", target: args.target } }, 15000); } catch {}
  await new Promise((r) => setTimeout(r, GLIDE_MS));
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
