// View models: what the web app's main reads (state, a thread, a member card) assemble from the store. Telemetry is in lists.ts.
import { one, all, now, json, getSetting, marks, driverName } from "../db.js";
import { resolveSurface } from "../ledger.js";
import { httpErr } from "../auth.js";
import * as P from "../providers.js";
import * as R from "../runtime/index.js";
import { getBot, listBots, plansOn } from "../crew.js";
import { allComputers, allBrains } from "../computer.js";
import { linked, engramUrl } from "../engramStore.js";
import { newThreadAutonomy } from "../runtime/autonomy.js";
import type { Bot, BotCard, Mood, PitStop, ProviderId, State, ThreadSummary, ThreadView, ThreadEvent } from "../../shared/types.js";
import type { PitstopRow, EventRow, LearnedRow, SurfaceRow } from "../models.js";
import { liveCommands } from "../runtime/state.js";
import { balanceAlerts } from "../runtime/balance.js";
import { shownTitle } from "../runtime/threads.js";
import { istDayAt } from "../runtime/util.js";

// An Engram proposal waits on the driver, not on the member it's filed under, so it doesn't make that member "needs".
function mood(b: Bot, threads: ThreadSummary[], pending: { bot_id: string; kind?: string }[], up: boolean, last: string | null): Mood {
  if (pending.some((p) => p.bot_id === b.id && p.kind !== "engram")) return "needs";
  if (threads.some((t) => t.status === "running")) return "working";
  if (last === "failed") return "failed";
  if (!up) return "sleep";
  return last === "completed" ? "done" : "idle";
}
// Each member's last run status and week spend, by index probes per member (turns_bot); /api/state reads all in one statement.
type CardStats = { last: string | null; spend: number };
const STATS = "SELECT b.id, (SELECT status FROM turns WHERE bot_id=b.id ORDER BY started_at DESC LIMIT 1) last, (SELECT COALESCE(SUM(cost_usd),0) FROM turns WHERE bot_id=b.id AND started_at>=?) spend FROM bots b";
const statsOf = (b: Bot): CardStats => one<CardStats>(`${STATS} WHERE b.id=?`, R.weekStart(), b.id) ?? { last: null, spend: 0 };
// Every view needs at most 12 threads a member (wall, sidebar, thread panel); the Crew page pages its own (/api/threads).
export function botCard(b: Bot, pending: { bot_id: string; kind?: string }[], limit = 12, stats = statsOf(b)): BotCard {
  // A scheduled run's own thread shows only while it runs, waits on the driver, or reported news or failed in the last 48 h;
  // quiet runs live on the Schedules page.
  const threads = all<ThreadSummary>(`SELECT id,replace(title,' · pinned','') AS title,status,created_at,updated_at,pinned FROM threads WHERE bot_id=? AND archived=0 AND test=0 AND (origin IS NULL OR json_extract(origin,'$.kind') IS NOT 'schedule'
    OR status IN ('running','needs') OR EXISTS (SELECT 1 FROM schedule_runs r WHERE r.thread_id=threads.id AND r.status IN ('reported','failed') AND r.fired_at>?)) ORDER BY pinned DESC, updated_at DESC LIMIT ?`, b.id, Date.now() - 48 * 3600000, limit);
  const c = allComputers().find((x) => x.bot.id === b.id), br = allBrains().find((x) => x.bot.id === b.id);
  return { ...b, threads: threads.map((t) => ({ ...t, title: shownTitle(t.title) })), mood: mood(b, threads, pending, !!c?.up || !!br?.up, stats.last), spend: stats.spend, computer: { up: !!c?.up, desktop: !!c?.desktopUp, startedAt: c?.startedAt ?? null, lease: R.leaseHeld(b.id) } };
}
export const pitRow = R.pitRow;
export const LEARNED = `SELECT l.rowid id, l.*, ${R.LEARN_AFTER} need, b.name bot_name FROM learned l JOIN bots b ON b.id=l.bot_id`;
// A learned pattern only acts while the member's policy allows its effect; hide the ones a policy change switched off.
// One bot read per member in rows, not per row.
export function liveLearned(rows: LearnedRow[]) {
  const bots = new Map<string, Bot | undefined>();
  const policy = (id: string) => (bots.has(id) ? bots.get(id) : bots.set(id, getBot(id)).get(id))?.policy;
  return rows.filter((l) => policy(l.bot_id)?.[l.effect] === "allow");
}
export function state(): State {
  const pending = all<PitstopRow>("SELECT * FROM pitstops WHERE status='pending' ORDER BY created_at").map(pitRow) as PitStop[];
  const dayStart = istDayAt(now());
  const stats = new Map(all<CardStats & { id: string }>(`${STATS} WHERE b.archived=0`, R.weekStart()).map((s) => [s.id, s]));
  return {
    driverName: driverName("Driver"), paused: getSetting("paused") === "1", defaultProvider: getSetting("default_provider", "openrouter") as ProviderId, plainVoice: getSetting("plain_voice") === "1", newThreadMode: newThreadAutonomy(),
    bots: listBots().map((b) => botCard(b, pending, 12, stats.get(b.id))), pitstops: pending, providers: P.providerStatus(), plans: plansOn(),
    today: one<{ usd: number; runs: number }>("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", dayStart)!,
    week: one<{ usd: number; runs: number }>("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", R.weekStart())!,
    weekCap: one<{ c: number }>("SELECT COALESCE(SUM(weekly_cap_usd),0) c FROM bots WHERE archived=0")!.c,
    computersUp: allComputers().filter((c) => c.up).length,
    engram: { linked: linked(), url: engramUrl() },
    unread: R.inbox().unread,
    alerts: balanceAlerts(),
    formerNames: Object.fromEntries(all<{ id: string; name: string }>("SELECT id, name FROM bots WHERE archived=1").map((b) => [b.id, b.name])),
  };
}
export async function threadView(id: string): Promise<ThreadView> {
  const t = R.getThread(id);
  if (!t) throw httpErr(404, "No such thread");
  const events: ThreadEvent[] = all<EventRow>("SELECT * FROM events WHERE thread_id=? ORDER BY id DESC LIMIT 400", id).reverse().map((e) => ({ ...e, data: json(e.data, {}) }) as ThreadEvent);
  const pitIds = events.filter((e) => e.kind === "pitstop").map((e) => e.data.id);
  const surfIds = events.filter((e) => e.kind === "surface").map((e) => e.data.id);
  const pits = pitIds.length ? all<PitstopRow>(`SELECT * FROM pitstops WHERE id IN (${marks(pitIds)})`, ...pitIds).map(pitRow) as PitStop[] : [];
  // Bound dashboards run their queries here (cached per ledger version; ledger.ts), once per thread load.
  const surfaces = surfIds.length ? await Promise.all(all<Pick<SurfaceRow, "id" | "title" | "spec" | "saved" | "bot_id">>(`SELECT id,title,spec,saved,bot_id FROM surfaces WHERE id IN (${marks(surfIds)})`, ...surfIds)
    .map(({ bot_id, ...s }) => resolveSurface({ ...s, spec: json(s.spec) }, bot_id))) : [];
  return { thread: { ...t, title: shownTitle(t.title), running: R.isRunning(id) }, bot: getBot(t.bot_id)!, events, pitstops: pits, surfaces, queued: R.listQueued(id), painting: R.paintings(id),
    commands: [...liveCommands.values()].filter((c) => c.threadId === id).map(({ threadId: _, ...c }) => c) };
}
