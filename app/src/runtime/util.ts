// Small helpers the runtime modules share.
import type { ToolResult } from "../shots.js";

// Asia/Kolkata (UTC+5:30, no DST): the driver's clock for schedules, notes and day totals.
export const IST = 330 * 60000;
/** "HH:MM" in IST. */
export const istClock = (t: number) => new Date(t + IST).toISOString().slice(11, 16);
/** "YYYY-MM-DD HH:MM" in IST. */
export const istStamp = (t: number) => new Date(t + IST).toISOString().slice(0, 16).replace("T", " ");
/** hh:mm IST on t's IST day (midnight by default), as epoch ms. */
export const istDayAt = (t: number, hh = 0, mm = 0) => { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - IST; };
export function short(s: unknown, n = 160) { const t: string = typeof s === "string" ? s : JSON.stringify(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
export function summariseArgs(a: any) {
  if (!a || typeof a !== "object") return "";
  const pick = a.element || a.target || a.field || a.purpose || a.url || a.text || a.ref || "";
  return pick ? String(pick) : Object.entries(a).map(([k, v]) => `${k}=${short(v, 40)}`).join(" ");
}
// A step's input as the driver sees it when debugging: the arguments as JSON, capped, with secret-looking values
// replaced, by key (password, token, otp…) or, for a form field, by its label ({name: "Password", value: …}).
const SECRET = /pass(word|code|phrase)?|secret|token|api[_-]?key|\botp\b|one[- ]time|\bpin\b|cvv|cvc|card[ _-]?(number|no)|credential|cookie|authori[sz]ation/i;
export function debugArgs(a: unknown, max = 4000): string | null {
  if (a == null) return null;
  const walk = (v: any, d: number): any => {
    if (d > 6) return "…";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, d + 1));
    if (v && typeof v === "object") {
      const named = [v.name, v.label, v.element, v.field, v.purpose].some((x) => typeof x === "string" && SECRET.test(x));
      return Object.fromEntries(Object.entries(v).slice(0, 80).map(([k, x]) => [k, SECRET.test(k) || (named && /^(value|text|values)$/.test(k)) ? "[redacted]" : walk(x, d + 1)]));
    }
    return typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v;
  };
  const s = JSON.stringify(walk(a, 0));
  return s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null;
}
/** Markdown emphasis, headings and quotes dropped, links reduced to their text. */
export const unmark = (s: unknown) => String(s || "").replace(/[*_`#>]+|\[([^\]]*)\]\([^)]*\)/g, "$1");
/** A shell command without the "/bin/sh -lc " Codex wraps it in, for titles. */
export const bareCommand = (c: unknown) => String(c || "").replace(/^\/bin\/(ba)?sh -l?c /, "");
export const hostOf = (url: string | null | undefined) => { try { return url ? new URL(url).hostname : ""; } catch { return ""; } };
// A dynamic tool's reply to the brain.
export const say = (text: string, success = true): ToolResult => ({ success, contentItems: [{ type: "inputText", text }] });
