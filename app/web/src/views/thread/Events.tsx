// One transcript event as an element. layout.ts decides which events draw and groups tool calls into Steps.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { editOf, type EditAsk } from "../../../../shared/edits";
import type { Bot, DelegationCard as Deleg, PitStop, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { DelegationCard } from "../../components/DelegationCard";
import { PitCard } from "../../components/PitCard";
import { PlanCard, PlanChip } from "../../components/PlanCard";
import { Face, Inline, Md } from "../../components/ui";
import { plural } from "../../lib/format";
import { attachmentName, imgFile, imgSrc, isImagePath, type Img, type ImageIndex } from "../../lib/images";
import { CheckLine, LearnedNotes, Note, said, SystemNote, userNote } from "./Notes";
import { catches } from "./Painting";
import { ReplyActions } from "./Rewind";
import { Tool } from "./Steps";

function UserMsg({ e, botId, fromName, images, onView }: { e: ThreadEvent; botId: string; fromName: string; images?: ImageIndex; onView?: (im: Img) => void }) {
  const d = e.data;
  const via = d.via === "schedule" ? "Scheduled" : d.via === "delegation" ? `${fromName} asks` : d.via === "plan" ? "Plan step" : d.via === "resume" ? "Picked up again" : null;
  const ed = editOf(d.text), loose = (p: string): Img => ({ id: `a:${p}`, path: p, parentId: null, botId, caption: "", at: e.ts });
  const atts = ((d.attachments || []) as string[]).filter((p) => p !== ed?.marked);
  return (
    <div className="msg me">
      {via && <span className="pc-lab">{via}</span>}
      {ed ? <EditAskView ed={ed} botId={botId} at={e.ts} images={images} onView={onView} /> : <Inline text={d.display || d.text} />}
      {atts.length > 0 && (
        <div className="sent-atts">{atts.map((p) => isImagePath(p)
          ? <button key={p} className="img-open" title="Open" onClick={() => onView?.(loose(p))}><img src={imgSrc({ botId, path: p })} alt={p.split("/").pop()} loading="lazy" /></button>
          : <a key={p} className="pc-chip" href={imgFile({ botId, path: p })}>{attachmentName(p)}</a>)}
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
  const sub = [ed.brushed ? "brushed" : "", pins ? plural(pins, "pin") : "", ed.model || ""].filter(Boolean).join(" · ");
  return <>
    <button className="edit-ref" title="Open" onClick={() => onView?.(im || { id: `a:${thumb}`, path: thumb, parentId: null, botId, caption: "", at })}>
      <img src={imgSrc({ botId, path: thumb })} alt="" loading="lazy" />
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
            <button className="img-open" title="Open" onClick={() => im && c.onView?.(im)}><img src={imgSrc({ botId: d.botId, path: p })} alt={d.caption} loading="lazy" /></button>
            {!old && paths.length === 1 && <span className="img-tag">Open</span>}
            {kept && <span className="img-tag kept">Kept</span>}
            {im && !old && <span className="img-acts">
              <button onClick={() => c.onEdit?.(im)}>Edit</button>
              {one && parent ? <button onClick={() => c.onCompare?.(im)}>{`Compare with v${ver - 1}`}</button> : <button onClick={() => c.onMore?.(im)}>More like this</button>}
              {!ids[i].startsWith("p:") && !kept && <button onClick={() => keep(ids[i])}>Keep{burst === ids[i] && <Burst />}</button>}
              <a href={imgFile({ botId: d.botId, path: p })} download title="Download">↓</a>
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
            <img src={imgSrc(v)} alt="" loading="lazy" /><span>{`v${I!.chain(v.id).length}`}</span></button></Fragment>)}</div>}
      </figure>
    </div>
  );
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
        {c.rewind?.ids.has(e.id) && e.turn_id ? <div className="reply"><Md text={d.text} botId={c.b.id} /><ReplyActions text={d.text} turnId={e.turn_id} name={c.b.name} onRewound={c.rewind.onRewound} /></div> : <Md text={d.text} botId={c.b.id} />}</div>;
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
