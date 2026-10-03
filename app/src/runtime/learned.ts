// "Learned this run": the memories a turn saved, shown as one card when the turn ends, each plain new one undoable.
// Rows are per (turn, memory) so the card reads the same after a reload; one indexed read per finished turn.
import { all, one, run, now, audit } from "../db.js";
import { getBot } from "../crew.js";
import { forget } from "../engram.js";
import { memberLinked } from "../engramStore.js";
import { httpErr } from "../auth.js";
import { addEvent } from "./threads.js";

// saved: new, undoable · held: waiting in Engram · known: Engram already had it · replaced: rewrote an older one · undone.
export type LearnedState = "saved" | "held" | "known" | "replaced" | "undone";
export interface LearnedItem { memory_id: string; text: string; state: LearnedState }

export function noteLearned(turnId: string | null | undefined, threadId: string, botId: string, memoryId: string, text: string, state: LearnedState) {
  if (!turnId) return;
  run("INSERT INTO turn_memories(turn_id,memory_id,thread_id,bot_id,text,state,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(turn_id,memory_id) DO UPDATE SET text=excluded.text, state=excluded.state",
    turnId, memoryId, threadId, botId, text.slice(0, 500), state, now());
}
export const learnedFor = (turnId: string) => all<LearnedItem>("SELECT memory_id, text, state FROM turn_memories WHERE turn_id=? ORDER BY at, rowid", turnId);

// Called from finishTurn: one card per turn that saved anything.
export function postLearned(threadId: string, turnId: string, botId: string) {
  const n = one<{ n: number }>("SELECT COUNT(*) n FROM turn_memories WHERE turn_id=?", turnId)!.n;
  if (n) addEvent(threadId, turnId, "learned", { turnId, botId, count: n });
}

// Only a plain new save is undone: forgetting a "known" or "replaced" memory would drop a fact the turn didn't add.
export async function undoLearned(turnId: string, memoryId: string) {
  const r = one<{ bot_id: string; state: string }>("SELECT bot_id, state FROM turn_memories WHERE turn_id=? AND memory_id=?", turnId, memoryId);
  if (!r) throw httpErr(404, "Not learned in this run");
  if (r.state !== "saved") throw httpErr(409, "Only a new memory from this run can be undone here");
  const b = getBot(r.bot_id);
  if (!b) throw httpErr(404, "No such crew member");
  if (memberLinked(b)) await forget(b, memoryId, "driver");
  else run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), memoryId, b.id);
  run("UPDATE turn_memories SET state='undone' WHERE turn_id=? AND memory_id=?", turnId, memoryId);
  audit("driver", "memory.learned.undone", { turnId, id: memoryId, botId: b.id });
  return learnedFor(turnId);
}
