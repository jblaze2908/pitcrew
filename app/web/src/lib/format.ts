// Formatting shared by every view. Times show in IST, the driver's zone.
const IST = "Asia/Kolkata";

export const usd = (n: number | null | undefined) => { const v = n || 0; return `$${v.toFixed(v > 0 && v < 0.1 ? 3 : 2)}`; };

export const ago = (t: number | null | undefined) => {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const clockFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: IST });
const whenFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: IST });
const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", timeZone: IST });

export const clock = () => clockFmt.format(new Date()).replace(",", "");
export const when = (t: number | null | undefined) => (t ? whenFmt.format(new Date(t)) : "");
export const hourNow = () => +hourFmt.format(new Date());

const hmFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: IST });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST });
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
export const hm = (t: number) => hmFmt.format(new Date(t));
/** "Today", "Yesterday" or "Thu 2 Oct", by the IST calendar day. */
export const dayLabel = (t: number) => {
  const k = keyFmt.format(new Date(t));
  return k === keyFmt.format(new Date()) ? "Today" : k === keyFmt.format(new Date(Date.now() - 86400000)) ? "Yesterday" : dayFmt.format(new Date(t)).replace(",", "");
};

const wdFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: IST });
const dmFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: IST });
/** A log time: "07:38" today, "Sun 23:31" within the week, "3 Oct" before that. */
export const stamp = (t: number) => {
  if (keyFmt.format(new Date(t)) === keyFmt.format(new Date())) return hm(t);
  return Date.now() - t < 6 * 86400000 ? `${wdFmt.format(new Date(t))} ${hm(t)}` : dmFmt.format(new Date(t));
};
/** "07:02" today, "yesterday 22:00", "Fri 23:33" within the week, else "3 Oct 23:33". */
export const sinceLabel = (t: number) => {
  const d = dayLabel(t);
  return d === "Today" ? hm(t) : d === "Yesterday" ? `yesterday ${hm(t)}` : Date.now() - t < 6 * 86400000 ? `${wdFmt.format(new Date(t))} ${hm(t)}` : `${dmFmt.format(new Date(t))} ${hm(t)}`;
};

export const until = (t: number) => {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
};

export const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const tokens = (n: number | null | undefined) => (n || 0).toLocaleString("en-IN");
/** "1 memory", "2 memories"; pass `many` for other irregular words. */
export const plural = (n: number, word: string, many?: string) => `${n} ${n === 1 ? word : many ?? (/[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`)}`;

/** Markdown flattened to one line for a list cell: heading, list and quote markers go; inline code and bold stay for <Inline>. */
export const flat = (t: string | null | undefined) => String(t || "").replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim();
export const plainText = (t: string | null | undefined) => String(t || "").replace(/[*_#`>|]/g, "").replace(/\s+/g, " ").trim();
// Older events carry the model-facing snapshot attributes; show role and name only.
export const tidyTitle = (s: string | null | undefined) => String(s || "").replace(/\s*\[[a-z-]+(=[^\]]*)?\]/g, "").replace(/:(?=\s|$)/g, "");
export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
