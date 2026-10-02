// Engram, the driver's context engine: the link settings, the crew's tokens, the memory move, and the Pit wall digest.
import { useEffect, useState } from "react";
import type { EngramDigest, EngramProposal, EngramStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { ago, plural, when } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { BusyButton, ConfirmButton, Face, Field } from "./ui";

export function EngramSettings() {
  const { refresh } = useStore();
  const st = useFetch(() => api.get<EngramStatus>("/api/engram"), []);
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const running = !!st.data?.migration.running;
  // The move has no stream event, so while it runs this rereads its progress every 1.5 s.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(st.reload, 1500);
    return () => clearInterval(t);
  }, [running, st.reload]);
  if (st.error && !st.data) return <p className="badc">{st.error}</p>;
  if (!st.data) return null;
  const s = st.data, m = s.migration;
  const after = (r: EngramStatus, ok?: string) => { if (r.test && !r.test.ok) toast(r.test.detail, true); else if (ok) toast(ok); st.reload(); refresh(); };
  const save = async () => { const r = await api.put<EngramStatus>("/api/engram", { url: url ?? s.url, token }); setToken(""); after(r, r.linked ? "Linked to Engram" : undefined); };
  return (
    <div className="col">
      <div className="pc-card col" style={{ maxWidth: 640 }}>
        <div className="spread"><b className="pc-h3">Engram</b><span className={`pc-chip ${s.linked ? "ok" : ""}`}>{s.linked ? "linked" : "off"}</span></div>
        <p className="small muted">Your context engine. Linked, its inbox shows up here as pit stops, the Pit wall shows its weekly digest, and each crew member uses Engram instead of its own connectors. Private members stay out.</p>
        <Field label="Address"><input value={url ?? s.url} placeholder={s.defaultUrl} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Link token" help="From Engram → Agents → Link Pitcrew. Stored encrypted and never shown again.">
          <input type="password" autoComplete="off" placeholder={s.linked ? "Replace token" : "Paste the link token"} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <div className="row">
          <BusyButton className="pc-pill s" onClick={save}>Save and test</BusyButton>
          {s.linked && <BusyButton className="pc-pill o s" onClick={async () => after(await api.post<EngramStatus>("/api/engram/test"), "Engram answered")}>Test</BusyButton>}
          {s.linked && <ConfirmButton className="small faint" ask="Unlink?" onConfirm={async () => after(await api.del<EngramStatus>("/api/engram"), "Unlinked")}>Unlink</ConfirmButton>}
        </div>
        {s.test && <p className={`small ${s.test.ok ? "muted" : "badc"}`}>{`${s.test.detail} · ${ago(s.test.at)}`}</p>}
        {s.linked && s.poll && <p className={`small ${s.poll.ok ? "faint" : "badc"}`}>{`Inbox checked ${ago(s.poll.at)}: ${s.poll.detail}`}</p>}
      </div>
      {s.linked && <div className="pc-card col" style={{ maxWidth: 640 }}>
        <p className="pc-lab">The crew in Engram</p>
        {s.members.map((x) => (
          <div key={x.id} className="row">
            <Face b={x} size="xs" /><b style={{ flex: 1 }}>{x.name}</b>
            <span className="small faint">{!x.eligible ? "private: give it Money or Health memories to link it" : x.linked ? `own token${x.prefix ? ` ${x.prefix}…` : ""} · ${when(x.at)}` : x.revoked ? "revoked in Engram" : "no token yet"}</span>
            {x.eligible && <BusyButton className="pc-pill o s" onClick={async () => after(await api.post<EngramStatus>(`/api/engram/members/${x.id}/rotate`), "New token")}>{x.linked ? "Rotate" : "Link"}</BusyButton>}
          </div>))}
        <p className="small faint">A new token reaches a member when its brain next starts.</p>
      </div>}
      {s.linked && <div className="pc-card col" style={{ maxWidth: 640 }}>
        <p className="pc-lab">Move memories to Engram</p>
        <p className="small muted">Sends each member's memories, with their dates, and its Library files from out/ and downloads/ (up to 6 MB each) to Engram. Private members without Money or Health memories are skipped, and nothing here is deleted. Run it again any time: only what's new is sent.</p>
        <div className="row">
          <BusyButton className="pc-pill s" onClick={async () => { await api.post("/api/engram/migrate"); st.reload(); }}>{running ? "Moving…" : "Move memories to Engram"}</BusyButton>
          <span className="small faint">{`${plural(s.sent.memories, "memory")} and ${plural(s.sent.files, "file")} sent so far`}</span>
        </div>
        {m.line && <p className="small">{m.line}</p>}
        {!running && m.summary && m.summary.length > 0 && <table className="tbl"><tbody>{m.summary.map((r) => (
          <tr key={r.name}><td>{r.name}</td><td className="small">{`${plural(r.memories, "memory")}, ${plural(r.files, "file")}`}</td>
            <td className="small faint">{[r.skipped && `${r.skipped} already there`, r.tooBig && `${r.tooBig} over 6 MB`, r.failed && `${r.failed} failed`].filter(Boolean).join(" · ")}</td></tr>))}
        </tbody></table>}
      </div>}
    </div>
  );
}

// The proposal as Engram holds it: what it would store, why it's held, and what it would replace.
export function ProposalSummary({ x }: { x: EngramProposal }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <p className="pc-m small faint">{[x.kind, x.area, x.scope, x.source?.label].filter(Boolean).join(" · ")}</p>
      {x.text && x.text !== x.title && <p className="small">{x.text}</p>}
      {x.reasons.length > 0 && <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{x.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {x.replaces && <p className="small">{`Replaces: “${x.replaces.text}”${x.replaces.source ? ` (${x.replaces.source})` : ""}`}</p>}
    </div>
  );
}

interface DigestView { url: string; at: number | null; digest: EngramDigest | null }
export function DigestCard() {
  const { data } = useFetch(() => api.get<DigestView>("/api/engram/digest", { quiet: true }), []);
  const d = data?.digest;
  if (!d) return null;
  const waiting = d.waiting.open ? `${plural(d.waiting.open, "thing")} waiting on you in Engram${d.waiting.held ? `, ${d.waiting.held} held for a closer look` : ""}.` : "Nothing waiting in Engram.";
  return (
    <div className="pc-card col">
      <div className="spread"><p className="pc-lab">{`This week in Engram · ${d.week}`}</p><a className="small faint" href={`${data!.url}/#/digest`} target="_blank" rel="noopener noreferrer">Open the digest</a></div>
      <p>{waiting}</p>
      {d.runningOut.length > 0 && <p className="small">{`Running out: ${d.runningOut.slice(0, 3).map((r) => `${r.text} (${r.date})`).join("; ")}`}</p>}
      {d.changed.slice(0, 3).map((c, i) => <p key={i} className={`small ${c.tone === "bad" ? "badc" : "muted"}`}>{c.text}</p>)}
      {d.openLoops.length > 0 && <p className="small muted">{`${plural(d.openLoops.length, "open loop")}: ${d.openLoops.slice(0, 3).map((l) => l.text).join("; ")}`}</p>}
    </div>
  );
}
