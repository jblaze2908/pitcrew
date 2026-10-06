// The thread header's two controls: the title menu and where the thread came from.
import { useRef, useState } from "react";
import type { BotCard, Origin } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { MemberMenu } from "../../components/MemberMenu";
import { Chev, ConfirmButton, Face, hueStyle } from "../../components/ui";
import { api } from "../../lib/api";
import { go } from "../../lib/router";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";

/** The thread title is its menu: rename, auto-name, context, pin, files, archive. */
export function TitleMenu({ id, title, onRenamed, b, pinned, onPinned }: { id: string; title: string; onRenamed: (t: string) => void; b: BotCard; pinned: boolean; onPinned: (p: boolean) => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (editing != null) {
    const done = async () => { const t = editing || title; setEditing(null); await api.patch(`/api/threads/${id}`, { title: t }); onRenamed(t); };
    return <input className="ttl-edit" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditing(null); }} />;
  }
  const act = (fn: () => unknown) => async () => { setMenu(false); await fn(); };
  return (
    <span className="ttlwrap">
      <button className="ttl" aria-expanded={menu} onClick={() => setMenu(!menu)}><span className="t">{title}</span><Icon name="chev" size={14} /></button>
      {menu && <>
        <div className="scrim" onClick={() => setMenu(false)} />
        <div className="menu tmenu" role="menu">
          <button className="op" onClick={act(() => setEditing(title))}><Icon name="pen" />Rename</button>
          <button className="op" onClick={act(async () => { const r = await api.post<{ title: string }>(`/api/threads/${id}/retitle`); onRenamed(r.title); })}><Icon name="spark" />Auto-name from the chat</button>
          <hr />
          <button className="op" onClick={act(async () => { await api.post(`/api/threads/${id}/compact`); toast("Compacting the thread"); })}><Icon name="compact" />Compact the context</button>
          <button className="op" onClick={act(async () => { const r = await api.post<{ id: string }>(`/api/threads/${id}/fresh`); go(`#/t/${r.id}`); })}><Icon name="fresh" />Fresh thread from here</button>
          <button className="op" onClick={act(async () => { await api.patch(`/api/threads/${id}`, { pinned: !pinned }); onPinned(!pinned); })}><Icon name="pin" />{pinned ? "Unpin" : "Pin to the sidebar"}</button>
          <hr />
          <a className="op" href={`#/crew/${b.id}/files`} onClick={() => setMenu(false)}><Icon name="folder" />Files and changes</a>
          <a className="op" href={`#/crew/${b.id}/profile`} onClick={() => setMenu(false)}><Icon name="person" />{`${b.name}'s profile`}</a>
          <ConfirmButton className="op dim" ask="Archive this thread?" onConfirm={async () => { setMenu(false); await api.patch(`/api/threads/${id}`, { archived: true }); go(`#/crew/${b.id}`); }}><Icon name="archive" />Archive</ConfirmButton>
        </div>
      </>}
    </span>);
}

// Where a thread came from: routed by the front door (its pill changes who takes it) or asked by another member.
export function OriginChip({ origin: o, threadId, b }: { origin: Origin; threadId: string; b: { id: string; name: string; hue: string; shape: string } }) {
  const { bot } = useStore();
  const pill = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  if (o.kind === "email") return <span className="pc-chip" title={o.subject}>{`Woken by an email from ${o.from}`}</span>;
  if (o.kind === "schedule") return <a className="pc-chip" href="#/schedules" title="This run's schedule">{`Scheduled run${o.spec ? ` · ${o.spec}` : ""}`}</a>;
  if (o.kind === "delegated") {
    const f = bot(o.fromBot);
    return <a className="pc-chip blue" href={`#/t/${o.fromThread}`} title="Open the thread that asked">{o.planId ? `Plan step for ${f?.name || "another member"}` : `Asked by ${f?.name || "another member"}`}</a>;
  }
  const reroute = async (to: string | null) => {
    if (!to) return;
    const r = await api.post<{ threadId: string; botId: string }>(`/api/threads/${threadId}/reroute`, { botId: to });
    toast(`Moved to ${bot(r.botId)?.name}`);
    go(`#/t/${r.threadId}`);
  };
  const tip = o.confidence != null ? `Routed with ${(o.confidence * 100).toFixed(0)}% confidence. Pick someone else to move this message.` : "Pick someone else to move this message";
  return (
    <span className="row" style={{ gap: 6, flex: "none" }}>
      {o.by !== "driver" && <span className="small faint">{o.by === "names" ? "You named several" : "Picked for you"}</span>}
      <button ref={pill} className="to alt" style={hueStyle(b.hue)} title={tip} onClick={() => setMenu(true)}><Face b={b} size="xs" mood="idle" />{b.name}<Chev /></button>
      {menu && pill.current && <MemberMenu anchor={pill.current} auto={false} exclude={b.id} onClose={() => setMenu(false)} onPick={reroute} />}
    </span>
  );
}
