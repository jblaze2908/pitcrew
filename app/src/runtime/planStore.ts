// Plans as stored: the plan and its items, their spend and run counts, the todo text the Chief reads, and the
// snapshot event the plan card draws.
import { one, all, run, now, json } from "../db.js";
import { getBot } from "../crew.js";
import type { PlanRow, PlanItemRow } from "../models.js";
import type { ConstraintCheck, Handoff, PlanSnapshot } from "../../shared/types.js";
import { addEvent } from "./threads.js";
import { short } from "./util.js";

export const PLAN = { budget: 1, chiefRuns: 12, memberRuns: 3, items: 20, itemWaitMs: 10 * 60000, sweepWaitMs: 5 * 60000 };
export interface Limits { chiefRuns: number; extra: Record<string, number> }
export type Plan = Omit<PlanRow, "constraints" | "checks" | "limits" | "log" | "sweep"> & {
  constraints: string[]; checks: ConstraintCheck[] | null; limits: Limits; log: { at: number; text: string }[]; sweep: { who: string; text: string; found: boolean }[] | null;
};
export type PlanItem = Omit<PlanItemRow, "after" | "result" | "history"> & { after: string[]; result: Handoff | null; history: { task: string; result: Handoff | null }[] };

export const planRow = (id: string): Plan | undefined => { const p = one<PlanRow>("SELECT * FROM plans WHERE id=?", id); return p && { ...p, constraints: json(p.constraints, []), checks: json(p.checks, null), limits: { chiefRuns: PLAN.chiefRuns, extra: {}, ...json<Partial<Limits>>(p.limits, {}) }, log: json(p.log, []), sweep: json(p.sweep, null) }; };
export const setLimits = (p: Plan, limits: Limits) => run("UPDATE plans SET limits=? WHERE id=?", JSON.stringify(limits), p.id);
// What the Chief decided at each look, shown as the dashed lines on the plan card. Capped at 40 lines.
export function planLog(planId: string, text: string) { const p = planRow(planId); if (p) run("UPDATE plans SET log=? WHERE id=?", JSON.stringify([...p.log, { at: now(), text: short(text, 200) }].slice(-40)), planId); }
export const chiefOf = (p: Plan) => getBot(one<{ bot_id: string }>("SELECT bot_id FROM threads WHERE id=?", p.thread_id)!.bot_id)!;
export const activePlan = (threadId: string) => { const p = one<{ id: string }>("SELECT id FROM plans WHERE thread_id=? AND status='running' ORDER BY created_at DESC LIMIT 1", threadId); return p && planRow(p.id); };
export const planItems = (planId: string): PlanItem[] => all<PlanItemRow>("SELECT * FROM plan_items WHERE plan_id=? ORDER BY seq", planId).map((i) => ({ ...i, after: json(i.after, []), result: json(i.result, null), history: json(i.history, []) }));
// Runs a member has had or is queued for in this plan: each item counts once plus each reopen. Counted per member, not
// per item, so adding a fresh key can't sidestep the limit.
const memberRuns = (planId: string, botId: string) => one<{ n: number; r: number }>("SELECT COUNT(*) n, COALESCE(SUM(reopened),0) r FROM plan_items WHERE plan_id=? AND owner_bot=? AND NOT (status='cancelled' AND started_at IS NULL)", planId, botId)!;
export const runsOf = (planId: string, botId: string) => { const x = memberRuns(planId, botId); return x.n + x.r; };
export const runsAllowed = (p: Plan, botId: string) => PLAN.memberRuns + (p.limits.extra[botId] || 0);
export function planSpend(p: Plan) {
  const items = one<{ s: number }>("SELECT COALESCE(SUM(cost_usd),0) s FROM plan_items WHERE plan_id=?", p.id)!.s;
  const chief = one<{ s: number; n: number }>("SELECT COALESCE(SUM(cost_usd),0) s, COUNT(*) n FROM turns WHERE thread_id=? AND started_at>=? AND trigger='plan'", p.thread_id, p.created_at)!;
  return { usd: items + chief.s, chiefRuns: chief.n };
}
export function planText(p: Plan, items = planItems(p.id)) {
  const mark: Record<string, string> = { todo: "[ ]", doing: "[~]", done: "[x]", failed: "[!]", cancelled: "[-]" };
  return items.map((i) => `${mark[i.status] || "[?]"} ${i.key} · ${getBot(i.owner_bot)?.name}: ${short(i.task, 160)}${i.after.length ? ` (after ${i.after.join(", ")})` : ""}${i.reopened ? ` · reopened ×${i.reopened}` : ""}${i.result?.answer ? `\n    → ${short(i.result.answer, 300)}` : ""}`).join("\n");
}
export function emitPlan(p: Plan) {
  const items = planItems(p.id), spend = planSpend(p);
  const snap: PlanSnapshot = { id: p.id, goal: p.goal, constraints: p.constraints, status: p.status, answer: p.answer, checks: p.checks, budget: p.budget_usd, spend: spend.usd, chiefRuns: spend.chiefRuns, chiefLimit: p.limits.chiefRuns, live: p.live, log: p.log.slice(-12), sweep: p.sweep,
    items: items.map((i) => ({ key: i.key, owner: i.owner_bot, ownerName: getBot(i.owner_bot)?.name!, task: short(i.task, 300), status: i.status, after: i.after, why: i.why, reopened: i.reopened, runs: runsOf(p.id, i.owner_bot), allowed: runsAllowed(p, i.owner_bot), toThread: i.to_thread, cost: i.cost_usd,
      result: i.result && { answer: short(i.result.answer, 600), assumed: short(i.result.assumed || "", 300), unchecked: short(i.result.unchecked || "", 300), options: short(i.result.options || "", 300) } })) };
  addEvent(p.thread_id, null, "plan", snap);
}
// Splits a member's reply into the handoff shape the plan asks for; a reply without the sections is all answer.
export function parseHandoff(text: unknown): Handoff & { data: string } {
  const t = String(text || ""), heads: [keyof Handoff, RegExp][] = [["data", /from my data/i], ["assumed", /assumed/i], ["unchecked", /couldn[’']?t check/i], ["options", /other options/i]];
  const marks = heads.map(([k, re]) => { const m = new RegExp(`^[\\s>*_#-]*(?:${re.source})[*_:\\s]*:?[*_]*\\s*`, "im").exec(t); return m && { k, at: m.index, end: m.index + m[0].length }; }).filter(Boolean).sort((a, b) => a!.at - b!.at) as { k: keyof Handoff; at: number; end: number }[];
  const out = { answer: (marks.length ? t.slice(0, marks[0].at) : t).trim(), data: "", assumed: "", unchecked: "", options: "" };
  marks.forEach((m, i) => { out[m.k] = t.slice(m.end, marks[i + 1]?.at ?? t.length).trim(); });
  return out;
}
