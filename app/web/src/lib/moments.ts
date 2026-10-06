import { useSyncExternalStore } from "react";
import type { BotCard, Mood } from "../../../shared/types";

/** pc-bot's one-shot moments, the moods each was drawn to land on, and how long each plays (ds pc-bot css). */
export type Moment = "finish" | "stumble" | "wake" | "doze";
const LANDS: Record<Moment, readonly Mood[]> = { finish: ["done"], stumble: ["failed"], wake: ["idle", "done"], doze: ["sleep"] };
const PLAYS: Record<Moment, number> = { finish: 900, stumble: 1100, wake: 900, doze: 1600 };
// A state refresh already in flight can land with the old mood; the event's own refresh follows within ~0.3 s.
const WAIT = 3000;

const expected = new Map<string, { m: Moment; at: number }>();
const playing = new Map<string, { m: Moment; timer: ReturnType<typeof setTimeout> }>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());
const quiet = () => document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A live event that may end in a moment, once the next state shows the member in the right mood. */
export function expectMoment(botId: string, m: Moment) {
  if (!quiet()) expected.set(botId, { m, at: Date.now() });
}

/** After a reconnect the state re-syncs: anything waiting is old news. */
export function forgetMoments() { expected.clear(); }

/** Called with each fresh state: plays what it expected where the face landed true. Cheap: the map holds only recent events. */
export function landMoments(bots: BotCard[]) {
  if (!expected.size) return;
  const now = Date.now(), hidden = quiet();
  for (const [id, e] of expected) {
    const b = bots.find((x) => x.id === id);
    if (hidden || !b || now - e.at > WAIT) { expected.delete(id); continue; }
    if (!LANDS[e.m].includes(b.mood)) continue;
    expected.delete(id);
    clearTimeout(playing.get(id)?.timer);
    playing.set(id, { m: e.m, timer: setTimeout(() => { playing.delete(id); notify(); }, PLAYS[e.m]) });
    notify();
  }
}

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
/** The moment a member's face is playing, if any, and only over the mood it was drawn for. */
export function useMoment(botId: string | undefined, mood: string): Moment | undefined {
  const m = useSyncExternalStore(subscribe, () => (botId ? playing.get(botId)?.m : undefined));
  return m && (LANDS[m] as readonly string[]).includes(mood) ? m : undefined;
}
