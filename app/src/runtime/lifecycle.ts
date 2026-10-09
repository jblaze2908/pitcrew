// Kill switch, resume, and settling what a previous process left in flight.
import { all, run, now, json, audit, setSetting } from "../db.js";
import { allComputers, allBrains } from "../computer.js";
import { startShotSweeper } from "../shots.js";
import { bus } from "./bus.js";
import { active } from "./state.js";
import { getThread, addEvent, UNTITLED, titleFrom, isSmallTalk } from "./threads.js";
import { interrupt, sendMessage, startQueues } from "./turns.js";
import { decide } from "./pitstops.js";
import { tickSchedules, scheduleRunsCut, backfillScheduleTitles } from "./schedules.js";
import { backfillTitles } from "./titles.js";
import { startBalanceWatch } from "./balance.js";
import { stopClaude, settleClaudeCards } from "./claude.js";

export async function killSwitch() {
  setSetting("paused", "1");
  const inFlight = [...active.keys()].map((t) => ({ threadId: t, title: getThread(t)?.title }));
  // Hires, Engram proposals and done-checks hold no running work; the kill switch leaves them for the driver.
  for (const ps of all<{ id: string }>("SELECT id FROM pitstops WHERE status='pending' AND kind NOT IN ('hire','engram','check')")) await decide(ps.id, "deny", { note: "Kill switch" });
  stopClaude();
  await Promise.all([...active.keys()].map((t) => interrupt(t)));
  await Promise.all([...allComputers().map((c) => c.stop()), ...allBrains().map((x) => x.stop())]);
  audit("driver", "killswitch", { inFlight });
  bus.emit("paused", { paused: true });
  return { inFlight };
}
export function resumeCrew() { setSetting("paused", "0"); audit("driver", "crew.resumed"); bus.emit("paused", { paused: false }); startQueues(); }

/** Returns the turns this restart cut off; the caller resumes them once reapOrphans has restarted the brains. */
export function bootRuntime() {
  // Pit stops from a previous process can't be answered: their Codex requests died with the computers. A done-check's
  // decision is applied in decide(), not by a waiting request, and a vault "update it" reminder waits on nothing, so both stay.
  for (const ps of all<{ id: string }>("SELECT id,thread_id FROM pitstops WHERE status='pending' AND kind NOT IN ('hire','engram','check','vault')")) run("UPDATE pitstops SET status='expired', note='Control plane restarted', decided_at=? WHERE id=?", now(), ps.id);
  const cut = settleCutTurns();
  settleClaudeCards();
  run("UPDATE threads SET status='idle' WHERE status!='idle'"); // also clears pre-v1.2 'done'/'failed' thread states
  // Name threads left untitled (from before naming existed, or still on small talk) from their first real message.
  for (const t of all<{ id: string }>("SELECT id FROM threads WHERE title=?", UNTITLED)) {
    const first = all<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id LIMIT 20", t.id).map((e) => json(e.data, {})).find((d) => !isSmallTalk(d.text) || d.attachments?.length);
    if (first) { const title = titleFrom(first.text, first.attachments || []); if (title !== UNTITLED) run("UPDATE threads SET title=? WHERE id=?", title, t.id); }
  }
  setTimeout(() => backfillTitles().catch(() => {}), 60000).unref();
  backfillScheduleTitles();
  startBalanceWatch();
  setInterval(tickSchedules, 30000).unref();
  startShotSweeper();
  return cut;
}

type Cut = { id: string; thread_id: string; trigger: string; started_at: number };
/** A turn still starting or running in the store was cut off by this restart: nothing in memory survives one. */
export function settleCutTurns() {
  const cut = all<Cut>("SELECT id,thread_id,trigger,started_at FROM turns WHERE status IN ('starting','running')");
  for (const t of cut) {
    run("UPDATE turns SET status='interrupted', error='Control plane restarted', ended_at=? WHERE id=?", now(), t.id);
    addEvent(t.thread_id, t.id, "system", { text: "Pitcrew restarted during this run, so it stopped partway.", tone: "bad" });
  }
  scheduleRunsCut(cut.map((t) => t.id));
  return cut;
}

const RESUME = "Pitcrew restarted in the middle of your last run, so it stopped partway. Check where things stand now (the screen, the page, the files) and carry on with the task from there. Don't redo steps that already finished.";
const RESUME_WITHIN = 2 * 3600_000;
// Each cut turn resumes once, on the thread it was on. Not a resume of a resume (a restart loop would replay forever),
// nor a delegated or plan turn (whoever waited for its answer died with the process), nor work older than 2 h. A retro
// isn't resumed or offered: it ran on a fork the thread never saw, and the next run that stands out gets another.
export const resumable = (t: Cut, at = now()) => !["resume", "delegation", "plan", "retro"].includes(t.trigger) && at - t.started_at < RESUME_WITHIN && !!getThread(t.thread_id);
export function resumeCut(cut: Cut[]) {
  for (const t of cut) {
    if (t.trigger === "retro") continue;
    if (!resumable(t)) { addEvent(t.thread_id, null, "system", { text: "Say continue to pick it up." }); continue; }
    sendMessage(t.thread_id, { text: RESUME, trigger: "resume", display: "Pick up where you left off" })
      .catch((e) => addEvent(t.thread_id, null, "error", { text: e.message }));
  }
}
