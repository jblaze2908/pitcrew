// Hash routes: #/<name>/<arg>/<arg>… The stream follows the open thread before any view fetches.
import { useSyncExternalStore } from "react";
import { watchThread } from "./live";

export interface Route { name: string; args: string[]; hash: string }

function parse(hash: string): Route {
  const [name, ...args] = (hash.replace(/^#\/?/, "") || "wall").split("/");
  return { name: name || "wall", args, hash };
}

let current = parse(location.hash);
let backTo: string | null = null; // where the live view's Back returns to
let streaming = false;
const listeners = new Set<() => void>();

export const threadOf = (r: Route) => (r.name === "t" ? r.args[0] || null : null);

window.addEventListener("hashchange", () => {
  const prev = current.hash;
  current = parse(location.hash);
  if (current.name === "live" && prev && !prev.startsWith("#/live")) backTo = prev;
  if (streaming) watchThread(threadOf(current));
  listeners.forEach((fn) => fn());
});

/** Starts the live stream for the current route; later route changes keep it pointed at the open thread. */
export function startStream() { streaming = true; watchThread(threadOf(current)); }

export function useRoute(): Route {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => current);
}

export const liveBackTo = () => backTo;
export const go = (hash: string) => { location.hash = hash; };
