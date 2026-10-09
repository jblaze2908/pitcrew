// Surface charts (generative UI). Drawn at the container's real pixel width so text stays 11–12px on any screen.
// Quiet by default: a lone series is grey ink; colour comes from the hue the member picks, or the fixed palette order
// when several series need telling apart. Every chart shows its values on hover.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// The chart palette (app.css --v1..--v5, checked for colour-blind separation in both themes) plus grey and trouble.
// c1..c6 are the older crew-hue names, mapped so surfaces made before this keep a colour.
const HUE_VAR: Record<string, string> = { blue: "--v1", magenta: "--v2", violet: "--v3", teal: "--v4", amber: "--v5", grey: "--ink-3", bad: "--soft-bad",
  c1: "--v1", c2: "--v4", c3: "--v5", c5: "--v2", c6: "--v3" };
const ORDER = ["--v1", "--v2", "--v3", "--v4", "--v5"];
/** The colour for a hue name; without one, the i-th palette colour (never cycled), or undefined. */
export const chartColor = (hue?: string | null, i?: number) => (hue && HUE_VAR[hue] ? `var(${HUE_VAR[hue]})` : i != null && i < ORDER.length ? `var(${ORDER[i]})` : undefined);

type Fmt = (v: number) => string;
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
/** A value as the tooltip and labels show it. */
export function fmtValue(v: number, format?: string, unit?: string): string {
  const s = format === "money" ? `₹${inr.format(v)}` : format === "percent" ? `${inr.format(v)}%` : inr.format(v);
  return unit && !(format === "money" && /₹|inr|rupee|rs/i.test(unit)) ? `${s} ${unit}` : s;
}
// Axis ticks stay short: ₹1.2L, 25k, 3.5Cr.
function fmtAxis(v: number, format?: string): string {
  const a = Math.abs(v), sign = v < 0 ? "−" : "", pre = format === "money" ? "₹" : "", post = format === "percent" ? "%" : "";
  const short = a >= 1e7 ? `${+(a / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${+(a / 1e5).toFixed(1)}L` : a >= 1e4 ? `${+(a / 1e3).toFixed(0)}k` : `${+a.toFixed(2)}`;
  return `${sign}${pre}${short}${post}`;
}
function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null), [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface TipState { x: number; y: number; title: string; rows: { color?: string; text: string }[] }
function Tip({ t }: { t: TipState | null }) {
  if (!t) return null;
  return <div className="cv-tip" style={{ left: t.x, top: t.y }}><p>{t.title}</p>{t.rows.map((r, i) => <div key={i}>{r.color && <i style={{ background: r.color }} />}{r.text}</div>)}</div>;
}
const Title = ({ text }: { text?: string }) => (text ? <p className="pc-lab">{text}</p> : null);

// ---------- line ----------
export function LineChart({ n }: { n: any }) {
  const [ref, W] = useWidth<HTMLDivElement>(), [hover, setHover] = useState<number | null>(null), [tip, setTip] = useState<TipState | null>(null);
  const series: any[] = n.series || [];
  const xs: string[] = [...new Set<string>(series.flatMap((s) => (s.points || []).map((p: any) => String(p.x))))];
  const at = series.map((s) => new Map<string, number | null>((s.points || []).map((p: any) => [String(p.x), typeof p.y === "number" ? p.y : null])));
  const ys = at.flatMap((m) => [...m.values()]).filter((v): v is number => v != null);
  const multi = series.length > 1, f: Fmt = (v) => fmtValue(v, n.format, n.unit);
  const colors = series.map((s, i) => chartColor(s.hue, multi ? i : undefined) || "var(--ink-2)");
  const H = 200, T = 12, B = 26, L = 46, R = multi ? Math.min(150, 24 + Math.max(...series.map((s) => String(s.name).length)) * 7 + 48) : 64;
  const plotW = Math.max(40, W - L - R);
  if (!ys.length || !xs.length) return <div className="col" ref={ref}><Title text={n.title} /><p className="small faint">No data</p></div>;
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys)), lo = ticks[0], hi = ticks[ticks.length - 1];
  const X = (i: number) => L + (xs.length > 1 ? i / (xs.length - 1) : 0.5) * plotW, Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const every = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(plotW / 72))));
  // Runs between gaps: a missing value breaks the line instead of dropping it to zero.
  const paths = at.map((m) => {
    let d = "", pen = false;
    xs.forEach((x, i) => { const v = m.get(x); if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    return d;
  });
  // End labels: each series' last value, nudged apart so they don't overlap.
  const ends = at.map((m, si) => { for (let i = xs.length - 1; i >= 0; i--) { const v = m.get(xs[i]); if (v != null) return { si, i, v, y: Y(v) }; } return null; }).filter(Boolean) as { si: number; i: number; v: number; y: number }[];
  const placed = [...ends].sort((a, b) => a.y - b.y);
  placed.forEach((e, k) => { if (k && e.y - placed[k - 1].y < 14) e.y = placed[k - 1].y + 14; });
  const move = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(((e.clientX - r.left - L) / plotW) * (xs.length - 1))));
    setHover(i);
    setTip({ x: Math.min(X(i) + 12, W - 170), y: T, title: xs[i], rows: series.map((s, si) => { const v = at[si].get(xs[i]); return { color: multi ? colors[si] : undefined, text: `${multi ? `${s.name} ` : ""}${v == null ? "no data" : f(v)}` }; }) });
  };
  return (
    <div className="col cv" ref={ref}><Title text={n.title} />
      {W > 0 && <div className="cv-box">
        <svg width={W} height={H} className="cv-svg">
          {ticks.map((t) => <g key={t}><line x1={L} x2={L + plotW} y1={Y(t)} y2={Y(t)} className="cv-grid" /><text x={L - 8} y={Y(t) + 4} textAnchor="end" className="cv-ax">{fmtAxis(t, n.format)}</text></g>)}
          {xs.map((x, i) => (i % every === 0 || i === xs.length - 1) && (i === xs.length - 1 || xs.length - 1 - i >= every) ? <text key={i} x={X(i)} y={H - 6} textAnchor="middle" className="cv-ax">{x}</text> : null)}
          {paths.map((d, si) => <path key={si} d={d} fill="none" stroke={colors[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {ends.map((e) => <circle key={e.si} cx={X(e.i)} cy={Y(e.v)} r={4} fill={multi || series[e.si].hue ? colors[e.si] : "var(--ink)"} stroke="var(--surface)" strokeWidth={2} />)}
          {placed.map((e) => <text key={e.si} x={X(e.i) + 9} y={e.y + 4} className="cv-lab">{multi ? `${series[e.si].name} ${fmtAxis(e.v, n.format)}` : f(e.v)}</text>)}
          {hover != null && <line x1={X(hover)} x2={X(hover)} y1={T} y2={H - B} className="cv-cross" />}
          {hover != null && at.map((m, si) => { const v = m.get(xs[hover]); return v == null ? null : <circle key={si} cx={X(hover)} cy={Y(v)} r={4} fill={colors[si]} stroke="var(--surface)" strokeWidth={2} />; })}
          <rect x={L} y={0} width={plotW} height={H} fill="transparent" onMouseMove={move} onMouseLeave={() => { setHover(null); setTip(null); }} />
        </svg>
        <Tip t={tip} />
      </div>}
    </div>
  );
}

// ---------- bars ----------
// Up to 12 categories (or any negative value) draw as labelled rows; a longer series draws as columns.
export function BarChart({ n }: { n: any }) {
  const data: any[] = n.data || [], neg = data.some((d) => d.value < 0);
  return data.length > 12 && !neg ? <Columns n={n} /> : <Rows n={n} data={data} neg={neg} />;
}
function Rows({ n, data, neg }: { n: any; data: any[]; neg: boolean }) {
  const max = Math.max(1e-9, ...data.map((d) => Math.abs(d.value))), f: Fmt = (v) => fmtValue(v, n.format || "number", n.unit);
  const [tip, setTip] = useState<{ i: number } | null>(null);
  return (
    <div className="col"><Title text={n.title} />
      <div className={`cv-rows${neg ? " neg" : ""}`}>{data.map((d, i) => {
        const color = chartColor(d.hue) || chartColor(n.hue) || "var(--ink-3)", pct = (Math.abs(d.value) / max) * (neg ? 50 : 100);
        const bar: CSSProperties = neg ? (d.value >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }) : { width: `${Math.max(pct, d.value ? 1 : 0)}%` };
        return (
          <div key={i} className={`cv-row${tip?.i === i ? " on" : ""}`} onMouseEnter={() => setTip({ i })} onMouseLeave={() => setTip(null)} title={`${d.label}: ${f(d.value)}`}>
            <span className="l">{d.label}</span>
            <span className="t">{neg && <i className="z" />}{d.value !== 0 && <b style={{ ...bar, background: color }} />}</span>
            <span className="v num" style={d.hue === "bad" ? { color: "var(--soft-bad)" } : undefined}>{neg && d.value > 0 ? "+" : ""}{d.value < 0 ? `−${f(-d.value)}` : f(d.value)}</span>
          </div>);
      })}</div>
    </div>
  );
}

function Columns({ n }: { n: any }) {
  const [ref, W] = useWidth<HTMLDivElement>(), [tip, setTip] = useState<TipState | null>(null), [on, setOn] = useState<number | null>(null);
  const data: any[] = n.data, H = 130, L = 46, R = 16, T = 10, B = 24, plotW = Math.max(40, W - L - R);
  const ticks = niceTicks(0, Math.max(...data.map((d) => d.value)), 2), top = ticks[ticks.length - 1], bw = plotW / data.length;
  const Y = (v: number) => T + (1 - v / (top || 1)) * (H - T - B), every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 72))));
  const f: Fmt = (v) => fmtValue(v, n.format || "number", n.unit);
  return (
    <div className="col cv" ref={ref}><Title text={n.title} />
      {W > 0 && <div className="cv-box">
        <svg width={W} height={H} className="cv-svg">
          {ticks.map((t) => <g key={t}><line x1={L} x2={L + plotW} y1={Y(t)} y2={Y(t)} className="cv-grid" /><text x={L - 8} y={Y(t) + 4} textAnchor="end" className="cv-ax">{fmtAxis(t, n.format)}</text></g>)}
          {data.map((d, i) => {
            const x = L + i * bw + 1, w = Math.max(2, bw - 2), h = d.value ? Math.max(2, Y(0) - Y(d.value)) : 2;
            const fill = d.value === 0 ? "var(--line-2)" : chartColor(d.hue) || chartColor(n.hue) || (on === i ? "var(--ink)" : "var(--ink-3)");
            return <g key={i}>
              <rect x={x} y={Y(0) - h} width={w} height={h} rx={Math.min(3, w / 2)} fill={fill} opacity={on == null || on === i ? 1 : 0.6} />
              <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" onMouseEnter={() => { setOn(i); setTip({ x: Math.min(x + w + 8, W - 150), y: T, title: d.label, rows: [{ text: d.value ? f(d.value) : "no data" }] }); }} onMouseLeave={() => { setOn(null); setTip(null); }} />
              {(i % every === 0) && <text x={x + w / 2} y={H - 6} textAnchor="middle" className="cv-ax">{d.label}</text>}
            </g>;
          })}
        </svg>
        <Tip t={tip} />
      </div>}
    </div>
  );
}

