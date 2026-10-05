// Schedules: recurring prompts in Asia/Kolkata time, run by a 30 s tick.
import { one, all, run, now, uid, audit, getSetting, pruneLabels, json } from "../db.js";
import type { ScheduleRow, ScheduleRunRow } from "../models.js";
import { getThread, addEvent } from "./threads.js";
import { sendMessage } from "./turns.js";
import { IST } from "./util.js";
import { dueResumes, sentResume } from "./resume.js";

const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export function nextRun(spec: string, from = now()) {
  let m: RegExpExecArray | null;
  if ((m = /^every (\d+) (minute|minutes|hour|hours)$/i.exec(spec))) {
    const ms = +m[1] * (m[2].startsWith("hour") ? 3600000 : 60000);
    if (ms < 15 * 60000) throw new Error("Schedules run at most every 15 minutes");
    return from + ms;
  }
  const at = (d: Date, hh: number, mm: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - IST;
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
export function addSchedule(botId: string, threadId: string | null, spec: string, prompt: string) {
  spec = spec.trim().toLowerCase();
  if (!prompt.trim()) throw new Error("A schedule needs a prompt");
  const next = nextRun(spec);
  const id = uid("sc");
  run("INSERT INTO schedules(id,bot_id,thread_id,spec,prompt,next_run,created_at) VALUES(?,?,?,?,?,?,?)", id, botId, threadId, spec, prompt.trim().slice(0, 2000), next, now());
  audit("crew", "schedule.added", { id, botId, spec });
  return one<ScheduleRow>("SELECT * FROM schedules WHERE id=?", id)!;
}
export const listSchedules = (botId: string) => all<ScheduleRow>("SELECT * FROM schedules WHERE bot_id=? ORDER BY created_at", botId);
// botId scopes a lookup to one member's own schedules; null is the driver, who may touch any.
function own(id: string, botId: string | null) {
  const s = one<ScheduleRow>("SELECT * FROM schedules WHERE id=?", id);
  if (!s || (botId && s.bot_id !== botId)) throw new Error(`No schedule ${id}. list_schedules shows yours.`);
  return s;
}
/** Change the time, prompt or paused state. A new time, or resuming, recomputes the next run so a stale one doesn't fire at once. */
export function updateSchedule(id: string, botId: string | null, ch: { spec?: string; prompt?: string; enabled?: boolean }, who: "crew" | "driver") {
  const s = own(id, botId);
  const spec = ch.spec !== undefined ? ch.spec.trim().toLowerCase() : s.spec, prompt = ch.prompt !== undefined ? ch.prompt.trim().slice(0, 2000) : s.prompt;
  if (!prompt) throw new Error("A schedule needs a prompt");
  const enabled = ch.enabled ?? !!s.enabled, next = spec !== s.spec || (enabled && !s.enabled) ? nextRun(spec) : s.next_run;
  run("UPDATE schedules SET spec=?, prompt=?, enabled=?, next_run=? WHERE id=?", spec, prompt, enabled ? 1 : 0, next, id);
  audit(who, "schedule.updated", { id, botId: s.bot_id, spec, enabled, promptChanged: prompt !== s.prompt });
  return one<ScheduleRow>("SELECT * FROM schedules WHERE id=?", id)!;
}
/** The audit row keeps the spec and prompt, so a deleted schedule can be put back by hand. */
export function deleteSchedule(id: string, botId: string | null, who: "crew" | "driver") {
  const s = own(id, botId);
  run("DELETE FROM schedules WHERE id=?", id);
  audit(who, "schedule.deleted", { id, botId: s.bot_id, spec: s.spec, prompt: s.prompt });
  return s;
}
let nextPrune = 0;
export function tickSchedules() {
  // Rides the schedule tick (30 s) but deletes at most hourly; the ts index keeps it a range scan.
  if (now() >= nextPrune) { nextPrune = now() + 3600000; pruneLabels(); }
  if (getSetting("paused") === "1") return;
  for (const r of dueResumes()) {
    if (!getThread(r.threadId)) continue;
    sentResume(r.threadId, r.tries);
    sendMessage(r.threadId, { text: "[Pitcrew] The usage limit has reset. Continue where you stopped; don't redo work that's already done.", mode: "queue", trigger: "resume" }).catch((e) => addEvent(r.threadId, null, "error", { text: e.message }));
  }
  for (const s of all<ScheduleRow>("SELECT * FROM schedules WHERE enabled=1 AND next_run<=?", now())) {
    run("UPDATE schedules SET last_run=?, next_run=? WHERE id=?", now(), nextRun(s.spec), s.id);
    fire(s, "time", s.next_run);
  }
}

const LATE_MS = 5 * 60000;
const clock = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);
/** Sends a schedule's prompt to its thread and records the run. due: when it should have fired (a late tick after a
 * restart or the kill switch says so in the run's note). */
function fire(s: ScheduleRow, kind: ScheduleRunRow["kind"], due: number) {
  let threadId = s.thread_id && getThread(s.thread_id) ? s.thread_id : one<{ id: string }>("SELECT id FROM threads WHERE bot_id=? AND pinned=1 AND archived=0 LIMIT 1", s.bot_id)?.id;
  if (!threadId) { threadId = uid("th"); run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", threadId, s.bot_id, "Scheduled work", 1, now(), now()); }
  const id = uid("sr"), at = now();
  const note = kind === "time" && at - due > LATE_MS ? `Due ${clock(due)}, fired ${clock(at)}: Pitcrew was stopped or restarting` : null;
  run("INSERT INTO schedule_runs(id,schedule_id,bot_id,thread_id,kind,due_at,fired_at,status,note) VALUES(?,?,?,?,?,?,?,?,?)", id, s.id, s.bot_id, threadId, kind, due, at, "queued", note);
  sendMessage(threadId, { text: `[Scheduled: ${s.spec}] ${s.prompt}`, mode: "queue", trigger: "schedule" }).catch((e) => {
    addEvent(threadId, null, "error", { text: e.message });
    run("UPDATE schedule_runs SET status='failed', ended_at=?, note=? WHERE id=?", now(), String(e.message).slice(0, 300), id);
  });
  return id;
}
/** The driver's "Run now": fires once without moving the next scheduled time. */
export function runScheduleNow(id: string) {
  const s = own(id, null);
  audit("driver", "schedule.run_now", { id, botId: s.bot_id });
  return fire(s, "manual", now());
}

// The run's turn: linked when it starts (queued runs start in order, so the oldest unlinked one is this turn's), closed when it ends.
export function scheduleRunStarted(threadId: string, turnId: string) {
  run("UPDATE schedule_runs SET turn_id=?, started_at=?, status='running' WHERE id=(SELECT id FROM schedule_runs WHERE thread_id=? AND status='queued' ORDER BY fired_at LIMIT 1)", turnId, now(), threadId);
}
export function scheduleRunEnded(turnId: string, status: string, reply: string, tokens: number, cost: number) {
  const st = status === "completed" ? (/^\s*QUIET\b/.test(reply) ? "quiet" : "reported") : status === "interrupted" ? "interrupted" : "failed";
  run("UPDATE schedule_runs SET status=?, ended_at=?, summary=?, input_tokens=?, cost_usd=? WHERE turn_id=?", st, now(), reply.replace(/^\s*QUIET:?\s*/, "").split("\n")[0].slice(0, 200) || null, tokens, cost, turnId);
}
/** Why a queued run hasn't started (kill switch, cap, provider), kept on the run until it does. */
export function scheduleRunWaiting(threadId: string, why: string) {
  run("UPDATE schedule_runs SET note=? WHERE id=(SELECT id FROM schedule_runs WHERE thread_id=? AND status='queued' ORDER BY fired_at LIMIT 1)", `Waiting: ${why}`.slice(0, 300), threadId);
}
/** The run's turn couldn't start (cap, provider, kill switch at start time); the thread shows the same error. */
export function scheduleRunFailedToStart(threadId: string, why: string) {
  run("UPDATE schedule_runs SET status='failed', ended_at=?, note=? WHERE id=(SELECT id FROM schedule_runs WHERE thread_id=? AND status='queued' ORDER BY fired_at LIMIT 1)", now(), String(why).slice(0, 300), threadId);
}
/** The driver removed the queued prompt before it ran. */
export function scheduleRunCancelled(threadId: string) {
  run("UPDATE schedule_runs SET status='cancelled', ended_at=? WHERE id=(SELECT id FROM schedule_runs WHERE thread_id=? AND status='queued' ORDER BY fired_at DESC LIMIT 1)", now(), threadId);
}
/** A restart cut these turns (lifecycle.ts). */
export function scheduleRunsCut(turnIds: string[]) {
  for (const t of turnIds) run("UPDATE schedule_runs SET status='interrupted', ended_at=? WHERE turn_id=? AND ended_at IS NULL", now(), t);
}

export const scheduleRuns = (id: string, limit = 50) => all<ScheduleRunRow>("SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY fired_at DESC LIMIT ?", id, limit);
/** Every schedule with its member, its last 14 runs and 7-day totals, for the Schedules page. One indexed read per schedule. */
export function scheduleOverview() {
  const since = now() - 7 * 86400000;
  return all<ScheduleRow & { bot_name: string }>("SELECT s.*, b.name bot_name FROM schedules s JOIN bots b ON b.id=s.bot_id WHERE b.archived=0 ORDER BY s.enabled DESC, s.next_run").map((s) => {
    const runs = scheduleRuns(s.id, 14), week = runs.filter((r) => r.fired_at >= since && r.ended_at);
    const ok = week.filter((r) => r.status === "quiet" || r.status === "reported").length;
    return { ...s, runs, week: { runs: week.length, ok, tokens: week.reduce((n, r) => n + (r.input_tokens || 0), 0), cost: week.reduce((n, r) => n + (r.cost_usd || 0), 0) } };
  });
}

// A schedule's latest run: when, how it ended, and the first line of its reply (QUIET runs included). Runs from before
// schedule_runs existed are found the old way: the schedule's thread (or the pinned one) near last_run.
export function lastScheduledRun(s: Pick<ScheduleRow, "id" | "bot_id" | "thread_id" | "last_run">) {
  const r = one<ScheduleRunRow>("SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY fired_at DESC LIMIT 1", s.id);
  if (r) return { at: r.started_at || r.fired_at, status: r.status, summary: r.summary || r.note || "", threadId: r.thread_id };
  if (!s.last_run) return null;
  const thread = s.thread_id || one<{ id: string }>("SELECT id FROM threads WHERE bot_id=? AND pinned=1 AND archived=0 LIMIT 1", s.bot_id)?.id;
  const t = thread && one<{ id: string; status: string; started_at: number; error: string | null }>("SELECT id,status,started_at,error FROM turns WHERE thread_id=? AND trigger='schedule' AND started_at>=? ORDER BY started_at DESC LIMIT 1", thread, s.last_run - 120000);
  if (!t) return { at: s.last_run, status: "queued or not started", summary: "" };
  const reply = json<{ text?: string }>(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND turn_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", thread, t.id)?.data, {}).text || t.error || "";
  return { at: t.started_at, status: t.status, summary: reply.split("\n")[0].slice(0, 140), threadId: thread };
}
