// Every thread across the crew, in one list: search what was said, filter by member and by state, grouped by day.
import { useEffect, useRef, useState } from "react";
import type { ThreadListRow } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { MemberMenu } from "../components/MemberMenu";
import { Face, Loader } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";

type State = "all" | "needs" | "running" | "pinned" | "archived";
const STATES: [State, string][] = [["all", "All"], ["needs", "Needs you"], ["running", "Working"], ["pinned", "Pinned"], ["archived", "Archived"]];

function dayLabel(t: number) {
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Earlier this week" : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function Threads() {
  const { S, bot } = useStore();
  const [q, setQ] = useState("");
  const [member, setMember] = useState<string | null>(null);
  const [state, setState] = useState<State>("all");
  const [rows, setRows] = useState<ThreadListRow[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [bump, setBump] = useState(0);
  const pill = useRef<HTMLButtonElement>(null);
  const pending = new Set(S.pitstops.filter((p) => p.kind !== "engram").map((p) => p.thread_id));

  // Search waits for a 200 ms pause in typing; filters apply at once.
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(member ? { bot: member } : {}), ...(state === "archived" ? { archived: "1" } : {}) });
      const r = await api.get<ThreadListRow[]>(`/api/threads?${qs}`, { quiet: true }).catch(() => []);
      if (live) setRows(r);
    }, q ? 200 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, member, state, bump]);
  useLiveReload((e) => e.type === "thread", () => setBump((n) => n + 1), 1500);

  const needs = (r: ThreadListRow) => r.status === "needs" || pending.has(r.id);
  const shown = (rows || []).filter((r) => state === "needs" ? needs(r) : state === "running" ? r.status === "running" : state === "pinned" ? !!r.pinned : true);
  const days: [string, ThreadListRow[]][] = [];
  for (const r of shown) { const d = dayLabel(r.updated_at); const last = days[days.length - 1]; if (last && last[0] === d) last[1].push(r); else days.push([d, [r]]); }
  const who = member ? bot(member) : null;
  const total = rows?.length ?? 0, nNeeds = (rows || []).filter(needs).length, nRun = (rows || []).filter((r) => r.status === "running").length;

  return (
    <div className="page threads-page">
      <div className="row"><h1 className="pc-h2">Threads</h1><span className="small faint">{`${total}${nNeeds ? ` · ${nNeeds} need you` : ""}${nRun ? ` · ${nRun} working` : ""}`}</span><span style={{ flex: 1 }} /><a className="pc-pill s" href={member ? `#/new/${member}` : "#/new"}>+ New thread</a></div>
      <label className="tsearch"><Icon name="search" /><input type="search" placeholder="Find a thread by its title or anything said in it" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="row">
        <button ref={pill} className={`fl ${member ? "" : "on"}`} onClick={() => setMenu(true)}>{who ? <><Face b={who} size="xs" />{who.name}</> : "Everyone"}<Icon name="chev" size={13} /></button>
        {menu && pill.current && <MemberMenu anchor={pill.current} autoLabel={["Everyone", "Every member's threads"]} current={member} onClose={() => setMenu(false)} onPick={(id) => { setMember(id); setMenu(false); }} />}
        <div className="segp">{STATES.map(([k, l]) => <button key={k} className={k === state ? "on" : ""} onClick={() => setState(k)}>{k === "needs" && <i className="dot" />}{l}</button>)}</div>
      </div>
      {!rows ? null : !shown.length ? <div className="pc-card"><p className="empty">{q ? "Nothing matches that." : "No threads here."}</p></div> : (
        <div className="tlist">
          {days.map(([d, list]) => (
            <section key={d}>
              <p className="gl">{d}</p>
              {list.map((r) => { const b = bot(r.bot_id); return (
                <a key={r.id} className={`trow ${needs(r) ? "need" : ""}`} href={`#/t/${r.id}`}>
                  <Face b={b} size="sm" mood={needs(r) ? "needs" : r.status === "running" ? "working" : "idle"} />
                  <span className="tt"><b>{r.title}</b>{r.snippet ? <small>{r.snippet}</small> : null}</span>
                  <span className="tm">{b?.name || r.bot_id}</span>
                  <span className="ts">{needs(r) ? <span className="pc-chip hot">Pit stop</span> : r.status === "running" ? <span className="pc-chip blue"><Loader />Working</span> : r.pinned ? <span className="pc-chip">Pinned</span> : null}</span>
                  <span className="tw">{ago(r.updated_at)}</span>
                </a>); })}
            </section>))}
        </div>)}
    </div>);
}
