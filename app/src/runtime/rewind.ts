// Rewind a run: the member's workspace files and/or its conversation go back to just before a finished run. Driver-only
// (an API route, no crew tool) and audited. Files come back from the shadow copies snapshot.ts keeps per turn; the
// conversation continues on a Codex fork taken before that turn (thread/fork beforeTurnId), and the transcript keeps
// what followed, marked "Rewound". Cost: nothing per turn beyond the snapshots; per rewind, one read per changed path
// and, for the chat, one fork (or a recap when the fork isn't possible).
import { one, all, run, now, json, audit, driverName } from "../db.js";
import { getBot } from "../crew.js";
import { restoreTargets, planRestore, restoreFiles, type Change } from "../snapshot.js";
import type { RewindPlan } from "../../shared/types.js";
import { active } from "./state.js";
import { addEvent, getThread } from "./threads.js";
import { brain } from "./machines.js";
import { recap, forkThread, dropCodex } from "./turns.js";
import { localClock, tzLabel } from "./util.js";
import { httpErr } from "../auth.js";

export type RewindMode = "both" | "chat" | "files";
type TurnLite = { id: string; thread_id: string; bot_id: string; status: string; codex_turn_id: string | null; started_at: number; rewound_at: number | null };
export const REWOUND = "This thread continues an earlier conversation, rewound by the driver to before a run, so it was restarted from that point.";

/** The first event a rewind of this turn takes out: the message that started it, unless that message belongs to an earlier
 * run (then the turn's own first event). Two indexed reads and a guard query. */
export function boundaryOf(t: TurnLite) {
  const u = one<{ id: number | null }>("SELECT MAX(id) id FROM events WHERE thread_id=? AND kind='user' AND ts<=?", t.thread_id, t.started_at)?.id ?? null;
  const f = one<{ id: number | null }>("SELECT MIN(id) id FROM events WHERE thread_id=? AND turn_id=?", t.thread_id, t.id)?.id ?? null;
  if (u == null) return f;
  const stray = one("SELECT 1 FROM events WHERE thread_id=? AND id>? AND id<? AND turn_id IN (SELECT id FROM turns WHERE thread_id=? AND started_at<?) LIMIT 1", t.thread_id, u, f ?? Number.MAX_SAFE_INTEGER, t.thread_id, t.started_at);
  return stray ? f : u;
}
// A member's workspace is shared by all its threads: nothing may run on it while files go back.
const memberBusy = (botId: string) => [...active.keys()].some((th) => getThread(th)?.bot_id === botId);

/** What rewinding this run would change, for the confirm sheet. Files: every path this run or a later run of the same
 * member touched (any thread), back to how it was when this run started. */
