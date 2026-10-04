// A thread: the transcript (live over SSE), the composer, and the side panel.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CatchThePaint } from "./thread/Painting";
import type { Origin, PitStop, Surface as SurfaceRow, ThreadEvent, ThreadView } from "../../../shared/types";
import { MemberMenu } from "../components/MemberMenu";
import { Surface } from "../components/Surface";
import { Chev, Face, hueStyle, Loader } from "../components/ui";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { Composer } from "./thread/Composer";
import { renderEvent, Steps, type EventCtx } from "./thread/Events";
import { Panel } from "./thread/Panel";

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
  const [pits, setPits] = useState<Record<string, PitStop>>(() => Object.fromEntries(d.pitstops.map((p) => [p.id, p])));
  const [surfaces, setSurfaces] = useState<Record<string, SurfaceRow>>(() => Object.fromEntries(d.surfaces.map((s) => [s.id, s])));
  const [running, setRunning] = useState(d.thread.running);
  const [title, setTitle] = useState(d.thread.title);
  const [autonomy, setAutonomy] = useState(d.thread.autonomy || "ask");
  const [ctx, setCtx] = useState({ tokens: d.thread.ctx_tokens, window: d.thread.ctx_window });
  const [activity, setActivity] = useState("On track");
  const [streaming, setStreaming] = useState<{ itemId: string; text: string } | null>(null);
  const [lease, setLease] = useState(!!b.computer?.lease);
  const [closeSteps, setCloseSteps] = useState(0);

  const stream = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  const liveIds = useRef(new Set<number>());
  const buffer = useRef<{ itemId: string; text: string } | null>(null);
  const frame = useRef(0);

  const nearBottom = () => { const s = stream.current; return !!s && s.scrollHeight - s.scrollTop - s.clientHeight < 160; };
  const scrollSoon = (force = false) => { stick.current = stick.current || force || nearBottom(); };
  useLayoutEffect(() => { if (stick.current && stream.current) { stream.current.scrollTop = stream.current.scrollHeight; stick.current = false; } });
  useEffect(() => { const t = setTimeout(() => { if (stream.current) stream.current.scrollTop = stream.current.scrollHeight; }, 30); return () => clearTimeout(t); }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useLive(async (e) => {
    if (e.type === "lease") { if (e.data.botId === b.id) setLease(e.data.held); return; }
    if (e.type === "thread") {
      if (e.data.id !== id) return;
      setRunning(e.data.status === "running" || e.data.status === "needs");
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
      case "context": setCtx({ tokens: e.data.tokens, window: e.data.window }); return;
      case "queue": setQueued(e.data.queued); return;
      case "painting": { const x = e.data; scrollSoon(); setPainting((l) => x.done || !x.painting ? l.filter((p) => p.id !== x.id) : [...l.filter((p) => p.id !== x.id), x.painting]); return; }
      case "turn":
        setRunning(false); buffer.current = null; setStreaming(null); setCloseSteps((n) => n + 1);
        return;
      case "event": {
        const x = e.data;
        if (x.kind === "agent") { buffer.current = null; setStreaming(null); }
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
  const evCtx: EventCtx = {
    b, fromName, pits, latest,
    surface: (sid) => { const s = surfaces[sid]; return s ? <ThreadSurface s={s} /> : null; },
  };
  const items = layout(events, evCtx);
  // The last group is open on load if the run is still going; groups that arrive live start open.
  const openOnLoad = useRef<string | null>(null);
  if (openOnLoad.current === null) { const last = items[items.length - 1]; openOnLoad.current = d.thread.running && last && "steps" in last ? last.key : ""; }

  return (
    <div className="threadpage">
      <section className="convo">
        <header><Face b={b} size="sm" /><Title id={id} title={title} onRenamed={setTitle} />{origin ? <OriginChip origin={origin} threadId={id} b={b} /> : <span className="pc-chip">{b.name}</span>}<Autonomy id={id} value={autonomy} onChange={setAutonomy} /></header>
        <div ref={stream} className="stream">
          {items.map((it) => "steps" in it
            ? <Steps key={it.key} events={it.steps} results={scriptResults} closeSignal={closeSteps} initialOpen={it.key === openOnLoad.current || liveIds.current.has(it.steps[0].id)} />
            : <Fragment key={it.key}>{it.el}</Fragment>)}
          {streaming && <div className={`msg bot${endsWithAgent(events) ? " cont" : ""}`}>{endsWithAgent(events) ? <span /> : <Face b={b} size="sm" mood="working" />}<div className="md">{streaming.text}</div></div>}
          {painting.map((p) => <CatchThePaint key={p.id} p={p} b={b} />)}
          <div className={`live ${running ? "" : "hidden"}`}><Loader /><span>{activity}</span></div>
        </div>
        <Composer threadId={id} name={b.name} running={running} queued={queued} fromName={fromName} />
      </section>
      <Panel id={id} b={b} ctx={ctx} lease={lease} onHandedBack={() => setLease(false)} />
    </div>
  );
}

// How much this thread runs without pit stops (server: runtime/autonomy.ts). YOLO is drawn in the bad tone so it's
// never on by accident or forgotten.
const AUTONOMY = [
  ["ask", "Ask me", "Pit stops whenever jev isn't sure"],
  ["handsfree", "Hands-free", "Stops only for paying, signing in, sending, sharing, deleting, and look-alike or non-https sites"],
  ["yolo", "YOLO", "No pit stops, paying and sending included. Only hard blocks and blocked sites stop it"],
] as const;
function Autonomy({ id, value, onChange }: { id: string; value: string; onChange: (a: string) => void }) {
  const set = async (a: string) => {
    if (a === value) return;
    await api.patch(`/api/threads/${id}`, { autonomy: a });
    onChange(a);
    toast(AUTONOMY.find(([k]) => k === a)![1]);
  };
  return <div className="autonomy" role="group" aria-label="Pit stops for this thread">
    {AUTONOMY.map(([k, label, tip]) => <button key={k} title={tip} aria-pressed={value === k} className={`pc-pill s ${value === k ? (k === "yolo" ? "yolo" : "sig") : "o"}`} onClick={() => set(k)}>{label}</button>)}
  </div>;
}

function Title({ id, title, onRenamed }: { id: string; title: string; onRenamed: (t: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const auto = async () => { const r = await api.post<{ title: string }>(`/api/threads/${id}/retitle`); onRenamed(r.title); };
  if (editing == null) return <h1 className="pc-h2" title="Click to rename" onClick={() => setEditing(title)}>{title}<button className="small faint" style={{ marginLeft: 8 }} title="Name it from the conversation" onClick={(e) => { e.stopPropagation(); auto(); }}>Auto-name</button></h1>;
  const done = async () => { const t = editing || title; setEditing(null); await api.patch(`/api/threads/${id}`, { title: t }); onRenamed(t); };
  return <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />;
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
