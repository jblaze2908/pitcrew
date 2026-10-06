// Done-check: when a run that set success criteria (set_done_criteria), or did work, finishes, a separate model grades it
// against evidence Pitcrew gathered (files, command output, the last page, a shared screenshot), never the member's own
// word. Pass → "Checked". Not confirmed → the member hears why and tries again (MAX_RETRIES); still not → a pit stop.
// Per graded run, after finishTurn and off its path: ~8 indexed reads, one side ask (ChatGPT plan, else OpenRouter);
// chat-only runs without criteria are never graded. No grader → "unchecked"; nothing ever waits on it.
import { readFileSync } from "node:fs";
import { one, all, run, now, json, getSetting, audit } from "../db.js";
import { getSecret } from "../auth.js";
import { openPlanSide, ROOT } from "../computer.js";
import { objectText, type Change } from "../snapshot.js";
import type { CheckCriterion } from "../../shared/types.js";
import type { PitstopRow } from "../models.js";
import { active } from "./state.js";
import { addEvent, getThread, setThreadStatus } from "./threads.js";
import { enqueue } from "./queue.js";
import { pitStop } from "./pitstops.js";

export const CRITERIA_MAX = 6, MAX_RETRIES = 2;
const NOT_GRADED = new Set(["retro", "delegation", "plan"]);
// Lookups (reading commands, MCP reads, opening pages) aren't graded unless the member set criteria: a grader sees only
// clipped output, so it can't confirm an answer and sent members round in circles. Changes are graded.
const BROWSER_ACTS = /^(click|type|fill form|select option|press key|file upload|drag|run code unsafe|evaluate|handle dialog|replay request)\b/;
const changedSomething = (t: Record<string, any>) => t.type === "fileChange" || t.type === "computer" || (t.type === "browser" && BROWSER_ACTS.test(String(t.title || "")));

