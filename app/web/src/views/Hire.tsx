// Hiring: a blank form, or the Crew Chief's proposal (a hire pit stop) to review. Nothing joins without your click.
// The preview card is a fixed template over the form's values: no model call per keystroke.
import { useState, type KeyboardEvent } from "react";
import type { EngramConnection, EngramScope, Hue, PitStop, Shape } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { ModelPicker } from "../components/ModelPicker";
import type { HireSpec } from "../components/PitCard";
import { Face, Field, hueStyle } from "../components/ui";
import { api } from "../lib/api";
import { cap } from "../lib/format";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { HouseholdBox, SCOPE_LABEL } from "./crew/ProfileTab";
import { specWords } from "./Schedules";

const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
const SHAPES: Shape[] = ["square", "round", "blob"];
const HUE_NAME: Record<Hue, string> = { c1: "Blue", c2: "Teal", c3: "Green", c5: "Pink", c6: "Violet" };
const DIALS = [["warmth", "Warmth", "Reserved", "Warm"], ["talk", "Talk", "Brief", "Chatty"], ["humour", "Humour", "Dry", "Playful"]] as const;
const MAX_HABITS = 3;

export function Hire({ psId }: { psId?: string }) {
  const proposal = useFetch(async () => ({ ps: psId ? (await api.get<PitStop[]>("/api/pitstops?status=pending")).find((p) => p.id === psId) ?? null : null }), [psId]);
  if (!proposal.data) return proposal.error ? <div className="page"><p className="badc">{proposal.error}</p></div> : null;
  if (psId && !proposal.data.ps) return <div className="page"><p className="muted">That proposal was already decided.</p><a className="pc-pill s" href="#/pitstops">Needs you</a></div>;
  return <HireForm ps={proposal.data.ps} />;
}

/** "How they'll sound": one sample reply assembled from the dials, the name you're called and the sign-off. */
function sample(f: { warmth: number; talk: number; humour: number; callMe: string; signoff: string }, driver: string) {
  const you = f.callMe.trim() || driver;
  const hello = f.warmth >= 4 ? `Hi ${you}! ` : f.warmth === 3 ? `${you}, ` : "";
  const body = f.talk <= 2 ? "done. The details are in the thread." : f.talk === 3 ? "that's done. I checked everything and put the details in the thread."
    : "that's all done. I went through everything carefully, checked the numbers twice and put the full details in the thread for you.";
  const joke = f.humour >= 4 ? " No surprises this time, which is its own kind of surprise." : "";
  const text = `${hello}${hello.endsWith(", ") ? body : cap(body)}${joke}`;
  return f.signoff.trim() ? `${text} ${f.signoff.trim()}` : text;
}

