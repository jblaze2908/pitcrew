// Text helpers shared by the server and the web app; the unit tests use them too.

/** A file's lines. The newline that ends the last line opens no extra line, and an empty file has none. */
export const textLines = (t: string | null | undefined): string[] => (t ? t.replace(/\r?\n$/, "").split(/\r?\n/) : []);

const MSG_KEYS = ["message", "detail", "error_description", "error"];
function findMessage(o: unknown, depth = 0): string {
  if (!o || typeof o !== "object" || depth > 4) return "";
  const r = o as Record<string, unknown>;
  for (const k of MSG_KEYS) if (typeof r[k] === "string" && (r[k] as string).trim()) return (r[k] as string).trim();
  for (const v of Object.values(r)) { const m = findMessage(v, depth + 1); if (m) return m; }
  return "";
}
/** The JSON body inside a provider error ("400 {…}"), or null when there is none. */
function errorBody(s: string): unknown {
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

/** A run error as one readable line: the message inside a JSON error body, else the text itself. */
export function errorLine(raw: string | null | undefined): string {
  const s = String(raw || "").trim();
  return findMessage(errorBody(s)) || s;
}

/** The raw error laid out for reading (JSON indented), or null when errorLine already says all of it. */
export function errorDetail(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim(), body = errorBody(s);
  if (!body) return null;
  const i = s.indexOf("{"), lead = s.slice(0, i).trim();
  return `${lead ? `${lead}\n` : ""}${JSON.stringify(body, null, 2)}`;
}
