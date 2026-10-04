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
  return signature(call);
}
export function describePattern(p: string | null | undefined) {
  const m = /^browser:([^:]+):([^:]+):(.+)$/.exec(p || "");
  if (m) return `${m[1].replace(/_/g, " ")} ${m[3].replace(/\+/g, " or ")} on ${m[2]}`;
  const s = String(p || "");
  return s.startsWith("cmd:") ? `run ${s.slice(4)}` : s.replace(/^mcp:/, "").replace("/", " ");
}
// Standing approvals hold only for the effect they were granted for: "always" on a link click never covers a Send.
function ruleFor(botId: string, threadId: string, matches: (string | null)[], effect: string) {
  return matches.filter(Boolean).map((m) => one<RuleRow>("SELECT * FROM rules WHERE bot_id=? AND match=? AND effect=? AND revoked_at IS NULL AND (thread_id IS NULL OR thread_id=?)", botId, m, effect, threadId)).find(Boolean);
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
