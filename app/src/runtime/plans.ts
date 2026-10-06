// Plans (prototype, behind the "plans" setting). The Crew Chief edits a todo; Pitcrew starts every item whose `after`
// items are done, hands it their results, records what comes back and wakes the Chief after each item. Starting,
// waiting and passing results is code, not the model.
import { one, run, now, uid, json, audit, driverName } from "../db.js";
import { getBot } from "../crew.js";
import type { ToolResult } from "../shots.js";
import type { Bot, Handoff } from "../../shared/types.js";
import { active, wakeFor } from "./state.js";
import { lastQueued, extendQueued } from "./queue.js";
import { getThread, addEvent } from "./threads.js";
import { sendMessage, interrupt, blockedReason, nextTurn, lastAgentText } from "./turns.js";
import { pitStop } from "./pitstops.js";
import { findMember } from "./delegation.js";
import { PLAN, planRow, setLimits, planLog, chiefOf, activePlan, planItems, runsOf, runsAllowed, planSpend, planText, emitPlan, parseHandoff, type Plan, type PlanItem } from "./planStore.js";
import { short, say } from "./util.js";

// Hitting a limit asks the driver instead of refusing outright; one pending ask per plan and limit.
const planAsks = new Map<string, Promise<boolean>>();
function askToContinue(p: Plan, key: string, title: string) {
  const k = `${p.id}:${key}`;
  if (!planAsks.has(k)) planAsks.set(k, pitStop({ botId: chiefOf(p).id, threadId: p.thread_id, kind: "plan", effect: "plan_limit", title, detail: { planId: p.id, limit: key } })
    .then((d) => { planAsks.delete(k); return d === "approved"; }));
  return planAsks.get(k)!;
}
const ownerOf = (q: unknown, chief: Bot) => (/^(crew )?chief$/i.test(String(q || "").trim()) || q === chief.id ? chief : findMember(q, chief.id));

