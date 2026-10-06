// Self-improvement. After a run, Pitcrew measures it (no model): tokens, time, tool mix, failures, pit stops, blocks,
// rate limits, against the thread's earlier runs. A run that stands out (or a scheduled thread's weekly check) gets a
// retro: a quiet turn where the member fixes its own skill or memory and files harness ideas with suggest_improvement.
// Per finished run: a few indexed reads; a retro is one model turn, only when triggered.
import { one, all, run, now, uid, json, audit } from "../db.js";

export interface RunReport {
  turnId: string; status: string; secs: number; input: number; cached: number; output: number;
  tools: Record<string, number>; failed: number; declined: number; repeated: string[]; pitstops: number; blocks: number; limits: number;
  baseline: { runs: number; input: number | null; secs: number | null };
}
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const toolKey = (d: Record<string, any>) => (d.type === "browser" || d.type === "computer" || d.type === "mcpToolCall" ? String(d.tool || d.type) : String(d.type));

export function runReport(turnId: string): RunReport | null {
  const t = one<{ id: string; thread_id: string; status: string; started_at: number; ended_at: number | null; input_tokens: number; cached_tokens: number; output_tokens: number }>("SELECT * FROM turns WHERE id=?", turnId);
  if (!t) return null;
  const tools: Record<string, number> = {}; let failed = 0, declined = 0, blocks = 0, limits = 0;
  for (const e of all<{ kind: string; data: string }>("SELECT kind, data FROM events WHERE turn_id=? AND kind IN ('tool','system','error')", turnId)) {
    const d = json<Record<string, any>>(e.data, {});
    if (e.kind === "tool") {
      if (d.type === "script" || d.type === "scriptResult") continue;
      const k = toolKey(d); tools[k] = (tools[k] || 0) + 1;
      if (d.status === "failed") failed++; if (d.status === "declined") declined++;
      if (/\b(429|403)\b|rate.?limit/i.test(String(d.output || d.error || "").slice(0, 2000))) limits++;
    } else if (/^Blocked by jev/.test(String(d.text || ""))) blocks++;
  }
  const prev = all<{ input_tokens: number; started_at: number; ended_at: number }>("SELECT input_tokens, started_at, ended_at FROM turns WHERE thread_id=? AND id<>? AND status='completed' AND trigger<>'retro' AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 10", t.thread_id, turnId);
  const pitstops = one<{ n: number }>("SELECT COUNT(*) n FROM pitstops WHERE turn_id=?", turnId)!.n;
  return { turnId, status: t.status, secs: Math.round(((t.ended_at ?? now()) - t.started_at) / 1000), input: t.input_tokens, cached: t.cached_tokens, output: t.output_tokens,
    tools, failed, declined, repeated: Object.entries(tools).filter(([, n]) => n >= 20).map(([k, n]) => `${k} ×${n}`), pitstops, blocks, limits,
    baseline: { runs: prev.length, input: median(prev.map((p) => p.input_tokens)), secs: median(prev.map((p) => Math.round((p.ended_at - p.started_at) / 1000))) } };
}

// Why this run deserves a retro, or null. Thresholds: a failure, 2× the thread's median input over at least 3 earlier
// runs, more than 3 pit stops, any jev block, 3+ failed tool calls, rate limits, or a tool repeated 20+ times.
export function retroReason(r: RunReport) {
  if (r.status === "failed") return "the run failed";
  if (r.baseline.runs >= 3 && r.baseline.input && r.input > 2 * r.baseline.input) return `it used ${(r.input / r.baseline.input).toFixed(1)}× the usual input tokens`;
  if (r.pitstops > 3) return `${r.pitstops} pit stops`;
  if (r.blocks) return `${r.blocks} blocked action${r.blocks === 1 ? "" : "s"}`;
  if (r.failed >= 3) return `${r.failed} failed tool calls`;
  if (r.limits) return `${r.limits} rate-limited responses`;
  if (r.repeated.length) return `repeated calls (${r.repeated.join(", ")})`;
  return null;
}
// A scheduled thread gets one retro a week even when nothing stood out, so slow drift gets looked at.
// A scheduled run has a thread of its own, so its weekly check counts retros across every run of that schedule.
export function weeklyDue(threadId: string) {
  const sched = one<{ s: string | null }>("SELECT json_extract(origin,'$.scheduleId') s FROM threads WHERE id=? AND json_extract(origin,'$.kind')='schedule'", threadId)?.s;
  return sched
    ? !one("SELECT 1 FROM turns t JOIN threads th ON th.id=t.thread_id WHERE json_extract(th.origin,'$.scheduleId')=? AND t.trigger='retro' AND t.started_at>?", sched, now() - 7 * 86400000)
    : !one("SELECT 1 FROM turns WHERE thread_id=? AND trigger='retro' AND started_at>?", threadId, now() - 7 * 86400000);
}

