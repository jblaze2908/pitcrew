// The harness manual: detail a member reads on demand with harness_help(topic), so the instructions every thread carries
// stay short (crew.ts HARNESS core). One page per topic; each a few hundred words at most.
import { catalogueDoc } from "./surfaces.js";

export const FILES_URL = "http://127.0.0.1:7780/";
export const BOUND_DOC = `Dashboards over data you keep: store the data in a SQLite ledger under /bot/work (e.g. /bot/work/grocery/ledger.db) and pass source plus queries ({name: "SELECT …"}, read-only, one statement each). A component with bind: "<query name>" gets its data from that query every time the driver opens it, so a daily run only adds rows; never re-render to refresh numbers. Column names per component: Stat value (+delta, tone; format for money), Meter value, max; Text text; Table: the columns you list; List title, detail, meta; Timeline time, text, state; BarChart/Donut label, value; LineChart x, y (+series); Sparkline value. Re-render with id only to change the layout. The tool result lists any query that failed.`;

const PAGES = (driver: string): Record<string, string> => ({
  browser: [
    "Browser (Chromium on your computer; it keeps logins):",
    "- Every action returns the page afterwards (what changed since your last snapshot, or the full snapshot on a new page). Don't call browser_snapshot after an action.",
    "- Refs die when the page navigates or reloads; act only on refs from the latest result. To open a link, browser_navigate to its URL instead of clicking.",
    "- Read with browser_snapshot or browser_read (markdown). Screenshots only when layout matters.",
    "- Bulk or repeated reads: check browser_network_requests for the site's own API and read responses with browser_network_request; page through it with browser_replay_request (merge the next cursor, save pages under /bot/work). Else one browser_evaluate (or browser_run_code_unsafe) loop that filters and returns compact JSON. Big results: pass filename and process in the shell. Some sites reject replays (403): fall back to the browser session.",
    "- Cookies, localStorage and sessionStorage tools exist; secret values come back masked. Page JS and storage writes are checked by jev like any action.",
    "- browser_fill_form handles radios, checkboxes and selects too, several fields per call. computer_* pixel actions return a screenshot already.",
    `- file:// is blocked: open workspace files at ${FILES_URL}<path under /bot/work>.`,
  ].join("\n"),
  dashboards: `render_surface shows ${driver} a visual surface: {title, root}, root a component tree ({type, ...props, children?}); colours are hue tokens only. Forms come back to you as a message with the submitted values; pass id to update a surface of yours in place.\n\nComponents:\n${catalogueDoc()}\n\n${BOUND_DOC}`,
  schedules: [
    "Schedules: schedule_task(when, prompt) runs a prompt on a cadence (daily 09:00, weekly mon 08:30, every 6 hours); list_schedules shows each one's next and last run; update_schedule / cancel_schedule manage them.",
    `- A run arrives as "[Scheduled: …]"; ${driver} isn't waiting on it. Stay quiet unless something needs them: an alert rule in the skill fired, something failed (a login expired), they must act, or the digest is due. Otherwise your whole reply is "QUIET: <what you checked>"; the thread folds it to one line.`,
    "- Keep the task's data in a SQLite ledger and show it with a bound dashboard, so a run only adds rows. Alert rules (thresholds over the ledger) live in the task's skill.",
    "- A weekly digest is notable: a short summary with the numbers that changed.",
  ].join("\n"),
  memory: [
    "Memory has three tiers; remember(text, scope) picks one:",
    "- session: this thread only (decisions, what's pending); kept through a thread restart; 2,000 chars per thread.",
    "- agent (default): your own memory, yours alone, saved at once, shown to you at thread start; 3,000 chars in all, so rewrite (pass id) instead of piling up. How your job works, site quirks, where things are.",
    `- global: a fact about ${driver} for the whole crew (a preference, a rule, a stable detail). It goes to Engram and waits for ${driver}'s review. Never paths, files or task state.`,
    "- forget(id) removes one. Don't save secrets, guesses, or what you just read from Engram.",
  ].join("\n"),
  skills: [
    "Skills: how you do a kind of task, in /bot/work/skills/<name>/:",
    "- SKILL.md: frontmatter (name, description: one line saying when to use it), then the method, gotchas and alert rules. scripts/ and references/ beside it.",
    "- /bot/work/skills is one git repo: commit each change with a message saying what and why; never push. Data stays outside it.",
    "- The index of your skills is in your instructions; skill_view(name) loads one (and counts the use). Load before a task it covers; when you find a better way, fix the skill and commit.",
    `- A proven how-to other members could use: engram propose (kind skill) to the crew registry; ${driver} reviews it.`,
  ].join("\n"),
  approvals: [
    "Approvals: the gate (jev) judges each action by its real effect. Reading, browsing and drafting run; paying, sending, signing in, sharing, deleting and installing may wait for the driver (a pit stop).",
    "- Never ask for approval yourself; act, and the runtime pauses when needed.",
    "- Declined: don't try it another way; say what didn't happen. Blocked by a rule: same; the result says why. Expired: the driver didn't answer in 30 minutes; finish what you can and say what's waiting.",
    "- Threads can run Ask me, Hands-free (stops only for money, sign-in, send, share, delete) or YOLO (no pit stops); house rules (the driver's never/fine-to lines) hold in every mode.",
    "- A workspace script jev allowed once runs again without asking until its bytes change.",
  ].join("\n"),
  images: [
    "Images: every image you make lands in /bot/work/out/images (the Library) and shows in this chat.",
    `- image_gen (Codex, on the ChatGPT plan only): gpt-image-2, billed to ${driver}'s plan, so use it first when you have it. Edit by passing referenced_image_paths. It picks size and quality itself.`,
    "- generate_image (OpenRouter, billed per image to your weekly cap): any model, plus aspect_ratio, resolution, quality, transparent background, SVG and up to 4 variants (n). Pass images (workspace paths) to edit, restyle or combine them.",
    "- Models: google/gemini-3.1-flash-image (default: fast, cheap, good edits); openai/gpt-image-2.5-sunburst (best quality and text in images; transparent backgrounds); black-forest-labs/flux-3-image (photoreal); recraft/recraft-v4.1-vector (logos and icons as SVG); bytedance-seed/seedream-5-0-pro. A model that doesn't take an option says which values it does.",
    "- Write the prompt as a brief: subject, composition, style, lighting, exact text in quotes, what to keep unchanged when editing.",
    "- Look at the result with view_image before calling it done; fix it with another edit rather than starting over.",
    "- Edits from the driver say [Edit of <image>] or [Editing image <image>]: change that image, passing it first in images (or referenced_image_paths). A brushed edit names a mask and a marked copy (pink = change only there, numbered pins = notes for that spot): follow its How line exactly; with mask, Pitcrew keeps everything outside it unchanged. Every result is a new version; never overwrite the original.",
    `- Name files for what they are (name). Don't publish or send an image unless ${driver} asks.`,
  ].join("\n"),
  files: [
    "Files: /bot/work is your workspace.",
    `- out/: what ${driver} sees (Library). publish_file shares one file as a link, only when ${driver} asks for one.`,
    "- skills/: your skill library (git). downloads/: browser downloads. uploads/: what the driver attached. .scratch/: probes, raw dumps, one-off scripts; never shown as results.",
    "- A task's data (its ledger) lives in its own folder, e.g. /bot/work/grocery.",
    `- file:// is blocked in the browser; open workspace files at ${FILES_URL}<path>.`,
  ].join("\n"),
  crew: [
    "Crew: other members have their own computer, logins and memory.",
    "- ask_crew_member asks one a question or gives a task in their job; their reply comes back.",
    "- query_ledger reads a member's ledger read-only (not a private member's). read_thread / find_threads read your own past threads (the Chief can read non-private members').",
    "- whats_new lists harness changes you haven't seen.",
    "- Crew Chief only, as workspace admin: propose_member_change, propose_soul, propose_retire, delete_member_files and propose_crew_member each open a pit stop; nothing changes until the driver approves. Private members: setup and retiring only, never their files. Privacy, household access and connectors stay the driver's settings.",
  ].join("\n"),
});
export const TOPICS = ["browser", "dashboards", "schedules", "memory", "skills", "approvals", "files", "images", "crew"];
export const harnessHelp = (topic: string, driver: string) => PAGES(driver)[topic] ?? null;
