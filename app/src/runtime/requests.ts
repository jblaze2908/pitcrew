// Requests from a brain that need an answer: command, file and MCP approvals, and dynamic tool calls.
import type { Brain } from "../computer.js";
import { byCodex, items } from "./state.js";
import { gate } from "./gate.js";
import { pitStop } from "./pitstops.js";
import { dynamicTool } from "./tools.js";
import type { ToolCall } from "./browser.js";
import { short, summariseArgs, bareCommand } from "./util.js";
import { audit } from "../db.js";

export async function onRequest(c: Brain, method: string, p: Record<string, any>) {
  const threadId = byCodex.get(p.threadId);
  if (!threadId) return method === "item/tool/call" ? { success: false, contentItems: [{ type: "inputText", text: "Unknown thread" }] } : { decision: "decline" };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const call = { kind: "shell", command: p.command, cwd: p.cwd };
      const ok = await gate(c, threadId, call, { kind: "command", title: `Run: ${short(bareCommand(p.command), 180)}`, detail: { command: p.command, cwd: p.cwd, reason: p.reason || null } });
      return { decision: ok ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const paths: string[] = (items.get(p.itemId)?.changes || []).map((x) => x.path);
      const inside = paths.length && paths.every((x) => x.startsWith("/bot/work/") || !x.startsWith("/"));
      if (inside) return { decision: "accept" };
      const ok = await pitStop({ botId: c.bot.id, threadId, kind: "file", effect: "write", title: `Edit files outside the workspace: ${paths.join(", ").slice(0, 160) || "unknown"}`, detail: { paths, reason: p.reason || null, signature: "file:outside" } });
      return { decision: ok === "approved" ? "accept" : "decline" };
    }
    case "mcpServer/elicitation/request": {
      const tool = /tool "([^"]+)"/.exec(p.message || "")?.[1];
      const args = p._meta?.tool_params || {};
      if (!tool) {
        const ok = await pitStop({ botId: c.bot.id, threadId, kind: "mcp", effect: "ask", title: `${p.serverName} asks: ${short(p.message, 160)}`, detail: { server: p.serverName, message: p.message } });
        return ok === "approved" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
      }
      // Only the driver's own MCP connectors reach here now; browser and pixel tools are Pitcrew tools (runtimeTool).
      const ok = await gate(c, threadId, { kind: "mcp", server: p.serverName, tool, arguments: args }, { kind: "mcp", title: `${p.serverName}: ${tool.replace(/_/g, " ")} ${short(summariseArgs(args), 140)}`, detail: { server: p.serverName, tool, args } });
      return ok ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
    }
    // A throw here reached the model only as "dynamic tool request failed" and was logged nowhere: say what broke instead.
    case "item/tool/call": try { return await dynamicTool(c, threadId, p as ToolCall); } catch (e: any) {
      console.error(`[tool] ${p.tool} failed for ${c.bot.id}:`, e?.stack || e);
      audit("system", "tool.crashed", { botId: c.bot.id, threadId, tool: p.tool, error: String(e?.message || e).slice(0, 300) });
      return { success: false, contentItems: [{ type: "inputText", text: `Pitcrew's ${p.tool} tool crashed (${String(e?.message || e).slice(0, 200)}). That's a Pitcrew bug, not your input: don't retry it the same way; use another route if there is one and tell the driver.` }] };
    }
    case "item/permissions/requestApproval": return { decision: "decline" };
    default: return undefined;
  }
}
