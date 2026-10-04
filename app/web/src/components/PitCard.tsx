// A pit stop: what the member wants to do, why jev stopped it, and the choices that fit its kind.
import { useEffect, useState } from "react";
import type { EngramDecision, Personality, PitStop } from "../../../shared/types";
import { api } from "../lib/api";
import { ago, usd, when } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { ProposalSummary } from "./Engram";
import { EffectChip, Face } from "./ui";

type Scope = "once" | "thread" | "always" | "site" | "full" | "block";

export function PitCard({ p: given, onDone }: { p: PitStop; onDone?: (r: PitStop) => void }) {
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
    toast(decision === "accept" ? "Accepted in Engram" : decision === "keep" ? "Kept the current one" : "Rejected in Engram");
    if (r?.id) setP(r);
    onDone?.(r);
  };
  const btn = (label: string, onClick: () => void, sig = false) => <button className={`pc-pill ${sig ? "sig" : "o"} s`} onClick={onClick}>{label}</button>;
  const openLink = (label: string) => p.thread_id && <a className="small faint" href={`#/t/${p.thread_id}`} style={{ marginLeft: "auto" }}>{label}</a>;
  const noteInput = <input placeholder="Note for the crew (optional)" className="small" value={note} onChange={(e) => setNote(e.target.value)} />;
  const noAlways = ["pay", "delete", "share"].includes(p.effect) || p.kind === "hire" || p.kind === "plan";

  const body = p.kind === "command" ? <pre>{String(d.command || "").replace(/^\/bin\/(ba)?sh -l?c /, "")}</pre>
    : p.kind === "mcp" ? <pre>{`${d.server || ""}.${d.tool || ""}\n${JSON.stringify(d.args || d.message || {}, null, 1).slice(0, 1200)}`}</pre>
    : p.kind === "file" ? <pre>{(d.paths || []).join("\n")}</pre>
    : p.kind === "hire" ? <HireSummary s={d.spec || {}} />
    : p.kind === "site" ? <SiteSummary d={d} />
    : p.kind === "engram" && d.proposal ? <ProposalSummary x={d.proposal} />
    : p.kind === "soul" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p><pre>{d.soul}</pre>{d.before && <details><summary className="small faint">Current SOUL</summary><pre>{d.before}</pre></details>}</div>
    : p.kind === "retire" ? <div className="col" style={{ gap: 4 }}><p className="small muted">{d.why}</p><p className="small faint">{d.memberName}: {d.job || "no job set"}{d.schedules ? ` · ${d.schedules} schedule${d.schedules === 1 ? "" : "s"} will stop` : ""}. Threads and memory stay.</p></div> : null;

  const outcome = `${p.kind === "engram" && p.note ? p.note : p.status} ${ago(p.decided_at)}`;
  // Decided: one line that opens to the details, so a thread's history doesn't keep full cards around.
  if (done) return (
    <details className="pit done">
      <summary><Face b={b} size="sm" mood="idle" /><b>{b?.name || p.bot_id}</b><span className="t1">{p.title}</span><span className="pc-m small faint">{outcome}</span></summary>
      {body}
      {j.reason && <p className="why">{`jev · ${j.by || ""} · ${j.reason}${j.ms ? ` · ${j.ms} ms` : ""}`}</p>}
      {p.note && p.kind !== "engram" && <p className="small faint">{p.note}</p>}
      {typeof d.public_url === "string" && /^https:\/\//.test(d.public_url) && <p className="small"><a href={d.public_url} target="_blank" rel="noreferrer">{d.public_url}</a></p>}
    </details>
  );

  let actions = null;
  if (p.kind === "engram") actions = <div className="acts">
    {d.proposal?.replaces && btn("Keep current", () => engram("keep"))}
    {btn("Accept", () => engram("accept"), true)}
    {btn("Reject", () => engram("reject"))}
    <a className="small faint" href={`${S.engram.url}/#/inbox`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>Open in Engram</a></div>;
  else if (p.kind === "hire") actions = <div className="acts"><a className="pc-pill sig s" href={`#/hire/${p.id}`}>Review &amp; hire</a>{btn("Decline", () => decide("deny"))}</div>;
  else if (p.kind === "lease") actions = <div className="acts">{btn("Hand it back", () => decide("approve", "once"), true)}{btn("Keep control", () => decide("deny"))}<a className="small faint" href={`#/live/${p.bot_id}`} style={{ marginLeft: "auto" }}>Open live view</a></div>;
  else if (p.kind === "site") actions = <>{noteInput}<div className="acts">
    {p.thread_id && btn("Allow once (this thread)", () => decide("approve", "thread"))}
    {btn("Allow site", () => decide("approve", "site"), true)}
    {btn("Allow site fully", () => decide("approve", "full"))}
    {btn("Block site", () => decide("deny", "block"))}
    {openLink("Open thread")}</div></>;
  else if (p.kind === "soul") actions = <div className="acts">{btn("Use this SOUL", () => decide("approve", "once"), true)}{btn("Keep current", () => decide("deny"))}{openLink("Open thread")}</div>;
  else if (p.kind === "retire") actions = <div className="acts">{btn(`Retire ${d.memberName || "member"}`, () => decide("approve", "once"), true)}{btn("Keep", () => decide("deny"))}{openLink("Open thread")}</div>;
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
        <div className="row"><Face b={b} size="sm" mood="needs" /><b>{b?.name || p.bot_id}</b><EffectChip kind={p.effect} /></div>
        <span className="pc-m small faint">{p.kind === "engram" ? "from Engram" : `expires ${when(p.expires_at)}`}</span>
      </div>
      <p className="t">{p.title}</p>
      {body}
      {j.reason && <p className="why">{`jev · ${j.by || ""} · ${j.reason}${j.ms ? ` · ${j.ms} ms` : ""}`}</p>}
      {p.similar && !["pay", "delete", "share"].includes(p.effect) && <p className="small faint">{`Similar means: ${p.similar}.`}</p>}
      {p.learn && <p className="small faint">{p.learn.need - p.learn.streak <= 1
        ? `Approve this and ${who} stops asking for “${p.learn.label}”.`
        : `Approve “${p.learn.label}” ${p.learn.need - p.learn.streak} times in a row and ${who} stops asking.`}</p>}
      {actions}
    </div>
  );
}

