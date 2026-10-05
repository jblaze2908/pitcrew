// One shape for the long lists (Pit stops, Telemetry, Threads): header, tabs, filter row, day groups and pager.
// Pages come from "before" cursors (api/lists.ts); Newer walks back down the stack of cursors already seen.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dayLabel } from "../lib/format";
import { useFetch } from "../lib/useFetch";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";

export function ListPage({ title, lede, right, className = "", children }: { title: string; lede?: string; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`page lp ${className}`}>
      <header className="lp-head"><div><h1 className="lp-title">{title}</h1>{lede && <p className="lp-lede">{lede}</p>}</div>{right && <div className="lp-right">{right}</div>}</header>
      {children}
    </div>);
}

export function ListTabs({ tabs, value }: { tabs: { key: string; label: string; count?: number | null; href: string }[]; value: string }) {
  return <nav className="lp-tabs">{tabs.map((t) => <a key={t.key} href={t.href} className={t.key === value ? "on" : ""}>{t.label}{t.count != null && <em>{t.count}</em>}</a>)}</nav>;
}

export const ListHeading = ({ children, count, dot }: { children: ReactNode; count?: number; dot?: boolean }) =>
  <h2 className="lp-h2">{dot && <i className="lp-dot" />}{children}{count != null && <em>{count}</em>}</h2>;

/** Search first, then ghost dropdowns, then whatever goes on the right (a range, a toggle). */
export function ListFilters({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="lp-filters">{children}{right && <><span className="lp-grow" />{right}</>}</div>;
}

/** Typing waits for a 250 ms pause before onChange, so a search costs one request, not one per key. */
export function ListSearch({ value, onChange, placeholder, wide }: { value: string; onChange: (v: string) => void; placeholder: string; wide?: boolean }) {
  const [v, setV] = useState(value);
  const fn = useRef(onChange); fn.current = onChange;
  useEffect(() => { if (v.trim() === value) return; const t = setTimeout(() => fn.current(v.trim()), 250); return () => clearTimeout(t); }, [v]);
  return <label className={`lp-search${wide ? " wide" : ""}`}><Icon name="search" size={13} /><input type="search" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} /></label>;
}

/** active: the filter narrows the list (any value but the first, by default), so it reads a shade brighter. */
export function ListSelect<T extends string>({ value, onChange, options, label, active = value !== options[0]?.[0] }: { value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; label: string; active?: boolean }) {
  return <select className={`lp-dd${active ? " on" : ""}`} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
}

/** "Everyone" plus each member; a retired member stays listed while it's the one picked. */
export function MemberSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { S, name } = useStore();
  const opts: [string, string][] = [["", "Everyone"], ...S.bots.map((b): [string, string] => [b.id, b.name])];
  if (value && !S.bots.some((b) => b.id === value)) opts.push([value, name(value)]);
  return <ListSelect value={value} onChange={onChange} options={opts} label="Member" />;
}

export const RANGES = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["0", "All time"]] as const;
export type Range = (typeof RANGES)[number][0];
export const RangeSelect = ({ value, onChange }: { value: Range; onChange: (v: Range) => void }) => <ListSelect value={value} onChange={onChange} options={RANGES} label="Range" active={false} />;

/** Rows grouped under a heading with its count; consecutive rows with the same label share a group. */
export function ListGroups<T>({ rows, group = (r: T, at: (r: T) => number) => dayLabel(at(r)), at, keyOf, children }: { rows: T[]; at: (r: T) => number; group?: (r: T, at: (r: T) => number) => string; keyOf: (r: T) => string; children: (r: T) => ReactNode }) {
  const groups: [string, T[]][] = [];
  for (const r of rows) { const g = group(r, at), last = groups.at(-1); if (last && last[0] === g) last[1].push(r); else groups.push([g, [r]]); }
  return <>{groups.map(([g, list], i) => (
    <section key={`${g}.${i}`} className="lp-group">
      <p className="lp-day">{g}<em>{list.length}</em></p>
      {list.map((r) => <div key={keyOf(r)} className="lp-item">{children(r)}</div>)}
    </section>))}</>;
}

export function ListPager({ note, newer, older, children }: { note: ReactNode; newer?: (() => void) | null; older?: (() => void) | null; children?: ReactNode }) {
  return (
    <div className="lp-pager"><small>{note}</small><span className="lp-grow" />{children}
      {(newer !== undefined || older !== undefined) && <>
        <button className="pc-pill o s" disabled={!newer} onClick={() => newer?.()}>Newer</button>
        <button className="pc-pill o s" disabled={!older} onClick={() => older?.()}>Older</button></>}
    </div>);
}

/** "1–12 of 184 decisions", or "5 decisions" when it all fits on one page. */
export function pageNote(from: number, shown: number, total: number | null, noun: string) {
  if (!shown) return `No ${noun}`;
  const to = from + shown - 1;
  return total != null && total <= shown && from === 1 ? `${total} ${noun}` : `${from}–${to}${total != null ? ` of ${total}` : ""} ${noun}`;
}

interface Paged<R> { rows: R[]; next: string | null; total?: number | null }
/** One page of a cursor-paged list. key holds every filter: when it changes, paging starts over at the newest page.
 *  The total comes with the first page only and is kept while paging back. */
export function useCursorPages<R, P extends Paged<R>>(load: (before: string | null) => Promise<P>, key: string, limit: number) {
  const [stack, setStack] = useState<{ key: string; cursors: (string | null)[] }>({ key, cursors: [null] });
  const cursors = stack.key === key ? stack.cursors : [null];
  const before = cursors[cursors.length - 1];
  const res = useFetch(async () => ({ key, before, ...(await load(before)) }), [key, before], { keep: true });
  const [total, setTotal] = useState<{ key: string; n: number } | null>(null);
  const d = res.data;
  useEffect(() => { if (d && d.before === null && d.total != null) setTotal({ key: d.key, n: d.total }); }, [d]);
  const fresh = d && d.key === key && d.before === before ? d : null;
  const n = cursors.length - 1;
  return {
    page: fresh, stale: !!d && !fresh, data: d, error: res.error, reload: res.reload, first: n === 0,
    total: total?.key === key ? total.n : null, from: n * limit + 1,
    older: fresh?.next ? () => setStack({ key, cursors: [...cursors, fresh.next] }) : null,
    newer: n > 0 ? () => setStack({ key, cursors: cursors.slice(0, -1) }) : null,
  };
}
