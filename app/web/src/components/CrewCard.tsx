import type { BotCard } from "../../../shared/types";
import { go } from "../lib/router";
import { usd } from "../lib/format";
import { Face, Loader, Track } from "./ui";

export function CrewCard({ b }: { b: BotCard }) {
  const running = b.threads.find((t) => t.status === "running");
  const pct = (b.spend / (b.weekly_cap_usd || 1)) * 100;
  const busy = ["working", "needs", "failed"].includes(b.mood);
  return (
    <div className="pc-card crewcard" onClick={() => go(`#/crew/${b.id}`)}>
      <div className="who"><Face b={b} size="md" /><div className="col" style={{ gap: 3, minWidth: 0 }}><b>{b.name}</b><span className="pc-m small faint">{`${b.provider} · ${b.model}`}</span></div></div>
      <p className={`now ${busy ? "flex" : ""}`}>
        {b.mood === "working" ? <><Loader />{running?.title || "Working"}</>
          : b.mood === "needs" ? <span className="sig">Waiting on a pit stop</span>
          : b.mood === "failed" ? <span className="badc">Last run failed</span> : b.job || ""}
      </p>
      <div className="budget">
        <Track pct={pct} hue={b.hue} shape={b.shape} state={b.mood === "failed" ? "failed" : "working"} />
        <div className="spread"><span>{`${usd(b.spend)} this week`}</span><span>{`cap ${usd(b.weekly_cap_usd)}`}</span></div>
      </div>
    </div>
  );
}
