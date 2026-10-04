// Turns on a member's brain: sending a message, starting and finishing a run, steering, interrupting, compacting.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { one, all, run, now, uid, json, getSetting } from "../db.js";
import { getBot, instructions, dynamicTools, engramBlock } from "../crew.js";
import { botDir, toolManifest } from "../computer.js";
import { providerReady, estimateCost } from "../providers.js";
import { snapshot, changes } from "../snapshot.js";
import { bus } from "./bus.js";
import { active, byCodex, turnWaiters, wakeFor, type TurnEnd } from "./state.js";
import { enqueue, peekQueued, takeQueued, requeue, queuedThreads } from "./queue.js";
import { getThread, addEvent, setThreadStatus, nameThread } from "./threads.js";
import { brain, computer } from "./machines.js";
import { weekSpend, logSize, billedUsage } from "./spend.js";
import { activePlan, planLog, emitPlan, planRow } from "./planStore.js";
import { ensureMemberToken, threadContext, skillsIndex, engramMemories } from "../engram.js";
import { memberLinked } from "../engramStore.js";
import { setRollout } from "./scripts.js";
import { taint, tainted } from "./taint.js";
import { postLearned } from "./learned.js";
import { isUsageLimit, armResume, clearResume } from "./resume.js";
import type { Bot } from "../../shared/types.js";

export const isRunning = (threadId: string) => active.has(threadId);

export interface Message { text?: unknown; attachments?: string[]; mode?: string; trigger?: string; display?: string | null }
export async function sendMessage(threadId: string, { text: given, attachments = [], mode = "auto", trigger = "driver", display = null }: Message) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error("No such thread"), { status: 404 });
  const text = String(given || "").slice(0, 20000);
  if (!text.trim() && !attachments.length) throw Object.assign(new Error("Say something"), { status: 400 });
  if (trigger === "driver" && text.trim() === "/refresh" && !attachments.length) return refresh(threadId);
  nameThread(t, text, attachments);
  const a = active.get(threadId);
  // A queued message stays out of the transcript until it actually goes to the member (startQueued).
  if (a && mode === "queue") return { queued: true, id: enqueue(threadId, { text, attachments, trigger, display }) };
  const said = () => addEvent(threadId, null, "user", { text, attachments, via: trigger, ...(display ? { display } : {}) });
  if (a) {
    await brain(getBot(t.bot_id)!).request("turn/steer", { threadId: t.codex_id, expectedTurnId: a.codexTurnId, input: toInput(t.bot_id, text, attachments) });
    said();
    return { steered: true };
  }
  said();
  startTurn(threadId, text, attachments, trigger).catch((e) => {
    if (e.silent) return;
    addEvent(threadId, null, "error", { text: e.message });
    setThreadStatus(threadId, "idle");
  });
  return { started: true };
}

// Images are read here and sent inline: the brain can't see the computer's disk.
function toInput(botId: string, text: string, attachments: string[]) {
  const input: Record<string, unknown>[] = [];
  const isImg = (f: string) => /\.(png|jpe?g|webp|gif)$/i.test(f);
  const body = attachments.length ? `${text}\n\nAttached files (in /bot/work on your computer): ${attachments.join(", ")}` : text;
  if (body.trim()) input.push({ type: "text", text: body, text_elements: [] });
  for (const f of attachments.filter(isImg)) {
    try {
      const buf = readFileSync(`${botDir(botId)}/work/${f}`);
      if (buf.length < 8 << 20) input.push({ type: "image", url: `data:image/${f.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")};base64,${buf.toString("base64")}` });
    } catch {}
  }
  return input;
}

