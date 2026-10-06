// Live bus (SSE): every state change the web app draws without a refetch.
import type { ServerResponse } from "node:http";
import type { ToolKind } from "../../shared/types.js";

type Client = Pick<ServerResponse, "writableLength" | "write" | "destroy" | "on">;

// Transcript events go only to clients watching that thread (?thread=); a delta per token to every tab adds up.
const clients = new Map<Client, string | null>(); // res → thread id it watches, or null
const SCOPED = new Set(["event", "delta", "activity", "context", "jev", "queue", "painting", "output"]);
export const SSE_CAP = 1 << 20;
// The newest activity line per thread (what the open thread shows under its steps), for side questions (side.ts).
// Cleared when the run ends.
export const activityNow = new Map<string, string>();
/** threadId → the kind of tool its running turn has in flight; set by activity, cleared at turn end. In memory only. */
export const toolNow = new Map<string, { botId: string; kind: ToolKind }>();
// A client that stopped reading would buffer every event in memory; past the cap it's dropped and EventSource reconnects.
const push = (c: Client, s: string) => { if (c.writableLength > SSE_CAP) { clients.delete(c); c.destroy(); } else c.write(s); };
export const bus = {
  add(res: Client, thread: string | null = null) { clients.set(res, thread); res.on("close", () => clients.delete(res)); },
  emit(type: string, data: Record<string, any>) {
    const scoped = SCOPED.has(type); let s: string | undefined;
    if (type === "activity" && data.threadId) {
      activityNow.set(data.threadId, String(data.text || "").slice(0, 300));
      if ("toolKind" in data && data.botId) setToolKind(data.threadId, data.botId, data.toolKind ?? null);
    }
    for (const [c, th] of clients) if (!scoped || th === data.threadId) push(c, (s ??= `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  },
};
// The scoped activity event can't reach the sidebar, so a change of kind also goes to every client (once per change, not per call).
export function setToolKind(threadId: string, botId: string, kind: ToolKind | null) {
  const prev = toolNow.get(threadId)?.kind ?? null;
  if (kind) toolNow.set(threadId, { botId, kind }); else toolNow.delete(threadId);
  if (prev !== kind) bus.emit("tool", { threadId, botId, toolKind: kind });
}
/** A member's in-flight tool kind, from any of its running threads. Runs per member per /api/state; the map holds only live turns. */
export function toolKindOf(botId: string): ToolKind | null {
  for (const t of toolNow.values()) if (t.botId === botId) return t.kind;
  return null;
}
setInterval(() => { for (const c of clients.keys()) push(c, ": ping\n\n"); }, 25000).unref();
