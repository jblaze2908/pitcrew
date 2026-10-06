// The wait for an image: catch the paint. Paint falls in the brief's colours; whatever is caught fills the tile and
// comes back in the unveil (Events.tsx Images). Idle for 1.5 s and the member plays itself. One rAF loop per wait.
import { useEffect, useRef, useState } from "react";
import type { Bot, Painting } from "../../../../shared/types";
import { Face } from "../../components/ui";

/** Colours caught per painting id, read once by the image that lands for it. */
export const catches = new Map<string, string[]>();
const CELLS = 48;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const ratio = (a: string) => (/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(a) ? a.replace(":", "/") : "1/1");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

type Drop = { el: HTMLElement; c: string; x: number; y: number; v: number };

export function CatchThePaint({ p, b }: { p: Painting; b: Bot }) {
  const tile = useRef<HTMLDivElement>(null), paddle = useRef<HTMLDivElement>(null);
  const [caught, setCaught] = useState<string[]>(() => catches.get(p.id) || []);
  const [secs, setSecs] = useState(() => Math.max(0, (Date.now() - p.startedAt) / 1000));

  useEffect(() => { const t = setInterval(() => setSecs(Math.max(0, (Date.now() - p.startedAt) / 1000)), 1000); return () => clearInterval(t); }, [p.startedAt]);

  useEffect(() => {
    const T = tile.current, P = paddle.current;
    if (!T || !P || still()) return;
    let drops: Drop[] = [], x = 0.5, user = 0, spawn = 0, last = 0, raf = 0;
    const got = catches.get(p.id) || [];
    const steer = (cx: number) => { const r = T.getBoundingClientRect(); x = Math.max(0.06, Math.min(0.94, (cx - r.left) / r.width)); user = performance.now(); };
    const onMove = (e: PointerEvent) => steer(e.clientX);
    const onKey = (e: KeyboardEvent) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); x = Math.max(0.06, Math.min(0.94, x + (e.key === "ArrowLeft" ? -0.08 : 0.08))); user = performance.now(); } };
    T.addEventListener("pointermove", onMove); T.addEventListener("keydown", onKey);
    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0, r = T.getBoundingClientRect(); last = now;
      if (now - spawn > 550) {
        spawn = now; const el = document.createElement("i"); el.className = "drop"; const c = p.palette[(Math.random() * p.palette.length) | 0];
        el.style.background = c; T.appendChild(el); drops.push({ el, c, x: 0.08 + Math.random() * 0.84, y: -0.05, v: 0.28 + Math.random() * 0.18 });
      }
      if (now - user > 1500 && drops.length) { const lowest = drops.reduce((a, d) => (d.y > a.y ? d : a)); x += (lowest.x - x) * Math.min(1, dt * 3.2); }
      P.style.transform = `translate(${x * r.width - 20}px, ${r.height - 48}px)`;
      drops = drops.filter((d) => {
        d.y += d.v * dt; d.el.style.transform = `translate(${d.x * r.width - 8}px, ${d.y * r.height}px)`;
        if (d.y > 0.84 && d.y < 0.95 && Math.abs(d.x - x) < 0.1) { got.push(d.c); catches.set(p.id, got); setCaught([...got]); d.el.remove(); return false; }
        if (d.y > 1) { d.el.remove(); return false; }
        return true;
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); T.removeEventListener("pointermove", onMove); T.removeEventListener("keydown", onKey); drops.forEach((d) => d.el.remove()); };
  }, [p.id, p.palette.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const what = p.n > 1 ? `${p.n} images` : "An image";
  return (
    <div className="msg bot"><Face b={b} size="sm" mood="working" />
      <figure className="paint">
        <div ref={tile} className="paint-tile" style={{ aspectRatio: ratio(p.aspect) }} tabIndex={0} role="img" aria-label={`${what} on the way. Catch the paint with the mouse or the arrow keys; ${caught.length} caught.`}>
          <div className="paint-cells">{Array.from({ length: CELLS }, (_, i) => <i key={i} style={caught[i] ? { background: caught[i] } : undefined} className={caught[i] ? "on" : undefined} />)}</div>
          <div ref={paddle} className="paint-paddle"><Face b={b} size="md" mood="working" /></div>
        </div>
        <figcaption className="small muted">{`${what} on the way · ${p.model} · ${clock(secs)}`}{caught.length ? <span className="faint">{` · caught ${caught.length}`}</span> : <span className="faint"> · catch the paint while you wait</span>}</figcaption>
      </figure>
    </div>
  );
}
