// A member's threads, with search over titles and anything said in them.
import { useEffect, useState } from "react";
import type { BotCard, ThreadRow } from "../../../../shared/types";
import { api } from "../../lib/api";
import { ago, when } from "../../lib/format";
import { go } from "../../lib/router";

export function ThreadsTab({ b }: { b: BotCard }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ThreadRow[] | null>(null);
  // Search waits for a 200 ms pause in typing.
  useEffect(() => {
    const v = q.trim();
    if (!v) { setFound(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await api.get<ThreadRow[]>(`/api/bots/${b.id}/threads?q=${encodeURIComponent(v)}`, { quiet: true }).catch(() => []);
      if (live) setFound(r);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, b.id]);

  if (!b.threads.length) return <div className="pc-card tight"><p className="empty">No threads yet.</p></div>;
  // Threads carry no outcome of their own; only a live run (working, or waiting on a pit stop) earns a chip.
  const rows: ThreadRow[] = found ?? b.threads;
  return (
    <div className="col">
      <input type="search" className="threadq" placeholder="Find a thread by its title or anything said in it" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pc-card tight">
        <table className="tbl threads">
          <thead><tr><th>Thread</th><th className="num">Created</th><th className="num">Last active</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((t) => (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => go(`#/t/${t.id}`)}>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <b>{t.title}</b>
                    {!!t.pinned && <span className="pc-chip">pinned</span>}
                    {!!t.archived && <span className="pc-chip">archived</span>}
                    {t.status === "running" ? <span className="pc-chip blue">working</span> : t.status === "needs" ? <span className="pc-chip hot">pit stop</span> : null}
                  </div>
                  {t.snippet && <p className="small faint snip">{t.snippet}</p>}
                </td>
                <td className="num faint small">{when(t.created_at)}</td>
                <td className="num faint small" title={when(t.updated_at)}>{ago(t.updated_at)}</td>
              </tr>))
              : <tr><td colSpan={3} className="faint small">No threads match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
