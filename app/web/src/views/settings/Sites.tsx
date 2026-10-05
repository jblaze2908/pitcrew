// Per-domain policy, crew-wide (scope "global") or one member's, grouped: added by you, blocked, and the presets on
// one line. Labels only: the server keeps read / allowed / blocked, and "Act freely" is allowed with every effect on.
import { useEffect, useState } from "react";
import type { Decision, SiteRow, SitesView } from "../../../../shared/types";
import { EffectChip, Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { useFetch } from "../../lib/useFetch";
import { Menu, useSaved } from "./kit";

const SITE_EFFECTS = ["read", "draft", "browse", "write_workspace", "signin", "install", "send", "delete", "share", "exec_untrusted"];
type Kind = "read" | "allowed" | "full" | "blocked";
export const SITE_LEVELS: readonly (readonly [Kind, string, string])[] = [
  ["read", "Read only", "Reads pages, asks before anything else."],
  ["allowed", "Member's rules", "Follows that member's own permissions."],
  ["full", "Act freely", "Does anything there except pay."],
  ["blocked", "Blocked", "Never opens it."],
];
const label = (k: Kind) => SITE_LEVELS.find(([x]) => x === k)![1];
const FULL = () => Object.fromEntries(SITE_EFFECTS.map((e) => [e, "allow"])) as Record<string, Decision>;
const kindOf = (r: Pick<SiteRow, "mode" | "overrides">): Kind | "custom" =>
  r.mode !== "allowed" ? r.mode : SITE_EFFECTS.every((e) => r.overrides?.[e] === "allow") ? "full" : Object.keys(r.overrides || {}).length ? "custom" : "allowed";
const customLine = (o: Record<string, Decision>) => `Member's rules, plus ${Object.entries(o).map(([e, v]) => `${e.replace(/_/g, " ")} ${v === "allow" ? "without asking" : "asks"}`).join(", ")}`;

export function Sites({ scope, intro }: { scope: string; intro?: string }) {
  const { data, error, reload } = useFetch(() => api.get<SitesView>(`/api/sites?scope=${encodeURIComponent(scope)}`), [scope]);
  const [pick, setPick] = useState<Kind>("read");
  const [domain, setDomain] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  if (error && !data) return <p className="badc">{error}</p>;
  if (!data) return null;

  const put = (d: string, mode: string, overrides: Record<string, Decision> = {}) => api.put("/api/sites", { scope, domain: d, mode, overrides });
  const store = (d: string, k: Kind) => (k === "full" ? put(d, "allowed", FULL()) : put(d, k));
  const remove = (d: string) => api.del(`/api/sites?scope=${encodeURIComponent(scope)}&domain=${encodeURIComponent(d)}`);
  const add = async () => { const d = domain.trim(); if (!d) return; await store(d, pick); setDomain(""); reload(); };
  // Typing in the add box also filters every group, so a long preset list stays findable.
  const q = domain.trim().toLowerCase(), shown = data.sites.filter((r) => !q || r.domain.includes(q));
  const blocked = shown.filter((r) => r.mode === "blocked"), mine = shown.filter((r) => r.mode !== "blocked" && r.by !== "preset"), presets = shown.filter((r) => r.mode !== "blocked" && r.by === "preset");
  const allPresets = data.sites.filter((r) => r.mode !== "blocked" && r.by === "preset");
  const line = (r: SiteRow) => <Line key={r.domain} r={r} store={store} put={put} remove={async () => { await remove(r.domain); reload(); }} />;
  const group = (title: string, rows: SiteRow[]) => rows.length > 0 && <div className="st-group"><div className="st-sub"><span>{title}</span><span>{rows.length === 1 ? "1 site" : `${rows.length} sites`}</span></div>{rows.map(line)}</div>;
  // The presets folded to one line: the read-only ones by name, then any that differ.
  const ro = allPresets.filter((r) => kindOf(r) === "read").map((r) => r.domain), other = allPresets.filter((r) => kindOf(r) !== "read");
  const summary = [ro.length ? `${ro.slice(0, 6).join(", ")}${ro.length > 6 ? ` and ${ro.length - 6} more` : ""} ${ro.length === 1 ? "is" : "are"} read only.` : "",
    ...other.map((r) => { const k = kindOf(r); return `${r.domain} ${k === "full" ? "may act freely" : k === "custom" ? "has its own rules" : "follows the member's rules"}.`; })].filter(Boolean).join(" ");

  return (
    <div className="st-sites">
      {intro && <p className="st-intro">{intro}</p>}
      <div className="st-add">
        <input className="st-in wide" placeholder="Add a site or search, e.g. example.com" value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <select className="st-sel" aria-label="Level for the new site" value={pick} onChange={(e) => setPick(e.target.value as Kind)}>{SITE_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button className="pc-pill s" disabled={!domain.trim()} onClick={add}>Add</button>
      </div>
      <div className="st-legend">{SITE_LEVELS.map(([k, l, d]) => <div key={k}><b>{l}</b><span>{d}</span></div>)}</div>
      {!data.sites.length && <p className="st-empty">No sites yet. A site the crew hasn't been allowed to open asks you first.</p>}
      {q && !shown.length && data.sites.length > 0 && <p className="st-empty">{`No site matches “${q}”. Press Add to add it.`}</p>}
      {group("Added by you", mine)}
      {group("Blocked", blocked)}
      {allPresets.length > 0 && (q ? group("Included with Pitcrew", presets) : (
        <div className="st-group">
          <div className="st-sub"><span>Included with Pitcrew</span><button className="st-q" onClick={() => setShowPresets((x) => !x)}>{showPresets ? "Fold" : `Show all ${allPresets.length}`}</button></div>
          {showPresets ? allPresets.map(line) : <p className="st-fold">{summary}</p>}
        </div>))}
    </div>
  );
}

interface LineProps { r: SiteRow; store: (d: string, k: Kind) => Promise<unknown>; put: (d: string, mode: string, o?: Record<string, Decision>) => Promise<unknown>; remove: () => Promise<unknown> }

function Line({ r, store, put, remove }: LineProps) {
  const [row, setRow] = useState(r);
  useEffect(() => setRow(r), [r]);
  const [custom, setCustom] = useState(false);
  const [saved, flash] = useSaved();
  const kind = kindOf(row);
  const setKind = async (k: Kind) => {
    await store(row.domain, k);
    setRow({ ...row, mode: k === "full" ? "allowed" : k, overrides: k === "full" ? FULL() : {} });
    setCustom(false); flash();
  };
  const setOverride = async (effect: string, v: "" | Decision) => {
    const next = { ...(row.overrides || {}) };
    if (v) next[effect] = v; else delete next[effect];
    await put(row.domain, "allowed", next);
    setRow({ ...row, mode: "allowed", overrides: next }); flash();
  };
  return (
    <div className="st-site">
      <div className="st-siterow">
        <div className="st-rl"><p className="st-l" title={`Updated ${when(row.updated_at)}`}>{row.domain}</p>{kind === "custom" && <p className="st-h">{customLine(row.overrides)}</p>}</div>
        <div className="st-ctl">
          {saved && <span className="st-saved">Saved</span>}
          <select className="st-sel" aria-label={`Level for ${row.domain}`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {SITE_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            {kind === "custom" && <option value="custom" disabled>Custom</option>}
          </select>
          <Menu label={`More for ${row.domain}`} items={[{ label: custom ? "Hide custom rules" : "Customize", run: () => setCustom((c) => !c) }, { label: "Remove", danger: true, confirm: "Remove?", run: remove }]} />
        </div>
      </div>
      {custom && (
        <div className="st-custom">
          {SITE_EFFECTS.map((e) => (
            <div key={e} className="st-perm">
              <EffectChip kind={e} />
              <Seg options={[["", "Member's rules"], ["allow", "Without asking"], ["ask", "Asks"]] as const} value={(row.overrides?.[e] || "") as "" | "allow" | "ask"} onChange={(v) => setOverride(e, v)} />
            </div>))}
          <p className="st-h">{`Paying always asks, whatever you set here. ${label("full")} turns every one of these on.`}</p>
        </div>)}
    </div>
  );
}
