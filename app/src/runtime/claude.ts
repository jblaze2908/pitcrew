// Claude Code as a worker: a member hands it a coding task. It runs the unmodified `claude` CLI, signed in with the
// driver's own Claude plan, in a throwaway container over the member's /bot/work. The login lives in claudeDir(), which
// no member computer mounts; Pitcrew only stats it (deploy/claude-login.sh writes it).
import { spawn } from "node:child_process";
import { query, type CanUseTool, type PermissionResult, type SDKMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { all, audit, driverName, getSetting, json, now, one, uid } from "../db.js";
import { claudeDir, claudeStatus } from "../providers.js";
import { IMAGE, CREW_UID, botDir, docker, ensureNet, gitIdentity, type Brain } from "../computer.js";
import type { Bot, ClaudeCard } from "../../shared/types.js";
import type { ToolResult } from "../shots.js";
import { addEvent } from "./threads.js";
import { gate } from "./gate.js";
import { pitStop, decide } from "./pitstops.js";
import { sendMessage } from "./turns.js";
import { hostOf, say, short, TZ } from "./util.js";

const WAIT_MS = 10 * 60000, RUN_MS = 60 * 60000, FLUSH_MS = 4000;
interface Run { card: ClaudeCard; botId: string; threadId: string; abort: AbortController; pits: Set<string>; flushed: number; timer: NodeJS.Timeout | null }
const runs = new Map<string, Run>();
// One run at a time: one login, one usage window.
let line: Promise<unknown> = Promise.resolve();

export async function delegateToClaude(c: Brain, b: Bot, threadId: string, a: Record<string, any>): Promise<ToolResult> {
  if (getSetting("paused") === "1") return say("The crew is stopped (kill switch).", false);
  if (!claudeStatus().connected) return say(`Claude Code isn't signed in on this server. Tell ${driverName()}: Settings → Models → Claude Code.`, false);
  const task = String(a.task || "").trim().slice(0, 8000);
  if (!task) return say("Pass the task.", false);
  const r: Run = { card: { id: uid("cc"), task, status: "queued", steps: [], read: 0, edited: [], commands: 0, questions: 0, startedAt: now() }, botId: b.id, threadId, abort: new AbortController(), pits: new Set(), flushed: 0, timer: null };
  runs.set(r.card.id, r);
  flush(r, true);
  audit(b.id, "claude.started", { id: r.card.id, threadId });
  const done = line.then(() => execute(c, b, r));
  // A run that throws must not stall every run after it.
  line = done.catch(() => {});
  const ended = await Promise.race([done.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), WAIT_MS).unref())]);
  if (!ended) {
    done.then(() => sendMessage(threadId, { text: `[Claude Code finished]\n${outcome(r)}`, trigger: "claude", display: "Claude Code finished", mode: "queue" }).catch(() => {}));
    return say(`Claude Code is still working after 10 minutes. Its result comes back to you as a message when it finishes; tell ${driverName()} that.`);
  }
  return say(outcome(r), r.card.status === "done");
}

/** Stops one run, or every run (kill switch). Its open pit stops close with it. */
export function stopClaude(id?: string) {
  for (const r of id ? [runs.get(id)].filter((x): x is Run => !!x) : [...runs.values()]) {
    r.abort.abort();
    for (const ps of r.pits) decide(ps, "deny", { note: "Claude Code stopped" }).catch(() => {});
  }
  return { ok: true };
}

/** At boot: a run the previous process left live died with it (reapOrphans removed its container); its card says so. */
export function settleClaudeCards() {
  const last = all<{ thread_id: string; data: string }>("SELECT thread_id, data FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind='claude' GROUP BY json_extract(data,'$.id'))");
  for (const e of last) { const d = json(e.data, {}) as ClaudeCard; if (["queued", "working", "asking"].includes(d.status)) addEvent(e.thread_id, null, "claude", { ...d, status: "stopped", error: "Pitcrew restarted during the run", endedAt: now() }); }
}

