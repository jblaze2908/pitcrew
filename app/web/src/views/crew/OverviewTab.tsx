// Overview: talk to the member, what waits on you, its threads, and a side column for job, schedule and computer.
import { useEffect, useState, type KeyboardEvent } from "react";
import type { AskResult, BotCard, BotDetail, ThreadListRow, ThreadPage } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { ago, dayLabel, hm, plainWords, when } from "../../lib/format";
import { useLiveReload } from "../../lib/live";
import { go } from "../../lib/router";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";
import { specWords } from "../Schedules";

const FIRST = 5; // threads shown before "All N threads"
const short = (t: number) => { const d = dayLabel(t); return d === "Today" ? hm(t) : d; };

export function OverviewTab({ b, d }: { b: BotCard; d: BotDetail }) {
  return (
    <div className="ov">
      <div className="ov-main">
        <Composer b={b} />
        <Waiting b={b} />
        <Threads b={b} />
      </div>
      <aside className="ov-side">
        <Job b={b} />
        <ScheduleBlock d={d} />
        <Computer b={b} />
      </aside>
    </div>
  );
}

// Starts a new thread with this member, in the default Ask-first mode.
function Composer({ b }: { b: BotCard }) {
  const [text, setText] = useState(""), [sending, setSending] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await api.post<AskResult>("/api/ask", { text: t, botId: b.id });
      if ("threadId" in r) { setText(""); go(`#/t/${r.threadId}`); }
    } finally { setSending(false); }
  };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  return (
    <div className="comp">
      <textarea rows={2} placeholder={`Message ${b.name}…`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} aria-label={`Message ${b.name}`} />
      <div className="bar"><span>Starts a new thread · Ask first</span>
        <button className="send" disabled={!text.trim() || sending} onClick={send} aria-label="Send"><Icon name="up" size={14} /></button></div>
    </div>
  );
}

// The only orange on the page: pit stops this member is waiting on.
function Waiting({ b }: { b: BotCard }) {
  const { S, threadTitle: title } = useStore();
  const pits = S.pitstops.filter((p) => p.bot_id === b.id && p.status === "pending");
  if (!pits.length) return null;
  return (
    <section>
      <h3>Waiting on you</h3>
      <div className="ms-rows">{pits.map((p) => (
        <div key={p.id} className="wait">
          <span className="dot" />
          <div className="grow"><p className="ms-l">{plainWords(p.title)}</p><p className="ms-h">{`${ago(p.created_at)}${title(p.thread_id) ? `, in ${title(p.thread_id)}` : ""}`}</p></div>
          <a className="pc-pill s" href={p.thread_id ? `#/t/${p.thread_id}` : "#/pitstops"}>Review</a>
        </div>))}
      </div>
    </section>
  );
}

const flat = (p: ThreadPage) => [...p.pinned, ...p.rows];
// Its threads with the last thing said; search covers titles and anything said in them.
function Threads({ b }: { b: BotCard }) {
  const [q, setQ] = useState(""), [all, setAll] = useState(false);
  const list = useFetch(() => api.get<ThreadPage>(`/api/threads?bot=${encodeURIComponent(b.id)}`, { quiet: true }).then(flat), [b.id]);
  useLiveReload((e) => e.type === "thread" && "botId" in e.data && e.data.botId === b.id, list.reload);
  const [found, setFound] = useState<ThreadListRow[] | null>(null);
  // Search waits for a 200 ms pause in typing.
  useEffect(() => {
    const v = q.trim();
    if (!v) { setFound(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await api.get<ThreadPage>(`/api/threads?bot=${encodeURIComponent(b.id)}&q=${encodeURIComponent(v)}`, { quiet: true }).then(flat).catch(() => []);
      if (live) setFound(r);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, b.id]);

  const rows = found ?? list.data ?? [];
  const shown = found || all ? rows : rows.slice(0, FIRST);
  return (
    <section>
      <div className="ms-hrow"><h3>Threads</h3>
        <label className="search"><Icon name="search" size={14} /><input type="search" placeholder="Search its threads" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
      <div className="ms-rows">
        {shown.map((t) => (
          <a key={t.id} className="ms-trow" href={`#/t/${t.id}`}>
            <div className="mn">
              <p className="t1"><span className="trunc">{t.title}</span>{!!t.pinned && <Icon name="pin" size={13} className="faint" />}
                {t.status === "running" && <span className="st">working</span>}</p>
              {t.snippet && <p className="t2">{t.snippet}</p>}
            </div>
            <span className="when" title={when(t.updated_at)}>{short(t.updated_at)}</span>
          </a>))}
        {list.data && !shown.length && <p className="none">{found ? "No threads match." : "No threads yet. Message it above to start one."}</p>}
      </div>
      {!found && !all && rows.length > FIRST && <p className="more"><button className="lk2" onClick={() => setAll(true)}>{`All ${rows.length} threads`}</button></p>}
    </section>
  );
}

function Job({ b }: { b: BotCard }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="blk">
      <p className="k">Job</p>
      <p className={open ? "" : "clamp2"}>{b.job || "No job written yet."}</p>
      <div className="links">
        {b.job.length > 90 && <button className="lk2" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>}
        <a className="lk2" href={`#/crew/${b.id}/settings/job`}>Edit</a>
      </div>
    </div>
  );
}

// Schedules are edited on the Schedules page; this is one line about them.
function ScheduleBlock({ d }: { d: BotDetail }) {
  const s = d.schedules[0], more = d.schedules.length - 1;
  return (
    <div className="blk">
      <p className="k">Schedule</p>
      {s ? <>
        <p className="v">{specWords(s.spec)}</p>
        <p className="clamp2">{`${s.prompt.split("\n")[0]}${s.enabled ? (s.next_run ? ` · next ${when(s.next_run)}` : "") : " · paused"}`}</p>
        {more > 0 && <p>{`and ${more} more`}</p>}
      </> : <p>Runs only when asked.</p>}
      <div className="links"><a className="lk2" href="#/schedules">{s ? "Open in Schedules" : "Add one in Schedules"}</a></div>
    </div>
  );
}

function Computer({ b }: { b: BotCard }) {
  const c = b.computer;
  return (
    <div className="blk">
      <p className="k">Computer</p>
      <p className="v">{c.desktop ? "Screen on" : c.up ? "Running" : "Asleep"}</p>
      <p>{c.desktop ? `Up since ${when(c.startedAt)}. Logins you make in the live view stay in its browser.`
        : c.up ? `Up since ${when(c.startedAt)} for commands. The screen starts on its first browser action.`
        : "Wakes on its first command or browser action."}</p>
      <div className="links">
        {c.desktop ? <a className="lk2" href={`#/live/${b.id}`}>Live view</a>
          : <BusyButton className="lk2" busyLabel="Starting…" onClick={async () => { await api.post(`/api/bots/${b.id}/computer/start`).catch(() => {}); go(`#/live/${b.id}`); }}>Start and watch</BusyButton>}
        {c.up && <BusyButton className="lk2" onClick={async () => { await api.post(`/api/bots/${b.id}/computer/stop`); toast("Computer stopped"); }}>Stop</BusyButton>}
      </div>
    </div>
  );
}

