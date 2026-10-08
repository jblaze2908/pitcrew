// Small helpers the runtime modules share.
import type { ToolResult } from "../shots.js";

// Where the driver opens Pitcrew, for links in pushes and crew replies: https://PITCREW_HOST, else the local port.
export const HOST = process.env.PITCREW_HOST || `localhost:${process.env.PORT || 8330}`;
export const PUBLIC_URL = process.env.PITCREW_HOST ? `https://${HOST}` : `http://${HOST}`;
// The driver's clock for schedules, notes and day totals: PITCREW_TZ (IANA name), else the process TZ, else UTC.
// The brain must run in the same zone: Codex renders "try again at 4:54 AM" in its own clock (see resume.ts).
export const TZ = (() => {
  const z = process.env.PITCREW_TZ || process.env.TZ || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { return "UTC"; }
})();
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Wall-clock parts of t in TZ. m is 0-based; dow 0 = Sunday. */
export function localParts(t: number) {
  const p: Record<string, string> = {}; for (const x of partsFmt.formatToParts(t)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month - 1, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, dow: WD.indexOf(p.weekday) };
}
const offsetAt = (t: number) => { const p = localParts(t); return Date.UTC(p.y, p.m, p.d, p.hh, p.mm, p.ss) - Math.floor(t / 1000) * 1000; };
/** Epoch ms of a wall-clock time in TZ. Fields overflow like Date.UTC (d + 1 is tomorrow). */
export function localAt(y: number, m: number, d: number, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const t = guess - offsetAt(guess);
  return guess - offsetAt(t);
}
const pad = (n: number) => String(n).padStart(2, "0");
/** "HH:MM" in TZ. */
export const localClock = (t: number) => { const p = localParts(t); return `${pad(p.hh)}:${pad(p.mm)}`; };
/** "YYYY-MM-DD HH:MM" in TZ. */
export const localStamp = (t: number) => { const p = localParts(t); return `${p.y}-${pad(p.m + 1)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`; };
/** hh:mm on t's day in TZ (midnight by default), as epoch ms. */
export const localDayAt = (t: number, hh = 0, mm = 0) => { const p = localParts(t); return localAt(p.y, p.m, p.d, hh, mm); };
/** t's day in TZ shifted by `days`, at hh:mm. DST-safe, unlike adding 86 400 000. */
export const dayAtPlus = (t: number, days: number, hh = 0, mm = 0) => { const p = localParts(t); return localAt(p.y, p.m, p.d + days, hh, mm); };
/** Short zone label for messages: "IST", "EDT", "CET"; the IANA name when the locale only offers "GMT+5:30". */
export const tzLabel = (() => {
  const short = (loc: string) => new Intl.DateTimeFormat(loc, { timeZone: TZ, timeZoneName: "short" }).formatToParts(Date.now()).find((x) => x.type === "timeZoneName")?.value || "";
  if (TZ === "UTC") return "UTC";
  for (const loc of ["en-US", "en-IN", "en-GB"]) { const s = short(loc); if (s && !/^(GMT|UTC)[+-]/.test(s)) return s; }
  return TZ;
})();
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
