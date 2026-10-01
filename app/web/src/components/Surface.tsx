// Renders a validated surface spec (generative UI) with Pitcrew components. Text renders as text only; colours are hue
// tokens only. Specs are dynamic JSON from the crew, hence `any` for nodes.
import { createContext, useContext, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Surface as SurfaceRow } from "../../../shared/types";

type Values = Record<string, unknown>;
interface Ctx { onAction: (action: string, values: Values) => Promise<void> | void; locked: boolean }
const SurfaceCtx = createContext<Ctx>({ onAction: () => {}, locked: false });

const HUES = ["c1", "c2", "c3", "c5", "c6"];
const hueVar = (hue?: string | null, i = 0) => `var(--${hue && HUES.includes(hue) ? hue : HUES[i % HUES.length]})`;
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
export function fmt(v: unknown, f?: string): string {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    if (f === "money") return `₹${inr.format(v)}`;
    if (f === "percent") return `${inr.format(v)}%`;
    if (f === "number") return inr.format(v);
  }
  return String(v);
}
const toneClass = (t?: string) => ({ ok: "ok", up: "ok", bad: "bad", down: "bad", blue: "blue" } as Record<string, string>)[t || ""] || "";
const isNum = (f?: string) => ["number", "money", "percent"].includes(f || "");
const hue = (h: string) => ({ "--hue": h }) as CSSProperties;

/** `extra` sits in the header (Keep in Library, or a link back); `lockOnAction` disables the inputs once one is sent. */
export function Surface({ s, extra, onAction, lockOnAction = false }: { s: SurfaceRow; extra?: ReactNode; onAction: Ctx["onAction"]; lockOnAction?: boolean }) {
  const [locked, setLocked] = useState(false);
  const act = async (action: string, values: Values) => { await onAction(action, values); if (lockOnAction) setLocked(true); };
  return (
    <SurfaceCtx.Provider value={{ onAction: act, locked }}>
      <div className="surface">
        <div className="head"><span className="pc-lab">Surface</span><b className="pc-h3">{s.spec?.title}</b>{extra}</div>
        <Node n={s.spec?.root} />
      </div>
    </SurfaceCtx.Provider>
  );
}

function Kids({ n }: { n: any }) { return <>{(n.children || []).map((c: any, i: number) => <Node key={i} n={c} />)}</>; }

