// The long lists (Pit stops history, Threads, Telemetry runs): filters validated against allowlists, parameterized SQL,
// and "before" cursors so every page reads limit+1 rows off an index. Newer pages are the client's cursor stack.
import { Hono } from "hono";
import { one, all, json } from "../db.js";
import * as R from "../runtime/index.js";
import { listBots } from "../crew.js";
import { signedIn, type Env } from "../http/guard.js";
import type { PitHistoryPage, PitHistoryRow, RunPage, RunRow, TelemetrySummary, ThreadKid, ThreadListRow, ThreadPage } from "../../shared/types.js";
import type { PitstopRow } from "../models.js";

type Q = Record<string, string | undefined>;
const DAY = 86400000;
export const RANGES = [1, 7, 30, 90, 0] as const;

/** A cursor is "ts:id" of the last row shown; the id breaks ties within one millisecond. */
export const cursorOf = (ts: number, id: string) => `${ts}:${id}`;
export const parseCursor = (c: unknown) => { const m = /^(\d{1,15}):([\w-]{1,64})$/.exec(String(c ?? "")); return m ? { ts: +m[1], id: m[2] } : null; };
export const limitOf = (v: unknown, d: number, max = 50) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : d; };
/** Start of the range in ms; days outside RANGES falls back to 7, and 0 means all time. */
export const rangeStart = (v: unknown, at = Date.now()) => { const d = v === undefined || v === "" ? 7 : Number(v); const days = (RANGES as readonly number[]).includes(d) ? d : 7; return days ? at - days * DAY : 0; };
export const idOf = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
export const searchOf = (v: unknown) => String(v ?? "").trim().slice(0, 100);
/** A LIKE pattern matching s anywhere, with % _ and \ taken literally (pair with ESCAPE '\'). */
export const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (list as readonly unknown[]).includes(v) ? v as T : null;

// --- Pit stops history ---------------------------------------------------------------------------------------------
// Each kind and outcome is a fixed SQL fragment; only the key comes from the request.
export const PIT_KINDS = {
  pay: "p.effect='pay'", send: "p.effect='send'", signin: "(p.effect='signin' OR p.kind IN ('secret','vault'))", install: "p.effect='install'",
  delete: "(p.effect='delete' OR p.kind='files')", share: "p.effect='share'", site: "p.kind='site'", run: "p.kind IN ('command','mcp') AND p.effect NOT IN ('pay','send','signin','install','delete','share')",
  hire: "p.kind IN ('hire','member','retire','soul')", memory: "p.kind='engram'",
} as const;
const STANDING = "('thread','always','site','full')";
export const PIT_OUTCOMES = {
  approved: `p.status='approved' AND COALESCE(p.scope,'once') NOT IN ${STANDING}`, standing: `p.status='approved' AND p.scope IN ${STANDING}`,
  denied: "p.status='denied'", expired: "p.status='expired'",
} as const;

/** Decided pit stops, newest first. Per request: walks pitstops_created from the cursor and stops at limit+1 matches;
 *  the first page also counts the range (bounded by hand-made decisions, hundreds a week). */
