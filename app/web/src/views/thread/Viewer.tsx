// The full-screen image viewer: one image large, its versions, before/after against its parent, and the actions.
// ←/→ walk the thread's images, C toggles compare, Esc closes. An attachment (not in the index) shows alone.
import { useEffect, useState } from "react";
import { imgFile, imgMeta, imgName, imgSrc, type Img, type ImageIndex } from "../../lib/images";

export interface ViewerActions { onEdit?: (im: Img) => void; onMore?: (im: Img) => void; onKeep?: (id: string) => Promise<unknown> }

export function Viewer({ I, start, compare, onClose, onEdit, onMore, onKeep }: { I: ImageIndex; start: Img; compare?: boolean; onClose: () => void } & ViewerActions) {
  const [cur, setCur] = useState(start);
  const [cmp, setCmp] = useState(!!compare && !!start.parentId);
  const [x, setX] = useState(50);
  const [full, setFull] = useState(false);
  const known = I.byId.has(cur.id), list = known ? I.all : [cur], at = list.findIndex((im) => im.id === cur.id);
  const fam = known ? I.family(cur.id) : [], ver = known ? I.chain(cur.id).length : 0;
  const parent = cur.parentId ? I.byId.get(cur.parentId) : undefined;
  const kept = I.kept.has(cur.id), traced = known && !cur.id.startsWith("p:");
  const show = (im: Img | undefined) => { if (im) { setCur(im); setFull(false); if (!im.parentId) setCmp(false); } };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") show(list[at - 1]);
      else if (e.key === "ArrowRight") show(list[at + 1]);
      else if (e.key.toLowerCase() === "c" && parent) setCmp((v) => !v);
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });
  const vlab = (im: Img) => `v${I.chain(im.id).length}`;
  return (
    <div className="vw" role="dialog" aria-label={`Image ${imgName(cur.path)}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="vw-top">
        <div className="vw-title">{known && <b>{`v${ver}`}</b>}<span className="faint">{list.length > 1 ? `${at + 1} of ${list.length}` : imgName(cur.path)}</span></div>
        {fam.length > 1 && <div className="vw-fam" aria-label="Versions">{fam.map((v) => (
          <button key={v.id} className={`${v.id === cur.id ? "on" : ""}${I.kept.has(v.id) ? " kept" : ""}`} title={vlab(v)} onClick={() => show(v)}><img src={imgSrc(v)} alt="" /><span>{vlab(v)}</span></button>))}</div>}
        <div className="vw-tools">
          {parent && <button className={`pc-pill s ${cmp ? "" : "o"}`} title="Compare with the version it came from (C)" onClick={() => setCmp((v) => !v)}>{cmp ? "Comparing" : `Compare with ${vlab(parent)}`}</button>}
          <a className="pc-pill s o" href={imgFile(cur)} download>Download</a>
          <button className="pc-pill s o" title="Close (Esc)" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="vw-stage" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {at > 0 && <button className="vw-nav l" title="Previous (←)" onClick={() => show(list[at - 1])}>‹</button>}
        {cmp && parent
          ? <div className="vw-cmp">
              <img src={imgSrc(cur)} alt={vlab(cur)} draggable={false} />
              <img src={imgSrc(parent)} alt={vlab(parent)} className="top" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} draggable={false} />
              <i className="ie-handle" style={{ left: `${x}%` }} />
              <span className="ie-tag l">{vlab(parent)}</span><span className="ie-tag r">{vlab(cur)}</span>
              <input type="range" min={0} max={100} value={x} onChange={(e) => setX(+e.target.value)} aria-label="Before and after" />
            </div>
          : <img key={cur.id} className="vw-img" src={imgSrc(cur)} alt={cur.caption || imgName(cur.path)} />}
        {at < list.length - 1 && <button className="vw-nav r" title="Next (→)" onClick={() => show(list[at + 1])}>›</button>}
      </div>
      <div className="vw-foot">
        <div className="vw-info">
          {cur.caption && <button className={`vw-prompt${full ? " full" : ""}`} title={full ? "Show less" : "Show the whole prompt"} onClick={() => setFull((v) => !v)}>{cur.caption}</button>}
          {imgMeta(cur) && <span className="small faint">{imgMeta(cur)}</span>}
        </div>
        <div className="col" style={{ gap: 10, alignItems: "flex-end" }}>
          {known && <div className="vw-acts">
            {onMore && <button className="pc-pill s o" onClick={() => { onMore(cur); onClose(); }}>More like this</button>}
            {traced && onKeep && (kept ? <span className="pc-chip ok">kept</span> : <button className="pc-pill s o" title="Mark this as the version you're going with" onClick={() => onKeep(cur.id)}>Keep</button>)}
            {onEdit && <button className="pc-pill s" onClick={() => onEdit(cur)}>Edit</button>}
          </div>}
          <p className="vw-keys">{`${list.length > 1 ? "← → images · " : ""}${parent ? "C compare · " : ""}Esc close`}</p>
        </div>
      </div>
    </div>
  );
}
