// The whole crew by state: who needs you, who's on track, who's in the garage. Scales past a sidebar's worth of faces.
import { useState } from "react";
import type { BotCard } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { jobLine } from "../components/MemberMenu";
import { Face, hueStyle } from "../components/ui";
import { usd } from "../lib/format";
import { useStore } from "../lib/store";

const STATE: Record<string, string> = { needs: "pit stop", working: "on track", failed: "didn't finish", done: "done", idle: "ready", sleep: "in the garage" };

export function CrewIndex() {
  const { S } = useStore();
  const [q, setQ] = useState("");
  const match = (b: BotCard) => !q || `${b.name} ${b.job}`.toLowerCase().includes(q.toLowerCase());
  const bots = S.bots.filter(match);
  const groups: [string, BotCard[], string][] = [
    ["Needs you", bots.filter((b) => b.mood === "needs"), "sig"],
    ["On track", bots.filter((b) => b.mood === "working"), ""],
    ["In the garage", bots.filter((b) => b.mood !== "needs" && b.mood !== "working"), ""],
  ];
  const n = (m: string) => S.bots.filter((b) => b.mood === m).length;
  return (
    <div className="page crew-index">
      <div className="row"><h1 className="pc-h2">Crew</h1>
        <span className="pc-m small faint">{`${S.bots.length} members${n("needs") ? ` · ${n("needs")} need you` : ""}${n("working") ? ` · ${n("working")} on track` : ""}`}</span>
        <span style={{ flex: 1 }} />
        <label className="tsearch sm"><Icon name="search" size={14} /><input type="search" placeholder="Find a member" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <a className="pc-pill s" href="#/hire">+ New crew member</a></div>
      {groups.map(([label, list, cls]) => list.length > 0 && (
        <section key={label} className="col">
          <p className={`pc-lab ${cls}`}>{label}</p>
          <div className="mgrid">
            {list.map((b) => {
              const pits = S.pitstops.filter((p) => p.bot_id === b.id && p.kind !== "engram").length;
              return (
                <a key={b.id} className={`mcard ${b.mood === "needs" ? "need" : ""}`} style={hueStyle(b.hue)} href={`#/crew/${b.id}`}>
                  <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}><Face b={b} size="md" /><b className="pc-h3 trunc">{b.name}</b></div>
                  <p className="small muted clamp2">{jobLine(b)}</p>
                  <div className="ft"><span className={b.mood === "needs" ? "sig" : b.mood === "working" ? "blue" : ""}>{pits ? `${pits} pit stop${pits > 1 ? "s" : ""}` : STATE[b.mood] || b.mood}{b.computer.desktop ? " · screen up" : b.computer.up ? " · shell up" : ""}</span><span>{`${usd(b.spend)} wk`}</span></div>
                </a>);
            })}
          </div>
        </section>))}
    </div>);
}
