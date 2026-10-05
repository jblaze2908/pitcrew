// Member Settings: one column of sections with a pinned list on the left. Everything saves as you change it:
// toggles and choices at once, text when you leave the field.
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { BotCard, BotDetail, Decision, EngramScope, Hue, ProviderId, Shape, SitesView } from "../../../../shared/types";
import { RuleLabel } from "../../components/Approvals";
import { MailboxCard } from "../../components/MailboxCard";
import { ModelPicker } from "../../components/ModelPicker";
import { Sites as SiteList } from "../settings/Sites";
import { ConfirmButton, Face, Seg, hueStyle } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { go } from "../../lib/router";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";

export const DIALS = ["warmth", "talk", "humour"] as const;
export const SCOPE_LABEL: Record<EngramScope, string> = { personal: "Personal", finance: "Money", health: "Health" };
export const splitQuirks = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);
const DIAL_ENDS: Record<(typeof DIALS)[number], [string, string]> = { warmth: ["Dry", "Warm"], talk: ["Brief", "Chatty"], humour: ["Serious", "Playful"] };

/** Hire's checkbox for household facts; member Settings uses a toggle row instead. */
export function HouseholdBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row chk">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="col" style={{ gap: 2 }}><b className="small">Household facts</b><span className="small faint">Reads the household facts in shared memory: addresses, account last-4s, family. Off unless you tick it.</span></span>
    </label>
  );
}

const SECTIONS = [["profile", "Profile"], ["job", "Job and instructions"], ["voice", "Voice"], ["model", "Model and spending"],
  ["permissions", "Permissions"], ["memory", "Memory and privacy"], ["email", "Email"], ["retire", "Retire"]] as const;
type Save = (key: string, patch: Record<string, unknown>) => Promise<void>;

