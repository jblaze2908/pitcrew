// The whole crew by state: who's waiting on you, who's working, who's idle. Neutral rows; orange only where you're needed.
// One /api/schedules read per visit fills "Next up"; everything else comes from the state the app already holds.
import { useState } from "react";
import type { BotCard, PitStop } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { jobLine } from "../components/MemberMenu";
import { Face } from "../components/ui";
import { api } from "../lib/api";
import { cap, dayLabel, dayMonth, hm, plainWords, plural } from "../lib/format";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";

interface Sched { id: string; bot_id: string; title: string | null; prompt: string; spec: string; next_run: number | null; enabled: number }

/** "at 22:00" today, "tomorrow 08:00", "Thu 10:00" this week, "1 Nov 09:00" later. */
function at(t: number): [string, string] {
  const d = dayLabel(t);
  if (d === "Today") return ["at", hm(t)];
  if (dayLabel(t - 86400000) === "Today") return ["tomorrow", hm(t)];
  return [t - Date.now() < 6 * 86400000 ? d.split(" ")[0] : dayMonth(t), hm(t)];
}
const lastSeen = (t: number) => { const d = dayLabel(t); return d === "Today" ? `at ${hm(t)}` : d === "Yesterday" ? "yesterday" : `on ${dayMonth(t)}`; };

/** What the member is doing, as one sentence, and its tone: needs (orange), bad (soft red) or plain. */
function status(b: BotCard, pits: PitStop[]): [string, "" | "needs" | "bad" | "work"] {
  const mine = pits.filter((p) => p.bot_id === b.id && p.status === "pending").sort((x, y) => y.created_at - x.created_at);
  if (b.mood === "needs" && mine[0]) return [`Wants your OK: ${plainWords(mine[0].title)}`, "needs"];
  if (b.mood === "needs") return ["Waiting for you", "needs"];
  // A pinned thread is named after the member, so it says nothing about what they did; prefer the others.
  const all = [...b.threads].sort((x, y) => y.updated_at - x.updated_at), last = all.filter((x) => !x.pinned);
  if (b.mood === "working") { const t = all.find((x) => x.status === "running") || last[0]; return [t && !t.pinned ? t.title : "Working", "work"]; }
  if (b.mood === "failed") return [last[0] ? `Last run didn't finish: ${last[0].title}` : "Last run didn't finish", "bad"];
  if (last[0]) return [`${last[0].title}, ${lastSeen(last[0].updated_at)}`, ""];
  return all[0] ? [`Last active ${lastSeen(all[0].updated_at)}`, ""] : ["Hasn't started anything yet", ""];
}

export function CrewIndex() {
  const { S } = useStore();
  const [q, setQ] = useState("");
  const scheds = useFetch(() => api.get<Sched[]>("/api/schedules", { quiet: true }), []);
  // Each member's soonest enabled timed schedule; event schedules have no clock time to show.
  const next = new Map<string, Sched>();
  for (const s of scheds.data || []) if (s.enabled && s.next_run && (!next.has(s.bot_id) || s.next_run < next.get(s.bot_id)!.next_run!)) next.set(s.bot_id, s);
  const match = (b: BotCard) => !q || `${b.name} ${b.job}`.toLowerCase().includes(q.toLowerCase());
  const bots = S.bots.filter(match);
  const groups: [string, BotCard[]][] = [
    ["Waiting on you", bots.filter((b) => b.mood === "needs")],
    ["Working now", bots.filter((b) => b.mood === "working")],
    ["Idle", bots.filter((b) => b.mood !== "needs" && b.mood !== "working")],
  ];
  const n = (m: string) => S.bots.filter((b) => b.mood === m).length;
  const words = (k: number) => ["no one", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][k] || String(k);
  const busy = [n("needs") && `${words(n("needs"))} ${n("needs") === 1 ? "is" : "are"} waiting on you`, n("working") && `${words(n("working"))} ${n("working") === 1 ? "is" : "are"} working`].filter(Boolean).join(", ");
  const sub = `${plural(S.bots.length, "member")}.${busy ? ` ${cap(busy)}.` : ""}`;
  return (
    <div className="page crew2">
      <div className="lib-top">
        <div><h1 className="lib-h1">Crew</h1><p className="lib-sub">{sub}</p></div>
        <div className="row crew2-tools">
          <label className="lib-search"><Icon name="search" size={14} /><input type="search" placeholder="Find a member" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a member" /></label>
          <a className="pc-pill s" href="#/hire"><Icon name="plus" size={14} />Hire a member</a>
        </div>
      </div>
      {!bots.length ? <p className="small faint">{q ? "No one matches." : "No members yet."}</p> : <div className="crew2-list">
        <div className="crew2-head"><span>Member</span><span>Right now</span><span>Next up</span><span /></div>
        {groups.map(([label, list]) => list.length > 0 && (
          <section key={label}>
            <p className="crew2-grp">{label}<em>{list.length}</em></p>
            <div className="crew2-card">
              {list.map((b) => {
                const [line, tone] = status(b, S.pitstops), s = next.get(b.id), when = s?.next_run ? at(s.next_run) : null;
                return (
                  <a key={b.id} className="crew2-row" href={`#/crew/${b.id}`}>
                    <span className="crew2-who"><Face b={b} size="md" live /><span className="col"><b>{b.name}</b><span className="small muted trunc">{jobLine(b)}</span></span></span>
                    <span className={`crew2-now${tone ? ` is-${tone}` : ""}`}>{line}</span>
                    <span className="crew2-next">{s && when ? <>{`${s.title || "Scheduled run"} ${when[0]} `}<span className="pc-m">{when[1]}</span></> : <span className="faint">Nothing scheduled</span>}</span>
                    <Icon name="chev" size={14} className="crew2-go" />
                  </a>);
              })}
            </div>
          </section>))}
      </div>}
    </div>);
}
