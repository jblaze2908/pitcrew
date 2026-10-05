// A thread: the transcript (live over SSE), the composer, and the side panel.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CatchThePaint } from "./thread/Painting";
import { EditPanel } from "./thread/ImageEdit";
import { Viewer } from "./thread/Viewer";
import { indexImages, imgName, imgSrc, type Img } from "../lib/images";
import type { BotCard, Origin, PitStop, PlanSnapshot, Surface as SurfaceRow, ThreadEvent, ThreadView } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { MemberMenu } from "../components/MemberMenu";
import { Surface } from "../components/Surface";
import { Chev, ConfirmButton, Face, hueStyle, Loader } from "../components/ui";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { Composer } from "./thread/Composer";
import { renderEvent, Steps, type EventCtx } from "./thread/Events";
import { isCommand, TAB_LABEL, tabFor, useThreadRuns, WorkPanel, type LiveCmd, type Tab } from "./thread/WorkPanel";

export function Thread({ id }: { id?: string }) {
  const { setThreadBot } = useStore();
  useEffect(() => { if (!id) go("#/"); }, [id]);
  const { data, error } = useFetch(() => (id ? api.get<ThreadView>(`/api/threads/${id}`) : Promise.resolve(null)), [id]);
  useEffect(() => { if (data) setThreadBot(data.bot.id); return () => setThreadBot(null); }, [data, setThreadBot]);
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  return data ? <LiveThread d={data} /> : null;
}

const parseOrigin = (s: string | null): Origin | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

type Item = { key: string; el: ReactNode } | { key: string; steps: ThreadEvent[] };

/** Lays events out in order. Consecutive tool calls of one run share a Steps group; events that draw nothing don't
 * break a group, and a plan or delegation card draws once, where it first appeared, with its newest snapshot. */
function layout(events: ThreadEvent[], ctx: EventCtx): Item[] {
  const items: Item[] = [];
  const drawn = new Set<string>();
  let group: { turn: string | null; steps: ThreadEvent[] } | null = null;
  let lastAgent = false;  // the last drawn item, steps aside, was this member's message
  for (const e of events) {
    // A script's output is drawn inside its script step (Steps results), never as a row of its own.
    if (e.kind === "tool" && e.data.type === "scriptResult") continue;
    if (e.kind === "tool") {
      const last = items[items.length - 1];
      if (group && last && "steps" in last && last.steps === group.steps && group.turn === e.turn_id) group.steps.push(e);
      else { group = { turn: e.turn_id, steps: [e] }; items.push({ key: `g${e.id}`, steps: group.steps }); }
      continue;
    }
    // A surface updated in place (render_surface with its id) draws where it first appeared, with its newest spec.
    if ((e.kind === "plan" || e.kind === "delegation" || e.kind === "surface") && drawn.has(e.data.id)) continue;
    const el = renderEvent(e, e.kind === "agent" && lastAgent ? { ...ctx, cont: true } : ctx);
    if (el == null) continue;
    lastAgent = e.kind === "agent";
    if (e.kind === "plan" || e.kind === "delegation" || e.kind === "surface") drawn.add(e.data.id);
    group = null;
    items.push({ key: `e${e.id}`, el });
  }
  return items;
}
/** Whether the newest drawn item (steps aside) is the member's own message, so a streaming reply continues it. */
const endsWithAgent = (events: ThreadEvent[]) => { for (let i = events.length - 1; i >= 0; i--) { const k = events[i].kind; if (k === "tool") continue; return k === "agent"; } return false; };

