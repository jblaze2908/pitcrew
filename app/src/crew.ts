// Crew members: the Crew Chief is built in; everyone else is hired through a HIRE pit stop.
// Personality is voice only: it never touches permissions, caps or jev.
import { one, all, run, now, uid, json, getSetting, setSetting, audit, driverName } from "./db.js";
import { DEFAULT_POLICY } from "./jev.js";
import { DEFAULT_MODEL } from "./providers.js";
import type { Bot, EngramScope, Hue, Shape, Personality, ProviderId } from "../shared/types.js";
import type { BotRow } from "./models.js";
import { FILES_URL, TOPICS } from "./manual.js";
import { httpErr } from "./auth.js";

export const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
/** A colour no active member wears yet, else the least worn; ties go to palette order. One query per hire. */
export function freeHue(prefer?: string | null): Hue {
  const worn = new Map<string, number>(all<{ hue: string; n: number }>("SELECT hue, COUNT(*) n FROM bots WHERE archived=0 GROUP BY hue").map((r) => [r.hue, r.n]));
  if (prefer && HUES.includes(prefer as Hue) && !worn.get(prefer)) return prefer as Hue;
  return [...HUES].sort((a, b) => (worn.get(a) || 0) - (worn.get(b) || 0))[0];
}
// The computer's loopback-only, read-only view of /bot/work (computer/files.mjs, started by desktop.sh).
export { FILES_URL } from "./manual.js";
export const SHAPES: Shape[] = ["square", "round", "blob"];
export const ENGRAM_SCOPES: EngramScope[] = ["personal", "finance", "health"];
const CONN_ID = /^[a-z0-9][a-z0-9-]{0,11}$/;
// New crew members start with read/draft allowed; sign-in, pay and send ask first; delete and share always ask.
export const STARTING_POLICY = { ...DEFAULT_POLICY };

const row = (b: BotRow | undefined): Bot | undefined => b && ({ ...b, personality: json(b.personality, {}), policy: { ...STARTING_POLICY, ...json(b.policy, {}) }, mcp: json(b.mcp, []), archived: !!b.archived, private: !!b.private, engram_scope: ENGRAM_SCOPES.includes(b.engram_scope as EngramScope) ? b.engram_scope : "personal", engram_household: !!b.engram_household, house_rules: b.house_rules || "", soul: b.soul || "" } as Bot);
export const getBot = (id: string | null | undefined) => row(one<BotRow>("SELECT * FROM bots WHERE id=?", id));
export const listBots = () => all<BotRow>("SELECT * FROM bots WHERE archived=0 ORDER BY kind='chief' DESC, created_at").map(row) as Bot[];

