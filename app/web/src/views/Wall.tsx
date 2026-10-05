// Home: ask the crew, decide what's waiting, see what's on track and pick up where you left off. The rest folds away.
import { useState } from "react";
import { AskBox } from "../components/AskBox";
import { AsksList } from "../components/AsksList";
import { DigestCard } from "../components/Engram";
import { PitCard } from "../components/PitCard";
import { Surface } from "../components/Surface";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import type { KeptSurface } from "../../../shared/types";
import { Face, Loader } from "../components/ui";
import { api } from "../lib/api";
import { ago, hourNow, plural, usd } from "../lib/format";
import { connected, useStore } from "../lib/store";

interface Idea { id: string; bot_name: string; area: string; title: string; evidence: string; proposal: string; votes: number }
export function Wall() {
  const { S, setS } = useStore();
  const [asksVersion, setAsksVersion] = useState(0);
  const hour = hourNow();
  const greet = hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  // Pit stops block a run; Engram notes only wait for your review, so they sit apart and don't count.
  const pits = S.pitstops.filter((p) => p.kind !== "engram"), notes = S.pitstops.filter((p) => p.kind === "engram");
  const n = pits.length;
  // On track and recent come from the state's threads (12 a member): no extra fetch.
  const rows = S.bots.flatMap((b) => b.threads.map((t) => ({ ...t, b })));
  const waiting = new Set(pits.map((p) => p.thread_id));
  const track = rows.filter((t) => t.status === "running");
  const recent = rows.filter((t) => t.status === "idle" && !waiting.has(t.id)).sort((x, y) => y.updated_at - x.updated_at).slice(0, 3);
  const shells = S.bots.filter((b) => b.computer.up).length, screens = S.bots.filter((b) => b.computer.desktop).length;
  // Kept dashboards bound to a ledger: always current, since they read the ledger on view (server/ledger.ts).
  const boards = useFetch(() => api.get<KeptSurface[]>("/api/surfaces?bound=1", { quiet: true }), []);
  // Harness suggestions the crew filed after retros (runtime/retro.ts): accept the ones worth building, dismiss the rest.
  const ideas = useFetch(() => api.get<Idea[]>("/api/improvements", { quiet: true }), []);
  const decideIdea = async (id: string, status: string) => { await api.post(`/api/improvements/${id}`, { status }); toast(status === "accepted" ? "Accepted" : "Dismissed"); ideas.reload(); };
  return (
    <div className="page">
      <div className="spread"><h1 className="pc-hello">{`${greet}, ${S.driverName}. `}{n ? <em>{`${plural(n, "pit stop")} need${n > 1 ? "" : "s"} you.`}</em> : "All quiet."}</h1></div>
      <AskBox onSent={() => setAsksVersion((v) => v + 1)} />
      <AsksList version={asksVersion} />
      {!connected(S) && (
        <div className="pc-card row">
          <pc-bot size="md" hue="c1" mood="sleep" />
          <div className="col" style={{ flex: 1, gap: 2 }}><b className="pc-h3">Connect a model provider to start</b><p className="muted small">Add an OpenRouter or AI Gateway key, or sign in with ChatGPT. The crew runs on whichever you pick.</p></div>
          <a className="pc-pill s" href="#/settings">Providers</a>
        </div>)}
      {S.paused && (
        <div className="pc-card row">
          <b className="sig" style={{ flex: 1 }}>The crew is stopped. Nothing runs until you resume.</b>
          <button className="pc-pill s" onClick={async () => setS(await api.post("/api/resume"))}>Resume the crew</button>
        </div>)}
      {n > 0 && (
        <section className="col">
          <div className="spread"><p className="pc-lab sig">Box, box · waiting on you</p>{n > 1 && <a className="small faint" href="#/pitstops">Decide all ›</a>}</div>
          <div className="grid2">{pits.slice(0, 6).map((p) => <PitCard key={p.id} p={p} />)}</div>
        </section>)}
      {track.length > 0 && (
        <section className="col">
          <p className="pc-lab">On track</p>
          <div className="pc-card tight">{track.map((t) => (
            <a key={t.id} className="hrow" href={`#/t/${t.id}`}><Face b={t.b} size="sm" mood="working" /><b className="trunc">{t.title}</b><span className="small faint">{t.b.name}</span><Loader /></a>))}</div>
        </section>)}
      {recent.length > 0 && (
        <section className="col">
          <div className="spread"><p className="pc-lab">Pick up where you left off</p><a className="small faint" href="#/threads">All threads ›</a></div>
          <div className="pc-card tight">{recent.map((t) => (
            <a key={t.id} className="hrow" href={`#/t/${t.id}`}><Face b={t.b} size="xs" /><b className="trunc">{t.title}</b><span className="small faint">{t.b.name}</span><span className="pc-m small faint">{ago(t.updated_at)}</span></a>))}</div>
        </section>)}
      <div className="hfoot">
        <span>Today <b>{usd(S.today.usd)}</b>{` · ${plural(S.today.runs, "run")}`}</span>
        <span>Week <b>{usd(S.week.usd)}</b>{` of ${usd(S.weekCap)}`}</span>
        <span>{shells || screens ? `${shells} shell${shells === 1 ? "" : "s"} · ${screens} screen${screens === 1 ? "" : "s"} up` : "all in the garage"}</span>
        <span style={{ flex: 1 }} /><a href="#/telemetry">Telemetry ›</a>
      </div>
      {notes.length > 0 && (
        <details className="col">
          <summary className="pc-lab">{`Notes for Engram · ${notes.length} to review`}</summary>
          <div className="grid2">{notes.slice(0, 8).map((p) => <PitCard key={p.id} p={p} />)}</div>
        </details>)}
      {!!boards.data?.length && (
        <details className="col">
          <summary className="pc-lab">{`Dashboards · ${boards.data.length}`}</summary>
          <div className="grid2">{boards.data.slice(0, 4).map((s) => <Surface key={s.id} s={s} extra={<a className="small faint" href={`#/t/${s.thread_id}`} style={{ marginLeft: "auto" }}>{s.bot_name}</a>}
            onAction={async (action, values) => { await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); }} />)}</div>
        </details>)}
      {!!ideas.data?.length && (
        <details className="col">
          <summary className="pc-lab">{`Crew suggestions · ${ideas.data.length}`}</summary>
          <div className="col">{ideas.data.slice(0, 8).map((i) => (
            <div key={i.id} className="pc-card col" style={{ gap: 6 }}>
              <div className="spread"><b>{i.title}</b><span className="small faint">{`${i.bot_name} · ${i.area}${i.votes > 1 ? ` · ${i.votes}×` : ""}`}</span></div>
              <p className="small">{i.proposal}</p><p className="small muted">{i.evidence.slice(0, 400)}</p>
              <div className="acts"><button className="pc-pill sig s" onClick={() => decideIdea(i.id, "accepted")}>Accept</button><button className="pc-pill o s" onClick={() => decideIdea(i.id, "dismissed")}>Dismiss</button></div>
            </div>))}</div>
        </details>)}
      {S.engram.linked && <details className="col"><summary className="pc-lab">Engram digest</summary><DigestCard /></details>}
    </div>
  );
}