const ENVS = [{ environmentId: "computer", cwd: "/bot/work" }];
// Why a member can't start a run now, or null. Delegation checks it first, so the Chief gets a reason instead of a wait.
export function blockedReason(b: Bot) {
  if (getSetting("paused") === "1") return "The crew is stopped (kill switch). Resume the crew in Settings first.";
  if (weekSpend(b.id) >= b.weekly_cap_usd) return `${b.name} has reached this week's cap ($${b.weekly_cap_usd.toFixed(2)}). Raise the cap to continue.`;
  if (!providerReady(b.provider)) return `${b.name} uses ${b.provider === "openai" ? "the ChatGPT plan" : b.provider}, which isn't connected. Add it in Settings → Providers.`;
  return null;
}
// A tool set's identity: its names, sorted. Descriptions can change without a restart; a new or removed tool can't.
export const toolsSig = (tools: { name?: string }[]) => createHash("sha1").update(tools.map((x) => x.name).sort().join("\n")).digest("hex").slice(0, 12);
// What a fresh Codex thread is told about the one it replaces: the latest user and agent messages, newest kept whole
// first, about 8,000 chars in all. One indexed query of at most 40 rows.
export function recap(threadId: string, carry: string | null = null, current = "", max = 8000) {
  const rows = all<{ kind: string; data: string }>("SELECT kind, data FROM events WHERE thread_id=? AND kind IN ('user','agent') ORDER BY id DESC LIMIT 40", threadId);
  // The message starting this turn goes in as the turn's own input, not the recap.
  if (rows[0]?.kind === "user" && json(rows[0].data, {}).text === current) rows.shift();
  const lines: string[] = []; let size = 0;
  for (const r of rows) {
    const line = `${r.kind === "user" ? "Driver" : "You"}: ${String(json(r.data, {}).text || "").trim().slice(0, 1500)}`;
    if (size + line.length > max) break;
    lines.unshift(line); size += line.length;
  }
  return [carry, `This thread continues an earlier conversation. Your tools changed since it started, so it was restarted. Files in /bot/work are as you left them. The latest messages, oldest first:\n\n${lines.join("\n\n")}`].filter(Boolean).join("\n\n");
}
export async function startTurn(threadId: string, text: string, attachments: string[], trigger: string) {
  const t = getThread(threadId)!, b = getBot(t.bot_id)!;
  const why = blockedReason(b);
  if (why) throw new Error(why);
  const warm = warmPlan(threadId);
  if (warm) computer(b).prewarm(warm.desktop);
  const turnId = uid("tu");
  active.set(threadId, { turnId, codexTurnId: null, base: null, total: null, last: null, usageFrom: logSize(b.id), ...(trigger === "schedule" ? { quietFrom: t.updated_at } : {}) });
  run("INSERT INTO turns(id,thread_id,bot_id,status,trigger,provider,model,started_at) VALUES(?,?,?,?,?,?,?,?)", turnId, threadId, b.id, "starting", trigger, b.provider, b.model, now());
  setThreadStatus(threadId, "running");
  try {
    const c = brain(b);
    if (!c.up) await ensureMemberToken(b);
    await c.ensure();
    let codexId = t.codex_id;
    const tools = dynamicTools(b, await toolManifest(), { engram: memberLinked(b) }), sig = toolsSig(tools);
    // Dynamic tools are fixed at thread/start: resume and fork keep the old set (codex 0.156.1; their params have no
    // dynamicTools). When the set changed since this Codex thread started, start a new one and carry a recap over.
    if (codexId && t.tools_sig !== sig) {
      const old = codexId;
      await c.unload(old).catch(() => {}); byCodex.delete(old);
      codexId = null;
      run("UPDATE threads SET codex_id=NULL, carry=? WHERE id=?", recap(threadId, t.carry, text), threadId);
      addEvent(threadId, null, "system", { text: `${b.name}'s tools changed since this thread started, so ${b.name} picks it up fresh with a recap of the conversation.` });
    }
    const refreshNow = refreshing.delete(threadId) && !!codexId;
    // Engram context only where instructions are sent (start/resume) or on /refresh, so a normal turn makes no Engram
    // call. A new thread or a /refresh always syncs: one GET per thread start, not per turn.
    const eg = !codexId || !c.loaded.has(codexId) || refreshNow ? await threadContext(b, !codexId || refreshNow) : null;
    // A linked member whose sync failed still gets the Engram rules (no profile or skills): its remember goes there.
    const egCtx = eg ? { profile: eg.profile, skills: skillsIndex(eg.skills) } : memberLinked(b) ? { profile: null, skills: "" } : null;
    // A linked member's memories are Engram's (cached from the last sync); null until one succeeds, so nothing is
    // reported forgotten just because Engram was unreachable.
    const mems = memberLinked(b) ? engramMemories(b.id) : all<{ id: string; text: string }>("SELECT id,text FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at LIMIT 60", b.id);
    const common = { model: b.model, modelProvider: b.provider, cwd: "/bot/work", developerInstructions: instructions(b, mems ?? [], egCtx) };
    let refreshed: string | null = null;
    if (!codexId) {
      const st = await c.request("thread/start", { ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", environments: ENVS, dynamicTools: tools }, 120000);
      codexId = st.thread.id as string;
      run("UPDATE threads SET codex_id=?, tools_sig=? WHERE id=?", codexId, sig, threadId);
      c.loaded.add(codexId);
      setRollout(b.id, codexId, st.thread.path);
      await c.mcpReady(codexId);
    } else if (refreshNow) {
      // A fork is the only per-thread way to reconnect MCP: unsubscribe + resume reuses the loaded session's tools. It keeps
      // the history, dynamic tools and the original instructions (new ones are ignored), so Engram's current skills and
      // profile go in as this turn's context (all measured 2026-10-02, codex 0.156.1). The old thread is never resumed.
      const old = codexId, seen = c.mems.get(old);
      const f = await c.request("thread/fork", { threadId: old, model: b.model, modelProvider: b.provider, cwd: "/bot/work", sandbox: "danger-full-access", approvalPolicy: "untrusted", excludeTurns: true }, 120000);
      codexId = f.thread.id as string;
      setRollout(b.id, codexId, f.thread.path);
      run("UPDATE threads SET codex_id=? WHERE id=?", codexId, threadId);
      await c.unload(old); byCodex.delete(old);
      c.loaded.add(codexId);
      c.mems.set(codexId, seen ?? new Map());  // unknown after a brain restart: every memory goes in as context
      await c.mcpReady(codexId);
      if (eg && egCtx) refreshed = `Refreshed just now; this replaces any earlier Engram profile and skills list.\n\n${engramBlock(getSetting("driver_name", "the driver"), egCtx, b.engram_scope)}`;
    } else if (!c.loaded.has(codexId)) {
      c.mcp.delete(codexId);
      const r = await c.request("thread/resume", { threadId: codexId, ...common, sandbox: "danger-full-access", approvalPolicy: "untrusted", excludeTurns: true }, 120000);
      c.loaded.add(codexId);
      setRollout(b.id, codexId, r?.thread?.path);
      await c.mcpReady(codexId);
    }
    // Developer instructions reach Codex only at start/resume (which just sent the current list); memories saved since
    // go in as turn context, persisted in the thread's history.
    if (mems && !c.mems.has(codexId)) c.mems.set(codexId, memMap(mems));
    const memDelta = mems && memoryDelta(c.mems.get(codexId), mems);
    byCodex.set(codexId, threadId);
    const a0 = active.get(threadId);
    if (a0) try { a0.snap = snapshot(b.id); } catch {}
    const carry = getThread(threadId)!.carry;
    if (carry) run("UPDATE threads SET carry=NULL WHERE id=?", threadId);
    const ctx = { ...(memDelta ? { pitcrew_memory: { kind: "application", value: memDelta } } : {}), ...(refreshed ? { pitcrew_engram: { kind: "application", value: refreshed } } : {}) };
    // Every turn names the computer environment, so commands never run in the brain itself.
    const r = await c.request("turn/start", { threadId: codexId, environments: ENVS, input: toInput(b.id, carry ? `${carry}\n\n---\n\n${text}` : text, attachments), responsesapiClientMetadata: { pitcrew_turn: turnId },
      ...(Object.keys(ctx).length ? { additionalContext: ctx } : {}) }, 120000);
    if (memDelta && mems) c.mems.set(codexId, memMap(mems));
    const a = active.get(threadId);
    if (a) a.codexTurnId = r.turn.id;
    run("UPDATE turns SET codex_turn_id=?, status='running' WHERE id=?", r.turn.id, turnId);
  } catch (e: any) {
    finishTurn(threadId, "failed", e.message);
    throw Object.assign(new Error(e.message), { silent: true });
  }
}

const memMap = (mems: { id: string; text: string }[]) => new Map(mems.map((m) => [m.id, m.text]));
// What changed in a member's memory since this thread was last told, or null. Rendered by Codex as a developer
// message (<pitcrew_memory>) at that point in the thread, so the cached prefix stays intact.
export function memoryDelta(seen: Map<string, string> | undefined, mems: { id: string; text: string }[]) {
  if (!seen) return null;
  const changed = mems.filter((m) => seen.get(m.id) !== m.text).map((m) => `- [${m.id}] ${m.text}`);
  const ids = new Set(mems.map((m) => m.id)), gone = [...seen.keys()].filter((id) => !ids.has(id));
  if (!changed.length && !gone.length) return null;
  return [`Your memory changed since this thread was told (this replaces older entries with the same id):`, ...changed, ...(gone.length ? [`Forgotten: ${gone.map((id) => `[${id}]`).join(", ")}`] : [])].join("\n");
}

// Which stage of the computer the next turn likely needs, from the thread's last 3 turns: stage 1 (exec-server, ~20 MiB)
// if any ran a command or used the browser/screen, the desktop (~470 MiB) only if the last one did. One indexed query per turn.
const EXEC_TOOLS = new Set(["commandExecution", "browser", "computer"]);
export function warmPlan(threadId: string) {
  const recent = all<{ id: string }>("SELECT id FROM turns WHERE thread_id=? ORDER BY started_at DESC LIMIT 3", threadId).map((t) => t.id);
  if (!recent.length) return null;
  const used = all<{ turn_id: string; type: string }>(`SELECT turn_id, json_extract(data,'$.type') type FROM events WHERE thread_id=? AND kind='tool' AND turn_id IN (${recent.map(() => "?").join(",")})`, threadId, ...recent);
  if (!used.some((u) => EXEC_TOOLS.has(u.type))) return null;
  return { desktop: used.some((u) => u.turn_id === recent[0] && (u.type === "browser" || u.type === "computer")) };
}

// Opening a thread in the UI starts its member's brain (~0.3-0.6 s cold), so the first message doesn't wait on it.
export function prewarmBrain(threadId: string) {
  const t = getThread(threadId), b = t && getBot(t.bot_id);
  if (b && !b.archived && getSetting("paused") !== "1") brain(b).prewarm();
}

export async function finishTurn(threadId: string, status: string, error?: string | null) {
  const a = active.get(threadId);
  if (!a) return;
  active.delete(threadId);
  const t = getThread(threadId)!, b = getBot(t.bot_id)!;
  const u = a.total && a.base ? { input: a.total.inputTokens - a.base.inputTokens, cached: a.total.cachedInputTokens - a.base.cachedInputTokens, output: a.total.outputTokens - a.base.outputTokens } : { input: 0, cached: 0, output: 0 };
  const billed = billedUsage(b.id, a.turnId, a.usageFrom);
  if (billed) Object.assign(u, { input: billed.input, cached: billed.cached, output: billed.output });
  const cost = billed?.cost != null ? { usd: billed.cost, basis: "billed" } : await estimateCost(b.provider, b.model, u).catch(() => ({ usd: 0, basis: "unknown" }));
  run("UPDATE turns SET status=?, error=?, ended_at=?, input_tokens=?, cached_tokens=?, output_tokens=?, cost_usd=?, cost_basis=? WHERE id=?",
    status, error || null, now(), u.input, u.cached, u.output, cost.usd, cost.basis, a.turnId);
  if (error) addEvent(threadId, a.turnId, "error", { text: error });
  if (status === "failed" && isUsageLimit(error)) armResume(threadId, error!); else if (status === "completed") clearResume(threadId);
  // What changed on disk during this turn, however it was changed.
  if (a.snap) try {
    const ch = changes(b.id, a.snap, snapshot(b.id));
    if (ch.length) {
      run("UPDATE turns SET changes=? WHERE id=?", JSON.stringify(ch), a.turnId);
      addEvent(threadId, a.turnId, "changes", { turnId: a.turnId, botId: b.id, count: ch.length, files: ch.slice(0, 12).map((c) => ({ path: c.path, status: c.status, lines: c.lines })) });
    }
  } catch {}
  postLearned(threadId, a.turnId, b.id);
  // A delegated thread's answer carries what it read, so untrusted content also taints the thread that asked.
  const from = tainted(threadId) && t.origin ? json<{ fromThread?: string }>(t.origin, {}).fromThread : null;
  if (from && taint(from)) addEvent(from, null, "system", { text: `${b.name}'s answer came from a thread with untrusted content. For the next 10 minutes, sending, paying, signing in, sharing and deleting ask you first.` });
  setThreadStatus(threadId, "idle");
  // A scheduled run with nothing notable ends "QUIET: …": the thread keeps its place instead of jumping to the top, and
  // the web app folds the run to one line. Anything else is news and surfaces as usual.
  if (a.quietFrom != null && status === "completed" && isQuiet(lastAgentText(threadId, a.turnId))) run("UPDATE threads SET updated_at=? WHERE id=?", a.quietFrom, threadId);
  bus.emit("turn", { threadId, turnId: a.turnId, status, cost: cost.usd, botId: b.id });
  if (wakeFor.has(threadId)) { const p = activePlan(threadId); if (p) { planLog(p.id, `Looked after ${wakeFor.get(threadId)}: no change`); emitPlan(planRow(p.id)!); } wakeFor.delete(threadId); }
  for (const w of turnWaiters.get(threadId)?.splice(0) || []) w({ turnId: a.turnId, status, cost: cost.usd });
  // After a failure the queue waits for the driver: a broken brain or provider would otherwise fail every queued item in turn.
  if (status !== "failed") startQueued(threadId);
}

/** Starts the thread's oldest queued message if nothing runs there. A blocked member (kill switch, cap, provider) leaves it
 * at the head of the queue, so nothing is dropped; quiet skips the error line (boot and resume would repeat it per thread). */
export function startQueued(threadId: string, quiet = false) {
  if (active.has(threadId)) return false;
  const t = getThread(threadId), b = t && getBot(t.bot_id), q = b && peekQueued(threadId);
  if (!q) return false;
  const why = blockedReason(b);
  if (why) { if (!quiet) addEvent(threadId, null, "error", { text: `${why} Your queued message is still waiting.` }); return false; }
  takeQueued(threadId, q.id);
  addEvent(threadId, null, "user", { text: q.text, attachments: q.attachments, via: q.via, ...(q.display ? { display: q.display } : {}) });
  startTurn(threadId, q.text, q.attachments, q.via).catch((e) => { if (!e.silent) { addEvent(threadId, null, "error", { text: e.message }); setThreadStatus(threadId, "idle"); } });
  return true;
}
/** Threads with queued messages and no run, e.g. after a restart or a kill-switch resume. */
export const idleQueued = () => queuedThreads().filter((id) => !active.has(id));
export const startQueues = (quiet = true) => idleQueued().map((id) => startQueued(id, quiet)).filter(Boolean).length;

// A note from Pitcrew into the running turn (not the driver's words, so no user event): e.g. that a pit stop expired.
export async function steerNote(threadId: string, text: string) {
  const a = active.get(threadId), t = getThread(threadId);
  if (!a?.codexTurnId || !t?.codex_id) return false;
  await brain(getBot(t.bot_id)!).request("turn/steer", { threadId: t.codex_id, expectedTurnId: a.codexTurnId, input: toInput(t.bot_id, `[Pitcrew] ${text}`, []) });
  return true;
}
/** The driver's "Send now": steers it into the running turn, or starts it. A failed delivery puts it back in place. */
export async function sendQueuedNow(threadId: string, id: string) {
  const t = getThread(threadId), q = peekQueued(threadId, id);
  if (!t || !q) throw Object.assign(new Error("No such queued message"), { status: 404 });
  if (!active.has(threadId)) { const why = blockedReason(getBot(t.bot_id)!); if (why) throw Object.assign(new Error(why), { status: 409 }); }
  takeQueued(threadId, id);
  try { return await sendMessage(threadId, { text: q.text, attachments: q.attachments, mode: "auto", trigger: q.via, display: q.display }); }
  catch (e) { requeue(threadId, q); throw e; }
}
export function removeQueued(threadId: string, id: string) {
  if (!takeQueued(threadId, id)) throw Object.assign(new Error("No such queued message"), { status: 404 });
  return { ok: true };
}

export async function interrupt(threadId: string) {
  const t = getThread(threadId), a = active.get(threadId);
  if (!t || !a) return false;
  const c = brain(getBot(t.bot_id)!);
  if (a.codexTurnId && c.up) await c.request("turn/interrupt", { threadId: t.codex_id, turnId: a.codexTurnId }).catch(() => {});
  else finishTurn(threadId, "interrupted");
  return true;
}
// /refresh: the thread's next message runs on a fork with fresh MCP tools and Engram's current skills and profile. Only
// on request, never automatically: changed tools or context change the prompt prefix, so that turn misses the cache.
const refreshing = new Set<string>();
export function refresh(threadId: string) {
  if (active.has(threadId)) throw Object.assign(new Error("Wait for the run to finish, then /refresh"), { status: 409 });
  refreshing.add(threadId);
  addEvent(threadId, null, "system", { text: "Tools and skills reload with your next message." });
  return { refreshed: true };
}
export async function compact(threadId: string) {
  const t = getThread(threadId);
  if (!t?.codex_id) throw Object.assign(new Error("Nothing to compact yet"), { status: 400 });
  if (active.has(threadId)) throw Object.assign(new Error("Wait for the run to finish"), { status: 409 });
  const b = getBot(t.bot_id)!, c = brain(b);
  await c.ensure();
  if (!c.loaded.has(t.codex_id)) { await c.request("thread/resume", { threadId: t.codex_id, model: b.model, modelProvider: b.provider, excludeTurns: true }); c.loaded.add(t.codex_id); }
  byCodex.set(t.codex_id, threadId);
  await c.request("thread/compact/start", { threadId: t.codex_id });
  addEvent(threadId, null, "system", { text: "Compacting the thread…" });
}

// The next run to finish on a thread, for whoever asked it something (delegation, plans).
export const nextTurn = (threadId: string) => new Promise<TurnEnd>((resolve) => (turnWaiters.get(threadId) || turnWaiters.set(threadId, []).get(threadId)!).push(resolve));
export const isQuiet = (text: string) => /^\s*QUIET\b/.test(text);
export const lastAgentText = (threadId: string, turnId: string): string => json(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND turn_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", threadId, turnId)?.data, {}).text || "";