export function ProfileTab({ b, d, section, reload }: { b: BotCard; d: BotDetail; section?: string; reload: () => void }) {
  const { refresh } = useStore();
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // One PATCH per change; the store refresh carries it to the header and sidebar. "Saved" shows by that row for 2 s.
  const save: Save = async (key, patch) => {
    await api.patch(`/api/bots/${b.id}`, patch);
    await refresh();
    setSaved(key); clearTimeout(timer.current); timer.current = setTimeout(() => setSaved(null), 2000);
  };
  const chief = b.kind === "chief";
  const sections = SECTIONS.filter(([k]) => !(chief && k === "retire"));
  const [on, setOn] = useSpy(sections.map(([k]) => k), section);
  const ok = (k: string) => saved === k;
  const p = b.personality || {};

  return (
    <div className="set">
      <nav className="sn">{sections.map(([k, l]) => <a key={k} href={`#/crew/${b.id}/settings/${k}`} className={on === k ? "on" : ""} onClick={(e) => { e.preventDefault(); setOn(k); document.getElementById(`ms-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{l}</a>)}</nav>
      <div className="sc">
        <p className="intro">Changes save as you make them. New threads use them; a running computer picks them up when it next starts.</p>

        <Section id="profile" title="Profile">
          <Row label="Face" help="Shows everywhere this member appears." saved={ok("face")}><FacePicker b={b} save={save} /></Row>
          <Row label="Name" help={chief ? "The Crew Chief keeps its name." : undefined} saved={ok("name")}><Text aria-label="Name" value={b.name} disabled={chief} onSave={(v) => v.trim() && save("name", { name: v.trim() })} /></Row>
          <Row label="Role line" help="One line, shown under its name." saved={ok("role")}><Text aria-label="Role line" value={p.role || ""} placeholder="Calm race engineer. Facts first." onSave={(v) => save("role", { personality: { role: v } })} /></Row>
        </Section>

        <Section id="job" title="Job and instructions" intro="The job says what it's for. Instructions say how it works. Most members only need a job.">
          <Block label="Job" help="Two or three sentences. The Crew Chief and New thread read it to decide who takes a message." saved={ok("job")}>
            <Area aria-label="Job" value={b.job} max={400} rows={4} onSave={(v) => save("job", { job: v })} />
          </Block>
          <Block label="Instructions" help="Read at the start of each of its own threads. When filled, they replace the job and voice settings there. Keep them short: they're paid for on every turn." saved={ok("soul")}>
            <Area aria-label="Instructions" value={b.soul || ""} max={1500} rows={6} placeholder={"Who it is and how it works. For example:\nYou track grocery spending. Be brief: numbers first.\nDaily runs stay quiet unless something changed.\n\nLeave empty to use the job and voice settings."} onSave={(v) => save("soul", { soul: v })} />
          </Block>
        </Section>

        <Section id="voice" title="Voice" intro="How it sounds, nothing more. Voice never changes permissions, spending or the safety check, and pit stops and money are always plain.">
          {DIALS.map((k) => <Row key={k} label={k[0].toUpperCase() + k.slice(1)} saved={ok(k)}><Dial value={p[k] || 3} ends={DIAL_ENDS[k]} label={k} onSave={(v) => save(k, { personality: { [k]: v } })} /></Row>)}
          <Block label="Quirks" help="Up to three habits it keeps." saved={ok("quirks")}><Quirks list={p.quirks || []} onSave={(q) => save("quirks", { personality: { quirks: q } })} /></Block>
          <Row label="Calls you" saved={ok("callMe")}><Text aria-label="Calls you" value={p.callMe || ""} placeholder="Your name" onSave={(v) => save("callMe", { personality: { callMe: v } })} /></Row>
          <Row label="Sign-off" help="Optional. Added to the end of longer replies." saved={ok("signoff")}><Text aria-label="Sign-off" value={p.signoff || ""} placeholder="None" onSave={(v) => save("signoff", { personality: { signoff: v } })} /></Row>
          <Row label="Plain voice" help="Drops the personality and writes plainly." saved={ok("plain")}><Toggle on={!!p.plain} label="Plain voice" onChange={(v) => save("plain", { personality: { plain: v } })} /></Row>
        </Section>

        <Section id="model" title="Model and spending">
          <Block label="Model" help="Set up providers in Settings, Models." saved={ok("model")}><Model b={b} save={save} /></Block>
          <Row label="Weekly cap" help="New runs stop once this week's estimate reaches it." saved={ok("cap")}>
            <span className="cap"><span className="faint">$</span><Text aria-label="Weekly cap in dollars" type="number" min={0} step="0.5" value={String(b.weekly_cap_usd)} onSave={(v) => v !== "" && +v >= 0 && save("cap", { weekly_cap_usd: +v })} /></span>
          </Row>
        </Section>

        <Section id="permissions" title="Permissions" intro={`What ${b.name} may do without asking. The thread's mode and the crew-wide rules in Settings still apply.`}>
          <Permissions b={b} />
          <Block label="Rules" help="One per line. A “never” rule stops the action even in YOLO. A “fine to” rule saves a pit stop, though paying and signing in still ask." saved={ok("rules")}>
            <Area aria-label="Rules" value={b.house_rules || ""} rows={3} placeholder={"Never place, change or cancel orders.\nFine to download my own statements."} onSave={(v) => save("rules", { house_rules: v })} />
          </Block>
          <Sites b={b} />
          <Learned d={d} reload={reload} />
        </Section>

        <Section id="memory" title="Memory and privacy"><Privacy b={b} save={save} ok={ok} /></Section>

        <Section id="email" title="Email" intro={`Forward or CC a bill to this address and ${b.name} wakes on its own. Mail from your own addresses always wakes it.`}><Email b={b} /></Section>

        {!chief && <Section id="retire" title={`Retire ${b.name}`} danger>
          <Row label="Retire this member" help="It leaves the crew and its schedules stop. Its threads stay readable.">
            <ConfirmButton className="pc-pill o s retire" ask="Retire?" onConfirm={async () => { await api.post(`/api/bots/${b.id}/archive`); toast(`${b.name} retired`); await refresh(); go("#/"); }}>Retire</ConfirmButton>
          </Row>
        </Section>}
      </div>
    </div>
  );
}

/** The section in view, for the pinned list; a deep link (settings/<section>) scrolls there first. */
function useSpy(ids: string[], first?: string) {
  const [on, setOn] = useState(first && ids.includes(first) ? first : ids[0]);
  useEffect(() => {
    if (first && ids.includes(first)) document.getElementById(`ms-${first}`)?.scrollIntoView({ block: "start" });
    // Per scroll event: eight rect reads. The last section whose heading has passed 140px wins; at the bottom, the last one.
    const pick = (e: Event) => {
      const box = e.target instanceof HTMLElement ? e.target : document.scrollingElement;
      if (!box?.contains(document.getElementById(`ms-${ids[0]}`))) return;
      let cur = ids[0];
      for (const k of ids) if ((document.getElementById(`ms-${k}`)?.getBoundingClientRect().top ?? Infinity) <= 140) cur = k;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) cur = ids[ids.length - 1];
      setOn(cur);
    };
    document.addEventListener("scroll", pick, true);
    return () => document.removeEventListener("scroll", pick, true);
  }, [first, ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return [on, setOn] as const;
}

function Section({ id, title, intro, danger, children }: { id: string; title: string; intro?: string; danger?: boolean; children: ReactNode }) {
  return (
    <section id={`ms-${id}`} className={danger ? "danger" : ""}>
      <h3>{title}</h3>{intro && <p className="intro">{intro}</p>}
      <div className="ms-rows">{children}</div>
    </section>
  );
}
const Saved = ({ on }: { on?: boolean }) => (on ? <span className="saved">Saved</span> : null);
function Row({ label, help, saved, children }: { label: string; help?: string; saved?: boolean; children: ReactNode }) {
  return <div className="ms-r"><div><p className="ms-l">{label}</p>{help && <p className="ms-h">{help}</p>}</div><div className="ctl"><Saved on={saved} />{children}</div></div>;
}
/** A full-width row for long text and lists. */
function Block({ label, help, saved, children }: { label: string; help?: string; saved?: boolean; children: ReactNode }) {
  return <div className="br"><div className="brh"><p className="ms-l">{label}</p><Saved on={saved} /></div>{help && <p className="ms-h">{help}</p>}{children}</div>;
}

/** An input that saves when you leave it, and only if it changed. */
function Text({ value, onSave, ...rest }: { value: string; onSave: (v: string) => unknown } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input {...rest} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}
function Area({ value, max, onSave, ...rest }: { value: string; max?: number; onSave: (v: string) => unknown } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <>
    <textarea {...rest} value={v} maxLength={max} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
    {max && <p className="cnt">{`${v.length.toLocaleString("en-IN")} / ${max.toLocaleString("en-IN")}`}</p>}
  </>;
}
function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`tg${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}
/** A 1–5 slider with words at each end; saves 400 ms after the last move. */
function Dial({ value, ends, label, onSave }: { value: number; ends: [string, string]; label: string; onSave: (v: number) => void }) {
  const [v, setV] = useState(value);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const move = (n: number) => { setV(n); clearTimeout(t.current); t.current = setTimeout(() => n !== value && onSave(n), 400); };
  return <span className="sl"><span>{ends[0]}</span><input type="range" min={1} max={5} value={v} aria-label={label} onChange={(e) => move(+e.target.value)} /><span>{ends[1]}</span></span>;
}

const HUES: Hue[] = ["c1", "c2", "c3", "c5", "c6"];
const SHAPES: Shape[] = ["square", "round", "blob"];
function FacePicker({ b, save }: { b: BotCard; save: Save }) {
  return (
    <span className="face">
      <span className="sw">{HUES.map((c) => <button key={c} className={c === b.hue ? "on" : ""} style={hueStyle(c)} aria-label={`Colour ${c}`} aria-pressed={c === b.hue} onClick={() => save("face", { hue: c })} />)}</span>
      <span className="shp">{SHAPES.map((sh) => <button key={sh} className={sh === b.shape ? "on" : ""} aria-label={`Shape ${sh}`} aria-pressed={sh === b.shape} onClick={() => save("face", { shape: sh })}><Face b={{ hue: b.hue, shape: sh }} size="sm" /></button>)}</span>
    </span>
  );
}

// A new provider clears the model; nothing saves until a model is picked for it.
function Model({ b, save }: { b: BotCard; save: Save }) {
  const [prov, setProv] = useState<ProviderId>(b.provider), [model, setModel] = useState(b.model);
  return <ModelPicker provider={prov} model={model} onProvider={setProv} onModel={(m) => { setModel(m); if (m.trim()) save("model", { provider: prov, model: m.trim() }); }} />;
}

function Quirks({ list, onSave }: { list: string[]; onSave: (q: string[]) => void }) {
  const [add, setAdd] = useState("");
  const put = () => { const q = add.trim(); if (!q) return; onSave([...list, q].slice(0, 3)); setAdd(""); };
  return (
    <div className="quirks">
      {list.map((q, i) => <div key={i} className="q"><span>{q}</span><button className="lk2" onClick={() => onSave(list.filter((_, j) => j !== i))}>Remove</button></div>)}
      {list.length < 3 && <input className="q add" placeholder="Add a quirk" maxLength={120} value={add} onChange={(e) => setAdd(e.target.value)} onBlur={put} onKeyDown={(e) => { if (e.key === "Enter") put(); }} />}
    </div>
  );
}

// Plain-language effects in rising order of consequence. The last three can't be allowed.
const EFFECTS: [string, string][] = [["read", "Look at files and data"], ["browse", "Open and read web pages"], ["draft", "Fill in forms and write drafts, without sending"],
  ["write_workspace", "Create and edit files in its own workspace"], ["signin", "Sign in, or enter passwords and one-time codes"], ["install", "Install software"],
  ["send", "Send messages, post or submit forms"], ["exec_untrusted", "Run downloaded or unknown code"], ["delete", "Delete things outside its workspace"],
  ["share", "Send your private data somewhere new"], ["pay", "Spend money"]];
const LOCKED = ["delete", "share", "pay"];

function Permissions({ b }: { b: BotCard }) {
  const [policy, setPolicy] = useState<Record<string, Decision>>(b.policy);
  const known = new Set(EFFECTS.map(([k]) => k));
  const rows = [...EFFECTS.filter(([k]) => k in policy), ...Object.keys(policy).filter((k) => !known.has(k)).map((k): [string, string] => [k, k.replace(/_/g, " ")])];
  const change = async (k: string, v: Decision) => {
    if (policy[k] === v) return;
    await api.patch(`/api/bots/${b.id}`, { policy: { [k]: v } });
    setPolicy((p) => ({ ...p, [k]: v }));
  };
  return <>{rows.map(([k, what]) => (
    <div key={k} className="ps"><span>{what}</span>
      {LOCKED.includes(k) ? <span className="lock">Always asks</span>
        : <Seg options={[["allow", "Allow"], ["ask", "Ask"]] as const} value={policy[k] === "allow" ? "allow" : "ask"} onChange={(v) => change(k, v)} />}
    </div>))}</>;
}

const MODE: Record<string, string> = { allowed: "member's rules", read: "read only", blocked: "blocked" };
function Sites({ b }: { b: BotCard }) {
  const [edit, setEdit] = useState(false);
  const f = useFetch(() => api.get<SitesView>(`/api/sites?scope=${encodeURIComponent(b.id)}`, { quiet: true }), [b.id, edit], { keep: true });
  const list = f.data?.sites || [];
  return (
    <div className="br">
      <div className="brh"><p className="ms-l">Its own sites</p><button className="lk2" onClick={() => setEdit(!edit)}>{edit ? "Done" : "Edit sites"}</button></div>
      <p className="ms-h">{list.length ? list.map((s) => `${s.domain}, ${MODE[s.mode] || s.mode}`).join(" · ") : "None of its own. It follows the crew-wide list in Settings."}</p>
      {edit && <div className="ms-sites"><SiteList scope={b.id} intro="These win over the crew-wide list, except a crew-wide block." /></div>}
    </div>
  );
}

// Standing approvals for this member and the patterns it learned from your approvals, in one list.
function Learned({ d, reload }: { d: BotDetail; reload: () => void }) {
  const none = !d.rules.length && !d.learned.length;
  return (
    <div className="br">
      <div className="brh"><p className="ms-l">Approvals it has learned</p></div>
      <p className="ms-h">{none ? "Nothing yet. Approve the same kind of action twice in a row and it stops asking, unless it signs in, installs, sends, pays, deletes or shares." : "The crew-wide list is under Pit stops."}</p>
      {!none && <div className="lrn">
        {d.rules.map((r) => (
          <div key={r.id} className="lr"><div><p><RuleLabel label={r.label} /></p><p className="ms-h">{`Always allowed · since ${when(r.created_at)}`}</p></div>
            <button className="lk2" onClick={async () => { await api.post(`/api/rules/${r.id}/revoke`); toast("Revoked"); reload(); }}>Revoke</button></div>))}
        {d.learned.map((l) => {
          const done = l.streak >= l.need;
          return (
            <div key={l.id} className="lr"><div><p>{l.label}</p><p className="ms-h">{done ? "No longer asks" : `Approved ${l.streak} of ${l.need} times in a row`}</p></div>
              {done && <button className="lk2" onClick={async () => { await api.post(`/api/learned/${l.id}/reset`); toast("It will ask again"); reload(); }}>Ask again</button>}</div>);
        })}
      </div>}
    </div>
  );
}

function Privacy({ b, save, ok }: { b: BotCard; save: Save; ok: (k: string) => boolean }) {
  const { S } = useStore();
  const chief = b.kind === "chief";
  return <>
    {!chief && <Row label="Private" help="Only you talk to it. The Crew Chief can't ask it anything, so nothing it knows reaches other members." saved={ok("private")}>
      <Toggle on={!!b.private} label="Private" onChange={(v) => save("private", { private: v })} /></Row>}
    <Row label="Its shared memories go under" saved={ok("scope")}
      help={b.private && b.engram_scope === "personal" ? "A private member stays out of shared memory until its memories go under Money or Health, which other members can't read." : "Other members read Personal. Money and Health need a grant you give in shared memory."}>
      <Seg options={(Object.keys(SCOPE_LABEL) as EngramScope[]).map((k) => [k, SCOPE_LABEL[k]] as const)} value={b.engram_scope} onChange={(v) => save("scope", { engram_scope: v })} />
    </Row>
    {S.engram.linked && <Row label="Household facts" help="Lets it read addresses, family details and account last digits from shared memory." saved={ok("household")}>
      <Toggle on={!!b.engram_household} label="Household facts" onChange={(v) => save("household", { engram_household: v })} /></Row>}
  </>;
}

function Email({ b }: { b: BotCard }) {
  const f = useFetch(() => api.get<{ domain: string }>("/api/mail", { quiet: true }), []);
  if (f.error) return <p className="ms-h">{`Couldn't load email settings: ${f.error}`}</p>;
  return f.data ? <div className="mailbox"><MailboxCard botId={b.id} name={b.name} domain={f.data.domain} onSaved={() => {}} /></div> : null;
}
