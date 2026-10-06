// The transcript's layout: which events draw, which fold into a Steps group or a "Rewound" fold. Pure; runs per render.
import type { ReactNode } from "react";
import type { PitStop, ThreadEvent } from "../../../../shared/types";
import { renderEvent, type EventCtx } from "./Events";

export type Item = { key: string; el: ReactNode } | { key: string; steps: ThreadEvent[] } | { key: string; rewound: ThreadEvent[] };

/** Lays events out in order. Consecutive tool calls of one run share a Steps group, and so do pit stops already decided
 * (a pending one is a card that breaks the group until it's answered). Events that draw nothing don't break a group, and
 * a plan or delegation card draws once, where it first appeared, with its newest snapshot. A run of rewound events
 * folds into one "Rewound" item (inner: laying out that fold's own contents). */
export function layout(events: ThreadEvent[], ctx: EventCtx, inner = false): Item[] {
  const items: Item[] = [];
  const drawn = new Set<string>();
  let group: { turn: string | null; steps: ThreadEvent[] } | null = null;
  let fold: ThreadEvent[] | null = null;
  let lastAgent = false;  // the last drawn item, steps aside, was this member's message
  let lastUser = -1;
  events.forEach((e, i) => { if (e.kind === "user") lastUser = i; });
  events.forEach((e, i) => {
    if (!inner && e.rewound) {
      if (!fold) { fold = []; items.push({ key: `r${e.id}`, rewound: fold }); }
      fold.push(e); group = null; lastAgent = false;
      return;
    }
    fold = null;
    // A script's output is drawn inside its script step (Steps results), never as a row of its own.
    if (e.kind === "tool" && e.data.type === "scriptResult") return;
    const p = e.kind === "pitstop" ? ctx.pits[e.data.id] : undefined;
    if (e.kind === "tool" || (p && p.status !== "pending")) {
      const last = items[items.length - 1];
      if (group && last && "steps" in last && last.steps === group.steps && group.turn === e.turn_id) group.steps.push(e);
      else { group = { turn: e.turn_id, steps: [e] }; items.push({ key: `g${e.id}`, steps: group.steps }); }
      return;
    }
    // A surface updated in place (render_surface with its id) draws where it first appeared, with its newest spec.
    if ((e.kind === "plan" || e.kind === "delegation" || e.kind === "surface") && drawn.has(e.data.id)) return;
    const c = e.kind === "agent" && lastAgent ? { ...ctx, cont: true } : i < lastUser ? { ...ctx, onContinue: undefined } : ctx;
    const el = renderEvent(e, c);
    if (el == null) return;
    lastAgent = e.kind === "agent";
    if (e.kind === "plan" || e.kind === "delegation" || e.kind === "surface") drawn.add(e.data.id);
    group = null;
    items.push({ key: `e${e.id}`, el });
  });
  return items;
}
/** Whether the newest drawn item (steps aside) is the member's own message, so a streaming reply continues it. */
export const endsWithAgent = (events: ThreadEvent[], pits: Record<string, PitStop>) => { for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (e.kind === "tool" || (e.kind === "pitstop" && pits[e.data.id]?.status !== "pending")) continue; return e.kind === "agent"; } return false; };
