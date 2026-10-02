// Provider and model for a member. The model is a searchable dropdown of the provider's catalogue: one /api/models call
// per provider per page load (the server caches the catalogue 6 h), filtered here as you type.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ModelInfo, ProviderId } from "../../../shared/types";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Field } from "./ui";

const loaded = new Map<string, Promise<ModelInfo[]>>();
const catalogue = (p: string) => {
  if (!loaded.has(p)) loaded.set(p, api.get<ModelInfo[]>(`/api/models?provider=${p}`, { quiet: true }).catch(() => { loaded.delete(p); return []; }));
  return loaded.get(p)!;
};
const SHOWN = 200;
// OpenRouter lists routers with -1 prices; show a price only when it's a real one.
const perM = (n: number) => `$${(n * 1e6).toFixed(2)}`;
const priceOf = (m: ModelInfo) => m.price && m.price.in >= 0 && m.price.out >= 0 ? `${perM(m.price.in)} / ${perM(m.price.out)} per M` : "";

export function ModelPicker({ provider, model, onProvider, onModel }: { provider: string; model: string; onProvider: (p: ProviderId) => void; onModel: (m: string) => void }) {
  const { S } = useStore();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { let live = true; setModels(null); catalogue(provider).then((l) => live && setModels(l)); return () => { live = false; }; }, [provider]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (models || []).filter((m) => words.every((w) => m.id.toLowerCase().includes(w) || String(m.name).toLowerCase().includes(w)));
  const custom = q.trim() && !matches.some((m) => m.id === q.trim()) ? q.trim() : null;
  const rows: { id: string; name: string; price: string; custom?: boolean }[] = [
    ...matches.slice(0, SHOWN).map((m) => ({ id: m.id, name: m.name, price: priceOf(m) })),
    ...(custom ? [{ id: custom, name: `Use “${custom}”`, price: "", custom: true }] : []),
  ];
  const cur = models?.find((m) => m.id === model);

  const show = () => { setQ(""); setOpen(true); setAt(Math.max(0, (models || []).findIndex((m) => m.id === model))); };
  const pick = (id: string) => { onModel(id); setOpen(false); };
  useEffect(() => { list.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" }); }, [at, open]);
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (rows.length) setAt((a) => (a + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) pick(rows[at].id); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="grid2">
      <Field label="Provider">
        <select value={provider} onChange={(e) => { onProvider(e.target.value as ProviderId); onModel(""); }}>
          {Object.entries(S.providers).map(([k, p]) => <option key={k} value={k}>{`${p.label}${p.connected ? "" : " (not connected)"}`}</option>)}
        </select>
      </Field>
      <Field label="Model">
        <div className="modelpick" ref={box}>
          <button type="button" className="trigger" onClick={() => (open ? setOpen(false) : show())}>
            <span className="col">
              <b>{cur?.name || model || "Pick a model"}</b>
              {model && <span className="pc-m small faint">{model}</span>}
            </span>
            <span className="faint">▾</span>
          </button>
          {open && (
            <div className="menu">
              <input autoFocus value={q} placeholder={models ? `Search ${models.length} models` : "Loading models…"} onChange={(e) => { setQ(e.target.value); setAt(0); }} onKeyDown={key} />
              <div className="rows" ref={list}>
                {rows.map((r, i) => (
                  <button type="button" key={r.custom ? "custom" : r.id} className={`mi${i === at ? " on" : ""}`} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); pick(r.id); }}>
                    <span className="col"><b>{r.name}</b>{!r.custom && <span className="pc-m small faint">{r.id}</span>}</span>
                    <span className="small faint">{r.id === model ? "Current" : r.price}</span>
                  </button>))}
                {models && !rows.length && <p className="small faint" style={{ padding: "8px 10px" }}>No models match.</p>}
                {matches.length > SHOWN && <p className="small faint" style={{ padding: "8px 10px" }}>{`${matches.length - SHOWN} more: type to narrow.`}</p>}
              </div>
            </div>)}
        </div>
      </Field>
    </div>
  );
}
