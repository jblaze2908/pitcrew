// Pit stops: a call (or hire, lease, site, plan limit) waiting on the driver, and the driver's decision.
import { one, run, now, uid, json, audit } from "../db.js";
import { getBot, normaliseSpec, createBot } from "../crew.js";
import { applySiteChoice } from "../domains.js";
import type { PitstopRow } from "../models.js";
import type { PitStop } from "../../shared/types.js";
import { bus } from "./bus.js";
import { active, waits } from "./state.js";
import { getThread, addEvent, setThreadStatus } from "./threads.js";
import { describePattern, learnable, learn, learnProgress } from "./rules.js";
import { addSchedule } from "./schedules.js";

export const pitRow = (p: PitstopRow | undefined): PitStop | undefined => p && { ...p, detail: json(p.detail, {}), jev: json(p.jev, {}), learn: p.status === "pending" ? learnProgress(p) : null };

export interface PitStopSpec { id?: string; botId: string; threadId: string | null; kind: string; effect: string; title: string; detail: object; jev?: object; expiresMin?: number }
// Resolves with the decision: "approved" | "denied" | "expired" (a hire resolves "pending" at once; its decision makes the member).
export function pitStop({ id = uid("ps"), botId, threadId, kind, effect, title, detail, jev: v = {}, expiresMin = 30 }: PitStopSpec): Promise<string> {
  // Work another member asked for says so wherever the pit stop shows (wall, pit stops, phone).
  const o = threadId && json(getThread(threadId)?.origin);
  if (o?.kind === "delegated") title = `${title} · for ${getBot(o.fromBot)?.name || "another member"}`;
  run("INSERT INTO pitstops(id,bot_id,thread_id,turn_id,kind,effect,title,detail,jev,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id, botId, threadId, threadId ? active.get(threadId)?.turnId ?? null : null, kind, effect, title, JSON.stringify(detail), JSON.stringify(v), now(), now() + expiresMin * 60000);
  const row = pitRow(one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id));
  if (threadId) { addEvent(threadId, active.get(threadId)?.turnId, "pitstop", { id }, { pitstop: row }); setThreadStatus(threadId, "needs"); }
  bus.emit("pitstop", { id, botId, threadId, status: "pending", pitstop: row });
  audit("jev", "pitstop.opened", { id, botId, kind, effect, title });
  if (kind === "hire") return Promise.resolve("pending");
  return new Promise((resolve) => {
    waits.set(id, resolve);
    setTimeout(() => decide(id, "expired", {}), expiresMin * 60000).unref();
  });
}

export async function decide(id: string, decision: string, { scope = "once", note = "", spec = null }: { scope?: string; note?: string; spec?: Record<string, unknown> | null } = {}) {
  const ps = one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id);
  if (!ps || ps.status !== "pending") return ps;
  const status = decision === "approve" || decision === "approved" ? "approved" : decision === "expired" ? "expired" : "denied";
  if (ps.kind === "hire" && status === "approved") {
    const s = normaliseSpec({ ...json(ps.detail, {}).spec, ...(spec || {}) });
    const bot = createBot(s);
    if (s.schedule?.spec && s.schedule.prompt) { try { addSchedule(bot.id, null, s.schedule.spec, s.schedule.prompt); } catch {} }
    note = `Hired ${bot.name}`;
  }
  const detail = json(ps.detail, {});
  const match = detail.pattern || detail.signature;
  if (status === "approved" && ["thread", "always"].includes(scope) && match && !["pay", "delete", "share"].includes(ps.effect)) {
    run("INSERT INTO rules(id,bot_id,thread_id,effect,match,label,created_at) VALUES(?,?,?,?,?,?,?)", uid("ru"), ps.bot_id, scope === "thread" ? ps.thread_id : null, ps.effect, match, `${describePattern(match)}${scope === "thread" ? " (this thread)" : ""}`, now());
  }
  if (ps.kind === "site") applySiteChoice(ps, status, scope);
  if (detail.pattern && ps.kind !== "hire" && (status === "approved" || status === "denied") && note !== "Kill switch" && learnable(getBot(ps.bot_id)?.policy, ps.effect, json(ps.jev, {}).by)) learn(ps, detail, status);
  run("UPDATE pitstops SET status=?, scope=?, note=?, decided_at=? WHERE id=?", status, scope, String(note).slice(0, 500), now(), id);
  // A kill-switch denial judges nothing about the call, so it trains as no answer.
  const label = note === "Kill switch" ? "expired" : status;
  run("UPDATE jev_labels SET driver_decision=?, driver_scope=? WHERE pitstop_id=?", label, label === "expired" ? null : scope, id);
  audit(status === "expired" ? "system" : "driver", `pitstop.${status}`, { id, scope, title: ps.title });
  const row = one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id);
  bus.emit("pitstop", { id, botId: ps.bot_id, threadId: ps.thread_id, status, pitstop: pitRow(row) });
  if (ps.thread_id && active.has(ps.thread_id)) setThreadStatus(ps.thread_id, "running");
  if (ps.thread_id && status === "expired") addEvent(ps.thread_id, null, "system", { text: `Pit stop expired after 30 minutes: nothing was done. (${ps.title})` });
  waits.get(id)?.(status); waits.delete(id);
  return row;
}
