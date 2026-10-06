// Small building blocks over the design system's classes and web components.
import { useEffect, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { errorDetail, errorLine } from "../../../shared/text";
import type { Hue, Shape } from "../../../shared/types";
import { cap } from "../lib/format";
import { mdToHtml } from "../lib/md";

type Size = "xs" | "sm" | "md" | "lg" | "xl";
/** The colours and shapes a member's face can take (c4 is kept for signal orange). */
export const HUES: readonly Hue[] = ["c1", "c2", "c3", "c5", "c6"];
export const SHAPES: readonly Shape[] = ["square", "round", "blob"];
interface Looks { hue?: string; shape?: string; mood?: string }

/** The hue token as a --hue custom property, which the app's classes read. */
export const hueStyle = (hue: string | null | undefined, extra?: CSSProperties) => ({ "--hue": `var(--${hue || "c1"})`, ...extra }) as CSSProperties;

// components.js draws a component only when it connects, so changed attributes need a fresh element: hence the keys.
export function Face({ b, size = "sm", mood }: { b?: Looks | null; size?: Size; mood?: string }) {
  const hue = b?.hue || "c1", shape = b?.shape || "square", m = mood || b?.mood || "idle";
  return <pc-bot key={`${size}.${hue}.${shape}.${m}`} size={size} hue={hue} shape={shape} mood={m} />;
}

export const Loader = () => <pc-loader />;

/** The gate's effect classes (jev.ts) in plain words. */
const EFFECT_LABEL: Record<string, string> = { read: "Read", browse: "Browse", draft: "Draft", write_workspace: "Write files", write: "Write files", signin: "Sign in",
  install: "Install", send: "Send", pay: "Pay", delete: "Delete", share: "Share", exec_untrusted: "Run unknown code", hire: "Hire", member: "Member change",
  soul: "Instructions", retire: "Retire", plan_limit: "Plan", ask: "Ask", unknown: "Other" };
export const effectLabel = (kind: string | null | undefined) => EFFECT_LABEL[kind || "ask"] || cap(String(kind).replace(/_/g, " "));
// Quiet grey words, not the design system's coloured pc-effect badge: orange is kept for what waits on you.
export function EffectChip({ kind }: { kind: string | null | undefined }) {
  return <span className="eff">{effectLabel(kind)}</span>;
}


export const Chev = () => <span className="chev" />;

export function Md({ text, className = "md", botId }: { text: string | null | undefined; className?: string; botId?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: mdToHtml(text, botId) }} />;
}

/** Inline code and bold as elements, the rest as plain text: for bubbles and one-line cells where block markdown won't fit. */
export function Inline({ text }: { text: string | null | undefined }) {
  // split() with one capture group puts the matches at odd indexes.
  return <>{String(text || "").split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((p, i) => i % 2 === 0 ? p
    : p[0] === "`" ? <code key={i} className="ic">{p.slice(1, -1)}</code> : <strong key={i}>{p.slice(2, -2)}</strong>)}</>;
}

/** A run error as its message, with the raw body folded underneath when there was one. */
export function ErrorText({ raw, className = "small badc" }: { raw: string | null | undefined; className?: string }) {
  const more = errorDetail(raw);
  return (
    <div className={`errtext ${className}`}>
      <span>{errorLine(raw)}</span>
      {more && <details onClick={(e) => e.stopPropagation()}><summary>Details</summary><pre>{more}</pre></details>}
    </div>);
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{help && <span className="help">{help}</span>}</div>;
}

export function Seg<T extends string>({ options, value, onChange }: { options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}</div>;
}


/** A button that asks once ("Retire? Click again") before it acts. */
export function ConfirmButton({ ask, onConfirm, className, armedClass, style, children }: { ask: string; onConfirm: () => void; className?: string; armedClass?: string; style?: CSSProperties; children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button className={armed && armedClass ? `${className || ""} ${armedClass}` : className} style={style} onClick={() => { if (!armed) return setArmed(true); setArmed(false); onConfirm(); }}>{armed ? `${ask} Click again` : children}</button>;
}

/** A button that disables itself while its async action runs. */
export function BusyButton({ onClick, className, children, busyLabel }: { onClick: () => Promise<unknown>; className?: string; children: ReactNode; busyLabel?: string }) {
  const [busy, setBusy] = useState(false);
  return <button className={className} disabled={busy} onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>{busy && busyLabel ? busyLabel : children}</button>;
}


/** An on/off switch; Settings draws it as .st-tg, member Settings as .tg. */
export function Switch({ on, onChange, label, className }: { on: boolean; onChange: (v: boolean) => void; label: string; className: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`${className}${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** An input that saves when you leave it (or press Enter), only if it changed; a failed save puts the old value back. */
export function BlurInput({ value, onSave, ...rest }: { value: string; onSave: (v: string) => unknown } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input {...rest} value={v} onChange={(e) => setV(e.target.value)}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    onBlur={() => { if (v !== value) Promise.resolve(onSave(v)).catch(() => setV(value)); }} />;
}
