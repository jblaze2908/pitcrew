// Crew members: the Crew Chief is built in; everyone else is hired through a HIRE pit stop.
// Personality is voice only: it never touches permissions, caps or jev.
import { one, all, run, now, uid, json, getSetting, setSetting, audit } from "./db.js";
import { DEFAULT_POLICY } from "./jev.js";
import { DEFAULT_MODEL } from "./providers.js";
import { DEFAULT_IMAGE_MODEL } from "./images.js";
import { CATALOGUE } from "./surfaces.js";
import type { Bot, EngramScope, Hue, Shape, Personality, ProviderId } from "../shared/types.js";
import type { BotRow } from "./models.js";

export const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
/** A colour no active member wears yet, else the least worn; ties go to palette order. One query per hire. */
export function freeHue(prefer?: string | null): Hue {
  const worn = new Map<string, number>(all<{ hue: string; n: number }>("SELECT hue, COUNT(*) n FROM bots WHERE archived=0 GROUP BY hue").map((r) => [r.hue, r.n]));
  if (prefer && HUES.includes(prefer as Hue) && !worn.get(prefer)) return prefer as Hue;
  return [...HUES].sort((a, b) => (worn.get(a) || 0) - (worn.get(b) || 0))[0];
}
// The computer's loopback-only, read-only view of /bot/work (computer/files.mjs, started by desktop.sh).
export { FILES_URL } from "./manual.js";
import { FILES_URL, TOPICS, HELP_TOPICS } from "./manual.js";
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
  if (!b) throw Object.assign(new Error("No such crew member"), { status: 404 });
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
    `- Done: before a task, set_done_criteria (checkable facts). A separate grader checks your evidence, not your summary, when you finish.`,
    `- Bulk web reads: the site's own API first (browser_network_requests, browser_replay_request), else one browser_evaluate loop; never page-by-page clicks. A plain fetch from the shell beats the browser for public pages.`,
    `- Recurring work: data in a SQLite ledger shown by a bound dashboard (render_surface with source and queries). A "[Scheduled: …]" run replies "QUIET: <what you checked>" unless an alert fired, something failed, ${driver} must act, or the digest is due.`,
    `- Showing ${driver}: render_surface for tables, charts and forms; share_screenshot for the screen; publish_file only when they ask for a link or file.`,
    `- Images: make or edit them with image_gen or generate_image, whichever you have; they land in out/images (harness_help images).`,
    `- In exec scripts call tools.browser_click({...}); don't print ALL_TOOLS; a screenshot comes back as a data: URL: show it with image(result).`,
    `- Details: harness_help(topic), topics ${TOPICS.join(", ")}.`].join("\n");
}
// Who this member is: the driver's SOUL for it, or one made from its job and voice until they write one.
export const soulOf = (b: Pick<Bot, "personality"> & Partial<Bot>) => (b.soul?.trim() ? b.soul.trim() : [b.job ? `Your job: ${b.job}` : "", voiceBlock(b as Bot)].filter(Boolean).join("\n"));
// skills: the member's own skill index (runtime/skills.ts skillIndex); unseen: changelog lines it hasn't read. Both are
// built at thread start, the only time instructions reach Codex.
export function instructions(b: Pick<Bot, "name" | "personality"> & Partial<Bot>, memories: { id: string; text: string }[], engram: EngramContext | null = null, skills = "", unseen = 0) {
  const driver = getSetting("driver_name", "the driver");
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

// Browser (Playwright over CDP) and pixel tools come from the computer image's own manifest, under their usual names.
// Page JS, Playwright code, network and storage are offered and gated per call (jev reads the code; see gate.ts). HIDDEN
// went unused in prod rollouts or is covered by browser_run_code_unsafe, and only cost prompt tokens (the runtime still
// uses browser_hover and browser_tabs itself).
const HIDDEN = new Set(["browser_emulate_media", "browser_resize", "browser_close", "browser_drag", "browser_cookie_clear", "browser_localstorage_clear",
  "browser_sessionstorage_clear", "browser_storage_state", "browser_set_storage_state", "computer_double_click", "computer_type"]);
// Actions whose result carries the page afterwards (see shapeSnapshot in runtime/pageText.ts).
export const SNAPSHOT_ACTIONS = /^browser_(click|type|navigate|navigate_back|press_key|select_option|fill_form|hover|handle_dialog|file_upload|drop|tabs|wait_for)$/;
const SHOT_HINT = "In an exec script it returns the image as a data: URL string: show it with image(result), never text(result).";
const DESCRIBE: Record<string, string> = {
  browser_click: "Click an element by ref from the latest snapshot. To follow a link, navigate to its URL (browser_navigate) instead of clicking it.",
  browser_type: "Type text into an editable element (textbox, textarea, contenteditable) by ref. Not for canvas or pixel-drawn editors; use computer_* there. submit presses Enter after.",
  browser_fill_form: "Fill several form fields in one call: text inputs, checkboxes, radios, selects and sliders. Use it for radios and checkboxes too, instead of clicking each.",
  browser_file_upload: "Pick files in a file chooser that is already open. First click the page's upload control; the result's Modal state then shows a file chooser. Then pass absolute paths (under /bot/work). Omit paths to cancel the chooser.",
  browser_take_screenshot: `Screenshot of the current page (JPEG unless you pass type). Use it only when layout or visuals matter; read with browser_snapshot or browser_read. ${SHOT_HINT}`,
  browser_snapshot: "Accessibility snapshot of the current page, with refs to act on. Over 12 KB it is truncated: scope it with target (a ref) or depth, or search it with browser_find.",
  browser_evaluate: "Run JavaScript in the page and get its return value as JSON. function is () => { ... } (async allowed), or (element) => { ... } with target. Use it to read in bulk: map over the DOM, or fetch the site's own API (the page's login applies). Filter inside the function so only what you need comes back; over 24 KB the result is cut, so pass filename (a path under /bot/work) for big results and read the file from the shell. Each call is checked for its real effect: code that orders, pays, posts or sends waits for the driver.",
  browser_run_code_unsafe: "Run a Playwright function on your computer's browser controller, for what browser_evaluate can't do: capture network responses (page.waitForResponse), drive several steps in one call, read cookies (page.context().cookies()), or open a CDP session (page.context().newCDPSession(page)). code is async (page) => { ... return value; }; pass it inline. Return a small JSON value; over 24 KB the result is cut. Checked like browser_evaluate.",
  browser_network_requests: "List the page's network requests since it loaded (static assets left out unless static is true). filter is a URL regexp, e.g. \"/api/|graphql\". Then read one with browser_network_request. The fastest way to bulk data: the site's own API responses.",
  browser_network_request: "Headers and body of one request from browser_network_requests, by its number; part narrows it to one section (response-body is usually what you want). Auth and cookie header values are masked. Over 24 KB the result is cut, so pass filename (a path under /bot/work) for big bodies and parse the file from the shell.",
};
const FIELD_TYPE = "Kind of control, not its HTML type: textbox for any text, email, password or number input and textareas; checkbox; radio; combobox for a select/dropdown (value = the option's text); slider. checkbox and radio values are \"true\" or \"false\".";
const SNAPSHOT_ARG = { type: "string", enum: ["diff", "full", "none"], description: "What the result shows of the page afterwards: diff (default: what changed since your last snapshot; full on a new page), full, or none." };
const PIXEL = "pixel control of the computer's screen; the result includes a screenshot of the screen after the action, so don't take another";
// One tool from an MCP server's tools/list, as the computer image reports it.
export interface McpTool { name: string; description?: string; inputSchema?: Record<string, any> }
export interface ToolManifest { browser: McpTool[]; computer: McpTool[]; image?: string; caps?: string; execInfo?: unknown }
// Upstream schemas repeat the same long boilerplate on most tools; it's paid on every turn, so it's shortened here. The
// meaning is unchanged; only the wording of these common fields and the $schema URL go.
const SHORT_PROP: Record<string, string> = { target: "Ref from the latest snapshot (or a unique selector)", element: "What the element is, in words",
  filename: "Save the result to this path (under /bot/work) instead of returning it" };
function compact(schema: Record<string, any>) {
  delete schema.$schema;
  for (const [k, v] of Object.entries<any>(schema.properties || {})) if (SHORT_PROP[k] && typeof v?.description === "string" && v.description.length > SHORT_PROP[k].length) v.description = SHORT_PROP[k];
  return schema;
}
function browserTool(x: McpTool) {
  const inputSchema: Record<string, any> = compact(structuredClone(x.inputSchema || { type: "object", properties: {} }));
  const field = inputSchema.properties?.fields?.items?.properties?.type;
  if (x.name === "browser_fill_form" && field) field.description = FIELD_TYPE;
  if (SNAPSHOT_ACTIONS.test(x.name)) inputSchema.properties = { ...inputSchema.properties, snapshot: SNAPSHOT_ARG };
  return { type: "function", name: x.name, description: DESCRIBE[x.name] || x.description || x.name, inputSchema };
}
const BROWSER_READ = { type: "function", name: "browser_read", description: "Read the current page's content as compact markdown (headings, text, lists, links with their URLs, form fields, tables), up to 12 KB; the main landmark when the page has one. Pass target (a ref) to read just that part. For reading; use browser_snapshot when you need refs to act on.",
  inputSchema: { type: "object", properties: { target: { type: "string", description: "Ref of the element to read, from the latest snapshot. Omit for the whole page." }, element: { type: "string", description: "What that element is, in words." } } } };
const BROWSER_REPLAY = { type: "function", name: "browser_replay_request", description: "Re-send request #index from browser_network_requests from the page's own logged-in session, with its original headers (you never see them), optionally changing it: body replaces the body, merge sets fields in a JSON body (e.g. a next-page cursor), query sets URL parameters. The way to page through a site's own API in bulk. Returns status and body (24 KB; pass save, a path under /bot/work, for the whole body). Checked like page JS: anything that orders, pays, posts or sends waits for the driver.",
  inputSchema: { type: "object", properties: { index: { type: "integer", minimum: 1 }, body: { description: "New body: a string, or an object sent as JSON." }, merge: { type: "object", description: "Fields to set in the original JSON body." }, query: { type: "object", description: "URL parameters to set." }, method: { type: "string" }, save: { type: "string", description: "Write the full response body to this path under /bot/work." } }, required: ["index"] } };
const BROWSER_FILL_SECRET = { type: "function", name: "browser_fill_secret", description: "Sign in (or pay with a card) using a secret from the driver's vault, by name: Pitcrew types the values into the fields you name and submits, in one step; you never see them. The page must be the secret's own site. Details: harness_help vault.",
  inputSchema: { type: "object", properties: { secret: { type: "string", description: "The secret's name, e.g. BESCOM login" },
    fields: { type: "array", items: { type: "object", properties: { field: { type: "string", enum: ["username", "password", "totp", "card_number", "card_expiry", "card_cvc", "card_name"] }, target: { type: "string", description: "Ref of that box from the latest snapshot" } }, required: ["field", "target"] } },
    submit: { type: "string", description: "Ref of the sign-in or pay button; omit to press Enter (logins only)" } }, required: ["secret", "fields"] } };
export function dynamicTools(b: Pick<Bot, "kind">, manifest: ToolManifest = { browser: [], computer: [] }, { engram = false, images = false } = {}) {
  const runtime = [
    ...manifest.browser.filter((x) => !HIDDEN.has(x.name)).map(browserTool),
    ...(manifest.browser.some((x) => x.name === "browser_snapshot") ? [BROWSER_READ] : []),
    ...(manifest.browser.some((x) => x.name === "browser_run_code_unsafe") ? [BROWSER_REPLAY, BROWSER_FILL_SECRET] : []),
    ...manifest.computer.filter((x) => !HIDDEN.has(`computer_${x.name}`)).map((x) => ({ type: "function", name: `computer_${x.name}`, description: `${x.description || x.name} (${x.name === "screenshot" ? `pixel control of the computer's screen. ${SHOT_HINT}` : PIXEL})`, inputSchema: x.inputSchema || { type: "object", properties: {} } })),
  ];
  const tools: Record<string, any>[] = [...runtime,
    { type: "function", name: "render_surface", description: `Show the driver a visual surface: tables, charts, comparisons, dashboards or forms. Pass {title, root}, root a component tree ({type, ...props, children?}); hue tokens only. Components: ${Object.keys(CATALOGUE).join(", ")}; their props and bound dashboards (source + queries + bind) are in harness_help("dashboards"). Validation errors name what's wrong.`,
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Update this surface of yours in place instead of making a new one." }, title: { type: "string" }, root: { type: "object" }, source: { type: "string", description: "SQLite ledger under /bot/work that bind queries read." }, queries: { type: "object", description: "name → one read-only SELECT against source." } }, required: ["title", "root"] } },
    { type: "function", name: "share_screenshot", description: "Post a screenshot into this chat for the driver, with a one-line caption. source: browser (the current page, default) or screen (the whole desktop). For one element, pass element and ref from the latest snapshot.",
      inputSchema: { type: "object", properties: { caption: { type: "string" }, source: { type: "string", enum: ["browser", "screen"] }, full_page: { type: "boolean" }, element: { type: "string" }, ref: { type: "string" } }, required: ["caption"] } },
    { type: "function", name: "remember", description: "Save one self-contained sentence. scope picks where: session = this thread only (decisions, what's pending; survives a restart); agent (default) = your own memory, yours alone, saved at once, capped at 3,000 chars so rewrite (pass id) rather than pile up: how your job works, site quirks, where things are; global = a fact about the driver for the whole crew (a preference, a rule, a stable detail), which waits for their review in Engram. Never put paths, files or task state in global.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, scope: { type: "string", enum: ["session", "agent", "global"] }, id: { type: "string", description: "The memory it replaces" },
        valid_until: { type: "string", description: "YYYY-MM-DD, for a fact that expires (a fare, an offer, a quote, a document)" } }, required: ["text"] } },
    { type: "function", name: "forget", description: "Forget a memory by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { type: "function", name: "query_ledger", description: "Read a crew member's SQLite ledger with one SELECT (read-only; 500 rows). member: their name (omit for your own). Omit source to list their ledgers. Private members' ledgers stay private. Use it to answer from another member's data instead of asking them.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, source: { type: "string", description: "Ledger path under their /bot/work, e.g. grocery/ledger.db" }, sql: { type: "string" } } } },
    { type: "function", name: "propose_house_rule", description: "When the driver tells you a standing don't (\"never post anything\", \"don't book without asking\"), propose it as one of your house rules, in their words. The gate enforces house rules in every mode; it doesn't scan the chat for don'ts. The driver confirms it in a pit stop.",
      inputSchema: { type: "object", properties: { rule: { type: "string", description: "One line, e.g. Never post or send anything on my behalf" }, why: { type: "string", description: "What the driver said" } }, required: ["rule", "why"] } },
    { type: "function", name: "suggest_improvement", description: "Suggest a change only Pitcrew can make (a missing tool, a rule that got in the way, a confusing result), with the evidence: runs, numbers, what happened. The driver reviews suggestions; you can't change the harness yourself.",
      inputSchema: { type: "object", properties: { area: { type: "string", enum: ["tool", "approvals", "prompt", "runtime", "other"] }, title: { type: "string" }, evidence: { type: "string" }, proposal: { type: "string" } }, required: ["title", "evidence"] } },
    { type: "function", name: "set_done_criteria", description: "Before a task, say what done looks like: 1-6 checkable facts about the result (a file has the rows, a page shows the order id). When you finish, a separate grader checks them against your evidence. harness_help done.",
      inputSchema: { type: "object", properties: { criteria: { type: "array", items: { type: "string" }, maxItems: 6 } }, required: ["criteria"] } },
    { type: "function", name: "harness_help", description: "How part of Pitcrew works, in detail: browser, dashboards, schedules, memory, skills, approvals, files, images, crew, done or vault.",
      inputSchema: { type: "object", properties: { topic: { type: "string", enum: HELP_TOPICS } }, required: ["topic"] } },
    { type: "function", name: "whats_new", description: "Harness changes you haven't seen yet (new tools, rules, ways of working). Marks them seen.", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "skill_view", description: "Load one of your skills (/bot/work/skills/<name>/SKILL.md), or a file inside it (file: references/x.md, scripts/y.py). Load the skill before doing a task it covers.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["name"] } },
    { type: "function", name: "read_thread", description: "Read one of your threads in full: every message from the driver and you, each tool call as one line with its outcome, pit stops, errors and notes. Paged (about 20 KB); pass after from the last page to continue. Use it when reviewing past work; find_threads gives the ids.",
      inputSchema: { type: "object", properties: { thread: { type: "string", description: "Thread id or link" }, after: { type: "integer" } }, required: ["thread"] } },
    { type: "function", name: "find_threads", description: "Search your own past threads (titles and transcripts) when the driver asks to find, reopen or resume an earlier conversation. Returns matching threads, best first, with links. Words, names and phrases from that conversation make good queries.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
    { type: "function", name: "schedule_task", description: 'Run a prompt on a schedule; each run gets its own thread with the last three runs\' outcomes. when: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "monthly 1 HH:MM" (day 1-28), "every N minutes|hours" (min 15 minutes). Times are Asia/Kolkata. Call list_schedules first: to change or extend an existing schedule, use update_schedule instead of adding a second one.',
      inputSchema: { type: "object", properties: { when: { type: "string" }, prompt: { type: "string" }, title: { type: "string", description: "A short name the driver sees, e.g. Daily expense review" } }, required: ["when", "prompt"] } },
    { type: "function", name: "list_schedules", description: "Your schedules: id, when, next run (Asia/Kolkata) or paused, and the prompt.", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "update_schedule", description: "Change one of your schedules. Pass only what changes: when (same formats as schedule_task), prompt (replaces the whole prompt), title, paused.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, when: { type: "string" }, prompt: { type: "string" }, title: { type: "string" }, paused: { type: "boolean" } }, required: ["id"] } },
    { type: "function", name: "cancel_schedule", description: "Delete one of your schedules for good. To stop it for a while, update_schedule with paused: true.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ];
  // Only with an OpenRouter key, which bills each image; ChatGPT-plan members also have Codex's own image_gen.
  if (images) tools.push({ type: "function", name: "generate_image",
    description: `Make or edit images with any OpenRouter image model; saved to /bot/work/out/images and shown in this chat. To edit or restyle, pass images (workspace paths). Model choice and options: harness_help images. Default model ${DEFAULT_IMAGE_MODEL}.`,
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, images: { type: "array", items: { type: "string" }, description: "Workspace images to edit or use as references" },
      model: { type: "string" }, aspect_ratio: { type: "string" }, resolution: { type: "string" }, quality: { type: "string" }, background: { type: "string", enum: ["auto", "transparent", "opaque"] },
      output_format: { type: "string", enum: ["png", "jpeg", "webp", "svg"] }, n: { type: "integer", minimum: 1, maximum: 4 }, name: { type: "string", description: "File name, without extension" },
      mask: { type: "string", description: "Workspace PNG: white where the edit goes. Pitcrew keeps the rest of images[0] unchanged." } }, required: ["prompt"] } });
  // Only for a member linked to Engram, which hosts the published files.
  if (engram) tools.push({ type: "function", name: "publish_file",
    description: "Only when the driver asks for a link or file: publish one file from /bot/work (md, html, pdf, an image, or any single file) as a page they open at a link. Private to the driver; public only when they ask to share it and approve. Pass id to update one you published (same link, new version).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Under /bot/work, e.g. /bot/work/out/goa-comparison.html" }, title: { type: "string" },
      id: { type: "string", description: "An artifact you published, to replace it with a new version" }, description: { type: "string" },
      public: { type: "boolean", description: "Ask the driver to let anyone with the link open it. Only when they asked to share it." } }, required: ["path", "title"] } });
  const plans = b.kind === "chief" && plansOn();
  if (plans) tools.push({ type: "function", name: "plan",
    description: "Run work that needs crew members as a living todo list that Pitcrew executes. First call: goal, constraints (the driver's preferences and limits, word for word) and add. Later calls: add, reopen (send an item back with a new task and why), cancel, or finish. Pitcrew starts every item whose `after` items are done, hands it their results, and wakes you after each item ends. You may finish only when every constraint is marked met, unmet or untested.",
    inputSchema: { type: "object", properties: {
      goal: { type: "string" }, constraints: { type: "array", items: { type: "string" } },
      add: { type: "array", items: { type: "object", properties: { key: { type: "string", description: "Short id you choose, e.g. dates" }, member: { type: "string", description: "Member name; Crew Chief for work you do yourself" }, task: { type: "string", description: "Self-contained: the member sees only this and the results of its `after` items" }, after: { type: "array", items: { type: "string" } } }, required: ["key", "member", "task"] } },
      reopen: { type: "array", items: { type: "object", properties: { key: { type: "string" }, task: { type: "string" }, why: { type: "string" } }, required: ["key", "task", "why"] } },
      cancel: { type: "array", items: { type: "string" } },
      finish: { type: "object", properties: { answer: { type: "string" }, constraints: { type: "array", items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["met", "unmet", "untested"] }, note: { type: "string" } }, required: ["text", "status"] } } }, required: ["answer", "constraints"] },
    } } });
  if (b.kind === "chief") tools.push({ type: "function", name: "ask_crew_member",
    description: "Ask another crew member a question, or give them a task in their job, and wait up to 10 minutes for their answer. They work in their own thread with their own memory, logins, computer, cap and permissions; any pit stop they hit still goes to the driver.",
    inputSchema: { type: "object", properties: { member: { type: "string", description: "The member's name" }, question: { type: "string", description: "Self-contained: they can't see this thread. Say what you need back." } }, required: ["member", "question"] } });
  // The Chief is the workspace admin: it reads every member's setup, record and files; every change it proposes waits for the driver.
  if (b.kind === "chief") tools.push(
    { type: "function", name: "crew_overview", description: "How each member is set up and doing: SOUL, house rules, skills with loads and staleness, memory use, last runs, retros, open suggestions (private members: setup only). Omit member for the whole crew.",
      inputSchema: { type: "object", properties: { member: { type: "string" } } } },
    { type: "function", name: "propose_soul", description: "Propose a new SOUL for a member (who it is, its job, voice, working style; at most 1,500 chars). The driver approves it in a pit stop; you can't change a member yourself.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, soul: { type: "string" }, why: { type: "string", description: "The evidence: runs, retros, what kept going wrong" } }, required: ["member", "soul", "why"] } },
    { type: "function", name: "propose_retire", description: "Propose retiring a member: it leaves the crew and its schedules stop; its threads and memory stay. The driver approves it in a pit stop.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, why: { type: "string", description: "The evidence: idle weeks, a job another member covers, work that ended" } }, required: ["member", "why"] } },
    { type: "function", name: "propose_member_change", description: "Propose changing a member's profile: name, job, house_rules, hue, shape, personality, provider, model, weekly_cap_usd, policy ({effect: allow|ask}), engram_scope. Pass only what changes. The driver approves it in a pit stop.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, changes: { type: "object" }, why: { type: "string", description: "The evidence for the change" } }, required: ["member", "changes", "why"] } },
    { type: "function", name: "member_files", description: "List one folder of a member's /bot/work (not a private member's). Omit path for the top.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, path: { type: "string" } }, required: ["member"] } },
    { type: "function", name: "delete_member_files", description: "Propose deleting files or folders (with their contents) from a member's /bot/work: 1 to 50 paths. The driver approves it in a pit stop.",
      inputSchema: { type: "object", properties: { member: { type: "string" }, paths: { type: "array", items: { type: "string" } }, why: { type: "string" } }, required: ["member", "paths", "why"] } },
    { type: "function", name: "triage_suggestion", description: "Tidy the crew's open suggestions: merge_into folds a duplicate into another (votes and evidence move over); note adds evidence. Accepting and dismissing stay with the driver.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, merge_into: { type: "string" }, note: { type: "string" } }, required: ["id"] } });
  if (b.kind === "chief") tools.push({ type: "function", name: "propose_crew_member",
    description: "Propose a new crew member for recurring work. The driver reviews it as a HIRE pit stop. Authority always starts at the default policy.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, job: { type: "string" }, reason: { type: "string", description: "Why: the recurring work you noticed" },
      hue: { type: "string", enum: HUES }, shape: { type: "string", enum: SHAPES },
      personality: { type: "object", properties: { role: { type: "string" }, warmth: { type: "integer" }, talk: { type: "integer" }, humour: { type: "integer" }, quirks: { type: "array", items: { type: "string" } }, signoff: { type: "string" } } },
      weekly_cap_usd: { type: "number" }, schedule: { type: "object", properties: { spec: { type: "string" }, prompt: { type: "string" } } },
      engram_scope: { type: "string", enum: ENGRAM_SCOPES, description: "Where its memories live in Engram: finance for money work, health for health, else personal" } },
      required: ["name", "job", "reason"] } });
  return tools;
}
