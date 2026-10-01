// Per-domain policy, crew-wide (scope "global") or one member's. An override replaces that effect's permission on
// pages of the domain; pay always asks.
import { useEffect, useState } from "react";
import type { Decision, SiteRow, SitesView } from "../../../shared/types";
import { api } from "../lib/api";
import { when } from "../lib/format";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { ConfirmButton, Seg } from "./ui";

const SITE_EFFECTS = ["read", "draft", "browse", "write_workspace", "signin", "install", "send", "delete", "share", "exec_untrusted"];
type Kind = "read" | "allowed" | "full" | "blocked";
const KINDS = [["read", "Read only"], ["allowed", "Allowed"], ["full", "Fully"], ["blocked", "Blocked"]] as const;
const SUMMARY: Record<Kind | "custom", string> = { read: "Reads pages; asks before anything else", allowed: "Follows this member's permissions", full: "Does anything except pay", blocked: "Never opens", custom: "Custom" };
const FULL = () => Object.fromEntries(SITE_EFFECTS.map((e) => [e, "allow"])) as Record<string, Decision>;
const kindLabel = (k: Kind) => KINDS.find(([x]) => x === k)![1].toLowerCase();

// "Fully" is stored as allowed with every effect overridden to allow; anything in between is a custom allowed site.
const kindOf = (r: Pick<SiteRow, "mode" | "overrides">): Kind | "custom" =>
  r.mode !== "allowed" ? r.mode : SITE_EFFECTS.every((e) => r.overrides?.[e] === "allow") ? "full" : Object.keys(r.overrides || {}).length ? "custom" : "allowed";

export function SitesEditor({ scope, help }: { scope: string; help?: string }) {
  const { data, error, reload } = useFetch(() => api.get<SitesView>(`/api/sites?scope=${encodeURIComponent(scope)}`), [scope]);
  const [pick, setPick] = useState<Kind>("read");
  const [domain, setDomain] = useState("");
  if (error && !data) return <p className="badc">{error}</p>;
  if (!data) return null;

  const put = (d: string, mode: string, overrides: Record<string, Decision> = {}) => api.put("/api/sites", { scope, domain: d, mode, overrides });
  const store = (d: string, k: Kind) => (k === "full" ? put(d, "allowed", FULL()) : put(d, k));
  const add = async () => { const d = domain.trim(); if (!d) return; await store(d, pick); toast(`${d}: ${kindLabel(pick)}`); reload(); };
  // Typing in the add box also filters the list, so a long preset list stays findable.
  const q = domain.trim().toLowerCase();

  return (
    <div className="col">
      {help && <p className="small muted">{help}</p>}
      <div className="pc-card col">
        <div className="addsite">
          <input placeholder="Add a site: example.com, or app.example.com for one subdomain" value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          <Seg options={KINDS} value={pick} onChange={setPick} />
          <button className="pc-pill s" onClick={add}>Add</button>
        </div>
        {data.sites.length
          ? <div className="sites">{data.sites.map((r) => <SiteLine key={r.domain} r={r} hidden={!!q && !r.domain.includes(q)} store={store} put={put}
              onRemoved={reload} remove={() => api.del(`/api/sites?scope=${encodeURIComponent(scope)}&domain=${encodeURIComponent(r.domain)}`)} />)}</div>
          : <p className="empty">No sites yet. A site the crew hasn't been allowed to open asks you first.</p>}
      </div>
    </div>
  );
}

interface LineProps {
  r: SiteRow; hidden: boolean;
  store: (d: string, k: Kind) => Promise<unknown>; put: (d: string, mode: string, o?: Record<string, Decision>) => Promise<unknown>;
  remove: () => Promise<unknown>; onRemoved: () => void;
}

function SiteLine({ r, hidden, store, put, remove, onRemoved }: LineProps) {
  const [row, setRow] = useState(r);
  useEffect(() => setRow(r), [r]);
  const [custom, setCustom] = useState(false);
  const kind = kindOf(row);
  const summary = kind === "custom" ? Object.entries(row.overrides).map(([e, v]) => `${e.replace(/_/g, " ")}: ${v}`).join(" · ") : SUMMARY[kind];

  const setKind = async (k: Kind) => {
    await store(row.domain, k);
    setRow({ ...row, mode: k === "full" ? "allowed" : k, overrides: k === "full" ? FULL() : {} });
    setCustom(false);
    toast(`${row.domain}: ${kindLabel(k)}`);
  };
  const setOverride = async (effect: string, v: "" | Decision) => {
    const next = { ...(row.overrides || {}) };
    if (v) next[effect] = v; else delete next[effect];
    await put(row.domain, "allowed", next);
    setRow({ ...row, mode: "allowed", overrides: next });
    toast(`${row.domain}: saved`);
  };

  return (
    <div className={`site ${hidden ? "hidden" : ""}`}>
      <div className="siterow">
        <span className="pc-m dom" title={`Updated ${when(row.updated_at)}`}>{row.domain}{row.by === "preset" && <small className="faint"> preset</small>}</span>
        <Seg options={KINDS} value={kind === "custom" ? "allowed" : kind} onChange={setKind} />
        <span className="what">{summary}</span>
        <div className="row acts">
          <button className="small faint" onClick={() => setCustom((c) => !c)}>Customize</button>
          <ConfirmButton className="small faint" ask="Remove?" onConfirm={async () => { await remove(); toast(`${row.domain} removed`); onRemoved(); }}>Remove</ConfirmButton>
        </div>
      </div>
      {custom && (
        <div className="custom">
          {SITE_EFFECTS.map((e) => (
            <div key={e} className="perm">
              <pc-effect kind={e}>{e.replace(/_/g, " ")}</pc-effect><span className="what">On this site</span>
              <Seg options={[["", "Member's"], ["allow", "Allow"], ["ask", "Ask"]] as const} value={(row.overrides?.[e] || "") as "" | "allow" | "ask"} onChange={(v) => setOverride(e, v)} />
            </div>))}
          <p className="small faint">Pay always asks, whatever you set here.</p>
        </div>)}
    </div>
  );
}
