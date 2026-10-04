// Browser and pixel tools run on the crew member's computer, booting it (and its desktop) on first use.
// The gate sees the grounded element; the computer's MCP server sees only the model's own arguments.
// browser_read is ours: a gated browser_snapshot turned into text. Page JS and Playwright code run like any other tool:
// gated per call (gate.ts never lets a fully allowed site skip jev for them), with secrets masked and size capped.
import { getBot } from "../crew.js";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PW_SETTLE_MS, botDir, type Brain, type Rpc } from "../computer.js";
import type { ToolResult } from "../shots.js";
import { bus } from "./bus.js";
import { active, snapshots } from "./state.js";
import { addEvent } from "./threads.js";
import { computer } from "./machines.js";
import { gate } from "./gate.js";
import { takeRefusal, afterAction } from "./sitegate.js";
import { planLive } from "./plans.js";
import { ground, pixelContext, snapshotOf, noteSnapshot } from "./grounding.js";
import { SNAP_LINK, SNAP_MODES, DATA_TOOLS, shapeSnapshot, verifyLine, snapshotToText, readTabs, pageHead, maskSecrets, capData } from "./pageText.js";
import { short, summariseArgs, hostOf, say, debugArgs } from "./util.js";

// A dynamic tool call from the brain (item/tool/call): p.threadId is Codex's thread id.
// A call from inside a Code Mode script (Codex gives those ids "exec-…"); the thread draws it under that script.
const viaScript = (p: { callId?: string }) => (String(p.callId || "").startsWith("exec-") ? { viaScript: true } : {});
export interface ToolCall { tool: string; threadId: string; callId?: string; arguments?: Record<string, any> }