// ---------- donut ----------
// The figure inside the ring: in full when it fits (₹59,240), else short (₹1.2L).
const centre = (v: number, format?: string) => { const full = fmtValue(v, format); return full.length <= 8 ? full : fmtAxis(v, format); };
// Up to five slices keep their own colour; the rest fold into a grey "Other". Gaps between slices, the total inside.
export function Donut({ n }: { n: any }) {
  const [on, setOn] = useState<number | null>(null);
  const raw: any[] = (n.data || []).filter((d: any) => d.value > 0), f: Fmt = (v) => fmtValue(v, n.format || "number", n.unit);
  const slices = raw.length > 5 ? [...raw.slice(0, 4), { label: "Other", value: raw.slice(4).reduce((a, d) => a + d.value, 0), hue: "grey", parts: raw.slice(4).map((d) => d.label) }] : raw;
  const total = slices.reduce((a, d) => a + d.value, 0) || 1, S = 148, r = 60, w = 16, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="col"><Title text={n.title} />
      <div className="cv-donut">
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="cv-svg">
          {slices.map((d, i) => { const len = (d.value / total) * c, off = acc; acc += len; return <circle key={i} cx={S / 2} cy={S / 2} r={r} fill="none" stroke={chartColor(d.hue, i) || "var(--ink-3)"} strokeWidth={on === i ? w + 4 : w} strokeDasharray={`${Math.max(0.5, len - (slices.length > 1 ? 2 : 0))} ${c}`} strokeDashoffset={-off} transform={`rotate(-90 ${S / 2} ${S / 2})`} onMouseEnter={() => setOn(i)} onMouseLeave={() => setOn(null)} />; })}
          <text x={S / 2} y={S / 2 + 3} textAnchor="middle" className="cv-total">{centre(on == null ? total : slices[on].value, n.format)}</text>
          <text x={S / 2} y={S / 2 + 20} textAnchor="middle" className="cv-ax">{on == null ? "total" : `${Math.round((slices[on].value / total) * 100)}%`}</text>
        </svg>
        <div className="cv-legend">{slices.map((d, i) => (
          <div key={i} className={on === i ? "on" : ""} onMouseEnter={() => setOn(i)} onMouseLeave={() => setOn(null)} title={d.parts ? d.parts.join(", ") : undefined}>
            <i style={{ background: chartColor(d.hue, i) || "var(--ink-3)" }} /><span>{d.label}</span><span className="num">{f(d.value)} · {Math.round((d.value / total) * 100)}%</span>
          </div>))}</div>
      </div>
    </div>
  );
}

