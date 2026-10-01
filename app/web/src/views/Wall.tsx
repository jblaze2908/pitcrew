// The pit wall: the front door, your asks, what's waiting on you, Engram's digest, spend, and the crew.
import { useState } from "react";
import { AskBox } from "../components/AskBox";
import { AsksList } from "../components/AsksList";
import { CrewCard } from "../components/CrewCard";
import { DigestCard } from "../components/Engram";
import { PitCard } from "../components/PitCard";
import { Meter } from "../components/ui";
import { api } from "../lib/api";
import { hourNow, plural, usd } from "../lib/format";
import { connected, useStore } from "../lib/store";

export function Wall() {
  const { S, setS } = useStore();
  const [asksVersion, setAsksVersion] = useState(0);
  const hour = hourNow();
  const greet = hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  const n = S.pitstops.length;
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
          <div className="spread"><p className="pc-lab">Box, box: waiting on you</p>{n > 1 && <a className="small faint" href="#/pitstops">Batch decide</a>}</div>
          <div className="grid2">{S.pitstops.slice(0, 6).map((p) => <PitCard key={p.id} p={p} />)}</div>
        </section>)}
      {S.engram.linked && <DigestCard />}
      <div className="grid3">
        <div className="pc-card col"><p className="pc-lab">Today</p><span className="big num">{usd(S.today.usd)}</span><p className="small muted">{`${plural(S.today.runs, "run")} · billed cost where the provider reports it`}</p></div>
        <div className="pc-card col"><p className="pc-lab">This week</p><span className="big num">{usd(S.week.usd)}</span><Meter pct={(S.week.usd / (S.weekCap || 1)) * 100} /><p className="small muted">{`of ${usd(S.weekCap)} across the crew's caps`}</p></div>
        <div className="pc-card col"><p className="pc-lab">Computers</p><span className="big num">{String(S.computersUp)}</span><p className="small muted">up now. Idle computers go back to the garage after 10 minutes.</p></div>
      </div>
      <section className="col">
        <p className="pc-lab">The crew</p>
        <div className="grid3">
          {S.bots.map((b) => <CrewCard key={b.id} b={b} />)}
          <a className="pc-card crewcard" href="#/hire" style={{ justifyContent: "center", alignItems: "center", borderStyle: "dashed" }}><b className="pc-h3">+ New crew member</b><p className="small faint">Every hire is reviewed by you.</p></a>
        </div>
      </section>
    </div>
  );
}
