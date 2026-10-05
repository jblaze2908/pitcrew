// Hiring: a blank form, or the Crew Chief's proposal (a hire pit stop) to review. Nothing joins without your click.
import { useRef, useState } from "react";
import type { EngramConnection, EngramScope, Hue, PitStop, Shape } from "../../../shared/types";
import { ModelPicker } from "../components/ModelPicker";
import { HireSummary, type HireSpec } from "../components/PitCard";
import { Face, Field, hueStyle } from "../components/ui";
import { api } from "../lib/api";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { DIALS, HouseholdBox, SCOPE_LABEL, splitQuirks } from "./crew/ProfileTab";

const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
const SHAPES: Shape[] = ["square", "round", "blob"];

export function Hire({ psId }: { psId?: string }) {
  const proposal = useFetch(async () => ({ ps: psId ? (await api.get<PitStop[]>("/api/pitstops?status=pending")).find((p) => p.id === psId) ?? null : null }), [psId]);
  if (!proposal.data) return proposal.error ? <div className="page"><p className="badc">{proposal.error}</p></div> : null;
  if (psId && !proposal.data.ps) return <div className="page"><p className="muted">That proposal was already decided.</p><a className="pc-pill s" href="#/pitstops">Pit stops</a></div>;
  return <HireForm ps={proposal.data.ps} />;
}

