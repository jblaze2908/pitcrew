// Renders a validated surface spec (generative UI) with Pitcrew components. Text renders as text only; colours are hue
// tokens only. Specs are dynamic JSON from the crew, hence `any` for nodes.
import { Component, createContext, useContext, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Surface as SurfaceRow } from "../../../shared/types";
import { controlDefaults, whenHolds } from "../../../shared/pui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { toast } from "../lib/toast";
import { BarChart, Donut, LineChart, Sparkline, chartColor } from "./Charts";

type Values = Record<string, unknown>;
type State = Record<string, string | number | boolean>;
interface Ctx { onAction: (action: string, values: Values) => Promise<void> | void; locked: boolean; state: State; setControl: (name: string, v: string | number | boolean) => void }
const SurfaceCtx = createContext<Ctx>({ onAction: () => {}, locked: false, state: {}, setControl: () => {} });

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
function fmt(v: unknown, f?: string): string {
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

/** `extra` sits in the header (Keep in Library, or a link back); `lockOnAction` disables the inputs once one is sent.
 *  An action goes to the crew as a message on the surface's thread. `live` is a surface still streaming in a reply:
 *  drawn, but nothing is sent or fetched yet. Controls change `state`; a surface with queries re-runs them for it. */
export function Surface({ s: given, extra, lockOnAction = false, live = false }: { s: SurfaceRow; extra?: ReactNode; lockOnAction?: boolean; live?: boolean }) {
  const [locked, setLocked] = useState(false);
  // What the driver changed; every other control sits at its default (a live surface gains controls as it streams).
  const [changed, setChanged] = useState<State>({});
  // A bound dashboard re-reads its ledger on refresh; the server runs the queries (cached per ledger version and state).
  const [fresh, setFresh] = useState<SurfaceRow | null>(null);
  const s = fresh && fresh.id === given.id ? fresh : given;
  const state: State = { ...controlDefaults(s.spec?.root), ...changed };
  const timer = useRef(0);
  const load = async (st: State) => setFresh(await api.get<SurfaceRow>(`/api/surfaces/${s.id}?state=${encodeURIComponent(JSON.stringify(st))}`));
  const setControl = (name: string, v: string | number | boolean) => {
    const next = { ...state, [name]: v };
    setChanged((c) => ({ ...c, [name]: v }));
    // Sliders fire per pixel: the queries run once the hand stops (150 ms).
    if (s.data && !live) { clearTimeout(timer.current); timer.current = window.setTimeout(() => load(next).catch(() => {}), 150); }
  };
  const act = async (action: string, values: Values) => {
    if (live) return;
    await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew");
    if (lockOnAction) setLocked(true);
  };
  return (
    <SurfaceCtx.Provider value={{ onAction: act, locked: locked || live, state, setControl }}>
      <div className="surface">
        <div className="head"><span className="pc-lab">{s.data?.source ? "Dashboard" : "Surface"}</span><b className="pc-h3">{s.spec?.title}</b>{extra}</div>
        {s.data?.source && <p className="small faint row" style={{ gap: 8 }}>
          <span title={s.data.source}>{s.data.asOf ? `Data as of ${ago(s.data.asOf)}` : "Ledger not found"}</span>
          <button className="small faint" onClick={() => load(state)}>Refresh</button>
        </p>}
        <Node n={s.spec?.root} />
      </div>
    </SurfaceCtx.Provider>
  );
}

/** A surface that throws (a half-written spec in a live reply) draws one faint line instead of taking the thread down. */
export class SurfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="small faint" style={{ marginLeft: 40 }}>This surface couldn't be drawn.</p> : this.props.children; }
}

function Kids({ n }: { n: any }) { return <>{(n.children || []).map((c: any, i: number) => <Node key={i} n={c} />)}</>; }

