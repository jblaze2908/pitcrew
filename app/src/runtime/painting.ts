// Images being made right now, per thread. Held in memory only: a restart ends every wait anyway.
import { now } from "../db.js";
import { bus } from "./bus.js";
import type { Painting } from "../../shared/types.js";

const live = new Map<string, Map<string, Painting>>();

export function startPainting(threadId: string, p: Omit<Painting, "startedAt">) {
  const painting = { ...p, startedAt: now() };
  (live.get(threadId) || live.set(threadId, new Map()).get(threadId)!).set(p.id, painting);
  bus.emit("painting", { threadId, id: p.id, painting });
}
export function endPainting(threadId: string, id: string) {
  if (!live.get(threadId)?.delete(id)) return;
  bus.emit("painting", { threadId, id, done: true });
}
/** A turn that ends (or dies) takes its unfinished waits with it. */
export function endPaintings(threadId: string) { for (const id of [...(live.get(threadId)?.keys() || [])]) endPainting(threadId, id); live.delete(threadId); }
export const paintings = (threadId: string) => [...(live.get(threadId)?.values() || [])];