function wakeChief(p: Plan, text: string, display: string, key: string | null = null) {
  const spend = planSpend(p);
  if (spend.chiefRuns >= p.limits.chiefRuns) {
    askToContinue(p, "chief", `The Crew Chief has looked at this plan ${spend.chiefRuns} times. Let it keep going? (${short(p.goal, 70)})`).then((ok) => {
      const fresh = planRow(p.id); if (!fresh || fresh.status !== "running") return;
      setLimits(fresh, { ...fresh.limits, chiefRuns: fresh.limits.chiefRuns + (ok ? 6 : 1) });
      wakeChief(planRow(p.id)!, ok ? text : `${text}\n\n${driverName("The driver")} said to finish with what the crew has. Finish now.`, display, key);
    });
    return;
  }
  if (key) wakeFor.set(p.thread_id, key);
  const last = lastQueued(p.thread_id);
  if (active.has(p.thread_id) && last?.via === "plan") { extendQueued(p.thread_id, last.id, `\n\n${text}`); return; }
  sendMessage(p.thread_id, { text, trigger: "plan", mode: "queue", display }).catch((e) => addEvent(p.thread_id, null, "error", { text: e.message }));
}
function dispatchPlan(planId: string) {
  const p = planRow(planId);
  if (!p || p.status !== "running") return;
  const items = planItems(p.id), done = new Set(items.filter((i) => i.status === "done").map((i) => i.key));
  for (const it of items.filter((i) => i.status === "todo" && i.after.every((k) => done.has(k)))) {
    if (planSpend(p).usd >= p.budget_usd) {
      askToContinue(p, "budget", `This plan has spent $${planSpend(p).usd.toFixed(2)} of $${p.budget_usd.toFixed(2)}. Allow another $1.00? (${short(p.goal, 70)})`).then((ok) => {
        if (ok) { run("UPDATE plans SET budget_usd=budget_usd+1 WHERE id=?", p.id); emitPlan(planRow(p.id)!); dispatchPlan(p.id); }
        else wakeChief(planRow(p.id)!, `${driverName("The driver")} didn't allow more spending on this plan. Finish with what the crew has.`, "Plan update: budget reached");
      });
      return;
    }
    startItem(p, it);
  }
}
async function startItem(p: Plan, it: PlanItem) {
  const chief = getBot(one<{ bot_id: string }>("SELECT bot_id FROM threads WHERE id=?", p.thread_id)!.bot_id)!, owner = getBot(it.owner_bot)!, driver = driverName();
  const end = (status: string, result: Partial<Handoff> | null, cost = 0) => {
    if (one<{ status: string }>("SELECT status FROM plan_items WHERE id=?", it.id)?.status === "cancelled") { run("UPDATE plan_items SET cost_usd=cost_usd+? WHERE id=?", cost, it.id); return; }
    run("UPDATE plan_items SET status=?, result=?, cost_usd=cost_usd+?, ended_at=? WHERE id=?", status, JSON.stringify(result), cost, now(), it.id);
    const fresh = planRow(p.id)!; emitPlan(fresh);
    if (fresh.status !== "running") return;
    dispatchPlan(p.id);
    const r: Partial<Handoff> = result || {}, running = planItems(p.id).filter((i) => i.status === "doing").map((i) => i.key);
    wakeChief(fresh, [`Plan update from Pitcrew: "${it.key}" (${owner.name}) ${status === "done" ? "finished" : "did not finish"}.`, `Answer: ${r.answer || "(none)"}`,
      r.data && `From their data: ${r.data}`, r.assumed && `Assumed: ${r.assumed}`, r.unchecked && `Couldn't check: ${r.unchecked}`, r.options && `Other options: ${r.options}`,
      `Todo now:\n${planText(fresh)}`, `Constraints:\n${fresh.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      running.length ? `Still running: ${running.join(", ")}. If nothing needs to change, reply "waiting".` : "Nothing is running. Reopen or add items, or finish."].filter(Boolean).join("\n\n"), `Plan update: ${it.key} ${status === "done" ? "done" : "didn't finish"}`, it.key);
  };
  const why = blockedReason(owner);
  if (why) return end("failed", { answer: why });
  // Every finished result goes along, the ones this item waits on first: a step that only saw its `after` items once
  // judged a budget without the fares (2026-10-01 gate).
  const finished = planItems(p.id).filter((x) => x.status === "done" && x.id !== it.id && x.result);
  const toThread = uid("th"), inputs = [...finished.filter((x) => it.after.includes(x.key)), ...finished.filter((x) => !it.after.includes(x.key))];
  run("INSERT INTO threads(id,bot_id,title,origin,created_at,updated_at) VALUES(?,?,?,?,?,?)", toThread, owner.id, `Plan · ${short(it.task, 80)}`, JSON.stringify({ kind: "delegated", fromBot: chief.id, fromThread: p.thread_id, planId: p.id, itemKey: it.key }), now(), now());
  run("UPDATE plan_items SET status='doing', to_thread=?, started_at=? WHERE id=?", toThread, now(), it.id);
  emitPlan(planRow(p.id)!);
  const text = [`${chief.name} is running a plan for ${driver} and needs this from you.`, `Goal: ${p.goal}`, `Your task: ${it.task}`,
    inputs.length ? `Results from earlier steps you can build on:\n${inputs.map((x) => `- ${x.key} (${getBot(x.owner_bot)?.name}): ${short(x.result?.answer, 900)}${x.result?.options && !/^nothing\.?$/i.test(x.result.options) ? `\n  (other options they know of: ${short(x.result.options, 300)})` : ""}${x.result?.assumed && !/^nothing\.?$/i.test(x.result.assumed) ? `\n  (they assumed: ${short(x.result.assumed, 300)})` : ""}`).join("\n")}` : "",
    `Reply with your answer, then end with three short sections titled exactly:\nFrom my data: what came from your own memory, logins or tools.\nAssumed: anything you assumed or estimated, or "nothing".\nCouldn't check: what you couldn't verify, or "nothing".\nOther options: alternatives you know of that weren't asked for (cheaper, other dates, other providers), with figures, or "nothing".\nAnswer only what's asked. Don't add costs, allowances or facts you weren't given; anything estimated goes under Assumed.${p.live === 0 ? "\nThis plan runs on what you already know: live lookups are off." : ""}`].filter(Boolean).join("\n\n");
  const doneP = nextTurn(toThread);
  await sendMessage(toThread, { text, trigger: "delegation", display: it.task }).catch(() => {});
  const r = await Promise.race([doneP, new Promise<null>((res) => setTimeout(() => res(null), PLAN.itemWaitMs).unref())]);
  if (!r) return end("failed", { answer: `${owner.name} didn't finish within ${PLAN.itemWaitMs / 60000} minutes.` });
  const reply = lastAgentText(toThread, r.turnId);
  end(r.status === "completed" ? "done" : "failed", r.status === "completed" ? parseHandoff(reply) : { answer: `Run ended ${r.status}. ${short(reply, 400)}` }, r.cost || 0);
}
// Before a plan may finish, every member that contributed is asked once, in its own item thread (cached, cheap), for an
// alternative that would better meet the constraints. Structural, because two gate runs showed the Chief grading its own
// search as complete. One follow-up per member, in parallel; once per plan.
async function sweep(p: Plan) {
  run("UPDATE plans SET swept=1 WHERE id=?", p.id);
  const latest = new Map<string, PlanItem>();
  for (const i of planItems(p.id)) if (i.status === "done" && i.to_thread) latest.set(i.owner_bot, i);
  addEvent(p.thread_id, null, "system", { text: `Before finishing, asking ${[...latest.values()].map((i) => getBot(i.owner_bot)?.name).join(", ")} for alternatives.` });
  const summary = planItems(p.id).filter((i) => i.status === "done").map((i) => `- ${i.key} (${getBot(i.owner_bot)?.name}): ${short(i.result?.answer, 400)}`).join("\n");
  const answers = await Promise.all([...latest.values()].map(async (i) => {
    const doneP = nextTurn(i.to_thread!);
    await sendMessage(i.to_thread!, { text: `Before the plan finishes: the driver's constraints are\n${p.constraints.map((c, n) => `${n + 1}. ${c}`).join("\n")}\n\nWhat the plan found:\n${summary}\n\nDo you know any alternative, within your job, that would better meet a constraint (cheaper, other dates or times, another provider)? Reply "No alternative" or give it with figures. Nothing else.`, trigger: "delegation", display: "Any alternative before the plan finishes?" }).catch(() => {});
    const r = await Promise.race([doneP, new Promise<null>((res) => setTimeout(() => res(null), PLAN.sweepWaitMs).unref())]);
    if (r?.cost) run("UPDATE plan_items SET cost_usd=cost_usd+? WHERE id=?", r.cost, i.id);
    return { who: getBot(i.owner_bot)?.name, text: r ? lastAgentText(i.to_thread!, r.turnId) : "(no reply in time)" };
  }));
  run("UPDATE plans SET sweep=? WHERE id=?", JSON.stringify(answers.map((a) => ({ who: a.who, text: short(a.text, 600), found: !/^\W*no alternative/i.test(a.text.trim()) }))), p.id);
  const fresh = planRow(p.id)!; emitPlan(fresh);
  if (fresh.status !== "running") return;
  const found = answers.filter((a) => !/^\W*no alternative/i.test(a.text.trim()));
  wakeChief(fresh, [`Alternatives check from Pitcrew, before finishing:`, ...answers.map((a) => `- ${a.who}: ${short(a.text, 700)}`),
    found.length ? `Some members know alternatives. If one could change the answer, reopen or add an item to test it; a constraint it could meet stays untested until tested. Then finish.` : `No member knows a better alternative. You can finish now.`].join("\n"), "Plan update: alternatives check");
}
export function stopPlan(planId: string) {
  const p = planRow(planId);
  if (!p || p.status !== "running") return false;
  for (const i of planItems(p.id).filter((x) => ["todo", "doing", "failed"].includes(x.status))) {
    run("UPDATE plan_items SET status='cancelled', ended_at=? WHERE id=?", now(), i.id);
    if (i.status === "doing" && i.to_thread) interrupt(i.to_thread).catch(() => {});
  }
  run("UPDATE plans SET status='stopped', ended_at=? WHERE id=?", now(), p.id);
  audit("driver", "plan.stopped", { id: p.id });
  emitPlan(planRow(p.id)!);
  addEvent(p.thread_id, null, "system", { text: "You stopped the plan. Nothing more will run for it." });
  return true;
}
// Live lookups are decided once per plan: the first browser action in any plan step asks the driver, and the answer holds
// for every step after (site rules still apply). Before this, each first-visit site was its own pit stop.
// Runs on every browser action: two indexed reads, then nothing for threads outside a plan.
export async function planLive(threadId: string) {
  const o = json(getThread(threadId)?.origin);
  if (!o?.planId) return true;
  let p = planRow(o.planId);
  if (!p) return true;
  if (p.live == null) {
    const chief = getBot(one<{ bot_id: string }>("SELECT bot_id FROM threads WHERE id=?", p.thread_id)!.bot_id)!;
    const id = p.id;
    if (!planLiveAsk.has(id)) planLiveAsk.set(id, pitStop({ botId: chief.id, threadId: p.thread_id, kind: "plan", effect: "browse", title: `Let the crew look things up online for this plan? (${short(p.goal, 80)})`, detail: { planId: id } })
      .then((d) => { run("UPDATE plans SET live=? WHERE id=?", d === "approved" ? 1 : 0, id); planLiveAsk.delete(id); }));
    await planLiveAsk.get(id);
    p = planRow(o.planId)!;
  }
  return p.live === 1;
}
const planLiveAsk = new Map<string, Promise<void>>();

export async function planTool(chief: Bot, threadId: string, a: Record<string, any>): Promise<ToolResult> {
  if (json(getThread(threadId)?.origin)?.kind === "delegated") return say("Plans are run from the Crew Chief's own thread, not from a plan step.", false);
  const current = activePlan(threadId);
  const errs: string[] = [], did: string[] = [], after = wakeFor.get(threadId);
  wakeFor.delete(threadId);
  let p: Plan;
  if (current) p = current;
  else {
    if (!a.goal || !Array.isArray(a.add) || !a.add.length) return say("Start a plan with goal, constraints and add.", false);
    const id = uid("pl");
    run("INSERT INTO plans(id,thread_id,goal,constraints,status,budget_usd,created_at) VALUES(?,?,?,?,?,?,?)", id, threadId, String(a.goal).slice(0, 1000), JSON.stringify((a.constraints || []).map((c) => String(c).slice(0, 300)).slice(0, 10)), "running", PLAN.budget, now());
    audit(chief.id, "plan.started", { id, threadId });
    p = planRow(id)!;
  }
  // A member past its run limit asks the driver once; yes grants one more run for that member.
  const roomFor = async (owner: Bot) => {
    if (runsOf(p.id, owner.id) < runsAllowed(p, owner.id)) return true;
    const ok = await askToContinue(p, `runs:${owner.id}`, `${owner.name} has had ${runsOf(p.id, owner.id)} runs in this plan. Allow one more? (${short(p.goal, 70)})`);
    if (ok) { p = planRow(p.id)!; setLimits(p, { ...p.limits, extra: { ...p.limits.extra, [owner.id]: (p.limits.extra[owner.id] || 0) + 1 } }); p = planRow(p.id)!; }
    return ok;
  };
  const items = planItems(p.id), byKey = new Map<string, Partial<PlanItem> & { id: string; key: string }>(items.map((i) => [i.key, i]));
  let seq = items.length;
  for (const x of a.add || []) {
    const key = String(x.key || "").trim().slice(0, 40), owner = ownerOf(x.member, chief);
    if (!key || byKey.has(key)) { errs.push(`add ${key || "?"}: key missing or already used (reopen it instead)`); continue; }
    if (!owner) { errs.push(`add ${key}: no crew member called "${short(x.member, 40)}"`); continue; }
    if (owner.private) { errs.push(`add ${key}: ${owner.name} is private; only ${driverName()} talks to it`); continue; }
    if (seq >= PLAN.items) { errs.push(`add ${key}: a plan holds at most ${PLAN.items} items`); continue; }
    if (!(await roomFor(owner))) { errs.push(`add ${key}: ${driverName()} said ${owner.name} shouldn't run again; finish with what the crew has`); continue; }
    const after = (x.after || []).map(String).filter((k) => byKey.has(k) || (a.add || []).some((y) => y.key === k));
    const row = { id: uid("pi"), key }; byKey.set(key, row);
    run("INSERT INTO plan_items(id,plan_id,seq,key,owner_bot,task,after,status) VALUES(?,?,?,?,?,?,?,?)", row.id, p.id, seq++, key, owner.id, String(x.task || "").slice(0, 2000), JSON.stringify(after), "todo");
    did.push(`added ${key} for ${owner.name}`);
  }
  for (const x of a.reopen || []) {
    const it = byKey.get(String(x.key));
    if (!it?.status) { errs.push(`reopen ${x.key}: no such item`); continue; }
    if (it.status === "doing") { errs.push(`reopen ${x.key}: still running`); continue; }
    if (!(await roomFor(getBot(it.owner_bot)!))) { errs.push(`reopen ${x.key}: ${driverName()} said ${getBot(it.owner_bot)?.name} shouldn't run again; finish with what the crew has`); continue; }
    run("UPDATE plan_items SET status='todo', task=?, why=?, reopened=reopened+1, history=?, result=NULL WHERE id=?", String(x.task).slice(0, 2000), String(x.why || "").slice(0, 300), JSON.stringify([...it.history!, { task: it.task, result: it.result }]), it.id);
    did.push(`sent ${x.key} back: ${x.why || "no reason given"}`);
  }
  // Cancelling a running item stops its run; marked cancelled first so its ending doesn't wake the Chief as a result.
  for (const k of a.cancel || []) {
    const it = byKey.get(String(k));
    if (!it?.status || ["done", "cancelled"].includes(it.status)) continue;
    run("UPDATE plan_items SET status='cancelled', ended_at=? WHERE id=?", now(), it.id);
    if (it.status === "doing" && it.to_thread) interrupt(it.to_thread).catch(() => {});
    did.push(`cancelled ${k}`);
  }
  if (a.finish) {
    const checks = (a.finish.constraints || []).map((c) => ({ text: String(c.text || "").slice(0, 300), status: ["met", "unmet", "untested"].includes(c.status) ? c.status : "untested", note: String(c.note || "").slice(0, 300) }));
    const missing = p.constraints.filter((c) => !checks.some((k) => k.text.trim().toLowerCase() === c.trim().toLowerCase()));
    if (missing.length) return say(`Not finished: mark every constraint, word for word. Missing: ${missing.join(" | ")}`, false);
    if (planItems(p.id).some((i) => i.status === "doing")) return say("Not finished: items are still running. Cancel them (that stops them) or wait.", false);
    if (!p.swept) { planLog(p.id, "Chief wants to finish; asking members for alternatives first"); sweep(p); return say("Not finished yet: before any plan finishes, Pitcrew asks each member who contributed whether they know an alternative that would better meet the constraints. You'll be woken with what they say. End this turn now."); }
    run("UPDATE plan_items SET status='cancelled' WHERE plan_id=? AND status='todo'", p.id);
    run("UPDATE plans SET status='done', answer=?, checks=?, ended_at=? WHERE id=?", String(a.finish.answer).slice(0, 4000), JSON.stringify(checks), now(), p.id);
    planLog(p.id, "Chief finished the plan");
    audit(chief.id, "plan.finished", { id: p.id, spend: planSpend(p).usd });
    emitPlan(planRow(p.id)!);
    return say("Plan finished. Now tell the driver the answer in plain words, saying which constraints were met, unmet or untested and anything that rests on an assumption.");
  }
  if (did.length) planLog(p.id, `${after ? `After ${after}: ` : ""}${did.join("; ")}`);
  emitPlan(planRow(p.id)!);
  dispatchPlan(p.id);
  return say(`${errs.length ? `Not applied:\n- ${errs.join("\n- ")}\n\n` : ""}Todo now:\n${planText(planRow(p.id)!)}\n\nPitcrew runs ready items and wakes you after each one ends. End this turn now unless you have more to change.`, !errs.length || errs.length < (a.add || []).length + (a.reopen || []).length);
}
