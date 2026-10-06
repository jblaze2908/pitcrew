// Done-check: when a run whose member named its done criteria (set_done_criteria) finishes, Pitcrew checks only those.
// A criterion with a check runs that read-only command on the member's computer and passes or fails on its output, no
// model; one without is judged by a second model from the screenshot, last page and files. No criteria, no check.
// Fail → the member goes back once with what failed; still failing → a quiet "Not confirmed" note, never a pit stop.
// Scheduled runs are checked only when their schedule's grade flag is on. Cost per checked run, after finishTurn and
// off its path: ≤6 docker execs (20 s cap each), one gate classification per check (rules, else one jev call), and at
// most one model ask, only when some criterion has no check. No grader → those criteria are "not checked".
import { readFileSync } from "node:fs";
import { one, all, run, now, json, getSetting, audit } from "../db.js";
import { getSecret } from "../auth.js";
import { getBot } from "../crew.js";
import { openPlanSide, ROOT } from "../computer.js";
import { jev, redact, type Verdict } from "../jev.js";
import { objectText, type Change } from "../snapshot.js";
import type { CheckCriterion, DoneCriterion } from "../../shared/types.js";
import type { PitstopRow } from "../models.js";
import { active } from "./state.js";
import { addEvent, getThread, setThreadStatus } from "./threads.js";
import { enqueue } from "./queue.js";
import { jevContext, withScript } from "./gate.js";

export const CRITERIA_MAX = 6, MAX_RETRIES = 1, CHECK_MS = 20000;
const NOT_GRADED = new Set(["retro", "delegation", "plan"]);
const OUT_MAX = 1500;

