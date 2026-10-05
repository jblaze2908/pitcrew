// Live bus (SSE): every state change the web app draws without a refetch.
import type { ServerResponse } from "node:http";

type Client = Pick<ServerResponse, "writableLength" | "write" | "destroy" | "on">;

// Transcript events go only to clients watching that thread (?thread=); a delta per token to every tab adds up.
const clients = new Map<Client, string | null>(); // res → thread id it watches, or null
const SCOPED = new Set(["event", "delta", "activity", "context", "jev", "queue", "painting", "output"]);
export const SSE_CAP = 1 << 20;
// A client that stopped reading would buffer every event in memory; past the cap it's dropped and EventSource reconnects.
const push = (c: Client, s: string) => { if (c.writableLength > SSE_CAP) { clients.delete(c); c.destroy(); } else c.write(s); };
export const bus = {
  add(res: Client, thread: string | null = null) { clients.set(res, thread); res.on("close", () => clients.delete(res)); },
  emit(type: string, data: Record<string, any>) {
    const scoped = SCOPED.has(type); let s: string | undefined;
    for (const [c, th] of clients) if (!scoped || th === data.threadId) push(c, (s ??= `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  },
};
setInterval(() => { for (const c of clients.keys()) push(c, ": ping\n\n"); }, 25000).unref();
