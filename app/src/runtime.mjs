// The runtime: turns on each crew member's computer, the jev gate and pit stops, dynamic tools, schedules, kill switch.
import { writeFileSync, chownSync, mkdirSync } from "node:fs";
import { one, all, run, now, uid, json, getSetting, setSetting, audit } from "./db.mjs";
import { getSecret } from "./auth.mjs";
import { jev } from "./jev.mjs";
import { getBot, listBots, instructions, dynamicTools, normaliseSpec, createBot } from "./crew.mjs";
import { computerFor, allComputers, botDir, ensureDirs } from "./computer.mjs";
import { providerReady, estimateCost } from "./providers.mjs";
import { validateSurface } from "./surfaces.mjs";

// ---------- live bus (SSE) ----------
const clients = new Set();
export const bus = {
  add(res) { clients.add(res); res.on("close", () => clients.delete(res)); },
  emit(type, data) { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); },
};
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25000).unref();

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

function addEvent(threadId, turnId, kind, data) {
  const r = run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", threadId, turnId, kind, JSON.stringify(data), now());
  run("UPDATE threads SET updated_at=? WHERE id=?", now(), threadId);
  bus.emit("event", { id: Number(r.lastInsertRowid), threadId, turnId, kind, data, ts: now() });
}
function setThreadStatus(threadId, status) {
  run("UPDATE threads SET status=?, updated_at=? WHERE id=?", status, now(), threadId);
  const t = getThread(threadId);
  bus.emit("thread", { id: threadId, botId: t?.bot_id, status });
}

// Monday 00:00 in Asia/Kolkata (UTC+5:30, no DST).
const IST = 330 * 60000;
export function weekStart(t = now()) {
  const d = new Date(t + IST); const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - IST;
}
export const weekSpend = (botId) => one("SELECT COALESCE(SUM(cost_usd),0) s FROM turns WHERE bot_id=? AND started_at>=?", botId, weekStart()).s;

// ---------- computer hooks ----------
const hooks = {
  isBusy,
  onState: (c) => bus.emit("computer", { botId: c.bot.id, up: c.up, startedAt: c.startedAt }),
  onExit: (c, code, errTail) => {
    for (const [tid, a] of active) {
      if (getThread(tid)?.bot_id !== c.bot.id) continue;
      finishTurn(tid, "failed", `The computer stopped (exit ${code}).`);
    }
    if (code && code !== 143 && code !== 137) addSystemForBot(c.bot.id, `Computer stopped unexpectedly (exit ${code}). ${errTail.split("\n").filter(Boolean).slice(-1)[0] || ""}`.trim());
  },
  onNotify: (c, method, p) => onNotify(c, method, p),
  onRequest: (c, method, p) => onRequest(c, method, p),
};
function addSystemForBot(botId, text) {
  const t = one("SELECT id FROM threads WHERE bot_id=? ORDER BY updated_at DESC LIMIT 1", botId);
  if (t) addEvent(t.id, null, "system", { text, tone: "bad" });
}
export const computer = (bot) => computerFor(bot, hooks);

// ---------- turns ----------
export async function sendMessage(threadId, { text, attachments = [], mode = "auto", trigger = "driver", display = null }) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error("No such thread"), { status: 404 });
  text = String(text || "").slice(0, 20000);
  if (!text.trim() && !attachments.length) throw Object.assign(new Error("Say something"), { status: 400 });
  addEvent(threadId, null, "user", { text, attachments, via: trigger, ...(display ? { display } : {}) });
  const a = active.get(threadId);
  if (a) {
    if (mode === "queue") { (queues.get(threadId) || queues.set(threadId, []).get(threadId)).push({ text, attachments, trigger }); addEvent(threadId, null, "system", { text: "Queued for after this run." }); return { queued: true }; }
    const c = computer(getBot(t.bot_id));
    await c.request("turn/steer", { threadId: t.codex_id, expectedTurnId: a.codexTurnId, input: toInput(text, attachments) });
    return { steered: true };
  }
  startTurn(threadId, text, attachments, trigger).catch((e) => {
    if (e.silent) return;
    addEvent(threadId, null, "error", { text: e.message });
    setThreadStatus(threadId, "failed");
  });
  return { started: true };
}

function toInput(text, attachments) {
  const input = [];
  const files = attachments.filter((f) => !/\.(png|jpe?g|webp|gif)$/i.test(f));
  const body = files.length ? `${text}\n\nAttached files (in /bot/work): ${files.join(", ")}` : text;
  if (body.trim()) input.push({ type: "text", text: body, text_elements: [] });
  for (const f of attachments.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))) input.push({ type: "localImage", path: `/bot/work/${f}` });
  return input;
}

