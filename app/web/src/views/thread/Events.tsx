// One transcript event as an element. Tool calls are grouped by the caller (see groupEvents).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bot, DelegationCard as Deleg, PitStop, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { DelegationCard } from "../../components/DelegationCard";
import { PitCard } from "../../components/PitCard";
import { PlanCard } from "../../components/PlanCard";
import { BusyButton, Face, Md } from "../../components/ui";
import { tidyTitle } from "../../lib/format";
import { stepView } from "../../lib/steps";
import { StepIcon } from "../../components/StepIcon";
import { api } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";

export const stepOk = (e: ThreadEvent) => e.data.status === "completed" && (e.data.exitCode == null || e.data.exitCode === 0);
const isImg = (p: string) => /\.(png|jpe?g|webp|gif)$/i.test(p);

export function UserMsg({ e, botId, fromName }: { e: ThreadEvent; botId: string; fromName: string }) {
  const d = e.data;
  const via = d.via === "schedule" ? "scheduled · " : d.via === "delegation" ? `${fromName} asks · ` : d.via === "plan" || d.via === "resume" ? "Pitcrew · " : null;
  return (
    <div className="msg me">
      {via && <span className="pc-lab">{via}</span>}
      {d.display || d.text}
      {d.attachments?.length > 0 && (
        <div className="sent-atts">{(d.attachments as string[]).map((p) => isImg(p)
          ? <a key={p} href={`/files/${botId}/${p}?inline=1`} target="_blank" rel="noopener"><img src={`/files/${botId}/${p}?inline=1`} alt={p.split("/").pop()} loading="lazy" /></a>
          : <a key={p} className="pc-chip" href={`/files/${botId}/${p}`}>{p.split("/").pop()!.replace(/^[a-z0-9]+-/, "")}</a>)}
        </div>)}
    </div>
  );
}

function Shot({ e, b }: { e: ThreadEvent; b: Bot }) {
  const [gone, setGone] = useState(false);
  const src = `/shots/${e.data.botId}/${e.data.file}`;
  return (
    <div className="msg bot"><Face b={b} size="sm" mood="idle" />
      <figure className="shot">
        {gone ? <p className="small faint">{`Screenshot no longer kept · ${e.data.caption}`}</p>
          : <><a href={src} target="_blank" rel="noopener"><img src={src} alt={e.data.caption} loading="lazy" onError={() => setGone(true)} /></a><figcaption className="small muted">{e.data.caption}</figcaption></>}
      </figure>
    </div>
  );
}

/** A Code Mode script: its code, and its output once the turn has it (a scriptResult event, merged in by callId). */
function Script({ e, result }: { e: ThreadEvent; result?: Record<string, any> }) {
  const st = !result ? "" : result.status === "completed" ? "ok" : "bad", lines = String(e.data.code || "").split("\n").length;
  return (
    <details className="tool script"><summary><span className={`st ${st}`} /><StepIcon name="code" /><span className="lbl">Ran a script</span><span className="det">{`${lines} line${lines === 1 ? "" : "s"}${result ? "" : " · running"}`}</span></summary>
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

export function Tool({ e, results }: { e: ThreadEvent; results?: Map<string, Record<string, any>> }) {
  if (e.data.type === "script") return <Script e={e} result={results?.get(e.data.callId)} />;
  const st = stepOk(e) ? "ok" : e.data.status === "inProgress" ? "" : "bad";
  const v = stepView(tidyTitle(e.data.title), e.data.conn);
  return <details className={`tool${e.data.viaScript ? " nested" : ""}`}><summary><span className={`st ${st}`} /><StepIcon name={v.icon} /><span className="lbl">{v.label}</span>{v.detail && <span className="det">{v.detail}</span>}</summary><Debug d={e.data} /></details>;
}

function Changes({ d }: { d: Record<string, any> }) {
  return (
    <div className="changes">
      <div className="spread"><b className="small">{`Changed ${d.count} file${d.count === 1 ? "" : "s"}`}</b><a className="small faint" href={`#/crew/${d.botId}/files/${d.turnId}`}>Review changes</a></div>
      {(d.files as { path: string; status: string; lines?: number }[]).map((f) => (
        <a key={f.path} className="cf" href={`#/crew/${d.botId}/files/${d.turnId}/${encodeURIComponent(f.path)}`}>
          <span className={`pc-chip ${f.status === "added" ? "ok" : f.status === "deleted" ? "bad" : "blue"}`}>{f.status[0].toUpperCase()}</span>
          <span className="pc-m small">{f.path}</span>
          {f.lines ? <span className={`pc-m small ${f.lines > 0 ? "okc" : "badc"}`}>{`${f.lines > 0 ? "+" : ""}${f.lines} lines`}</span> : null}
        </a>))}
    </div>
  );
}

type Learned = { memory_id: string; text: string; state: "saved" | "held" | "known" | "replaced" | "undone" };
const LEARNED_STATE: Record<Learned["state"], string> = { saved: "saved", held: "waiting for you", known: "already known", replaced: "replaced an older one", undone: "undone" };
/** What this run remembered; read per card from the turn, so an undo shows after a reload too. */
function LearnedCard({ d }: { d: Record<string, any> }) {
  const f = useFetch(() => api.get<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned`, { quiet: true }), [d.turnId]);
  const [items, setItems] = useState<Learned[] | null>(null);
  const list = items ?? f.data?.items ?? null;
  if (!list?.length) return null;
  const undo = async (m: Learned) => setItems((await api.post<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned/${encodeURIComponent(m.memory_id)}/undo`)).items);
  return (
    <div className="changes learned">
      <b className="small">{`Learned this run · ${list.length}`}</b>
      {list.map((m) => (
        <div key={m.memory_id} className="cf">
          <span className={`pc-chip ${m.state === "saved" ? "ok" : m.state === "held" ? "blue" : ""}`}>{LEARNED_STATE[m.state]}</span>
          <span className={`small${m.state === "undone" ? " faint" : ""}`} style={m.state === "undone" ? { textDecoration: "line-through" } : undefined}>{m.text}</span>
          {m.state === "saved" && <BusyButton className="small faint" busyLabel="Undoing…" onClick={() => undo(m)}>Undo</BusyButton>}
        </div>))}
    </div>
  );
}