export function rewindPlan(turnId: string, mode: RewindMode): RewindPlan & { boundary: number | null } {
  const t = one<TurnLite>("SELECT id, thread_id, bot_id, status, codex_turn_id, started_at, rewound_at FROM turns WHERE id=?", turnId);
  if (!t) throw httpErr(404, "No such run");
  if (active.has(t.thread_id) || t.status === "running" || t.status === "starting") throw httpErr(409, "Wait for the run to finish");
  const later = mode === "chat" ? [] : all<{ thread_id: string; changes: string }>("SELECT thread_id, changes FROM turns WHERE bot_id=? AND started_at>=? AND changes IS NOT NULL ORDER BY started_at", t.bot_id, t.started_at).map((r) => ({ thread: r.thread_id, list: json<Change[]>(r.changes, []) }));
  const files = mode === "chat" ? [] : planRestore(t.bot_id, restoreTargets(later.map((r) => r.list))).map(({ path, kind, ok, why }) => ({ path, kind, ok, ...(why ? { why } : {}) }));
  const boundary = boundaryOf(t);
  const span = boundary == null ? [] : all<{ kind: string; data: string }>("SELECT kind, data FROM events WHERE thread_id=? AND id>=? AND rewound IS NULL", t.thread_id, boundary);
  // Websites the rewound runs used: what they did there (sent, paid, posted) can't be taken back.
  const hosts = new Set<string>();
  for (const e of span) if (e.kind === "tool") { const d = json<Record<string, any>>(e.data, {}); if (d.type === "browser") { const u = /Page URL: (https?:\/\/[^\s/]+)/.exec(String(d.output || ""))?.[1] || / on ([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(d.title || ""))?.[1]; if (u) hosts.add(u.replace(/^https?:\/\/(www\.)?/, "")); } }
  return { turnId, threadId: t.thread_id, at: t.started_at, mode, rewound: !!t.rewound_at, boundary, files,
    otherThreads: new Set(later.filter((r) => r.thread !== t.thread_id && r.list.length).map((r) => r.thread)).size,
    partial: later.some((r) => r.list.length >= 300), messages: span.filter((e) => e.kind === "user" || e.kind === "agent").length, websites: [...hosts].slice(0, 8) };
}

const appendCarry = (threadId: string, note: string) => { const c = getThread(threadId)?.carry; run("UPDATE threads SET carry=? WHERE id=?", c ? `${c}\n\n${note}` : note, threadId); };

/** Takes the conversation back to before turn t: marks what followed as rewound, then forks the Codex thread before that
 * turn. When the fork can't be made (no Codex turn id, a thread restarted since, the brain refusing), the next message
 * starts a fresh Codex thread with a recap of what's left. Returns how it was done. */
async function rewindChat(t: TurnLite, boundary: number | null) {
  const at = now();
  if (boundary != null) run("UPDATE events SET rewound=? WHERE thread_id=? AND id>=? AND rewound IS NULL", at, t.thread_id, boundary);
  run("UPDATE turns SET rewound_at=? WHERE thread_id=? AND started_at>=? AND rewound_at IS NULL", at, t.thread_id, t.started_at);
  const th = getThread(t.thread_id)!, b = getBot(th.bot_id)!, old = th.codex_id;
  if (old && t.codex_turn_id) try {
    const c = brain(b);
    await c.ensure();
    const id = await forkThread(c, b, old, { beforeTurnId: t.codex_turn_id });
    run("UPDATE threads SET codex_id=? WHERE id=?", id, t.thread_id);
    await dropCodex(c, old).catch(() => {});
    // The fork forgot memories told after that point: an empty map sends the whole list once, as turn context.
    c.loaded.add(id); c.mems.set(id, new Map());
    await c.mcpReady(id);
    return "fork";
  } catch {}
  if (old) await dropCodex(brain(b), old).catch(() => {});
  run("UPDATE threads SET codex_id=NULL, carry=? WHERE id=?", recap(t.thread_id, null, "", 8000, REWOUND), t.thread_id);
  return "recap";
}

/** Rewinds a finished run. mode: both (files and chat), chat or files. The driver's action (api/threads.ts), audited. */
export async function rewind(turnId: string, mode: RewindMode) {
  const p = rewindPlan(turnId, mode);
  const t = one<TurnLite>("SELECT id, thread_id, bot_id, status, codex_turn_id, started_at, rewound_at FROM turns WHERE id=?", turnId)!;
  if (mode !== "files" && p.rewound) throw httpErr(409, "This run was already rewound");
  if (mode !== "chat" && memberBusy(t.bot_id)) throw httpErr(409, `${getBot(t.bot_id)?.name || "This member"} is running something; rewind when it's idle`);
  const files = mode === "chat" ? { done: [] as string[], failed: [] as { path: string; why: string }[] } : restoreFiles(t.bot_id, planRestore(t.bot_id, restoreTargets(
    all<{ changes: string }>("SELECT changes FROM turns WHERE bot_id=? AND started_at>=? AND changes IS NOT NULL ORDER BY started_at", t.bot_id, t.started_at).map((r) => json<Change[]>(r.changes, [])))));
  const driver = driverName(), when = localClock(t.started_at), list = (xs: string[]) => `${xs.slice(0, 12).join(", ")}${xs.length > 12 ? ` and ${xs.length - 12} more` : ""}`;
  const how = mode === "files" ? null : await rewindChat(t, p.boundary);
  // The member hears what changed under it: the chat it no longer remembers, or files it remembers differently.
  if (mode === "files" && files.done.length) appendCarry(t.thread_id, `[Pitcrew] ${driver} rewound your workspace files to how they were before the run at ${when} ${tzLabel}. Changed back: ${list(files.done)}. Anything done to them since is gone; check before relying on it.`);
  if (mode === "chat") appendCarry(t.thread_id, `[Pitcrew] ${driver} rewound this conversation to before a run at ${when} ${tzLabel}. The files that run changed in /bot/work were kept as they are now.`);
  audit("driver", "run.rewound", { turnId, threadId: t.thread_id, botId: t.bot_id, mode, how, files: files.done.length, failed: files.failed.map((f) => f.path).slice(0, 50), messages: p.messages });
  const parts = [mode !== "files" ? `the chat went back to before ${when}` : "", mode !== "chat" ? `${files.done.length} file${files.done.length === 1 ? "" : "s"} changed back` : "",
    files.failed.length ? `${files.failed.length} couldn't be (${list(files.failed.map((f) => `${f.path}: ${f.why}`))})` : ""].filter(Boolean);
  addEvent(t.thread_id, null, "system", { text: `Rewound: ${parts.join("; ")}.`, rewind: { turnId, mode }, ...(files.failed.length ? { tone: "bad" } : {}) });
  return { ok: true, mode, how, restored: files.done, failed: files.failed };
}
