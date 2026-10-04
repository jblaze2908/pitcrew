// The gate: decides one tool call. The site policy first (browser and pixel tools), then rules and standing approvals,
// then jev, then the driver. Every decision is logged for audit and for training a local classifier.
import { run, now, uid, audit } from "../db.js";
import { getSecret } from "../auth.js";
import { getBot } from "../crew.js";
import { jev, redact, jevSystemOne, secretKind, PAGE_CODE, type Call, type Policy, type Verdict } from "../jev.js";
import { siteTag } from "../domains.js";
import type { Brain } from "../computer.js";
import { bus } from "./bus.js";
import { active } from "./state.js";
import { addEvent } from "./threads.js";
import { signature, pattern, standingRule, learnedTrust } from "./rules.js";
import { siteStep } from "./sitegate.js";
import { waitLease } from "./lease.js";
import { pitStop } from "./pitstops.js";
import { hostOf } from "./util.js";
import { OUTBOUND, tainted } from "./taint.js";

// How a gated call shows up if it becomes a pit stop.
export interface PitInfo { kind: string; title: string; detail: Record<string, unknown> }

// Returns true to run the call.
export async function gate(c: Brain, threadId: string, call: Call, pit: PitInfo) {
  const b = getBot(c.bot.id)!;
  if (call.kind === "mcp" && ["browser", "computer"].includes(call.server!) && !(await waitLease(b.id, threadId, call))) return false;
  const site = await siteStep(b, threadId, call);
  if (!site) return false;
  const policy = site.policy!, sig = signature(call), pat = pattern(call), browser = call.kind === "mcp" && call.server === "browser";
  // Untrusted content from Engram in this thread: no shortcut may stand in for the driver on an outbound effect.
  const taint = tainted(threadId);
  // A fully allowed site skips jev, except for anything that looks like paying (checkout pages never count as full) and
  // page code or storage writes, whose effect only jev can read from the code.
  if (browser && site.full && !taint && call.effect !== "pay" && !PAGE_CODE.test(call.tool || "") && !/^(card|cvv)$/.test(secretKind(JSON.stringify(call.arguments?.grounded_elements || [])) || ""))
    return logDecision(threadId, b.id, { decision: "allow", effect: call.effect || "browse", reason: `${site.site!.domain} is fully allowed`, by: "site" }, call);
  const v = await jev(call, { policy, apiKey: getSecret("openrouter") || "missing" });
  if (v.decision === "block") { logDecision(threadId, b.id, v, call); addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Blocked by jev: ${v.reason}. Nothing ran.`, tone: "bad" }); return false; }
  const forced = taint && OUTBOUND.has(v.effect);
  if (v.decision === "allow" && !forced) { const lid = uid("jl"), ok = logDecision(threadId, b.id, v, call, { id: lid }); shadowVerify(lid, call, v, policy); return ok; }
  // A standing approval covers repeats of the same action, but never money, deletion or sharing. Browser approvals
  // match only by their host-bearing pattern, so one granted on a.example never covers b.example; on a checkout page
  // nothing stands in for the driver on pay or send.
  const effect = v.effect === "unknown" ? "ask" : v.effect;
  const standing = forced || (site.checkout && ["pay", "send"].includes(effect)) ? null : standingRule(b.id, threadId, call, effect);
  if (standing && !["pay", "delete", "share"].includes(v.effect)) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `rule:${standing.label}`, source: "standing" });
  const learned = forced || site.checkout ? null : learnedTrust(b, pat, v);
  if (learned) return logDecision(threadId, b.id, v, call, { decision: "allow", by: `learned:${pat} (${learned.approvals} approvals)`, source: "learned" });
  // Logged before the pit stop opens, so decide() always finds the label row to fill in.
  const id = uid("ps");
  logDecision(threadId, b.id, v, call, { decision: "ask", pitstop: id });
  // Sign-in, payment, send and share pit stops name the exact registrable domain and https, so the driver checks the site.
  const sensitive = ["signin", "pay", "send", "share"].includes(v.effect) || !!secretKind((call.arguments?.grounded_elements || []).map((e) => e.element).join(" "));
  const verify = site.site?.domain && (sensitive || site.checkout) ? ` · verify: ${siteTag(site.site)}${site.checkout ? ` · checkout page (${site.checkout})` : ""}` : "";
  const siteDetail = site.site?.domain ? { site: { domain: site.site.domain, host: site.site.host, https: site.site.https, checkout: site.checkout || null } } : {};
  const untrusted = forced ? { untrusted: "Engram returned untrusted content to this thread in the last 10 minutes" } : {};
  const decision = await pitStop({ id, botId: b.id, threadId, kind: pit.kind, effect, title: `${pit.title}${verify}${forced ? " · after untrusted content" : ""}`, detail: { ...pit.detail, ...siteDetail, ...untrusted, signature: sig, pattern: pat }, jev: v });
  return decision === "approved";
}

// Shadow jev: a background second opinion on every rule-allowed browser or shell call, stored on that call's label row
// (jev_labels.shadow). The gate never awaits it, so it adds no latency; it costs one remote jev call per rule allow, with
// at most SHADOW_MAX in flight (the rest are dropped, not queued). PITCREW_JEV_SHADOW=0 turns it off.
const SHADOW = process.env.PITCREW_JEV_SHADOW !== "0", SHADOW_MAX = Number(process.env.PITCREW_JEV_SHADOW_MAX || 4);
let shadowing = 0;
export function shadowVerify(labelId: string, call: Call, v: Verdict, policy: Policy) {
  if (!SHADOW || !["rule", "policy"].includes(v.by) || shadowing >= SHADOW_MAX || !(call.kind === "shell" || (call.kind === "mcp" && call.server === "browser"))) return null;
  shadowing++;
  return jevSystemOne(call, { apiKey: getSecret("openrouter") || "missing", policy }).then((j) => {
    const decision = j.by === "fail-closed" ? null : j.decision === "allow" && (policy[j.effect] ?? "ask") === "allow" ? "allow" : j.decision === "block" ? "block" : "ask";
    run("UPDATE jev_labels SET shadow=? WHERE id=?", JSON.stringify({ effect: j.effect, decision, by: j.by, ms: j.ms ?? null, agree: decision == null ? null : decision === v.decision, sameEffect: j.effect === v.effect }), labelId);
  }).catch(() => {}).finally(() => { shadowing--; });
}
// Every gate decision lands in the audit log and jev_labels, so "why did this run without asking?" always has an answer.
// Per gate call: one redaction walk and two small INSERTs. v is the rules'/jev's verdict; the options are what overrode it.
const labelSource = (by: string) => (by === "fail-closed" ? "fail-closed" : /^(jev|judge):/.test(by || "") ? "jev" : "rule");
export function logDecision(threadId: string | null, botId: string, v: Verdict, call: Call, { decision = v.decision, by = v.by, source = labelSource(v.by), pitstop = null, id = uid("jl") }: { decision?: string; by?: string; source?: string; pitstop?: string | null; id?: string } = {}) {
  const safe = redact(call);
  audit("jev", `gate.${decision}`, { threadId, effect: v.effect, by, reason: v.reason, ms: v.ms ?? null, call: gateSummary(safe), ...(pitstop ? { pitstop } : {}) });
  const verdict = { effect: v.effect, decision: v.decision, reason: v.reason, by: v.by, model: /^(jev|judge):/.test(v.by || "") ? v.by.replace(/^\w+:/, "") : null, ms: v.ms ?? null, answers: v.answers ?? null, probabilities: v.probabilities ?? null };
  run("INSERT INTO jev_labels(id,ts,bot_id,thread_id,source,call,verdict,decision,pitstop_id) VALUES(?,?,?,?,?,?,?,?,?)", id, now(), botId, threadId ?? null, source,
    JSON.stringify({ ...safe, host: hostOf(call.arguments?.page_url) || null }), JSON.stringify(verdict), decision, pitstop);
  if (decision === "allow") bus.emit("jev", { threadId, effect: v.effect, by, ms: v.ms ?? null });
  return decision === "allow";
}
const gateSummary = (c: Call) => (c.kind === "shell" ? { kind: "shell", command: String(c.command).slice(0, 300) } : { kind: c.kind, server: c.server, tool: c.tool, args: JSON.stringify(c.arguments || {}).slice(0, 300) });
