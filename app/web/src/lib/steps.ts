// A tool step's title (notify.ts toolTitle) as an icon, a plain label and the detail. Parsed from the title, so old
// threads read the same: "engram.google__gmail_search query=x" → mail · "Search mail" · "x".
export type StepIcon = "mail" | "calendar" | "drive" | "engram" | "ledger" | "web" | "browser" | "terminal" | "file" | "tool"
  | "search" | "read" | "add" | "edit" | "remove" | "send" | "code";
export interface StepView { icon: StepIcon; label: string; detail: string }

const GOOGLE: Record<string, [StepIcon, string]> = {
  gmail_search: ["mail", "Search mail"], gmail_read: ["mail", "Read mail"], gmail_create_draft: ["mail", "Draft mail"],
  calendar_list: ["calendar", "List calendars"], calendar_events: ["calendar", "Check calendar"], calendar_freebusy: ["calendar", "Check free time"],
  calendar_create_event: ["calendar", "Block calendar"], calendar_delete_event: ["calendar", "Remove calendar block"],
  drive_search: ["drive", "Search Drive"], drive_read: ["drive", "Read Drive file"], drive_save_file: ["drive", "Save to Drive"],
};
const ENGRAM: Record<string, string> = { search: "Search Engram", get: "Open from Engram", propose: "Save to Engram", profile: "Read profile" };
const CONN: Record<string, [StepIcon, string]> = { tijori: ["ledger", "Tijori"], exa: ["web", "Web"] };
const EXA: Record<string, string> = { web_search_exa: "Search the web", web_fetch_exa: "Read web page" };
const BROWSER = /^(browser_)?(navigate|navigate_back|click|type|fill_form|select_option|press_key|hover|drag|snapshot|read|tabs|wait_for|file_upload|handle_dialog|take_screenshot|evaluate|close|resize)\b/;

// Any other server's tool gets an icon from its verb, so a newly added MCP reads sensibly with no change here.
const VERBS: [RegExp, StepIcon][] = [
  [/^(search|find|query|list|lookup|browse|filter)/, "search"], [/^(get|read|fetch|view|open|show|describe|download|export|retrieve|check)/, "read"],
  [/^(create|add|insert|new|save|upload|write|draft|make|append|log|record|book|schedule)/, "add"], [/^(update|edit|modify|set|patch|move|rename|change|replace|tag|label|assign|mark|merge)/, "edit"],
  [/^(delete|remove|trash|archive|cancel|close|clear|revoke|unsubscribe)/, "remove"], [/^(send|post|reply|forward|publish|share|invite|notify|comment|message|pay|transfer)/, "send"],
];
const verbIcon = (tool: string): StepIcon => { const w = tool.toLowerCase(); return VERBS.find(([re]) => re.test(w))?.[1] ?? "tool"; };
const words = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// "query=newer_than:30d max=1" → "newer_than:30d max=1": the one key everyone reads past.
const tidyArgs = (s: string) => s.replace(/^(query|text|id|q)=/, "").trim();

