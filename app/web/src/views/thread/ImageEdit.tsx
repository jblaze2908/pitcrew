// The image edit panel (brush an area, pin notes, quick fixes, pick the model) and the before/after compare.
// Strokes and pins live in the image's own pixels; Send turns them into a mask and a marked copy (uploads/), and the
// server writes the member's instructions (images.ts editMessage). Pitcrew pastes the result back inside the mask.
import { useEffect, useRef, useState } from "react";
import type { Bot } from "../../../../shared/types";
import { api } from "../../lib/api";
import { imgName, imgSrc, type Img } from "../../lib/images";

type Stroke = { r: number; pts: [number, number][] };
type Pin = { x: number; y: number; note: string };
const PINK = "#ff6fab", PIN = "#7196ff";
const QUICK: [string, string][] = [
  ["Remove background", "Remove the background and leave the subject on transparency; keep the subject exactly as it is."],
  ["Bigger text", "Make the text bigger and easier to read; keep the wording and the style."],
  ["Expand to 16:9", "Extend the image to 16:9, continuing the scene at the sides; keep the middle as it is."],
  ["Restyle", "Restyle it as a flat paper-cut illustration; keep the layout and the text."],
  ["Fix spelling", "Fix any misspelt text; change nothing else."],
];
// Nano Banana 2's price is from the 2026-10-04 brush test (about $0.068 per 1K edit); GPT Image 2.5 bills by tokens.
const MODELS = [{ id: "google/gemini-3.1-flash-image", label: "Nano Banana 2", note: "about $0.07 · best at brushed edits" },
  { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5", note: "sharpest text · billed per image" }];

function strokesOn(g: CanvasRenderingContext2D, strokes: Stroke[], k: number, colour: string) {
  g.strokeStyle = g.fillStyle = colour; g.lineCap = g.lineJoin = "round";
  for (const s of strokes) {
    if (s.pts.length === 1) { g.beginPath(); g.arc(s.pts[0][0] * k, s.pts[0][1] * k, s.r * k, 0, Math.PI * 2); g.fill(); continue; }
    g.lineWidth = s.r * 2 * k; g.beginPath(); s.pts.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k))); g.stroke();
  }
}
const canvasOf = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
const blobOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't draw the marks"))), "image/png"));
function maskOf(w: number, h: number, strokes: Stroke[]) {
  const c = canvasOf(w, h), g = c.getContext("2d")!; g.fillStyle = "#000"; g.fillRect(0, 0, w, h); strokesOn(g, strokes, 1, "#fff"); return c;
}
function markedOf(img: HTMLImageElement, strokes: Stroke[], pins: Pin[]) {
  const w = img.naturalWidth, h = img.naturalHeight, c = canvasOf(w, h), g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const o = canvasOf(w, h); strokesOn(o.getContext("2d")!, strokes, 1, PINK); g.globalAlpha = 0.45; g.drawImage(o, 0, 0); g.globalAlpha = 1;
  const r = Math.max(14, w * 0.024);
  pins.forEach((p, i) => { g.fillStyle = PIN; g.beginPath(); g.arc(p.x * w, p.y * h, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#0b1020"; g.font = `700 ${Math.round(r * 1.1)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(i + 1), p.x * w, p.y * h + 1); });
  return c;
}

export function EditPanel({ img, version, b, threadId, onClose }: { img: Img; version: number; b: Bot; threadId: string; onClose: () => void }) {
  const pic = useRef<HTMLImageElement>(null), cv = useRef<HTMLCanvasElement>(null), live = useRef<Stroke | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<"brush" | "pin">("brush");
  const [size, setSize] = useState(6);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [steps, setSteps] = useState<("s" | "p")[]>([]);
  const [text, setText] = useState("");
  const plan = b.provider === "openai";
  const [model, setModel] = useState(plan ? "plan" : MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const brushed = strokes.length > 0;
  // A mask needs generate_image (Codex's image_gen takes no mask), so brushing moves off the plan.
  useEffect(() => { if (brushed && model === "plan") setModel(MODELS[0].id); }, [brushed, model]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const draw = () => {
    const c = cv.current, p = pic.current; if (!c || !p || !nat) return;
    const w = p.clientWidth, h = p.clientHeight; if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d")!; g.clearRect(0, 0, w, h); strokesOn(g, live.current ? [...strokes, live.current] : strokes, w / nat.w, PINK);
  };
  useEffect(draw);
  useEffect(() => { const p = pic.current; if (!p) return; const ro = new ResizeObserver(draw); ro.observe(p); return () => ro.disconnect(); });

  const at = (e: React.PointerEvent): [number, number] => { const r = cv.current!.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * nat!.w, ((e.clientY - r.top) / r.height) * nat!.h]; };
  const down = (e: React.PointerEvent) => {
    if (!nat) return;
    if (tool === "pin") { if (pins.length >= 9) return; const [x, y] = at(e); setPins((l) => [...l, { x: x / nat.w, y: y / nat.h, note: "" }]); setSteps((s) => [...s, "p"]); return; }
    cv.current!.setPointerCapture(e.pointerId); live.current = { r: ((size / 100) * nat.w) / 2, pts: [at(e)] }; draw();
  };
  const move = (e: React.PointerEvent) => { if (live.current) { live.current.pts.push(at(e)); draw(); } };
  const up = () => { const s = live.current; live.current = null; if (s) { setStrokes((l) => [...l, s]); setSteps((x) => [...x, "s"]); } };
  const undo = () => { const last = steps[steps.length - 1]; if (!last) return; setSteps((s) => s.slice(0, -1)); (last === "s" ? setStrokes : setPins)((l: any[]) => l.slice(0, -1)); };

  const ready = !!text.trim() || pins.some((p) => p.note.trim());
  const send = async () => {
    if (!ready || busy || !pic.current || !nat) return;
    setBusy(true); setErr(null);
    try {
      const up = async (c: HTMLCanvasElement, name: string) => (await api.post<{ path: string }>(`/api/threads/${threadId}/upload?name=${name}`, await blobOf(c), { raw: true })).path;
      const marked = brushed || pins.length ? await up(markedOf(pic.current, strokes, pins), "edit-marked.png") : null;
      const mask = brushed ? await up(maskOf(nat.w, nat.h, strokes), "edit-mask.png") : null;
      await api.post(`/api/threads/${threadId}/messages`, { text, mode: "queue", edit: { image: img.path, mask, marked, model, pins: pins.map((p) => ({ x: p.x, y: p.y, note: p.note })) } });
      onClose();
    } catch (e: any) { setErr(e.message || "Couldn't send the edit"); } finally { setBusy(false); }
  };

  const choices = [...(plan && !brushed ? [{ id: "plan", label: "ChatGPT plan", note: "included · gpt-image-2" }] : []), ...MODELS];
  return (
    <div className="ie-shade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ie-panel" role="dialog" aria-label={`Edit ${imgName(img.path)}`}>
        <header><div><b>{`Edit v${version}`}</b><span className="small faint">{imgName(img.path)}</span></div><button className="pc-pill o s" onClick={onClose}>Close</button></header>
        <div className="ie-tools">
          <button className={`ie-tool${tool === "brush" ? " on" : ""}`} onClick={() => setTool("brush")}>Brush</button>
          <label className="ie-size small faint">Size<input type="range" min={2} max={16} value={size} onChange={(e) => setSize(+e.target.value)} aria-label="Brush size" /></label>
          <button className={`ie-tool${tool === "pin" ? " on" : ""}`} onClick={() => setTool("pin")}>Pin a note</button>
          <span style={{ flex: 1 }} />
          <button className="ie-tool" disabled={!steps.length} onClick={undo}>Undo</button>
          <button className="ie-tool" disabled={!steps.length} onClick={() => { setStrokes([]); setPins([]); setSteps([]); }}>Clear</button>
        </div>
        <div className="ie-stage">
          <div className="ie-pic">
            <img ref={pic} src={imgSrc(img)} alt={img.caption} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} draggable={false} />
            <canvas ref={cv} className={tool} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
            {pins.map((p, i) => <span key={i} className="ie-pin" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>{i + 1}</span>)}
          </div>
          <p className="small faint">{tool === "brush" ? "Brush where it should change. Pitcrew keeps everything outside the brush as it was." : "Tap a spot to pin a note there."}</p>
        </div>
        {pins.length > 0 && <div className="ie-pins">{pins.map((p, i) => (
          <label key={i}><span className="ie-pin static">{i + 1}</span><input value={p.note} placeholder="What should happen here?" maxLength={200}
            onChange={(e) => { const v = e.target.value; setPins((l) => l.map((x, j) => (j === i ? { ...x, note: v } : x))); }} /></label>))}</div>}
        <div className="ie-quick">{QUICK.map(([label, prompt]) => <button key={label} className="ie-chip" onClick={() => setText((t) => (t.trim() ? `${t.trim()} ${prompt}` : prompt))}>{label}</button>)}</div>
        <textarea className="ie-text" rows={2} value={text} placeholder={brushed ? "What should change in the brushed area?" : "What should change?"} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
        <div className="ie-foot">
          <div className="ie-models" role="radiogroup" aria-label="Who makes the edit">{choices.map((m) => (
            <button key={m.id} role="radio" aria-checked={model === m.id} className={model === m.id ? "on" : ""} onClick={() => setModel(m.id)}><b>{m.label}</b><span>{m.note}</span></button>))}</div>
          <button className="pc-pill" disabled={!ready || busy} onClick={send}>{busy ? "Sending…" : `Send to ${b.name}`}</button>
        </div>
        {err && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>{err}</p>}
      </aside>
    </div>
  );
}

export function Compare({ before, after, labels, onClose }: { before: Img; after: Img; labels: [string, string]; onClose: () => void }) {
  const [x, setX] = useState(50);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="ie-shade center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ie-compare" role="dialog" aria-label="Compare versions">
        <header><b>{`${labels[0]} → ${labels[1]}`}</b><button className="pc-pill o s" onClick={onClose}>Close</button></header>
        <div className="ie-cmp">
          <img src={imgSrc(after)} alt={labels[1]} draggable={false} />
          <img src={imgSrc(before)} alt={labels[0]} className="top" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} draggable={false} />
          <i className="ie-handle" style={{ left: `${x}%` }} />
          <span className="ie-tag l">{labels[0]}</span><span className="ie-tag r">{labels[1]}</span>
          <input type="range" min={0} max={100} value={x} onChange={(e) => setX(+e.target.value)} aria-label="Before and after" />
        </div>
      </div>
    </div>
  );
}