const tidy = (x: unknown) => String(x ?? "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
/** The member's criteria as a clean list of {text, check?, expect?}, or why they can't be used. Bare strings are texts. */
export function normCriteria(v: unknown): DoneCriterion[] | string {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [];
  const list = raw.map((x): Record<string, unknown> => (x && typeof x === "object" ? x : { text: x }))
    .map((x) => ({ text: tidy(x.text), check: String(x.check ?? "").trim(), expect: String(x.expect ?? "").trim() })).filter((c) => c.text);
  if (!list.length) return "Give 1 to 6 criteria: checkable facts about the finished result, each with a read-only check command where you can.";
  if (list.length > CRITERIA_MAX) return `At most ${CRITERIA_MAX} criteria: keep the ones that prove the task is done.`;
  if (list.some((c) => c.text.length > 200)) return "Each criterion's text is one short checkable fact, under 200 characters.";
  if (list.some((c) => c.check.length > 500 || /[\r\n]/.test(c.check))) return "Each check is one shell command on one line, under 500 characters.";
  if (list.some((c) => c.expect && !c.check)) return "expect goes with a check: it says what the check's output must show.";
  if (list.some((c) => c.expect.length > 120)) return "Keep expect short: text the output must contain, or a number test like >=6.";
  return list.map((c) => ({ text: c.text, ...(c.check ? { check: c.check } : {}), ...(c.expect ? { expect: c.expect } : {}) }));
}
// Rows from before checks stored plain strings.
const criteriaOf = (t: { criteria: string | null }): DoneCriterion[] => json<unknown[]>(t.criteria, []).map((c) => (typeof c === "string" ? { text: c } : c as DoneCriterion)).filter((c) => c?.text);

/** set_done_criteria: fixed for the task once set, so a retry can't move the goalposts. */
export function setDoneCriteria(threadId: string, raw: unknown) {
  const a = active.get(threadId);
  if (!a) return { ok: false, text: "No run in progress." };
  const t = one<{ trigger: string }>("SELECT trigger FROM turns WHERE id=?", a.turnId);
  if (t?.trigger === "check") return { ok: false, text: "This task's criteria are already set; fix what the check found instead." };
  const c = normCriteria(raw);
  if (typeof c === "string") return { ok: false, text: c };
  run("UPDATE turns SET criteria=? WHERE id=?", JSON.stringify(c), a.turnId);
  const n = c.filter((x) => x.check).length;
  return { ok: true, text: `Noted ${c.length} criteria${n ? `, ${n} with a check` : ""}. When you finish, Pitcrew runs each check on your computer${n < c.length ? "; the rest are judged from the screenshot, last page and files you changed" : ""}. Nothing to prepare for it.` };
}

// ---------- checks ----------
export interface CheckRun { code: number | null; out: string; err: string }
export type RunCheck = (botId: string, cmd: string) => Promise<CheckRun>;
export type Classify = (botId: string, threadId: string, cmd: string) => Promise<Verdict>;

/** The gate's verdict on a check as if the member ran it: same rules, script reading, policy and house rules (gate.ts). */
export async function classifyCheck(botId: string, threadId: string, cmd: string): Promise<Verdict> {
  const b = getBot(botId);
  if (!b) return { decision: "ask", effect: "unknown", reason: "member gone", by: "donecheck" };
  return jev(withScript(botId, { kind: "shell", command: cmd, cwd: "/bot/work" }), { policy: b.policy, apiKey: getSecret("openrouter") || "missing", context: () => jevContext(threadId, b.house_rules) });
}
// Lazy import: machines.ts → turns.ts → this module.
const runOnComputer: RunCheck = async (botId, cmd) => {
  const b = getBot(botId);
  if (!b) return { code: null, out: "", err: "member gone" };
  return (await import("./machines.js")).computer(b).probe(cmd, CHECK_MS);
};

const NUM = /^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/;
/** Whether a check's stdout meets expect: a number test on the last line's leading number, else a substring. */
export function meets(out: string, expect = "") {
  if (!expect) return true;
  const m = NUM.exec(expect.trim()), s = out.trim();
  if (!m) return s.includes(expect);
  const lead = /^-?\d+(?:\.\d+)?/.exec(s.split("\n").pop()!.trim());
  if (!lead) return false;
  const n = Number(lead[0]), k = Number(m[2]);
  return m[1] === ">=" ? n >= k : m[1] === "<=" ? n <= k : m[1] === ">" ? n > k : m[1] === "<" ? n < k : n === k;
}
const line = (s: string) => s.trim().split("\n").pop()!.trim().slice(0, 80);

/** One check: only if the gate would run it without a pit stop as a read-only command, and never while paused. */
async function checkOne(c: DoneCriterion, botId: string, threadId: string, runCheck: RunCheck, classify: Classify): Promise<CheckCriterion> {
  const cmd = c.check!, no = (why: string): CheckCriterion => ({ text: c.text, check: cmd, verdict: "unknown", why: `not checked: ${why}` });
  if (getSetting("paused") === "1") return no("the crew is paused");
  const v = await classify(botId, threadId, cmd).catch(() => null);
  audit("jev", "donecheck.classified", { threadId, effect: v?.effect ?? "unknown", decision: v?.decision ?? "ask", by: v?.by ?? "error", command: redact(cmd).slice(0, 300) });
  if (!v || v.decision !== "allow" || v.effect !== "read" || v.forbidden) return no(v?.decision === "block" ? "the safety check blocks it" : "needs approval to run");
  let r: CheckRun;
  try { r = await runCheck(botId, cmd); } catch { return no("the computer didn't start"); }
  const out = redact(`${r.out}${r.code !== 0 && r.err.trim() ? `\n${r.err}` : ""}`).trim().slice(-OUT_MAX), base = { text: c.text, check: cmd, out };
  if (r.code === 0) return meets(r.out, c.expect) ? { ...base, verdict: "pass", why: r.out.trim() ? `output ${line(redact(r.out))}` : "exit 0" }
    : { ...base, verdict: "fail", why: `expected ${c.expect}, got ${r.out.trim() ? line(redact(r.out)) : "no output"}` };
  // timeout exits 124 (137 once it kills); 126/127: the command isn't on the computer. Neither is the work's fault.
  if (r.code === 124 || r.code === 137) return { ...no(`it took over ${CHECK_MS / 1000} s`), out };
  if (r.code === 126 || r.code === 127 || r.code == null) return { ...no("the command couldn't run there"), out };
  return { ...base, verdict: "fail", why: `exit ${r.code}${r.err.trim() ? `: ${line(redact(r.err))}` : ""}` };
}

// ---------- the grader, for criteria without a check ----------
export const GRADER_PROMPT = `You check whether an AI agent really finished a task for its owner. You did not do the work. Judge only from the evidence given, never from the agent's own claims.
Return ONLY JSON: {"criteria":[{"text":"<criterion>","verdict":"pass|fail|unknown","why":"<what in the evidence shows it, under 25 words>"}],"evidence":"<for a pass: the strongest proof, under 12 words, e.g. refund ID RF-2291 on the confirmation page>"}
Rules:
- Judge exactly the criteria given, in order, word for word. Add none.
- pass only when files, command output, page text or the screenshot show it. The agent's final message saying so is not evidence. Missing evidence is unknown, not pass; contradicting evidence is fail.`;

export interface Grade { criteria: CheckCriterion[]; evidence: string; passed: boolean }
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** The grader's reply, validated: JSON with one verdict per given criterion, in order, texts kept as given. Anything
 * else is null. Pass is computed here from the verdicts, never taken from the reply. */
export function parseGrade(raw: string, given: string[]): Grade | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ""));
  if (!m || !given.length) return null;
  let o: any; try { o = JSON.parse(m[0]); } catch { return null; }
  if (!o || !Array.isArray(o.criteria) || o.criteria.length !== given.length) return null;
  const criteria: CheckCriterion[] = [];
  for (const [i, c] of o.criteria.entries()) {
    if (!c || typeof c !== "object" || !["pass", "fail", "unknown"].includes(c.verdict)) return null;
    criteria.push({ text: given[i], verdict: c.verdict, why: clip(c.why, 300) });
  }
  return { criteria, passed: criteria.every((c) => c.verdict === "pass"), evidence: clip(o.evidence, 160) };
}