export interface EventCtx { cont?: boolean; b: Bot; fromName: string; pits: Record<string, PitStop>; latest: Map<string, Record<string, any>>; surface: (id: string) => ReactNode }

/** The element for one event, or null when it draws nothing (an unknown pit stop or surface). */
export function renderEvent(e: ThreadEvent, c: EventCtx): ReactNode {
  const d = e.data;
  switch (e.kind) {
    case "user": return <UserMsg e={e} botId={c.b.id} fromName={c.fromName} />;
    // A follow-on message from the same member (only steps between) drops the face; the column stays for alignment.
    case "agent": return <div className={`msg bot${c.cont ? " cont" : ""}`}>{c.cont ? <span /> : <Face b={c.b} size="sm" mood="idle" />}<Md text={d.text} /></div>;
    case "shot": return <Shot e={e} b={c.b} />;
    case "tool": return <Tool e={e} />;
    case "system": return <p className={`sys ${d.tone === "bad" ? "bad" : ""}`}>{d.text}</p>;
    case "error": return <p className="err">{d.text}</p>;
    case "changes": return <Changes d={d} />;
    case "learned": return <LearnedCard d={d} />;
    case "delegation": return <DelegationCard d={(c.latest.get(d.id) || d) as Deleg} />;
    case "plan": return <PlanCard P={(c.latest.get(d.id) || d) as PlanSnapshot} />;
    case "pitstop": { const p = c.pits[d.id]; return p ? <div style={{ marginLeft: 40, maxWidth: 760 }}><PitCard p={p} /></div> : null; }
    case "surface": return c.surface(d.id);
  }
  return null;
}

function Last({ e }: { e: ThreadEvent }) {
  const v = stepView(tidyTitle(e.data.title), e.data.conn);
  return <span className="last"><StepIcon name={v.icon} />{v.detail ? `${v.label} · ${v.detail}` : v.label}</span>;
}

/** A run's tool calls fold into one "N steps" row: open while the run goes, folded when it ends (closeSignal bumps). */
export function Steps({ events, initialOpen, closeSignal, results }: { events: ThreadEvent[]; initialOpen: boolean; closeSignal: number; results?: Map<string, Record<string, any>> }) {
  const [open, setOpen] = useState(initialOpen);
  const first = useRef(closeSignal);
  useEffect(() => { if (closeSignal !== first.current) setOpen(false); }, [closeSignal]);
  const bad = events.filter((e) => !stepOk(e) && e.data.status !== "inProgress").length;
  return (
    <details className="steps" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><span>{`${events.length} step${events.length === 1 ? "" : "s"}${bad ? ` · ${bad} failed` : ""}`}</span><Last e={events[events.length - 1]} /></summary>
      <div className="steps-body">{events.map((e) => <Tool key={e.id} e={e} results={results} />)}</div>
    </details>
  );
}
