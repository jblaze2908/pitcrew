// What one approval generalises to: a call's signature and pattern, the standing rules that match it, and patterns
// learned from repeated approvals.
import { one, run, now, json } from "../db.js";
import { getBot } from "../crew.js";
import type { Call, Policy, Verdict } from "../jev.js";
import type { Bot } from "../../shared/types.js";
import type { PitstopRow, RuleRow, LearnedRow } from "../models.js";
import { addEvent } from "./threads.js";
import { roleOf } from "./grounding.js";
import { hostOf } from "./util.js";

// A command that runs a workspace script: interpreter, its own flags (python3 -B, node --no-warnings), then the path.
// Flags that take code instead of a file (-c, -m, -e, -p, --eval, --print) never match, so `python3 -c …` isn't a script.
export const RUNS = /\b(?:python3?|node|bash|sh|bun|deno(?:\s+run)?)(?:\s+(?:-(?![cmep]\b)[A-Za-z]+|--(?!eval\b|print\b)[\w-]+(?:=\S+)?))*\s+(\/bot\/work\/[\w.\/@+-]+\.(?:py|mjs|cjs|js|ts|sh))\b/;
// An interpreter started without a workspace script (inline code, a heredoc, a module): too broad to generalise.
const INLINE = /^(?:python3?|node|bash|sh|bun|deno)\b/;
const bare = (command: unknown) => String(command).replace(/^\/bin\/(ba)?sh -l?c /, "").replace(/^['"]/, "").trim();

export function signature(call: Call) {
  if (call.kind === "shell") return `cmd:${String(call.command).replace(/^\/bin\/(ba)?sh -l?c /, "").replace(/^['"]/, "").trim().split(/\s+/).slice(0, 2).join(" ")}`;
  if (call.kind === "mcp") return `mcp:${call.server}/${call.tool}`;
  return `${call.kind}:*`;
}
// What one decision generalises to. Browser actions key on site and element role, so approving a link click on
// example.com says nothing about its buttons or another site. Ungrounded and pixel actions generalise to nothing.
export function pattern(call: Call) {
  if (call.kind === "mcp" && call.server === "computer") return null;
  if (call.kind === "mcp" && call.server === "browser") {
    const a = call.arguments || {}, host = hostOf(a.page_url), roles = (a.grounded_elements || []).map((e) => roleOf(e.element));
    if (!host || !roles.length || roles.includes(null)) return null;
    return `browser:${call.tool!.replace(/^browser_/, "")}:${host}:${[...new Set(roles)].sort().join("+")}`;
  }
  if (call.kind === "shell") {
    const m = RUNS.exec(String(call.command || ""));
    if (m) return `script:${m[1]}`;
    if (INLINE.test(bare(call.command))) return null;
  }
  return signature(call);
}
/** An exact action: one workspace script or one tool. Its standing approval holds whatever effect jev reads next time
 *  (jev's guess for the same call moves between runs at low confidence), except paying and deleting. */
export const exactPattern = (p: string | null | undefined) => !!p && (p.startsWith("script:") || (p.startsWith("mcp:") && !/^mcp:(browser|computer)\//.test(p)));
export const NEVER_STANDING = ["pay", "delete"], NEVER_BROAD = ["pay", "delete", "share"];
/** What an approval with "always" or "this thread" stands for, or null: an interpreter with no workspace script
 *  (cmd:python3 -c, cmd:node -e) would stand for any code at all, so it gets no rule. */
export const ruleMatch = (detail: { pattern?: string | null; signature?: string }) =>
  detail.pattern || (detail.signature && !(INLINE.test(detail.signature.replace(/^cmd:/, "")) && !RUNS.test(detail.signature)) ? detail.signature : null);
export function describePattern(p: string | null | undefined) {
  const m = /^browser:([^:]+):([^:]+):(.+)$/.exec(p || "");
  if (m) return `${m[1].replace(/_/g, " ")} ${m[3].replace(/\+/g, " or ")} on ${m[2]}`;
  const s = String(p || "");
  return s.startsWith("cmd:") ? `run ${s.slice(4)}` : s.startsWith("script:") ? `run ${s.slice(7)}` : s.replace(/^mcp:/, "").replace("/", " ");
}
// A broad standing approval holds only for the effect it was granted for: "always" on a link click never covers a Send.
// An exact one (exactPattern) holds for any effect but paying or deleting.
function ruleFor(botId: string, threadId: string, matches: (string | null)[], effect: string) {
  return matches.filter(Boolean).map((m) => exactPattern(m)
    ? (NEVER_STANDING.includes(effect) ? undefined : one<RuleRow>("SELECT * FROM rules WHERE bot_id=? AND match=? AND revoked_at IS NULL AND (thread_id IS NULL OR thread_id=?)", botId, m, threadId))
    : one<RuleRow>("SELECT * FROM rules WHERE bot_id=? AND match=? AND effect=? AND revoked_at IS NULL AND (thread_id IS NULL OR thread_id=?)", botId, m, effect, threadId)).find(Boolean);
}
export const standingRule = (botId: string, threadId: string, call: Call, effect: string) => ruleFor(botId, threadId, call.kind === "mcp" && call.server === "browser" ? [pattern(call)] : [pattern(call), signature(call)], effect);

// Learning from pit stops: after LEARN_AFTER approvals in a row (no denial since) of one pattern with one effect, the
// crew stops asking. It only lifts jev's uncertainty escalations: the effect must be one the member's policy already
// allows, judged by a real classifier (not a fail-closed verdict). Sign-in, send, pay, delete and share never qualify.
export const LEARN_AFTER = 2;
export const learnable = (policy: Policy | undefined, effect: string, by: string | undefined) => policy?.[effect] === "allow" && /^(jev|judge):/.test(by || "");
export function learnedTrust(b: Bot, pat: string | null, v: Verdict) {
  if (!pat || !learnable(b.policy, v.effect, v.by)) return null;
  const r = one<LearnedRow>("SELECT * FROM learned WHERE bot_id=? AND pattern=? AND effect=?", b.id, pat, v.effect);
  return r && r.streak >= LEARN_AFTER ? r : null;
}
export function learn(ps: PitstopRow, detail: { pattern: string }, status: string) {
  const ok = status === "approved";
  run(`INSERT INTO learned(bot_id,pattern,effect,label,approvals,denials,streak,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(bot_id,pattern,effect) DO UPDATE SET approvals=approvals+excluded.approvals, denials=denials+excluded.denials,
      streak=CASE WHEN excluded.denials>0 THEN 0 ELSE streak+1 END, label=excluded.label, updated_at=excluded.updated_at`,
    ps.bot_id, detail.pattern, ps.effect, describePattern(detail.pattern), ok ? 1 : 0, ok ? 0 : 1, ok ? 1 : 0, now());
  const r = one<{ streak: number }>("SELECT streak FROM learned WHERE bot_id=? AND pattern=? AND effect=?", ps.bot_id, detail.pattern, ps.effect)!;
  if (ok && r.streak === LEARN_AFTER && ps.thread_id)
    addEvent(ps.thread_id, null, "system", { text: `Learned: “${describePattern(detail.pattern)}” won't ask again (you approved it ${LEARN_AFTER} times in a row). Undo it under Rules.` });
}
// Shown on a pending pit stop: how far this pattern is from being learned, or null if it can't be.
export function learnProgress(ps: PitstopRow) {
  const d = json(ps.detail, {}), v = json(ps.jev, {});
  if (!d.pattern || ps.kind === "hire" || !learnable(getBot(ps.bot_id)?.policy, ps.effect, v.by)) return null;
  const r = one<{ streak: number }>("SELECT streak FROM learned WHERE bot_id=? AND pattern=? AND effect=?", ps.bot_id, d.pattern, ps.effect);
  return { label: describePattern(d.pattern), streak: r?.streak || 0, need: LEARN_AFTER };
}
