// The global /api/state, refetched (debounced) after any event that can change it. Chrome and the wall draw from it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BotCard, State } from "../../../shared/types";
import { api } from "./api";
import { GLOBAL, useLive, useResync } from "./live";

interface Store {
  S: State;
  setS: (s: State) => void;
  refresh: () => Promise<void>;
  bot: (id: string | null | undefined) => BotCard | undefined;
  /** A member's display name, a retired one's included; never the raw id. */
  name: (id: string | null | undefined) => string;
  chief: BotCard | undefined;
  /** A thread's title from the state's recent threads (12 a member); undefined for older ones. */
  threadTitle: (id: string | null | undefined) => string | undefined;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ initial, children }: { initial: State; children: ReactNode }) {
  const [S, setS] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    const next = await api.get<State>("/api/state", { quiet: true }).catch(() => null);
    if (next) setS(next);
  }, []);

  useResync(() => { refresh(); });
  useLive((e) => {
    if (!GLOBAL.has(e.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 250);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo<Store>(() => {
    const byId = new Map(S.bots.map((b) => [b.id, b]));
    const titles = new Map(S.bots.flatMap((b) => b.threads.map((t) => [t.id, t.title] as const)));
    return {
      S, setS, refresh,
      bot: (id) => (id ? byId.get(id) : undefined),
      name: (id) => (id && (byId.get(id)?.name || S.formerNames?.[id])) || "A former member",
      chief: S.bots.find((b) => b.kind === "chief"),
      threadTitle: (id) => (id ? titles.get(id) : undefined),
    };
  }, [S, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export const connected = (S: State) => Object.values(S.providers).some((p) => p.connected);
