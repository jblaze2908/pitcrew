// noVNC is served by the control plane at /novnc, not bundled: it's loaded at runtime only when a screen is shown.
import { useEffect, useState, type RefObject } from "react";

export interface Rfb extends EventTarget {
  scaleViewport: boolean; resizeSession: boolean; viewOnly: boolean; background: string;
  disconnect(): void;
}
type RfbClass = new (target: HTMLElement, url: string) => Rfb;

const RFB_URL = "/novnc/core/rfb.js";

export async function openScreen(target: HTMLElement, botId: string, viewOnly: boolean): Promise<Rfb> {
  const { default: RFB } = (await import(/* @vite-ignore */ RFB_URL)) as { default: RfbClass };
  const rfb = new RFB(target, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live/${botId}/ws`);
  rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = viewOnly; rfb.background = "transparent";
  return rfb;
}

/** A view-only screen in `el` while `on`, and its status line; disconnects on unmount or when the member changes. */
export function useWatchScreen(el: RefObject<HTMLDivElement | null>, botId: string, on = true) {
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    if (!on || !el.current) return;
    let rfb: Rfb | null = null, gone = false;
    openScreen(el.current, botId, true).then((r) => {
      if (gone) return r.disconnect();
      rfb = r;
      r.addEventListener("connect", () => setStatus("Live"));
      r.addEventListener("disconnect", () => setStatus("Disconnected"));
    }).catch((e: Error) => setStatus(e.message));
    return () => { gone = true; rfb?.disconnect(); };
  }, [botId, on]);
  return status;
}