export interface Evidence { text: string; image: string | null; proof: { botId: string; file: string } | null }
type Ev = { id: number; turn_id: string | null; kind: string; data: string };
/** What the grader sees, from the store (about 14 KB at most): the request, the files the runs changed (small text files'
 * contents), their commands' output, the last page read, and the last shared screenshot as an image. */
export function gatherEvidence(threadId: string, turnIds: string[], botId: string, request: string): Evidence {
  const marks = turnIds.map(() => "?").join(",");
  const evs = all<Ev>(`SELECT id, turn_id, kind, data FROM events WHERE thread_id=? AND turn_id IN (${marks}) ORDER BY id`, threadId, ...turnIds);
  const tools = evs.filter((e) => e.kind === "tool").map((e) => json<Record<string, any>>(e.data, {}));
  const changes = new Map<string, Change>();
  for (const r of all<{ changes: string | null }>(`SELECT changes FROM turns WHERE id IN (${marks}) ORDER BY started_at`, ...turnIds)) for (const c of json<Change[]>(r.changes, [])) changes.set(c.path, c);
  const last = [...evs].reverse().find((e) => e.kind === "agent"), shot = [...evs].reverse().find((e) => e.kind === "shot");
  const parts = [`## Request\n${request.slice(0, 1500) || "(none recorded)"}`, `## The agent's final message (its claim, not evidence)\n${String(json(last?.data, {}).text || "(none)").slice(0, 2000)}`];
  if (changes.size) {
    let room = 4000;
    const lines = [...changes.values()].slice(0, 40).map((c) => {
      const body = c.status !== "deleted" && c.text && c.after && c.size <= 4000 && room > 0 ? objectText(botId, c.after) : null;
      const shown = body ? body.slice(0, Math.min(1500, room)) : null;
      if (shown) room -= shown.length;
      return `- ${c.status} ${c.path} (${c.size} B)${shown ? `\n\`\`\`\n${shown}\n\`\`\`` : ""}`;
    });
    parts.push(`## Files changed in the workspace\n${lines.join("\n")}`);
  }
  const cmds = tools.filter((t) => t.type === "commandExecution").reverse().slice(0, 8);
  if (cmds.length) parts.push(`## Commands (newest first)\n${cmds.map((c) => `$ ${String(c.input || c.title || "").slice(0, 300)}\nexit ${c.exitCode ?? "?"}\n${String(c.output || "").slice(-600)}`).join("\n\n")}`);
  const page = [...tools].reverse().find((t) => t.type === "browser" && t.output);
  if (page) parts.push(`## Last page the agent read\n${String(page.output).slice(0, 2500)}`);
  const sd = shot ? json<{ botId?: string; file?: string; caption?: string }>(shot.data, {}) : null;
  let image: string | null = null;
  if (sd?.file && /^[\w-]+\.jpg$/.test(sd.file)) { try { image = `data:image/jpeg;base64,${readFileSync(`${ROOT}/shots/${botId}/${sd.file}`).toString("base64")}`; } catch {} }
  if (image) parts.push(`## Screenshot attached: "${sd!.caption || ""}"`);
  return { text: parts.join("\n\n").slice(0, 14000), image, proof: image ? { botId, file: sd!.file! } : null };
}

export interface Grader { ask: (system: string, user: string, image: string | null) => Promise<string>; close: () => void; by: string }
/** A cheap model that isn't the member: the ChatGPT plan's side server (billed to the plan), else OpenRouter. */
export async function openGrader(): Promise<Grader | null> {
  const side = await openPlanSide().catch(() => null);
  if (side) return { ask: (s, u, img) => side.ask(s, u, { images: img ? [img] : [], timeoutMs: 90000 }), close: side.close, by: "gpt-6-luna · ChatGPT plan" };
  const key = getSecret("openrouter"), model = process.env.DONECHECK_MODEL || "deepseek/deepseek-v4.1-flash";
  if (!key) return null;
  return { by: model, close: () => {}, ask: async (s, u) => {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: ctrl.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: s }, { role: "user", content: u }] }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return String((await res.json() as any).choices?.[0]?.message?.content || "");
    } finally { clearTimeout(t); }
  } };
}

