// Settings: general, model providers and keys, the Engram link, crew-wide sites, the vault, safety (the kill switch), account.
import { useEffect, useState } from "react";
import type { ProviderId, ProviderStatus, State } from "../../../shared/types";
import { EngramSettings } from "../components/Engram";
import { SitesEditor } from "../components/SitesEditor";
import { VaultSettings } from "../components/Vault";
import { BusyButton, ConfirmButton, Field, Loader, Seg } from "../components/ui";
import { api } from "../lib/api";
import { when } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

type Providers = Record<ProviderId, ProviderStatus>;
const TAB_IDS = ["general", "models", "phone", "email", "engram", "sites", "vault", "safety", "account"] as const;

export function Settings({ tab: asked, item }: { tab: string; item?: string }) {
  const { S } = useStore();
  const prov = useFetch(() => api.get<Providers>("/api/providers"), []);
  if (prov.error && !prov.data) return <div className="page"><p className="badc">{prov.error}</p></div>;
  if (!prov.data) return null;
  const p = prov.data;
  const tab = (TAB_IDS as readonly string[]).includes(asked) ? asked : "general";
  const anyKey = Object.values(p).some((x) => x.connected);
  const tabs: [string, string, boolean][] = [["general", "General", false], ["models", "Models and keys", !anyKey], ["phone", "Phone", false], ["email", "Email", false], ["engram", "Engram", false], ["sites", "Sites", false], ["vault", "Vault", false], ["safety", "Safety", S.paused], ["account", "Account", false]];
  return (
    <div className="page">
      <h1 className="pc-h2">Settings</h1>
      <div className="tabs">{tabs.map(([k, l, dot]) => <a key={k} href={`#/settings/${k}`} className={tab === k ? "on" : ""}>{l}{dot && <i className="dot" />}</a>)}</div>
      {tab === "general" && <General prov={p} />}
      {tab === "models" && <div className="col">
        <div className="grid3"><KeyCard id="openrouter" hint="sk-or-…" p={p.openrouter} reload={prov.reload} /><KeyCard id="aigateway" hint="AI Gateway key" p={p.aigateway} reload={prov.reload} /><ChatGpt p={p.openai} reload={prov.reload} /></div>
        <p className="small faint">jev (the pit-stop decider) runs on TypeSafe Jev through your OpenRouter key. Without one, every consequential action becomes a pit stop.</p>
      </div>}
      {tab === "phone" && <Phone />}
      {tab === "email" && <Email />}
      {tab === "engram" && <EngramSettings />}
      {tab === "sites" &&<SitesEditor scope="global" help="Every crew member gets these. A member's own entry wins, except a crew-wide block. Loopback (the crew's own file server) is always allowed; private network addresses never are." />}
      {tab === "vault" && <VaultSettings item={item} />}
      {tab === "safety" && <Safety jev={!!p.openrouter?.connected} />}
      {tab === "account" && <Account />}
    </div>
  );
}

// Pit stops and failed scheduled runs on the phone, through an ntfy topic the driver subscribes to. The token is write-only.
function Phone() {
  const f = useFetch(() => api.get<{ url: string; token: boolean }>("/api/push"), []);
  const [url, setUrl] = useState<string | null>(null), [token, setToken] = useState("");
  if (!f.data) return null;
  const u = url ?? f.data.url;
  const save = async () => { await api.put("/api/push", { url: u, ...(token ? { token } : {}) }); setToken(""); f.reload(); toast("Saved"); };
  const test = async () => { const r = await api.post<{ ok: boolean }>("/api/push/test"); toast(r.ok ? "Sent. Check your phone" : "Couldn't reach the topic"); };
  return (
    <div className="pc-card col" style={{ maxWidth: 640 }}>
      <p className="small muted">Pit stops come with Approve and Deny buttons; paying, hiring and plan changes only open Pitcrew. Nothing is pushed while Pitcrew is open in front of you.</p>
      <Field label="ntfy topic URL"><input placeholder="https://ntfy.example.com/pitcrew-crew" value={u} onChange={(e) => setUrl(e.target.value)} /></Field>
      <Field label={`Access token${f.data.token ? " (saved)" : ""}`}><input type="password" placeholder={f.data.token ? "Leave empty to keep it" : "Only if the topic is protected"} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
      <div className="row"><BusyButton className="pc-pill s" onClick={save}>Save</BusyButton><BusyButton className="pc-pill o s" onClick={test}>Send a test</BusyButton></div>
    </div>
  );
}