/** The member's criteria as a clean list, or why they can't be used. */
export function normCriteria(v: unknown): string[] | string {
  const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((x) => String(x ?? "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!list.length) return "Give 1 to 6 criteria: checkable facts about the finished result.";
  if (list.length > CRITERIA_MAX) return `At most ${CRITERIA_MAX} criteria: keep the ones that prove the task is done.`;
  if (list.some((x) => x.length > 200)) return "Each criterion is one short checkable fact, under 200 characters.";
  return list;
}

/** set_done_criteria: fixed for the task once set, so a retry can't move the goalposts. */
export function setDoneCriteria(threadId: string, raw: unknown) {
  const a = active.get(threadId);
  if (!a) return { ok: false, text: "No run in progress." };
  const t = one<{ trigger: string; criteria: string | null }>("SELECT trigger, criteria FROM turns WHERE id=?", a.turnId);
  if (t?.trigger === "check") return { ok: false, text: "This task's criteria are already set; fix what the check found instead." };
  const c = normCriteria(raw);
  if (typeof c === "string") return { ok: false, text: c };
  run("UPDATE turns SET criteria=? WHERE id=?", JSON.stringify(c), a.turnId);
  return { ok: true, text: `Noted ${c.length} criteria. When you finish, a separate grader checks them against files, page text and command output, not your summary, so leave evidence it can read.` };
}

export const GRADER_PROMPT = `You check whether an AI agent really finished a task for its owner. You did not do the work. Judge only from the evidence given, never from the agent's own claims.
Return ONLY JSON: {"criteria":[{"text":"<criterion>","verdict":"pass|fail|unknown","why":"<what in the evidence shows it, under 25 words>"}],"evidence":"<for a pass: the strongest proof, under 12 words, e.g. refund ID RF-2291 on the confirmation page>","headline":"<if anything isn't a pass: what couldn't be confirmed, worded to follow 'Couldn't confirm', under 14 words>","fix":"<one sentence: what would fix it, or empty>"}
Rules:
- Judge each given criterion, in order, word for word. If they miss something the request plainly asked for, add it (at most 2 more).
- No criteria given: first write 1 to 4 checkable criteria from the request, then judge them.
- pass only when files, command output, page text or the screenshot show it. The agent's final message saying so is not evidence. Missing evidence is unknown, not pass; contradicting evidence is fail.`;

export interface Grade { criteria: CheckCriterion[]; evidence: string; headline: string; fix: string; passed: boolean }
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** The grader's reply, validated: JSON with one verdict per given criterion (in order, texts kept as given) plus at most
 * 2 it added. Anything else is null. Pass is computed here from the verdicts, never taken from the reply. */
export function parseGrade(raw: string, given: string[]): Grade | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ""));
  if (!m) return null;
  let o: any; try { o = JSON.parse(m[0]); } catch { return null; }
  if (!o || !Array.isArray(o.criteria)) return null;
  const max = given.length ? given.length + 2 : 4;
  if (o.criteria.length < Math.max(1, given.length) || o.criteria.length > max) return null;
  const criteria: CheckCriterion[] = [];
  for (const [i, c] of o.criteria.entries()) {
    if (!c || typeof c !== "object" || !["pass", "fail", "unknown"].includes(c.verdict)) return null;
    const text = i < given.length ? given[i] : clip(c.text, 200);
    if (!text) return null;
    criteria.push({ text, verdict: c.verdict, why: clip(c.why, 300) });
  }
  const passed = criteria.every((c) => c.verdict === "pass"), miss = criteria.find((c) => c.verdict !== "pass");
  return { criteria, passed, evidence: clip(o.evidence, 160), fix: clip(o.fix, 240), headline: passed ? "" : clip(String(o.headline || "").replace(/^couldn'?t confirm:?\s*/i, ""), 140) || miss!.text };
}

// ---------- evidence ----------
export interface Evidence { text: string; image: string | null; proof: { botId: string; file: string } | null; worked: boolean }
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
  return { text: parts.join("\n\n").slice(0, 14000), image, proof: image ? { botId, file: sd!.file! } : null, worked: changes.size > 0 || tools.some(changedSomething) };
}

// ---------- the grader ----------
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

export function retryPrompt(g: Pick<Grade, "criteria" | "fix" | "headline">, attempt: number) {
  return [`[Done-check] A separate grader couldn't confirm this task is done (try ${attempt} of ${MAX_RETRIES}): ${g.headline}.`,
    ...g.criteria.map((c) => `- ${c.verdict === "pass" ? "confirmed" : c.verdict === "fail" ? "failed" : "no evidence"}: ${c.text}${c.why ? ` (${c.why})` : ""}`),
    g.fix ? `Suggested fix: ${g.fix}` : "",
    "Fix what's missing, then leave evidence the grader can read: the file, command output that shows the result, or the confirmation page. If it can't be done, say plainly what's blocking it."].filter(Boolean).join("\n");
}

const startQueued = (threadId: string) => import("./turns.js").then((T) => T.startQueued(threadId)).catch(() => false);

/** Grades a finished run. Returns what happened: skipped | unchecked | passed | retrying | failed. grader is injectable
 * for tests. Runs after finishTurn (turns.ts), so the thread is already idle and its queue moving. */
export async function doneCheck(threadId: string, turnId: string, { grader = openGrader }: { grader?: () => Promise<Grader | null> } = {}) {
  const t = one<TurnLite>(`${TURN} WHERE id=?`, turnId);
  // Work asked by another member is judged by the one that asked: its answer has already gone back when this runs.
  if (!t || t.status !== "completed" || NOT_GRADED.has(t.trigger) || getSetting("donecheck", "1") !== "1") return "skipped";
  const root = t.trigger === "check" ? openRetry(threadId) : t;
  if (!root) return "skipped";
  const rg = gradeOf(root), given = json<string[]>(root.criteria, []);
  const chain = root.id === t.id ? [t.id] : [root.id, ...all<{ id: string }>("SELECT id FROM turns WHERE thread_id=? AND trigger='check' AND started_at>? ORDER BY started_at", threadId, root.started_at).map((r) => r.id)];
  const ev = gatherEvidence(threadId, chain, t.bot_id, requestOf(root));
  // A scheduled run that found nothing, or a chat-only run without criteria, has nothing to check.
  const said = String(json(one<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND turn_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", threadId, t.id)?.data, {}).text || "");
  if (!given.length && (!ev.worked || /^\s*QUIET\b/.test(said))) return "skipped";
  const unchecked = (why: string) => {
    setGrade(t.id, { status: "unchecked", why, at: now() });
    if (given.length) addEvent(threadId, t.id, "check", { status: "unchecked", why });
    return "unchecked";
  };
  const g = await grader().catch(() => null);
  if (!g) return unchecked("no grader: the ChatGPT plan or an OpenRouter key is needed");
  let grade: Grade | null = null, err = "";
  try { for (let i = 0; i < 2 && !grade; i++) grade = parseGrade(await g.ask(GRADER_PROMPT, `## Criteria\n${given.length ? given.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(none given: write them from the request)"}\n\n${ev.text}`, ev.image), given); }
  catch (e: any) { err = String(e.message || e).slice(0, 120); } finally { g.close(); }
  if (!grade) return unchecked(err ? `the grader failed: ${err}` : "the grader's reply wasn't valid");
  // Criteria the grader wrote stay the task's criteria, so every retry is judged against the same list.
  if (!given.length) run("UPDATE turns SET criteria=? WHERE id=?", JSON.stringify(grade.criteria.map((c) => c.text)), root.id);
  const attempt = root.id === t.id ? 0 : Number(rg.attempt) || 0, base = { criteria: grade.criteria, by: g.by, at: now(), proof: ev.proof, attempt };
  if (grade.passed) {
    setGrade(t.id, { ...base, status: "passed", evidence: grade.evidence });
    if (root.id !== t.id) setGrade(root.id, { ...rg, status: "passed", passedIn: t.id });
    addEvent(threadId, t.id, "check", { status: "passed", evidence: grade.evidence, n: grade.criteria.length, proof: ev.proof, attempt, by: g.by });
    return "passed";
  }
  if (root.id !== t.id) setGrade(t.id, { ...base, status: "failed", headline: grade.headline });
  if (attempt < MAX_RETRIES) {
    const next = attempt + 1;
    setGrade(root.id, { ...(root.id === t.id ? base : rg), status: "retrying", attempt: next, headline: grade.headline, criteria: grade.criteria, fix: grade.fix });
    addEvent(threadId, t.id, "check", { status: "retrying", attempt: next, of: MAX_RETRIES, headline: grade.headline, criteria: grade.criteria });
    enqueue(threadId, { text: retryPrompt(grade, next), attachments: [], trigger: "check", display: `Done-check · couldn't confirm ${grade.headline}` });
    await startQueued(threadId);
    return "retrying";
  }
  setGrade(root.id, { ...(root.id === t.id ? base : rg), status: "failed", headline: grade.headline, criteria: grade.criteria, fix: grade.fix });
  audit("system", "donecheck.failed", { threadId, turnId: t.id, root: root.id, attempts: attempt });
  // Not awaited: the driver may take days. Its decision lands in applyCheckDecision (pitstops.ts decide).
  void pitStop({ botId: t.bot_id, threadId, kind: "check", effect: "check", title: `Couldn't confirm ${String(grade.headline || "").replace(/^couldn'?t confirm:?\s*/i, "")}`,
    detail: { criteria: grade.criteria, fix: grade.fix, attempts: attempt, turnId: t.id, root: root.id, proof: ev.proof }, expiresMin: 7 * 24 * 60 });
  return "failed";
}

/** The driver's answer to a "Couldn't confirm" pit stop: Accept as is (approve once) or Try again (approve, scope retry). */
export function applyCheckDecision(ps: PitstopRow, status: string, scope: string) {
  const d = json<Record<string, any>>(ps.detail, {}), root = one<TurnLite>(`${TURN} WHERE id=?`, String(d.root || ""));
  if (root && status === "approved" && scope === "retry" && ps.thread_id) {
    // One more try: a failure after it comes straight back here.
    const g = gradeOf(root);
    setGrade(root.id, { ...g, status: "retrying", attempt: MAX_RETRIES });
    enqueue(ps.thread_id, { text: retryPrompt({ criteria: g.criteria || d.criteria || [], fix: g.fix || d.fix || "", headline: g.headline || ps.title.replace(/^Couldn't confirm /, "") }, MAX_RETRIES), attachments: [], trigger: "check", display: "Done-check · trying again" });
    startQueued(ps.thread_id);
  } else if (root && status === "approved") {
    setGrade(root.id, { ...gradeOf(root), status: "accepted", acceptedAt: now() });
    if (ps.thread_id) addEvent(ps.thread_id, null, "system", { text: "Accepted as is: the run counts as done without the check." });
  }
  if (ps.thread_id && !active.has(ps.thread_id) && getThread(ps.thread_id)?.status === "needs") setThreadStatus(ps.thread_id, "idle");
}