function LiveThread({ d }: { d: ThreadView }) {
  const { bot } = useStore();
  const id = d.thread.id;
  const b = { ...d.bot, ...(bot(d.bot.id) || {}) };
  const origin = parseOrigin(d.thread.origin);
  const fromName = (origin?.kind === "delegated" && bot(origin.fromBot)?.name) || "Another member";

  const [events, setEvents] = useState(d.events);
  const [queued, setQueued] = useState(d.queued);
  const [painting, setPainting] = useState(d.painting || []);
  const [editing, setEditing] = useState<Img | null>(null);
  const [viewing, setViewing] = useState<{ im: Img; cmp?: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pits, setPits] = useState<Record<string, PitStop>>(() => Object.fromEntries(d.pitstops.map((p) => [p.id, p])));
  const [surfaces, setSurfaces] = useState<Record<string, SurfaceRow>>(() => Object.fromEntries(d.surfaces.map((s) => [s.id, s])));
  const [running, setRunning] = useState(d.thread.running);
  const [title, setTitle] = useState(d.thread.title);
  const [autonomy, setAutonomy] = useState(d.thread.autonomy || "ask");
  const [pinned, setPinned] = useState(!!d.thread.pinned);
  const [ctx, setCtx] = useState({ tokens: d.thread.ctx_tokens, window: d.thread.ctx_window });
  const [activity, setActivity] = useState("On track");
  const [streaming, setStreaming] = useState<{ itemId: string; text: string } | null>(null);
  const [lease, setLease] = useState(!!b.computer?.lease);
  const [closeSteps, setCloseSteps] = useState(0);
  // Work panel: the tab, whether it follows the live work, and whether it's open. Live commands stream in by item id.
  const [live, setLive] = useState<LiveCmd[]>(d.commands || []);
  const [tab, setTab] = useState<Tab>(d.commands?.length ? "terminal" : "files");
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState(d.thread.running || !!d.commands?.length);
  const [runsBump, setRunsBump] = useState(0);
  const chunks = useRef(new Map<string, string>());
  const chunkFrame = useRef(0);

  const stream = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  const liveIds = useRef(new Set<number>());
  const buffer = useRef<{ itemId: string; text: string } | null>(null);
  const frame = useRef(0);

  const nearBottom = () => { const s = stream.current; return !!s && s.scrollHeight - s.scrollTop - s.clientHeight < 160; };
  const scrollSoon = (force = false) => { stick.current = stick.current || force || nearBottom(); };
  useLayoutEffect(() => { if (stick.current && stream.current) { stream.current.scrollTop = stream.current.scrollHeight; stick.current = false; } });
  useEffect(() => { const t = setTimeout(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, 30); return () => clearTimeout(t); }, []);
  useEffect(() => () => { cancelAnimationFrame(frame.current); cancelAnimationFrame(chunkFrame.current); }, []);
  const show = (t: Tab | null) => { if (!t || !follow) return; setTab(t); setOpen(true); };

  useLive(async (e) => {
    if (e.type === "lease") { if (e.data.botId === b.id) setLease(e.data.held); return; }
    if (e.type === "thread") {
      if (e.data.id !== id) return;
      setRunning(e.data.status === "running" || e.data.status === "needs");
      if (e.data.status === "idle") setLive([]);
      if (e.data.title) setTitle(e.data.title);
      return;
    }
    if (e.type === "pitstop") {
      const ps = e.data.pitstop;
      if (ps && (e.data.threadId === id || e.data.botId === b.id)) setPits((m) => ({ ...m, [ps.id]: ps }));
      return;
    }
    if (!("threadId" in e.data) || e.data.threadId !== id) return;
    switch (e.type) {
      case "delta": {
        // Tokens land many times a frame: buffer them and draw once per animation frame.
        const x = e.data;
        if (buffer.current?.itemId !== x.itemId) buffer.current = { itemId: x.itemId, text: "" };
        buffer.current.text += x.text;
        frame.current ||= requestAnimationFrame(() => { frame.current = 0; scrollSoon(); setStreaming(buffer.current && { ...buffer.current }); });
        return;
      }
      case "activity": setActivity(e.data.text); return;
      case "output": {
        const x = e.data;
        if (x.command !== undefined) { setLive((l) => [...l.filter((c) => c.itemId !== x.itemId), { itemId: x.itemId, command: x.command!, cwd: x.cwd ?? null, startedAt: Date.now(), output: "", gate: x.gate ?? null }]); show("terminal"); return; }
        // Output can arrive many times a frame: collect chunks and apply them once per animation frame.
        chunks.current.set(x.itemId, (chunks.current.get(x.itemId) || "") + (x.chunk || ""));
        chunkFrame.current ||= requestAnimationFrame(() => {
          chunkFrame.current = 0;
          const add = new Map(chunks.current); chunks.current.clear();
          setLive((l) => l.map((c) => (add.has(c.itemId) ? { ...c, output: (c.output + add.get(c.itemId)).slice(-64000) } : c)));
        });
        return;
      }
      case "context": setCtx({ tokens: e.data.tokens, window: e.data.window }); return;
      case "queue": setQueued(e.data.queued); return;
      case "painting": { const x = e.data; scrollSoon(); setPainting((l) => x.done || !x.painting ? l.filter((p) => p.id !== x.id) : [...l.filter((p) => p.id !== x.id), x.painting]); return; }
      case "turn":
        setRunning(false); buffer.current = null; setStreaming(null); setCloseSteps((n) => n + 1); setRunsBump((n) => n + 1); setLive([]);
        return;
      case "event": {
        const x = e.data;
        if (x.kind === "agent") { buffer.current = null; setStreaming(null); }
        if (x.kind === "tool" && x.data.type === "commandExecution" && x.data.itemId) setLive((l) => l.filter((c) => c.itemId !== x.data.itemId));
        if (x.kind === "tool" && x.data.type === "fileChange") setRunsBump((n) => n + 1);
        show(tabFor({ ...x, thread_id: x.threadId, turn_id: x.turnId } as ThreadEvent));
        if (x.kind === "pitstop") {
          if (x.pitstop) { const ps = x.pitstop; setPits((m) => ({ ...m, [ps.id]: ps })); }
          else if (!pits[x.data.id]) {
            const list = await api.get<PitStop[]>("/api/pitstops?status=pending", { quiet: true }).catch(() => []);
            setPits((m) => ({ ...m, ...Object.fromEntries(list.map((p) => [p.id, p])) }));
          }
        }
        if (x.kind === "surface") {
          if (x.surface) { const s = x.surface; setSurfaces((m) => ({ ...m, [s.id]: s })); }
          else if (!surfaces[x.data.id]) {
            const fresh = await api.get<ThreadView>(`/api/threads/${id}`, { quiet: true }).catch(() => null);
            if (fresh) setSurfaces((m) => ({ ...m, ...Object.fromEntries(fresh.surfaces.map((s) => [s.id, s])) }));
          }
        }
        liveIds.current.add(x.id);
        scrollSoon(x.kind === "user");
        setEvents((list) => [...list, { id: x.id, thread_id: x.threadId, turn_id: x.turnId, kind: x.kind, data: x.data, ts: x.ts }]);
      }
    }
  });

  // Plans and delegations: the newest snapshot per id.
  const latest = useMemo(() => {
    const m = new Map<string, Record<string, any>>();
    for (const e of events) if (e.kind === "plan" || e.kind === "delegation") m.set(e.data.id, e.data);
    return m;
  }, [events]);
  const scriptResults = useMemo(() => new Map(events.filter((e) => e.kind === "tool" && e.data.type === "scriptResult").map((e) => [e.data.callId as string, e.data])), [events]);
  // Versions: which image came from which. The newest image is what the next message edits, until a new message is sent.
  const images = useMemo(() => indexImages(events), [events]);
  const lastUserAt = useMemo(() => { for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "user") return events[i].ts; return 0; }, [events]);
  const auto = images.latest && images.latest.at >= lastUserAt && images.latest.id !== dismissed ? images.latest : null;
  const label = (im: Img) => `${imgName(im.path)} · v${images.chain(im.id).length}`;
  const evCtx: EventCtx = {
    b, fromName, pits, latest, images,
    onView: (im) => setViewing({ im }), onCompare: (im) => setViewing({ im, cmp: true }), onEdit: (im) => { setViewing(null); setEditing(im); },
    onMore: (im) => api.post(`/api/threads/${id}/messages`, { text: "Make 4 more variations of this image, same brief.", mode: "queue", edit: { image: im.path } }),
    onKeep: (imageId) => api.post(`/api/images/${imageId}/keep`),
    surface: (sid) => { const s = surfaces[sid]; return s ? <ThreadSurface s={s} /> : null; },
  };
  const items = layout(events, evCtx);
  // The last group is open on load if the run is still going; groups that arrive live start open.
  const openOnLoad = useRef<string | null>(null);
  if (openOnLoad.current === null) { const last = items[items.length - 1]; openOnLoad.current = d.thread.running && last && "steps" in last ? last.key : ""; }

  const plan = useMemo(() => { let p: PlanSnapshot | null = null; for (const e of events) if (e.kind === "plan") p = e.data as PlanSnapshot; return p; }, [events]);
  const card = { ...b, threads: b.threads || [], computer: b.computer || { up: false, desktop: false, startedAt: null, lease: false } } as BotCard;
  const runs = useThreadRuns(b.id, id, runsBump);
  const tabs = (["plan", "screen", "terminal", "files"] as Tab[]).filter((t) =>
    t === "plan" ? !!plan : t === "screen" ? card.computer.desktop || events.some((e) => tabFor(e) === "screen") : t === "terminal" ? live.length > 0 || events.some(isCommand) : runs.length > 0);
  const cur = tabs.includes(tab) ? tab : tabs[0];
  const showPanel = open && tabs.length > 0;
  const handBack = async () => { await api.post(`/api/bots/${b.id}/computer/handback`); setLease(false); };

  return (
    <div className={`threadpage ${showPanel ? "withwork" : ""}`}>
      <section className="convo">
        <header className="thd">
          <TitleMenu id={id} title={title} onRenamed={setTitle} b={card} pinned={pinned} onPinned={setPinned} />
          {origin ? <OriginChip origin={origin} threadId={id} b={b} /> : <a className="who" style={hueStyle(b.hue)} href={`#/crew/${b.id}`} title={`${b.name}'s profile`}><Face b={b} size="xs" mood={running ? "working" : undefined} />{b.name}</a>}
          <span style={{ flex: 1 }} />
          {lease && <button className="pc-pill sig s" onClick={handBack}>Hand back</button>}
          <Power b={card} />
          {!showPanel && tabs.length > 0 && <button className="reo" title="Open the work panel" onClick={() => setOpen(true)}><Icon name="panel" size={14} />{TAB_LABEL[cur!]}</button>}
        </header>
        <div ref={stream} className="stream">
          {items.map((it) => "steps" in it
            ? <Steps key={it.key} events={it.steps} results={scriptResults} closeSignal={closeSteps} initialOpen={it.key === openOnLoad.current || liveIds.current.has(it.steps[0].id)} />
            : <Fragment key={it.key}>{it.el}</Fragment>)}
          {streaming && <div className={`msg bot${endsWithAgent(events) ? " cont" : ""}`}>{endsWithAgent(events) ? <span /> : <Face b={b} size="sm" mood="working" />}<div className="md">{streaming.text}</div></div>}
          {painting.map((p) => <CatchThePaint key={p.id} p={p} b={b} />)}
          <div className={`live ${running ? "" : "hidden"}`}><Loader /><span>{activity}</span></div>
        </div>
        <Composer threadId={id} name={b.name} running={running} queued={queued} fromName={fromName}
          target={auto ? { path: auto.path, label: label(auto), src: imgSrc(auto) } : null}
          onClearTarget={() => auto && setDismissed(auto.id)} autonomy={autonomy} onAutonomy={setAutonomy} ctx={ctx} />
        {editing && <EditPanel img={editing} version={images.chain(editing.id).length} b={b} threadId={id} onClose={() => setEditing(null)} />}
        {viewing && <Viewer I={images} start={viewing.im} compare={viewing.cmp} onClose={() => setViewing(null)} onEdit={evCtx.onEdit} onMore={evCtx.onMore} onKeep={evCtx.onKeep} />}
      </section>
      {showPanel && <WorkPanel b={card} threadId={id} events={events} plan={plan} live={live} runs={runs} tab={cur!} tabs={tabs} follow={follow} running={running} lease={lease}
        onTab={(t) => { setTab(t); setFollow(false); }} onFollow={() => setFollow(true)} onClose={() => setOpen(false)} onHandBack={handBack} />}
    </div>
  );
}