// Member email (runtime/mail.ts): the driver's own addresses, the worker's address and secret, each member's mailbox.
function Email() {
  const { S } = useStore();
  const f = useFetch(() => api.get<{ domain: string; driverEmails: string[]; boxes: { bot_id: string; handle: string }[] }>("/api/mail"), []);
  const [mine, setMine] = useState<string | null>(null), [hook, setHook] = useState<{ url: string; secret: string } | null>(null);
  if (!f.data) return null;
  const saveMine = async () => { await api.put("/api/mail", { driverEmails: mine ?? f.data!.driverEmails.join(", ") }); f.reload(); toast("Saved"); };
  return (
    <div className="col" style={{ maxWidth: 760, gap: 16 }}>
      <div className="pc-card col">
        <p className="small muted">{`Each member can have an address at ${f.data.domain}. Forward or CC bills there and the member wakes on its own. Email text reaches it as untrusted data; mail from someone not listed waits for you.`}</p>
        <Field label="Your addresses (mail from these always wakes a member)"><input placeholder="you@gmail.com, you@work.com" value={mine ?? f.data.driverEmails.join(", ")} onChange={(e) => setMine(e.target.value)} onBlur={saveMine} /></Field>
        {hook ? <div className="col" style={{ gap: 4 }}><span className="small faint">Cloudflare Email Worker settings (integrations/cloudflare-email):</span><code className="small">{`PITCREW_MAIL_URL=${hook.url}`}</code><code className="small">{`PITCREW_MAIL_SECRET=${hook.secret}`}</code></div>
          : <div className="row"><BusyButton className="pc-pill o s" onClick={async () => setHook(await api.get("/api/mail/secret"))}>Show worker settings</BusyButton></div>}
      </div>
      {S.bots.filter((b) => !b.archived).map((b) => <MailboxCard key={b.id} botId={b.id} name={b.name} domain={f.data!.domain} onSaved={f.reload} />)}
    </div>
  );
}
function MailboxCard({ botId, name, domain, onSaved }: { botId: string; name: string; domain: string; onSaved: () => void }) {
  const f = useFetch(() => api.get<{ box: { handle: string; senders: string[]; others: "hold" | "drop" } | null }>(`/api/bots/${botId}/mailbox`), [botId]);
  const [handle, setHandle] = useState<string | null>(null), [senders, setSenders] = useState<string | null>(null), [others, setOthers] = useState<"hold" | "drop" | null>(null);
  if (!f.data) return null;
  const box = f.data.box, h = handle ?? box?.handle ?? name.toLowerCase().replace(/[^a-z0-9]+/g, ""), snd = senders ?? (box?.senders || []).join(", "), oth = others ?? box?.others ?? "hold";
  const save = async () => { await api.put(`/api/bots/${botId}/mailbox`, { handle: h, senders: snd.split(/[\s,]+/).filter(Boolean), others: oth }); f.reload(); onSaved(); toast("Saved"); };
  const off = async () => { await api.put(`/api/bots/${botId}/mailbox`, { off: true }); f.reload(); onSaved(); };
  return (
    <div className="pc-card col">
      <div className="spread"><b className="pc-h3">{name}</b><span className={`pc-chip ${box ? "ok" : ""}`}>{box ? `${box.handle}@${domain}` : "no address"}</span></div>
      <div className="row" style={{ alignItems: "flex-end" }}><Field label="Address"><input value={h} onChange={(e) => setHandle(e.target.value)} /></Field><span className="small faint" style={{ paddingBottom: 10 }}>{`@${domain}`}</span></div>
      <Field label="Who else may wake it" help="Addresses, or a whole domain as @bescom.co.in"><input placeholder="@bescom.co.in, billing@airtel.in" value={snd} onChange={(e) => setSenders(e.target.value)} /></Field>
      <Field label="Anyone else"><Seg options={[["hold", "Hold for me"], ["drop", "Drop"]] as const} value={oth} onChange={setOthers} /></Field>
      <div className="row"><BusyButton className="pc-pill s" onClick={save}>{box ? "Save" : "Give it an address"}</BusyButton>{box && <BusyButton className="pc-pill o s" onClick={off}>Turn off</BusyButton>}</div>
    </div>
  );
}

