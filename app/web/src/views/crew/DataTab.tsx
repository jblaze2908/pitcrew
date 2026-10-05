// What a member keeps: its ledgers (tables, row counts, a look at the rows) and the dashboards it built on them.
import { useState } from "react";
import type { BotCard, Surface as SurfaceRow } from "../../../../shared/types";
import { Surface } from "../../components/Surface";
import { api } from "../../lib/api";
import { ago, kb, plural } from "../../lib/format";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";

interface Table { name: string; rows: number | null; columns: string[] }
interface Ledger { path: string; size: number; asOf: number | null; tables: Table[]; error?: string }
interface Skill { name: string; description: string; size: number; uses: number; last_used: number | null; stale: boolean }
interface Board { id: string; title: string; saved: number; thread_id: string; created_at: number; source: string; queries: string[] }
type Preview = { columns: string[]; rows: Record<string, unknown>[] } | { error: string };

export function DataTab({ b }: { b: BotCard }) {
  const { data, reload } = useFetch(() => api.get<{ ledgers: Ledger[]; dashboards: Board[]; skills: Skill[] }>(`/api/bots/${b.id}/data`), [b.id]);
  if (!data) return null;
  return (
    <div className="col">
      <section className="col">
        <p className="pc-lab">{`Ledgers · ${data.ledgers.length}`}</p>
        {data.ledgers.length ? data.ledgers.map((l) => <LedgerCard key={l.path} b={b} l={l} />)
          : <div className="pc-card tight"><p className="empty">{`${b.name} keeps no ledgers yet. A recurring task stores its data in a SQLite file under /bot/work.`}</p></div>}
      </section>
      <section className="col">
        <p className="pc-lab">{`Skills · ${data.skills.length}`}</p>
        {data.skills.length ? <div className="pc-card tight"><table className="tbl"><tbody>{data.skills.map((k) => (
          <tr key={k.name}><td className="pc-m">{k.name}</td><td className="small muted">{k.description}</td>
            <td className="num small faint">{k.uses ? `${k.uses} load${k.uses === 1 ? "" : "s"} · last ${ago(k.last_used)}` : "never loaded"}{k.stale ? " · stale" : ""}</td></tr>))}</tbody></table>
          <p className="small faint" style={{ padding: "0 12px 10px" }}>{`In /bot/work/skills, a git repo: history under Files → Projects.`}</p></div>
          : <div className="pc-card tight"><p className="empty">{`No skills yet. ${b.name} writes them in /bot/work/skills as it learns how a task runs.`}</p></div>}
      </section>
      <section className="col">
        <p className="pc-lab">{`Dashboards · ${data.dashboards.length}`}</p>
        {data.dashboards.length ? data.dashboards.map((d) => <BoardRow key={d.id} d={d} onChange={reload} />)
          : <div className="pc-card tight"><p className="empty">No dashboards on its ledgers yet.</p></div>}
      </section>
    </div>
  );
}

function LedgerCard({ b, l }: { b: BotCard; l: Ledger }) {
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<Preview | null>(null);
  const show = async (t: string) => {
    if (open === t) { setOpen(null); return; }
    setOpen(t); setRows(null);
    setRows(await api.get<Preview>(`/api/bots/${b.id}/data/table?source=${encodeURIComponent(l.path)}&table=${encodeURIComponent(t)}`));
  };
  return (
    <div className="pc-card col">
      <div className="spread"><b className="pc-m">{l.path}</b><span className="small faint">{`${kb(l.size)} · updated ${ago(l.asOf)}`}</span></div>
      {l.error && <p className="badc small">{l.error}</p>}
      <table className="tbl">
        <thead><tr><th>Table</th><th className="num">Rows</th><th>Columns</th></tr></thead>
        <tbody>{l.tables.map((t) => (
          <tr key={t.name} onClick={() => show(t.name)} style={{ cursor: "pointer" }} title="Show its newest rows">
            <td className="pc-m">{t.name}</td><td className="num">{t.rows ?? "—"}</td><td className="small muted">{t.columns.join(", ")}</td>
          </tr>))}
        </tbody>
      </table>
      {open && (rows == null ? <p className="small faint">Loading…</p> : "error" in rows ? <p className="badc small">{rows.error}</p> : (
        <div className="col" style={{ gap: 4 }}>
          <p className="small faint">{`${open}: newest ${plural(rows.rows.length, "row")}`}</p>
          <div className="scrollx"><table className="tbl"><thead><tr>{rows.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.rows.map((r, i) => <tr key={i}>{rows.columns.map((c) => <td key={c} className="small">{String(r[c] ?? "").slice(0, 120)}</td>)}</tr>)}</tbody></table></div>
        </div>))}
    </div>
  );
}

function BoardRow({ d, onChange }: { d: Board; onChange: () => void }) {
  const [s, setS] = useState<SurfaceRow | null>(null);
  const toggle = async () => { await api.post(`/api/surfaces/${d.id}/save`, { saved: !d.saved }); toast(d.saved ? "Taken off the Wall" : "Pinned to the Wall"); onChange(); };
  return (
    <div className="pc-card col">
      <div className="spread">
        <div className="col" style={{ gap: 2 }}><b>{d.title}</b><span className="small faint">{`${d.source} · ${plural(d.queries.length, "query")} · made ${ago(d.created_at)}`}</span></div>
        <div className="row" style={{ gap: 8 }}>
          <button className="pc-pill o s" onClick={async () => setS(s ? null : await api.get<SurfaceRow>(`/api/surfaces/${d.id}`))}>{s ? "Hide" : "Show"}</button>
          <button className={`pc-pill s ${d.saved ? "o" : "sig"}`} onClick={toggle}>{d.saved ? "On the Wall" : "Pin to Wall"}</button>
          <a className="small faint" href={`#/t/${d.thread_id}`}>Thread</a>
        </div>
      </div>
      {s && <Surface s={s} onAction={async (action, values) => { await api.post(`/api/surfaces/${d.id}/action`, { action, values }); toast("Sent to the crew"); }} />}
    </div>
  );
}