export async function runtimeTool(br: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, t0 = Date.now();
  const kind = p.tool.startsWith("browser_") ? "browser" : "computer", reading = p.tool === "browser_read";
  if (p.tool === "browser_replay_request") return replayRequest(br, threadId, p);
  if (kind === "browser" && !(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off. Answer from your memory and say what you couldn't check.", false);
  // `snapshot` (what the result shows of the page afterwards) is ours; Playwright never sees it.
  const { snapshot: snapArg, ...given } = p.arguments || {};
  // jev judges the code it can see; a snippet loaded from a file would run unread.
  if (p.tool === "browser_run_code_unsafe" && given.filename) return say("Pass the Playwright function inline as code; loading it from a file isn't supported here.", false);
  const tool = reading ? "browser_snapshot" : kind === "browser" ? p.tool : p.tool.replace(/^computer_/, "");
  const args: Record<string, any> = reading ? (given.target ? { target: String(given.target) } : {}) : tool === "browser_take_screenshot" && !given.type && !given.filename ? { ...given, type: "jpeg" } : given;
  const g = kind === "browser" ? ground(snapshots.get(p.threadId), tool, args) : { grounded: pixelContext(args, snapshots.get(p.threadId)), effect: null, label: "" };
  const host = hostOf(g.grounded.page_url);
  const title = `${reading ? "read" : tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(g.label || summariseArgs(args), 140)}${host ? ` on ${host}` : ""}`.trim();
  bus.emit("activity", { threadId, botId: b.id, text: title });
  const ok = await gate(br, threadId, { kind: "mcp", server: kind, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) }, { kind: "mcp", title, detail: { server: kind, tool, args: g.grounded } });
  const timing: Record<string, number> = { gate: Date.now() - t0 }; // includes a lease wait and jev's remote check (p50 336 ms for browser, measured)
  if (!ok) { addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: "declined", timing }); return say(takeRefusal(threadId) || "Not done: this action was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const comp = computer(b);
  try {
    if (!comp.desktopUp) bus.emit("activity", { threadId, botId: b.id, text: comp.up ? "Starting the desktop…" : "Starting the computer…" });
    let t = Date.now();
    const mcp = await comp.mcp(kind);
    comp.touch();
    timing.boot = Date.now() - t; t = Date.now();
    if (kind === "browser" && tool !== "browser_tabs" && needsFront(mcp, comp.viewers)) await frontTab(mcp);
    if (kind === "browser" && comp.viewers > 0 && /^browser_(click|select_option)$/.test(tool) && args.target) await glideTo(mcp, args);
    const tabsBefore = tabCounts.get(mcp);
    timing.prep = Date.now() - t; t = Date.now();
    const r = await mcp.request("tools/call", { name: tool, arguments: kind === "computer" ? { ...args, _watched: comp.viewers > 0 } : args }, 120000);
    timing.run = Date.now() - t;
    const content: McpContent[] = Array.isArray(r.content) ? r.content : [];
    const text = maskSecrets(tool, content.filter((x) => x.type === "text").map((x) => x.text).join("\n"));
    let out = text;
    if (kind === "browser") {
      const prev = snapshots.get(p.threadId), url = /^- Page URL: (\S+)/m.exec(text)?.[1] || prev?.url || null, snap = snapshotOf(b.id, text);
      const mode = SNAP_MODES.includes(snapArg) ? snapArg : undefined;
      if (reading) out = snap == null ? text : `${pageHead(text)}\n\n${snapshotToText(snap)}`;
      else out = `${SNAP_LINK.test(text) ? `${verifyLine(tool, text, { before: prev?.url, tabsBefore })}\n` : ""}${shapeSnapshot(DATA_TOOLS.test(tool) ? capData(text) : text, snap, { prev, url, mode })}`;
      noteSnapshot(p.threadId, snap, url, { scoped: !!(args.target || args.depth), seen: !reading && mode !== "none" });
      const post = await afterAction(b, threadId, p.threadId, mcp, { tool, text, snap, url, before: prev?.url, tabsBefore });
      if (post) out = `${post}\n\n${out}`;
      const tb = readTabs(text); if (tb) noteTabs(mcp, tb.count);
    }
    addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: r.isError ? "failed" : "completed", output: text.slice(0, 8000), timing });
    return { success: !r.isError, contentItems: toContentItems([{ type: "text", text: out }, ...content.filter((x) => x.type !== "text")], { codeMode: String(p.callId || "").startsWith("exec-") }) };
  } catch (e: any) {
    addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: "failed", error: e.message });
    return say(`The computer couldn't run ${tool}: ${e.message}`, false);
  }
}

