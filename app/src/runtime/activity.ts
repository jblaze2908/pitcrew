// Crew activity: everything done on the driver's behalf, read from what the gate already records. jev_labels holds one
// row per gate decision (allowed calls and the pit stops the driver approved); approved pit stops that never passed the
// gate (file deletions, hires, member changes) come from pitstops. Blocked, denied and expired calls did nothing, so
// they aren't listed; nor are reads, browsing, drafts and workspace writes, unless the driver approved one by hand.
import { all, json } from "../db.js";
import type { ActivityPage, ActivityRow, AllowedBy } from "../../shared/types.js";

export const QUIET_EFFECTS = ["read", "browse", "draft", "write_workspace"];
export const ALLOWED_BY: readonly AllowedBy[] = ["once", "always", "autonomy", "learned", "jev", "rules"];
// Pit stops about the crew itself, not an action taken for the driver.
const NOT_ACTIONS = ["engram", "lease"];
export interface ActivityQuery { bot?: string | null; effect?: string | null; by?: string | null; before?: string | null; limit?: number }

// Must match the expression index jev_labels_effect (db.ts) exactly, or SQLite won't use it.
const EFFECT = "json_extract(l.verdict,'$.effect')";
const BY_CAT = `CASE WHEN l.decision='ask' THEN (CASE WHEN l.driver_scope IN ('thread','always') THEN 'always' ELSE 'once' END)
  WHEN l.allowed_by LIKE 'rule:%' THEN 'always' WHEN l.allowed_by IN ('hands-free','yolo') THEN 'autonomy'
  WHEN l.source='learned' THEN 'learned' WHEN l.source='jev' THEN 'jev' ELSE 'rules' END`;
const QUIET_IN = QUIET_EFFECTS.map((e) => `'${e}'`).join(",");

type LabelRow = { id: string; ts: number; bot_id: string; thread_id: string | null; source: string; call: string; verdict: string; allowed_by: string | null; driver_scope: string | null; cat: AllowedBy; pit_title: string | null };
type PitRow = { id: string; ts: number; bot_id: string; thread_id: string | null; effect: string; title: string; scope: string | null };

/** A cursor is "ts:id" of the last row shown; ids break ties within one millisecond. */
const parseCursor = (c: string | null | undefined) => { const m = /^(\d+):([\w-]+)$/.exec(c || ""); return m ? { ts: +m[1], id: m[2] } : null; };

/** One page, newest first. Per request: two indexed reads of at most limit+1 rows each. The label read walks
 *  jev_labels_ts (or jev_labels_bot / jev_labels_effect when filtered) from the cursor down and stops at limit+1
 *  matches, so an unfiltered page skims past the reads and browsing in between; approved pit stops are few (the driver
 *  decides each by hand) and come off pitstops_status. The page itself is one PK lookup per label for its pit stop title. */
export function activity({ bot = null, effect = null, by = null, before = null, limit = 50 }: ActivityQuery = {}): ActivityPage {
  limit = Math.min(Math.max(1, limit | 0 || 50), 200);
  const cur = parseCursor(before), cat = by && (ALLOWED_BY as string[]).includes(by) ? by : null;
  const w: string[] = ["(l.decision='allow' OR l.driver_decision='approved')"], a: (string | number)[] = [];
  if (effect) { w.push(`${EFFECT}=?`); a.push(effect); } else w.push(`(${EFFECT} NOT IN (${QUIET_IN}) OR l.driver_decision='approved')`);
  if (bot) { w.push("l.bot_id=?"); a.push(bot); }
  if (cat) { w.push(`(${BY_CAT})=?`); a.push(cat); }
  if (cur) { w.push("(l.ts<? OR (l.ts=? AND l.id<?))"); a.push(cur.ts, cur.ts, cur.id); }
  const labels = all<LabelRow>(`SELECT l.id, l.ts, l.bot_id, l.thread_id, l.source, l.call, l.verdict, l.allowed_by, l.driver_scope, ${BY_CAT} cat, p.title pit_title
    FROM jev_labels l LEFT JOIN pitstops p ON p.id=l.pitstop_id WHERE ${w.join(" AND ")} ORDER BY l.ts DESC, l.id DESC LIMIT ?`, ...a, limit + 1).map(fromLabel);
  // Pit stops only the driver can approve: none of them answer to "allowed by" anything else.
  let pits: ActivityRow[] = [];
  if (!cat || cat === "once" || cat === "always") {
    const pw = ["p.status='approved'", "p.decided_at IS NOT NULL", `p.kind NOT IN (${NOT_ACTIONS.map((k) => `'${k}'`).join(",")})`, "NOT EXISTS (SELECT 1 FROM jev_labels l WHERE l.pitstop_id=p.id)"], pa: (string | number)[] = [];
    if (effect) { pw.push("p.effect=?"); pa.push(effect); }
    if (bot) { pw.push("p.bot_id=?"); pa.push(bot); }
    if (cat) pw.push(cat === "once" ? "COALESCE(p.scope,'once')='once'" : "p.scope IN ('thread','always')");
    if (cur) { pw.push("(p.decided_at<? OR (p.decided_at=? AND p.id<?))"); pa.push(cur.ts, cur.ts, cur.id); }
    pits = all<PitRow>(`SELECT p.id, p.decided_at ts, p.bot_id, p.thread_id, p.effect, p.title, p.scope FROM pitstops p WHERE ${pw.join(" AND ")} ORDER BY p.decided_at DESC, p.id DESC LIMIT ?`, ...pa, limit + 1).map(fromPit);
  }
  const rows = [...labels, ...pits].sort((x, y) => y.at - x.at || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0));
  const page = rows.slice(0, limit), last = page.at(-1);
  return { rows: page, next: rows.length > limit && last ? `${last.at}:${last.id}` : null };
}

