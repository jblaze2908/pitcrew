// "Since you last looked" on Home: runs that ended while the driver wasn't looking. A run is unread until the driver
// opens its thread after it ended (threads.seen_at, set by GET /api/threads/:id and by an open thread when its run ends).
// A delegated run also counts as seen once the asking thread was opened, since its answer lands there too. QUIET
// schedule runs are listed but never unread: nothing happened worth a look.
import { all, run, now, json, marks } from "../db.js";
import type { Inbox, InboxItem } from "../../shared/types.js";
import { unmark } from "./util.js";

export const INBOX_DAYS = 7, INBOX_SCAN = 80, READ_KEEP = 8;
type Row = { turn_id: string; thread_id: string; bot_id: string; status: string; trigger: string; error: string | null; ended_at: number; title: string; origin: string | null;
  seen_at: number | null; run_status: string | null; summary: string | null; note: string | null; prompt: string | null; reply: string | null };

/** The driver has seen this thread as of `at`; never moves the marker back. */
export const markSeen = (threadId: string, at = now()) => run("UPDATE threads SET seen_at=? WHERE id=? AND (seen_at IS NULL OR seen_at<?)", at, threadId, at).changes > 0;
/** Mark all read: every thread seen now. One UPDATE over the threads table (hundreds of rows). */
export const markAllSeen = (at = now()) => Number(run("UPDATE threads SET seen_at=? WHERE seen_at IS NULL OR seen_at<?", at, at).changes);

const firstLine = (s: unknown) => unmark(s).split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 240) || "";

/** Unread runs (all of them, up to INBOX_SCAN) plus the READ_KEEP newest read ones, newest first. Retros are Pitcrew's
 *  housekeeping and interrupted runs were stopped by the driver, so neither is listed. Per call (each Home render and
 *  /api/state): one range read on turns(ended_at) of at most INBOX_SCAN rows with PK joins and the run's last agent line
 *  (events_thread), then one IN read for delegations' asking threads and one for pending pit stops. */
export function inbox(at = now()): Inbox {
  const rows = all<Row>(`SELECT t.id turn_id, t.thread_id, t.bot_id, t.status, t.trigger, t.error, t.ended_at, th.title, th.origin, th.seen_at,
      sr.status run_status, sr.summary, sr.note, s.prompt,
      (SELECT data FROM events e WHERE e.thread_id=t.thread_id AND e.turn_id=t.id AND e.kind='agent' ORDER BY e.id DESC LIMIT 1) reply
    FROM turns t JOIN threads th ON th.id=t.thread_id LEFT JOIN schedule_runs sr ON sr.turn_id=t.id LEFT JOIN schedules s ON s.id=sr.schedule_id
    WHERE t.ended_at>=? AND t.status IN ('completed','failed') AND t.trigger!='retro' AND th.archived=0 ORDER BY t.ended_at DESC LIMIT ?`, at - INBOX_DAYS * 86400000, INBOX_SCAN);
  const origins = new Map(rows.map((r) => [r.turn_id, json<{ kind?: string; fromBot?: string; fromThread?: string }>(r.origin, {})]));
  const asking = [...new Set([...origins.values()].filter((o) => o.kind === "delegated" && o.fromThread).map((o) => o.fromThread!))];
  const askSeen = new Map(asking.length ? all<{ id: string; seen_at: number | null }>(`SELECT id, seen_at FROM threads WHERE id IN (${marks(asking)})`, ...asking).map((r) => [r.id, r.seen_at]) : []);
  const waiting = new Set(all<{ thread_id: string }>("SELECT DISTINCT thread_id FROM pitstops WHERE status='pending' AND thread_id IS NOT NULL").map((r) => r.thread_id));
  // "Waiting on you" is the thread's state now, so only its newest run carries it.
  const items: InboxItem[] = [], flagged = new Set<string>(); let read = 0;
  for (const r of rows) {
    const o = origins.get(r.turn_id)!, delegated = o.kind === "delegated";
    const kind: InboxItem["kind"] = r.run_status ? "scheduled" : delegated ? "delegation" : "run";
    const status = (r.run_status === "quiet" || r.run_status === "reported" ? r.run_status : r.status === "failed" ? "failed" : "completed") as InboxItem["status"];
    const seen = Math.max(r.seen_at ?? 0, (delegated && o.fromThread && askSeen.get(o.fromThread)) || 0);
    const unread = status !== "quiet" && seen < r.ended_at;
    if (!unread && read++ >= READ_KEEP) continue;
    const reply = firstLine(json<{ text?: string }>(r.reply, {}).text);
    const text = status === "failed" ? firstLine(r.error || r.note) || reply || "The run failed" : (kind === "scheduled" && r.summary) || reply || "Finished without a reply";
    items.push({ turnId: r.turn_id, threadId: r.thread_id, botId: r.bot_id, kind, status, sub: kind === "scheduled" ? firstLine(r.prompt).slice(0, 60) : delegated ? "" : r.title,
      fromBot: delegated ? o.fromBot ?? null : null, text, endedAt: r.ended_at, unread, waiting: waiting.has(r.thread_id) && !flagged.has(r.thread_id) });
    flagged.add(r.thread_id);
  }
  return { items, unread: items.filter((i) => i.unread).length };
}
