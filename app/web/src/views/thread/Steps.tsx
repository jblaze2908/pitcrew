// A run's tool calls: one Steps fold per run, each call a row that opens to its input, output and error.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PitStop, ThreadEvent } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { OUTCOME, PitCard } from "../../components/PitCard";
import { StepIcon } from "../../components/StepIcon";
import { plainWords, plural, tidyTitle } from "../../lib/format";
import { pitLabel, runSummary, stepView } from "../../lib/steps";
const stepOk = (e: ThreadEvent) => e.data.status === "completed" && (e.data.exitCode == null || e.data.exitCode === 0);

/** A Code Mode script: its code, and its output once the turn has it (a scriptResult event, merged in by callId). */
function Script({ e, result }: { e: ThreadEvent; result?: Record<string, any> }) {
  const failed = !!result && result.status !== "completed", lines = String(e.data.code || "").split("\n").length;
  return (
    <details className="tool script"><summary><StepIcon name="code" /><span className="lbl">Ran a script</span><span className="det">{`${plural(lines, "line")}${result ? "" : " · running"}`}</span>{failed && <span className="tag failed">Failed</span>}</summary>
      <pre>{e.data.code}</pre>
      {result?.output && <><p className="small faint" style={{ margin: "8px 0 4px" }}>Output</p><pre>{result.output}</pre></>}
    </details>
  );
}

