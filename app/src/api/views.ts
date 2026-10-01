// View models: what the web app's main reads (state, a thread, a member card, telemetry) assemble from the store.
import { one, all, now, json, getSetting } from "../db.js";
import { httpErr } from "../auth.js";
import * as P from "../providers.js";
import * as R from "../runtime/index.js";
import { getBot, listBots, plansOn } from "../crew.js";
import { allComputers, allBrains } from "../computer.js";
import type { Bot, BotCard, Mood, PitStop, ProviderId, State, ThreadSummary, ThreadView, ThreadEvent } from "../../shared/types.js";
import type { PitstopRow, EventRow, LearnedRow, SurfaceRow } from "../models.js";

function mood(b: Bot, threads: ThreadSummary[], pending: { bot_id: string }[], up: boolean): Mood {
  if (pending.some((p) => p.bot_id === b.id)) return "needs";
  if (threads.some((t) => t.status === "running")) return "working";
  const last = one<{ status: string }>("SELECT status FROM turns WHERE bot_id=? ORDER BY started_at DESC LIMIT 1", b.id)?.status;
  if (last === "failed") return "failed";
  if (!up) return "sleep";
  return last === "completed" ? "done" : "idle";
}
// /api/state needs at most 9 threads a member (wall, sidebar, thread panel); the crew view asks for all of them.
export function botCard(b: Bot, pending: { bot_id: string }[], limit = -1): BotCard {
  const threads = all<ThreadSummary>("SELECT id,title,status,created_at,updated_at,pinned FROM threads WHERE bot_id=? AND archived=0 ORDER BY pinned DESC, updated_at DESC LIMIT ?", b.id, limit);
  const c = allComputers().find((x) => x.bot.id === b.id), br = allBrains().find((x) => x.bot.id === b.id);
  return { ...b, threads, mood: mood(b, threads, pending, !!c?.up || !!br?.up), spend: R.weekSpend(b.id), computer: { up: !!c?.up, desktop: !!c?.desktopUp, startedAt: c?.startedAt ?? null, lease: R.leaseHeld(b.id) } };
}
export const pitRow = R.pitRow;
export const LEARNED = `SELECT l.rowid id, l.*, ${R.LEARN_AFTER} need, b.name bot_name FROM learned l JOIN bots b ON b.id=l.bot_id`;
// A learned pattern only acts while the member's policy allows its effect; hide the ones a policy change switched off.
export const liveLearned = (rows: LearnedRow[]) => rows.filter((l) => getBot(l.bot_id)?.policy[l.effect] === "allow");
export function state(): State {
  const pending = all<PitstopRow>("SELECT * FROM pitstops WHERE status='pending' ORDER BY created_at").map(pitRow) as PitStop[];
  const dayStart = (() => { const d = new Date(now() + 330 * 60000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 330 * 60000; })();
  return {
    driverName: getSetting("driver_name", "Driver"), paused: getSetting("paused") === "1", defaultProvider: getSetting("default_provider", "openrouter") as ProviderId, plainVoice: getSetting("plain_voice") === "1",
    bots: listBots().map((b) => botCard(b, pending, 12)), pitstops: pending, providers: P.providerStatus(), plans: plansOn(),
    today: one<{ usd: number; runs: number }>("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", dayStart)!,
    week: one<{ usd: number; runs: number }>("SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) runs FROM turns WHERE started_at>=?", R.weekStart())!,
    weekCap: one<{ c: number }>("SELECT COALESCE(SUM(weekly_cap_usd),0) c FROM bots WHERE archived=0")!.c,
    computersUp: allComputers().filter((c) => c.up).length,
  };
}
export function threadView(id: string): ThreadView {
  const t = R.getThread(id);
  if (!t) throw httpErr(404, "No such thread");
  const events: ThreadEvent[] = all<EventRow>("SELECT * FROM events WHERE thread_id=? ORDER BY id DESC LIMIT 400", id).reverse().map((e) => ({ ...e, data: json(e.data, {}) }) as ThreadEvent);
  const pitIds = events.filter((e) => e.kind === "pitstop").map((e) => e.data.id);
  const surfIds = events.filter((e) => e.kind === "surface").map((e) => e.data.id);
  const pits = pitIds.length ? all<PitstopRow>(`SELECT * FROM pitstops WHERE id IN (${pitIds.map(() => "?").join(",")})`, ...pitIds).map(pitRow) as PitStop[] : [];
  const surfaces = surfIds.length ? all<Pick<SurfaceRow, "id" | "title" | "spec" | "saved">>(`SELECT id,title,spec,saved FROM surfaces WHERE id IN (${surfIds.map(() => "?").join(",")})`, ...surfIds).map((s) => ({ ...s, spec: json(s.spec) })) : [];
  return { thread: { ...t, running: R.isRunning(id) }, bot: getBot(t.bot_id)!, events, pitstops: pits, surfaces };
}
export function telemetry() {
  const ws = R.weekStart();
  return {
    bots: listBots().map((b) => ({ id: b.id, name: b.name, hue: b.hue, shape: b.shape, cap: b.weekly_cap_usd, spend: R.weekSpend(b.id),
      runs: one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND started_at>=?", b.id, ws)!.n,
      failed: one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND started_at>=? AND status='failed'", b.id, ws)!.n })),
    runs: all("SELECT t.*, th.title thread_title, b.name bot_name, b.hue FROM turns t JOIN threads th ON th.id=t.thread_id JOIN bots b ON b.id=t.bot_id ORDER BY t.started_at DESC LIMIT 150"),
    pitstops: one("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='denied') denied, SUM(status='expired') expired, COALESCE(SUM(CASE WHEN decided_at IS NOT NULL AND status!='expired' THEN decided_at-created_at END),0) wait_ms FROM pitstops WHERE created_at>=?", ws),
    handled: one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE status='completed' AND started_at>=?", ws)!.n,
    byModel: all("SELECT provider, model, COUNT(*) runs, SUM(cost_usd) usd, SUM(input_tokens) input, SUM(output_tokens) output FROM turns WHERE started_at>=? GROUP BY provider, model ORDER BY usd DESC", ws),
  };
}
