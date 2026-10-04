// Thread titles from the conversation. The provisional title is the first real message (threads.ts); once the
// conversation has a topic, a small model on the ChatGPT plan names it in 2-6 words and the name then stays put.
// threads.title_auto: 0 set by hand, never replaced · 1 provisional, asked after each run until a name sticks ·
// 2 named by the model, left alone ("Name it again" sets 1). Per ask: ~3.9k tokens in on the plan, ~4 s (computer.ts).
import { one, all, run, json, getSetting, setSetting } from "../db.js";
import { openPlanSide, type PlanAsk } from "../computer.js";
import { bus } from "./bus.js";
import { getThread, isSmallTalk } from "./threads.js";
import type { ThreadRow } from "../models.js";

const PROMPT = `You title conversations for a list of threads. Reply with the title only: 2 to 6 words, sentence case, no quotes, no trailing period, in the conversation's language.
Name the concrete task or topic with its specifics (the site, merchant, person, place or file), not the request: "Swiggy order history export", "Goa trip in December", "Dentist near Indiranagar on Saturday".
If the conversation is only greetings or small talk with no task yet, reply NONE.`;
const MAX_RUNS = 6; // a thread still on small talk after this many runs keeps its provisional title

export function cleanTitle(s: unknown) {
  const t = String(s || "").split("\n")[0].replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, "").replace(/^title:\s*/i, "").replace(/\s+/g, " ").trim();
  const words = t.split(" ").length;
  const mixed = /[A-Za-z][\u0400-\u04FF]|[\u0400-\u04FF][A-Za-z]/.test(t); // seen on gpt-6-luna: "уточification"
  return t && !mixed && !/^none$/i.test(t) && words <= 8 && t.length <= 70 ? t : null;
}

/** The opening exchanges with greetings dropped: up to 3 driver messages and the first reply to each, 600 chars apiece. */
export function openingText(threadId: string) {
  const out: string[] = [];
  let asks = 0, skipping = false;
  for (const e of all<{ kind: string; data: string }>("SELECT kind, data FROM events WHERE thread_id=? AND kind IN ('user','agent') ORDER BY id LIMIT 60", threadId)) {
    const text = String(json<{ text?: string }>(e.data, {}).text || "").trim();
    if (!text) continue;
    if (e.kind === "user") {
      if (asks >= 3) break;
      if ((skipping = isSmallTalk(text))) continue;
      asks++; out.push(`Driver: ${text.slice(0, 600)}`);
    } else if (!skipping && out.at(-1)?.startsWith("Driver: ")) out.push(`Agent: ${text.slice(0, 600)}`);
  }
  return out.join("\n\n");
}

export async function nameFromConversation(threadId: string, { ask }: { ask?: PlanAsk } = {}) {
  const t = getThread(threadId);
  if (!t || !t.title_auto || t.pinned) return null; // a pinned thread is named after its member
  const text = openingText(threadId);
  if (!text) return null;
  const side = ask ? null : await openPlanSide().catch(() => null);
  const asker = ask ?? side?.ask;
  if (!asker) return null; // no ChatGPT plan: the provisional title stays
  try {
    const title = cleanTitle(await asker(PROMPT, text));
    if (!title) return null; // NONE: still small talk, asked again after the next run
    const r = run("UPDATE threads SET title=?, title_auto=2 WHERE id=? AND title_auto>0", title, threadId);
    if (Number(r.changes)) bus.emit("thread", { id: threadId, botId: t.bot_id, status: t.status, title });
    return title;
  } catch { return null; } finally { side?.close(); }
}

/** After a completed run: names a provisional thread once the driver's latest message is more than small talk. */
export function nameAfterRun(t: ThreadRow) {
  if (t.title_auto !== 1 || t.pinned || json<{ kind?: string }>(t.origin, {}).kind === "delegated") return;
  if (one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE thread_id=? AND status='completed'", t.id)!.n > MAX_RUNS) return;
  const last = one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id DESC LIMIT 1", t.id);
  if (!last || isSmallTalk(json<{ text?: string }>(last.data, {}).text)) return;
  nameFromConversation(t.id).catch(() => {});
}

/** Once per install: names the threads from before model naming, one after another on a single side server. */
export async function backfillTitles() {
  if (getSetting("titles_backfilled")) return;
  const ids = all<{ id: string; origin: string | null }>("SELECT id, origin FROM threads WHERE title_auto=1 AND pinned=0 AND archived=0 AND EXISTS (SELECT 1 FROM turns WHERE thread_id=threads.id AND status='completed') ORDER BY updated_at DESC LIMIT 200")
    .filter((t) => json<{ kind?: string }>(t.origin, {}).kind !== "delegated");
  const side = ids.length ? await openPlanSide().catch(() => null) : null;
  if (ids.length && !side) return; // tried again on the next boot, once the plan is connected
  try { for (const t of ids) await nameFromConversation(t.id, { ask: side!.ask }); setSetting("titles_backfilled", "1"); } finally { side?.close(); }
}
