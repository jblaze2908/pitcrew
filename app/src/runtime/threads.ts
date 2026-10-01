// Threads: their transcript events and live status, naming, finding past ones, and uploads into them.
import { writeFileSync, chownSync } from "node:fs";
import { one, all, run, now, json } from "../db.js";
import { botDir, ensureDirs } from "../computer.js";
import { bus } from "./bus.js";
import type { ThreadRow } from "../models.js";
import type { ThreadStatus, EventKind } from "../../shared/types.js";

export const getThread = (id: string | null | undefined) => one<ThreadRow>("SELECT * FROM threads WHERE id=?", id);

// `live` rides on the SSE payload only (the pit stop or surface row), so an open thread draws it without a refetch.
export function addEvent(threadId: string, turnId: string | null | undefined, kind: EventKind, data: object, live: object | null = null) {
  const r = run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", threadId, turnId ?? null, kind, JSON.stringify(data), now());
  run("UPDATE threads SET updated_at=? WHERE id=?", now(), threadId);
  bus.emit("event", { id: Number(r.lastInsertRowid), threadId, turnId, kind, data, ts: now(), ...live });
}
// A thread's status is only its live state (idle | running | needs). How a run ended belongs to the turn.
export function setThreadStatus(threadId: string, status: ThreadStatus) {
  run("UPDATE threads SET status=?, updated_at=? WHERE id=?", status, now(), threadId);
  const t = getThread(threadId);
  bus.emit("thread", { id: threadId, botId: t?.bot_id, status });
}
export function addSystemForBot(botId: string, text: string) {
  const t = one<{ id: string }>("SELECT id FROM threads WHERE bot_id=? ORDER BY updated_at DESC LIMIT 1", botId);
  if (t) addEvent(t.id, null, "system", { text, tone: "bad" });
}

// Names an untitled thread from its first message, locally: no extra model call, and the text goes nowhere new.
export const UNTITLED = "New thread";
export function titleFrom(text: unknown, attachments: string[] = []) {
  let s = String(text || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!s) return attachments.length ? `Shared ${attachments[0].split("/").pop()!.replace(/^[a-z0-9]+-/, "")}`.slice(0, 60) : UNTITLED;
  const sentence = /^(.{12,}?[.?!])(\s|$)/.exec(s)?.[1];
  if (sentence && sentence.length <= 60) s = sentence;
  if (s.length > 60) s = `${s.slice(0, 58).replace(/\s+\S*$/, "")}…`;
  return s[0].toUpperCase() + s.slice(1);
}
// A greeting says nothing about what the thread is for, so the thread waits for its first real message.
const SMALL_TALK = /^(hi+|hey+|hello+|yo|sup|hola|namaste|good (morning|afternoon|evening|night)|thanks?( you)?|ty|ok(ay)?|cool|test(ing)?|ping|are you there|you there)[\s!.?,]*$/i;
export const isSmallTalk = (text: unknown) => SMALL_TALK.test(String(text || "").trim());
export function nameThread(t: ThreadRow, text: string, attachments: string[]) {
  if (t.title !== UNTITLED || (isSmallTalk(text) && !attachments.length)) return;
  const title = titleFrom(text, attachments);
  if (title === UNTITLED) return;
  run("UPDATE threads SET title=? WHERE id=?", title, t.id);
  bus.emit("thread", { id: t.id, botId: t.bot_id, status: t.status, title });
}

// ---------- finding past threads ----------
// Ranks a crew member's own threads by how many query terms appear in the title (weighted) and the transcript.
// One indexed scan of that member's user/agent events per call; calls are rare (a tool call or a search box).
const HOST = process.env.PITCREW_HOST || "pitcrew.example.com";
type Found = Pick<ThreadRow, "id" | "title" | "archived" | "created_at" | "updated_at"> & { score: number; snippet: string; matched?: number; of?: number };
export function findThreads(botId: string, query: unknown, { exclude = null, limit = 8 }: { exclude?: string | null; limit?: number } = {}): Found[] {
  const terms = [...new Set(String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))].slice(0, 8);
  const threads = all<Found>("SELECT id,title,archived,created_at,updated_at FROM threads WHERE bot_id=? AND id IS NOT ? ORDER BY updated_at DESC", botId, exclude);
  if (!terms.length) return threads.slice(0, limit).map((t) => ({ ...t, score: 0, snippet: "" }));
  const byId = new Map(threads.map((t) => [t.id, { ...t, hits: new Set<string>(), score: 0, snippet: "" }]));
  const like = terms.map(() => "lower(data) LIKE ?").join(" OR ");
  for (const e of all<{ thread_id: string; data: string }>(`SELECT thread_id, data FROM events WHERE kind IN ('user','agent') AND thread_id IN (SELECT id FROM threads WHERE bot_id=?) AND (${like})`, botId, ...terms.map((t) => `%${t}%`))) {
    const t = byId.get(e.thread_id); if (!t) continue;
    const text = String(json(e.data, {}).text || ""), low = text.toLowerCase();
    for (const term of terms) if (low.includes(term)) {
      t.hits.add(term); t.score += 1;
      if (!t.snippet) { const i = low.indexOf(term); t.snippet = `${i > 60 ? "…" : ""}${text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, " ").trim()}…`; }
    }
  }
  for (const t of byId.values()) for (const term of terms) if (t.title.toLowerCase().includes(term)) { t.hits.add(term); t.score += 5; }
  return [...byId.values()].filter((t) => t.hits.size).sort((a, b) => b.hits.size - a.hits.size || b.score - a.score || b.updated_at - a.updated_at)
    .slice(0, limit).map(({ hits, ...t }) => ({ ...t, matched: hits.size, of: terms.length }));
}
export const threadLink = (id: string) => `https://${HOST}/#/t/${id}`;

export function saveUpload(threadId: string, name: string, buf: Buffer) {
  const t = getThread(threadId)!;
  const safe = String(name).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
  const rel = `uploads/${Date.now().toString(36)}-${safe}`;
  ensureDirs(t.bot_id);
  writeFileSync(`${botDir(t.bot_id)}/work/${rel}`, buf);
  chownSync(`${botDir(t.bot_id)}/work/${rel}`, 1500, 1500);
  return rel;
}