export function ensureChief() {
  if (one("SELECT 1 FROM bots WHERE kind='chief'")) return;
  const provider = getSetting("default_provider", "openrouter");
  run(`INSERT INTO bots(id,name,job,kind,hue,shape,personality,provider,model,weekly_cap_usd,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    "chief", "Crew Chief", "Takes any task, runs a thread for each, and proposes new crew members when work keeps coming back.", "chief", "c1", "square",
    JSON.stringify({ role: "Calm race engineer. Short sentences, facts first.", warmth: 3, talk: 2, humour: 1, quirks: ["Says what changed before what's next"], signoff: "", callMe: "" }),
    provider, DEFAULT_MODEL[provider as ProviderId], 20, "{}", now());
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), "chief", "Crew Chief", 1, now(), now());
}

const clamp = (n: any, lo: number, hi: number, d: number) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);
const text = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

// Normalises a proposal or a manual hire form into a crew-member record. Authority comes from STARTING_POLICY, never from the proposal.
// A hire as proposed or typed in; any field may be missing or the wrong type.
export type HireSpec = Record<string, any>;
export interface Spec {
  name: string; job: string; hue: Hue; shape: Shape; personality: Personality; provider: ProviderId; model: string;
  weekly_cap_usd: number; schedule: { spec: string; prompt: string } | null; reason: string;
  // Engram: where its memories live, and the connections it may read (granted once, when its Engram agent is made).
  engram_scope: EngramScope; engram_connections: string[]; engram_household: boolean;
}
export function normaliseSpec(s: HireSpec = {}): Spec {
  const provider = (["openrouter", "aigateway", "openai"].includes(s.provider) ? s.provider : getSetting("default_provider", "openrouter")) as ProviderId;
  const p = s.personality || {};
  return {
    name: text(s.name, 40) || "New crew member",
    job: text(s.job, 400),
    hue: HUES.includes(s.hue) ? s.hue : HUES[Math.floor(Math.random() * HUES.length)],
    shape: SHAPES.includes(s.shape) ? s.shape : "square",
    personality: {
      role: text(p.role, 160), warmth: clamp(p.warmth, 1, 5, 3), talk: clamp(p.talk, 1, 5, 3), humour: clamp(p.humour, 1, 5, 2),
      quirks: (Array.isArray(p.quirks) ? p.quirks : []).map((q: unknown) => text(q, 120)).filter(Boolean).slice(0, 3),
      signoff: text(p.signoff, 60), callMe: text(p.callMe, 40), plain: !!p.plain,
    },
    provider, model: text(s.model, 120) || DEFAULT_MODEL[provider],
    weekly_cap_usd: Math.min(500, Math.max(0, Number.isFinite(+s.weekly_cap_usd) ? +s.weekly_cap_usd : 5)),
    schedule: s.schedule && typeof s.schedule === "object" ? { spec: text(s.schedule.spec, 60), prompt: text(s.schedule.prompt, 1000) } : null,
    reason: text(s.reason, 600),
    engram_scope: ENGRAM_SCOPES.includes(s.engram_scope) ? s.engram_scope : "personal",
    engram_household: s.engram_household === true,
    engram_connections: (Array.isArray(s.engram_connections) ? s.engram_connections : []).filter((c: unknown) => typeof c === "string" && CONN_ID.test(c)).slice(0, 20),
  };
}

export function createBot(spec: Spec) {
  const base = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "crew";
  let id = base, i = 2;
  while (one("SELECT 1 FROM bots WHERE id=?", id)) id = `${base}-${i++}`;
  run(`INSERT INTO bots(id,name,job,kind,hue,shape,personality,provider,model,weekly_cap_usd,policy,engram_scope,engram_household,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, spec.name, spec.job, "specialist", spec.hue, spec.shape, JSON.stringify(spec.personality), spec.provider, spec.model, spec.weekly_cap_usd, "{}", spec.engram_scope, spec.engram_household ? 1 : 0, now());
  // Read by the member's first Engram link (engram.ts linkMember), then dropped.
  if (spec.engram_connections.length) setSetting(`engram_hire:${id}`, JSON.stringify(spec.engram_connections));
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), id, spec.name, 1, now(), now());
  audit("driver", "crew.hired", { id, name: spec.name, provider: spec.provider, model: spec.model });
  return getBot(id)!;
}

