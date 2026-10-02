// Crew members: the Crew Chief is built in; everyone else is hired through a HIRE pit stop.
// Personality is voice only: it never touches permissions, caps or jev.
import { one, all, run, now, uid, json, getSetting, setSetting, audit } from "./db.js";
import { DEFAULT_POLICY } from "./jev.js";
import { DEFAULT_MODEL } from "./providers.js";
import { catalogueDoc } from "./surfaces.js";
import type { Bot, EngramScope, Hue, Shape, Personality, ProviderId } from "../shared/types.js";
import type { BotRow } from "./models.js";

export const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
// The computer's loopback-only, read-only view of /bot/work (computer/files.mjs, started by desktop.sh).
export const FILES_URL = "http://127.0.0.1:7780/";
export const SHAPES: Shape[] = ["square", "round", "blob"];
export const ENGRAM_SCOPES: EngramScope[] = ["personal", "finance", "health"];
const CONN_ID = /^[a-z0-9][a-z0-9-]{0,11}$/;
// New crew members start with read/draft allowed; sign-in, pay and send ask first; delete and share always ask.
export const STARTING_POLICY = { ...DEFAULT_POLICY };

const row = (b: BotRow | undefined): Bot | undefined => b && ({ ...b, personality: json(b.personality, {}), policy: { ...STARTING_POLICY, ...json(b.policy, {}) }, mcp: json(b.mcp, []), archived: !!b.archived, private: !!b.private, engram_scope: ENGRAM_SCOPES.includes(b.engram_scope as EngramScope) ? b.engram_scope : "personal", engram_household: !!b.engram_household } as Bot);
export const getBot = (id: string | null | undefined) => row(one<BotRow>("SELECT * FROM bots WHERE id=?", id));
export const listBots = () => all<BotRow>("SELECT * FROM bots WHERE archived=0 ORDER BY kind='chief' DESC, created_at").map(row) as Bot[];

export function ensureChief() {
  if (one("SELECT 1 FROM bots WHERE kind='chief'")) return;
  const provider = getSetting("default_provider", "openrouter");
  run(`INSERT INTO bots(id,name,job,kind,hue,shape,personality,provider,model,weekly_cap_usd,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    "chief", "Crew Chief", "Takes any task, runs a thread for each, and proposes new crew members when work keeps coming back.", "chief", "c1", "square",
    JSON.stringify({ role: "Calm race engineer. Short sentences, facts first.", warmth: 3, talk: 2, humour: 1, quirks: ["Says what changed before what's next"], signoff: "", callMe: "" }),
    provider, DEFAULT_MODEL[provider as ProviderId], 20, "{}", now());
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), "chief", "Crew Chief · pinned", 1, now(), now());
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
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), id, `${spec.name} · pinned`, 1, now(), now());
  audit("driver", "crew.hired", { id, name: spec.name, provider: spec.provider, model: spec.model });
  return getBot(id)!;
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
export function instructions(b: Pick<Bot, "name" | "personality"> & Partial<Bot>, memories: { id: string; text: string }[], engram: EngramContext | null = null) {
  const driver = getSetting("driver_name", "the driver");
  return [
    `You are ${b.name}, a member of ${driver}'s Pitcrew: a personal crew of AI agents that get real-life admin and computer work done for ${driver}.`,
    b.job ? `Your job: ${b.job}` : "",
    voiceBlock(b),
    `You have your own computer, started on demand: shell commands and file edits run there, and the browser_* tools drive its Chromium (a 1280x800 desktop ${driver} can watch live). Answer from what you know when no tool is needed; the computer only starts when you run a command or use the browser. Prefer browser_* tools (they act on page elements by ref from browser_snapshot); use computer_* pixel tools only when a page can't be driven otherwise. The browser keeps its logins between runs.`,
    `Workspace on the computer: /bot/work. Downloads land in /bot/work/downloads. Put files meant for ${driver} in /bot/work/out; they appear in the Library.`,
    [`Browser rules:`,
      `- Every browser action returns the page afterwards: what changed since your last snapshot, or the full snapshot on a new page. Don't call browser_snapshot after an action.`,
      `- Refs die when the page navigates or reloads; act only on refs from the latest result.`,
      `- To open a link, browser_navigate to its /url instead of clicking it.`,
      `- Read pages with browser_snapshot or browser_read (page text as markdown). Take screenshots only when layout or visuals matter.`,
      `- Use browser_fill_form for radios, checkboxes and selects too, several fields per call.`,
      `- computer_* pixel actions already return a screenshot of the result; don't take another.`,
      `- file:// is blocked in the browser. Open workspace files at ${FILES_URL}<path under /bot/work>, e.g. ${FILES_URL}out/report.html (read-only).`,
      `- In exec scripts, call tools as tools.browser_click({...}); don't print ALL_TOOLS. Tools that return a screenshot give a data: URL string there: show it with image(result), never text(result).`,
    ].join("\n"),
    `Pit stops: the runtime decides which actions need ${driver}'s approval (sending, paying, signing in, installing, deleting, sharing). You don't ask for approval yourself; just act and the runtime pauses when needed. If an action is declined, do not retry it another way; say what didn't happen.`,
    `When a comparison, table, chart, dashboard or form would help, call render_surface instead of writing a long text table. Forms come back to you as a message with the submitted values.`,
    `To show the driver what's on screen (a result, a confirmation, a page that looks wrong), call share_screenshot; your own screenshots stay private.`,
    engram ? "" : `When ${driver} tells you a durable fact or preference worth keeping, call remember.`,
    `Recurring work can be put on a schedule with schedule_task.`,
    memories.length ? `What you remember${engram ? " (in Engram)" : ""} (rewrite one by passing its id to remember; forget removes it):\n${memories.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "",
    engram ? engramBlock(driver, engram, b.engram_scope) : "",
    b.kind === "chief" ? `You are the Crew Chief, the only built-in crew member. When you notice recurring work that deserves its own crew member (the same kind of task 3+ times), call propose_crew_member. ${driver} always reviews and approves a hire; you can't create one yourself.` : "",
    b.kind === "chief" ? crewRoster(b as Bot, driver) : `The Crew Chief may ask you something on ${driver}'s behalf. Answer it fully in one reply; that reply goes back to the Chief.`,
    b.kind === "chief" && plansOn() ? planRules(driver) : "",
  ].filter(Boolean).join("\n\n");
}

