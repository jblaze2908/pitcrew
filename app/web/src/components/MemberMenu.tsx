// One menu for the composer pill, @ in the text and the thread header: face, name, a one-line job, number keys.
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import type { BotCard } from "../../../shared/types";
import { useStore } from "../lib/store";
import { Face } from "./ui";

export interface MenuHandle {
  /** Handles a key typed in the field that owns the menu; true when the menu used it. */
  key: (e: KeyboardEvent) => boolean;
}
interface Props {
  anchor: HTMLElement;
  onPick: (id: string | null) => void;
  onClose: () => void;
  /** Offer "Auto" first (the pill does; @ and the thread header don't). */
  auto?: boolean;
  /** The text after @; null for a plain menu. */
  filter?: string | null;
  current?: string | null;
  exclude?: string | null;
  handle?: Ref<MenuHandle>;
  /** Relabels the first row, e.g. "Everyone" when the menu filters rather than routes. */
  autoLabel?: [string, string];
}
type Row = { id: string; name: string; auto?: boolean; bot?: BotCard };

export const jobLine = (b: Pick<BotCard, "kind" | "job">) => (b.kind === "chief" ? "Anything else; can ask the others" : b.job || "");

export function MemberMenu({ anchor, onPick, onClose, auto = true, filter = null, current = null, exclude = null, handle, autoLabel }: Props) {
  const { S } = useStore();
  const q = (filter || "").toLowerCase();
  const list: Row[] = [
    ...(auto && filter == null ? [{ id: "", name: autoLabel?.[0] || "Auto", auto: true }] : []),
    ...S.bots.filter((b) => b.id !== exclude && (!q || b.name.toLowerCase().includes(q))).map((b) => ({ id: b.id, name: b.name, bot: b })),
  ];
  const [at, setAt] = useState(() => Math.max(0, list.findIndex((r) => r.id === (current ?? ""))));
  const el = useRef<HTMLDivElement>(null);
  const pick = (i: number) => { onClose(); onPick(list[i]?.id || null); };

  useImperativeHandle(handle, () => ({
    key: (e) => {
      if (!list.length) return false;
      if (e.key === "ArrowDown") setAt((a) => (a + 1) % list.length);
      else if (e.key === "ArrowUp") setAt((a) => (a - 1 + list.length) % list.length);
      else if (e.key === "Enter" || e.key === "Tab") pick(Math.min(at, list.length - 1));
      else if (e.key === "Escape") onClose();
      else if (filter == null && /^[0-9]$/.test(e.key) && list[+e.key]) pick(+e.key);
      else return false;
      return true;
    },
  }));

  useEffect(() => {
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!el.current?.contains(t) && !anchor.contains(t)) onClose(); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [anchor, onClose]);

  if (!list.length) return null;
  const r = anchor.getBoundingClientRect();
  return createPortal(
    <div ref={el} className="menu" style={{ left: Math.min(r.left, innerWidth - 400), top: r.bottom + 6 }}>
      {list.map((row, i) => (
        <button key={row.id || "auto"} className={`mi${i === at ? " on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
          {row.auto ? <span className="dot">{(autoLabel?.[0] || "Auto")[0]}</span> : <Face b={row.bot} size="sm" />}
          <span className="col" style={{ gap: 2, minWidth: 0, textAlign: "left" }}>
            <b>{row.name}</b>
            <span className="small faint ell">{row.auto ? autoLabel?.[1] || "Pitcrew picks from each member's job" : jobLine(row.bot!)}</span>
          </span>
          {row.bot?.private ? <span className="pc-chip">Private</span>
            : row.id && row.id === current ? <span className="pc-chip">Picked</span>
            : filter == null && i < 10 ? <span className="kbd">{i}</span> : <span />}
        </button>
      ))}
    </div>,
    document.body,
  );
}
