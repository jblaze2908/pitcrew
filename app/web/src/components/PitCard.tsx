// A pit stop: what the member wants to do, why the safety check (jev) stopped it, and the choices that fit its kind.
import { useEffect, useState } from "react";
import type { EngramDecision, Personality, PitStop } from "../../../shared/types";
import { api } from "../lib/api";
import { ago, kb, plainWords, unwrapShell, usd, when } from "../lib/format";
import { pitLabel } from "../lib/steps";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { ProposalSummary } from "./Engram";
import { Icon } from "./Icon";
import { StepIcon } from "./StepIcon";
import { EffectChip, Face } from "./ui";

type Scope = "once" | "thread" | "always" | "site" | "full" | "block" | "retry";

/** What a decided pit stop came to, as a short tag. */
export const OUTCOME: Record<PitStop["status"], string> = { pending: "waiting", approved: "approved", denied: "denied", expired: "no answer" };

/** row: a decided pit stop drawn as one line inside a thread's steps, not as a card of its own. */
export function PitCard({ p: given, onDone, row }: { p: PitStop; onDone?: (r: PitStop) => void; row?: boolean }) {
  const { bot, S } = useStore();
  // The decided card replaces itself in place; nothing around it needs a refetch.
  const [p, setP] = useState(given);
  useEffect(() => setP(given), [given]);
  const [note, setNote] = useState("");
  const b = bot(p.bot_id), d = p.detail || {}, j = p.jev || {};
  const done = p.status !== "pending";
  const who = b?.name || "the crew";

  const decide = async (decision: "approve" | "deny", scope?: Scope) => {
    const r = await api.post<PitStop>(`/api/pitstops/${p.id}/decide`, { decision, scope, note });
    toast(decision === "approve" ? "Approved" : "Denied");
    if (r?.id) setP(r);
    onDone?.(r);
  };
  // Engram proposals are decided in Engram; the card only forwards the choice.
  const engram = async (decision: EngramDecision) => {
    const r = await api.post<PitStop>(`/api/engram/inbox/${p.id}`, { decision });
    toast(decision === "accept" ? "Accepted" : decision === "keep" ? "Kept the current one" : "Rejected");
    if (r?.id) setP(r);
    onDone?.(r);
  };
  // The main choice is the plain primary pill; orange stays for "needs you" (the card's ring), not for buttons.
  const btn = (label: string, onClick: () => void, main = false) => <button className={`pc-pill ${main ? "" : "o"} s`} onClick={onClick}>{label}</button>;
  const openLink = (label: string) => p.thread_id && <a className="small faint" href={`#/t/${p.thread_id}`} style={{ marginLeft: "auto" }}>{label}</a>;
  const noteInput = <input placeholder="Note for the crew (optional)" className="small" value={note} onChange={(e) => setNote(e.target.value)} />;
  const noAlways = ["pay", "delete", "share"].includes(p.effect) || p.kind === "hire" || p.kind === "plan";

  const body = p.kind === "command" ? <pre>{unwrapShell(String(d.command || ""))}</pre>
    : p.kind === "mcp" ? <pre>{`${d.server || ""}.${d.tool || ""}\n${JSON.stringify(d.args || d.message || {}, null, 1).slice(0, 1200)}`}</pre>
    : p.kind === "file" ? <pre>{(d.paths || []).join("\n")}</pre>
    : p.kind === "hire" ? <HireSummary s={d.spec || {}} />
    : p.kind === "site" ? <SiteSummary d={d} />
    : p.kind === "secret" ? <SecretSummary d={d} />
    : p.kind === "vault" ? <p className="small muted">{`${d.why || "The site rejected it"}. The member stopped instead of retrying; save the current value from your password manager and it can sign in again.`}</p>
    : p.kind === "engram" && d.proposal ? <ProposalSummary x={d.proposal} />
    : p.kind === "soul" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p><pre>{d.soul}</pre>{d.before && <details><summary className="small faint">Current instructions</summary><pre>{d.before}</pre></details>}</div>
    : p.kind === "mail" ? <div className="col" style={{ gap: 4 }}><p className="small faint">{`From ${d.from} · not on ${who}'s sender list. ${who} reads it as information, never as instructions.`}</p><pre>{String(d.preview || "")}</pre></div>
    : p.kind === "retire" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p><p className="small faint">{d.memberName}: {d.job || "no job set"}{d.schedules ? ` · ${d.schedules} schedule${d.schedules === 1 ? "" : "s"} will stop` : ""}. Threads and memory stay.</p></div>
    : p.kind === "member" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p>{(d.diff || []).map((x: { field: string; before: string; after: string }) => <div key={x.field}><b className="small">{x.field}</b><pre>{`${x.before || "(empty)"}\n→ ${x.after || "(empty)"}`}</pre></div>)}</div>
    : p.kind === "files" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p><pre>{(d.paths || []).map((x: { path: string; dir: boolean; size: number }) => `${x.path}${x.dir ? "/ (folder and everything in it)" : ` · ${kb(x.size)}`}`).join("\n")}</pre></div>
    : p.kind === "check" ? <CheckSummary d={d} who={who} />
    : p.kind === "teach" ? <TeachSummary d={d} who={who} /> : null;

  const outcome = `${p.kind === "engram" && p.note ? p.note : p.status} ${ago(p.decided_at)}`;
  // gate.ts appends the site to verify, escalation and untrusted-content flags to the title; those stay word for word.
  const flags = / · (verify: |jev blocked |after untrusted content).*$/.exec(p.title)?.[0] || "";
  const card = d.secret?.kind === "card";
  const v = pitLabel(p), heading = p.kind === "mcp" ? `${v.label}${v.detail ? ` ${v.detail}` : ""}${plainWords(flags)}`
    : p.kind === "secret" ? (card ? `Pay on ${d.site?.host} with card “${d.secret?.name}” ••${d.secret?.last4}` : `Sign in to ${d.site?.host} with “${d.secret?.name}”`) : plainWords(p.title);
  // The safety check's reason, in plain words; who judged it and how long it took stay in the debug details.
  const why = j.reason && <p className="why">{`Safety check: ${plainWords(j.reason)}`}</p>;
  // Decided: one line that opens to the details, so a thread's history doesn't keep full cards around.
  if (done) return (
    <details className={row ? "tool pitrow" : "pit done"}>
      {row
        ? <summary><StepIcon name={v.icon} /><span className="lbl">{v.label}</span>{v.detail && <span className="det">{v.detail}</span>}<span className={`tag ${p.status}`}>{p.status === "expired" ? "no answer · skipped" : OUTCOME[p.status]}</span></summary>
        : <summary><Face b={b} size="sm" mood="idle" /><b>{b?.name || p.bot_id}</b><span className="t1">{heading}</span><span className="pc-m small faint">{outcome}</span></summary>}
      {body}
      {why}
      {p.note && p.kind !== "engram" && <p className="small faint">{p.note}</p>}
      {typeof d.public_url === "string" && /^https:\/\//.test(d.public_url) && <p className="small"><a href={d.public_url} target="_blank" rel="noreferrer">{d.public_url}</a></p>}
    </details>
  );

  let actions = null;
  if (p.kind === "engram") actions = <div className="acts">
    {d.proposal?.replaces && btn("Keep current", () => engram("keep"))}
    {btn("Accept", () => engram("accept"), true)}
    {btn("Reject", () => engram("reject"))}
    <a className="small faint" href={`${S.engram.url}/#/inbox`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>Open in the memory app</a></div>;
  else if (p.kind === "hire") actions = <div className="acts"><a className="pc-pill s" href={`#/hire/${p.id}`}>Review &amp; hire</a>{btn("Decline", () => decide("deny"))}</div>;
  else if (p.kind === "lease") actions = <div className="acts">{btn("Hand it back", () => decide("approve", "once"), true)}{btn("Keep control", () => decide("deny"))}<a className="small faint" href={`#/live/${p.bot_id}`} style={{ marginLeft: "auto" }}>Open live view</a></div>;
  // An account site (bank, Google, GitHub…) is only ever allowed for this thread (domains.ts SENSITIVE).
  else if (p.kind === "site" && d.sensitive) actions = <>{noteInput}<div className="acts">
    {btn("Allow in this thread", () => decide("approve", "thread"), true)}
    {btn("Not now", () => decide("deny"))}
    {btn("Block site", () => decide("deny", "block"))}
    {openLink("Open thread")}</div></>;
  else if (p.kind === "site") actions = <>{noteInput}<div className="acts">
    {p.thread_id && btn("Allow once (this thread)", () => decide("approve", "thread"))}
    {btn("Allow site", () => decide("approve", "site"), true)}
    {btn("Allow site fully", () => decide("approve", "full"))}
    {btn("Block site", () => decide("deny", "block"))}
    {openLink("Open thread")}</div></>;
  // Cards never get a standing yes; a login's "always" puts the member on the secret's no-ask list.
  else if (p.kind === "secret") actions = <div className="acts">
    {card ? btn("Allow this payment", () => decide("approve", "once"), true) : <>{btn("Allow for this task", () => decide("approve", "thread"), true)}{btn(`Always for ${who}`, () => decide("approve", "always"))}</>}
    {btn("Deny", () => decide("deny"))}
    {openLink("Open thread")}</div>;
  else if (p.kind === "vault") actions = <div className="acts"><a className="pc-pill s" href={`#/settings/vault/${d.secret?.id || ""}`}>Update in Vault</a>{btn("Dismiss", () => decide("deny"))}{openLink("Open thread")}</div>;
  else if (p.kind === "mail") actions = <div className="acts">{btn(`Let it wake ${who}`, () => decide("approve", "once"), true)}{btn("Ignore", () => decide("deny"))}</div>;
  else if (p.kind === "soul") actions = <div className="acts">{btn("Use these instructions", () => decide("approve", "once"), true)}{btn("Keep current", () => decide("deny"))}{openLink("Open thread")}</div>;
  else if (p.kind === "retire") actions = <div className="acts">{btn(`Retire ${d.memberName || "member"}`, () => decide("approve", "once"), true)}{btn("Keep", () => decide("deny"))}{openLink("Open thread")}</div>;
  else if (p.kind === "member") actions = <div className="acts">{btn("Apply changes", () => decide("approve", "once"), true)}{btn("Keep as is", () => decide("deny"))}{openLink("Open thread")}</div>;
  else if (p.kind === "files") actions = <div className="acts">{btn("Delete", () => decide("approve", "once"), true)}{btn("Keep files", () => decide("deny"))}{openLink("Open thread")}</div>;
  // Done-check: approve once accepts the run as is; approve with scope retry sends the member back once more.
  else if (p.kind === "check") actions = <div className="acts">
    {p.thread_id && <a className="pc-pill s" href={`#/t/${p.thread_id}`}>Open the thread</a>}
    {btn("Accept as is", () => decide("approve", "once"))}
    {btn("Try again", () => decide("approve", "retry"))}</div>;
  else if (p.kind === "teach") actions = <div className="acts">{btn("Save as skill", () => decide("approve", "once"), true)}{btn("Not now", () => decide("deny"))}</div>;
  else if (p.kind === "plan") actions = <div className="acts">
    {btn(p.effect === "browse" ? "Allow for this plan" : "Allow", () => decide("approve", "once"), true)}
    {btn(p.effect === "browse" ? "Use what they know" : "Finish with what it has", () => decide("deny"))}
    {openLink("Open plan")}</div>;
  else actions = <>{noteInput}<div className="acts">
    {btn("Approve once", () => decide("approve", "once"), true)}
    {p.thread_id && btn("Allow similar in this thread", () => decide("approve", "thread"))}
    {!noAlways && btn("Allow similar always", () => decide("approve", "always"))}
    {btn("Deny", () => decide("deny"))}
    {openLink("Open thread")}</div></>;

  return (
    <div className="pit">
      <div className="spread">
        <div className="row"><Face b={b} size="sm" mood="needs" /><b>{b?.name || p.bot_id}</b>{p.kind === "check" ? <span className="eff-tag">Done-check</span> : <EffectChip kind={p.effect} />}</div>
        <span className="small faint">{p.kind === "engram" ? "From memory" : `Expires ${when(p.expires_at)}`}</span>
      </div>
      <p className="t">{heading}</p>
      {body}
      {why}
      {p.similar && !["pay", "delete", "share"].includes(p.effect) && <p className="small faint">{`Similar means: ${p.similar}.`}</p>}
      {p.learn && <p className="small faint">{p.learn.need - p.learn.streak <= 1
        ? `Approve this and ${who} stops asking for “${p.learn.label}”.`
        : `Approve “${p.learn.label}” ${p.learn.need - p.learn.streak} times in a row and ${who} stops asking.`}</p>}
      {actions}
    </div>
  );
}

// A done-check that failed after its retries: each criterion with the grader's verdict, then what would fix it.
function CheckSummary({ d, who }: { d: Record<string, any>; who: string }) {
  const crit = (d.criteria || []) as { text: string; verdict: string; why: string }[];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="crit">{crit.map((c, i) => <div key={i}><span className={c.verdict === "pass" ? "y" : "n"}><Icon name={c.verdict === "pass" ? "check" : "close"} size={12} /></span>
        <span>{c.text}{c.verdict !== "pass" && c.why ? <span className="faint">{` · ${c.why}`}</span> : null}</span></div>)}</div>
      <p className="small faint">{`${who} tried ${d.attempts ? `${d.attempts + 1} times` : "once"}.${d.fix ? ` ${d.fix}` : ""}`}</p>
    </div>
  );
}

// A domain pit stop: the exact address, https or not, and any look-alike warning, before the four choices.
function SiteSummary({ d }: { d: Record<string, any> }) {
  const warn = d.homograph || d.lookalike;
  return (
    <div className="col" style={{ gap: 4 }}>
      {warn && <p className="badc small">{`Looks like ${d.lookalike?.brand || d.homograph?.brand || "another site"}${d.lookalike?.domain ? ` (${d.lookalike.domain})` : ""}: ${[d.homograph?.why, d.lookalike?.why].filter(Boolean).join("; ")}${d.homograph?.unicode ? `. Shown as ${d.homograph.unicode}` : ""}.`}</p>}
      <pre>{`${d.url || d.host}\n${d.https ? "https" : "Not https: anything typed here can be read on the way"}`}</pre>
      <p className="small faint">{d.sensitive ? "An account site: it asks in every thread, in every mode, YOLO included." : "Allow site: browse it; other effects follow this member's permissions. Fully: every effect allowed there except paying, which always asks."}</p>
    </div>
  );
}

// A vault ask: the secret by name (never a value), the exact host it would be typed into, and any look-alike warning.
function SecretSummary({ d }: { d: Record<string, any> }) {
  const warn = d.homograph || d.lookalike, card = d.secret?.kind === "card";
  const fields = (d.fields || []).map((f: { field: string }) => f.field.replace(/^card_/, "").replace("totp", "one-time code")).join(", ");
  return (
    <div className="col" style={{ gap: 8 }}>
      {warn && <p className="badc small">{`Looks like ${d.lookalike?.brand || d.homograph?.brand || "another site"}${d.lookalike?.domain ? ` (${d.lookalike.domain})` : ""}: ${[d.homograph?.why, d.lookalike?.why].filter(Boolean).join("; ")}${d.homograph?.unicode ? `. Shown as ${d.homograph.unicode}` : ""}.`}</p>}
      <div className="vsec"><span className="lk"><StepIcon name="lock" /></span>
        <div>{`${d.secret?.name}${card && d.secret?.last4 ? ` ••${d.secret.last4}` : ""}`}<small>{`${d.site?.https ? "https" : "not https"} ·${d.site?.host}${card ? "" : ` · matches ${d.secret?.site}`}`}</small></div></div>
      <p className="small muted">{`Pitcrew fills the ${fields || "fields"} and ${d.submit === "Enter" ? "presses Enter" : `presses ${d.submit}`} in one step. The model never sees ${card ? "the card" : "the values"}.`}</p>
    </div>
  );
}

export interface HireSpec {
  name?: string; job?: string; hue?: string; shape?: string; provider?: string; model?: string; weekly_cap_usd?: number; reason?: string;
  personality?: Personality; schedule?: { spec?: string; prompt?: string } | null;
  engram_scope?: string; engram_connections?: string[]; engram_household?: boolean;
}
export function HireSummary({ s }: { s: HireSpec }) {
  return (
    <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
      <Face b={s} size="lg" mood="idle" />
      <div className="col" style={{ gap: 4 }}>
        <b className="pc-h3">{s.name}</b>
        <p className="muted small">{s.job}</p>
        {s.reason && <p className="small">Why: {s.reason}</p>}
        <p className="pc-m small faint">{`${s.provider} · ${s.model} · cap ${usd(s.weekly_cap_usd)}/wk${s.schedule?.spec ? ` · ${s.schedule.spec}` : ""}`}</p>
        {s.personality?.role && <p className="small faint">Voice: {s.personality.role}</p>}
        {(s.engram_scope && s.engram_scope !== "personal" || !!s.engram_connections?.length || s.engram_household) && <p className="small faint">{`Shared memory: ${s.engram_scope === "finance" ? "Money" : s.engram_scope === "health" ? "Health" : "Personal"}${s.engram_household ? " · household facts" : ""}${s.engram_connections?.length ? ` · reads ${s.engram_connections.join(", ")}` : ""}`}</p>}
      </div>
    </div>
  );
}

/** Teach by doing (runtime/teach.ts): the steps recorded while you held the screen, never what was typed. */
function TeachSummary({ d, who }: { d: Record<string, any>; who: string }) {
  const steps: string[] = d.steps || [];
  return <div className="col" style={{ gap: 4 }}>
    <p className="small muted">{`${who} heard these steps. Save them and ${who} writes them up as a skill to do this itself next time.`}</p>
    {steps.length > 0 && <details><summary className="small faint">{`${d.n} step${d.n === 1 ? "" : "s"}${d.full ? " (recording stopped there)" : ""} · typed text not recorded`}</summary><ol className="small">{steps.slice(0, 60).map((s, i) => <li key={i}>{s}</li>)}</ol>{steps.length > 60 && <p className="small faint">{`…and ${steps.length - 60} more`}</p>}</details>}
  </div>;
}