// Also a /refresh turn's context (turns.ts), so a forked thread hears the same words its instructions use.
export function engramBlock(driver: string, engram: EngramContext, scope: keyof typeof SCOPE_NAME = "personal") {
  return [
    `Engram is ${driver}'s context engine; its tools are on your engram MCP server. Search it before asking ${driver} something they may already have told another agent.`,
    // What to send, so the next agent doesn't ask again. Kept short: it rides in every thread's instructions.
    [`Keep Engram current, without being asked: ${driver} should never have to tell another agent the same thing twice.`,
      `- remember: one durable fact per call, as a sentence another agent understands cold ("Electricity is BESCOM, account ending 4417, due on the 5th"). Save what ${driver} tells you, and what you confirm from their own accounts, bills, bookings and documents: providers, due and renewal dates, plan and policy details, preferences, people and addresses. Pass valid_until (YYYY-MM-DD) for anything that expires: a fare, an offer, a quote, a document.`,
      `- If a fact changed, pass the old memory's id to remember so it is replaced, not duplicated.`,
      `- Not worth saving: what you just read from Engram, guesses or estimates, one-off chatter, and secrets (passwords, OTPs, card numbers, full account numbers).`,
      `- If a fact didn't come from ${driver}, say where it did ("per the October BESCOM bill"). Anything from an email or a web page waits for ${driver}'s review.`,
      `- engram propose: a person, account or place worth its own record (kind entity), or a how-to you worked out that will come up again (kind skill)${scope === "personal" ? "" : `, with scope ${scope}`}. Don't propose episodes: Pitcrew sends your journal itself.`,
      `- When you make something ${driver} will read, keep or share (a report, comparison, plan, dashboard, letter), write it as one file in /bot/work/out (md, html or pdf) and call publish_file, then give them the link. To change it later, publish again with its id. Working files stay unpublished.`,
      `- Before you finish a task, check whether you learned something durable, and save it then.`,
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
// Page JS is never offered; the rest of HIDDEN went unused in prod rollouts and only cost prompt tokens (the runtime
// still uses browser_hover and browser_tabs itself).
const NO_PAGE_JS = new Set(["browser_evaluate", "browser_run_code_unsafe"]);
const HIDDEN = new Set(["browser_emulate_media", "browser_resize", "browser_network_request", "browser_network_requests", "browser_close", "browser_drag", "computer_double_click", "computer_type"]);
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
};
const FIELD_TYPE = "Kind of control, not its HTML type: textbox for any text, email, password or number input and textareas; checkbox; radio; combobox for a select/dropdown (value = the option's text); slider. checkbox and radio values are \"true\" or \"false\".";
const SNAPSHOT_ARG = { type: "string", enum: ["diff", "full", "none"], description: "What the result shows of the page afterwards: diff (default: what changed since your last snapshot; full on a new page), full, or none." };
const PIXEL = "pixel control of the computer's screen; the result includes a screenshot of the screen after the action, so don't take another";
// One tool from an MCP server's tools/list, as the computer image reports it.
export interface McpTool { name: string; description?: string; inputSchema?: Record<string, any> }
export interface ToolManifest { browser: McpTool[]; computer: McpTool[]; image?: string; execInfo?: unknown }
function browserTool(x: McpTool) {
  const inputSchema: Record<string, any> = structuredClone(x.inputSchema || { type: "object", properties: {} });
  const field = inputSchema.properties?.fields?.items?.properties?.type;
  if (x.name === "browser_fill_form" && field) field.description = FIELD_TYPE;
  if (SNAPSHOT_ACTIONS.test(x.name)) inputSchema.properties = { ...inputSchema.properties, snapshot: SNAPSHOT_ARG };
  return { type: "function", name: x.name, description: DESCRIBE[x.name] || x.description || x.name, inputSchema };
}
const BROWSER_READ = { type: "function", name: "browser_read", description: "Read the current page's content as compact markdown (headings, text, lists, links with their URLs, form fields, tables), up to 12 KB; the main landmark when the page has one. Pass target (a ref) to read just that part. For reading; use browser_snapshot when you need refs to act on.",
  inputSchema: { type: "object", properties: { target: { type: "string", description: "Ref of the element to read, from the latest snapshot. Omit for the whole page." }, element: { type: "string", description: "What that element is, in words." } } } };
export function dynamicTools(b: Pick<Bot, "kind">, manifest: ToolManifest = { browser: [], computer: [] }, { engram = false } = {}) {
  const runtime = [
    ...manifest.browser.filter((x) => !NO_PAGE_JS.has(x.name) && !HIDDEN.has(x.name)).map(browserTool),
    ...(manifest.browser.some((x) => x.name === "browser_snapshot") ? [BROWSER_READ] : []),
    ...manifest.computer.filter((x) => !HIDDEN.has(`computer_${x.name}`)).map((x) => ({ type: "function", name: `computer_${x.name}`, description: `${x.description || x.name} (${x.name === "screenshot" ? `pixel control of the computer's screen. ${SHOT_HINT}` : PIXEL})`, inputSchema: x.inputSchema || { type: "object", properties: {} } })),
  ];
  const tools: Record<string, any>[] = [...runtime,
    { type: "function", name: "render_surface", description: `Show the driver a visual surface in the Pitcrew design system: tables, charts, comparisons, dashboards or forms. Pass {title, root} where root is a component tree ({type, ...props, children?}). Colours are hue tokens only. Components:\n${catalogueDoc()}`,
      inputSchema: { type: "object", properties: { title: { type: "string" }, root: { type: "object" } }, required: ["title", "root"] } },
    { type: "function", name: "share_screenshot", description: "Post a screenshot into this chat for the driver, with a one-line caption. source: browser (the current page, default) or screen (the whole desktop). For one element, pass element and ref from the latest snapshot.",
      inputSchema: { type: "object", properties: { caption: { type: "string" }, source: { type: "string", enum: ["browser", "screen"] }, full_page: { type: "boolean" }, element: { type: "string" }, ref: { type: "string" } }, required: ["caption"] } },
    { type: "function", name: "remember", description: "Save one durable fact or preference (one self-contained sentence). Pass id to replace an existing memory instead of adding a second one.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, id: { type: "string", description: "The memory it replaces" },
        valid_until: { type: "string", description: "YYYY-MM-DD, for a fact that expires (a fare, an offer, a quote, a document)" } }, required: ["text"] } },
    { type: "function", name: "forget", description: "Forget a memory by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { type: "function", name: "find_threads", description: "Search your own past threads (titles and transcripts) when the driver asks to find, reopen or resume an earlier conversation. Returns matching threads, best first, with links. Words, names and phrases from that conversation make good queries.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
    { type: "function", name: "schedule_task", description: 'Run a prompt on a schedule in this thread. when: "daily HH:MM", "weekly mon HH:MM", "every N minutes|hours" (min 15 minutes). Times are Asia/Kolkata.',
      inputSchema: { type: "object", properties: { when: { type: "string" }, prompt: { type: "string" } }, required: ["when", "prompt"] } },
  ];
  // Only for a member linked to Engram, which hosts the published files.
  if (engram) tools.push({ type: "function", name: "publish_file",
    description: "Publish one file from /bot/work (md, html, pdf, an image, or any single file) as a page the driver opens at a link. Private to the driver; public only when they ask to share it and approve. Pass id to update one you published (same link, new version).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Under /bot/work, e.g. /bot/work/out/goa-comparison.html" }, title: { type: "string" },
      id: { type: "string", description: "An artifact you published, to replace it with a new version" }, description: { type: "string" },
      public: { type: "boolean", description: "Ask the driver for a public link anyone can open. Only when they asked to share it." } }, required: ["path", "title"] } });
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
