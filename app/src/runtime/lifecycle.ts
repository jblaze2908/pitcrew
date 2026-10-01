// Kill switch, resume, and settling what a previous process left in flight.
import { all, run, now, json, audit, setSetting } from "../db.js";
import { allComputers, allBrains } from "../computer.js";
import { startShotSweeper } from "../shots.js";
import { bus } from "./bus.js";
import { active } from "./state.js";
import { getThread, UNTITLED, titleFrom, isSmallTalk } from "./threads.js";
import { interrupt } from "./turns.js";
import { decide } from "./pitstops.js";
import { tickSchedules } from "./schedules.js";

export async function killSwitch() {
  setSetting("paused", "1");
  const inFlight = [...active.keys()].map((t) => ({ threadId: t, title: getThread(t)?.title }));
  // Hires and Engram proposals hold no running work; the kill switch leaves them for the driver.
  for (const ps of all<{ id: string }>("SELECT id FROM pitstops WHERE status='pending' AND kind NOT IN ('hire','engram')")) await decide(ps.id, "deny", { note: "Kill switch" });
  await Promise.all([...active.keys()].map((t) => interrupt(t)));
  await Promise.all([...allComputers().map((c) => c.stop()), ...allBrains().map((x) => x.stop())]);
  audit("driver", "killswitch", { inFlight });
  bus.emit("paused", { paused: true });
  return { inFlight };
}
export function resumeCrew() { setSetting("paused", "0"); audit("driver", "crew.resumed"); bus.emit("paused", { paused: false }); }

export function bootRuntime() {
  // Pit stops from a previous process can't be answered: their Codex requests died with the computers.
  for (const ps of all<{ id: string }>("SELECT id,thread_id FROM pitstops WHERE status='pending' AND kind NOT IN ('hire','engram')")) run("UPDATE pitstops SET status='expired', note='Control plane restarted', decided_at=? WHERE id=?", now(), ps.id);
  run("UPDATE turns SET status='failed', error='Control plane restarted', ended_at=? WHERE status IN ('starting','running')", now());
  run("UPDATE threads SET status='idle' WHERE status!='idle'"); // also clears pre-v1.2 'done'/'failed' thread states
  // Name threads left untitled (from before naming existed, or still on small talk) from their first real message.
  for (const t of all<{ id: string }>("SELECT id FROM threads WHERE title=?", UNTITLED)) {
    const first = all<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id LIMIT 20", t.id).map((e) => json(e.data, {})).find((d) => !isSmallTalk(d.text) || d.attachments?.length);
    if (first) { const title = titleFrom(first.text, first.attachments || []); if (title !== UNTITLED) run("UPDATE threads SET title=? WHERE id=?", title, t.id); }
  }
  setInterval(tickSchedules, 30000).unref();
  startShotSweeper();
}
