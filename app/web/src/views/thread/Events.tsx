// One transcript event as an element. Tool calls are grouped by the caller (see groupEvents).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Img, ImageIndex } from "../../lib/images";
import { editOf, type EditAsk } from "../../../../shared/edits";
import type { Bot, DelegationCard as Deleg, PitStop, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { DelegationCard } from "../../components/DelegationCard";
import { OUTCOME, PitCard } from "../../components/PitCard";
import { PlanCard, PlanChip } from "../../components/PlanCard";
import { BusyButton, Face, Inline, Md } from "../../components/ui";
import { plainWords, tidyTitle } from "../../lib/format";
import { pitLabel, runSummary, stepView } from "../../lib/steps";
import { Icon } from "../../components/Icon";
import { StepIcon } from "../../components/StepIcon";
import { api } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";
import { catches } from "./Painting";
import { ReplyActions } from "./Rewind";

export const stepOk = (e: ThreadEvent) => e.data.status === "completed" && (e.data.exitCode == null || e.data.exitCode === 0);
const isImg = (p: string) => /\.(png|jpe?g|webp|gif)$/i.test(p);

export function UserMsg({ e, botId, fromName, images, onView }: { e: ThreadEvent; botId: string; fromName: string; images?: ImageIndex; onView?: (im: Img) => void }) {
  const d = e.data;
  const via = d.via === "schedule" ? "Scheduled" : d.via === "delegation" ? `${fromName} asks` : d.via === "plan" ? "Plan step" : d.via === "resume" ? "Picked up again" : null;
  const ed = editOf(d.text), loose = (p: string): Img => ({ id: `a:${p}`, path: p, parentId: null, botId, caption: "", at: e.ts });
  const atts = ((d.attachments || []) as string[]).filter((p) => p !== ed?.marked);
  return (
    <div className="msg me">
      {via && <span className="pc-lab">{via}</span>}
      {ed ? <EditAskView ed={ed} botId={botId} at={e.ts} images={images} onView={onView} /> : <Inline text={d.display || d.text} />}
      {atts.length > 0 && (
        <div className="sent-atts">{atts.map((p) => isImg(p)
          ? <button key={p} className="img-open" title="Open" onClick={() => onView?.(loose(p))}><img src={`/files/${botId}/${p}?inline=1`} alt={p.split("/").pop()} loading="lazy" /></button>
          : <a key={p} className="pc-chip" href={`/files/${botId}/${p}`}>{p.split("/").pop()!.replace(/^[a-z0-9]+-/, "")}</a>)}
        </div>)}
    </div>
  );
}

/** The version an edit asks about, drawn with your marks (the marked copy when there is one), then the words. */
function EditAskView({ ed, botId, at, images, onView }: { ed: EditAsk; botId: string; at: number; images?: ImageIndex; onView?: (im: Img) => void }) {
  const im = images?.all.filter((x) => x.path === ed.image && x.at <= at).pop();
  const ver = im ? images!.chain(im.id).length : 0;
  const thumb = ed.marked || ed.image;
  const pins = ed.pins.length;
  const sub = [ed.brushed ? "brushed" : "", pins ? `${pins} pin${pins > 1 ? "s" : ""}` : "", ed.model || ""].filter(Boolean).join(" · ");
  return <>
    <button className="edit-ref" title="Open" onClick={() => onView?.(im || { id: `a:${thumb}`, path: thumb, parentId: null, botId, caption: "", at })}>
      <img src={`/files/${botId}/${thumb}?inline=1`} alt="" loading="lazy" />
      <span><span>{ver ? `Editing v${ver}` : "Editing an image"}</span>{sub && <small>{sub}</small>}</span>
    </button>
    {ed.typed || (pins ? null : "Edit this image")}
    {ed.pins.some(Boolean) && <span className="edit-pins">{ed.pins.map((n, i) => n && <span key={i}><b>{i + 1}</b>{n}</span>)}</span>}
  </>;
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

/** Images a member made (generate_image or Codex's image_gen), kept in its out/images. 440px with actions on hover; a
 * click opens the viewer (Viewer.tsx). A version that was edited further shrinks, so the newest one carries the thread. */
function Images({ e, b, c }: { e: ThreadEvent; b: Bot; c: EventCtx }) {
  const d = e.data, paths = d.paths as string[], ids: string[] = paths.map((p, i) => d.ids?.[i] || `p:${p}`);
  // The paint caught while waiting covers the image, then falls away once (Painting.tsx).
  const [cover] = useState(() => (d.paintingId && catches.get(d.paintingId)) || null);
  const [gone, setGone] = useState(!cover);
  const [burst, setBurst] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => { if (!cover) return; catches.delete(d.paintingId); const t = setTimeout(() => setGone(true), 1700); return () => clearTimeout(t); }, [cover, d.paintingId]);
  const I = c.images, one = paths.length === 1 ? I?.byId.get(ids[0]) : undefined;
  const ver = one ? I!.chain(one.id).length : 0, old = !!one && I!.edited.has(one.id), fam = one && !old ? I!.family(one.id) : [];
  const parent = one?.parentId ? I!.byId.get(one.parentId) : undefined;
  const keep = async (id: string) => { if (id.startsWith("p:") || I?.kept.has(id)) return; setBurst(id); setTimeout(() => setBurst(null), 900); await c.onKeep?.(id); };
  const meta = [d.model, d.cost != null ? `$${Number(d.cost).toFixed(3)}` : null, d.pasted ? (d.pasted.ok ? "nothing changed outside the brush" : "whole image changed") : null].filter(Boolean) as string[];
  const Burst = () => <span className="burst" aria-hidden="true">{["--c5", "--c2", "--c3", "--c6", "--c1", "--c5"].map((h, i) => <i key={i} style={{ background: `var(${h})`, ["--a" as any]: `${i * 60}deg` }} />)}</span>;
  return (
    <div className="msg bot"><Face b={b} size="sm" mood="idle" />
      <figure className={`shot img-card${old ? " old" : ""}`}>
        <div className={`img-wrap${paths.length > 1 ? " shot-grid" : ""}`}>{paths.map((p, i) => {
          const im = I?.byId.get(ids[i]), kept = I?.kept.has(ids[i]);
          return <div key={p} className={`img-tile${kept ? " kept" : ""}`}>
            <button className="img-open" title="Open" onClick={() => im && c.onView?.(im)}><img src={`/files/${d.botId}/${p}?inline=1`} alt={d.caption} loading="lazy" /></button>
            {!old && paths.length === 1 && <span className="img-tag">Open</span>}
            {kept && <span className="img-tag kept">Kept</span>}
            {im && !old && <span className="img-acts">
              <button onClick={() => c.onEdit?.(im)}>Edit</button>
              {one && parent ? <button onClick={() => c.onCompare?.(im)}>{`Compare with v${ver - 1}`}</button> : <button onClick={() => c.onMore?.(im)}>More like this</button>}
              {!ids[i].startsWith("p:") && !kept && <button onClick={() => keep(ids[i])}>Keep{burst === ids[i] && <Burst />}</button>}
              <a href={`/files/${d.botId}/${p}`} download title="Download">↓</a>
            </span>}
          </div>;
        })}{!gone && cover && <div className="unveil" aria-hidden="true">{Array.from({ length: 48 }, (_, i) => <i key={i} style={{ background: cover[i] || undefined, ["--r" as any]: `${((i * 47) % 60) - 30}deg`, animationDelay: `${((i * 29) % 12) * 35}ms` }} />)}</div>}</div>
        {old ? <figcaption className="small faint"><span><b className="img-ver">{`v${ver}`}</b>{` · edited into v${ver + 1} below`}</span></figcaption>
          : <figcaption className="small muted">
              <span className="img-line">{ver > 0 && <b className="img-ver">{`v${ver}`}</b>}{meta.map((m) => <span key={m} className="faint">{m}</span>)}{cover && cover.length > 0 && <span className="faint">{`thanks for the ${cover.length} squares`}</span>}</span>
              {d.caption && <button className={`img-prompt${full ? " full" : ""}`} title={full ? "Show less" : "Show the whole prompt"} onClick={() => setFull((v) => !v)}><span>{d.caption}</span><u>{full ? "less" : "more"}</u></button>}
            </figcaption>}
        {fam.length > 1 && <div className="vers" aria-label="Versions">{fam.map((v, i) => <Fragment key={v.id}>{i > 0 && <i className="ln" />}
          <button className={`ver${v.id === one!.id ? " on" : ""}${I!.kept.has(v.id) ? " kept" : ""}`} title="Open this version" onClick={() => c.onView?.(v)}>
            <img src={`/files/${v.botId}/${v.path}?inline=1`} alt="" loading="lazy" /><span>{`v${I!.chain(v.id).length}`}</span></button></Fragment>)}</div>}
      </figure>
    </div>
  );
}

/** A Code Mode script: its code, and its output once the turn has it (a scriptResult event, merged in by callId). */
function Script({ e, result }: { e: ThreadEvent; result?: Record<string, any> }) {
  const failed = !!result && result.status !== "completed", lines = String(e.data.code || "").split("\n").length;
  return (
    <details className="tool script"><summary><StepIcon name="code" /><span className="lbl">Ran a script</span><span className="det">{`${lines} line${lines === 1 ? "" : "s"}${result ? "" : " · running"}`}</span>{failed && <span className="tag failed">Failed</span>}</summary>
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

// Every system event in a thread is one quiet line: a small icon and a grey sentence aligned with the reply text.
const NOTE_ICON = {
  restart: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
  mark: '<path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/>',
  tools: '<path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7" fill="var(--ground)"/><circle cx="10" cy="11" r="1.7" fill="var(--ground)"/>',
  retro: '<path d="M3 4h7M3 8h10M3 12h5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
  quiet: '<path d="M12.5 10A5 5 0 0 1 6 3.5a5 5 0 1 0 6.5 6.5z"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  alert: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 11h.01"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5h.01"/>',
  mail: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M3 4.5l5 4 5-4"/>',
  compact: '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>',
  rewind: '<path d="M6.5 4.5L3 8l3.5 3.5M3 8h10"/>',
} as const;
type NoteIcon = keyof typeof NOTE_ICON;
export function Note({ icon, bad, title, children }: { icon: NoteIcon; bad?: boolean; title?: string; children: ReactNode }) {
  return <p className={`tnote${bad ? " bad" : ""}`} title={title}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: NOTE_ICON[icon] }} />
    <span>{children}</span></p>;
}
/** Stored notes come with and without a full stop; each sentence ends once, with a space before any inline action. */
const said = (s: string) => `${/[.!?…:)”"]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`} `;

type Learned = { memory_id: string; text: string; state: "saved" | "held" | "known" | "replaced" | "undone" };
const LEARNED_SAID: Record<Learned["state"], string> = { saved: "Remembered", held: "Waiting for your review before it's shared", known: "Already knew", replaced: "Remembered, replacing an older note", undone: "Undone" };
/** What this run remembered, one note per memory with Undo inline; read from the turn, so an undo shows after a reload. */
function LearnedNotes({ d }: { d: Record<string, any> }) {
  const f = useFetch(() => api.get<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned`, { quiet: true }), [d.turnId]);
  const [items, setItems] = useState<Learned[] | null>(null);
  const list = items ?? f.data?.items ?? null;
  if (!list?.length) return null;
  const undo = async (m: Learned) => setItems((await api.post<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned/${encodeURIComponent(m.memory_id)}/undo`)).items);
  return <>{list.map((m) => (
    <Note key={m.memory_id} icon="mark">{said(`${LEARNED_SAID[m.state]}: ${m.text}`)}
      {m.state === "saved" && <BusyButton className="lnk" busyLabel="Undoing…" onClick={() => undo(m)}>Undo</BusyButton>}</Note>))}</>;
}

const MODE_SAID: Record<string, string> = {
  ask: "You switched this thread to Ask first: it asks before sending, paying, signing in, installing, sharing or deleting.",
  handsfree: "You switched this thread to Hands-free: it stops only for paying, signing in, sending, sharing and deleting.",
  yolo: "You switched this thread to YOLO: no pit stops, paying and sending included. Hard blocks and house rules still apply.",
};
// Mode notes are stored with the server's long sentence (api/threads.ts AUTONOMY_NOTE); the label before the colon names the mode.
const modeOf = (t: string) => /^Ask first:/.test(t) ? "ask" : /^Hands-free:/.test(t) ? "handsfree" : /^YOLO:/.test(t) ? "yolo" : null;
const isRestart = (e: ThreadEvent) => e.kind === "system" && /^Pitcrew restarted/.test(e.data.text || "");
const CONTINUE = "Say continue to pick it up.";
const isRemembered = (t: string) => /^(Remembered|Sent to Engram for [^:]*review): /.test(t);

/** Notes that fold into a neighbour: a restart into the resume or "continue" right after it, and "Remembered" into the
 * run's memory notes (LearnedNotes). Also the newest mode note, the only one offering a way back. One pass per events change. */
export function noteFolds(events: ThreadEvent[]) {
  const hide = new Set<number>(), learned = new Set<string>();
  let modeNote: number | null = null;
  for (const e of events) {
    if (e.kind === "learned" && e.turn_id) learned.add(e.turn_id);
    if (e.kind === "system" && modeOf(e.data.text || "")) modeNote = e.id;
  }
  events.forEach((e, i) => {
    if (isRestart(e)) {
      const next = events.slice(i + 1, i + 5).find((x) => x.kind === "user" || x.kind === "system");
      if (next && ((next.kind === "user" && next.data.via === "resume") || next.data.text === CONTINUE)) hide.add(e.id);
    }
    if (e.kind === "system" && e.turn_id && learned.has(e.turn_id) && isRemembered(e.data.text || "")) hide.add(e.id);
  });
  return { hide, modeNote };
}

/** A retro's note: "Looking back at the run · <why> · <what changed>" (runtime/turns.ts) as a sentence, the change behind Details. */
function RetroNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const parts = text.split(" · "), why = parts.length > 2 ? parts[1] : null, outcome = parts.slice(why ? 2 : 1).join(" · ");
  return <>
    <Note icon="retro">{said(`How this run went: ${why || outcome || "looked back at it"}`)}
      {why && outcome && <button className="lnk" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>}</Note>
    {open && <p className="tnote sub"><span>{said(`Looking back on it: ${outcome}`)}</span></p>}
  </>;
}

function SystemNote({ e, c }: { e: ThreadEvent; c: EventCtx }) {
  const d = e.data, t = String(d.text || "");
  // A restart cut the run (runtime/lifecycle.ts): nothing broke on the member's side, so no red.
  if (isRestart(e)) return <Note icon="restart">Pitcrew restarted during this run, so it stopped partway.</Note>;
  if (t === CONTINUE) return <Note icon="restart">{"Pitcrew restarted, so the last run stopped partway. "}{c.onContinue && <button className="lnk" onClick={c.onContinue}>Pick up where it left off</button>}</Note>;
  // A mode change isn't a failure: older YOLO notes were stored with the bad tone.
  const mode = modeOf(t);
  if (mode) return <Note icon="shield">{`${MODE_SAID[mode]} `}{mode !== "ask" && e.id === c.modeNote && c.autonomy === mode && c.onAutonomy && <button className="lnk" onClick={() => c.onAutonomy!("ask")}>Back to Ask first</button>}</Note>;
  if (d.retro) return <RetroNote text={t} />;
  const icon: NoteIcon = /tools changed|^Tools and skills reload/.test(t) ? "tools" : /^(Remembered|Noted for this thread|Learned|Sent to Engram)/.test(t) ? "mark"
    : /compact/i.test(t) ? "compact" : /^Rewound/.test(t) ? "rewind" : /^(Usage limit|Scheduled|Changed schedule|Cancelled schedule)/.test(t) ? "clock"
    : /untrusted content/.test(t) ? "shield" : /^Published/.test(t) ? "check" : d.tone === "bad" ? "alert" : "info";
  return <Note icon={icon} bad={d.tone === "bad"}>{said(plainWords(t).replace(/^Sent to Engram for [^:]*review: /, "Waiting for your review before it's shared: "))}</Note>;
}

/** A user event that isn't the driver typing (a schedule, a resume, a retro) as a note; null for a real message. */
function userNote(d: Record<string, any>): ReactNode {
  switch (d.via) {
    case "check": return <Note icon="alert" bad>{said(d.display || "Done-check")}</Note>;
    case "retro": return <Note icon="retro">{said(String(d.display || "Looked back at the run").replace(/^Retro\b/, "Looked back at the run").replace(/ · /g, ": "))}</Note>;
    case "teach": return <Note icon="mark">{said(String(d.display || "Save as skill").replace(/ · /g, ", "))}</Note>;
    case "resume": return <Note icon="restart">{/^Pitcrew restarted/.test(d.text || "") ? "Pitcrew restarted and picked up where it left off." : "The usage limit reset, so it picked up where it left off."}</Note>;
    case "email": return <Note icon="mail">{said(d.display || "An email arrived")}</Note>;
    // A scheduled run's prompt is the same every time: a note, not a message bubble.
    case "schedule": return <Note icon="clock">{/^\[Event\]/.test(d.text || "") ? said(d.display || "An event arrived") : said(`Scheduled run, ${String(d.text || "").replace(/^\[Scheduled: ([^\]]+)\][\s\S]*/, "$1")}`)}</Note>;
  }
  return null;
}

export interface EventCtx { cont?: boolean; b: Bot; fromName: string; pits: Record<string, PitStop>; latest: Map<string, Record<string, any>>; surface: (id: string) => ReactNode;
  /** Opens the work panel's Plan tab; when set, plans show as a chip in the chat instead of the full card. */
  onPlan?: () => void;
  /** Sends "continue" after a restart cut a run that won't resume on its own; unset once the driver has written since. */
  onContinue?: () => void;
  images?: ImageIndex; onView?: (im: Img) => void; onCompare?: (im: Img) => void; onEdit?: (im: Img) => void; onMore?: (im: Img) => void; onKeep?: (id: string) => Promise<unknown>;
  /** The last reply of each finished, not yet rewound run: those get Copy and Rewind (Rewind.tsx). */
  rewind?: { ids: Set<number>; onRewound: () => void };
  /** Folded notes and the newest mode note (noteFolds), plus the thread's mode so that note can offer the way back. */
  hide?: Set<number>; modeNote?: number | null; autonomy?: string; onAutonomy?: (a: string) => void }

/** A done-check result (runtime/donecheck.ts) as a note: checked with its proof one click away, a retry, or why not. */
function CheckLine({ d }: { d: Record<string, any> }) {
  if (d.status === "retrying") return <Note icon="alert" bad>{`The done-check couldn't confirm ${d.headline}, so it's trying again (${d.attempt} of ${d.of}).`}</Note>;
  if (d.status !== "passed") return <Note icon="check">{said(`Not checked: ${d.why || "no grader"}`)}</Note>;
  const src = d.proof?.file ? `/shots/${d.proof.botId}/${d.proof.file}` : null;
  const how = `Graded by a second model against ${d.n} criteri${d.n === 1 ? "on" : "a"}${d.attempt ? ` after ${d.attempt} ${d.attempt === 1 ? "retry" : "retries"}` : ""}`;
  return <Note icon="check" title={how}>{d.evidence ? <>{"Checked: "}<Inline text={said(d.evidence)} /></> : "Checked. "}{src && <a className="lnk" href={src} target="_blank" rel="noopener">Proof</a>}</Note>;
}

/** The element for one event, or null when it draws nothing (an unknown pit stop or surface). */
export function renderEvent(e: ThreadEvent, c: EventCtx): ReactNode {
  const d = e.data;
  if (c.hide?.has(e.id)) return null;
  switch (e.kind) {
    case "user": return userNote(d) ?? <UserMsg e={e} botId={c.b.id} fromName={c.fromName} images={c.images} onView={c.onView} />;
    // A follow-on message from the same member (only steps between) drops the face; the column stays for alignment.
    // A scheduled run with nothing notable (runtime/turns.ts isQuiet): one note.
    case "agent": if (/^\s*QUIET\b/.test(d.text || "")) { const why = String(d.text).replace(/^\s*QUIET:?\s*/, "").trim(); return <Note icon="quiet">{why ? said(`Nothing new: ${why}`) : "Nothing new."}</Note>; }
      return <div className={`msg bot${c.cont ? " cont" : ""}`}>{c.cont ? <span /> : <Face b={c.b} size="sm" mood="idle" />}
        {c.rewind?.ids.has(e.id) && e.turn_id ? <div className="reply"><Md text={d.text} /><ReplyActions text={d.text} turnId={e.turn_id} name={c.b.name} onRewound={c.rewind.onRewound} /></div> : <Md text={d.text} />}</div>;
    case "check": return <CheckLine d={d} />;
    case "shot": return <Shot e={e} b={c.b} />;
    case "image": return <Images e={e} b={c.b} c={c} />;
    case "tool": return <Tool e={e} />;
    case "system": return <SystemNote e={e} c={c} />;
    case "error": return <Note icon="alert" bad>{said(String(d.text || "Something went wrong"))}</Note>;
    // Older runs recorded a changed-files card; threads no longer draw it (Crew → Files keeps the history).
    case "changes": return null;
    case "learned": return <LearnedNotes d={d} />;
    case "delegation": return <DelegationCard d={(c.latest.get(d.id) || d) as Deleg} />;
    case "plan": { const P = (c.latest.get(d.id) || d) as PlanSnapshot; return c.onPlan ? <PlanChip P={P} onOpen={c.onPlan} /> : <PlanCard P={P} />; }
    case "pitstop": { const p = c.pits[d.id]; return p ? <div style={{ marginLeft: 40, maxWidth: 760 }}><PitCard p={p} /></div> : null; }
    case "surface": return c.surface(d.id);
  }
  return null;
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