function Node({ n }: { n: any }): ReactNode {
  if (!n) return null;
  switch (n.type) {
    case "Section": return <section className="col">{n.title && <h4 className="pc-h3">{n.title}</h4>}<Kids n={n} /></section>;
    case "Stack": return <div className={`sf-stack ${n.direction === "row" ? "row" : ""}`} style={{ gap: ({ s: 8, m: 12, l: 20 } as Record<string, number>)[n.gap] || 12 }}><Kids n={n} /></div>;
    case "Grid": return <div className="sf-grid" style={{ gridTemplateColumns: `repeat(${n.columns || 2},minmax(0,1fr))` }}><Kids n={n} /></div>;
    case "Card": return <div className={`sf-card ${n.hue ? "hue" : ""}`} style={n.hue ? hue(hueVar(n.hue)) : undefined}>{n.title && <b className="pc-h3">{n.title}</b>}<Kids n={n} /></div>;
    case "Divider": return <div className="divider" />;
    case "Heading": return n.level === 3 ? <h4 className="pc-h3">{n.text}</h4> : <h3 className="pc-h2">{n.text}</h3>;
    case "Text": { const t = toneClass(n.tone); return <p className={n.tone === "muted" ? "muted" : t === "ok" ? "okc" : t === "bad" ? "badc" : ""}>{n.text}</p>; }
    case "Quote": return <p className="pc-quote">{n.text}</p>;
    case "Lab": return <p className="pc-lab">{n.text}</p>;
    case "Receipt": return <p className="small muted">[ok] {n.text}{n.source && <> · <a href={n.source} target="_blank" rel="noopener noreferrer" className="md">{hostOf(n.source)}</a></>}</p>;
    case "Stat": return <div className="sf-stat col" style={{ gap: 4 }}><p className="pc-lab">{n.label}</p><span className="v num">{n.value}</span>{n.delta && <span className={`d ${n.tone === "down" || n.tone === "bad" ? "down" : n.tone === "up" || n.tone === "ok" ? "up" : "faint"}`}>{n.delta}</span>}</div>;
    case "Meter": return <div className="col" style={{ gap: 6 }}><div className="spread small"><span>{n.label}</span><span className="num faint">{`${fmt(n.value, "number")} / ${fmt(n.max, "number")}${n.unit ? " " + n.unit : ""}`}</span></div><div className="meter"><b style={{ width: `${Math.min(100, (n.value / (n.max || 1)) * 100)}%`, background: hueVar(n.hue) }} /></div></div>;
    case "Badge": return <span className={`pc-chip ${toneClass(n.tone)}`}>{n.text}</span>;
    case "Table": return <div className="scrollx"><table className="tbl"><thead><tr>{n.columns.map((c: any) => <th key={c.key} className={isNum(c.format) ? "num" : ""}>{c.label}</th>)}</tr></thead>
      <tbody>{n.rows.map((r: any, i: number) => <tr key={i}>{n.columns.map((c: any) => <td key={c.key} className={isNum(c.format) ? "num" : ""}>{fmt(r[c.key], c.format)}</td>)}</tr>)}</tbody></table></div>;
    case "List": return <div className="col" style={{ gap: 0 }}>{n.items.map((it: any, i: number) => <div key={i} className="spread" style={{ padding: "10px 0", borderTop: i ? "1px solid var(--line)" : undefined }}><div><b>{it.title}</b>{it.detail && <p className="small muted">{it.detail}</p>}</div>{it.meta && <span className="pc-m small faint">{it.meta}</span>}</div>)}</div>;
    case "Timeline": return <div className="col" style={{ gap: 8 }}>{n.items.map((it: any, i: number) => <div key={i} className="row" style={{ gap: 10, alignItems: "flex-start" }}><span className="pc-m small faint" style={{ minWidth: 64 }}>{it.time || ""}</span><span className={`pc-chip ${it.state === "done" ? "ok" : it.state === "failed" ? "bad" : it.state === "needs" ? "hot" : ""}`}>{it.state || "·"}</span><span>{it.text}</span></div>)}</div>;
    case "BarChart": return <BarChart n={n} />;
    case "LineChart": return <LineChart n={n} />;
    case "Donut": return <Donut n={n} />;
    case "Sparkline": return <Sparkline n={n} />;
    case "Compare": return <div className="scrollx"><table className="tbl"><thead><tr><th />{n.columns.map((c: string, i: number) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{n.rows.map((r: any, i: number) => <tr key={i}><td className="muted">{r.label}</td>{r.values.map((v: any, j: number) => <td key={j} className={r.winner === j ? "sf-win" : ""}>{v}</td>)}</tr>)}</tbody></table></div>;
    case "Form": return <Form n={n} />;
    case "Choice": return <Choice n={n} />;
    default: return <p className="badc small">Unknown component {String(n.type)}</p>;
  }
}

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

function BarChart({ n }: { n: any }) {
  const max = Math.max(1e-9, ...n.data.map((d: any) => Math.abs(d.value)));
  const unit = n.unit && !(n.format === "money" && /₹|inr|rupee|rs/i.test(n.unit)) ? ` ${n.unit}` : "";
  return (
    <div className="col">{n.title && <p className="pc-lab">{n.title}</p>}
      <div className="sf-bars">{n.data.map((d: any, i: number) => (
        <div key={i} className="sf-bar" style={hue(hueVar(n.hue))}>
          <span className="muted">{d.label}</span>
          <span className="track"><b style={{ width: `${Math.max(1, (Math.abs(d.value) / max) * 100)}%` }} /></span>
          <span className="n">{fmt(d.value, n.format || "number") + unit}</span>
        </div>))}
      </div>
    </div>
  );
}

function LineChart({ n }: { n: any }) {
  const W = 640, H = 200, P = 28;
  const xs: string[] = [...new Set<string>(n.series.flatMap((s: any) => s.points.map((p: any) => p.x)))];
  const ys: number[] = n.series.flatMap((s: any) => s.points.map((p: any) => p.y));
  const lo = Math.min(0, ...ys), hi = Math.max(1e-9, ...ys);
  const X = (x: string) => P + (xs.indexOf(x) / Math.max(1, xs.length - 1)) * (W - P * 2);
  const Y = (y: number) => H - P - ((y - lo) / (hi - lo || 1)) * (H - P * 2);
  const ends = [xs[0], xs[xs.length - 1]];
  return (
    <div className="col">{n.title && <p className="pc-lab">{n.title}</p>}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--line-2)" />
        <text x={2} y={Y(hi) + 4}>{fmt(hi, n.format || "number")}</text>
        <text x={2} y={H - P + 4}>{fmt(lo, n.format || "number")}</text>
        {ends.map((x, i) => x != null && <text key={i} x={i ? W - P - 30 : P} y={H - 8}>{x}</text>)}
        {n.series.map((s: any, i: number) => (
          <path key={i} d={s.points.map((p: any, j: number) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}
            fill="none" stroke={hueVar(s.hue, i)} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />))}
      </svg>
      {n.series.length > 1 && <div className="sf-legend">{n.series.map((s: any, i: number) => <span key={i} style={hue(hueVar(s.hue, i))}><i />{s.name}</span>)}</div>}
    </div>
  );
}

function Donut({ n }: { n: any }) {
  const total = n.data.reduce((a: number, d: any) => a + Math.max(0, d.value), 0) || 1;
  let acc = 0;
  const stops = n.data.map((d: any, i: number) => { const a = acc; acc += (Math.max(0, d.value) / total) * 100; return `${hueVar(null, i)} ${a}% ${acc}%`; }).join(",");
  const mask = "radial-gradient(circle,transparent 42%,#000 43%)";
  return (
    <div className="row" style={{ gap: 20, alignItems: "center" }}>
      <div style={{ width: 132, height: 132, borderRadius: "50%", background: `conic-gradient(${stops})`, WebkitMask: mask, mask }} />
      <div className="col" style={{ gap: 6 }}>{n.title && <p className="pc-lab">{n.title}</p>}
        {n.data.map((d: any, i: number) => <div key={i} className="sf-legend" style={hue(hueVar(null, i))}><span><i />{`${d.label} · ${fmt(d.value, n.format || "number")}`}</span></div>)}
      </div>
    </div>
  );
}

function Sparkline({ n }: { n: any }) {
  const v: number[] = n.values, lo = Math.min(...v), hi = Math.max(...v), W = 160, H = 36;
  const d = v.map((y, i) => `${i ? "L" : "M"}${((i / Math.max(1, v.length - 1)) * W).toFixed(1)},${(H - 3 - ((y - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}><path d={d} fill="none" stroke={hueVar(n.hue)} strokeWidth={2} /></svg>;
}

const FIELDS = ["TextField", "Number", "Money", "Date", "Select", "Radio", "Checkbox", "Toggle"];

function Form({ n }: { n: any }) {
  const { onAction, locked } = useContext(SurfaceCtx);
  const values = useRef<Values | null>(null);
  values.current ??= initialValues(n.children || []);
  return (
    <form className="sf-form" onSubmit={(e) => { e.preventDefault(); onAction(n.action, { ...values.current }); }}>
      {n.title && <b className="pc-h3">{n.title}</b>}
      {(n.children || []).map((c: any, i: number) => (FIELDS.includes(c?.type) ? <FormField key={i} n={c} values={values.current!} /> : <Node key={i} n={c} />))}
      <div className="row"><button className="pc-pill s" type="submit" disabled={locked}>{n.submitLabel || "Send"}</button></div>
    </form>
  );
}

function initialValues(children: any[]): Values {
  const v: Values = {};
  for (const n of children) {
    if (!FIELDS.includes(n?.type)) continue;
    v[n.name] = n.type === "Checkbox" || n.type === "Toggle" ? !!n.value
      : n.type === "Select" ? n.value ?? n.options?.[0]?.value
      : n.type === "Number" || n.type === "Money" || n.type === "Radio" ? n.value ?? null : n.value ?? "";
  }
  return v;
}

// Fields write straight into the form's values object, like the form state of a plain HTML form.
function FormField({ n, values }: { n: any; values: Values }) {
  const { locked } = useContext(SurfaceCtx);
  const id = useId();
  const set = (v: unknown) => { values[n.name] = v; };
  let input: ReactNode;
  switch (n.type) {
    case "TextField": input = n.multiline
      ? <textarea id={id} placeholder={n.placeholder} required={n.required} defaultValue={n.value || ""} disabled={locked} onChange={(e) => set(e.target.value)} />
      : <input id={id} placeholder={n.placeholder} required={n.required} defaultValue={n.value ?? ""} disabled={locked} onChange={(e) => set(e.target.value)} />; break;
    case "Number": case "Money": input = <input id={id} type="number" step="any" defaultValue={n.value ?? ""} min={n.min} max={n.max} required={n.required} placeholder={n.type === "Money" ? "₹" : ""} disabled={locked}
      onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} />; break;
    case "Date": input = <input id={id} type="date" defaultValue={n.value || ""} required={n.required} disabled={locked} onChange={(e) => set(e.target.value)} />; break;
    case "Select": input = <select id={id} required={n.required} defaultValue={n.value} disabled={locked} onChange={(e) => set(e.target.value)}>{n.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>; break;
    case "Radio": return (
      <div className="field"><label>{n.label}</label><div className="row">{n.options.map((o: any) => (
        <label key={o.value} className="row" style={{ gap: 6 }}><input type="radio" name={id} value={o.value} defaultChecked={o.value === n.value} disabled={locked} onChange={() => set(o.value)} />{o.label}</label>))}</div></div>);
    case "Checkbox": case "Toggle": return <label className="row" style={{ gap: 8 }}><input type="checkbox" defaultChecked={!!n.value} disabled={locked} onChange={(e) => set(e.target.checked)} />{n.label}</label>;
  }
  return <div className="field"><label htmlFor={id}>{n.label}</label>{input}{n.help && <span className="help">{n.help}</span>}</div>;
}

function Choice({ n }: { n: any }) {
  const { onAction, locked } = useContext(SurfaceCtx);
  return (
    <div className="sf-choice">{n.prompt && <p className="muted">{n.prompt}</p>}
      {n.options.map((o: any) => <button key={o.id} type="button" disabled={locked} onClick={() => onAction(n.action, { choice: o.id, label: o.label })}><b>{o.label}</b>{o.detail && <p className="small muted">{o.detail}</p>}</button>)}
    </div>
  );
}
