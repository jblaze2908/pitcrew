// A small view-only window onto one crew member's screen that stays put while you move around the app.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bot } from "../../../shared/types";
import { useWatchScreen } from "../lib/novnc";
import { Face } from "./ui";

type Docked = Pick<Bot, "id" | "name" | "hue" | "shape">;
interface DockApi { docked: Docked | null; openDock: (b: Docked) => void; closeDock: () => void }
const Ctx = createContext<DockApi>({ docked: null, openDock: () => {}, closeDock: () => {} });
export const useDock = () => useContext(Ctx);

export function DockProvider({ children }: { children: ReactNode }) {
  const [docked, setDocked] = useState<Docked | null>(null);
  const closeDock = useCallback(() => setDocked(null), []);
  const api = useMemo<DockApi>(() => ({ docked, openDock: setDocked, closeDock }), [docked, closeDock]);
  return <Ctx.Provider value={api}>{children}{docked && <Dock key={docked.id} b={docked} onClose={closeDock} />}</Ctx.Provider>;
}

function Dock({ b, onClose }: { b: Docked; onClose: () => void }) {
  const screen = useRef<HTMLDivElement>(null);
  const status = useWatchScreen(screen, b.id);
  return (
    <div className="dock">
      <div className="bar"><Face b={b} size="xs" /><b className="small">{b.name}</b><span className="small faint">{status}</span><span style={{ flex: 1 }} />
        <a className="small" href={`#/live/${b.id}`}>Expand</a><button className="small faint" title="Stop watching" onClick={onClose}>✕</button></div>
      <div ref={screen} className="vnc" />
    </div>
  );
}
