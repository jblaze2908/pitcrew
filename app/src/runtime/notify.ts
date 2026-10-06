// Notifications from a brain: streamed text, tool activity, token usage and turn ends, turned into events and SSE.
import { run } from "../db.js";
import { recordChatgptLimits } from "../providers.js";
import type { Brain } from "../computer.js";
import { bus } from "./bus.js";
import { active, byCodex, items, liveCommands, OUT_CAP, shellVerdicts, usage } from "./state.js";
import { addEvent } from "./threads.js";
import { finishTurn } from "./turns.js";
import { subtract } from "./spend.js";
import { short, summariseArgs, debugArgs, bareCommand } from "./util.js";
import { connName } from "../engram.js";
import { scanScripts } from "./scripts.js";
import { engramUntrusted, taint } from "./taint.js";
import { saveImage, paletteFor, recordImage, imageAt } from "../images.js";
import { startPainting, endPainting } from "./painting.js";

// A Codex thread item (commandExecution, mcpToolCall, fileChange, …) as the app-server sends it.
type Item = Record<string, any>;
function toolTitle(it: Item) {
  switch (it.type) {
    case "commandExecution": return `$ ${short(bareCommand(it.command), 200)}`;
    case "mcpToolCall": return `${it.server === "browser" ? it.tool.replace(/^browser_/, "") : `${it.server}.${it.tool}`} ${short(summariseArgs(it.arguments), 140)}`;
    case "dynamicToolCall": return `${it.tool}`;
    case "fileChange": return `Edited ${(it.changes || []).map((c) => c.path).join(", ").slice(0, 200)}`;
    case "webSearch": return `Searched “${short(it.query, 120)}”`;
    case "imageGeneration": return "Image generation";
    default: return it.type;
  }
}
// Text content, or the structured result when there is no text. Kept up to `max` for the step's Output.
function mcpResultText(it: Item, max = 1500) {
  const c = it.result?.content || it.result?.contentItems || [];
  const text = (Array.isArray(c) ? c : []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  return (text || (it.result?.structuredContent ? JSON.stringify(it.result.structuredContent) : "")).slice(0, max);
}

export function onNotify(c: Brain, method: string, p: Record<string, any>) {
  if (method === "account/rateLimits/updated") return recordChatgptLimits(p.rateLimits);
  const threadId = p.threadId ? byCodex.get(p.threadId) : null;
  if (!threadId) return;
  const a = active.get(threadId);
  // A retro on a fork streams nothing live and leaves the thread's context gauge alone: its tokens aren't the thread's.
  const fork = !!a?.fork && a.fork === p.threadId;
  if (fork && (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta")) return;
  switch (method) {
    case "item/agentMessage/delta": bus.emit("delta", { threadId, itemId: p.itemId, text: p.delta }); break;
    // Live shell output for the Terminal tab: one SSE frame per chunk, the same cost as streamed reply text.
    case "item/commandExecution/outputDelta": {
      const lc = liveCommands.get(p.itemId);
      if (lc && lc.output.length < OUT_CAP) lc.output += String(p.delta).slice(0, OUT_CAP - lc.output.length);
      bus.emit("output", { threadId, itemId: p.itemId, chunk: String(p.delta).slice(0, 16_000) });
      break;
    }
    case "item/started": {
      const it = p.item; items.set(it.id, it);
      if (it.type === "commandExecution" && !fork) {
        const command = bareCommand(it.command).slice(0, 8000), cwd = it.cwd ?? null;
        const gate = shellVerdicts.get(`${threadId}\n${it.command}`) || null;
        liveCommands.set(it.id, { itemId: it.id, threadId, command, cwd, startedAt: Date.now(), output: "", gate });
        bus.emit("output", { threadId, itemId: it.id, command, cwd, gate });
      }
      // A Code Mode script's nested call: show the script (from the rollout) before its calls.
      if (typeof it.id === "string" && it.id.startsWith("exec-")) scanScripts(threadId, a?.turnId, c.bot.id, p.threadId);
      if (it.type === "imageGeneration") startPainting(threadId, { id: it.id, botId: c.bot.id, n: 1, aspect: "1:1", palette: paletteFor(""), model: "gpt-image-2" });
      // Browser and pixel tools announce themselves from their own handler, with the grounded element.
      if (!fork && ["commandExecution", "mcpToolCall", "fileChange", "webSearch", "imageGeneration"].includes(it.type) || (it.type === "dynamicToolCall" && !/^(browser|computer)_/.test(it.tool)))
        bus.emit("activity", { threadId, botId: c.bot.id, text: toolTitle(it) });
      break;
    }
    case "item/completed": {
      const it = p.item; items.delete(it.id); liveCommands.delete(it.id);
      const via = typeof it.id === "string" && it.id.startsWith("exec-") ? { viaScript: true } : {};
      if (it.type === "agentMessage" && it.text?.trim()) addEvent(threadId, a?.turnId, "agent", { text: it.text, itemId: it.id });
      else if (it.type === "commandExecution") { const k = `${threadId}\n${it.command}`, g = shellVerdicts.get(k) || null; shellVerdicts.delete(k); addEvent(threadId, a?.turnId, "tool", { type: it.type, itemId: it.id, gate: g, title: toolTitle(it), status: it.status, exitCode: it.exitCode ?? null, output: String(it.aggregatedOutput || "").slice(-8000),
        input: String(it.command || "").slice(0, 8000), cwd: it.cwd ?? null, durationMs: it.durationMs ?? null, ...via }); }
      else if (it.type === "mcpToolCall") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, output: mcpResultText(it, 8000), error: it.error?.message ? String(it.error.message).slice(0, 4000) : null,
        server: it.server, tool: it.tool, input: debugArgs(it.arguments), durationMs: it.durationMs ?? null,
        ...(it.server === "engram" ? { conn: connName(c.bot.id, String(it.tool)) } : {}), ...via });
      if (it.type === "mcpToolCall" && it.server === "engram" && engramUntrusted(it.result) && taint(threadId))
        addEvent(threadId, a?.turnId, "system", { text: "Engram returned untrusted content. For the next 10 minutes, sending, paying, signing in, sharing and deleting ask you first." });
      else if (it.type === "fileChange") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status });
      else if (it.type === "webSearch") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: "completed" });
      else if (it.type === "imageGeneration") codexImage(c.bot.id, threadId, a?.turnId, it, a?.editOf);
      else if (it.type === "contextCompaction") addEvent(threadId, a?.turnId, "system", { text: "Thread compacted." });
      break;
    }
    case "thread/tokenUsage/updated": {
      const tu = p.tokenUsage;
      if (a) { if (!a.base) a.base = usage.get(p.threadId) || subtract(tu.total, tu.last); a.total = tu.total; }
      usage.set(p.threadId, tu.total);
      if (fork) break;
      run("UPDATE threads SET ctx_tokens=?, ctx_window=? WHERE id=?", tu.last.inputTokens, tu.modelContextWindow, threadId);
      bus.emit("context", { threadId, tokens: tu.last.inputTokens, window: tu.modelContextWindow });
      break;
    }
    // A script's nested commands complete through the rollout scan, not item/completed: drop whatever is left running.
    case "turn/completed": for (const [k, lc] of liveCommands) if (lc.threadId === threadId) liveCommands.delete(k); scanScripts(threadId, a?.turnId, c.bot.id, p.threadId); if (a) finishTurn(threadId, p.turn.status, p.turn.status === "failed" ? (p.turn.error?.message || "The run failed") : null); break;
    case "error": if (!p.willRetry) addEvent(threadId, a?.turnId, "error", { text: short(p.error?.message || "Model error", 500) }); break;
    case "thread/compacted": addEvent(threadId, null, "system", { text: "Thread compacted." }); break;
  }
}

