// One transcript event as an element. Tool calls are grouped by the caller (see groupEvents).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bot, DelegationCard as Deleg, PitStop, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { DelegationCard } from "../../components/DelegationCard";
import { PitCard } from "../../components/PitCard";
import { PlanCard } from "../../components/PlanCard";
import { Face, Md } from "../../components/ui";
import { tidyTitle } from "../../lib/format";

export const stepOk = (e: ThreadEvent) => e.data.status === "completed" && (e.data.exitCode == null || e.data.exitCode === 0);
const isImg = (p: string) => /\.(png|jpe?g|webp|gif)$/i.test(p);

export function UserMsg({ e, botId, fromName }: { e: ThreadEvent; botId: string; fromName: string }) {
  const d = e.data;
  const via = d.via === "schedule" ? "scheduled · " : d.via === "delegation" ? `${fromName} asks · ` : d.via === "plan" ? "Pitcrew · " : null;
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

export function Tool({ e }: { e: ThreadEvent }) {
  const st = stepOk(e) ? "ok" : e.data.status === "inProgress" ? "" : "bad";
  return <details className="tool"><summary><span className={`st ${st}`} />{tidyTitle(e.data.title)}</summary>{(e.data.output || e.data.error) && <pre>{e.data.error || e.data.output}</pre>}</details>;
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

export interface EventCtx { b: Bot; fromName: string; pits: Record<string, PitStop>; latest: Map<string, Record<string, any>>; surface: (id: string) => ReactNode }

/** The element for one event, or null when it draws nothing (an unknown pit stop or surface). */
export function renderEvent(e: ThreadEvent, c: EventCtx): ReactNode {
  const d = e.data;
  switch (e.kind) {
    case "user": return <UserMsg e={e} botId={c.b.id} fromName={c.fromName} />;
    case "agent": return <div className="msg bot"><Face b={c.b} size="sm" mood="idle" /><Md text={d.text} /></div>;
    case "shot": return <Shot e={e} b={c.b} />;
    case "tool": return <Tool e={e} />;
    case "system": return <p className={`sys ${d.tone === "bad" ? "bad" : ""}`}>{d.text}</p>;
    case "error": return <p className="err">{d.text}</p>;
    case "changes": return <Changes d={d} />;
    case "delegation": return <DelegationCard d={(c.latest.get(d.id) || d) as Deleg} />;
    case "plan": return <PlanCard P={(c.latest.get(d.id) || d) as PlanSnapshot} />;
    case "pitstop": { const p = c.pits[d.id]; return p ? <div style={{ marginLeft: 40, maxWidth: 760 }}><PitCard p={p} /></div> : null; }
    case "surface": return c.surface(d.id);
  }
  return null;
}

/** A run's tool calls fold into one "N steps" row: open while the run goes, folded when it ends (closeSignal bumps). */
export function Steps({ events, initialOpen, closeSignal }: { events: ThreadEvent[]; initialOpen: boolean; closeSignal: number }) {
  const [open, setOpen] = useState(initialOpen);
  const first = useRef(closeSignal);
  useEffect(() => { if (closeSignal !== first.current) setOpen(false); }, [closeSignal]);
  const bad = events.filter((e) => !stepOk(e) && e.data.status !== "inProgress").length;
  return (
    <details className="steps" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><span>{`${events.length} step${events.length === 1 ? "" : "s"}${bad ? ` · ${bad} failed` : ""}`}</span><span className="last">{tidyTitle(events[events.length - 1].data.title)}</span></summary>
      <div className="steps-body">{events.map((e) => <Tool key={e.id} e={e} />)}</div>
    </details>
  );
}