// ---------- the flow ----------
type TurnLite = { id: string; thread_id: string; bot_id: string; status: string; trigger: string; criteria: string | null; grade: string | null; started_at: number };
const TURN = "SELECT id, thread_id, bot_id, status, trigger, criteria, grade, started_at FROM turns";
export const gradeOf = (t: { grade: string | null } | undefined) => json<Record<string, any>>(t?.grade, {});
const setGrade = (id: string, g: object) => run("UPDATE turns SET grade=? WHERE id=?", JSON.stringify(g), id);
// The thread's task waiting on a retry: the newest turn whose check said "retrying".
const openRetry = (threadId: string) => one<TurnLite>(`${TURN} WHERE thread_id=? AND json_extract(grade,'$.status')='retrying' ORDER BY started_at DESC LIMIT 1`, threadId);
// The message that started a turn: the newest user event at or before its start.
const requestOf = (t: TurnLite) => String(json(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' AND ts<=? ORDER BY id DESC LIMIT 1", t.thread_id, t.started_at)?.data, {}).text || "");
// A schedule's run thread carries its schedule in origin (schedules.ts start).
const scheduleGrades = (threadId: string) => {
  const o = json<{ kind?: string; scheduleId?: string }>(getThread(threadId)?.origin, {});
  return o.kind === "schedule" && one<{ grade: number }>("SELECT grade FROM schedules WHERE id=?", String(o.scheduleId || ""))?.grade === 1;
};

const VERDICT_SAID = { pass: "passed", fail: "failed", unknown: "not checked" } as const;
export function retryPrompt(criteria: CheckCriterion[]) {
  return ["[Done-check] Pitcrew checked this task's criteria and it isn't done yet:",
    ...criteria.map((c) => `- ${VERDICT_SAID[c.verdict] || "not checked"}: ${c.text}${c.why ? ` (${c.why})` : ""}${c.verdict === "fail" && c.check ? `\n  check: ${c.check}${c.out ? `\n  output (end): ${c.out.slice(-600)}` : ""}` : ""}`),
    "Fix what failed, then finish: the same checks run again, once. Don't write files just for the check. If it can't be done, say plainly what's blocking it."].join("\n");
}

const startQueued = (threadId: string) => import("./turns.js").then((T) => T.startQueued(threadId)).catch(() => false);

/** Criteria without a check, judged by the grader from the evidence; null verdicts when there's no grader or no answer. */
async function gradeRest(threadId: string, root: TurnLite, t: TurnLite, texts: string[], grader: () => Promise<Grader | null>) {
  const g = await grader().catch(() => null);
  if (!g) return { verdicts: null, why: "no grader (the ChatGPT plan or an OpenRouter key)", by: "", evidence: "", proof: null };
  const chain = root.id === t.id ? [t.id] : [root.id, ...all<{ id: string }>("SELECT id FROM turns WHERE thread_id=? AND trigger='check' AND started_at>? ORDER BY started_at", threadId, root.started_at).map((r) => r.id)];
  const ev = gatherEvidence(threadId, chain, t.bot_id, requestOf(root));
  let grade: Grade | null = null, err = "";
  try { for (let i = 0; i < 2 && !grade; i++) grade = parseGrade(await g.ask(GRADER_PROMPT, `## Criteria\n${texts.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n${ev.text}`, ev.image), texts); }
  catch (e: any) { err = String(e.message || e).slice(0, 120); } finally { g.close(); }
  if (!grade) return { verdicts: null, why: err ? `the grader failed (${err})` : "the grader's answer wasn't usable", by: g.by, evidence: "", proof: null };
  return { verdicts: grade.criteria, why: "", by: g.by, evidence: grade.evidence, proof: ev.proof };
}

/** Checks a finished run. Returns what happened: skipped | unchecked | passed | retrying | failed. The grader, the command
 * runner and the gate's classifier are injectable for tests. Runs after finishTurn, so the thread is idle by now. */
export async function doneCheck(threadId: string, turnId: string, { grader = openGrader, runCheck = runOnComputer, classify = classifyCheck }: { grader?: () => Promise<Grader | null>; runCheck?: RunCheck; classify?: Classify } = {}) {
  const t = one<TurnLite>(`${TURN} WHERE id=?`, turnId);
  // Work asked by another member is judged by the one that asked: its answer has already gone back when this runs.
  if (!t || t.status !== "completed" || NOT_GRADED.has(t.trigger) || getSetting("donecheck", "1") !== "1") return "skipped";
  const root = t.trigger === "check" ? openRetry(threadId) : t;
  if (!root) return "skipped";
  const given = criteriaOf(root);
  if (!given.length || (root.trigger === "schedule" && !scheduleGrades(threadId))) return "skipped";
  const rg = gradeOf(root), attempt = root.id === t.id ? 0 : Number(rg.attempt) || 0;
  const results: CheckCriterion[] = [];
  // One at a time: they share the member's computer, and the kill switch is read before each.
  for (const c of given) results.push(c.check ? await checkOne(c, t.bot_id, threadId, runCheck, classify) : { text: c.text, verdict: "unknown", why: "" });
  const open = given.flatMap((c, i) => (c.check ? [] : [i]));
  let by = given.length > open.length ? "checks" : "", evidence = "", proof: Evidence["proof"] = null;
  if (open.length) {
    const r = getSetting("paused") === "1" ? { verdicts: null, why: "the crew is paused", by: "", evidence: "", proof: null } : await gradeRest(threadId, root, t, open.map((i) => given[i].text), grader);
    open.forEach((i, k) => { results[i] = r.verdicts?.[k] ?? { text: given[i].text, verdict: "unknown", why: `not checked: ${r.why}` }; });
    if (r.by) by = by ? `${by} + ${r.by}` : r.by;
    ({ evidence, proof } = r);
  }
  const fails = results.filter((c) => c.verdict === "fail"), base = { criteria: results, by, at: now(), proof, attempt };
  const close = (status: string, extra: object = {}) => {
    setGrade(t.id, { ...base, status, ...extra });
    if (root.id !== t.id) setGrade(root.id, { ...rg, status, criteria: results, in: t.id });
  };
  if (!fails.length) {
    const status = results.every((c) => c.verdict === "pass") ? "passed" : "unchecked";
    close(status, { evidence });
    addEvent(threadId, t.id, "check", { status, criteria: results, evidence, n: results.length, proof, attempt, by });
    return status;
  }
  const headline = `${fails[0].text}${fails[0].why ? ` · ${fails[0].why}` : ""}`;
  if (root.id !== t.id) setGrade(t.id, { ...base, status: "failed" });
  if (attempt < MAX_RETRIES) {
    setGrade(root.id, { ...(root.id === t.id ? base : rg), status: "retrying", attempt: attempt + 1, criteria: results });
    addEvent(threadId, t.id, "check", { status: "retrying", attempt: attempt + 1, of: MAX_RETRIES, headline, criteria: results });
    enqueue(threadId, { text: retryPrompt(results), attachments: [], trigger: "check", display: `Done-check · not confirmed: ${fails[0].text}` });
    await startQueued(threadId);
    return "retrying";
  }
  // Not a pit stop: nothing waits on the driver. The note offers Send back (sendBack) and the outputs.
  setGrade(root.id, { ...(root.id === t.id ? base : rg), status: "failed", criteria: results, headline });
  audit("system", "donecheck.failed", { threadId, turnId: t.id, root: root.id, attempts: attempt });
  addEvent(threadId, t.id, "check", { status: "failed", root: root.id, headline, criteria: results, attempt, by, proof });
  return "failed";
}

/** The driver's "Send back" on a "Not confirmed" note: one more try with what failed; a fail after it is a note again. */
export function sendBack(turnId: string) {
  const root = one<TurnLite>(`${TURN} WHERE id=?`, turnId), g = gradeOf(root);
  if (!root || g.status !== "failed") return { ok: false, text: root ? "Already sent back, or it passed since." : "No such run." };
  setGrade(root.id, { ...g, status: "retrying", attempt: MAX_RETRIES, sentBackAt: now() });
  enqueue(root.thread_id, { text: retryPrompt(g.criteria || []), attachments: [], trigger: "check", display: "Done-check · sent back" });
  audit("driver", "donecheck.sent_back", { threadId: root.thread_id, turnId });
  void startQueued(root.thread_id);
  return { ok: true, text: "Sent back" };
}

/** The driver's answer to an older "Couldn't confirm" pit stop (they're no longer opened): Accept as is (approve once)
 * or Try again (approve, scope retry). */
export function applyCheckDecision(ps: PitstopRow, status: string, scope: string) {
  const d = json<Record<string, any>>(ps.detail, {}), root = one<TurnLite>(`${TURN} WHERE id=?`, String(d.root || ""));
  if (root && status === "approved" && scope === "retry" && ps.thread_id) {
    const g = gradeOf(root);
    setGrade(root.id, { ...g, status: "retrying", attempt: MAX_RETRIES });
    enqueue(ps.thread_id, { text: retryPrompt(g.criteria || d.criteria || []), attachments: [], trigger: "check", display: "Done-check · trying again" });
    startQueued(ps.thread_id);
  } else if (root && status === "approved") {
    setGrade(root.id, { ...gradeOf(root), status: "accepted", acceptedAt: now() });
    if (ps.thread_id) addEvent(ps.thread_id, null, "system", { text: "Accepted as is: the run counts as done without the check." });
  }
  if (ps.thread_id && !active.has(ps.thread_id) && getThread(ps.thread_id)?.status === "needs") setThreadStatus(ps.thread_id, "idle");
}
