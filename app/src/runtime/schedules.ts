// Schedules: recurring prompts in Asia/Kolkata time, run by a 30 s tick.
import { one, all, run, now, uid, audit, getSetting, pruneLabels } from "../db.js";
import type { ScheduleRow } from "../models.js";
import { getThread, addEvent } from "./threads.js";
import { sendMessage } from "./turns.js";
import { IST } from "./util.js";

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
  for (const s of all<ScheduleRow>("SELECT * FROM schedules WHERE enabled=1 AND next_run<=?", now())) {
    run("UPDATE schedules SET last_run=?, next_run=? WHERE id=?", now(), nextRun(s.spec), s.id);
    let threadId = s.thread_id && getThread(s.thread_id) ? s.thread_id : one<{ id: string }>("SELECT id FROM threads WHERE bot_id=? AND pinned=1 AND archived=0 LIMIT 1", s.bot_id)?.id;
    if (!threadId) { threadId = uid("th"); run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", threadId, s.bot_id, "Scheduled work", 1, now(), now()); }
    sendMessage(threadId, { text: `[Scheduled: ${s.spec}] ${s.prompt}`, mode: "queue", trigger: "schedule" }).catch((e) => addEvent(threadId, null, "error", { text: e.message }));
  }
}
