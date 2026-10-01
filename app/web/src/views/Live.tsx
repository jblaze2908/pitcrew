// A member's screen, full size: watch, or take control (a lease) and hand it back with a note for the crew.
import { useEffect, useRef, useState } from "react";
import type { BotDetail } from "../../../shared/types";
import { useDock } from "../components/Dock";
import { Face } from "../components/ui";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { openScreen, type Rfb } from "../lib/novnc";
import { go, liveBackTo } from "../lib/router";
import { useFetch } from "../lib/useFetch";

export function Live({ id }: { id: string }) {
  const { data, error } = useFetch(() => api.get<BotDetail>(`/api/bots/${id}`), [id]);
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  return data ? <Screen d={data} /> : null;
}

function Screen({ d }: { d: BotDetail }) {
  const b = d.bot, id = b.id;
  const { docked, openDock, closeDock } = useDock();
  const [held, setHeld] = useState(b.computer.lease);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("Connecting…");
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<Rfb | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const back = liveBackTo() || `#/crew/${id}`;

  // Opening the full view replaces a corner view of the same screen; Minimize opens it again on the way out.
  const dockedOnOpen = useRef(docked?.id === id);
  useEffect(() => { if (dockedOnOpen.current) closeDock(); }, [closeDock]);
  useEffect(() => { if (rfb.current) rfb.current.viewOnly = !held; }, [held]);
  useLive((e) => { if (e.type === "lease" && e.data.botId === id) setHeld(e.data.held); });

  useEffect(() => {
    let gone = false;
    (async () => {
      if (!b.computer.up) {
        setStatus("Starting the computer…");
        await api.post(`/api/bots/${id}/computer/start`).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (gone) return;
      const r = await openScreen(screen.current!, id, !heldRef.current);
      if (gone) return r.disconnect();
      rfb.current = r;
      r.addEventListener("connect", () => setStatus(heldRef.current ? "Live · you have control" : "Live · watching"));
      r.addEventListener("disconnect", () => setStatus("Disconnected"));
    })().catch((e: Error) => setStatus(e.message));
    return () => { gone = true; rfb.current?.disconnect(); rfb.current = null; };
  }, [id, b.computer.up]);

  const toggleLease = async () => {
    if (held) { await api.post(`/api/bots/${id}/computer/handback`, { note }); setNote(""); setHeld(false); }
    else { await api.post(`/api/bots/${id}/computer/take`); setHeld(true); }
  };
  return (
    <div className="liveview">
      <header>
        <Face b={b} size="sm" /><b className="pc-h3">{`${b.name}'s computer`}</b><span className="small faint">{status}</span><span style={{ flex: 1 }} />
        {held && <input placeholder="What changed? (sent to the crew when you hand back)" className="small" style={{ maxWidth: 380 }} value={note} onChange={(e) => setNote(e.target.value)} />}
        <button className="pc-pill sig s" onClick={toggleLease}>{held ? "Hand back" : "Take control"}</button>
        <button className="pc-pill o s" title="Keep watching in a corner" onClick={() => { go(back); openDock(b); }}>Minimize</button>
        <a className="pc-pill o s" href={back}>{back.startsWith("#/t/") ? "Back to chat" : "Back"}</a>
      </header>
      <div className="screen"><div ref={screen} className="vnc" /></div>
    </div>
  );
}