// JSON reads better indented; anything else as it came.
const asJson = (t: string) => { try { const j = JSON.parse(t); return typeof j === "object" && j ? JSON.stringify(j, null, 2) : null; } catch { return null; } };
// Engram puts a one-line untrusted notice before the JSON; keep the line, indent the rest.
const pretty = (s: unknown) => {
  const t = String(s ?? ""), whole = asJson(t);
  if (whole) return whole;
  const nl = t.indexOf("\n"), rest = nl > 0 ? asJson(t.slice(nl + 1)) : null;
  return rest ? `${t.slice(0, nl)}\n\n${rest}` : t;
};
function Section({ label, text, bad }: { label: string; text: string; bad?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
  return (
    <div className={`dbg${bad ? " bad" : ""}`}>
      <div className="dbg-h"><span>{label}</span><button type="button" className="small faint" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
      <pre>{text}</pre>
    </div>
  );
}
const ms = (d: Record<string, any>) => {
  const n = typeof d.durationMs === "number" ? d.durationMs : d.timing && typeof d.timing === "object" ? Object.values(d.timing as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0) : null;
  return n == null ? null : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
};
/** What a step did, for debugging: which tool, how long, how it ended, then its input, output and error. */
function Debug({ d }: { d: Record<string, any> }) {
  const meta = [d.server && d.tool ? `${d.server} · ${d.tool}` : d.type, ms(d), d.status, d.exitCode != null ? `exit ${d.exitCode}` : null, d.cwd ? `in ${d.cwd}` : null, d.viaScript ? "from a script" : null].filter(Boolean).join(" · ");
  return (
    <div className="tool-debug">
      <p className="small faint">{meta}</p>
      {d.input && <Section label="Input" text={pretty(d.input)} />}
      {d.output && <Section label="Output" text={pretty(d.output)} />}
      {d.error && <Section label="Error" text={String(d.error)} bad />}
    </div>
  );
}

const SECRET_SCOPE: Record<string, string> = { thread: "allowed for this task", always: "always allowed", once: "allowed once" };
/** pit: the decided pit stop that gated this call, shown as its outcome tag and jev's reason instead of a row of its own. */
export function Tool({ e, results, pit }: { e: ThreadEvent; results?: Map<string, Record<string, any>>; pit?: PitStop }) {
  if (e.data.type === "script") return <Script e={e} result={results?.get(e.data.callId)} />;
  const failed = !stepOk(e) && e.data.status !== "inProgress";
  const v = stepView(tidyTitle(e.data.title), e.data.conn), j = pit?.jev || {};
  return <details className={`tool${e.data.viaScript ? " nested" : ""}`}><summary><StepIcon name={v.icon} /><span className="lbl">{v.label}</span>{v.detail && <span className={`det${v.icon === "terminal" ? " code" : ""}`}>{v.detail}</span>}
    {failed ? <span className="tag failed">Failed</span> : pit && <span className={`tag ${pit.status}`}>{pit.kind === "secret" && pit.status === "approved" ? SECRET_SCOPE[pit.scope || ""] || OUTCOME.approved : OUTCOME[pit.status]}</span>}</summary>
    {j.reason && <p className="why">{`Safety check: ${plainWords(j.reason)}`}</p>}<Debug d={e.data} /></details>;
}

/** Each decided pit stop's gated call: the next tool call within 4 steps with the same label (an approved call runs
 * right after its pit stop). A pit stop with no such call (denied, expired) keeps its own row. */
function gatedCalls(events: ThreadEvent[], pits: Record<string, PitStop>) {
  const byCall = new Map<number, PitStop>(), merged = new Set<number>();
  events.forEach((e, i) => {
    const p = e.kind === "pitstop" ? pits[e.data.id] : undefined;
    if (!p || p.status !== "approved") return;
    const label = pitLabel(p).label;
    const hit = events.slice(i + 1, i + 5).find((x) => x.kind === "tool" && !byCall.has(x.id) && stepView(tidyTitle(x.data.title), x.data.conn).label === label);
    if (hit) { byCall.set(hit.id, p); merged.add(e.id); }
  });
  return { byCall, merged };
}

/** A run's tool calls fold into one "N steps" row under the message before them: open while the run goes, folded when
 * it ends (closeSignal bumps). Decided pit stops ride in the same group as their own line, counted in the summary. */
export function Steps({ events, pits, initialOpen, closeSignal, results }: { events: ThreadEvent[]; pits: Record<string, PitStop>; initialOpen: boolean; closeSignal: number; results?: Map<string, Record<string, any>> }) {
  const [open, setOpen] = useState(initialOpen);
  const first = useRef(closeSignal);
  useEffect(() => { if (closeSignal !== first.current) setOpen(false); }, [closeSignal]);
  const tools = events.filter((e) => e.kind === "tool"), decided = events.flatMap((e) => (e.kind === "pitstop" && pits[e.data.id] ? [pits[e.data.id]] : []));
  const bad = tools.filter((e) => !stepOk(e) && e.data.status !== "inProgress").length;
  const n = (st: PitStop["status"]) => decided.filter((p) => p.status === st).length;
  const gated = useMemo(() => gatedCalls(events, pits), [events, pits]);
  const said = useMemo(() => runSummary(tools.map((e) => ({ type: String(e.data.type), nested: !!e.data.viaScript, v: stepView(tidyTitle(e.data.title || ""), e.data.conn) }))), [events]);
  // Approvals stay out of the sentence; only what went wrong gets a (soft) colour.
  const trouble = [n("expired") ? { k: "expired", t: `${n("expired")} no answer` } : null, n("denied") ? { k: "denied", t: `${n("denied")} denied` } : null, bad ? { k: "failed", t: `${bad} failed` } : null].filter(Boolean) as { k: string; t: string }[];
  return (
    <details className="steps" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {said.map((p, i) => typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : <em key={i}>{p.em}</em>)}
        {trouble.map((x) => <Fragment key={x.k}>{" · "}<span className={`tr ${x.k}`}>{x.t}</span></Fragment>)}
        <Icon name="chev" size={12} />
      </summary>
      <div className="steps-body">{events.map((e) => e.kind === "pitstop"
        ? pits[e.data.id] && !gated.merged.has(e.id) && <PitCard key={e.id} p={pits[e.data.id]} row />
        : <Tool key={e.id} e={e} results={results} pit={gated.byCall.get(e.id)} />)}</div>
    </details>
  );
}
