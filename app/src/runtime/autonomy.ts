// How much a thread runs without the driver, set per thread. ask (default): pit stops as jev decides. handsfree: only
// paying, signing in, sending, sharing, deleting, or a jev failure stop, plus a site that looks like another or isn't
// https. yolo: nothing stops but jev's hard blocks, the member's own "block" policy and refused sites. One indexed row
// read per gate call.
import { getSetting } from "../db.js";
import { getThread } from "./threads.js";

export const AUTONOMY = ["ask", "handsfree", "yolo"] as const;
export type Autonomy = (typeof AUTONOMY)[number];
const HANDSFREE_ASKS = new Set(["pay", "signin", "send", "share", "delete", "unknown"]);
export const autonomyOf = (threadId: string | null | undefined): Autonomy => {
  const a = threadId ? getThread(threadId)?.autonomy : null;
  return (AUTONOMY as readonly string[]).includes(a || "") ? (a as Autonomy) : "ask";
};
// Whether this thread's autonomy stands in for the driver on an effect jev would have asked about.
export const waived = (a: Autonomy, effect: string) => a === "yolo" || (a === "handsfree" && !HANDSFREE_ASKS.has(effect));
export const AUTONOMY_LABEL: Record<Autonomy, string> = { ask: "Ask first", handsfree: "Hands-free", yolo: "YOLO" };
// The mode a thread the driver starts gets (Settings → Permissions). Schedule, email and delegated threads keep "ask".
export const newThreadAutonomy = (): Autonomy => {
  const a = getSetting("new_thread_mode");
  return (AUTONOMY as readonly string[]).includes(a || "") ? (a as Autonomy) : "ask";
};
