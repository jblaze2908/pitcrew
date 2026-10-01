// The thread's side panel: who, context use, the computer, other threads, archive.
import type { Bot, BotCard } from "../../../../shared/types";
import { useDock } from "../../components/Dock";
import { ConfirmButton, Face } from "../../components/ui";
import { api } from "../../lib/api";
import { go } from "../../lib/router";
import { useStore } from "../../lib/store";

interface Props {
  id: string; b: Bot & Partial<BotCard>;
  ctx: { tokens: number | null; window: number | null };
  lease: boolean; onHandedBack: () => void;
}

export function Panel({ id, b, ctx, lease, onHandedBack }: Props) {
  const { bot } = useStore();
  const { openDock } = useDock();
  const pct = ctx.tokens && ctx.window ? Math.min(100, (ctx.tokens / ctx.window) * 100) : 0;
  const others = (bot(b.id)?.threads || []).filter((t) => t.id !== id).slice(0, 8);
  return (
    <aside className="panel">
      <div className="col"><p className="pc-lab">Crew member</p>
        <a className="row" href={`#/crew/${b.id}`}><Face b={b} size="md" /><div><b className="pc-h3">{b.name}</b><p className="pc-m small faint">{`${b.provider} · ${b.model}`}</p></div></a>
      </div>
      <div className="col"><p className="pc-lab">Context</p>
        <div className={`meter ${pct > 70 ? "hot" : ""}`}><b style={{ width: `${pct}%` }} /></div>
        <span className="pc-m small faint">{ctx.tokens && ctx.window ? `${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.window / 1000)}k tokens` : "no runs yet"}</span>
        <div className="row">
          <button className="pc-pill o s" onClick={() => api.post(`/api/threads/${id}/compact`)}>Compact</button>
          <button className="pc-pill o s" onClick={async () => { const r = await api.post<{ id: string }>(`/api/threads/${id}/fresh`); go(`#/t/${r.id}`); }}>Fresh thread from here</button>
        </div>
      </div>
      <div className="col"><p className="pc-lab">Computer</p>
        {/* Hand back works from chat too, so a held lease never strands the crew behind a screen you can't reach. */}
        {lease && <button className="pc-pill sig s" onClick={async () => { await api.post(`/api/bots/${b.id}/computer/handback`); onHandedBack(); }}>Hand back control</button>}
        {b.computer?.desktop
          ? <div className="col" style={{ gap: 8 }}>
              <a className="mini" href={`#/live/${b.id}`}><span className="pc-pill s">Watch live</span></a>
              <button className="small" style={{ textAlign: "left", padding: 0 }} onClick={() => openDock(b)}>Watch in a corner while you chat</button>
            </div>
          : <div className="mini"><span className="small faint">{b.computer?.up ? "Runtime up · no desktop yet" : "In the garage"}</span></div>}
        <p className="small faint">Chat needs no computer. It starts on the first command or browser action and stops after 10 idle minutes.</p>
        <a className="small" href={`#/crew/${b.id}/files`}>Browse files and changes</a>
      </div>
      <div className="col"><p className="pc-lab">Other threads</p>{others.map((t) => <a key={t.id} className="small muted" href={`#/t/${t.id}`}>{t.title}</a>)}</div>
      <ConfirmButton className="small faint" style={{ textAlign: "left", padding: 0 }} ask="Archive?"
        onConfirm={async () => { await api.patch(`/api/threads/${id}`, { archived: true }); go(`#/crew/${b.id}`); }}>Archive thread</ConfirmButton>
    </aside>
  );
}
