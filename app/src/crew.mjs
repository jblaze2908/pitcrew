// Crew members: the Crew Chief is built in; everyone else is hired through a HIRE pit stop.
// Personality is voice only: it never touches permissions, caps or jev.
import { one, all, run, now, uid, json, getSetting, audit } from "./db.mjs";
import { DEFAULT_POLICY } from "./jev.mjs";
import { DEFAULT_MODEL } from "./providers.mjs";
import { catalogueDoc } from "./surfaces.mjs";

export const HUES = ["c1", "c2", "c3", "c5", "c6"];
export const SHAPES = ["square", "round", "blob"];
// New crew members start with read/draft allowed; sign-in, pay and send ask first; delete and share always ask.
export const STARTING_POLICY = { ...DEFAULT_POLICY };

const row = (b) => b && { ...b, personality: json(b.personality, {}), policy: { ...STARTING_POLICY, ...json(b.policy, {}) }, mcp: json(b.mcp, []), archived: !!b.archived };
export const getBot = (id) => row(one("SELECT * FROM bots WHERE id=?", id));
export const listBots = () => all("SELECT * FROM bots WHERE archived=0 ORDER BY kind='chief' DESC, created_at").map(row);

export function ensureChief() {
  if (one("SELECT 1 FROM bots WHERE kind='chief'")) return;
  const provider = getSetting("default_provider", "openrouter");
  run(`INSERT INTO bots(id,name,job,kind,hue,shape,personality,provider,model,weekly_cap_usd,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    "chief", "Crew Chief", "Takes any task, runs a thread for each, and proposes new crew members when work keeps coming back.", "chief", "c1", "square",
    JSON.stringify({ role: "Calm race engineer. Short sentences, facts first.", warmth: 3, talk: 2, humour: 1, quirks: ["Says what changed before what's next"], signoff: "", callMe: "" }),
    provider, DEFAULT_MODEL[provider], 20, "{}", now());
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), "chief", "Crew Chief · pinned", 1, now(), now());
}

const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);
const text = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");

// Normalises a proposal or a manual hire form into a crew-member record. Authority comes from STARTING_POLICY, never from the proposal.
export function normaliseSpec(s = {}) {
  const provider = ["openrouter", "aigateway", "openai"].includes(s.provider) ? s.provider : getSetting("default_provider", "openrouter");
  const p = s.personality || {};
  return {
    name: text(s.name, 40) || "New crew member",
    job: text(s.job, 400),
    hue: HUES.includes(s.hue) ? s.hue : HUES[Math.floor(Math.random() * HUES.length)],
    shape: SHAPES.includes(s.shape) ? s.shape : "square",
    personality: {
      role: text(p.role, 160), warmth: clamp(p.warmth, 1, 5, 3), talk: clamp(p.talk, 1, 5, 3), humour: clamp(p.humour, 1, 5, 2),
      quirks: (Array.isArray(p.quirks) ? p.quirks : []).map((q) => text(q, 120)).filter(Boolean).slice(0, 3),
      signoff: text(p.signoff, 60), callMe: text(p.callMe, 40), plain: !!p.plain,
    },
    provider, model: text(s.model, 120) || DEFAULT_MODEL[provider],
    weekly_cap_usd: Math.min(500, Math.max(0, Number.isFinite(+s.weekly_cap_usd) ? +s.weekly_cap_usd : 5)),
    schedule: s.schedule && typeof s.schedule === "object" ? { spec: text(s.schedule.spec, 60), prompt: text(s.schedule.prompt, 1000) } : null,
    reason: text(s.reason, 600),
  };
}

export function createBot(spec) {
  const base = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "crew";
  let id = base, i = 2;
  while (one("SELECT 1 FROM bots WHERE id=?", id)) id = `${base}-${i++}`;
  run(`INSERT INTO bots(id,name,job,kind,hue,shape,personality,provider,model,weekly_cap_usd,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, spec.name, spec.job, "specialist", spec.hue, spec.shape, JSON.stringify(spec.personality), spec.provider, spec.model, spec.weekly_cap_usd, "{}", now());
  run("INSERT INTO threads(id,bot_id,title,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?)", uid("th"), id, `${spec.name} · pinned`, 1, now(), now());
  audit("driver", "crew.hired", { id, name: spec.name, provider: spec.provider, model: spec.model });
  return getBot(id);
}

export function updateBot(id, patch) {
  const b = getBot(id);
  if (!b) throw Object.assign(new Error("No such crew member"), { status: 404 });
  const n = normaliseSpec({ ...b, ...patch, personality: { ...b.personality, ...(patch.personality || {}) } });
  const policy = { ...b.policy };
  // Policy edits may only use known effect classes and allow/ask; "always" for delete/share is refused.
  for (const [k, v] of Object.entries(patch.policy || {})) if (k in STARTING_POLICY && ["allow", "ask"].includes(v) && !(v === "allow" && ["delete", "share", "pay"].includes(k))) policy[k] = v;
  const mcp = Array.isArray(patch.mcp) ? patch.mcp.filter((m) => /^[a-z][a-z0-9_-]{0,31}$/.test(m.name) && /^https:\/\//.test(m.url)).slice(0, 10).map((m) => ({ name: m.name, url: m.url.slice(0, 500), tokenSecret: m.tokenSecret || null })) : b.mcp;
  run("UPDATE bots SET name=?,job=?,hue=?,shape=?,personality=?,provider=?,model=?,weekly_cap_usd=?,policy=?,mcp=? WHERE id=?",
    b.kind === "chief" ? b.name : n.name, n.job, n.hue, n.shape, JSON.stringify(n.personality), n.provider, n.model, n.weekly_cap_usd, JSON.stringify(policy), JSON.stringify(mcp), id);
  audit("driver", "crew.updated", { id, fields: Object.keys(patch) });
  return getBot(id);
}

// ~150-token voice block; the plain-voice rule is repeated because it is the part that must never drift.
export function voiceBlock(b) {
  const p = b.personality || {};
  if (p.plain || getSetting("plain_voice") === "1") return "Voice: plain and brief. No personality flourishes.";
  const dial = (n, lo, hi) => (n <= 2 ? lo : n >= 4 ? hi : "balanced");
  return [
    `Voice: ${p.role || "helpful crew member"}.`,
    `Warmth: ${dial(p.warmth, "cool and matter-of-fact", "warm")}. Talk: ${dial(p.talk, "terse", "chatty")}. Humour: ${dial(p.humour, "none", "light, dry jokes")}.`,
    p.quirks?.length ? `Quirks: ${p.quirks.join("; ")}.` : "",
    p.callMe ? `Call the driver "${p.callMe}".` : "",
    p.signoff ? `Sign off long replies with "${p.signoff}".` : "",
    "Never joke about money, approvals, receipts or failures; state those plainly.",
  ].filter(Boolean).join(" ");
}

export function instructions(b, memories) {
  const driver = getSetting("driver_name", "the driver");
  return [
    `You are ${b.name}, a member of ${driver}'s Pitcrew: a personal crew of AI agents that get real-life admin and computer work done for ${driver}.`,
    b.job ? `Your job: ${b.job}` : "",
    voiceBlock(b),
    `You have your own computer, started on demand: shell commands and file edits run there, and the browser_* tools drive its Chromium (a 1280x800 desktop ${driver} can watch live). Answer from what you know when no tool is needed; the computer only starts when you run a command or use the browser. Prefer browser_* tools (they act on page elements by ref from browser_snapshot); use computer_* pixel tools only when a page can't be driven otherwise. The browser keeps its logins between runs.`,
    `Workspace on the computer: /bot/work. Downloads land in /bot/work/downloads. Put files meant for ${driver} in /bot/work/out; they appear in the Library.`,
    `Pit stops: the runtime decides which actions need ${driver}'s approval (sending, paying, signing in, installing, deleting, sharing). You don't ask for approval yourself; just act and the runtime pauses when needed. If an action is declined, do not retry it another way; say what didn't happen.`,
    `When a comparison, table, chart, dashboard or form would help, call render_surface instead of writing a long text table. Forms come back to you as a message with the submitted values.`,
    `When ${driver} tells you a durable fact or preference worth keeping, call remember. Recurring work can be put on a schedule with schedule_task.`,
    memories.length ? `What you remember (edit with remember/forget):\n${memories.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "",
    b.kind === "chief" ? `You are the Crew Chief, the only built-in crew member. When you notice recurring work that deserves its own crew member (the same kind of task 3+ times), call propose_crew_member. ${driver} always reviews and approves a hire; you can't create one yourself.` : "",
  ].filter(Boolean).join("\n\n");
}

// Browser (Playwright over CDP) and pixel tools come from the computer image's own manifest, under their usual names.
const NO_PAGE_JS = new Set(["browser_evaluate", "browser_run_code_unsafe"]);
export function dynamicTools(b, manifest = { browser: [], computer: [] }) {
  const runtime = [
    ...manifest.browser.filter((x) => !NO_PAGE_JS.has(x.name)).map((x) => ({ type: "function", name: x.name, description: x.description || x.name, inputSchema: x.inputSchema || { type: "object", properties: {} } })),
    ...manifest.computer.map((x) => ({ type: "function", name: `computer_${x.name}`, description: `${x.description || x.name} (pixel control of the computer's screen)`, inputSchema: x.inputSchema || { type: "object", properties: {} } })),
  ];
  const tools = [...runtime,
    { type: "function", name: "render_surface", description: `Show the driver a visual surface in the Pitcrew design system: tables, charts, comparisons, dashboards or forms. Pass {title, root} where root is a component tree ({type, ...props, children?}). Colours are hue tokens only. Components:\n${catalogueDoc()}`,
      inputSchema: { type: "object", properties: { title: { type: "string" }, root: { type: "object" } }, required: ["title", "root"] } },
    { type: "function", name: "remember", description: "Save one durable fact or preference the driver told you (one sentence). Pass id to rewrite an existing memory.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, id: { type: "string" } }, required: ["text"] } },
    { type: "function", name: "forget", description: "Forget a memory by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { type: "function", name: "schedule_task", description: 'Run a prompt on a schedule in this thread. when: "daily HH:MM", "weekly mon HH:MM", "every N minutes|hours" (min 15 minutes). Times are Asia/Kolkata.',
      inputSchema: { type: "object", properties: { when: { type: "string" }, prompt: { type: "string" } }, required: ["when", "prompt"] } },
  ];
  if (b.kind === "chief") tools.push({ type: "function", name: "propose_crew_member",
    description: "Propose a new crew member for recurring work. The driver reviews it as a HIRE pit stop. Authority always starts at the default policy.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, job: { type: "string" }, reason: { type: "string", description: "Why: the recurring work you noticed" },
      hue: { type: "string", enum: HUES }, shape: { type: "string", enum: SHAPES },
      personality: { type: "object", properties: { role: { type: "string" }, warmth: { type: "integer" }, talk: { type: "integer" }, humour: { type: "integer" }, quirks: { type: "array", items: { type: "string" } }, signoff: { type: "string" } } },
      weekly_cap_usd: { type: "number" }, schedule: { type: "object", properties: { spec: { type: "string" }, prompt: { type: "string" } } } },
      required: ["name", "job", "reason"] } });
  return tools;
}