// Each field saves on change; there is no form to remember to submit.
function General({ prov }: { prov: Providers }) {
  const { S, setS } = useStore();
  const [name, setName] = useState(S.driverName);
  const [theme, setTheme] = useState<"dark" | "light">(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const save = async (patch: Partial<State>) => { setS(await api.patch<State>("/api/settings", patch)); toast("Saved"); };
  const pickTheme = (t: "dark" | "light") => { document.documentElement.dataset.theme = t; try { localStorage.setItem("pc-theme", t); } catch { /* private mode */ } setTheme(t); };
  return (
    <div className="pc-card col" style={{ maxWidth: 640 }}>
      <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== S.driverName && save({ driverName: name })} /></Field>
      <Field label="Default provider for new crew members">
        <select value={S.defaultProvider} onChange={(e) => save({ defaultProvider: e.target.value as ProviderId })}>{Object.entries(prov).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
      </Field>
      <label className="row small"><input type="checkbox" checked={S.plainVoice} onChange={(e) => save({ plainVoice: e.target.checked })} />Plain voice for the whole crew</label>
      <label className="row small chk">
        <input type="checkbox" checked={S.plans} onChange={(e) => save({ plans: e.target.checked })} />
        <span className="col" style={{ gap: 2 }}>Crew plans<span className="faint">When a message needs several members, the Crew Chief runs it as a todo list. New Chief threads pick this up.</span></span>
      </label>
      <div className="field"><label>Theme</label><Seg options={[["dark", "dark"], ["light", "light"]] as const} value={theme} onChange={pickTheme} /></div>
    </div>
  );
}

function KeyCard({ id, hint, p, reload }: { id: ProviderId; hint: string; p: ProviderStatus; reload: () => void }) {
  const [key, setKey] = useState("");
  const save = async () => { const r = await api.put<{ ok: boolean; detail: string }>(`/api/providers/${id}/key`, { key }); setKey(""); toast(r.detail, !r.ok); reload(); };
  return (
    <div className="pc-card col">
      <div className="spread"><b className="pc-h3">{p.label}</b><span className={`pc-chip ${p.connected ? "ok" : ""}`}>{p.connected ? "connected" : "off"}</span></div>
      <p className={`small ${p.test?.ok === false ? "badc" : "muted"}`}>{p.connected ? `Connected · saved ${when(p.updatedAt)}${p.test ? ` · ${p.test.detail}` : ""}` : "Not connected"}</p>
      <input type="password" autoComplete="off" placeholder={p.connected ? "Replace key" : hint} value={key} onChange={(e) => setKey(e.target.value)} />
      <div className="row">
        <BusyButton className="pc-pill s" onClick={save}>Save and test</BusyButton>
        {p.connected && <button className="pc-pill o s" onClick={async () => { const r = await api.post<{ ok: boolean; detail: string }>(`/api/providers/${id}/test`); toast(r.detail, !r.ok); reload(); }}>Test</button>}
        {p.connected && <ConfirmButton className="small faint" ask="Remove?" onConfirm={async () => { await api.del(`/api/providers/${id}/key`); reload(); }}>Remove</ConfirmButton>}
      </div>
      <p className="small faint">Keys are write-only: stored encrypted on the server and never shown again.</p>
    </div>
  );
}

// Device-code sign-in has no stream event, so while it's in progress this checks every 2.5 s (at most 400 times).
function ChatGpt({ p, reload }: { p: ProviderStatus; reload: () => void }) {
  const login = p.login || { status: "", url: null, code: null, error: null, startedAt: null };
  const inProgress = login.status === "waiting" || login.status === "starting";
  useEffect(() => {
    if (!inProgress) return;
    let n = 0;
    const t = setInterval(async () => {
      if (++n > 400) return clearInterval(t);
      const pr = await api.get<Providers>("/api/providers", { quiet: true }).catch(() => null);
      if (pr?.openai?.login?.status !== login.status) reload();
    }, 2500);
    return () => clearInterval(t);
  }, [inProgress, login.status, reload]);
  return (
    <div className="pc-card col">
      <div className="spread"><b className="pc-h3">Sign in with ChatGPT</b><span className={`pc-chip ${p.connected ? "ok" : ""}`}>{p.connected ? "connected" : "off"}</span></div>
      <p className="small muted">Use your ChatGPT plan for crew members set to the ChatGPT provider. Runs cost nothing extra; they count against the plan's limits.</p>
      {login.status === "waiting" ? (
        <div className="col">
          <p>Open <a className="md" href={login.url || undefined} target="_blank" rel="noopener noreferrer"><span>{login.url}</span></a> and enter this code:</p>
          <p className="big num">{login.code}</p>
          <div className="row"><Loader /><span className="small faint">Waiting for you to finish…</span></div>
          <button className="small faint" onClick={async () => { await api.post("/api/providers/openai/cancel"); reload(); }}>Cancel</button>
        </div>
      ) : login.status === "starting" ? (
        <div className="row"><Loader /><span className="small">Getting a device code…</span></div>
      ) : (
        <div className="row">
          <button className="pc-pill s" onClick={async () => { await api.post("/api/providers/openai/login"); reload(); }}>{p.connected ? "Sign in again" : "Sign in with ChatGPT"}</button>
          {p.connected && <ConfirmButton className="pc-pill o s" ask="Sign out?" onConfirm={async () => { await api.post("/api/providers/openai/signout"); reload(); }}>Sign out</ConfirmButton>}
        </div>
      )}
      {login.status === "failed" && <p className="small badc">{`Sign-in didn't finish: ${login.error || "unknown error"}`}</p>}
    </div>
  );
}

function Safety({ jev }: { jev: boolean }) {
  const { S, setS, refresh } = useStore();
  return (
    <div className="col">
      <div className="pc-card spread">
        <div className="col" style={{ gap: 4, flex: 1 }}>
          <b className="pc-h3">{S.paused ? "The crew is stopped" : "Stop every crew member now"}</b>
          <p className="small muted">Interrupts every run, denies every pending pit stop, stops every computer and pauses schedules until you resume.</p>
        </div>
        {S.paused ? <button className="pc-pill" onClick={async () => setS(await api.post("/api/resume"))}>Resume the crew</button>
          : <ConfirmButton className="pc-pill sig" ask="Stop everything?" onConfirm={async () => {
              const r = await api.post<{ inFlight: unknown[] }>("/api/kill");
              toast(`Stopped. ${r.inFlight.length} run${r.inFlight.length === 1 ? " was" : "s were"} mid-flight.`);
              await refresh();
            }}>Stop the crew</ConfirmButton>}
      </div>
      <div className="pc-card col">
        <p className="pc-lab">Pit-stop decider</p>
        <p className="small">{jev ? "jev is checking consequential actions through your OpenRouter key." : "jev is off: no OpenRouter key. Every consequential action becomes a pit stop."}</p>
        <p className="small faint">What each crew member may do without asking lives on its Profile tab; per-site rules on Sites.</p>
      </div>
    </div>
  );
}

function Account() {
  const [cur, setCur] = useState(""), [next, setNext] = useState("");
  return (
    <div className="pc-card col" style={{ maxWidth: 520 }}>
      <p className="pc-lab">Password</p>
      <input type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
      <input type="password" placeholder="New password (12+)" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      <div className="row">
        <button className="pc-pill o s" onClick={async () => { await api.post("/api/password", { current: cur, next }); location.reload(); }}>Change password</button>
        <button className="pc-pill o s" onClick={async () => { await api.post("/api/logout"); location.reload(); }}>Sign out</button>
      </div>
    </div>
  );
}