// Codex's image_gen (ChatGPT plan): the PNG comes base64 in the item; a copy goes to out/images for the Library and the thread.
function codexImage(botId: string, threadId: string, turnId: string | undefined, it: Item, editOf?: string | null) {
  endPainting(threadId, it.id);
  if (it.status !== "completed" || typeof it.result !== "string" || !it.result) {
    const limit = it.failure?.type === "usageLimitExceeded";
    return addEvent(threadId, turnId, "tool", { type: it.type, title: toolTitle(it), status: "failed",
      error: limit ? `The ChatGPT plan's image limit is used up${it.failure.resetsAt ? ` until ${new Date(it.failure.resetsAt * 1000).toISOString().slice(0, 16)} UTC` : ""}.` : "Image generation failed." });
  }
  const caption = short(String(it.revisedPrompt || "Image"), 300);
  try {
    const path = saveImage(botId, Buffer.from(it.result, "base64"), "png", caption);
    const parentId = imageAt(botId, editOf), id = recordImage(botId, threadId, path, { parentId, model: "gpt-image-2 · ChatGPT plan" });
    addEvent(threadId, turnId, "image", { botId, paths: [path], ids: [id], parentId, caption, model: "gpt-image-2 · ChatGPT plan", cost: null, paintingId: it.id });
  } catch (e: any) { addEvent(threadId, turnId, "error", { text: `The image was made but couldn't be saved: ${short(e.message, 200)}` }); }
}
