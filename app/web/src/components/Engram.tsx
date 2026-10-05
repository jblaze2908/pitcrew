// Engram, the user's memory app (shown as "shared memory"): proposals and Home's digest. The link lives in Settings → Connections.
import type { EngramDigest, EngramProposal } from "../../../shared/types";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { useFetch } from "../lib/useFetch";

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
  const waiting = d.waiting.open ? `${plural(d.waiting.open, "thing")} waiting on you in the memory app${d.waiting.held ? `, ${d.waiting.held} held for a closer look` : ""}.` : "Nothing waiting in the memory app.";
  return (
    <div className="pc-card col">
      <div className="spread"><p className="pc-lab">{`This week in memory · ${d.week}`}</p><a className="small faint" href={`${data!.url}/#/digest`} target="_blank" rel="noopener noreferrer">Open the digest</a></div>
      <p>{waiting}</p>
      {d.runningOut.length > 0 && <p className="small">{`Running out: ${d.runningOut.slice(0, 3).map((r) => `${r.text} (${r.date})`).join("; ")}`}</p>}
      {d.changed.slice(0, 3).map((c, i) => <p key={i} className={`small ${c.tone === "bad" ? "badc" : "muted"}`}>{c.text}</p>)}
      {d.openLoops.length > 0 && <p className="small muted">{`${plural(d.openLoops.length, "open loop")}: ${d.openLoops.slice(0, 3).map((l) => l.text).join("; ")}`}</p>}
    </div>
  );
}
