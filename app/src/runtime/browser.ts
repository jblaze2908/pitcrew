// Browser and pixel tools run on the crew member's computer, booting it (and its desktop) on first use.
// The gate sees the grounded element; the computer's MCP server sees only the model's own arguments.
// browser_read is ours: a gated browser_snapshot turned into text, so it runs no page JS.
import { getBot } from "../crew.js";
import { PW_SETTLE_MS, type Brain, type Rpc } from "../computer.js";
import type { ToolResult } from "../shots.js";
import { bus } from "./bus.js";
import { active, snapshots } from "./state.js";
import { addEvent } from "./threads.js";
import { computer } from "./machines.js";
import { gate } from "./gate.js";
import { takeRefusal, afterAction } from "./sitegate.js";
import { planLive } from "./plans.js";
import { ground, pixelContext, snapshotOf, noteSnapshot } from "./grounding.js";
import { SNAP_LINK, SNAP_MODES, shapeSnapshot, verifyLine, snapshotToText, readTabs, pageHead } from "./pageText.js";
import { short, summariseArgs, hostOf, say } from "./util.js";

// A dynamic tool call from the brain (item/tool/call): p.threadId is Codex's thread id.
export interface ToolCall { tool: string; threadId: string; callId?: string; arguments?: Record<string, any> }

export async function runtimeTool(br: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, t0 = Date.now();
  const kind = p.tool.startsWith("browser_") ? "browser" : "computer", reading = p.tool === "browser_read";
  if (/^browser_(evaluate|run_code)/.test(p.tool)) return say("Page JavaScript isn't available. Use the element tools (click, type, fill_form, snapshot).", false);
  if (kind === "browser" && !(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off. Answer from your memory and say what you couldn't check.", false);
  // `snapshot` (what the result shows of the page afterwards) is ours; Playwright never sees it.
  const { snapshot: snapArg, ...given } = p.arguments || {};
  const tool = reading ? "browser_snapshot" : kind === "browser" ? p.tool : p.tool.replace(/^computer_/, "");
  const args: Record<string, any> = reading ? (given.target ? { target: String(given.target) } : {}) : tool === "browser_take_screenshot" && !given.type && !given.filename ? { ...given, type: "jpeg" } : given;
  const g = kind === "browser" ? ground(snapshots.get(p.threadId), tool, args) : { grounded: pixelContext(args, snapshots.get(p.threadId)), effect: null, label: "" };
  const host = hostOf(g.grounded.page_url);
  const title = `${reading ? "read" : tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(g.label || summariseArgs(args), 140)}${host ? ` on ${host}` : ""}`.trim();
  bus.emit("activity", { threadId, botId: b.id, text: title });
  const ok = await gate(br, threadId, { kind: "mcp", server: kind, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) }, { kind: "mcp", title, detail: { server: kind, tool, args: g.grounded } });
  const timing: Record<string, number> = { gate: Date.now() - t0 }; // includes a lease wait and jev's remote check (p50 336 ms for browser, measured)
  if (!ok) { addEvent(threadId, turnId, "tool", { type: kind, title, status: "declined", timing }); return say(takeRefusal(threadId) || "Not done: this action was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const comp = computer(b);
  try {
    if (!comp.desktopUp) bus.emit("activity", { threadId, botId: b.id, text: comp.up ? "Starting the desktop…" : "Starting the computer…" });
    let t = Date.now();
    const mcp = await comp.mcp(kind);
    comp.touch();
    timing.boot = Date.now() - t; t = Date.now();
    if (kind === "browser" && tool !== "browser_tabs") await frontTab(mcp);
    if (kind === "browser" && comp.viewers > 0 && /^browser_(click|select_option)$/.test(tool) && args.target) await glideTo(mcp, args);
    const tabsBefore = tabCounts.get(mcp);
    timing.prep = Date.now() - t; t = Date.now();
    const r = await mcp.request("tools/call", { name: tool, arguments: kind === "computer" ? { ...args, _watched: comp.viewers > 0 } : args }, 120000);
    timing.run = Date.now() - t;
    const content: McpContent[] = Array.isArray(r.content) ? r.content : [];
    const text = content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    let out = text;
    if (kind === "browser") {
      const prev = snapshots.get(p.threadId), url = /^- Page URL: (\S+)/m.exec(text)?.[1] || prev?.url || null, snap = snapshotOf(b.id, text);
      const mode = SNAP_MODES.includes(snapArg) ? snapArg : undefined;
      if (reading) out = snap == null ? text : `${pageHead(text)}\n\n${snapshotToText(snap)}`;
      else out = `${SNAP_LINK.test(text) ? `${verifyLine(tool, text, { before: prev?.url, tabsBefore })}\n` : ""}${shapeSnapshot(text, snap, { prev, url, mode })}`;
      noteSnapshot(p.threadId, snap, url, { scoped: !!(args.target || args.depth), seen: !reading && mode !== "none" });
      const post = await afterAction(b, threadId, p.threadId, mcp, { tool, text, snap, url, before: prev?.url, tabsBefore });
      if (post) out = `${post}\n\n${out}`;
      const tb = readTabs(text); if (tb) tabCounts.set(mcp, tb.count);
    }
    addEvent(threadId, turnId, "tool", { type: kind, title, status: r.isError ? "failed" : "completed", output: text.slice(0, 1500), timing });
    return { success: !r.isError, contentItems: toContentItems([{ type: "text", text: out }, ...content.filter((x) => x.type !== "text")], { codeMode: String(p.callId || "").startsWith("exec-") }) };
  } catch (e: any) {
    addEvent(threadId, turnId, "tool", { type: kind, title, status: "failed", error: e.message });
    return say(`The computer couldn't run ${tool}: ${e.message}`, false);
  }
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
const tabCounts = new WeakMap<Rpc, number>(); // browser MCP session → tab count from its last response
export async function frontTab(mcp: Rpc) {
  if (tabCounts.get(mcp) === 1) return;
  try {
    const call = (args: Record<string, unknown>) => mcp.request("tools/call", { name: "browser_tabs", arguments: args }, 15000);
    const t = readTabs(((await call({ action: "list" })).content || []).map((x) => x.text || "").join("\n"));
    tabCounts.set(mcp, t?.count ?? 1);
    if (t && t.count > 1) await call({ action: "select", index: t.current });
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
