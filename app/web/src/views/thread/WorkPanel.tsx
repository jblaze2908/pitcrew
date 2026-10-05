// The work panel: what the member is planning, looking at, running and changing in this thread. A tab exists only once
// there's something in it; the order never changes. Tabs map onto what's awake: Screen = the desktop, Terminal = the shell.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BotCard, ChangeRun, LiveCommandView, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { useDock } from "../../components/Dock";
import { Icon } from "../../components/Icon";
import { PlanCard } from "../../components/PlanCard";
import { StepIcon } from "../../components/StepIcon";
import { Loader } from "../../components/ui";
import { hm, tidyTitle, unwrapShell } from "../../lib/format";
import { stepView } from "../../lib/steps";
import { api } from "../../lib/api";
import { openScreen } from "../../lib/novnc";
import { FileBlock, Tally } from "../crew/FilesTab";

export type Tab = "plan" | "screen" | "terminal" | "files";
export const TAB_LABEL: Record<Tab, string> = { plan: "Plan", screen: "Screen", terminal: "Terminal", files: "Files" };
/** A command still streaming: started by an `output` event with command set, grown by chunks, dropped when its tool event lands. */
export type LiveCmd = LiveCommandView;

const isScreenTool = (e: ThreadEvent) => e.kind === "tool" && (e.data.type === "browser" || e.data.type === "computer" || (e.data.type === "dynamicToolCall" && /^(browser|computer)_/.test(String(e.data.title))));
export const isCommand = (e: ThreadEvent) => e.kind === "tool" && e.data.type === "commandExecution";
/** Which tab an event belongs to, for follow-live switching. */
export function tabFor(e: ThreadEvent): Tab | null {
  if (e.kind === "plan") return "plan";
  if (isCommand(e)) return "terminal";
  if (isScreenTool(e)) return "screen";
  if (e.kind === "tool" && e.data.type === "fileChange") return "files";
  return null;
}

interface Props {
  b: BotCard; threadId: string; events: ThreadEvent[]; plan: PlanSnapshot | null; live: LiveCmd[]; runs: ChangeRun[];
  tab: Tab; tabs: Tab[]; follow: boolean; running: boolean; lease: boolean;
  onTab: (t: Tab) => void; onFollow: () => void; onClose: () => void; onHandBack: () => void;
}

export function WorkPanel(p: Props) {
  const liveTab: Tab | null = p.live.length ? "terminal" : p.b.computer.desktop && p.running ? "screen" : null;
  const count = (t: Tab) => t === "terminal" ? p.events.filter(isCommand).length + p.live.length : t === "files" ? new Set(p.runs.flatMap((r) => r.changes.map((c) => c.path))).size : t === "plan" && p.plan ? `${p.plan.items.filter((i) => i.status === "done").length}/${p.plan.items.length}` : null;
  return (
    <aside className="work">
      <div className="wtop">
        <div className="wtabs" role="tablist">
          {p.tabs.map((t) => (
            <button key={t} role="tab" aria-selected={t === p.tab} className={`${t === p.tab ? "on" : ""} ${asleep(t, p.b) ? "zz" : ""}`} onClick={() => p.onTab(t)}>
              {liveTab === t && <i className="lv" />}{TAB_LABEL[t]}{count(t) ? <em>{count(t)}</em> : null}
            </button>))}
        </div>
        {!p.follow && p.running && <button className="chipb follow" onClick={p.onFollow}>Follow live</button>}
        <span style={{ flex: 1 }} />
        {/* One wording for a resting member, whichever tab is open. */}
        <span className="wstate">{p.running ? "Working" : p.events.length ? `Idle since ${hm(p.events[p.events.length - 1].ts)}` : "Idle"}</span>
        {p.tab === "screen" && <ScreenActions b={p.b} lease={p.lease} onHandBack={p.onHandBack} />}
        <button className="ib" title="Close the panel" onClick={p.onClose}><Icon name="close" /></button>
      </div>
      <div className="wbody">
        {p.tab === "plan" && p.plan && <PlanCard P={p.plan} flat />}
        {p.tab === "screen" && <ScreenTab b={p.b} events={p.events} running={p.running} />}
        {p.tab === "terminal" && <TerminalTab events={p.events} live={p.live} />}
        {p.tab === "files" && <FilesTab b={p.b} runs={p.runs} />}
      </div>
    </aside>);
}

const asleep = (t: Tab, b: BotCard) => (t === "screen" && !b.computer.desktop) || (t === "terminal" && !b.computer.up);

