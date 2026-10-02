// Who a member is (saved with one button) and what it may do without asking (each toggle saves on its own).
import { useState } from "react";
import type { BotCard, Decision, EngramScope } from "../../../../shared/types";
import { ModelPicker } from "../../components/ModelPicker";
import { ConfirmButton, Field } from "../../components/ui";
import { api } from "../../lib/api";
import { go } from "../../lib/router";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";

export const DIALS = ["warmth", "talk", "humour"] as const;
export const SCOPE_LABEL: Record<EngramScope, string> = { personal: "Personal", finance: "Money", health: "Health" };
export const splitQuirks = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);

export function ProfileTab({ b }: { b: BotCard }) {
  const { S, refresh } = useStore();
  const p = b.personality || {};
  const [f, setF] = useState({
    name: b.name, job: b.job, role: p.role || "", quirks: (p.quirks || []).join("; "), signoff: p.signoff || "", callMe: p.callMe || "",
    cap: String(b.weekly_cap_usd), plain: !!p.plain, priv: !!b.private, scope: b.engram_scope, household: !!b.engram_household, provider: b.provider as string, model: b.model,
    warmth: p.warmth || 3, talk: p.talk || 3, humour: p.humour || 3,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    await api.patch(`/api/bots/${b.id}`, {
      name: f.name, job: f.job, weekly_cap_usd: +f.cap, provider: f.provider, model: f.model.trim(), private: f.priv, engram_scope: f.scope, engram_household: f.household,
      personality: { role: f.role, quirks: splitQuirks(f.quirks), signoff: f.signoff, callMe: f.callMe, plain: f.plain, warmth: f.warmth, talk: f.talk, humour: f.humour },
    });
    toast("Saved. New threads use it; running computers pick it up at next start.");
    await refresh();
  };
  const chief = b.kind === "chief";
  return (
    <div className="grid2">
      <div className="pc-card col">
        <p className="pc-lab">Who</p>
        <Field label="Name"><input value={f.name} disabled={chief} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Job"><textarea value={f.job} onChange={(e) => set("job", e.target.value)} /></Field>
        <Field label="Weekly cap (USD)" help="The runtime refuses new runs once this week's estimate reaches the cap."><input type="number" min={0} step="0.5" value={f.cap} onChange={(e) => set("cap", e.target.value)} /></Field>
        <ModelPicker provider={f.provider} model={f.model} onProvider={(v) => set("provider", v)} onModel={(v) => set("model", v)} />
        {!chief && (
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={f.priv} onChange={(e) => set("priv", e.target.checked)} />
            <span className="col" style={{ gap: 2 }}><b className="small">Private</b><span className="small faint">Only you talk to it. The Crew Chief can't ask it anything, so nothing it knows reaches other members.</span></span>
          </label>)}
        <Field label="Memories in Engram" help={f.priv && f.scope === "personal" ? "A private member stays out of Engram until its memories go under Money or Health, which other members can't read." : "Other members read Personal; Money and Health only with a grant you give in Engram."}>
          <select value={f.scope} onChange={(e) => set("scope", e.target.value as EngramScope)}>
            {(Object.keys(SCOPE_LABEL) as EngramScope[]).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
          </select>
        </Field>
        {S.engram.linked && <HouseholdBox checked={f.household} onChange={(v) => set("household", v)} />}
        {!chief && <ConfirmButton className="pc-pill o s" ask="Retire?" onConfirm={async () => { await api.post(`/api/bots/${b.id}/archive`); toast(`${b.name} retired`); await refresh(); go("#/"); }}>Retire crew member</ConfirmButton>}
      </div>
      <div className="pc-card col">
        <p className="pc-lab">Personality (voice only)</p>
        <Field label="Role line"><input value={f.role} placeholder="e.g. Calm race engineer. Facts first." onChange={(e) => set("role", e.target.value)} /></Field>
        {DIALS.map((k) => (
          <div key={k} className="dial"><span className="muted">{k[0].toUpperCase() + k.slice(1)}</span>
            <input type="range" min={1} max={5} value={f[k]} onChange={(e) => set(k, +e.target.value)} /><span className="pc-m faint">{f[k]}</span></div>))}
        <Field label="Quirks"><input value={f.quirks} placeholder="Up to 3, separated by ;" onChange={(e) => set("quirks", e.target.value)} /></Field>
        <Field label="Sign-off"><input value={f.signoff} onChange={(e) => set("signoff", e.target.value)} /></Field>
        <Field label="Calls you"><input value={f.callMe} onChange={(e) => set("callMe", e.target.value)} /></Field>
        <label className="row small"><input type="checkbox" checked={f.plain} onChange={(e) => set("plain", e.target.checked)} />Plain voice</label>
        <p className="small faint">Personality never changes permissions, caps or jev. Pit stops and money always use a plain voice.</p>
      </div>
      <Permissions b={b} />
      <div className="row formbar"><button className="pc-pill" onClick={save}>Save profile</button><span className="small faint">Permissions save as you change them.</span></div>
    </div>
  );
}

// Plain-language effects, in rising order of consequence. Each toggle saves on its own: there's no half-edited policy.
export function HouseholdBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="col" style={{ gap: 2 }}><b className="small">Household facts</b><span className="small faint">Reads Engram's household facts: addresses, account last-4s, family. Off unless you tick it.</span></span>
    </label>
  );
}

const EFFECTS: [string, string][] = [["read", "Look at files and data"], ["browse", "Open and read web pages"], ["draft", "Fill in forms and write drafts, without sending"],
  ["write_workspace", "Create and edit files in its own workspace"], ["signin", "Log in, or enter passwords and one-time codes"], ["install", "Install software"],
  ["send", "Send messages, post, or submit forms"], ["exec_untrusted", "Run downloaded or unknown code"], ["delete", "Delete things outside its workspace"],
  ["share", "Send your private data somewhere new"], ["pay", "Spend money"]];
const LOCKED = ["delete", "share", "pay"];

function Permissions({ b }: { b: BotCard }) {
  const [policy, setPolicy] = useState<Record<string, Decision>>(b.policy);
  const known = new Set(EFFECTS.map(([k]) => k));
  const rows = [...EFFECTS.filter(([k]) => k in policy), ...Object.keys(policy).filter((k) => !known.has(k)).map((k): [string, string] => [k, k.replace(/_/g, " ")])];
  const change = async (k: string, what: string, v: Decision) => {
    if (policy[k] === v) return;
    await api.patch(`/api/bots/${b.id}`, { policy: { [k]: v } });
    setPolicy((p) => ({ ...p, [k]: v }));
    toast(`${what}: ${v === "allow" ? "no need to ask" : "asks you first"}`);
  };
  return (
    <div className="pc-card col">
      <p className="pc-lab">{`What ${b.name} may do without asking`}</p>
      <div className="perms">{rows.map(([k, what]) => (
        <div key={k} className="perm">
          <pc-effect kind={k}>{k.replace(/_/g, " ")}</pc-effect><span className="what">{what}</span>
          {LOCKED.includes(k) ? <span className="lock small faint" title="Can't be changed">Always asks</span>
            : <div className="seg">{(["allow", "ask"] as const).map((v) => <button key={v} className={policy[k] === v ? "on" : ""} onClick={() => change(k, what, v)}>{v === "allow" ? "Allow" : "Ask"}</button>)}</div>}
        </div>))}
      </div>
      <p className="small faint">Spending money, deleting outside the workspace and sharing private data always ask. <a href={`#/crew/${b.id}/sites`} style={{ textDecoration: "underline" }}>Per-site rules</a> can tighten this further.</p>
    </div>
  );
}