// A domain pit stop: the exact address, https or not, and any look-alike warning, before the four choices.
function SiteSummary({ d }: { d: Record<string, any> }) {
  const warn = d.homograph || d.lookalike;
  return (
    <div className="col" style={{ gap: 4 }}>
      {warn && <p className="badc small">{`Looks like ${d.lookalike?.brand || d.homograph?.brand || "another site"}${d.lookalike?.domain ? ` (${d.lookalike.domain})` : ""}: ${[d.homograph?.why, d.lookalike?.why].filter(Boolean).join("; ")}${d.homograph?.unicode ? `. Shown as ${d.homograph.unicode}` : ""}.`}</p>}
      <pre>{`${d.url || d.host}\n${d.https ? "https" : "NOT https: anything typed here can be read in transit"}`}</pre>
      <p className="small faint">Allow site: browse it; other effects follow this member's permissions. Fully: every effect allowed there except paying, which always asks.</p>
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
        {(s.engram_scope && s.engram_scope !== "personal" || !!s.engram_connections?.length || s.engram_household) && <p className="small faint">{`Engram: ${s.engram_scope === "finance" ? "Money" : s.engram_scope === "health" ? "Health" : "Personal"} memories${s.engram_household ? " · household facts" : ""}${s.engram_connections?.length ? ` · reads ${s.engram_connections.join(", ")}` : ""}`}</p>}
      </div>
    </div>
  );
}