function HireForm({ ps }: { ps: PitStop | null }) {
  const { S, refresh } = useStore();
  const spec = (ps?.detail.spec || {}) as HireSpec & Record<string, any>;
  const p = spec.personality || {};
  // A new face defaults to the first colour and shape no one has, so members don't look alike.
  const free = SHAPES.flatMap((sh) => HUES.map((h) => [h, sh] as const)).find(([h, sh]) => !S.bots.some((b) => b.hue === h && b.shape === sh));
  const [f, setF] = useState(() => ({
    name: spec.name || "", job: spec.job || "", role: p.role || "", habits: (p.quirks || []) as string[], signoff: p.signoff || "", callMe: p.callMe || "",
    cap: String(spec.weekly_cap_usd ?? 5), provider: (spec.provider || S.defaultProvider) as string, model: spec.model || "",
    hue: (spec.hue || free?.[0] || "c1") as Hue, shape: (spec.shape || free?.[1] || "round") as Shape,
    warmth: p.warmth || 3, talk: p.talk || 3, humour: p.humour || 2,
    scope: (["personal", "finance", "health"].includes(spec.engram_scope || "") ? spec.engram_scope : "personal") as EngramScope, conns: [] as string[], household: false,
  }));
  const [habit, setHabit] = useState("");
  const conns = useFetch(async () => (S.engram.linked ? (await api.get<{ connections: EngramConnection[] }>("/api/engram/connections")).connections : []), [S.engram.linked]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const name = f.name.trim() || "them";
  const provider = S.providers[f.provider as keyof typeof S.providers];
  const picked = (conns.data || []).filter((c) => f.conns.includes(c.id));
  const signedOut = picked.filter((c) => c.status !== "ok");

  const addHabit = () => { const h = habit.trim(); if (!h || f.habits.length >= MAX_HABITS) return; set("habits", [...f.habits, h.slice(0, 120)]); setHabit(""); };
  const habitKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); addHabit(); } };
  const hire = async () => {
    if (!f.name.trim() || !f.job.trim()) return toast("Give them a name and a job", true);
    const s = {
      name: f.name.trim(), job: f.job.trim(), hue: f.hue, shape: f.shape, provider: f.provider, model: f.model.trim(), weekly_cap_usd: +f.cap || 0,
      personality: { role: f.role, warmth: f.warmth, talk: f.talk, humour: f.humour, quirks: f.habits, signoff: f.signoff, callMe: f.callMe },
      // A proposal's schedule rides along unchanged; a blank hire gets its schedules on the Schedules page.
      schedule: spec.schedule?.spec ? spec.schedule : null, reason: spec.reason || "",
      engram_scope: f.scope, engram_connections: f.conns, engram_household: f.household,
    };
    if (ps) { await api.post(`/api/pitstops/${ps.id}/decide`, { decision: "approve", spec: s }); toast(`${s.name} is on the crew`); await refresh(); go("#/crew"); return; }
    const bot = await api.post<{ id: string }>("/api/hire", s);
    toast(`${s.name} is on the crew`); await refresh(); go(`#/crew/${bot.id}`);
  };
  const decline = async () => { await api.post(`/api/pitstops/${ps!.id}/decide`, { decision: "deny" }); go("#/pitstops"); };

  return (
    <div className="page hire2">
      <div className="col" style={{ gap: 6 }}>
        <a className="small faint" href="#/crew">Crew ›</a>
        <h1 className="lib-h1">{ps ? "The Crew Chief suggests a new member" : "Hire a member"}</h1>
        <p className="lib-sub">{ps && spec.reason ? spec.reason : "Give them a job and say what they can read. You can change any of this later."}</p>
      </div>
      <div className="hire2-cols">
        <div className="col hire2-form">
          <section className="hire2-sec">
            <h2>Who they are</h2>
            <div className="hire2-face">
              <Face b={f} size="xl" mood="idle" />
              <div className="col" style={{ gap: 12 }}>
                <div className="col" style={{ gap: 6 }}><span className="lib-lab">Colour</span>
                  <div className="hire2-pick">{HUES.map((c) => <button key={c} className={`hire2-dot${c === f.hue ? " on" : ""}`} style={hueStyle(c)} title={HUE_NAME[c]} aria-label={HUE_NAME[c]} aria-pressed={c === f.hue} onClick={() => set("hue", c)} />)}</div></div>
                <div className="col" style={{ gap: 6 }}><span className="lib-lab">Shape</span>
                  <div className="hire2-pick">{SHAPES.map((sh) => <button key={sh} className={`hire2-shape${sh === f.shape ? " on" : ""}`} aria-label={sh} aria-pressed={sh === f.shape} onClick={() => set("shape", sh)}><Face b={{ hue: f.hue, shape: sh }} size="sm" /></button>)}</div></div>
              </div>
            </div>
            <Field label="Name"><input value={f.name} maxLength={40} placeholder="Bills" onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Job" help="A sentence or two, written to them. This is what they work from every time."><textarea rows={3} maxLength={400} value={f.job} placeholder="Fetch e-bills from my email and pay them when they're under my limit. Ask me before anything over ₹5,000." onChange={(e) => set("job", e.target.value)} /></Field>
          </section>

          <section className="hire2-sec">
            <h2>Model and budget</h2>
            <ModelPicker provider={f.provider} model={f.model} onProvider={(v) => set("provider", v)} onModel={(v) => set("model", v)} />
            <Field label="Weekly limit" help="When they reach it, their runs stop until next week or until you raise it.">
              <label className="hire2-money"><span className="faint">$</span><input type="number" min={0} max={500} step="0.5" value={f.cap} onChange={(e) => set("cap", e.target.value)} aria-label="Weekly limit in dollars" /><span className="faint">per week</span></label>
            </Field>
          </section>

          <section className="hire2-sec">
            <h2>What they can read</h2>
            <p className="small muted">Reading, drafting and browsing are allowed. Signing in, installing, sending and paying ask you first; deleting and sharing always do. They get their own computer and browser.</p>
            {S.engram.linked ? <>
              {conns.error && <p className="small badc">{`Couldn't load your accounts: ${conns.error}`}</p>}
              {!!conns.data?.length && <div className="hire2-acc">{conns.data.map((c) => (
                <label key={c.id} className={`hire2-accrow${c.read ? "" : " off"}`}>
                  <input type="checkbox" checked={f.conns.includes(c.id)} disabled={!c.read} onChange={(e) => set("conns", e.target.checked ? [...f.conns, c.id] : f.conns.filter((x) => x !== c.id))} />
                  <span className="col" style={{ gap: 1 }}><b className="small">{c.name}</b><span className="small faint">{c.read ? "Read only" : "Nothing they can read here yet"}</span></span>
                  {c.status !== "ok" && <span className="small hire2-warn">{c.detail || "Needs attention"}</span>}
                </label>))}</div>}
              <Field label="Memories they can use" help="Other members read Personal. Money and Health need your OK first.">
                <select value={f.scope} onChange={(e) => set("scope", e.target.value as EngramScope)} className="hire2-narrow">
                  {(Object.keys(SCOPE_LABEL) as EngramScope[]).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
                </select>
              </Field>
              <HouseholdBox checked={f.household} onChange={(v) => set("household", v)} />
            </> : <p className="small faint">Link your accounts in Settings to let members read your mail, calendar or bank.</p>}
          </section>

          <section className="hire2-sec">
            <h2>Personality <span className="small faint">optional, only changes how they sound</span></h2>
            <Field label="In a few words"><input value={f.role} maxLength={160} placeholder="Unflappable accountant" onChange={(e) => set("role", e.target.value)} /></Field>
            <div className="hire2-dials">{DIALS.map(([k, label, lo, hi]) => (
              <div key={k} className="hire2-dial"><span>{label}</span><span className="faint small">{lo}</span>
                <input type="range" min={1} max={5} value={f[k]} onChange={(e) => set(k, +e.target.value)} aria-label={label} /><span className="faint small">{hi}</span></div>))}</div>
            <Field label="Habits">
              <div className="hire2-habits">
                {f.habits.map((h, i) => <span key={i} className="hire2-chip">{h}<button aria-label={`Remove ${h}`} onClick={() => set("habits", f.habits.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button></span>)}
                {f.habits.length < MAX_HABITS && <input value={habit} placeholder="Add a habit" maxLength={120} onChange={(e) => setHabit(e.target.value)} onKeyDown={habitKey} onBlur={addHabit} />}
              </div>
            </Field>
            <div className="grid2">
              <Field label="Calls you"><input value={f.callMe} maxLength={40} placeholder={S.driverName} onChange={(e) => set("callMe", e.target.value)} /></Field>
              <Field label="Signs off"><input value={f.signoff} maxLength={60} placeholder="Nothing" onChange={(e) => set("signoff", e.target.value)} /></Field>
            </div>
          </section>
        </div>

        <aside className="hire2-preview">
          <Face b={f} size="lg" mood="idle" />
          <h3>{f.name.trim() || "New member"}</h3>
          <p className="small muted">{f.job.trim() || "Their job shows here."}</p>
          <div className="hire2-sound"><span className="small faint">How they'll sound</span><p>{sample(f, S.driverName)}</p></div>
          <ul className="hire2-facts small">
            <li><Icon name="spark" size={14} />{`Works on ${f.model || "the default model"}${provider ? ` with ${provider.label}` : ""}`}</li>
            <li><Icon name="chart" size={14} />{`Spends up to $${+f.cap || 0} a week`}</li>
            {picked.length > 0 && <li><Icon name="search" size={14} />{`Reads ${picked.map((c) => c.name).join(", ")}`}</li>}
            {S.engram.linked && <li><Icon name="pin" size={14} />{`Uses your ${SCOPE_LABEL[f.scope]} memories`}</li>}
          </ul>
          <p className="small faint">{spec.schedule?.spec ? `Starts with a schedule: ${specWords(spec.schedule.spec).toLowerCase()}, ${String(spec.schedule.prompt || "").split("\n")[0].slice(0, 80)}`
            : `After hiring, you can give ${name} a schedule, like a check every morning.`}</p>
        </aside>
      </div>

      <div className="hire2-foot">
        <p className="small muted">{signedOut.length ? `${signedOut.map((c) => c.name).join(" and ")} ${signedOut.length === 1 ? "needs" : "need"} attention. ${name === "them" ? "They" : name} can still be hired and will ask you to reconnect when it matters.` : ps ? "Nothing joins the crew until you hire them." : ""}</p>
        <span style={{ flex: 1 }} />
        {ps && <button className="pc-pill o s" onClick={decline}>Decline</button>}
        <a className="pc-pill o s" href={ps ? "#/pitstops" : "#/crew"}>Cancel</a>
        <button className="pc-pill s" onClick={hire}>{f.name.trim() ? `Hire ${f.name.trim()}` : "Hire"}</button>
      </div>
    </div>
  );
}
