// The work panel: what the member is planning, looking at, running and changing in this thread. A tab exists only once
// there's something in it; the order never changes. Tabs map onto what's awake: Screen = the desktop, Terminal = the shell.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BotCard, ChangeRun, LiveCommandView, PlanSnapshot, ThreadEvent } from "../../../../shared/types";
import { useDock } from "../../components/Dock";
import { Icon } from "../../components/Icon";
import { PlanCard } from "../../components/PlanCard";
import { StepIcon } from "../../components/StepIcon";
import { Loader } from "../../components/ui";
import { tidyTitle } from "../../lib/format";
import { stepView } from "../../lib/steps";
import { api } from "../../lib/api";
import { hm } from "../../lib/format";
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
        {p.tab === "screen" && <ScreenActions b={p.b} lease={p.lease} onHandBack={p.onHandBack} />}
        <button className="ib" title="Close the panel" onClick={p.onClose}><Icon name="close" /></button>
      </div>
      <div className="wbody">
        {p.tab === "plan" && p.plan && <PlanCard P={p.plan} flat />}
        {p.tab === "screen" && <ScreenTab b={p.b} events={p.events} running={p.running} />}
        {p.tab === "terminal" && <TerminalTab b={p.b} events={p.events} live={p.live} />}
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
    {lease ? <button className="pc-pill sig s" onClick={onHandBack}>Hand back</button>
      : <a className="pc-pill s" href={`#/live/${b.id}`} title={up ? `Taking over pauses ${b.name} until you hand back` : undefined}>{up ? "Take over" : "Watch live"}</a>}
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
  return (
    <div className="col" style={{ gap: 14, flex: 1 }}>
      {up ? <div className="wscreen"><div ref={el} className="vnc" /><span className="st">{status}</span></div>
        : <div className="asleep"><b>The screen is asleep.</b><p>It wakes on the member's next page, or when you watch live.</p></div>}
      {recent.length > 0 && <div className="onscreen">
        <p className="pc-lab">On screen</p>
        {recent.map((e, i) => { const v = stepView(tidyTitle(e.data.title), e.data.conn); return (
          <div key={e.id} className={`osr ${i === 0 && running ? "now" : ""}`}>{i === 0 && running ? <Loader /> : <StepIcon name={v.icon} />}<span>{v.detail ? `${v.label} · ${v.detail}` : v.label}</span><small>{hm(e.ts)}</small></div>); })}
      </div>}
      {up && <p className="note" style={{ marginTop: "auto" }}>Back in the garage after 10 idle minutes</p>}
    </div>);
}

/** jev's call on the line: what kind of action it was and whether it ran without asking. */
function Gate({ g }: { g?: { effect: string; decision: string } | null }) {
  if (!g) return null;
  const label = g.decision === "allow" ? "allowed" : g.decision === "ask" ? "pit stop" : g.decision === "block" ? "blocked" : g.decision;
  return <span className={`gate ${g.decision === "allow" ? "" : "sig"}`} title="jev's call on this command">{`${g.effect.replace(/_/g, " ")} · ${label}`}</span>;
}

const cwdName = (cwd: string | null | undefined) => (cwd ? cwd.replace(/^\/bot\/work\/?/, "~/work/").replace(/\/$/, "") || "~/work" : "~/work");
const shownCmd = (s: string) => s.replace(/^\$ /, "");
const secs = (ms: number | null | undefined) => (ms == null ? "" : ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);
const TAIL = 12;

/** One command: its status on a line above so the command keeps the full width (one line until clicked); long output shows its tail. */
function CmdBlock({ cwd, cmd, meta, output, live }: { cwd?: string | null; cmd: string; meta: ReactNode; output: string; live?: boolean }) {
  const [wrap, setWrap] = useState(false), [all, setAll] = useState(false);
  const lines = output.replace(/\n$/, "").split("\n"), cut = !all && lines.length > TAIL;
  return (
    <div className={`blk${live ? " hl" : ""}`}>
      <div className="meta">{meta}</div>
      <button className={`pr${wrap ? " wrap" : ""}`} title={wrap ? undefined : cmd} onClick={() => setWrap(!wrap)}><span className="cwd">{cwdName(cwd)}</span><span className="cmd">{`$ ${cmd}`}</span></button>
      {cut && <button className="more" onClick={() => setAll(true)}>{`Show all ${lines.length} lines`}</button>}
      {(output || live) && <pre className="out">{cut ? lines.slice(-TAIL).join("\n") : output}{live && <span className="cur" />}</pre>}
    </div>);
}

/** Every shell command in this thread as one read-only terminal: saved ones from events, running ones from the stream. */
function TerminalTab({ b, events, live }: { b: BotCard; events: ThreadEvent[]; live: LiveCmd[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const done = useMemo(() => events.filter(isCommand), [events]);
  const failed = done.filter((e) => e.data.exitCode != null && e.data.exitCode !== 0).length;
  const match = (c: string) => !q || c.toLowerCase().includes(q.toLowerCase());
  const lastLen = live.reduce((n, c) => n + c.output.length, 0) + done.length;
  useLayoutEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [lastLen]);
  return (
    <div className="term">
      <div className="tbar"><i /><i /><i /><span>{`${b.name} · ~/work`}</span><span style={{ marginLeft: "auto" }}>{live.length ? "live · read-only" : b.computer.up ? "read-only" : "asleep · transcript"}</span></div>
      <div ref={box} className="tbody">
        {!done.length && !live.length && <p className="faint">No commands yet.</p>}
        {done.filter((e) => match(String(e.data.input || e.data.title))).map((e) => {
          const code = e.data.exitCode as number | null;
          return <CmdBlock key={e.id} cwd={e.data.cwd} cmd={shownCmd(String(e.data.input || e.data.title || ""))} output={String(e.data.output || "")}
            meta={<><Gate g={e.data.gate} />{e.data.status === "declined" ? <span className="bad">declined</span> : code != null && <span className={code === 0 ? "ok" : "bad"}>{code}</span>}<span>{secs(e.data.durationMs)}</span><span>{hm(e.ts)}</span></>} />;
        })}
        {live.filter((c) => match(c.command)).map((c) => <CmdBlock key={c.itemId} live cwd={c.cwd} cmd={shownCmd(c.command)} output={c.output} meta={<><Gate g={c.gate} /><Loader /></>} />)}
      </div>
      <div className="tft"><Icon name="search" size={14} /><input placeholder="Filter commands" value={q} onChange={(e) => setQ(e.target.value)} />
        <span>{`${done.length + live.length} command${done.length + live.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`}</span></div>
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
          <p className="pc-lab">{`run ${hm(r.started_at)} · ${r.changes.length} file${r.changes.length === 1 ? "" : "s"} `}<Tally cs={r.changes} /></p>
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
