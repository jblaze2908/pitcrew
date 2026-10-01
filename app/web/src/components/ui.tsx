// Small building blocks over the design system's classes and web components.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { mdToHtml } from "../lib/md";

export type Size = "xs" | "sm" | "md" | "lg" | "xl";
interface Looks { hue?: string; shape?: string; mood?: string }

/** The hue token as a --hue custom property, which the app's classes read. */
export const hueStyle = (hue: string | null | undefined, extra?: CSSProperties) => ({ "--hue": `var(--${hue || "c1"})`, ...extra }) as CSSProperties;

// components.js draws a component only when it connects, so changed attributes need a fresh element: hence the keys.
export function Face({ b, size = "sm", mood }: { b?: Looks | null; size?: Size; mood?: string }) {
  const hue = b?.hue || "c1", shape = b?.shape || "square", m = mood || b?.mood || "idle";
  return <pc-bot key={`${size}.${hue}.${shape}.${m}`} size={size} hue={hue} shape={shape} mood={m} />;
}

export const Loader = () => <pc-loader />;

export function EffectChip({ kind }: { kind: string | null | undefined }) {
  const label = kind === "hire" ? "HIRE" : String(kind || "ask").replace(/_/g, " ");
  return <pc-effect key={kind || ""} kind={kind || "ask"}>{label}</pc-effect>;
}

export function Track({ pct, hue, shape, state = "working" }: { pct: number; hue: string; shape: string; state?: string }) {
  const p = Math.min(100, Math.max(0, pct)).toFixed(0);
  return <pc-track key={`${p}.${hue}.${shape}.${state}`} pct={p} hue={hue} shape={shape} state={state} />;
}

export const Chev = () => <span className="chev" />;

export function Md({ text, className = "md" }: { text: string | null | undefined; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{help && <span className="help">{help}</span>}</div>;
}

export function Seg<T extends string>({ options, value, onChange }: { options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function Meter({ pct, tone = "" }: { pct: number; tone?: "" | "hot" | "bad" }) {
  return <div className={`meter${tone ? ` ${tone}` : ""}`}><b style={{ width: `${Math.min(100, Math.max(0, pct)).toFixed(0)}%` }} /></div>;
}

/** A button that asks once ("Retire? Click again") before it acts. */
export function ConfirmButton({ ask, onConfirm, className, style, children }: { ask: string; onConfirm: () => void; className?: string; style?: CSSProperties; children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button className={className} style={style} onClick={() => { if (!armed) return setArmed(true); setArmed(false); onConfirm(); }}>{armed ? `${ask} Click again` : children}</button>;
}

/** A button that disables itself while its async action runs. */
export function BusyButton({ onClick, className, children, busyLabel }: { onClick: () => Promise<unknown>; className?: string; children: ReactNode; busyLabel?: string }) {
  const [busy, setBusy] = useState(false);
  return <button className={className} disabled={busy} onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>{busy && busyLabel ? busyLabel : children}</button>;
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
