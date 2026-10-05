// The gate: decides one tool call. The site policy first (browser and pixel tools), then rules and standing approvals,
// then jev, then the driver. Every decision is logged for audit and for training a local classifier.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { run, one, all, now, uid, audit, json } from "../db.js";
import { getSecret } from "../auth.js";
import { getBot } from "../crew.js";
import { jev, redact, jevSystemOne, secretKind, PAGE_CODE, type Call, type JevContext, type Policy, type Verdict } from "../jev.js";
import { siteTag } from "../domains.js";
import { botDir, type Brain } from "../computer.js";
import { bus } from "./bus.js";
import { active, shellVerdicts } from "./state.js";
import { addEvent } from "./threads.js";
import { signature, pattern, standingRule, learnedTrust } from "./rules.js";
import { siteStep, noteRefusal } from "./sitegate.js";
import { waitLease } from "./lease.js";
import { pitStop } from "./pitstops.js";
import { hostOf } from "./util.js";
import { OUTBOUND, tainted } from "./taint.js";
import { autonomyOf, waived } from "./autonomy.js";

// How a gated call shows up if it becomes a pit stop.
export interface PitInfo { kind: string; title: string; detail: Record<string, unknown> }

// Returns true to run the call.
export async function gate(c: Brain, threadId: string, call: Call, pit: PitInfo) {
  const b = getBot(c.bot.id)!;
  if (call.kind === "mcp" && ["browser", "computer"].includes(call.server!) && !(await waitLease(b.id, threadId, call))) return false;
  const auto = autonomyOf(threadId);
  const site = await siteStep(b, threadId, call, auto);
  if (!site) return false;
  const policy = site.policy!, sig = signature(call), pat = pattern(call), browser = call.kind === "mcp" && call.server === "browser";
  // Untrusted content from Engram in this thread: no shortcut may stand in for the driver on an outbound effect.
  const taint = tainted(threadId);
  // A fully allowed site skips jev, except for anything that looks like paying (checkout pages never count as full) and
  // page code or storage writes, whose effect only jev can read from the code.
  if (browser && site.full && !taint && call.effect !== "pay" && !PAGE_CODE.test(call.tool || "") && !/^(card|cvv)$/.test(secretKind(JSON.stringify(call.arguments?.grounded_elements || [])) || ""))
    return logDecision(threadId, b.id, { decision: "allow", effect: call.effect || "browse", reason: `${site.site!.domain} is fully allowed`, by: "site" }, call);
  const judged = withScript(b.id, call), script = judged.script;
  // The same bytes of a workspace script that jev allowed or the driver approved before run again without asking.
  if (script && !script.downloaded && one("SELECT 1 FROM script_trust WHERE bot_id=? AND sha=?", b.id, script.sha))
    return allowed(threadId, logDecision(threadId, b.id, { decision: "allow", effect: "write_workspace", reason: `same ${script.path} as allowed before`, by: "script" }, call, { source: "standing" }));
  const v = await jev(judged, { policy, apiKey: getSecret("openrouter") || "missing", context: () => jevContext(threadId, b.house_rules) });
  if (v.decision === "block") {
    logDecision(threadId, b.id, v, call);
    const n = noteBlock(threadId);
    // After ESCALATE_AFTER jev blocks in a row the driver decides instead (hard rules never escalate); past
    // STOP_AFTER blocks in one run the run stops, so a member can't keep probing for a way through.
    if (n.total >= STOP_AFTER) { addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Stopped: jev blocked ${n.total} actions in this run. Tell ${b.name} how to go on, or change its house rules.`, tone: "bad" }); import("./turns.js").then((T) => T.interrupt(threadId)).catch(() => {}); return false; }
    if (n.consecutive < ESCALATE_AFTER || v.by === "rule") {
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Blocked by jev: ${v.reason}. Nothing ran.`, tone: "bad" });
      // Codex reports a declined command only as "rejected by user"; the member also hears what was blocked and why.
      if (call.kind === "shell") import("./turns.js").then((T) => T.steerNote(threadId, BLOCKED_NOTE(pit.title, v.reason))).catch(() => {});
      else noteRefusal(threadId, BLOCKED_NOTE(pit.title, v.reason));
      return false;
    }
    const decision = await pitStop({ botId: b.id, threadId, kind: pit.kind, effect: v.effect === "unknown" ? "ask" : v.effect, title: `${pit.title} · jev blocked ${n.consecutive} in a row`, detail: { ...pit.detail, signature: sig, pattern: pat, escalated: true }, jev: v });
    if (decision === "approved") { trustScript(b.id, script, "driver"); return allowed(threadId, true); }
    if (decision === "expired" && call.kind !== "shell") noteRefusal(threadId, EXPIRED_NOTE(pit.title));
    return false;
  }
  const forced = taint && OUTBOUND.has(v.effect);
  // Hands-free or YOLO stands in for the driver here; jev's verdict is still logged, so the audit shows what was waived.
  if ((v.decision !== "allow" || forced) && waived(auto, v.effect) && !v.forbidden) return logDecision(threadId, b.id, v, call, { decision: "allow", by: auto === "yolo" ? "yolo" : "hands-free", source: "standing" });
  if (v.decision === "allow" && !forced) { const lid = uid("jl"), ok = logDecision(threadId, b.id, v, call, { id: lid }); shadowVerify(lid, call, v, policy); trustScript(b.id, script, "jev"); return allowed(threadId, ok); }
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
  // An expired pit stop isn't a refusal: the driver wasn't there. Said so to the tool call; a command, whose decline
  // Codex reports as "rejected by user", also gets a steered note (pitstops.ts).
  if (decision === "expired" && call.kind !== "shell") noteRefusal(threadId, EXPIRED_NOTE(pit.title));
  if (decision === "approved") { trustScript(b.id, script, "driver"); allowed(threadId, true); }
  return decision === "approved";
}

