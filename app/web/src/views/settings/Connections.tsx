// Connections: shared memory (the Engram link, member tokens, the memory copy) and email (your addresses, the mail relay).
import { useEffect, useState } from "react";
import type { EngramStatus } from "../../../../shared/types";
import { BusyButton, Face } from "../../components/ui";
import { api } from "../../lib/api";
import { ago, plural } from "../../lib/format";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";
import { day, Menu, Row, SecretRow, Section, TabHead, TextSave, Wide, useSaved } from "./kit";

export function Connections() {
  return (
    <>
      <TabHead title="Connections" intro="Services the crew reaches through Pitcrew. Each says whether it's working." />
      <Memory />
      <Email />
    </>
  );
}

function Memory() {
  const { refresh } = useStore();
  const st = useFetch(() => api.get<EngramStatus>("/api/engram"), []);
  const [url, setUrl] = useState<string | null>(null);
  const [urlSaved, flashUrl] = useSaved();
  const running = !!st.data?.migration.running;
  // The copy has no stream event, so while it runs this rereads its progress every 1.5 s.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(st.reload, 1500);
    return () => clearInterval(t);
  }, [running, st.reload]);
  if (st.error && !st.data) return <p className="badc">{st.error}</p>;
  if (!st.data) return null;
  const s = st.data, m = s.migration;
  const after = (r: EngramStatus, ok?: string) => { if (r.test && !r.test.ok) toast(r.test.detail, true); else if (ok) toast(ok); st.reload(); refresh(); return !r.test || r.test.ok; };
  const status = [s.linked && s.poll && `Inbox checked ${ago(s.poll.at)}${s.poll.ok ? "" : `: ${s.poll.detail}`}.`, s.test && `${s.test.ok ? "Last test passed" : `Last test failed: ${s.test.detail}`} ${ago(s.test.at)}.`].filter(Boolean).join(" ");
  const bad = (s.test && !s.test.ok) || (s.linked && s.poll && !s.poll.ok);
  return (
    <Section id="memory" title="Shared memory"
      intro="Your Engram server keeps what you've told your agents in one place. Linked, its questions arrive as pit stops, Home shows its weekly digest, and members read and file memories there. Private members stay out."
      action={s.linked ? <BusyButton className="pc-pill o s" onClick={async () => { after(await api.post<EngramStatus>("/api/engram/test"), "Shared memory answered"); }}>Test</BusyButton> : undefined}>
      <Row label="Status" help={status || "Not linked yet. Add the address and link token below."} bad={!!bad}>
        <span className="st-val">{s.linked ? "Linked" : "Not linked"}</span>
        {s.linked && <Menu items={[{ label: "Unlink", danger: true, confirm: "Unlink?", run: async () => after(await api.del<EngramStatus>("/api/engram"), "Unlinked") }]} />}
      </Row>
      <Row label="Address" help={s.linked ? "A new address needs its own link token." : undefined} saved={urlSaved}>
        <TextSave wide value={url ?? s.url} placeholder={s.defaultUrl} onSave={async (v) => {
          if (!s.linked) return setUrl(v);
          if (after(await api.put<EngramStatus>("/api/engram", { url: v, token: "" }))) flashUrl();
        }} />
      </Row>
      <SecretRow label="Link token" help="Made in Engram under Agents, Link Pitcrew." has={s.linked} at={s.updatedAt} placeholder="Paste the link token" saveLabel={s.linked ? "Save and test" : "Link"}
        onSave={async (token) => after(await api.put<EngramStatus>("/api/engram", { url: url ?? s.url, token }), s.linked ? undefined : "Shared memory linked")} />
      {s.linked && <Row label="Copy memories over" help="Sends each member's memories, with their dates. Only new ones go, and nothing here is deleted. Files go over when a member publishes them."
        below={(m.line || (!running && m.summary?.length)) ? <div className="st-note">
          {m.line && <p>{m.line}</p>}
          {!running && m.summary?.map((r) => <p key={r.name} className="faint">{[`${r.name}: ${plural(r.memories, "memory")}`, r.skipped && `${r.skipped} already there`, r.failed && `${r.failed} failed`].filter(Boolean).join(" · ")}</p>)}
        </div> : undefined}>
        <span className="st-val">{`${s.sent.memories} sent so far`}</span>
        <BusyButton className="pc-pill o s" onClick={async () => { await api.post("/api/engram/migrate"); st.reload(); }}>{running ? "Copying…" : "Copy now"}</BusyButton>
      </Row>}
      {s.linked && <>
        <div className="st-sub"><span>Each member's access</span><span>A new token reaches a member when it next starts</span></div>
        {s.members.map((x) => {
          const line = !x.eligible ? "Private, so it stays out until its memories go under Money or Health." : x.revoked ? `Its token was revoked in Engram${x.at ? ` on ${day(x.at)}` : ""}.` : x.linked ? `Own token since ${day(x.at)}` : "No token yet";
          const rotate = async () => { after(await api.post<EngramStatus>(`/api/engram/members/${x.id}/rotate`), "New token"); };
          return (
            <Wide key={x.id} className="st-member">
              <Face b={x} size="xs" />
              <div className="st-rl"><p className="st-l">{x.name}</p><p className={`st-h${x.revoked ? " bad" : ""}`}>{line}</p></div>
              <div className="st-ctl">{!x.eligible ? <span className="st-val">Not linked</span>
                : x.linked && !x.revoked ? <BusyButton className="st-q" onClick={rotate}>Rotate</BusyButton>
                : <BusyButton className="pc-pill o s" onClick={rotate}>{x.revoked ? "Link again" : "Link"}</BusyButton>}</div>
            </Wide>);
        })}
      </>}
    </Section>
  );
}