/** The thread title is its menu: rename, auto-name, context, pin, files, archive. */
function TitleMenu({ id, title, onRenamed, b, pinned, onPinned }: { id: string; title: string; onRenamed: (t: string) => void; b: BotCard; pinned: boolean; onPinned: (p: boolean) => void }) {
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

/** What's awake on the member's computer: the shell (stage 1) and the screen (stage 2) wake and sleep on their own. */
function Power({ b }: { b: BotCard }) {
  const { up, desktop } = b.computer;
  const tip = !up ? "Computer in the garage: it wakes on the first command or page" : desktop ? "Shell and screen up · back in the garage after 10 idle minutes" : "Shell up, screen asleep · back in the garage after 10 idle minutes";
  return <span className="power" title={tip}><span className={up ? "up" : ""}><i />Shell</span><span className={desktop ? "up" : ""}><i />Screen</span></span>;
}

// Where a thread came from: routed by the front door (its pill changes who takes it) or asked by another member.
function OriginChip({ origin: o, threadId, b }: { origin: Origin; threadId: string; b: { id: string; name: string; hue: string; shape: string } }) {
  const { bot } = useStore();
  const pill = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
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
      <span className="pc-lab">{o.by === "driver" ? "You picked" : o.by === "names" ? "You named several" : "Routed"}</span>
      <button ref={pill} className="to alt" style={hueStyle(b.hue)} title={tip} onClick={() => setMenu(true)}><Face b={b} size="xs" />{b.name}<Chev /></button>
      {menu && pill.current && <MemberMenu anchor={pill.current} auto={false} exclude={b.id} onClose={() => setMenu(false)} onPick={reroute} />}
    </span>
  );
}

function ThreadSurface({ s }: { s: SurfaceRow }) {
  const [saved, setSaved] = useState(!!s.saved);
  const toggle = async () => { const next = !saved; setSaved(next); await api.post(`/api/surfaces/${s.id}/save`, { saved: next }); };
  return (
    <Surface s={s} lockOnAction extra={<button className="small faint" onClick={toggle}>{s.data ? (saved ? "On the Wall" : "Pin to Wall") : saved ? "Saved to Library" : "Keep in Library"}</button>}
      onAction={async (action, values) => { await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); }} />
  );
}