/** Take over, corner and full screen sit on the tab row, so the screen gets the panel's height. */
function ScreenActions({ b, lease, onHandBack }: { b: BotCard; lease: boolean; onHandBack: () => void }) {
  const { openDock } = useDock();
  const up = b.computer.desktop;
  return <>
    {lease ? <button className="pc-pill s" onClick={onHandBack}>Hand back</button>
      : up && <a className="pc-pill s" href={`#/live/${b.id}`} title={`Taking over pauses ${b.name} until you hand back`}>Take over</a>}
    {up && <button className="ib ol" title="Watch in a corner" onClick={() => openDock(b)}><Icon name="corner" size={14} /></button>}
    {up && <a className="ib ol" title="Full screen" href={`#/live/${b.id}`}><Icon name="expand" size={14} /></a>}
  </>;
}

function ScreenTab({ b, events, running }: { b: BotCard; events: ThreadEvent[]; running: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  const up = b.computer.desktop;
  useEffect(() => {
    if (!up) return;
    let rfb: Awaited<ReturnType<typeof openScreen>> | null = null, gone = false;
    openScreen(el.current!, b.id, true).then((r) => {
      if (gone) return r.disconnect();
      rfb = r; r.addEventListener("connect", () => setStatus("Live")); r.addEventListener("disconnect", () => setStatus("Disconnected"));
    }).catch((e: Error) => setStatus(e.message));
    return () => { gone = true; rfb?.disconnect(); };
  }, [b.id, up]);
  // The newest screen steps, so the space under a landscape screen says what just happened on it.
  const recent = useMemo(() => events.filter(isScreenTool).slice(-8).reverse(), [events]);
  const shot = useMemo(() => events.findLast((e) => e.kind === "shot"), [events]);
  return (
    <div className="col" style={{ gap: 14, flex: 1 }}>
      {up ? <div className="wscreen"><div ref={el} className="vnc" /><span className="st">{status}</span></div>
        : <div className="wrest">
            {shot && <img src={`/shots/${shot.data.botId}/${shot.data.file}`} alt={shot.data.caption || "Last screenshot"} loading="lazy" onError={(e) => { e.currentTarget.hidden = true; }} />}
            <p>{`${shot ? `Last screenshot, ${hm(shot.ts)}. ` : ""}The screen wakes when ${b.name} next opens a page.`}</p>
            <a className="pc-pill o s" href={`#/live/${b.id}`}>Watch live</a>
          </div>}
      {recent.length > 0 && <div className="onscreen">
        <p className="pc-lab">On screen</p>
        {recent.map((e, i) => { const v = stepView(tidyTitle(e.data.title), e.data.conn); return (
          <div key={e.id} className={`osr ${i === 0 && running ? "now" : ""}`}>{i === 0 && running ? <Loader /> : <StepIcon name={v.icon} />}<span>{v.detail ? `${v.label} · ${v.detail}` : v.label}</span><small>{hm(e.ts)}</small></div>); })}
      </div>}
      {up && <p className="note" style={{ marginTop: "auto" }}>Sleeps after 10 idle minutes</p>}
    </div>);
}

const shownCmd = (s: string) => unwrapShell(s.replace(/^\$ /, ""));
// Sub-second times say nothing worth reading, so they stay hidden.
const secs = (ms: number | null | undefined) => (ms == null || ms < 1000 ? "" : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
const lineList = (out: string) => out.replace(/\s+$/, "").split("\n");
interface Cmd { key: string; cmd: string; output: string; at: number; ms: number | null; failed: boolean; why: string; live: boolean }

/** A saved command as a row: failed when it exited non-zero, failed outright or the safety check blocked it. An approved
 * command says it needed your OK; exit 0 says nothing. */
function savedCmd(e: ThreadEvent): Cmd {
  const d = e.data, code = d.exitCode as number | null, g = d.gate as { decision?: string } | null;
  const failed = d.status === "failed" || (code != null && code !== 0) || g?.decision === "block";
  const why = failed ? (g?.decision === "block" ? "Blocked" : "Failed") : d.status === "declined" ? "Declined" : g?.decision === "ask" ? "Needed your OK" : "";
  return { key: String(e.id), cmd: shownCmd(String(d.input || d.title || "")), output: String(d.output || ""), at: e.ts, ms: d.durationMs ?? null, failed, why, live: false };
}

/** One command on one line. Failures open by default with their last line; others open on click with the last 3. */
function CmdRow({ c }: { c: Cmd }) {
  const [open, setOpen] = useState(c.failed || c.live), [all, setAll] = useState(false);
  const lines = c.output.trim() ? lineList(c.output) : [];
  const tail = c.failed ? lines.filter((l) => l.trim()).slice(-1) : lines.slice(-3);
  const head = c.live ? "Live, last 3 lines" : c.failed ? "Last line" : lines.length > 3 ? `Last 3 of ${lines.length} lines` : "Output";
  const meta = [c.failed ? "" : c.why, c.live ? secs(Date.now() - c.at) : secs(c.ms)].filter(Boolean).join(" · ");
  return (
    <div className={`cmdrow${open ? " open" : ""}`}>
      <button className="cmdline" aria-expanded={open} title={c.cmd} onClick={() => setOpen(!open)}>
        {c.live ? <Loader /> : <Icon name="chev" size={12} className="cv" />}
        <code>{c.cmd}</code>
        {meta && <span className="m">{meta}</span>}
        {c.failed && <span className="f">{c.why}</span>}
        <span className="t">{hm(c.at)}</span>
      </button>
      {open && <div className="cmdout">
        {c.cmd.length > 60 && <div className="full">{c.cmd}</div>}
        {lines.length ? <>
          <div className="oh"><span>{all ? `All ${lines.length} lines` : head}</span>{!c.live && lines.length > tail.length && <button className="lnk" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</button>}</div>
          <pre className={c.failed && !all ? "bad" : ""}>{(all ? lines : tail).join("\n")}</pre>
        </> : <div className="oh"><span>{c.live ? "No output yet" : "No output"}</span></div>}
      </div>}
    </div>);
}

/** Every shell command in this thread, one line each: saved ones from events, running ones from the stream. */
function TerminalTab({ events, live }: { events: ThreadEvent[]; live: LiveCmd[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState(""), [only, setOnly] = useState(false), [, tick] = useState(0);
  const done = useMemo(() => events.filter(isCommand).map(savedCmd), [events]);
  const running: Cmd[] = live.map((c) => ({ key: c.itemId, cmd: shownCmd(c.command), output: c.output, at: c.startedAt, ms: null, failed: false, why: "", live: true }));
  const failed = done.filter((c) => c.failed).length;
  const shown = [...done, ...running].filter((c) => (!only || c.failed) && (!q || c.cmd.toLowerCase().includes(q.toLowerCase())));
  // A running command's elapsed time ticks once a second; nothing ticks while the shell is quiet.
  useEffect(() => { if (!live.length) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [live.length]);
  const lastLen = live.reduce((n, c) => n + c.output.length, 0) + done.length;
  useLayoutEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [lastLen]);
  return (
    <div className="cmdlog">
      <div className="cmdsum">
        <div className="cmdseg" role="tablist">
          <button role="tab" aria-selected={!only} className={only ? "" : "on"} onClick={() => setOnly(false)}>{`All ${done.length + running.length}`}</button>
          <button role="tab" aria-selected={only} className={only ? "on" : ""} onClick={() => setOnly(true)}>Failed <b>{failed}</b></button>
        </div>
        <label className="cmdfind"><Icon name="search" size={13} /><input placeholder="Find a command" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      <div ref={box} className="cmdlist">
        {!shown.length && <p className="cmdnone">{done.length || running.length ? "No commands match." : "No commands yet."}</p>}
        {shown.map((c) => <CmdRow key={c.key} c={c} />)}
      </div>
    </div>);
}

/** Files changed in this thread's runs, newest run first, each file's diff on click. The whole workspace is one link away. */
function FilesTab({ b, runs }: { b: BotCard; runs: ChangeRun[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length) return <div className="asleep"><b>No files changed in this thread yet.</b><p><a href={`#/crew/${b.id}/files/workspace`}>Browse {b.name}'s workspace</a></p></div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      {runs.map((r) => (
        <section key={r.id} className="col" style={{ gap: 6 }}>
          <p className="pc-lab">{`Run at ${hm(r.started_at)} ·${r.changes.length} file${r.changes.length === 1 ? "" : "s"} `}<Tally cs={r.changes} /></p>
          {r.changes.map((c) => { const k = `${r.id}:${c.path}`; return <FileBlock key={k} b={b} turnId={r.id} c={c} open={open === k} focus={false} split={false} onToggle={() => setOpen(open === k ? null : k)} />; })}
        </section>))}
      <a className="small" href={`#/crew/${b.id}/files/workspace`}>{`All of ${b.name}'s files ›`}</a>
    </div>);
}

/** The thread's runs that changed files, from the member's change log (40 kept). Refetched when a run ends. */
export function useThreadRuns(botId: string, threadId: string, bump: number) {
  const [runs, setRuns] = useState<ChangeRun[]>([]);
  useEffect(() => {
    let live = true;
    api.get<ChangeRun[]>(`/api/bots/${botId}/changes`, { quiet: true }).then((all) => { if (live) setRuns(all.filter((r) => r.thread_id === threadId && r.changes.length)); }).catch(() => {});
    return () => { live = false; };
  }, [botId, threadId, bump]);
  return runs;
}