// ---------- replaying a captured request ----------
// browser_replay_request: re-send request #index from the page's own session with a changed body, merged JSON fields or
// query. The original headers (auth, device ids) are copied inside one Playwright call and never reach the model; jev
// judges the method, URL and the change. Per call: one MCP read of the request line, one gate, one run_code.
export const REPLAY_MAX = 24000;
const LINE = /^#\d+ \[(\w+)\] (\S+)/m;
export function replayTarget(details: string, query?: Record<string, unknown> | null) {
  const m = LINE.exec(details);
  if (!m) return null;
  let url: URL;
  try { url = new URL(m[2]); } catch { return null; }
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  return { method: m[1].toUpperCase(), url: url.toString() };
}
// The Playwright function that replays it. Spec values are JSON-embedded, so nothing the model sent becomes code.
export function replayCode(spec: { method: string; source: string; url: string; body?: unknown; merge?: Record<string, unknown> | null }) {
  return `async (page) => {
  const spec = ${JSON.stringify(spec)};
  const src = (await page.requests()).reverse().find((r) => r.url() === spec.source && r.method() === spec.method);
  const headers = src ? await src.allHeaders() : {};
  for (const k of Object.keys(headers)) if (/^(:|host$|content-length$|cookie$|accept-encoding$)/i.test(k)) delete headers[k];
  let data = spec.body !== undefined ? (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body)) : src ? src.postData() ?? undefined : undefined;
  if (spec.merge) { let base = {}; try { base = JSON.parse(data || "{}"); } catch {} data = JSON.stringify({ ...base, ...spec.merge }); }
  const r = await page.request.fetch(spec.url, { method: spec.method, headers, data, failOnStatusCode: false, maxRedirects: 0 });
  return { status: r.status(), type: r.headers()["content-type"] || "", text: (await r.text()).slice(0, 4000000), found: !!src };
}`;
}
async function replayRequest(br: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, a = p.arguments || {};
  if (!(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off.", false);
  const index = Number(a.index);
  if (!Number.isInteger(index) || index < 1) return say("index: the request's number from browser_network_requests", false);
  const comp = computer(b), mcp = await comp.mcp("browser");
  comp.touch();
  const details = ((await mcp.request("tools/call", { name: "browser_network_request", arguments: { index } }, 30000)).content || []).map((x: McpContent) => x.text || "").join("\n");
  const target = replayTarget(details, a.query && typeof a.query === "object" ? a.query : null);
  if (!target) return say(`Request #${index} wasn't found; list them again with browser_network_requests.`, false);
  const source = LINE.exec(details)![2], method = String(a.method || target.method).toUpperCase();
  const change = { ...(a.body !== undefined ? { body: a.body } : {}), ...(a.merge && typeof a.merge === "object" ? { merge: a.merge } : {}), ...(a.query ? { query: a.query } : {}) };
  const page_url = snapshots.get(p.threadId)?.url || null, host = hostOf(target.url);
  const title = `replay ${method} ${short(target.url.replace(/^https?:\/\//, ""), 120)}`;
  const ok = await gate(br, threadId, { kind: "mcp", server: "browser", tool: "browser_replay_request", arguments: { method, url: target.url, ...change, page_url } }, { kind: "mcp", title, detail: { server: "browser", tool: "browser_replay_request", args: { method, url: target.url, ...change } } });
  if (!ok) { addEvent(threadId, turnId, "tool", { type: "browser", title, ...viaScript(p), server: "browser", tool: p.tool, input: debugArgs(a), status: "declined" }); return say(takeRefusal(threadId) || "Not done: this replay was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const r = await mcp.request("tools/call", { name: "browser_run_code_unsafe", arguments: { code: replayCode({ method, source, url: target.url, body: a.body, merge: a.merge && typeof a.merge === "object" ? a.merge : null }) } }, 120000);
  const raw = (r.content || []).map((x: McpContent) => x.text || "").join("\n");
  let res: { status: number; type: string; text: string; found: boolean } | null = null;
  try { res = JSON.parse((/### Result\n([\s\S]*?)(?:\n### |$)/.exec(raw)?.[1] ?? raw).trim()); } catch {}
  addEvent(threadId, turnId, "tool", { type: "browser", title: `${title}${host ? ` on ${host}` : ""}`, ...viaScript(p), server: "browser", tool: p.tool, input: debugArgs(a), status: r.isError || !res ? "failed" : "completed", output: res ? `HTTP ${res.status} · ${res.text.length} chars` : raw.slice(0, 2000) });
  if (!res) return say(`The replay failed: ${raw.slice(0, 600)}`, false);
  const head = `HTTP ${res.status}${res.type ? ` · ${res.type.split(";")[0]}` : ""}${res.found ? "" : " · sent without the original's headers (it's no longer in the page's request log)"}`;
  if (typeof a.save === "string" && a.save) {
    const file = workFile(b.id, a.save);
    if (!file) return say(`${head}\nsave must be a path under /bot/work; nothing was saved.`, false);
    writeFileSync(file, res.text);
    return say(`${head}\nSaved ${(res.text.length / 1024).toFixed(0)} KB to ${a.save}.`);
  }
  return say(`${head}\n${res.text.length > REPLAY_MAX ? `${res.text.slice(0, REPLAY_MAX)}\n…\nTruncated at ${REPLAY_MAX / 1000} KB of ${(res.text.length / 1000).toFixed(0)} KB: pass save (a path under /bot/work) for the whole body.` : res.text}`);
}
// A /bot/work path as its host file, with its folder made, or null when it would leave the work dir.
export function workFile(botId: string, path: string) {
  const rel = path.replace(/^\/bot\/work\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return null;
  const root = `${botDir(botId)}/work`, f = `${root}/${rel}`;
  try { mkdirSync(dirname(f), { recursive: true }); return realpathSync(dirname(f)).startsWith(realpathSync(root)) ? f : null; } catch { return null; }
}

// Codex hands a dynamic tool's result to an exec script (nested call ids "exec-…") as ONE string, its text and image
// data URLs joined by newlines (codex-rs tools/src/tool_output.rs, 0.156). So there an image result is the bare data URL,
// which image(result) shows. Text items never carry base64: unknown blocks become a placeholder, not JSON.
type McpContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: unknown } };
const noBase64 = (s: unknown) => String(s).replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, "[base64 data omitted]").replace(/[A-Za-z0-9+/]{2000,}={0,2}/g, "[base64 data omitted]");
export function toContentItems(content: McpContent[], { codeMode = false } = {}): ToolResult["contentItems"] {
  const items = content.map((x) => x.type === "image" ? { type: "inputImage", imageUrl: `data:${x.mimeType || "image/png"};base64,${x.data}` }
    : { type: "inputText", text: noBase64(x.type === "text" ? x.text : x.type === "resource" && typeof x.resource?.text === "string" ? x.resource.text : `[${x.type} content omitted]`) });
  const images = items.filter((x) => x.type === "inputImage");
  return codeMode && images.length ? images.slice(0, 1) : items;
}

// ---------- tab focus ----------
// Playwright drives its own current tab, which needn't be Chrome's foreground one (a popup opened, the driver switched
// tabs in the live view, or a fresh MCP session adopted tab 0). Then the live view shows another tab, and Chrome throttles
// the background tab's animation frames, so clicks wait on stability checks and time out. Before each action, bring the
// agent's tab to the front. Costs two local MCP calls, only while more than one tab is open.
// Only when something could have moved the foreground: the first action of a session, a change in the tab count (a popup,
// a closed tab), or a driver watching the live view (they can switch tabs there). Otherwise the agent's tab is still in
// front, and the check cost two MCP calls per action (the Blinkit backfill ran 165 navigations with 3 tabs open).
const tabCounts = new WeakMap<Rpc, number>(); // browser MCP session → tab count from its last response
const fronted = new WeakSet<Rpc>();            // sessions whose current tab was brought to the front since the count last changed
export const needsFront = (mcp: Rpc, viewers = 0) => viewers > 0 || !fronted.has(mcp);
export function noteTabs(mcp: Rpc, count: number) { if (tabCounts.get(mcp) !== count) fronted.delete(mcp); tabCounts.set(mcp, count); }
export async function frontTab(mcp: Rpc) {
  if (tabCounts.get(mcp) === 1) { fronted.add(mcp); return; }
  try {
    const call = (args: Record<string, unknown>) => mcp.request("tools/call", { name: "browser_tabs", arguments: args }, 15000);
    const t = readTabs(((await call({ action: "list" })).content || []).map((x) => x.text || "").join("\n"));
    tabCounts.set(mcp, t?.count ?? 1);
    if (t && t.count > 1) await call({ action: "select", index: t.current });
    fronted.add(mcp);
  } catch {}
}

// While the driver watches, move the pointer onto the element first and let the live-view pointer finish its glide,
// so the press lands where the pointer already is instead of mid-flight. Unwatched runs skip it.
// The glide (pointer.js, 250 ms) starts when the hover moves the mouse; the hover's own settle wait has used part of it.
const GLIDE_MS = 250;
async function glideTo(mcp: Rpc, args: Record<string, any>) {
  try { await mcp.request("tools/call", { name: "browser_hover", arguments: { element: args.element || "target", target: args.target } }, 15000); } catch {}
  await new Promise((r) => setTimeout(r, Math.max(0, GLIDE_MS - PW_SETTLE_MS)));
}