// Browser steps arrive titled "<tool in words> <args> on <host>" (runtime/browser.ts); the args are Playwright's, not words.
const BR_TOOL = /^(run code unsafe|take screenshot|press key|navigate back|navigate|fill form|select option|wait for|file upload|handle dialog|replay request|evaluate|snapshot|read|click|type|hover|drag|tabs|close|resize)\b ?(.*)$/;
const BR_LABEL: Record<string, [StepIcon, string]> = {
  "run code unsafe": ["code", "Ran a browser script"], evaluate: ["code", "Ran page JavaScript"], "replay request": ["code", "Re-sent a request"],
  "take screenshot": ["browser", "Took a screenshot"], snapshot: ["read", "Read the page"], read: ["read", "Read the page"],
  navigate: ["browser", "Opened"], "navigate back": ["browser", "Went back"], click: ["browser", "Clicked"], type: ["browser", "Typed in"],
  "press key": ["browser", "Pressed"], "fill form": ["browser", "Filled a form"], "select option": ["browser", "Picked an option"], hover: ["browser", "Hovered"],
};
function browserStep(t: string): StepView | null {
  const m = BR_TOOL.exec(t);
  if (!m) return null;
  const [, tool] = m;
  let rest = m[2].replace(/\bcode=[\s\S]*?(?= on [a-z0-9.-]+\.[a-z]{2,}$|$)/i, "");
  const host = / on ([a-z0-9.-]+\.[a-z]{2,})$/i.exec(rest)?.[1] || "";
  if (host) rest = rest.slice(0, -(host.length + 4));
  const key = /\bkey=(\S+)/.exec(rest)?.[1];
  rest = key || rest.replace(/\b[a-z_]+=\S+/gi, "").replace(/\s+/g, " ").trim();
  const [icon, label] = BR_LABEL[tool] || ["browser", words(tool)];
  // A navigation's "on <host>" is the page it left; the address it opened is the detail.
  if (tool === "navigate") return { icon, label, detail: rest };
  return { icon, label, detail: [rest, host && `on ${host}`].filter(Boolean).join(" ") };
}

