// Screen lease: the driver takes a member's computer in the live view; the crew waits or asks for it back.
import { all, now, audit } from "../db.js";
import { getBot } from "../crew.js";
import type { Call } from "../jev.js";
import { bus } from "./bus.js";
import { active, leases } from "./state.js";
import { getThread, addEvent } from "./threads.js";
import { pitStop, decide } from "./pitstops.js";
import { sendMessage } from "./turns.js";

// While the driver holds the screen, the crew asks for it back through a pit stop instead of waiting blind.
export async function waitLease(botId: string, threadId: string, call: Call) {
  const l = leases.get(botId);
  if (!l) return true;
  // One ask per lease: every call that lands while it's open waits on the same pit stop.
  l.ask ??= pitStop({ botId, threadId, kind: "lease", effect: "ask", title: `${getBot(botId)?.name || "The crew"} needs the computer back`, detail: { server: call.server, tool: call.tool } })
    .then((d) => { if (d === "approved") releaseLease(botId, "computer.lease_granted"); else if (leases.get(botId) === l) l.ask = null; return d === "approved"; });
  return Promise.race([new Promise<boolean>((res) => l.waiters.push(res)), l.ask]);
}

export function takeControl(botId: string) { if (!leases.has(botId)) leases.set(botId, { since: now(), waiters: [] }); audit("driver", "computer.take_control", { botId }); bus.emit("lease", { botId, held: true }); }
export function releaseLease(botId: string, action: string, why?: string) {
  const l = leases.get(botId);
  if (!l) return;
  leases.delete(botId);
  l.waiters.forEach((w) => w(true));
  audit("driver", action, { botId });
  bus.emit("lease", { botId, held: false });
  for (const ps of all<{ id: string }>("SELECT id FROM pitstops WHERE bot_id=? AND kind='lease' AND status='pending'", botId)) decide(ps.id, "approve", { note: "Control handed back" });
  if (why) for (const [tid, a] of active) if (getThread(tid)?.bot_id === botId) addEvent(tid, a.turnId, "system", { text: why });
}
export function handBack(botId: string, note = "") {
  releaseLease(botId, "computer.hand_back");
  if (note.trim()) for (const [tid] of active) if (getThread(tid)?.bot_id === botId) sendMessage(tid, { text: `I handed the computer back. ${note}`, mode: "auto" }).catch(() => {});
}
export const leaseHeld = (botId: string) => leases.has(botId);
