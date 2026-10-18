// Formatting shared by every view. Times show in the browser's zone, which is the driver's.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Money in surfaces is in the host's currency (/api/state currency, set once at boot); numbers use the browser's locale.
let currency = "USD";
const numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
let moneyFmt = new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 });
let moneyCompact = new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
export function setCurrency(code: string | undefined) {
  if (!code || code === currency) return;
  try {
    moneyFmt = new Intl.NumberFormat(undefined, { style: "currency", currency: code, minimumFractionDigits: 0, maximumFractionDigits: 2 });
    moneyCompact = new Intl.NumberFormat(undefined, { style: "currency", currency: code, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
    currency = code;
  } catch { /* an unknown code keeps the last one */ }
}
export const currencyCode = () => currency;
export const currencySymbol = () => moneyFmt.formatToParts(0).find((p) => p.type === "currency")?.value || currency;
export const num = (v: number) => numFmt.format(v);
export const money = (v: number) => moneyFmt.format(v);
/** Short forms for axis ticks and tight spots: 1.2K, $3.5M (the locale's own, e.g. ₹1.2L in en-IN). */
export const numShort = (v: number) => (Math.abs(v) >= 1e4 ? compactFmt.format(v) : numFmt.format(v));
export const moneyShort = (v: number) => (Math.abs(v) >= 1e4 ? moneyCompact.format(v) : moneyFmt.format(v));

/** A zone as people say it: "India Standard Time", "Central European Time"; the IANA name if the browser has none. */
export const zoneName = (timeZone: string) => {
  try { return new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "longGeneric" }).formatToParts(0).find((p) => p.type === "timeZoneName")?.value || timeZone; } catch { return timeZone; }
};

export const usd = (n: number | null | undefined) => { const v = n || 0; return `$${v.toFixed(v > 0 && v < 0.1 ? 3 : 2)}`; };

export const ago = (t: number | null | undefined) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const whenFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ZONE });
const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", timeZone: ZONE });

export const when = (t: number | null | undefined) => (t ? whenFmt.format(new Date(t)) : "");
export const hourNow = () => +hourFmt.format(new Date());

const hmFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE });
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
export const hm = (t: number) => hmFmt.format(new Date(t));
/** "Today", "Yesterday" or "Thu 2 Oct", by the local calendar day. */
export const dayLabel = (t: number) => {
  const k = keyFmt.format(new Date(t));
  return k === keyFmt.format(new Date()) ? "Today" : k === keyFmt.format(new Date(Date.now() - 86400000)) ? "Yesterday" : dayFmt.format(new Date(t)).replace(",", "");
};

const wdFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: ZONE });
const dmFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: ZONE });
/** "3 Oct" by the local calendar; newer ICU writes September "Sept", the rest of the app says "Sep". */
export const dayMonth = (t: number | null | undefined) => (t ? dmFmt.format(new Date(t)).replace("Sept", "Sep") : "");
/** A log time: "07:38" today, "Sun 23:31" within the week, "3 Oct" before that. */
export const stamp = (t: number) => {
  if (keyFmt.format(new Date(t)) === keyFmt.format(new Date())) return hm(t);
  return Date.now() - t < 6 * 86400000 ? `${wdFmt.format(new Date(t))} ${hm(t)}` : dayMonth(t);
};
/** "07:02" today, "yesterday 22:00", "Fri 23:33" within the week, else "3 Oct 23:33". */
export const sinceLabel = (t: number) => {
  const d = dayLabel(t);
  return d === "Today" ? hm(t) : d === "Yesterday" ? `yesterday ${hm(t)}` : Date.now() - t < 6 * 86400000 ? `${wdFmt.format(new Date(t))} ${hm(t)}` : `${dayMonth(t)} ${hm(t)}`;
};

export const until = (t: number) => {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
};

export const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** "1 memory", "2 memories"; pass `many` for other irregular words. */
export const plural = (n: number, word: string, many?: string) => `${n} ${n === 1 ? word : many ?? (/[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`)}`;

/** Markdown flattened to one line for a list cell: heading, list, quote and table markers go; inline code and bold stay for <Inline>. */
export const flat = (t: string | null | undefined) => String(t || "").replace(/^\s*\|?[\s:|-]*-[\s:|-]*$/gm, "").replace(/[ \t]*\|[ \t]*/g, " ").replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim();
export const plainText = (t: string | null | undefined) => String(t || "").replace(/[*_#`>|]/g, "").replace(/\s+/g, " ").trim();
// Older events carry the model-facing snapshot attributes; show role and name only.
export const tidyTitle = (s: string | null | undefined) => String(s || "").replace(/ · pinned$/, "").replace(/\s*\[[a-z-]+(=[^\]]*)?\]/g, "").replace(/:(?=\s|$)/g, "");
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "/bin/zsh -lc 'curl …'" → "curl …": the shell wrapper Codex puts around every command. */
export const unwrapShell = (s: string) => s.replace(/^\/bin\/(ba|z)?sh -l?c /, "").replace(/^(["'])([\s\S]*)\1$/, "$2");
// Stored notes, titles and reasons name internals ("jev", "YOLO", "the driver"); the UI says them in plain words.
export const plainWords = (s: string | null | undefined) => String(s || "")
  .replace(/\bjev's\b/g, "the safety check's").replace(/\bjev\b/g, "the safety check")
  .replace(/\b[Tt]he driver's\b/g, "your").replace(/\bThe driver\b/g, "You").replace(/\bthe driver\b/g, "you")
  .replace(/\/bin\/(ba|z)?sh -l?c (["'])([\s\S]*?)\2/g, "$3").replace(/\/bin\/(ba|z)?sh -l?c /g, "");
export const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
