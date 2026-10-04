// Thread titles from the conversation, not the first message cut at 60 chars. After a thread's first completed run, one
// cheap model call names the task in 2-6 words from the driver's first message and the first reply. A title the driver
// set by hand (threads.title_auto = 0) is never replaced. Per thread: one call, ~1k tokens in (estimate); a failure
// keeps the placeholder from titleFrom.
import { one, run, json } from "../db.js";
import { getSecret } from "../auth.js";
import { bus } from "./bus.js";
import { getThread } from "./threads.js";

const MODEL = process.env.PITCREW_TITLE_MODEL || "deepseek/deepseek-v4.1-flash";
const PROMPT = `Title this conversation for a list of threads. 2 to 6 words, sentence case, no quotes, no trailing period.
Name the task or topic, not the request ("Blinkit order backfill", "Goa trip in December", "Crew feedback on the harness"). Reply with the title only.`;

// A model reply as a title, or null when it isn't one.
export function cleanTitle(s: unknown) {
  const t = String(s || "").split("\n")[0].replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, "").replace(/^title:\s*/i, "").replace(/\s+/g, " ").trim();
  const words = t.split(" ").length;
  return t && words <= 8 && t.length <= 70 ? t : null;
}

export async function nameFromConversation(threadId: string, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  const t = getThread(threadId);
  if (!t || !t.title_auto) return null;
  const said = one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id LIMIT 1", threadId);
  const reply = one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='agent' ORDER BY id LIMIT 1", threadId);
  const ask = String(json<{ text?: string }>(said?.data, {}).text || "").slice(0, 1500), answer = String(json<{ text?: string }>(reply?.data, {}).text || "").slice(0, 1500);
  if (!ask.trim()) return null;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${getSecret("openrouter") || "missing"}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 24, messages: [{ role: "system", content: PROMPT }, { role: "user", content: `Driver: ${ask}\n\nAgent: ${answer}` }] }) });
    const title = cleanTitle(((await res.json()) as any)?.choices?.[0]?.message?.content);
    if (!title) return null;
    // Re-checked in the UPDATE: the driver may have renamed it while the call ran.
    const r = run("UPDATE threads SET title=? WHERE id=? AND title_auto=1", title, threadId);
    if (Number(r.changes)) bus.emit("thread", { id: threadId, botId: t.bot_id, status: t.status, title });
    return title;
  } catch { return null; } finally { clearTimeout(timer); }
}
