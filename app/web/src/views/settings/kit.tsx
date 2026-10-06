// The one Settings template: tab head, sections, label/help rows, toggles, the quiet "Saved", secrets and the row menu.
// Save model everywhere: a change saves at once (text on leaving the field) and "Saved" shows by that row.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BlurInput, Switch } from "../../components/ui";
import { dayMonth } from "../../lib/format";


export function TabHead({ title, intro }: { title: string; intro: string }) {
  return <div className="st-head"><h2>{title}</h2><p>{intro}</p></div>;
}

export function Section({ id, title, intro, action, children }: { id?: string; title: string; intro?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-sec" id={id ? `st-${id}` : undefined}>
      <div className="st-sech"><div><h3>{title}</h3>{intro && <p className="st-intro">{intro}</p>}</div>{action && <div className="st-act">{action}</div>}</div>
      <div className="st-rows">{children}</div>
    </section>
  );
}

/** Label and help on the left, the control on the right; `below` spans the full width under them. */
export function Row({ label, help, bad, saved, children, below }: { label: ReactNode; help?: ReactNode; bad?: boolean; saved?: boolean; children?: ReactNode; below?: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-rl"><p className="st-l">{label}</p>{help && <p className={`st-h${bad ? " bad" : ""}`}>{help}</p>}</div>
      <div className="st-ctl">{saved && <span className="st-saved">Saved</span>}{children}</div>
      {below && <div className="st-below">{below}</div>}
    </div>
  );
}

/** A full-width row for lists and explainers that don't fit label + control. */
export const Wide = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`st-row st-wide ${className}`}>{children}</div>;

/** [shown, flash]: flash(key) shows that key for `ms`, so one timer serves a page of rows. */
export function useFlash<T>(ms: number): [T | null, (v: T) => void] {
  const [on, setOn] = useState<T | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const flash = useCallback((v: T) => { setOn(() => v); clearTimeout(t.current); t.current = setTimeout(() => setOn(null), ms); }, [ms]);
  return [on, flash];
}

/** [shown, flash]: flash() shows the row's "Saved" for 2.5 s. */
export function useSaved(): [boolean, () => void] {
  const [on, flash] = useFlash<true>(2500);
  return [!!on, useCallback(() => flash(true), [flash])];
}

export const Toggle = (p: { on: boolean; onChange: (v: boolean) => void; label: string }) => <Switch className="st-tg" {...p} />;

export const TextSave = ({ value, onSave, placeholder, wide }: { value: string; onSave: (v: string) => Promise<unknown>; placeholder?: string; wide?: boolean }) =>
  <BlurInput className={`st-in${wide ? " wide" : ""}`} value={value} placeholder={placeholder} onSave={onSave} />;

/** A write-only secret: "Saved ···· date" and Replace, which opens an empty field. The value is never shown. */
export function SecretRow({ label, help, bad, has, at, onSave, onRemove, placeholder, saveLabel = "Save", extra }: {
  label: string; help?: ReactNode; bad?: boolean; has: boolean; at?: number | null; placeholder: string; saveLabel?: string;
  onSave: (v: string) => Promise<boolean | void>; onRemove?: () => Promise<unknown>; extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false), [v, setV] = useState(""), [busy, setBusy] = useState(false);
  const [saved, flash] = useSaved();
  const save = async () => {
    if (!v.trim()) return;
    setBusy(true);
    try { const ok = await onSave(v.trim()); setV(""); if (ok !== false) { setOpen(false); flash(); } } catch { /* the API toasts the error */ } finally { setBusy(false); }
  };
  const field = (
    <div className="st-secret">
      <input className="st-in" type="password" autoComplete="off" spellCheck={false} autoFocus={has} placeholder={placeholder} value={v}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape" && has) setOpen(false); }} />
      <button className="pc-pill s" disabled={busy || !v.trim()} onClick={save}>{saveLabel}</button>
      {has && <button className="st-q" onClick={() => { setOpen(false); setV(""); }}>Cancel</button>}
    </div>
  );
  return (
    <Row label={label} help={help} bad={bad} saved={saved} below={has && open ? field : undefined}>
      {has ? <>
        <span className="st-val">{`Saved ····${at ? ` ${dayMonth(at)}` : ""}`}</span>
        {!open && <button className="st-q" onClick={() => setOpen(true)}>Replace</button>}
        {extra}
        {onRemove && <Menu items={[{ label: "Remove", danger: true, confirm: "Remove it?", run: onRemove }]} />}
      </> : field}
    </Row>
  );
}

export interface MenuItem { label: string; run: () => unknown; danger?: boolean; confirm?: string }
/** One "···" menu per row. A destructive item asks once before it runs. */
export function Menu({ items, label = "More" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false), [armed, setArmed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (!open) setArmed(null); }, [open]);
  return (
    <div className="st-menu" ref={ref}>
      <button className="st-dots" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>···</button>
      {open && <div className="st-pop" role="menu">{items.map((it) => (
        <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} onClick={() => {
          if (it.confirm && armed !== it.label) return setArmed(it.label);
          setOpen(false); it.run();
        }}>{it.confirm && armed === it.label ? `${it.confirm} Click again` : it.label}</button>))}
      </div>}
    </div>
  );
}