async function execute(c: Brain, b: Bot, r: Run) {
  if (r.abort.signal.aborted) return end(r, "stopped");
  r.card.status = "working"; r.card.startedAt = now(); flush(r, true);
  const kill = setTimeout(() => r.abort.abort(), RUN_MS).unref();
  // Killing `docker run` leaves the container running; remove it once the SDK's stdin-close grace has passed.
  r.abort.signal.addEventListener("abort", () => setTimeout(() => docker(["rm", "-f", r.card.id]), 3000).unref(), { once: true });
  try {
    const net = await ensureNet(b.id);
    let result: Extract<SDKMessage, { type: "result" }> | null = null;
    // settingSources [] keeps settings and hooks a task folder may carry (or a web page planted) from running with the login.
    const q = query({ prompt: r.card.task, options: {
      cwd: "/bot/work", pathToClaudeCodeExecutable: "claude", spawnClaudeCodeProcess: inContainer(b, net, r.card.id),
      settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, permissionMode: "acceptEdits",
      abortController: r.abort, canUseTool: canUse(c, r),
      systemPrompt: { type: "preset", preset: "claude_code", append: `You work for ${b.name}, a Pitcrew crew member, in its workspace /bot/work; it handed you this task and will check your work. Use AskUserQuestion only for a real choice the code can't settle: it goes to ${driverName()}, who may take a while. End with a short summary: what you changed, how you checked it, what's left.` },
    } });
    for await (const m of q) {
      if (m.type === "assistant") for (const part of m.message.content) { if (part.type === "tool_use") { const s = stepOf(r, part.name, part.input as Record<string, any>); if (s) { r.card.steps = [...r.card.steps, s].slice(-3); flush(r); } } }
      else if (m.type === "result") result = m;
    }
    if (result?.subtype === "success" && !result.is_error) { r.card.answer = String(result.result || "").slice(0, 8000); return end(r, "done"); }
    r.card.error = short(result ? (result.subtype === "success" ? result.result : result.errors.join("; ")) || result.subtype : "Claude Code exited without a result", 400);
    return end(r, r.abort.signal.aborted ? "stopped" : "failed");
  } catch (e: any) {
    r.card.error = short(e?.message || e, 400);
    return end(r, r.abort.signal.aborted ? "stopped" : "failed");
  } finally { clearTimeout(kill); }
}

// The member's computer limits; only /bot/work and the login are mounted, never the browser profile or another member's files.
function inContainer(b: Bot, net: string, name: string) {
  return (o: SpawnOptions) => spawn("docker", ["run", "--rm", "-i", "--name", name, "--label", "pitcrew=computer",
    "--cpus", "1.5", "--memory", "2g", "--pids-limit", "768", "--read-only", "--tmpfs", "/tmp:size=768m,mode=1777",
    "--tmpfs", `/home/crew:size=128m,uid=${CREW_UID},gid=${CREW_UID},mode=700`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", net, "-v", `${botDir(b.id)}/work:/bot/work`, "-v", `${claudeDir()}:/claude`, "-w", "/bot/work",
    "-e", "CLAUDE_CONFIG_DIR=/claude", "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "-e", "DISABLE_AUTOUPDATER=1", "-e", `TZ=${TZ}`,
    // Every member's workspace is /bot/work: without these, all members would share one projects/ folder and its auto memory.
    "-e", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", "-e", `CLAUDE_CODE_PROJECT_DIR_NAME=${b.id}`,
    // The SDK's own CLAUDE_* markers; nothing else from the control plane's environment goes in.
    ...Object.entries(o.env).filter(([k, v]) => /^CLAUDE_/.test(k) && !["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_PROJECT_DIR_NAME"].includes(k) && v != null).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...gitIdentity(b), "--entrypoint", "claude", IMAGE, ...o.args], { stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
}

// Claude's commands and tools pass the member's own gate (rules, jev, autonomy, pit stops); file edits in /bot/work don't ask.
function canUse(c: Brain, r: Run): CanUseTool {
  return async (name, input) => {
    if (name === "AskUserQuestion") return ask(r, input);
    const bash = name === "Bash", cmd = String(input.command || "");
    const ok = await gate(c, r.threadId, bash ? { kind: "shell", command: cmd, cwd: "/bot/work" } : { kind: "mcp", server: "claude_code", tool: name, arguments: input },
      bash ? { kind: "command", title: `Claude Code: ${short(cmd, 170)}`, detail: { command: cmd, cwd: "/bot/work", via: "claude_code" } }
        : { kind: "mcp", title: `Claude Code: ${name} ${short(input, 140)}`, detail: { server: "claude_code", tool: name, args: input } });
    return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `Pitcrew's safety check or ${driverName()} didn't allow this. Don't try it another way; finish what you can and say what's left.` };
  };
}

async function ask(r: Run, input: Record<string, any>): Promise<PermissionResult> {
  const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 4), id = uid("ps");
  r.card.status = "asking"; r.card.questions++; flush(r, true);
  r.pits.add(id);
  const decision = await pitStop({ id, botId: r.botId, threadId: r.threadId, kind: "question", effect: "ask", title: `Claude Code asks: ${short(questions[0]?.question, 200)}`, detail: { questions } });
  r.pits.delete(id);
  if (!r.abort.signal.aborted) { r.card.status = "working"; flush(r, true); }
  const answers = json(one<{ detail: string }>("SELECT detail FROM pitstops WHERE id=?", id)?.detail, {}).answers;
  if (decision === "approved" && answers && Object.keys(answers).length) return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
  return { behavior: "deny", message: `${driverName()} ${decision === "expired" ? "didn't answer within 30 minutes" : "chose not to answer"}. Pick the most reasonable option yourself and say which in your summary.` };
}

