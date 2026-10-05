// Models: the default service for new members, the write-only keys, and ChatGPT sign-in.
import { useEffect } from "react";
import type { ProviderId, ProviderStatus } from "../../../../shared/types";
import { Loader } from "../../components/ui";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useSetting } from "./General";
import { Menu, Row, SecretRow, Section, TabHead, useSaved } from "./kit";

export type Providers = Record<ProviderId, ProviderStatus>;
const KEY_HELP: Record<string, string> = { openrouter: "Runs members set to OpenRouter, and the safety check.", aigateway: "Runs members set to AI Gateway." };

export function Models({ prov, reload }: { prov: Providers; reload: () => void }) {
  const { S } = useStore();
  const save = useSetting();
  const [defSaved, flashDef] = useSaved();
  return (
    <>
      <TabHead title="Models" intro="Which service a new member runs on, and the keys Pitcrew uses. Keys are stored encrypted and never shown again." />
      <Section title="New members">
        <Row label="Default service" help="A member keeps the one it was hired with; change it on the member's page." saved={defSaved}>
          <select className="st-sel" value={S.defaultProvider} onChange={(e) => save({ defaultProvider: e.target.value as ProviderId }, flashDef)}>
            {Object.entries(prov).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
          </select>
        </Row>
      </Section>
      <Section title="Keys and sign-in">
        {(["openrouter", "aigateway"] as const).map((id) => <KeyRow key={id} id={id} p={prov[id]} reload={reload} />)}
        <ChatGpt p={prov.openai} reload={reload} />
      </Section>
    </>
  );
}

function KeyRow({ id, p, reload }: { id: ProviderId; p: ProviderStatus; reload: () => void }) {
  const test = async () => { const r = await api.post<{ ok: boolean; detail: string }>(`/api/providers/${id}/test`); toast(r.detail, !r.ok); reload(); };
  const failed = p.test?.ok === false;
  return (
    <SecretRow label={p.label} has={p.connected} at={p.updatedAt} placeholder={id === "openrouter" ? "sk-or-…" : "Paste the key"} saveLabel="Save and test"
      help={failed ? p.test!.detail : KEY_HELP[id]} bad={failed}
      onSave={async (key) => { const r = await api.put<{ ok: boolean; detail: string }>(`/api/providers/${id}/key`, { key }); if (!r.ok) toast(r.detail, true); reload(); return r.ok; }}
      extra={<Menu items={[{ label: "Test", run: test }, { label: "Remove", danger: true, confirm: "Remove the key?", run: async () => { await api.del(`/api/providers/${id}/key`); reload(); } }]} />} />
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
  const start = async () => { await api.post("/api/providers/openai/login"); reload(); };
  const waiting = login.status === "waiting" ? (
    <div className="st-device">
      <p>Open <a className="md" href={login.url || undefined} target="_blank" rel="noopener noreferrer"><span>{login.url}</span></a> and enter this code:</p>
      <p className="big num">{login.code}</p>
      <div className="row"><Loader /><span className="small faint">Waiting for you to finish…</span><button className="st-q" onClick={async () => { await api.post("/api/providers/openai/cancel"); reload(); }}>Cancel</button></div>
    </div>
  ) : undefined;
  const failed = login.status === "failed";
  return (
    <Row label="ChatGPT plan" below={waiting} bad={failed}
      help={failed ? `Sign-in didn't finish: ${login.error || "unknown error"}` : "Members set to ChatGPT use your plan. Runs cost nothing extra; they count against the plan's limits."}>
      {login.status === "starting" ? <><Loader /><span className="st-val">Getting a code…</span></>
        : login.status === "waiting" ? <span className="st-val">Waiting</span>
        : p.connected ? <><span className="st-val">Signed in</span><Menu items={[{ label: "Sign in again", run: start }, { label: "Sign out", danger: true, confirm: "Sign out?", run: async () => { await api.post("/api/providers/openai/signout"); reload(); } }]} /></>
        : <button className="pc-pill o s" onClick={start}>Sign in with ChatGPT</button>}
    </Row>
  );
}