function Node({ n }: { n: any }): ReactNode {
  const { state } = useContext(SurfaceCtx);
  if (!n) return null;
  if (n.when !== undefined && !whenHolds(n.when, state)) return null;
  // Still bound: a live reply's surface before the server has run its queries.
  if (n.bind !== undefined) return <p className="small faint">{n.title || n.label ? `${n.title || n.label} · ` : ""}loading…</p>;
  switch (n.type) {
    case "Section": return <section className="col">{n.title && <h4 className="pc-h3">{n.title}</h4>}<Kids n={n} /></section>;
    case "Stack": return <div className={`sf-stack ${n.direction === "row" ? "row" : ""}`} style={{ gap: ({ s: 8, m: 12, l: 20 } as Record<string, number>)[n.gap] || 12 }}><Kids n={n} /></div>;
    case "Grid": return <div className="sf-grid" style={{ gridTemplateColumns: `repeat(${n.columns || 2},minmax(0,1fr))` }}><Kids n={n} /></div>;
    case "Card": return <div className={`sf-card ${chartColor(n.hue) ? "hue" : ""}`} style={chartColor(n.hue) ? hue(chartColor(n.hue)!) : undefined}>{n.title && <b className="pc-h3">{n.title}</b>}<Kids n={n} /></div>;
    case "Divider": return <div className="divider" />;
    case "Heading": return n.level === 3 ? <h4 className="pc-h3">{n.text}</h4> : <h3 className="pc-h2">{n.text}</h3>;
    case "Text": { const t = toneClass(n.tone); return <p className={n.tone === "muted" ? "muted" : t === "ok" ? "okc" : t === "bad" ? "badc" : ""}>{n.text}</p>; }
    case "Quote": return <p className="pc-quote">{n.text}</p>;
    case "Lab": return <p className="pc-lab">{n.text}</p>;
    case "Receipt": return <p className="small muted">[ok] {n.text}{n.source && <> · <a href={n.source} target="_blank" rel="noopener noreferrer" className="md">{hostOf(n.source)}</a></>}</p>;
    case "Stat": return <div className="sf-stat col" style={{ gap: 4 }}><p className="pc-lab">{n.label}</p><span className="v num">{n.format ? fmt(n.value, n.format) : n.value}</span>{n.delta && <span className={`d ${n.tone === "down" || n.tone === "bad" ? "down" : n.tone === "up" || n.tone === "ok" ? "up" : "faint"}`}>{n.delta}</span>}</div>;
    case "Meter": return <div className="col" style={{ gap: 6 }}><div className="spread small"><span>{n.label}</span><span className="num faint">{`${fmt(n.value, "number")} / ${fmt(n.max, "number")}${n.unit ? " " + n.unit : ""}`}</span></div><div className="meter"><b style={{ width: `${Math.min(100, (n.value / (n.max || 1)) * 100)}%`, background: chartColor(n.hue) || "var(--v1)" }} /></div></div>;
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
    case "Picker": case "Tabs": case "Slider": case "Switch": return <Control n={n} />;
    case "Form": return <Form n={n} />;
    case "Choice": return <Choice n={n} />;
    default: return <p className="badc small">Unknown component {String(n.type)}</p>;
  }
}

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

// The driver's controls: plain inputs in the app's own styles; the value lives in the surface's state.
function Control({ n }: { n: any }) {
  const { state, setControl } = useContext(SurfaceCtx);
  const id = useId(), v = state[n.name];
  if (n.type === "Tabs") return <div className="seg" role="tablist" aria-label={n.label}>{(n.options || []).map((o: any) =>
    <button key={o.value} type="button" role="tab" aria-selected={v === o.value} className={v === o.value ? "on" : ""} onClick={() => setControl(n.name, o.value)}>{o.label}</button>)}</div>;
  if (n.type === "Switch") return <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={v === true} onChange={(e) => setControl(n.name, e.target.checked)} />{n.label}</label>;
  if (n.type === "Slider") return (
    <div className="field"><label htmlFor={id} className="spread"><span>{n.label}</span><span className="num faint">{`${fmt(Number(v), "number")}${n.unit ? ` ${n.unit}` : ""}`}</span></label>
      <input id={id} type="range" min={n.min} max={n.max} step={n.step ?? 1} value={Number(v)} onChange={(e) => setControl(n.name, Number(e.target.value))} /></div>);
  return <div className="field">{n.label && <label htmlFor={id}>{n.label}</label>}
    <select id={id} value={String(v ?? "")} onChange={(e) => setControl(n.name, e.target.value)}>{(n.options || []).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
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
