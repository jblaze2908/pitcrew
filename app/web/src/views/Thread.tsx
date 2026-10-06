// A thread: the transcript (live over SSE), the composer, and the side panel.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CatchThePaint } from "./thread/Painting";
import { EditPanel } from "./thread/ImageEdit";
import { Viewer } from "./thread/Viewer";
import { indexImages, imgName, imgSrc, type Img } from "../lib/images";
import type { BotCard, Origin, PitStop, PlanSnapshot, Surface as SurfaceRow, ThreadEvent, ThreadView } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { Surface } from "../components/Surface";
import { Face, hueStyle, Loader } from "../components/ui";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { useLive, useResync } from "../lib/live";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { Composer } from "./thread/Composer";
import { SideAsk } from "./thread/SideAsk";
import type { EventCtx } from "./thread/Events";
import { noteFolds } from "./thread/Notes";
import { Steps } from "./thread/Steps";
import { OriginChip, TitleMenu } from "./thread/Header";
import { endsWithAgent, layout } from "./thread/layout";
import { isCommand, TAB_LABEL, tabFor, useThreadRuns, WorkPanel, type LiveCmd, type Tab } from "./thread/WorkPanel";

export function Thread({ id }: { id?: string }) {
  const { S, refresh } = useStore();
  useEffect(() => { if (!id) go("#/"); }, [id]);
  const { data, error } = useFetch(() => (id ? api.get<ThreadView>(`/api/threads/${id}`) : Promise.resolve(null)), [id]);
  // Loading the thread marked it seen on the server; Home's unread count catches up (only when it had any to drop).
  useEffect(() => { if (data && S.unread) refresh(); }, [data]);
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  return data ? <LiveThread d={data} /> : null;
}