export function reportText(r: RunReport) {
  const k = (n: number) => `${(n / 1000).toFixed(0)}k`;
  const tools = Object.entries(r.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `${t} ${n}`).join(", ") || "none";
  return [`Run ${r.turnId}: ${r.status}, ${r.secs}s, ${k(r.input)} input tokens (${r.input ? Math.round((r.cached / r.input) * 100) : 0}% cached), ${k(r.output)} output.`,
    r.baseline.runs ? `Usual for this thread (median of ${r.baseline.runs}): ${r.baseline.input != null ? k(r.baseline.input) : "?"} input, ${r.baseline.secs ?? "?"}s.` : "No earlier runs to compare.",
    `Tool calls: ${tools}.`, `Failed ${r.failed}, declined ${r.declined}, blocked ${r.blocks}, pit stops ${r.pitstops}, rate-limited ${r.limits}.`,
    r.repeated.length ? `Repeated: ${r.repeated.join(", ")}.` : ""].filter(Boolean).join("\n");
}
// A retro runs on a Codex fork (turns.ts startTurn), so none of it rides in the thread's later turns; the fork may miss
// the prompt cache once (estimate: check cached_tokens / input_tokens on a trigger='retro' turn).
/** What a retro changed, for its summary line: skill folders and other files from the turn's changes, memory rewritten
 * or forgotten and suggestions filed since it started (two indexed counts; another thread's edits in that window count too). */
export function retroOutcome(botId: string, since: number, changes: { path: string }[], reply: string, status: string) {
  const skills = [...new Set(changes.map((c) => /^skills\/([^/]+)\//.exec(c.path)?.[1]).filter(Boolean))];
  const files = changes.filter((c) => !c.path.startsWith("skills/")).length;
  const mem = one<{ n: number }>("SELECT COUNT(*) n FROM memory WHERE bot_id=? AND (updated_at>=? OR forgotten_at>=?)", botId, since, since)!.n;
  const ideas = one<{ n: number }>("SELECT COUNT(*) n FROM improvements WHERE bot_id=? AND updated_at>=?", botId, since)!.n;
  const s = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [skills.length ? `skill ${skills.slice(0, 3).join(", ")}${skills.length > 3 ? ` and ${skills.length - 3} more` : ""} updated` : "",
    files ? `${s(files, "file")} changed` : "", mem ? `${s(mem, "memory")} rewritten`.replace("memorys", "memories") : "", ideas ? `${s(ideas, "suggestion")} filed` : ""].filter(Boolean);
  if (parts.length) return `${parts.join(", ")}${status === "completed" ? "" : ` (${status === "interrupted" ? "then stopped" : "then failed"})`}`;
  if (status === "interrupted") return "stopped before changing anything";
  if (status !== "completed") return "failed before changing anything";
  return /^\s*QUIET\b/.test(reply) ? `nothing to change${reply.replace(/^\s*QUIET:?\s*/, "").trim() ? `: ${reply.replace(/^\s*QUIET:?\s*/, "").trim().replace(/\s+/g, " ").slice(0, 140)}` : ""}` : "nothing changed";
}
export const retroPrompt = (r: RunReport, why: string) => `[Retro] Your last run stood out (${why}). How it went, measured by Pitcrew:\n${reportText(r)}\n\nImprove how you work, without redoing the task: fix the skill this task uses (commit with the evidence), rewrite agent memory if it was wrong, and for anything only Pitcrew can fix (a missing tool, a rule that got in the way) call suggest_improvement with the evidence. If nothing needs changing, reply "QUIET: <why not>".`;

// ---------- suggestions ----------
// Harness ideas from members, deduplicated by title; each repeat adds a vote and its evidence.
export function suggest(botId: string, threadId: string | null, s: { area: string; title: string; evidence: string; proposal: string }) {
  const key = s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
  const same = one<{ id: string; evidence: string }>("SELECT id, evidence FROM improvements WHERE norm=? AND status='open'", key);
  if (same) { run("UPDATE improvements SET votes=votes+1, evidence=?, updated_at=? WHERE id=?", `${same.evidence}\n— ${s.evidence}`.slice(-4000), now(), same.id); return { id: same.id, repeat: true }; }
  const id = uid("im");
  run("INSERT INTO improvements(id,bot_id,thread_id,area,title,norm,evidence,proposal,status,votes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'open',1,?,?)", id, botId, threadId, s.area, s.title.slice(0, 200), key, s.evidence.slice(0, 2000), s.proposal.slice(0, 2000), now(), now());
  audit(botId, "improvement.suggested", { id, title: s.title.slice(0, 120) });
  return { id, repeat: false };
}
