// Home (Draft M4b), also the new-thread page: the greeting and the ask box first, then what waits on you one row each,
// then one timeline of today. Sending opens the new thread. Rarer things (memory notes, dashboards, suggestions) fold below.
import { useEffect } from "react";
import type { KeptSurface } from "../../../shared/types";
import { AskBox } from "../components/AskBox";
import { DigestCard } from "../components/Engram";
import { PitCard } from "../components/PitCard";
import { Surface } from "../components/Surface";
import { api } from "../lib/api";
import { hourNow } from "../lib/format";
import { go } from "../lib/router";
import { connected, useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { Today } from "./home/Today";
import { Waiting } from "./home/Waiting";

interface Idea { id: string; bot_name: string; area: string; title: string; evidence: string; proposal: string; votes: number }

/** to: #/new/<member> starts the box on that member; focus: #/new puts the caret in the box. */
export function Wall({ to, focus }: { to?: string; focus?: boolean }) {
  const { S, bot } = useStore();
  const hour = hourNow();
  const greet = hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  const who = to ? bot(to) : undefined;
  // Pit stops block a run; memory notes only wait for your review, so they fold below and don't count.
  const pits = S.pitstops.filter((p) => p.kind !== "engram"), notes = S.pitstops.filter((p) => p.kind === "engram");
  // Home and #/new share one mounted view, so New thread has to bring the box back into sight itself.
  useEffect(() => {
    if (!focus) return;
    document.getElementById("view")?.scrollTo(0, 0);
    document.querySelector<HTMLTextAreaElement>(".home .ask textarea")?.focus();
  }, [focus, to]);
  // Kept dashboards bound to a ledger read it on view (server/ledger.ts); suggestions come from the crew's retros (runtime/retro.ts).
  const boards = useFetch(() => api.get<KeptSurface[]>("/api/surfaces?bound=1", { quiet: true }), []);
  const ideas = useFetch(() => api.get<Idea[]>("/api/improvements", { quiet: true }), []);
  const decideIdea = async (id: string, status: string) => { await api.post(`/api/improvements/${id}`, { status }); toast(status === "accepted" ? "Accepted" : "Dismissed"); ideas.reload(); };
  return (
    <div className="page home">
      <h1 className="hello"><pc-logo size="md" wordmark="none" />{who ? `New thread with ${who.name}` : `${greet}, ${S.driverName}`}</h1>
      <AskBox key={to || "auto"} to={who?.id ?? null} onSent={(r) => go(`#/t/${r.threadId}`)} />
      {!connected(S) && (
        <p className="setup">Connect a model provider to start: add an OpenRouter or AI Gateway key, or sign in with ChatGPT. The crew runs on whichever you pick.</p>)}
      {pits.length > 0 && <Waiting pits={pits} />}
      <Today />
      <p className="qf">
        <span />
        <span><a href="#/threads">All threads</a><a href="#/telemetry">All activity</a></span>
      </p>
      <div className="folds">
        {notes.length > 0 && (
          <details><summary>{`Memory notes · ${notes.length} to review`}</summary>
            <div className="grid2">{notes.slice(0, 8).map((p) => <PitCard key={p.id} p={p} />)}</div></details>)}
        {!!boards.data?.length && (
          <details><summary>{`Dashboards · ${boards.data.length}`}</summary>
            <div className="grid2">{boards.data.slice(0, 4).map((s) => <Surface key={s.id} s={s} extra={<a className="small faint" href={`#/t/${s.thread_id}`} style={{ marginLeft: "auto" }}>{s.bot_name}</a>}
              onAction={async (action, values) => { await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); }} />)}</div></details>)}
        {!!ideas.data?.length && (
          <details><summary>{`Crew suggestions · ${ideas.data.length}`}</summary>
            <div className="col">{ideas.data.slice(0, 8).map((i) => (
              <div key={i.id} className="pc-card col" style={{ gap: 6 }}>
                <div className="spread"><b>{i.title}</b><span className="small faint">{`${i.bot_name} · ${i.area}${i.votes > 1 ? ` · ${i.votes}×` : ""}`}</span></div>
                <p className="small">{i.proposal}</p><p className="small muted">{i.evidence.slice(0, 400)}</p>
                <div className="acts"><button className="pc-pill s" onClick={() => decideIdea(i.id, "accepted")}>Accept</button><button className="pc-pill o s" onClick={() => decideIdea(i.id, "dismissed")}>Dismiss</button></div>
              </div>))}</div></details>)}
        {S.engram.linked && <details><summary>This week in memory</summary><DigestCard /></details>}
      </div>
    </div>
  );
}