// ---------- sparkline ----------
export function Sparkline({ n }: { n: any }) {
  const [ref, W] = useWidth<HTMLDivElement>(), [on, setOn] = useState<number | null>(null);
  const v: number[] = (n.values || []).filter((x: unknown) => typeof x === "number"), H = 36, P = 4, w = Math.max(60, W - 64);
  if (v.length < 2) return <div ref={ref} />;
  const lo = Math.min(...v), hi = Math.max(...v), X = (i: number) => P + (i / (v.length - 1)) * (w - P * 2), Y = (y: number) => H - P - ((y - lo) / (hi - lo || 1)) * (H - P * 2);
  const color = chartColor(n.hue) || "var(--ink-2)", shown = on ?? v.length - 1;
  return (
    <div className="cv-spark" ref={ref}>
      {W > 0 && <svg width={w} height={H} className="cv-svg" onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOn(Math.max(0, Math.min(v.length - 1, Math.round(((e.clientX - r.left - P) / (w - P * 2)) * (v.length - 1))))); }} onMouseLeave={() => setOn(null)}>
        <path d={v.map((y, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join("")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        <circle cx={X(shown)} cy={Y(v[shown])} r={3.5} fill={n.hue ? color : "var(--ink)"} stroke="var(--surface)" strokeWidth={2} />
      </svg>}
      <span className="num small muted">{fmtValue(v[shown], n.format)}</span>
    </div>
  );
}