function HireForm({ ps }: { ps: PitStop | null }) {
  const { S, refresh } = useStore();
  const spec = (ps?.detail.spec || {}) as HireSpec & Record<string, any>;
  const p = spec.personality || {};
  const [f, setF] = useState(() => ({
    name: spec.name || "", job: spec.job || "", role: p.role || "", quirks: (p.quirks || []).join("; "), signoff: p.signoff || "", callMe: p.callMe || "",
    cap: String(spec.weekly_cap_usd ?? 5), sSpec: spec.schedule?.spec || "", sPrompt: spec.schedule?.prompt || "",
    provider: (spec.provider || S.defaultProvider) as string, model: spec.model || "",
    hue: (spec.hue || HUES.find((h) => !S.bots.some((x) => x.hue === h)) || HUES[Math.floor(Math.random() * HUES.length)]) as Hue, shape: (spec.shape || "round") as Shape,
    warmth: p.warmth || 3, talk: p.talk || 3, humour: p.humour || 3,
    scope: (["personal", "finance", "health"].includes(spec.engram_scope || "") ? spec.engram_scope : "personal") as EngramScope, conns: [] as string[], household: false,
  }));
  const conns = useFetch(async () => (S.engram.linked ? (await api.get<{ connections: EngramConnection[] }>("/api/engram/connections")).connections : []), [S.engram.linked]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [review, setReview] = useState<ReturnType<typeof collect> | null>(null);
  const reviewEl = useRef<HTMLDivElement>(null);

  function collect() {
    return {
      name: f.name, job: f.job, hue: f.hue, shape: f.shape, provider: f.provider, model: f.model.trim(), weekly_cap_usd: +f.cap,
      personality: { role: f.role, warmth: f.warmth, talk: f.talk, humour: f.humour, quirks: splitQuirks(f.quirks), signoff: f.signoff, callMe: f.callMe },
      schedule: f.sSpec.trim() ? { spec: f.sSpec.trim(), prompt: f.sPrompt.trim() } : null, reason: spec.reason || "",
      engram_scope: f.scope, engram_connections: f.conns, engram_household: f.household,
    };
  }
  const toReview = () => {
    const s = collect();
    if (!s.name.trim() || !s.job.trim()) return toast("Give them a name and a job", true);
    setReview(s);
    requestAnimationFrame(() => reviewEl.current?.scrollIntoView({ behavior: "smooth" }));
  };
  const hire = async (s: ReturnType<typeof collect>) => {
    if (ps) await api.post(`/api/pitstops/${ps.id}/decide`, { decision: "approve", spec: s });
    else await api.post("/api/hire", s);
    toast(`${s.name} is on the crew`); await refresh(); go("#/");
  };

  return (
    <div className="page">
      <div className="col" style={{ gap: 6 }}>
        <h1 className="pc-h2">{ps ? "The Crew Chief proposes a crew member" : "New crew member"}</h1>
        {ps && spec.reason && <p className="pc-quote">{spec.reason}</p>}
      </div>
      <div className="grid2">
        <div className="pc-card col">
          <div className="row" style={{ gap: 18 }}>
            <Face b={f} size="xl" mood="idle" />
            <div className="col"><p className="pc-lab">Face</p>
              <div className="swatches">{HUES.map((c) => <button key={c} className={`swatch ${c === f.hue ? "on" : ""}`} style={hueStyle(c)} title={c} onClick={() => set("hue", c)} />)}</div>
              <div className="shapes">{SHAPES.map((s) => <button key={s} className={s === f.shape ? "on" : ""} onClick={() => set("shape", s)}><Face b={{ hue: "c1", shape: s }} size="sm" /></button>)}</div>
            </div>
          </div>
          <Field label="Name"><input value={f.name} placeholder="e.g. Bills" onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Job"><textarea value={f.job} placeholder="What this crew member does, in a sentence or two" onChange={(e) => set("job", e.target.value)} /></Field>
          <ModelPicker provider={f.provider} model={f.model} onProvider={(v) => set("provider", v)} onModel={(v) => set("model", v)} />
          <Field label="Weekly cap (USD)"><input type="number" min={0} step="0.5" value={f.cap} onChange={(e) => set("cap", e.target.value)} /></Field>
          <div className="grid2">
            <Field label="Schedule"><input value={f.sSpec} placeholder="Optional: daily 09:00" onChange={(e) => set("sSpec", e.target.value)} /></Field>
            <Field label="Scheduled task"><input value={f.sPrompt} placeholder="What to do on schedule" onChange={(e) => set("sPrompt", e.target.value)} /></Field>
          </div>
          {S.engram.linked && <>
            <Field label="Shared memory" help="Other members read Personal; Money and Health only with a grant you give in the memory app.">
              <select value={f.scope} onChange={(e) => set("scope", e.target.value as EngramScope)}>
                {(Object.keys(SCOPE_LABEL) as EngramScope[]).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
              </select>
            </Field>
            <HouseholdBox checked={f.household} onChange={(v) => set("household", v)} />
            {!!conns.data?.length && <div className="col" style={{ gap: 6 }}>
              <p className="pc-lab">Accounts it can read</p>
              {conns.data.map((c) => (
                <label key={c.id} className="row small" style={{ gap: 8 }}>
                  <input type="checkbox" checked={f.conns.includes(c.id)} disabled={!c.read}
                    onChange={(e) => set("conns", e.target.checked ? [...f.conns, c.id] : f.conns.filter((x) => x !== c.id))} />
                  <span>{c.name}</span><span className="faint">{c.read ? `${c.read} read ${c.read === 1 ? "tool" : "tools"}` : "no read tools"}{c.status !== "ok" ? ` · ${c.detail}` : ""}</span>
                </label>))}
              <p className="small faint">Reading only. Writing and anything else you grant in the memory app, where every write asks you first.</p>
            </div>}
          </>}
        </div>
        <div className="pc-card col">
          <p className="pc-lab">Personality (voice only)</p>
          <Field label="Role line"><input value={f.role} placeholder="Role line, e.g. Unflappable accountant" onChange={(e) => set("role", e.target.value)} /></Field>
          {DIALS.map((k) => (
            <div key={k} className="dial"><span className="muted">{k[0].toUpperCase() + k.slice(1)}</span>
              <input type="range" min={1} max={5} value={f[k]} onChange={(e) => set(k, +e.target.value)} /><span className="pc-m faint">{f[k]}</span></div>))}
          <Field label="Quirks"><input value={f.quirks} placeholder="Up to 3 quirks, separated by ;" onChange={(e) => set("quirks", e.target.value)} /></Field>
          <Field label="Sign-off"><input value={f.signoff} onChange={(e) => set("signoff", e.target.value)} /></Field>
          <Field label="Calls you" help={`Default: ${S.driverName}`}><input value={f.callMe} onChange={(e) => set("callMe", e.target.value)} /></Field>
        </div>
      </div>
      <div className="row"><button className="pc-pill" onClick={toReview}>Review</button></div>
      {review && (
        <div ref={reviewEl} className="pc-card col">
          <p className="pc-lab">Review &amp; hire</p>
          <HireSummary s={review} />
          <p className="small muted">Starts with read, draft and browse allowed. Sign-in, install, send and pay ask first. Delete and share always ask. It gets its own computer, browser profile and network.</p>
          <div className="row">
            <button className="pc-pill" onClick={() => hire(review)}>{`Hire ${review.name}`}</button>
            <button className="pc-pill o" onClick={() => setReview(null)}>Back to edit</button>
            {ps && <button className="pc-pill o" onClick={async () => { await api.post(`/api/pitstops/${ps.id}/decide`, { decision: "deny" }); go("#/"); }}>Decline proposal</button>}
          </div>
        </div>)}
    </div>
  );
}