/** One grey sentence per notable step; reads only count. */
function stepOf(r: Run, name: string, i: Record<string, any>) {
  const rel = (p: unknown) => String(p || "").replace(/^\/bot\/work\//, "");
  switch (name) {
    case "Read": r.card.read++; return null;
    case "Edit": case "Write": case "NotebookEdit": { const p = rel(i.file_path || i.notebook_path); if (!r.card.edited.includes(p)) r.card.edited = [...r.card.edited, p].slice(-50); return `Edited ${p}`; }
    case "Bash": r.card.commands++; return `Ran ${short(i.description || i.command, 90)}`;
    case "Grep": case "Glob": return `Searched for ${short(i.pattern, 60)}`;
    case "WebFetch": return `Read ${hostOf(String(i.url || "")) || "a web page"}`;
    case "WebSearch": return `Searched the web for ${short(i.query, 60)}`;
  }
  return null;
}

// The card is one "claude" event per update; progress is throttled so a long run doesn't write a row per tool call.
function flush(r: Run, now_ = false) {
  if (r.timer) return;
  const wait = now_ ? 0 : Math.max(0, r.flushed + FLUSH_MS - now());
  const write = () => { r.timer = null; r.flushed = now(); addEvent(r.threadId, null, "claude", { ...r.card }); };
  if (!wait) write(); else r.timer = setTimeout(write, wait);
}

function end(r: Run, status: ClaudeCard["status"]) {
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  r.card.status = status; r.card.endedAt = now();
  flush(r, true);
  runs.delete(r.card.id);
  audit(r.botId, `claude.${status}`, { id: r.card.id, edited: r.card.edited.length, commands: r.card.commands });
}

function outcome(r: Run) {
  const k = r.card, did = `${k.edited.length} file${k.edited.length === 1 ? "" : "s"} edited, ${k.commands} command${k.commands === 1 ? "" : "s"} run`;
  if (k.status === "done") return `Claude Code finished (${did}). Its summary:\n\n${k.answer || "(no summary)"}\n\nCheck its work yourself before you call the task done.`;
  return `Claude Code ${k.status === "stopped" ? "was stopped" : "didn't finish"}${k.error ? `: ${k.error}` : ""} (${did}${k.edited.length ? `: ${k.edited.join(", ")}` : ""}).`;
}