async function startTurn(threadId, text, attachments, trigger) {
  const t = getThread(threadId), b = getBot(t.bot_id);
  if (getSetting("paused") === "1") throw new Error("The crew is stopped (kill switch). Resume the crew in Settings first.");
  if (weekSpend(b.id) >= b.weekly_cap_usd) throw new Error(`${b.name} has reached this week's cap ($${b.weekly_cap_usd.toFixed(2)}). Raise the cap to continue.`);
  if (!providerReady(b.provider)) throw new Error(`${b.name} uses ${b.provider === "openai" ? "the ChatGPT plan" : b.provider}, which isn't connected. Add it in Settings → Providers.`);
  const turnId = uid("tu");
  active.set(threadId, { turnId, codexTurnId: null, base: null, total: null, last: null });
  run("INSERT INTO turns(id,thread_id,bot_id,status,trigger,provider,model,started_at) VALUES(?,?,?,?,?,?,?,?)", turnId, threadId, b.id, "starting", trigger, b.provider, b.model, now());
  setThreadStatus(threadId, "running");
  try {
    const c = computer(b);
    if (!c.up) addEvent(threadId, turnId, "system", { text: "Starting the computer…" });
    await c.ensure();
    const mems = all("SELECT id,text FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at LIMIT 60", b.id);
    const common = { model: b.model, modelProvider: b.provider, cwd: "/bot/work", developerInstructions: instructions(b, mems) };
    let codexId = t.codex_id;
    if (!codexId) {
      const st = await c.request("thread/start", { ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", dynamicTools: dynamicTools(b) }, 120000);
      codexId = st.thread.id;
      run("UPDATE threads SET codex_id=? WHERE id=?", codexId, threadId);
      c.loaded.add(codexId);
    } else if (!c.loaded.has(codexId)) {
      await c.request("thread/resume", { threadId: codexId, ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", excludeTurns: true }, 120000);
      c.loaded.add(codexId);
    }
    byCodex.set(codexId, threadId);
    const carry = getThread(threadId).carry;
    if (carry) run("UPDATE threads SET carry=NULL WHERE id=?", threadId);
    const r = await c.request("turn/start", { threadId: codexId, input: toInput(carry ? `${carry}\n\n---\n\n${text}` : text, attachments) }, 120000);
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
  const cost = await estimateCost(b.provider, b.model, u).catch(() => ({ usd: 0, basis: "unknown" }));
  run("UPDATE turns SET status=?, error=?, ended_at=?, input_tokens=?, cached_tokens=?, output_tokens=?, cost_usd=?, cost_basis=? WHERE id=?",
    status, error || null, now(), u.input, u.cached, u.output, cost.usd, cost.basis, a.turnId);
  if (error) addEvent(threadId, a.turnId, "error", { text: error });
  setThreadStatus(threadId, status === "completed" ? "done" : status === "interrupted" ? "idle" : "failed");
  bus.emit("turn", { threadId, turnId: a.turnId, status, cost: cost.usd, botId: b.id });
  const next = queues.get(threadId)?.shift();
  if (next) startTurn(threadId, next.text, next.attachments, next.trigger).catch((e) => { if (!e.silent) addEvent(threadId, null, "error", { text: e.message }); });
}

export async function interrupt(threadId) {
  const t = getThread(threadId), a = active.get(threadId);
  if (!t || !a) return false;
  const c = computer(getBot(t.bot_id));
  if (a.codexTurnId && c.up) await c.request("turn/interrupt", { threadId: t.codex_id, turnId: a.codexTurnId }).catch(() => {});
  else finishTurn(threadId, "interrupted");
  return true;
}
export async function compact(threadId) {
  const t = getThread(threadId);
  if (!t?.codex_id) throw Object.assign(new Error("Nothing to compact yet"), { status: 400 });
  if (active.has(threadId)) throw Object.assign(new Error("Wait for the run to finish"), { status: 409 });
  const b = getBot(t.bot_id), c = computer(b);
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
      if (["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"].includes(it.type)) {
        const label = it.type === "mcpToolCall" && it.server === "browser" ? ground(p.threadId, it.tool, it.arguments || {}).label : "";
        bus.emit("activity", { threadId, botId: c.bot.id, text: label ? `${it.tool.replace(/^browser_/, "")} ${short(label, 100)}` : toolTitle(it) });
      }
      break;
    }
    case "item/completed": {
      const it = p.item; items.delete(it.id);
      if (it.type === "agentMessage" && it.text?.trim()) addEvent(threadId, a?.turnId, "agent", { text: it.text, itemId: it.id });
      else if (it.type === "commandExecution") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, exitCode: it.exitCode ?? null, output: String(it.aggregatedOutput || "").slice(-1500) });
      else if (it.type === "mcpToolCall") {
        const label = it.server === "browser" ? ground(p.threadId, it.tool, it.arguments || {}).label : "";
        if (it.server === "browser") keepSnapshot(p.threadId, it);
        addEvent(threadId, a?.turnId, "tool", { type: it.type, title: label ? `${it.tool.replace(/^browser_/, "")} ${short(label, 140)}` : toolTitle(it), status: it.status, output: mcpResultText(it), error: it.error?.message || null });
      }
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
function keepSnapshot(codexId, it) {
  const text = (it.result?.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  if (!text.includes("[ref=")) return;
  snapshots.set(codexId, { url: /Page URL: (\S+)/.exec(text)?.[1] || snapshots.get(codexId)?.url || null, lines: text.split("\n").filter((l) => l.includes("[ref=")) });
}
const CONSEQUENTIAL_PAY = /\b(pay|buy|purchase|place order|checkout|check out|transfer|subscribe|donate|confirm payment)\b/i;
const CONSEQUENTIAL_SEND = /\b(submit|send|post|publish|reply|confirm|sign up|register|book|reserve|apply|delete|remove|cancel (my )?(order|subscription|account))\b/i;
function ground(codexId, tool, args) {
  const snap = snapshots.get(codexId);
  const find = (ref) => snap?.lines.find((l) => l.includes(`[ref=${ref}]`))?.replace(/\[ref=[^\]]+\]/, "").replace(/^\s*-\s*/, "").trim().slice(0, 160);
  const refs = [args.target, args.ref, ...(Array.isArray(args.fields) ? args.fields.map((f) => f.target || f.ref) : [])].filter(Boolean);
  const elements = refs.map((r) => ({ ref: r, element: find(r) || "(not in the last snapshot)" }));
  const grounded = { ...args, page_url: snap?.url || null, ...(elements.length ? { grounded_elements: elements } : {}) };
  let effect = null;
  const label = elements.map((e) => e.element).join(" ");
  if (/^browser_(click|press_key|select_option)$/.test(tool) && elements.length) effect = CONSEQUENTIAL_PAY.test(label) ? "pay" : CONSEQUENTIAL_SEND.test(label) ? "send" : null;
  return { grounded, effect, label };
}

// ---------- the gate ----------
function signature(call) {
  if (call.kind === "shell") return `cmd:${String(call.command).replace(/^\/bin\/(ba)?sh -l?c /, "").replace(/^['"]/, "").trim().split(/\s+/).slice(0, 2).join(" ")}`;
  if (call.kind === "mcp") return `mcp:${call.server}/${call.tool}`;
  return `${call.kind}:*`;
}
function ruleFor(botId, threadId, sig) {
  return one("SELECT * FROM rules WHERE bot_id=? AND match=? AND revoked_at IS NULL AND (thread_id IS NULL OR thread_id=?)", botId, sig, threadId);
}

async function waitLease(botId, threadId) {
  const l = leases.get(botId);
  if (!l) return true;
  addEvent(threadId, active.get(threadId)?.turnId, "system", { text: "Waiting: you have the wheel. Hand back control to let the crew continue." });
  return new Promise((res) => { l.waiters.push(res); setTimeout(() => res(false), 30 * 60000); });
}

// Decides one tool call. Returns true to run it. Rules and standing approvals first, then jev, then the driver.
async function gate(c, threadId, call, pit) {
  const b = getBot(c.bot.id);
  if (call.kind === "mcp" && ["browser", "computer"].includes(call.server) && !(await waitLease(b.id, threadId))) return false;
  const sig = signature(call);
  const standing = ruleFor(b.id, threadId, sig);
  const v = await jev(call, { policy: b.policy, apiKey: getSecret("openrouter") || "missing" });
  if (v.decision === "block") { audit("jev", "gate.block", { threadId, effect: v.effect, reason: v.reason, call: gateSummary(call) }); addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Blocked by jev: ${v.reason}. Nothing ran.`, tone: "bad" }); return false; }
  if (v.decision === "allow") return logDecision(threadId, v, call);
  // A standing approval covers repeats of the same action, but never money, deletion or sharing.
  if (standing && !["pay", "delete", "share"].includes(v.effect)) return logDecision(threadId, { ...v, decision: "allow", by: `rule:${standing.label}` }, call);
  const decision = await pitStop({ botId: b.id, threadId, kind: pit.kind, effect: v.effect === "unknown" ? "ask" : v.effect, title: pit.title, detail: { ...pit.detail, signature: sig }, jev: v });
  return decision === "approved";
}
// Every gate decision lands in the audit log, so "why did this run without asking?" always has an answer.
function logDecision(threadId, v, call) {
  audit("jev", `gate.${v.decision}`, { threadId, effect: v.effect, by: v.by, reason: v.reason, ms: v.ms ?? null, call: gateSummary(call) });
  bus.emit("jev", { threadId, effect: v.effect, by: v.by, ms: v.ms ?? null });
  return true;
}
const gateSummary = (c) => (c.kind === "shell" ? { kind: "shell", command: String(c.command).slice(0, 300) } : { kind: c.kind, server: c.server, tool: c.tool, args: JSON.stringify(c.arguments || {}).slice(0, 300) });

export function pitStop({ botId, threadId, kind, effect, title, detail, jev: v = {}, expiresMin = 30 }) {
  const id = uid("ps");
  run("INSERT INTO pitstops(id,bot_id,thread_id,turn_id,kind,effect,title,detail,jev,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id, botId, threadId, threadId ? active.get(threadId)?.turnId ?? null : null, kind, effect, title, JSON.stringify(detail), JSON.stringify(v), now(), now() + expiresMin * 60000);
  if (threadId) { addEvent(threadId, active.get(threadId)?.turnId, "pitstop", { id }); setThreadStatus(threadId, "needs"); }
  bus.emit("pitstop", { id, botId, status: "pending" });
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
  if (status === "approved" && ["thread", "always"].includes(scope) && detail.signature && !["pay", "delete", "share"].includes(ps.effect)) {
    run("INSERT INTO rules(id,bot_id,thread_id,effect,match,label,created_at) VALUES(?,?,?,?,?,?,?)", uid("ru"), ps.bot_id, scope === "thread" ? ps.thread_id : null, ps.effect, detail.signature, `${detail.signature.replace(/^(cmd|mcp):/, "")}${scope === "thread" ? " (this thread)" : ""}`, now());
  }
  run("UPDATE pitstops SET status=?, scope=?, note=?, decided_at=? WHERE id=?", status, scope, String(note).slice(0, 500), now(), id);
  audit(status === "expired" ? "system" : "driver", `pitstop.${status}`, { id, scope, title: ps.title });
  bus.emit("pitstop", { id, botId: ps.bot_id, status });
  if (ps.thread_id && active.has(ps.thread_id)) setThreadStatus(ps.thread_id, "running");
  if (ps.thread_id && status === "expired") addEvent(ps.thread_id, null, "system", { text: `Pit stop expired after 30 minutes: nothing was done. (${ps.title})` });
  waits.get(id)?.(status); waits.delete(id);
  return one("SELECT * FROM pitstops WHERE id=?", id);
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
      const g = p.serverName === "browser" ? ground(p.threadId, tool, args) : { grounded: args, effect: null, label: "" };
      const call = { kind: "mcp", server: p.serverName, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) };
      const what = g.label || summariseArgs(args);
      const where = g.grounded.page_url ? ` on ${(() => { try { return new URL(g.grounded.page_url).hostname; } catch { return g.grounded.page_url; } })()}` : "";
      const ok = await gate(c, threadId, call, { kind: "mcp", title: `${tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(what, 140)}${where}`, detail: { server: p.serverName, tool, args: g.grounded } });
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
      addEvent(threadId, active.get(threadId)?.turnId, "surface", { id, title: a.title });
      return say(`Rendered surface ${id} for the driver.${v.actions.length ? ` Its actions (${v.actions.join(", ")}) will come back to you as a message.` : ""}`);
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
    case "propose_crew_member": {
      if (b.kind !== "chief") return say("Only the Crew Chief can propose crew members.", false);
      const spec = normaliseSpec(a);
      pitStop({ botId: b.id, threadId, kind: "hire", effect: "hire", title: `Hire ${spec.name}: ${spec.job.slice(0, 120)}`, detail: { spec }, expiresMin: 7 * 24 * 60 });
      return say(`Proposal sent. ${getSetting("driver_name", "The driver")} reviews it as a HIRE pit stop; don't create anything else for it.`);
    }
    default: return say(`Unknown tool ${p.tool}`, false);
  }
}

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
function tickSchedules() {
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
export function handBack(botId, note = "") {
  const l = leases.get(botId); leases.delete(botId);
  l?.waiters.forEach((w) => w(true));
  audit("driver", "computer.hand_back", { botId });
  bus.emit("lease", { botId, held: false });
  if (note.trim()) for (const [tid] of active) if (getThread(tid)?.bot_id === botId) sendMessage(tid, { text: `I handed the computer back. ${note}`, mode: "auto" }).catch(() => {});
}
export const leaseHeld = (botId) => leases.has(botId);

// ---------- kill switch ----------
export async function killSwitch() {
  setSetting("paused", "1");
  const inFlight = [...active.keys()].map((t) => ({ threadId: t, title: getThread(t)?.title }));
  for (const ps of all("SELECT id FROM pitstops WHERE status='pending' AND kind!='hire'")) await decide(ps.id, "deny", { note: "Kill switch" });
  await Promise.all([...active.keys()].map((t) => interrupt(t)));
  await Promise.all(allComputers().map((c) => c.stop()));
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
  run("UPDATE threads SET status='idle' WHERE status IN ('running','needs')");
  setInterval(tickSchedules, 30000).unref();
}
export { isBusy };

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