// Retiring hides a member and stops its schedules; its threads, memory and data stay. by: who decided (audit).
export function retireBot(id: string, by: string) {
  const b = getBot(id);
  if (!b || b.kind === "chief" || b.archived) return false;
  run("UPDATE bots SET archived=1 WHERE id=?", id); run("UPDATE schedules SET enabled=0 WHERE bot_id=?", id); audit(by, "crew.retired", { id });
  return true;
}
export function updateBot(id: string, patch: HireSpec) {
  const b = getBot(id);
  if (!b) throw httpErr(404, "No such crew member");
  const n = normaliseSpec({ ...b, ...patch, personality: { ...b.personality, ...(patch.personality || {}) } });
  const policy = { ...b.policy };
  // Policy edits may only use known effect classes and allow/ask; "always" for delete/share is refused.
  for (const [k, v] of Object.entries(patch.policy || {}) as [string, any][]) if (k in STARTING_POLICY && ["allow", "ask"].includes(v) && !(v === "allow" && ["delete", "share", "pay"].includes(k))) policy[k] = v;
  const mcp = Array.isArray(patch.mcp) ? patch.mcp.filter((m: any) => /^[a-z][a-z0-9_-]{0,31}$/.test(m.name) && /^https:\/\//.test(m.url)).slice(0, 10).map((m: any) => ({ name: m.name, url: m.url.slice(0, 500), tokenSecret: m.tokenSecret || null })) : b.mcp;
  run("UPDATE bots SET name=?,job=?,hue=?,shape=?,personality=?,provider=?,model=?,weekly_cap_usd=?,policy=?,mcp=? WHERE id=?",
    b.kind === "chief" ? b.name : n.name, n.job, n.hue, n.shape, JSON.stringify(n.personality), n.provider, n.model, n.weekly_cap_usd, JSON.stringify(policy), JSON.stringify(mcp), id);
  if (patch.private !== undefined && b.kind !== "chief") run("UPDATE bots SET private=? WHERE id=?", patch.private ? 1 : 0, id);
  if (patch.engram_scope !== undefined) run("UPDATE bots SET engram_scope=? WHERE id=?", n.engram_scope, id);
  if (patch.engram_household !== undefined) run("UPDATE bots SET engram_household=? WHERE id=?", n.engram_household ? 1 : 0, id);
  if (typeof (patch as { soul?: unknown }).soul === "string") run("UPDATE bots SET soul=? WHERE id=?", String((patch as { soul: string }).soul).slice(0, SOUL_MAX), id);
  if (typeof (patch as { house_rules?: unknown }).house_rules === "string") run("UPDATE bots SET house_rules=? WHERE id=?", String((patch as { house_rules: string }).house_rules).slice(0, 3000), id);
  audit("driver", "crew.updated", { id, fields: Object.keys(patch) });
  return getBot(id);
}

// ~150-token voice block; the plain-voice rule is repeated because it is the part that must never drift.
export function voiceBlock(b: Pick<Bot, "personality">) {
  const p: Personality = b.personality || {};
  if (p.plain || getSetting("plain_voice") === "1") return "Voice: plain and brief. No personality flourishes.";
  const dial = (n: number, lo: string, hi: string) => (n <= 2 ? lo : n >= 4 ? hi : "balanced");
  return [
    `Voice: ${p.role || "helpful crew member"}.`,
    `Warmth: ${dial(p.warmth!, "cool and matter-of-fact", "warm")}. Talk: ${dial(p.talk!, "terse", "chatty")}. Humour: ${dial(p.humour!, "none", "light, dry jokes")}.`,
    p.quirks?.length ? `Quirks: ${p.quirks.join("; ")}.` : "",
    p.callMe ? `Call the driver "${p.callMe}".` : "",
    p.signoff ? `Sign off long replies with "${p.signoff}".` : "",
    "Never joke about money, approvals, receipts or failures; state those plainly.",
  ].filter(Boolean).join(" ");
}

// What a linked member gets from Engram at thread start (engram.ts threadContext): the Chief's profile, a skills index.
export interface EngramContext { profile: string | null; skills: string }
const SCOPE_NAME = { personal: "Personal", finance: "Money (scope finance)", health: "Health (scope health)" } as const;
// How Pitcrew works, the same words for every member (and first, so the cached prefix is shared). Rules only, one line
// each; detail is in harness_help (manual.ts). Kept under 3,000 chars: it rides in every thread's instructions.
export const SOUL_MAX = 1500;
export function harnessCore(driver: string) {
  return [`How Pitcrew works (the same for every crew member):`,
    `- Computer: your own, started on demand. Shell and file edits run there; browser_* tools drive its Chromium, which keeps logins (computer_* pixel tools only when a page can't be driven otherwise). Answer from what you know when no tool is needed.`,
    `- Workspace /bot/work: out/ is what ${driver} sees (Library); skills/ is your skill library (one git repo: commit each change, never push); .scratch/ for probes and raw dumps; a task's data (its ledger) in its own folder. file:// is blocked in the browser: open workspace files at ${FILES_URL}<path>.`,
    `- Approvals: the runtime decides what waits for ${driver} (paying, sending, signing in, sharing, deleting). Don't ask yourself; act. If an action is declined, blocked or expired, don't try it another way; say what's waiting and why.`,
    `- Memory: remember(text, scope): session = this thread; agent = your own (how your job runs); global = facts about ${driver}, which they review. Never put paths or task state in global.`,
    `- Skills: before a task one of your skills covers, load it with skill_view; when you find a better way, fix the skill.`,
    `- Done: set_done_criteria only for a task that changes something (files, orders, messages), never for questions or lookups; give each criterion a read-only check command where you can. Pitcrew runs the checks when you finish.`,
    `- Bulk web reads: the site's own API first (browser_network_requests, browser_replay_request), else one browser_evaluate loop; never page-by-page clicks. A plain fetch from the shell beats the browser for public pages.`,
    `- Recurring work: data in a SQLite ledger shown by a bound surface (queries, harness_help dashboards). A "[Scheduled: …]" run replies "QUIET: <what you checked>" unless an alert fired, something failed, ${driver} must act, or the digest is due.`,
    `- Showing ${driver}: write a <Surface> inline in your reply for tables, charts, forms and controls (harness_help dashboards); share_screenshot for the screen; publish_file only when they ask for a link or file.`,
    `- Images: make or edit them with image_gen or generate_image, whichever you have; they land in out/images (harness_help images).`,
    `- In exec scripts call tools.browser_click({...}); don't print ALL_TOOLS; a screenshot comes back as a data: URL: show it with image(result).`,
    `- Details: harness_help(topic), topics ${TOPICS.join(", ")}.`].join("\n");
}
// Who this member is: the driver's SOUL for it, or one made from its job and voice until they write one.
export const soulOf = (b: Pick<Bot, "personality"> & Partial<Bot>) => (b.soul?.trim() ? b.soul.trim() : [b.job ? `Your job: ${b.job}` : "", voiceBlock(b as Bot)].filter(Boolean).join("\n"));
// skills: the member's own skill index (runtime/skills.ts skillIndex); unseen: changelog lines it hasn't read. Both are
// built at thread start, the only time instructions reach Codex.
export function instructions(b: Pick<Bot, "name" | "personality"> & Partial<Bot>, memories: { id: string; text: string }[], engram: EngramContext | null = null, skills = "", unseen = 0) {
  const driver = driverName();
  const rules = String(b.house_rules || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return [
    harnessCore(driver),
    `You are ${b.name}, a member of ${driver}'s Pitcrew: a personal crew of AI agents that get real-life admin and computer work done for ${driver}.`,
    soulOf(b),
    rules.length ? `${driver}'s house rules for you (the gate enforces them):\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
    engram ? "" : `When ${driver} tells you a durable fact or preference worth keeping, call remember.`,
    memories.length ? `Your own memory (only you see it; rewrite one by passing its id to remember, forget removes it):\n${memories.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "",
    skills ? `Your skills (load one with skill_view before a task it covers):\n${skills}` : "",
    engram ? engramBlock(driver, engram, b.engram_scope) : "",
    b.kind === "chief" ? `You are the Crew Chief, the only built-in crew member, and you manage the crew. When you notice recurring work that deserves its own crew member (the same kind of task 3+ times), call propose_crew_member. You are the workspace admin: crew_overview and member_files show how each member is set up and doing; propose_soul, propose_member_change (profile, model, budget, policy), propose_retire and delete_member_files change a member once ${driver} approves the pit stop. Propose only with evidence (runs, retros, idle weeks). triage_suggestion merges duplicate suggestions.` : "",
    b.kind === "chief" ? crewRoster(b as Bot, driver) : `The Crew Chief may ask you something on ${driver}'s behalf. Answer it fully in one reply; that reply goes back to the Chief.`,
    b.kind === "chief" && plansOn() ? planRules(driver) : "",
    unseen > 0 ? `The harness changed since you last looked (${unseen} note${unseen === 1 ? "" : "s"}): call whats_new before you start.` : "",
  ].filter(Boolean).join("\n\n");
}

// Also a /refresh turn's context (turns.ts), so a forked thread hears the same words its instructions use.
export function engramBlock(driver: string, engram: EngramContext, scope: keyof typeof SCOPE_NAME = "personal") {
  return [
    `Engram is ${driver}'s context engine; its tools are on your engram MCP server. Search it before asking ${driver} something they may already have told another agent.`,
    // What to send, so the next agent doesn't ask again. Kept short: it rides in every thread's instructions.
    [`Keep Engram current, without being asked: ${driver} should never have to tell another agent the same thing twice.`,
      `- remember with scope global: one durable fact about ${driver} per call, as a sentence another agent understands cold ("Electricity is BESCOM, account ending 4417, due on the 5th"). Save what ${driver} tells you, and what you confirm from their own accounts, bills, bookings and documents: providers, due and renewal dates, plan and policy details, preferences, people and addresses. Pass valid_until (YYYY-MM-DD) for anything that expires: a fare, an offer, a quote, a document. It waits for ${driver}'s review before other agents see it. How your own job runs (paths, scripts, site quirks) is agent memory, not global.`,
      `- If a fact changed, pass the old memory's id to remember so it is replaced, not duplicated.`,
      `- Not worth saving: what you just read from Engram, guesses or estimates, one-off chatter, and secrets (passwords, OTPs, card numbers, full account numbers).`,
      `- If a fact didn't come from ${driver}, say where it did ("per the October BESCOM bill"). Anything from an email or a web page waits for ${driver}'s review.`,
      `- engram propose: a person, account or place worth its own record (kind entity), or a how-to you worked out that will come up again (kind skill)${scope === "personal" ? "" : `, with scope ${scope}`}. Don't propose episodes: Pitcrew sends your journal itself.`,
      `- Publish only when ${driver} asks for a page, file or link, or asks to share something: write it as one file in /bot/work/out (md, html or pdf), call publish_file, then give them the link. Otherwise answer in the thread. To change it later, publish again with its id.`,
      `- Before you finish a task, check whether you learned something durable: about ${driver} → global; about doing your job → agent memory.`,
      scope === "personal" ? "" : `Your memories are filed under ${SCOPE_NAME[scope]}, which other crew members can't read.`].filter(Boolean).join("\n"),
    engram.profile ? `How ${driver} works, from Engram (their profile, compiled for you):\n${engram.profile}` : "",
    engram.skills ? `Skills in Engram. When a task matches one, load it with the engram get tool (id "skill:<name>") and follow it:\n${engram.skills}` : "",
  ].filter(Boolean).join("\n\n");
}

// Crew plans are on unless turned off in Settings; a thread keeps the tools it started with.
export const plansOn = () => getSetting("plans", "1") === "1";
// Orchestration rules. They encode what the 2026-10-01 spike got wrong: no loop-back after a result that
// changed the picture, assumptions passed on as facts, and the Chief doing members' work itself.
const planRules = (driver: string) => [`Plans: when work needs one or more crew members, call plan instead of doing it yourself.`,
  `- Put ${driver}'s preferences and limits in constraints, word for word.`,
  `- After every item, Pitcrew wakes you with its result. Ask: does this change the picture? Is a constraint still untested? If so, reopen the item that can fix it (say why) or add one. Reopen later items that depended on it too.`,
  `- Results come as answer, from-their-data, assumed and couldn't-check. Never repeat an assumption as fact; if your answer rests on one, say so.`,
  `- Don't search, browse or calculate members' work yourself. If you must do a step, add it as an item with member "Crew Chief".`,
  `- Before calling a preference unmet, ask the member who could change the outcome whether an alternative exists (cheaper, other dates, another provider). If you didn't ask, it's untested, not unmet.`,
  `- ${driver}'s messages override the plan: if they say stop something, cancel it (that stops running items).`,
  `- Answer the question as ${driver} asked it. Don't add costs or criteria they didn't mention (food, transport, fees); put those in a note, never in the verdict.`,
  `- Finish with plan.finish: the answer plus every constraint marked met, unmet or untested. Then tell ${driver} the answer in plain words.`].join("\n");

// Sent at thread start/resume only, so a hire or retire reaches the Chief at its next brain start.
function crewRoster(b: Bot, driver: string) {
  const crew = listBots().filter((x) => x.id !== b.id);
  if (!crew.length) return "";
  const how = plansOn() ? "call ask_crew_member for one quick question to one member, and put anything needing two or more members or several steps in a plan" : "call ask_crew_member and build on their answer";
  return [`Your crew. When a question or task falls in a member's job, ${how}: they work from their own memory, logins and computer. Private members talk only to ${driver}; don't ask them.`,
    ...crew.map((x) => `- ${x.name}${x.private ? " (private)" : ""}: ${x.job || "no job set"}`)].join("\n");
}
