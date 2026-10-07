// The tools a crew member's brain is offered at thread start: browser and pixel tools from the computer image's manifest
// (descriptions shortened, since every turn pays for them), then Pitcrew's own. Detail belongs in harness_help (manual.ts).
import { DEFAULT_IMAGE_MODEL } from "./images.js";
import { CATALOGUE } from "./surfaces.js";
import { HELP_TOPICS } from "./manual.js";
import { HUES, SHAPES, ENGRAM_SCOPES, plansOn } from "./crew.js";
import type { Bot } from "../shared/types.js";

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
    { type: "function", name: "set_done_criteria", description: "Before a task that changes something, say what done looks like: 1-6 criteria, each a checkable fact plus, where you can, a read-only shell command that proves it. Pitcrew runs the checks when you finish. harness_help done.",
      inputSchema: { type: "object", properties: { criteria: { type: "array", maxItems: 6, items: { type: "object", properties: { text: { type: "string" }, check: { type: "string", description: "Read-only shell command, run in /bot/work" }, expect: { type: "string", description: "Text the output must contain, or a number test on its last line (>=6). Omit: exit 0 passes" } }, required: ["text"] } } }, required: ["criteria"] } },
    { type: "function", name: "harness_help", description: "How part of Pitcrew works, in detail: browser, dashboards, schedules, memory, skills, approvals, files, images, crew, done or vault.",
      inputSchema: { type: "object", properties: { topic: { type: "string", enum: HELP_TOPICS } }, required: ["topic"] } },
    { type: "function", name: "whats_new", description: "Harness changes you haven't seen yet (new tools, rules, ways of working). Marks them seen.", inputSchema: { type: "object", properties: {} } },
    { type: "function", name: "skill_view", description: "Load one of your skills (/bot/work/skills/<name>/SKILL.md), or a file inside it (file: references/x.md, scripts/y.py). Load the skill before doing a task it covers.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string" } }, required: ["name"] } },
    { type: "function", name: "read_thread", description: "Read one of your threads in full: every message from the driver and you, each tool call as one line with its outcome, pit stops, errors and notes. Paged (about 20 KB); pass after from the last page to continue. Use it when reviewing past work; find_threads gives the ids.",
      inputSchema: { type: "object", properties: { thread: { type: "string", description: "Thread id or link" }, after: { type: "integer" } }, required: ["thread"] } },
    { type: "function", name: "find_threads", description: "Search your own past threads (titles and transcripts) when the driver asks to find, reopen or resume an earlier conversation. Returns matching threads, best first, with links. Words, names and phrases from that conversation make good queries.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
    { type: "function", name: "schedule_task", description: 'Run a prompt on a schedule; each run gets its own thread with the last three runs\' outcomes. when: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "monthly 1 HH:MM" (day 1-28), "every N minutes|hours" (min 15 minutes), or "after <schedule name>" to run when that schedule\'s run finishes, with its reply. Times are Asia/Kolkata. Call list_schedules first: to change or extend an existing schedule, use update_schedule instead of adding a second one.',
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