type Mail = { domain: string; driverEmails: string[]; boxes: { bot_id: string; handle: string }[] };

// Written straight to the clipboard: the secret is fetched on click and never kept in state or put on screen.
async function copyRelay() {
  const text = api.get<{ url: string; secret: string }>("/api/mail/secret").then((h) => `PITCREW_MAIL_URL=${h.url}\nPITCREW_MAIL_SECRET=${h.secret}\n`);
  try {
    // A ClipboardItem built from a promise keeps the click's permission in Safari while the fetch runs.
    try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]); }
    catch { await navigator.clipboard.writeText(await text); }
    toast("Copied. Paste both lines into the email worker's settings.");
  } catch { toast("Couldn't copy. Allow clipboard access for Pitcrew and try again.", true); }
}

function Email() {
  const { S } = useStore();
  const f = useFetch(() => api.get<Mail>("/api/mail"), []);
  const [mineSaved, flashMine] = useSaved();
  if (f.error && !f.data) return <p className="badc">{f.error}</p>;
  if (!f.data) return null;
  const d = f.data, crew = S.bots.filter((b) => !b.archived), boxed = crew.filter((b) => d.boxes.some((x) => x.bot_id === b.id));
  return (
    <Section id="email" title="Email" intro={`Each member can have its own address at ${d.domain}. Forward or CC a bill there and that member wakes on its own. Mail text reaches it as untrusted data.`}>
      <Row label="Your addresses" help="Mail from these always wakes a member. Mail from anyone else follows that member's own setting." saved={mineSaved}>
        <TextSave wide value={d.driverEmails.join(", ")} placeholder="you@gmail.com, you@work.com" onSave={async (v) => { await api.put("/api/mail", { driverEmails: v }); f.reload(); flashMine(); }} />
      </Row>
      <Row label="Mail relay" help="The Cloudflare email worker needs Pitcrew's mail address and a shared secret. Copy them straight into the worker.">
        <span className="st-val">Saved ····</span>
        <BusyButton className="st-q" onClick={copyRelay}>Copy settings</BusyButton>
      </Row>
      <Row label="Member addresses" help="Each address, and who may write to it, is set on that member's Settings page.">
        <span className="st-faces">{boxed.slice(0, 5).map((b) => <Face key={b.id} b={b} size="xs" />)}</span>
        <span className="st-val">{`${boxed.length} of ${plural(crew.length, "member")}`}</span>
      </Row>
    </Section>
  );
}