// Pit stop titles carry the gate's verification suffix (" · verify: …"); the log keeps the action, and names a code
// step by what it did instead of showing its code.
const CODE_TOOLS: Record<string, string> = { "run code unsafe": "ran a browser script", evaluate: "ran page JavaScript", "replay request": "re-sent a request" };
const codeStep = (t: string) => t.replace(/^(run code unsafe|evaluate|replay request)\b.*?((?: on [a-z0-9.-]+\.[a-z]{2,})?)$/is, (_, k: string, on: string) => `${CODE_TOOLS[k.toLowerCase()]}${on}`);
const tidy = (t: string) => codeStep(t.replace(/ · (verify|after untrusted|jev blocked)\b.*$/, "")).slice(0, 240);
const scopeHow = (s: string | null | undefined) => (s === "thread" ? "this thread" : s === "always" ? "always" : "once");

function fromLabel(r: LabelRow): ActivityRow {
  const call = json<Record<string, any>>(r.call, {}), v = json<{ effect?: string; reason?: string; by?: string }>(r.verdict, {}), by = r.allowed_by || "";
  const who = r.cat === "once" || r.cat === "always" ? { who: "You", how: r.driver_scope ? scopeHow(r.driver_scope) : / \(this thread\)$/.test(by) ? "this thread" : "always" }
    : r.cat === "autonomy" ? { who: "Thread", how: by === "yolo" ? "full auto" : "hands-free" }
    : r.cat === "learned" ? { who: "Learned", how: /\((\d+) approvals?\)/.exec(by)?.[1] ? `${/\((\d+) approvals?\)/.exec(by)![1]} approvals` : "" }
    : r.cat === "jev" ? { who: "Safety check", how: /the driver asked for this/.test(v.reason || "") ? "you asked" : "judged safe" }
    : by === "site" ? { who: "Site", how: "fully allowed" } : by === "script" ? { who: "Script", how: "allowed before" }
    : r.source === "standing" ? { who: "Standing", how: "approval" } : { who: "Policy", how: `${String(v.effect || "").replace(/_/g, " ")} allowed` };
  return { id: r.id, at: r.ts, botId: r.bot_id, threadId: r.thread_id, effect: v.effect || "unknown", what: r.pit_title ? tidy(r.pit_title) : describeCall(call), by: { cat: r.cat, ...who } };
}
const fromPit = (p: PitRow): ActivityRow => ({ id: p.id, at: p.ts, botId: p.bot_id, threadId: p.thread_id, effect: p.effect, what: tidy(p.title), by: { cat: p.scope === "thread" || p.scope === "always" ? "always" : "once", who: "You", how: scopeHow(p.scope) } });

/** A gated call in a few words, from its redacted record (jev.ts redact): the command, or the tool, element and site. */
export function describeCall(c: Record<string, any>): string {
  if (c.kind === "shell") return `Ran ${String(c.command || "").replace(/^\/bin\/(ba|z)?sh -l?c /, "").replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim().slice(0, 200)}`;
  const tool = String(c.tool || "").replace(/^(browser|computer)_/, "").replace(/_/g, " ");
  if (CODE_TOOLS[tool]) return `${CODE_TOOLS[tool]}${c.host ? ` on ${c.host}` : ""}`;
  const el = (c.arguments?.grounded_elements || [])[0]?.element;
  const what = el ? `${tool} ${String(el).slice(0, 120)}` : tool;
  return c.server === "browser" || c.server === "computer" ? `${what}${c.host ? ` on ${c.host}` : ""}` : `${c.server ? `${c.server}.` : ""}${what}`;
}