const parseOrigin = (s: string | null): Origin | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function LiveThread({ d }: { d: ThreadView }) {
  const { bot, refresh } = useStore();
  const id = d.thread.id;
  const b = useMemo(() => ({ ...d.bot, ...(bot(d.bot.id) || {}) }), [d.bot, bot]);
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
  // After a dropped stream, take the server's word for the transcript and whether it's still running.
  useResync(async () => {
    const f = await api.get<ThreadView>(`/api/threads/${d.thread.id}`, { quiet: true }).catch(() => null);
    if (!f) return;
    setEvents(f.events); setQueued(f.queued); setRunning(f.thread.running);
    setPits(Object.fromEntries(f.pitstops.map((p) => [p.id, p]))); setLive(f.commands || []);
    if (!f.thread.running) { buffer.current = null; setStreaming(null); }
  });
  const [title, setTitle] = useState(d.thread.title);
  const [autonomy, setAutonomy] = useState(d.thread.autonomy || "ask");
  const [pinned, setPinned] = useState(!!d.thread.pinned);
  const [ctx, setCtx] = useState({ tokens: d.thread.ctx_tokens, window: d.thread.ctx_window });
  const [activity, setActivity] = useState("Working");
  const [streaming, setStreaming] = useState<{ itemId: string; text: string } | null>(null);
  const [lease, setLease] = useState(!!b.computer?.lease);
  const [closeSteps, setCloseSteps] = useState(0);
  // Work panel: the tab, whether it follows the live work, and whether it's open. Live commands stream in by item id.
  const [live, setLive] = useState<LiveCmd[]>(d.commands || []);
  const [tab, setTab] = useState<Tab>(d.commands?.length ? "terminal" : "files");
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState(d.thread.running || !!d.commands?.length);
  const [runsBump, setRunsBump] = useState(0);
  const [side, setSide] = useState(false);
  const chunks = useRef(new Map<string, string>());
  // A run that ends while you watch is seen; one that ends in a background tab waits until you come back to it.
  const endedUnseen = useRef(false);
  const seen = () => { endedUnseen.current = false; api.post(`/api/threads/${id}/seen`, undefined, { quiet: true }).then(refresh).catch(() => {}); };
  useEffect(() => {
    const vis = () => { if (document.visibilityState === "visible" && endedUnseen.current) seen(); };
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ";") { e.preventDefault(); setSide((s) => !s); } };
    document.addEventListener("visibilitychange", vis); window.addEventListener("keydown", key);
    return () => { document.removeEventListener("visibilitychange", vis); window.removeEventListener("keydown", key); };
  }, [id]);
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
        endedUnseen.current = true;
        if (document.visibilityState === "visible") seen();
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
  // Copy and Rewind sit under the last reply of each finished run that isn't rewound yet (the running one has none).
  const rewindIds = useMemo(() => {
    const lastOf = new Map<string, number>();
    for (const e of events) if (e.kind === "agent" && e.turn_id && !e.rewound) lastOf.set(e.turn_id, e.id);
    if (running) { const cur = [...events].reverse().find((e) => e.turn_id)?.turn_id; if (cur) lastOf.delete(cur); }
    return new Set(lastOf.values());
  }, [events, running]);
  const folds = useMemo(() => noteFolds(events), [events]);
  // Memoised so a streaming frame (a delta, a terminal chunk) redraws only the live parts, not every message's markdown.
  const evCtx = useMemo<EventCtx>(() => ({
    b, fromName, pits, latest, images, hide: folds.hide, modeNote: folds.modeNote, autonomy,
    rewind: { ids: rewindIds, onRewound: async () => { const fresh = await api.get<ThreadView>(`/api/threads/${id}`, { quiet: true }).catch(() => null); if (fresh) setEvents(fresh.events); } },
    onAutonomy: async (a) => { await api.patch(`/api/threads/${id}`, { autonomy: a }); setAutonomy(a); },
    onView: (im) => setViewing({ im }), onCompare: (im) => setViewing({ im, cmp: true }), onEdit: (im) => { setViewing(null); setEditing(im); },
    onMore: (im) => api.post(`/api/threads/${id}/messages`, { text: "Make 4 more variations of this image, same brief.", mode: "queue", edit: { image: im.path } }),
    onKeep: (imageId) => api.post(`/api/images/${imageId}/keep`),
    surface: (sid) => { const s = surfaces[sid]; return s ? <ThreadSurface s={s} /> : null; },
    onPlan: () => { setTab("plan"); setFollow(false); setOpen(true); },
    onContinue: running ? undefined : () => api.post(`/api/threads/${id}/messages`, { text: "continue", mode: "auto" }),
  }), [b, fromName, pits, latest, images, folds, autonomy, rewindIds, id, surfaces, running]);
  const items = useMemo(() => layout(events, evCtx), [events, evCtx]);
  const afterAgent = useMemo(() => endsWithAgent(events, pits), [events, pits]);
  // The last group is open on load if the run is still going; groups that arrive live start open.
  const openOnLoad = useRef<string | null>(null);
  if (openOnLoad.current === null) { const last = items[items.length - 1]; openOnLoad.current = d.thread.running && last && "steps" in last ? last.key : ""; }
  const drawn = useMemo(() => items.map(function draw(it): ReactNode {
    if ("steps" in it) return <Steps key={it.key} events={it.steps} pits={pits} results={scriptResults} closeSignal={closeSteps} initialOpen={it.key === openOnLoad.current || liveIds.current.has(it.steps[0].id)} />;
    if ("rewound" in it) {
      const n = it.rewound.filter((e) => e.kind === "user" || e.kind === "agent").length;
      return <details key={it.key} className="rewound"><summary>{`Rewound · ${plural(n, "message")}`}<Icon name="chev" size={12} /></summary>
        <div className="rw-body">{layout(it.rewound, { ...evCtx, rewind: undefined, onContinue: undefined }, true).map(draw)}</div></details>;
    }
    return <Fragment key={it.key}>{it.el}</Fragment>;
  }), [items, pits, scriptResults, closeSteps, evCtx]);

  const plan = useMemo(() => { let p: PlanSnapshot | null = null; for (const e of events) if (e.kind === "plan") p = e.data as PlanSnapshot; return p; }, [events]);
  const card = { ...b, threads: b.threads || [], computer: b.computer || { up: false, desktop: false, startedAt: null, lease: false } } as BotCard;
  const runs = useThreadRuns(b.id, id, runsBump);
  const seenScreen = useMemo(() => events.some((e) => tabFor(e) === "screen"), [events]), seenCmd = useMemo(() => events.some(isCommand), [events]);
  const tabs = (["plan", "screen", "terminal", "files"] as Tab[]).filter((t) =>
    t === "plan" ? !!plan : t === "screen" ? card.computer.desktop || seenScreen : t === "terminal" ? live.length > 0 || seenCmd : runs.length > 0);
  const cur = tabs.includes(tab) ? tab : tabs[0];
  // The side question takes the right column while it's open; the work panel comes back when it closes.
  const showPanel = open && tabs.length > 0 && !side;
  const handBack = async () => { await api.post(`/api/bots/${b.id}/computer/handback`); setLease(false); };

  return (
    <div className={`threadpage ${side ? "withbtw" : showPanel ? "withwork" : ""}`}>
      <section className="convo">
        <header className="thd">
          <TitleMenu id={id} title={title} onRenamed={setTitle} b={card} pinned={pinned} onPinned={setPinned} />
          {origin ? <OriginChip origin={origin} threadId={id} b={b} /> : <a className="who" style={hueStyle(b.hue)} href={`#/crew/${b.id}`} title={`${b.name}'s profile`}><Face b={b} size="xs" mood={running ? "working" : "idle"} />{b.name}</a>}
          <span style={{ flex: 1 }} />
          {lease && <button className="pc-pill s" onClick={handBack}>Hand back</button>}
          {!showPanel && !side && tabs.length > 0 && <button className="reo" title="Open the work panel" onClick={() => setOpen(true)}><Icon name="panel" size={14} />{TAB_LABEL[cur!]}</button>}
        </header>
        <div ref={stream} className="stream">
          {drawn}
          {streaming && <div className={`msg bot${afterAgent ? " cont" : ""}`}>{afterAgent ? <span /> : <Face b={b} size="sm" mood="working" />}<div className="md">{streaming.text}</div></div>}
          {painting.map((p) => <CatchThePaint key={p.id} p={p} b={b} />)}
          <div className={`live ${running ? "" : "hidden"}`}><Loader /><span>{activity}</span></div>
        </div>
        <Composer threadId={id} name={b.name} running={running} queued={queued} fromName={fromName}
          target={auto ? { path: auto.path, label: label(auto), src: imgSrc(auto) } : null}
          onClearTarget={() => auto && setDismissed(auto.id)} autonomy={autonomy} onAutonomy={setAutonomy} ctx={ctx} side={side} onSide={() => setSide((s) => !s)} />
        {editing && <EditPanel img={editing} version={images.chain(editing.id).length} b={b} threadId={id} onClose={() => setEditing(null)} />}
        {viewing && <Viewer I={images} start={viewing.im} compare={viewing.cmp} onClose={() => setViewing(null)} onEdit={evCtx.onEdit} onMore={evCtx.onMore} onKeep={evCtx.onKeep} />}
      </section>
      {side && <SideAsk threadId={id} b={b} running={running} onClose={() => setSide(false)} />}
      {showPanel && <WorkPanel b={card} threadId={id} events={events} plan={plan} live={live} runs={runs} tab={cur!} tabs={tabs} follow={follow} running={running} lease={lease}
        onTab={(t) => { setTab(t); setFollow(false); }} onFollow={() => setFollow(true)} onClose={() => setOpen(false)} onHandBack={handBack} />}
    </div>
  );
}

function ThreadSurface({ s }: { s: SurfaceRow }) {
  const [saved, setSaved] = useState(!!s.saved);
  const toggle = async () => { const next = !saved; setSaved(next); await api.post(`/api/surfaces/${s.id}/save`, { saved: next }); };
  return (
    <Surface s={s} lockOnAction extra={<button className="small faint" onClick={toggle}>{s.data ? (saved ? "On Home" : "Pin to Home") : saved ? "Saved to Library" : "Keep in Library"}</button>} />
  );
}