// Blocks per thread: in a row (any allowed call resets it) and in the current run. In memory: a restart starts afresh.
export const ESCALATE_AFTER = 3, STOP_AFTER = 20;
const blocks = new Map<string, { consecutive: number; total: number; turnId: string | null }>();
export function noteBlock(threadId: string) {
  const turnId = active.get(threadId)?.turnId ?? null, prev = blocks.get(threadId);
  const n = { consecutive: (prev?.consecutive ?? 0) + 1, total: (prev && prev.turnId === turnId ? prev.total : 0) + 1, turnId };
  blocks.set(threadId, n);
  return n;
}
function allowed(threadId: string, ok: boolean) { const n = blocks.get(threadId); if (ok && n) n.consecutive = 0; return ok; }
function trustScript(botId: string, script: Call["script"], by: string) {
  if (script && !script.downloaded && !script.truncated) run("INSERT OR REPLACE INTO script_trust(bot_id,sha,path,by,at) VALUES(?,?,?,?,?)", botId, script.sha, script.path, by, now());
}
export const BLOCKED_NOTE = (title: string, reason: string) => `Blocked, not run: "${title.slice(0, 160)}". jev's reason: ${reason}. The driver didn't refuse it; a safety rule did. Don't try the same thing another way; if it's needed, say why and the driver can allow it.`;
export const EXPIRED_NOTE = (title: string) => `Not done yet: the pit stop for "${title.slice(0, 160)}" expired because the driver didn't answer within 30 minutes. That isn't a refusal. Don't try it another way; finish what you can without it and say clearly what is waiting on the driver, so they can approve it when they're back.`;

// The driver's last three messages in this thread (600 chars each, oldest first) and the member's house rules (20 lines).
// One indexed query, only for calls the rules leave to jev.
// Pitcrew's own notes ride as user messages; they aren't the driver's words ("Don't redo steps…" read as a prohibition).
const NOT_DRIVER = new Set(["retro", "resume"]);
export function jevContext(threadId: string | null, houseRules = ""): JevContext {
  const said = threadId ? all<{ data: string }>("SELECT data FROM events WHERE thread_id=? AND kind='user' ORDER BY id DESC LIMIT 12", threadId).map((e) => json(e.data, {}) as { text?: string; via?: string })
    .filter((d) => !NOT_DRIVER.has(String(d.via))).slice(0, 3).map((d) => String(d.text || "").trim().slice(0, 600)).filter(Boolean).reverse() : [];
  return { driver_said: said, house_rules: String(houseRules).split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean).slice(0, 20).map((l) => l.slice(0, 300)) };
}

// A command that runs a script in the member's workspace: jev reads the script, not just its name. A bare
// `python3 /bot/work/x.py` used to be judged blind and asked at low confidence. One stat and one bounded read per such
// command; the script is resolved under the bot's own work dir on the host (realpath, so no symlink leaves it).
const RUNS = /\b(?:python3?|node|bash|sh|bun|deno(?:\s+run)?)\s+(\/bot\/work\/[\w.\/@+-]+\.(?:py|mjs|cjs|js|ts|sh))\b/, SCRIPT_MAX = 6000;
export function withScript(botId: string, call: Call): Call {
  const m = call.kind === "shell" ? RUNS.exec(String(call.command || "")) : null;
  if (!m) return call;
  try {
    const root = realpathSync(`${botDir(botId)}/work`), f = realpathSync(`${botDir(botId)}${m[1].slice("/bot".length)}`);
    if (!f.startsWith(`${root}/`) || statSync(f).size > 1 << 20) return call;
    const src = readFileSync(f, "utf8");
    return { ...call, script: { path: m[1], source: src.slice(0, SCRIPT_MAX), truncated: src.length > SCRIPT_MAX, sha: createHash("sha256").update(src).digest("hex").slice(0, 32), downloaded: m[1].startsWith("/bot/work/downloads/") } };
  } catch { return call; }
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
  // allowed_by: what stood in for the driver (rule:…, hands-free, learned:…, site, script), for the activity log.
  run("INSERT INTO jev_labels(id,ts,bot_id,thread_id,source,call,verdict,decision,pitstop_id,allowed_by) VALUES(?,?,?,?,?,?,?,?,?,?)", id, now(), botId, threadId ?? null, source,
    JSON.stringify({ ...safe, host: hostOf(call.arguments?.page_url) || null }), JSON.stringify(verdict), decision, pitstop, by || null);
  if (decision === "allow") bus.emit("jev", { threadId, effect: v.effect, by, ms: v.ms ?? null });
  if (call.kind === "shell" && threadId) { if (shellVerdicts.size > 500) shellVerdicts.clear(); shellVerdicts.set(`${threadId}\n${call.command}`, { effect: String(v.effect || "unknown"), decision }); }
  return decision === "allow";
}
const gateSummary = (c: Call) => (c.kind === "shell" ? { kind: "shell", command: String(c.command).slice(0, 300) } : { kind: c.kind, server: c.server, tool: c.tool, args: JSON.stringify(c.arguments || {}).slice(0, 300) });
