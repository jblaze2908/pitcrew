// One SSE stream per tab. The open thread rides on ?thread=, so its transcript events reach only the tab showing it.
import { useEffect, useRef } from "react";
import type { StreamEvents, StreamType } from "../../../shared/types";

export type LiveEvent = { [K in StreamType]: { type: K; data: StreamEvents[K] } }[StreamType];

const TYPES: StreamType[] = ["thread", "turn", "pitstop", "computer", "paused", "lease", "event", "delta", "activity", "context", "queue"];
/** Events that change /api/state; the rest only matter to an open thread. */
export const GLOBAL: ReadonlySet<StreamType> = new Set(["thread", "turn", "pitstop", "computer", "paused", "lease"]);

let es: EventSource | null = null;
let watching: string | null = null;
const handlers = new Set<(e: LiveEvent) => void>();

function connect(thread: string | null) {
  es?.close();
  watching = thread;
  const src = new EventSource(thread ? `/api/stream?thread=${encodeURIComponent(thread)}` : "/api/stream");
  for (const type of TYPES) {
    src.addEventListener(type, (m) => {
      const e = { type, data: JSON.parse((m as MessageEvent<string>).data) } as LiveEvent;
      handlers.forEach((fn) => fn(e));
    });
  }
  // The browser retries on its own; this only covers a stream it gave up on.
  src.onerror = () => { setTimeout(() => { if (es === src && src.readyState === EventSource.CLOSED) connect(watching); }, 3000); };
  es = src;
}

/** Points the stream at a thread (or none). Reconnects only when that changes. */
export function watchThread(thread: string | null) {
  if (!es || thread !== watching) connect(thread);
}

/** Calls fn for every stream event while the component is mounted; fn may change between renders. */
export function useLive(fn: (e: LiveEvent) => void) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    const h = (e: LiveEvent) => ref.current(e);
    handlers.add(h);
    return () => { handlers.delete(h); };
  }, []);
}

/** Reloads a view's own data after matching events, debounced so a burst costs one fetch. */
export function useLiveReload(match: (e: LiveEvent) => boolean, reload: () => void, delay = 600) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLive((e) => {
    if (!match(e)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, delay);
  });
}
