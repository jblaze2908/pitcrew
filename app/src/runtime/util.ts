// Small helpers the runtime modules share.
import type { ToolResult } from "../shots.js";

// Asia/Kolkata (UTC+5:30, no DST).
export const IST = 330 * 60000;
export function short(s: unknown, n = 160) { const t: string = typeof s === "string" ? s : JSON.stringify(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
export function summariseArgs(a: any) {
  if (!a || typeof a !== "object") return "";
  const pick = a.element || a.target || a.field || a.purpose || a.url || a.text || a.ref || "";
  return pick ? String(pick) : Object.entries(a).map(([k, v]) => `${k}=${short(v, 40)}`).join(" ");
}
export const hostOf = (url: string | null | undefined) => { try { return url ? new URL(url).hostname : ""; } catch { return ""; } };
// A dynamic tool's reply to the brain.
export const say = (text: string, success = true): ToolResult => ({ success, contentItems: [{ type: "inputText", text }] });
