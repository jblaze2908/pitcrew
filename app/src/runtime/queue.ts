// Messages waiting for a thread's run to end. Read per message and per turn end, by the queued_thread index.
import { one, all, run, now, uid, json } from "../db.js";
import { bus } from "./bus.js";
import type { QueuedItem } from "../../shared/types.js";

type Row = { id: string; thread_id: string; text: string; attachments: string; trigger: string; display: string | null; created_at: number };
const item = (r: Row): QueuedItem => ({ id: r.id, text: r.text, attachments: json(r.attachments, []), via: r.trigger, display: r.display, created_at: r.created_at });
const ORDER = "ORDER BY created_at, rowid";

export const listQueued = (threadId: string) => all<Row>(`SELECT * FROM queued WHERE thread_id=? ${ORDER}`, threadId).map(item);
export const peekQueued = (threadId: string, id?: string) => {
  const r = id ? one<Row>("SELECT * FROM queued WHERE thread_id=? AND id=?", threadId, id) : one<Row>(`SELECT * FROM queued WHERE thread_id=? ${ORDER} LIMIT 1`, threadId);
  return r ? item(r) : null;
};
export const lastQueued = (threadId: string) => { const r = one<Row>(`SELECT * FROM queued WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, threadId); return r ? item(r) : null; };
export const queuedThreads = () => all<{ thread_id: string }>("SELECT DISTINCT thread_id FROM queued").map((r) => r.thread_id);
export const emitQueue = (threadId: string) => bus.emit("queue", { threadId, queued: listQueued(threadId) });

export function enqueue(threadId: string, m: { text: string; attachments: string[]; trigger: string; display: string | null }, at = now(), id = uid("q")) {
  run("INSERT INTO queued(id,thread_id,text,attachments,trigger,display,created_at) VALUES(?,?,?,?,?,?,?)", id, threadId, m.text, JSON.stringify(m.attachments), m.trigger, m.display, at);
  emitQueue(threadId);
  return id;
}
/** Removes and returns one item (the oldest when no id), or null. */
export function takeQueued(threadId: string, id?: string) {
  const q = peekQueued(threadId, id);
  if (!q) return null;
  run("DELETE FROM queued WHERE id=?", q.id);
  emitQueue(threadId);
  return q;
}
/** Puts a taken item back where it was, so a delivery that failed doesn't lose it. */
export const requeue = (threadId: string, q: QueuedItem) => enqueue(threadId, { text: q.text, attachments: q.attachments, trigger: q.via, display: q.display }, q.created_at, q.id);
export function extendQueued(threadId: string, id: string, text: string) {
  run("UPDATE queued SET text=text||? WHERE id=?", text, id);
  emitQueue(threadId);
}
