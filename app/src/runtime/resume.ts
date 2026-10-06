// Picking a thread back up when a provider's usage limit resets. A run that failed on "usage limit … try again at 4:54
// AM" (Codex renders that in the brain's clock, Asia/Kolkata) arms a resume; the schedule tick (30 s) sends it when due.
// Stored in settings, so a restart keeps it. At most RESUME_TRIES in a row, so a limit that won't lift can't loop.
import { all, run, now, getSetting, setSetting } from "../db.js";
import { getThread, addEvent } from "./threads.js";
import { istClock, istDayAt } from "./util.js";

const KEY = "resume_at:", RESUME_TRIES = 3, GRACE_MS = 90000;
export const isUsageLimit = (error: string | null | undefined) => /usage limit|rate limit reached|quota exceeded/i.test(error || "");

// When to try again, as epoch ms, or null. "try again at 4:54 AM" is the next 4:54 IST after `at`; "in 2 hours" is
// relative. A grace period lets the provider's window actually close.
export function retryAt(error: string, at = now()): number | null {
  const clock = /try again at (\d{1,2}):(\d{2})\s*([AP]M)/i.exec(error);
  if (clock) {
    let h = Number(clock[1]) % 12; if (/pm/i.test(clock[3])) h += 12;
    let t = istDayAt(at, h, Number(clock[2]));
    if (t <= at) t += 86400000;
    return t + GRACE_MS;
  }
  const rel = /try again in (\d+)\s*(second|minute|hour|day)s?/i.exec(error);
  if (rel) return at + Number(rel[1]) * { second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[rel[2].toLowerCase() as "second"] + GRACE_MS;
  return null;
}

// Arms (or re-arms) a thread's resume after a usage-limit failure. Returns the time, or null when it won't retry.
export function armResume(threadId: string, error: string, at = now()) {
  const t = retryAt(error, at);
  const prev = getSetting(`${KEY}${threadId}`), tries = prev ? Number(prev.split("|")[1] || 0) + 1 : 1;
  if (t == null || tries > RESUME_TRIES) { run("DELETE FROM settings WHERE key=?", `${KEY}${threadId}`); return null; }
  setSetting(`${KEY}${threadId}`, `${t}|${tries}`);
  addEvent(threadId, null, "system", { text: `Usage limit reached. ${getThread(threadId)?.title ? "This thread" : "It"} picks up again at ${istClock(t)} IST on its own.` });
  return t;
}
// A run that got going again clears the counter, so a later limit gets its full tries.
export const clearResume = (threadId: string) => run("DELETE FROM settings WHERE key=?", `${KEY}${threadId}`);
// Marks a resume as sent, so the tick doesn't send it again while its run goes; the try count stays for armResume.
export const sentResume = (threadId: string, tries: number) => setSetting(`${KEY}${threadId}`, `sent|${tries}`);

// Due resumes, for the schedule tick: one indexed range read of settings keys.
export function dueResumes(at = now()) {
  return all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key >= ? AND key < ?", KEY, `${KEY}￿`)
    .filter((r) => Number(r.value.split("|")[0]) <= at).map((r) => ({ threadId: r.key.slice(KEY.length), tries: Number(r.value.split("|")[1] || 1) }));
}