export function pitHistory(q: Q, at = Date.now()): PitHistoryPage {
  const limit = limitOf(q.limit, 12), cur = parseCursor(q.before), s = searchOf(q.q), bot = idOf(q.bot);
  const kind = oneOf(q.kind, Object.keys(PIT_KINDS) as (keyof typeof PIT_KINDS)[]), outcome = oneOf(q.outcome, Object.keys(PIT_OUTCOMES) as (keyof typeof PIT_OUTCOMES)[]);
  const w = ["p.status!='pending'", "p.created_at>=?"], a: (string | number)[] = [rangeStart(q.days, at)];
  if (bot) { w.push("p.bot_id=?"); a.push(bot); }
  if (kind) w.push(`(${PIT_KINDS[kind]})`);
  if (outcome) w.push(`(${PIT_OUTCOMES[outcome]})`);
  if (s) { w.push("(p.title LIKE ? ESCAPE '\\' OR th.title LIKE ? ESCAPE '\\')"); a.push(likeOf(s), likeOf(s)); }
  const from = "FROM pitstops p LEFT JOIN threads th ON th.id=p.thread_id";
  const page = all<PitstopRow & { thread_title: string | null }>(`SELECT p.*, th.title thread_title ${from} WHERE ${[...w, ...(cur ? ["(p.created_at<? OR (p.created_at=? AND p.id<?))"] : [])].join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    ...a, ...(cur ? [cur.ts, cur.ts, cur.id] : []), limit + 1);
  const rows = page.slice(0, limit).map((p) => ({ ...R.pitRow(p)!, thread_title: p.thread_title }) as PitHistoryRow), last = rows.at(-1);
  return { rows, next: page.length > limit && last ? cursorOf(last.created_at, last.id) : null, total: cur ? null : one<{ n: number }>(`SELECT COUNT(*) n ${from} WHERE ${w.join(" AND ")}`, ...a)!.n };
}

// --- Threads -------------------------------------------------------------------------------------------------------
const TOP = "(origin IS NULL OR json_extract(origin,'$.kind') IS NOT 'delegated')";
// Pinned threads made before 5 Oct 2026 stored " · pinned" in the title itself.
const COLS = "id,bot_id,replace(title,' · pinned','') AS title,status,pinned,archived,test,created_at,updated_at";
const tidyText = (t: unknown) => String(t || "").replace(/[*_`#>]+|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 180);

/** The last thing said in each thread, and whether it was the member: one grouped read over events_thread. */
function lastLines(ids: string[]) {
  if (!ids.length) return new Map<string, { text: string; agent: boolean }>();
  const rows = all<{ thread_id: string; kind: string; data: string }>(`SELECT thread_id, kind, data FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind IN ('agent','user') AND thread_id IN (${ids.map(() => "?").join(",")}) GROUP BY thread_id)`, ...ids);
  return new Map(rows.map((r) => [r.thread_id, { text: tidyText(json(r.data, {}).text), agent: r.kind === "agent" }]));
}

/** Top-level threads, pinned first (first page only), newest first, with sub-threads nested under their parent.
 *  Per request: one walk of threads_updated from the cursor (limit+1 rows, skipping sub-threads and test threads),
 *  one threads_parent lookup for the page's children, one events read for their last lines. The first page also
 *  counts the hidden ones, a scan of threads (hundreds of rows). A search reads every member's messages instead. */
export function threadPage(q: Q): ThreadPage {
  const limit = limitOf(q.limit, 12), cur = parseCursor(q.before), s = searchOf(q.q), bot = idOf(q.bot);
  const archived = q.archived === "1" ? 1 : 0, test = q.test === "1";
  let rows: ThreadListRow[], pinned: ThreadListRow[] = [], next: string | null = null;
  if (s) {
    const hits = (bot ? listBots().filter((b) => b.id === bot) : listBots()).flatMap((b) => R.findThreads(b.id, s, { limit: 50 }));
    const meta = hits.length ? new Map(all<ThreadListRow>(`SELECT ${COLS} FROM threads WHERE id IN (${hits.map(() => "?").join(",")})`, ...hits.map((h) => h.id)).map((r) => [r.id, r])) : new Map<string, ThreadListRow>();
    rows = hits.flatMap((h) => { const r = meta.get(h.id); return r && r.archived === archived && (test || !r.test) ? [{ ...r, snippet: h.snippet || undefined }] : []; });
  } else {
    const w = ["archived=?", TOP], a: (string | number)[] = [archived];
    if (!test) w.push("test=0");
    if (bot) { w.push("bot_id=?"); a.push(bot); }
    if (!cur) pinned = all<ThreadListRow>(`SELECT ${COLS} FROM threads WHERE ${w.join(" AND ")} AND pinned=1 AND bot_id IN (SELECT id FROM bots WHERE archived=0) ORDER BY updated_at DESC LIMIT 50`, ...a);
    const got = all<ThreadListRow>(`SELECT ${COLS} FROM threads WHERE ${w.join(" AND ")} AND pinned=0${cur ? " AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...a, ...(cur ? [cur.ts, cur.ts, cur.id] : []), limit + 1);
    rows = got.slice(0, limit);
    const last = rows.at(-1); if (got.length > limit && last) next = cursorOf(last.updated_at, last.id);
  }
  const shown = [...pinned, ...rows];
  const kidRows = shown.length && !s ? all<ThreadKid & { parent: string }>(`SELECT id,bot_id,title,status,updated_at,json_extract(origin,'$.fromThread') parent FROM threads WHERE json_extract(origin,'$.fromThread') IN (${shown.map(() => "?").join(",")}) ORDER BY created_at LIMIT 200`, ...shown.map((r) => r.id)) : [];
  const lines = lastLines([...shown.filter((r) => !r.snippet).map((r) => r.id), ...kidRows.map((k) => k.id)]);
  for (const r of shown) if (!r.snippet) r.snippet = lines.get(r.id)?.text || "";
  const kids: Record<string, ThreadKid[]> = {};
  for (const { parent, ...k } of kidRows) (kids[parent] ||= []).push({ ...k, snippet: lines.get(k.id)?.text || "", replied: !!lines.get(k.id)?.agent });
  const counts = cur || s ? null : one<{ total: number; test: number; sub: number }>(`SELECT COALESCE(SUM(${TOP} AND test=0),0) total, COALESCE(SUM(${TOP} AND test=1),0) test, COALESCE(SUM(NOT ${TOP}),0) sub FROM threads WHERE archived=?${bot ? " AND bot_id=?" : ""}`, archived, ...(bot ? [bot] : []))!;
  return { pinned, rows, kids, next, total: counts ? counts.total + (test ? counts.test : 0) : s ? rows.length : null, hidden: counts && { test: test ? 0 : counts.test, sub: counts.sub } };
}

// --- Telemetry -----------------------------------------------------------------------------------------------------
const RESTART = "'Control plane restarted'";
// A run counts once, when it starts; every place splits that one number the same way (finished + failed + cut + other).
export const RUN_OUTCOMES = {
  finished: "t.status='completed'", failed: "t.status='failed'", cut: `t.status='interrupted' AND t.error=${RESTART}`,
  stopped: `t.status='interrupted' AND t.error IS NOT ${RESTART}`, running: "t.status NOT IN ('completed','failed','interrupted')",
} as const;
export const RUN_TRIGGERS = ["driver", "schedule", "email", "delegation", "plan", "resume", "retro", "check", "surface", "teach"] as const;

/** The summary tiles and "Needs a look". Per request: a handful of aggregates over turns_started for the range, plus
 *  per failure one turns_thread probe for a later finished run (failures are few; capped at 5). */
export function telemetrySummary(q: Q, at = Date.now()): Omit<TelemetrySummary, "openrouter" | "chatgpt"> {
  const since = rangeStart(q.days, at);
  const n = one<Record<string, number>>(`SELECT COUNT(*) started, ${Object.entries(RUN_OUTCOMES).map(([k, v]) => `COALESCE(SUM(${v}),0) ${k}`).join(", ")},
    COALESCE(SUM(t.cost_usd),0) usd, COALESCE(SUM(t.input_tokens),0) input, COALESCE(SUM(t.cached_tokens),0) cached, COALESCE(SUM(t.output_tokens),0) output,
    COALESCE(SUM(t.cost_basis='plan'),0) plan FROM turns t WHERE t.started_at>=?`, since)!;
  const busy = one<{ bot_id: string; n: number }>("SELECT bot_id, COUNT(*) n FROM turns WHERE started_at>=? GROUP BY bot_id ORDER BY n DESC LIMIT 1", since);
  const busyTrigger = busy ? one<{ trigger: string }>("SELECT trigger FROM turns WHERE bot_id=? AND started_at>=? GROUP BY trigger ORDER BY COUNT(*) DESC LIMIT 1", busy.bot_id, since)?.trigger ?? null : null;
  const open = `t.status='failed' AND t.started_at>=? AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.thread_id AND u.started_at>t.started_at AND u.status='completed')`;
  const failures = all<RunRow>(`SELECT ${RUN_COLS} FROM turns t JOIN threads th ON th.id=t.thread_id WHERE ${open} ORDER BY t.started_at DESC LIMIT 5`, since);
  const cut = one<{ n: number; resumed: number }>(`SELECT COUNT(*) n, COALESCE(SUM(EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.thread_id AND u.started_at>t.started_at)),0) resumed FROM turns t WHERE ${RUN_OUTCOMES.cut} AND t.started_at>=?`, since)!;
  return {
    since, runs: { started: n.started, finished: n.finished, failed: n.failed, cut: n.cut, stopped: n.stopped, running: n.running },
    spend: { usd: n.usd, cap: one<{ c: number }>("SELECT COALESCE(SUM(weekly_cap_usd),0) c FROM bots WHERE archived=0")!.c, allPlan: n.started > 0 && n.plan === n.started },
    tokens: { input: n.input, cached: n.cached, output: n.output }, busiest: busy ? { botId: busy.bot_id, runs: busy.n, trigger: busyTrigger } : null,
    failures, failuresTotal: failures.length < 5 ? failures.length : one<{ n: number }>(`SELECT COUNT(*) n FROM turns t WHERE ${open}`, since)!.n,
    cut: { runs: cut.n, resumed: cut.resumed },
  };
}

const RUN_COLS = "t.id,t.thread_id,t.bot_id,t.trigger,t.status,t.error,t.started_at,t.ended_at,t.input_tokens,t.cached_tokens,t.output_tokens,t.cost_usd,t.cost_basis,th.title thread_title,json_extract(th.origin,'$.fromBot') from_bot";

/** Runs, newest first. Per request: walks turns_started from the cursor to limit+1 matches; the first page also counts
 *  the range (one indexed count over the range's runs). */
export function runPage(q: Q, at = Date.now()): RunPage {
  const limit = limitOf(q.limit, 10), cur = parseCursor(q.before), s = searchOf(q.q), bot = idOf(q.bot);
  const trigger = oneOf(q.trigger, RUN_TRIGGERS), outcome = oneOf(q.outcome, Object.keys(RUN_OUTCOMES) as (keyof typeof RUN_OUTCOMES)[]);
  const w = ["t.started_at>=?"], a: (string | number)[] = [rangeStart(q.days, at)];
  if (bot) { w.push("t.bot_id=?"); a.push(bot); }
  if (trigger) { w.push("t.trigger=?"); a.push(trigger); }
  if (outcome) w.push(`(${RUN_OUTCOMES[outcome]})`);
  if (s) { w.push("th.title LIKE ? ESCAPE '\\'"); a.push(likeOf(s)); }
  const from = "FROM turns t JOIN threads th ON th.id=t.thread_id";
  const got = all<RunRow>(`SELECT ${RUN_COLS} ${from} WHERE ${[...w, ...(cur ? ["(t.started_at<? OR (t.started_at=? AND t.id<?))"] : [])].join(" AND ")} ORDER BY t.started_at DESC, t.id DESC LIMIT ?`,
    ...a, ...(cur ? [cur.ts, cur.ts, cur.id] : []), limit + 1);
  const rows = got.slice(0, limit), last = rows.at(-1);
  return { rows, next: got.length > limit && last ? cursorOf(last.started_at, last.id) : null, total: cur ? null : one<{ n: number }>(`SELECT COUNT(*) n ${from} WHERE ${w.join(" AND ")}`, ...a)!.n };
}

export const listRoutes = new Hono<Env>()
  .get("/api/pitstops/history", signedIn, (c) => c.json(pitHistory(c.req.query())))
  .get("/api/telemetry/runs", signedIn, (c) => c.json(runPage(c.req.query())));
