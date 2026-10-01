// noVNC is served by the control plane at /novnc, not bundled: it's loaded at runtime only when a screen is shown.
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