/** connLabel: the connection's real name when Pitcrew stamped one on the event (from Engram's sync); else the id, in words. */
export function stepView(title: string, connLabel?: string | null): StepView {
  const t = title.trim();
  if (t === "Ran a script") return { icon: "code", label: "Ran a script", detail: "" };
  // Codex titles a shell call with its wrapper: /bin/zsh -lc "curl …" reads as curl ….
  if (t.startsWith("$ ")) return { icon: "terminal", label: "Run", detail: t.slice(2).replace(/^\/bin\/(ba|z)?sh -l?c /, "").replace(/^(["'])([\s\S]*)\1$/, "$2") };
  if (t.startsWith("Edited ")) return { icon: "file", label: "Edit", detail: t.slice(7) };
  if (t.startsWith("Searched ")) return { icon: "web", label: "Search the web", detail: t.slice(9) };
  const br = browserStep(t);
  if (br) return br;
  const sp = t.indexOf(" "), head = sp < 0 ? t : t.slice(0, sp), rest = sp < 0 ? "" : tidyArgs(t.slice(sp + 1));
  const m = /^([a-z][\w-]*)\.(.+)$/.exec(head);
  if (m) {
    const [, server, tool] = m, up = /^([a-z0-9-]+)__(.+)$/.exec(tool);
    if (server === "engram" && up) {
      const [, conn, name] = up;
      if (conn === "google" && GOOGLE[name]) return { icon: GOOGLE[name][0], label: GOOGLE[name][1], detail: rest };
      if (conn === "exa" && EXA[name]) return { icon: "web", label: EXA[name], detail: rest };
      const [icon, brand] = CONN[conn.split("-")[0]] || [verbIcon(name), words(conn)];
      return { icon, label: `${connLabel || brand} · ${words(name).toLowerCase()}`, detail: rest };
    }
    if (server === "engram") return { icon: "engram", label: ENGRAM[tool] || `Engram · ${words(tool).toLowerCase()}`, detail: rest };
    if (server === "computer") return { icon: "browser", label: `Computer · ${words(tool).toLowerCase()}`, detail: rest };
    return { icon: verbIcon(tool), label: `${words(server)} · ${words(tool).toLowerCase()}`, detail: rest };
  }
  if (BROWSER.test(head)) return { icon: "browser", label: words(head.replace(/^browser_/, "")), detail: rest };
  if (/^computer_/.test(head)) return { icon: "browser", label: words(head.replace(/^computer_/, "")), detail: rest };
  return { icon: verbIcon(head), label: words(head), detail: rest };
}

// Code-running browser tools: jev's title carries the raw code, which says nothing at a glance.
const PAGE_CODE: Record<string, string> = { browser_run_code_unsafe: "Ran a browser script", browser_evaluate: "Ran page JavaScript", browser_replay_request: "Re-sent a request" };
const hostOf = (u: unknown) => { try { return typeof u === "string" ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
/** A pit stop as a step line: what it would do, in words, for the folded row and the card heading. */
export function pitLabel(p: { kind: string; title: string; detail?: Record<string, any> }): StepView {
  const d = p.detail || {}, tool = String(d.tool || "");
  if (p.kind === "command") return { icon: "terminal", label: "Run", detail: String(d.command || p.title.replace(/^Run: /, "")).replace(/^\/bin\/(ba)?sh -l?c /, "") };
  if (p.kind === "mcp" && (d.server === "browser" || d.server === "computer")) {
    const host = hostOf(d.args?.page_url), on = host ? `on ${host}` : "";
    if (PAGE_CODE[tool]) return { icon: "code", label: PAGE_CODE[tool], detail: on };
    const v = stepView(`${d.server === "computer" ? "computer_" : ""}${tool}`);
    return { ...v, detail: on };
  }
  if (p.kind === "mcp" && d.server && tool) { const v = stepView(`${d.server}.${tool}`); return { ...v, detail: "" }; }
  return { icon: "tool", label: p.title, detail: "" };
}

export type SummaryPart = string | { em: string };
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
const baseName = (p: string) => p.split("/").filter(Boolean).pop() || p;
/** A run's steps as one plain sentence ("Opened example.com, ran 3 browser scripts, took 2 screenshots"); names come
 * back as { em } so the view can brighten them. A script that only wraps tool calls is counted by what it called. */
export function runSummary(steps: { type: string; nested: boolean; v: StepView }[]): SummaryPart[] {
  const wraps = steps.some((s) => s.nested);
  const order: string[] = [], n = new Map<string, number>(), names = new Map<string, string[]>();
  const add = (k: string, name?: string) => {
    if (!n.has(k)) order.push(k);
    n.set(k, (n.get(k) || 0) + 1);
    if (name && !names.get(k)?.includes(name)) names.set(k, [...(names.get(k) || []), name]);
  };
  for (const { type, v } of steps) {
    if (type === "script") { if (!wraps) add("script"); }
    else if (type === "commandExecution" || v.icon === "terminal") add("command");
    else if (v.icon === "code") add("bscript");
    else if (v.label === "Took a screenshot") add("shot");
    else if (v.label === "Opened") add("open", hostOf(v.detail) || v.detail);
    else if (v.label === "Read the page") add("read");
    else if (v.label === "Edit") add("edit", baseName(v.detail));
    else if (v.label === "Search the web") add("search");
    else if (v.icon === "browser") add("browse");
    else add("tool");
  }
  const out: SummaryPart[] = [];
  for (const k of order) {
    const c = n.get(k)!, nm = names.get(k) || [];
    if (out.length) out.push(", ");
    if ((k === "open" || k === "edit") && nm.length <= 2) {
      out.push(k === "open" ? "opened " : "edited ");
      nm.forEach((x, i) => { if (i) out.push(" and "); out.push({ em: x }); });
      continue;
    }
    out.push({
      command: plural(c, "ran a command", "ran # commands"), script: plural(c, "ran a script", "ran # scripts"),
      bscript: plural(c, "ran a browser script", "ran # browser scripts"), shot: plural(c, "took a screenshot", "took # screenshots"),
      open: `opened ${c} pages`, read: plural(c, "read the page", "read # pages"), edit: `edited ${nm.length} files`,
      search: plural(c, "searched the web", "searched the web # times"), browse: plural(c, "used the browser", "used the browser # times"),
      tool: plural(c, "used a tool", "used # tools"),
    }[k]!);
  }
  if (!out.length) return ["Waited on a pit stop"];
  if (typeof out[0] === "string") out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  return out;
}
