// Notifications from a brain: streamed text, tool activity, token usage and turn ends, turned into events and SSE.
import { run } from "../db.js";
import { recordChatgptLimits } from "../providers.js";
import type { Brain } from "../computer.js";
import { bus } from "./bus.js";
import { active, byCodex, items, usage } from "./state.js";
import { addEvent } from "./threads.js";
import { finishTurn } from "./turns.js";
import { subtract } from "./spend.js";
import { short, summariseArgs } from "./util.js";
import { connName } from "../engram.js";
import { scanScripts } from "./scripts.js";

// A Codex thread item (commandExecution, mcpToolCall, fileChange, …) as the app-server sends it.
type Item = Record<string, any>;
function toolTitle(it: Item) {
  switch (it.type) {
    case "commandExecution": return `$ ${short(String(it.command || "").replace(/^\/bin\/(ba)?sh -l?c /, ""), 200)}`;
    case "mcpToolCall": return `${it.server === "browser" ? it.tool.replace(/^browser_/, "") : `${it.server}.${it.tool}`} ${short(summariseArgs(it.arguments), 140)}`;
    case "dynamicToolCall": return `${it.tool}`;
    case "fileChange": return `Edited ${(it.changes || []).map((c) => c.path).join(", ").slice(0, 200)}`;
    case "webSearch": return `Searched “${short(it.query, 120)}”`;
    default: return it.type;
  }
}
function mcpResultText(it: Item) {
  const c = it.result?.content || it.result?.contentItems || [];
  return (Array.isArray(c) ? c : []).filter((x) => x.type === "text").map((x) => x.text).join("\n").slice(0, 1500);
}

export function onNotify(c: Brain, method: string, p: Record<string, any>) {
  if (method === "account/rateLimits/updated") return recordChatgptLimits(p.rateLimits);
  const threadId = p.threadId ? byCodex.get(p.threadId) : null;
  if (!threadId) return;
  const a = active.get(threadId);
  switch (method) {
    case "item/agentMessage/delta": bus.emit("delta", { threadId, itemId: p.itemId, text: p.delta }); break;
    case "item/started": {
      const it = p.item; items.set(it.id, it);
      // A Code Mode script's nested call: show the script (from the rollout) before its calls.
      if (typeof it.id === "string" && it.id.startsWith("exec-")) scanScripts(threadId, a?.turnId, c.bot.id, p.threadId);
      // Browser and pixel tools announce themselves from their own handler, with the grounded element.
      if (["commandExecution", "mcpToolCall", "fileChange", "webSearch"].includes(it.type) || (it.type === "dynamicToolCall" && !/^(browser|computer)_/.test(it.tool)))
        bus.emit("activity", { threadId, botId: c.bot.id, text: toolTitle(it) });
      break;
    }
    case "item/completed": {
      const it = p.item; items.delete(it.id);
      const via = typeof it.id === "string" && it.id.startsWith("exec-") ? { viaScript: true } : {};
      if (it.type === "agentMessage" && it.text?.trim()) addEvent(threadId, a?.turnId, "agent", { text: it.text, itemId: it.id });
      else if (it.type === "commandExecution") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, exitCode: it.exitCode ?? null, output: String(it.aggregatedOutput || "").slice(-1500), ...via });
      else if (it.type === "mcpToolCall") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status, output: mcpResultText(it), error: it.error?.message || null,
        ...(it.server === "engram" ? { conn: connName(c.bot.id, String(it.tool)) } : {}), ...via });
      else if (it.type === "fileChange") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: it.status });
      else if (it.type === "webSearch") addEvent(threadId, a?.turnId, "tool", { type: it.type, title: toolTitle(it), status: "completed" });
      else if (it.type === "contextCompaction") addEvent(threadId, a?.turnId, "system", { text: "Thread compacted." });
      break;
    }
    case "thread/tokenUsage/updated": {
      const tu = p.tokenUsage;
      if (a) { if (!a.base) a.base = usage.get(p.threadId) || subtract(tu.total, tu.last); a.total = tu.total; }
      usage.set(p.threadId, tu.total);
      run("UPDATE threads SET ctx_tokens=?, ctx_window=? WHERE id=?", tu.last.inputTokens, tu.modelContextWindow, threadId);
      bus.emit("context", { threadId, tokens: tu.last.inputTokens, window: tu.modelContextWindow });
      break;
    }
    case "turn/completed": scanScripts(threadId, a?.turnId, c.bot.id, p.threadId); if (a) finishTurn(threadId, p.turn.status, p.turn.status === "failed" ? (p.turn.error?.message || "The run failed") : null); break;
    case "error": if (!p.willRetry) addEvent(threadId, a?.turnId, "error", { text: short(p.error?.message || "Model error", 500) }); break;
    case "thread/compacted": addEvent(threadId, null, "system", { text: "Thread compacted." }); break;
  }
}
