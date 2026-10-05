// Schedules: what the crew does on its own and how each run went. One titled row per schedule with its last 14 runs as
// dots; a row opens full width to its settings and recent runs. "New schedule" opens the same editor empty.
import { Fragment, useEffect, useRef, useState } from "react";
import { BusyButton, ConfirmButton, Face, Field, Inline, Loader, Seg } from "../components/ui";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { dayLabel, flat, hm, sinceLabel, until } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

interface Run {
  id: string; thread_id: string | null; kind: "time" | "manual" | "event"; due_at: number; fired_at: number; started_at: number | null; ended_at: number | null;
  status: "queued" | "running" | "quiet" | "reported" | "failed" | "interrupted" | "cancelled" | "skipped"; note: string | null; summary: string | null; input_tokens: number | null; cost_usd: number | null;
}
interface Sched {
  id: string; bot_id: string; bot_name: string; title: string | null; spec: string; prompt: string; next_run: number | null; enabled: number; check_cmd: string | null;
  runs: Run[]; week: { runs: number; ok: number; tokens: number; cost: number };
}

const LATE_MS = 5 * 60000;
const DOW: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const nth = (n: number) => `${n}${[, "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10] || "th"}`;
const isEvent = (spec: string) => /^on event$/i.test(spec);
/** The spec in words: "Every day at 22:00", "1st of the month, 08:30", "When its webhook fires". */
export function specWords(spec: string) {
  let m: RegExpExecArray | null;
  if (isEvent(spec)) return "When its webhook fires";
  if ((m = /^daily (\S+)$/i.exec(spec))) return `Every day at ${m[1]}`;
  if ((m = /^weekdays (\S+)$/i.exec(spec))) return `Weekdays at ${m[1]}`;
  if ((m = /^weekly (\w+) (\S+)$/i.exec(spec))) return `Every ${DOW[m[1].toLowerCase()] || m[1]} at ${m[2]}`;
  if ((m = /^monthly (\d+) (\S+)$/i.exec(spec))) return `${nth(+m[1])} of the month, ${m[2]}`;
  if ((m = /^every 1 (hour|minute)s?$/i.exec(spec))) return `Every ${m[1]}`;
  if ((m = /^every (\d+) (\w+)$/i.exec(spec))) return `Every ${m[1]} ${m[2]}`;
  return spec;
}
const took = (r: Run) => (r.started_at && r.ended_at ? secs(r.ended_at - r.started_at) : "");
const secs = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`; };
const late = (r: Run) => (r.kind === "time" && r.started_at ? r.started_at - r.due_at : 0);
/** One word and a dot class for a run: the dot strip and the history share it. */
function result(r: Run): [string, string] {
  if (r.status === "queued" || r.status === "running") return [r.status === "queued" ? "Queued" : "Running", "live"];
  if (r.status === "failed" || r.status === "interrupted") return [r.status === "failed" ? "Failed" : "Cut by a restart", "bad"];
  if (r.status === "skipped" || r.status === "cancelled") return [r.status === "skipped" ? "Skipped" : "Cancelled", "hollow"];
  if (late(r) > LATE_MS) return [`Late ${Math.round(late(r) / 60000)} min`, "late"];
  return r.status === "quiet" ? ["Nothing new", "quiet"] : ["Alerted you", "news"];
}
const dm = (t: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(t));
/** The next run as a day word and a time: "Tonight 22:00", "Tomorrow 08:00", "Thu 10:00", "1 Nov 09:00". */
function nextWhen(t: number): [string, string] {
  const d = dayLabel(t), h = +hm(t).slice(0, 2);
  if (d === "Today") return [h >= 18 ? "Tonight" : "Today", hm(t)];
  if (dayLabel(t - 86400000) === "Today") return ["Tomorrow", hm(t)];
  return [t - Date.now() < 6 * 86400000 ? d.split(" ")[0] : dm(t), hm(t)];
}
/** The last 14 runs in words: "All 14 ran · 3 alerts", "1 failed on 1 Oct", "Last run failed". Empty when it never ran. */
function outcome(runs: Run[]): [string, boolean] {
  const done = runs.filter((r) => r.ended_at), bad = done.filter((r) => result(r)[1] === "bad");
  if (!done.length) return ["", false];
  if (result(done[0])[1] === "bad") return ["Last run failed", true];
  if (bad.length) return [`${bad.length} failed${bad.length === 1 ? ` on ${dm(bad[0].fired_at)}` : `, last on ${dm(bad[0].fired_at)}`}`, true];
  const ran = done.filter((r) => ["quiet", "news", "late"].includes(result(r)[1])).length, skipped = done.filter((r) => r.status === "skipped").length;
  const alerts = done.filter((r) => r.status === "reported").length;
  const head = ran === 1 && done.length === 1 ? "Ran once" : skipped ? `${ran} ran · ${skipped} skipped` : `All ${ran} ran`;
  return [`${head}${alerts ? ` · ${alerts} ${alerts === 1 ? "alert" : "alerts"}` : ""}`, false];
}

export function Schedules() {
  const f = useFetch(() => api.get<Sched[]>("/api/schedules"), []);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (f.error && !f.data) return <div className="page"><p className="badc">{f.error}</p></div>;
  if (!f.data) return null;
  const list = f.data;
  const added = (id: string) => { setAdding(false); setOpen(id); f.reload(); };
  return (
    <div className="page sch2-page">
      <div className="lib-top">
        <div><h1 className="lib-h1">Schedules</h1><p className="lib-sub">What your crew does on its own, and how each run went. Times are India time.</p></div>
        {!adding && <button className="pc-pill s" onClick={() => { setAdding(true); setOpen(null); }}><Icon name="plus" size={14} />New schedule</button>}
      </div>
      {!list.length && !adding ? <div className="pc-card"><p className="muted">No schedules yet. Use New schedule, or ask a member to check something every day.</p></div>
        : <div className="sch2">
          <table className="tbl"><thead><tr><th>Schedule</th><th>Runs</th><th>Next</th><th>Last 14 runs</th><th>Result</th><th /></tr></thead>
            <tbody>
              {adding && <tr className="sch2-open"><td colSpan={6}><Editor onDone={added} onCancel={() => setAdding(false)} /></td></tr>}
              {list.map((s) => <Fragment key={s.id}>
                <Row s={s} open={open === s.id} onOpen={() => { setAdding(false); setOpen(open === s.id ? null : s.id); }} reload={f.reload} />
                {open === s.id && <tr className="sch2-open"><td colSpan={6}><Editor s={s} onDone={() => { setOpen(null); f.reload(); }} onCancel={() => setOpen(null)} reload={f.reload} /></td></tr>}
              </Fragment>)}
            </tbody></table>
        </div>}
      {list.length > 0 && <div className="sch2-legend"><span><i className="news" />Alerted you</span><span><i className="quiet" />Nothing new</span><span><i className="bad" />Failed</span><span><i className="hollow" />Skipped</span></div>}
    </div>
  );
}

function Row({ s, open, onOpen, reload }: { s: Sched; open: boolean; onOpen: () => void; reload: () => void }) {
  const { bot } = useStore();
  const [word, bad] = outcome(s.runs);
  const runNow = async () => { await api.post(`/api/schedules/${s.id}/run`); toast("Started"); setTimeout(reload, 1500); };
  const toggle = async () => { await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled }); reload(); };
  const next = s.next_run ? nextWhen(s.next_run) : null;
  return (
    <tr className={`sch2-row${open ? " on" : ""}${s.enabled ? "" : " off"}`} onClick={onOpen}>
      <td className="sch2-name"><b>{s.title || s.prompt.split("\n")[0]}</b><span className="sch2-who"><Face b={bot(s.bot_id)} size="xs" />{s.bot_name}</span></td>
      <td className="nw">{specWords(s.spec)}</td>
      <td className="nw">{!s.enabled ? <span className="faint">{isEvent(s.spec) ? "On the next event" : "When resumed"}</span> : next ? <>{`${next[0]} `}<span className="pc-m">{next[1]}</span></> : isEvent(s.spec) ? "On the next event" : ""}</td>
      <td className="nw">{s.runs.length ? <span className="dots">{Array.from({ length: 14 }, (_, i) => { const r = [...s.runs].reverse()[i - (14 - s.runs.length)]; return <i key={i} className={r ? result(r)[1] : "none"} title={r ? `${sinceLabel(r.fired_at)} · ${result(r)[0]}` : ""} />; })}</span>
        : <span className="faint">No runs yet</span>}</td>
      <td className={`nw${bad ? " badc" : ""}`}>{word}</td>
      <td className="sch2-acts" onClick={(e) => e.stopPropagation()}>
        {s.enabled ? <BusyButton className="sch2-q" onClick={runNow}>Run now</BusyButton> : <><span className="faint small">Paused</span><BusyButton className="sch2-q" onClick={toggle}>Resume</BusyButton></>}
        <button className="sch2-chev" aria-label={open ? "Close" : "Open"} aria-expanded={open} onClick={onOpen}><Icon name="chev" size={14} className={open ? "up" : ""} /></button>
      </td>
    </tr>);
}

// ---------- the editor: a schedule's settings in plain words, built into the spec the server parses ----------
type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "hours" | "custom";
interface When { freq: Freq; time: string; dow: string; dom: string; hours: string; custom: string }
// A select rather than <input type=time>, which shows 12-hour times in some locales; times are India time, 24-hour.
const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
function parseSpec(spec: string): When {
  const w: When = { freq: "daily", time: "09:00", dow: "mon", dom: "1", hours: "6", custom: "" };
  let m: RegExpExecArray | null;
  const pad = (t: string) => t.padStart(5, "0");
  if ((m = /^daily (\d{1,2}:\d{2})$/i.exec(spec))) return { ...w, time: pad(m[1]) };
  if ((m = /^weekdays (\d{1,2}:\d{2})$/i.exec(spec))) return { ...w, freq: "weekdays", time: pad(m[1]) };
  if ((m = /^weekly (\w{3}) (\d{1,2}:\d{2})$/i.exec(spec))) return { ...w, freq: "weekly", dow: m[1].toLowerCase(), time: pad(m[2]) };
  if ((m = /^monthly (\d{1,2}) (\d{1,2}:\d{2})$/i.exec(spec))) return { ...w, freq: "monthly", dom: m[1], time: pad(m[2]) };
  if ((m = /^every (\d+) hours?$/i.exec(spec))) return { ...w, freq: "hours", hours: m[1] };
  return spec && !isEvent(spec) ? { ...w, freq: "custom", custom: spec } : w;
}
function buildSpec(w: When) {
  if (w.freq === "daily") return `daily ${w.time}`;
  if (w.freq === "weekdays") return `weekdays ${w.time}`;
  if (w.freq === "weekly") return `weekly ${w.dow} ${w.time}`;
  if (w.freq === "monthly") return `monthly ${w.dom} ${w.time}`;
  if (w.freq === "hours") return `every ${w.hours} ${w.hours === "1" ? "hour" : "hours"}`;
  return w.custom.trim();
}

function Editor({ s, onDone, onCancel, reload }: { s?: Sched; onDone: (id: string) => void; onCancel: () => void; reload?: () => void }) {
  const { S, bot } = useStore();
  const members = S.bots.filter((b) => !b.archived);
  const [botId, setBotId] = useState(s?.bot_id || "");
  const [title, setTitle] = useState(s?.title || ""), [prompt, setPrompt] = useState(s?.prompt || "");
  const [mode, setMode] = useState<"time" | "event">(s && isEvent(s.spec) ? "event" : "time");
  const [w, setW] = useState<When>(() => parseSpec(s?.spec || "daily 09:00"));
  const [check, setCheck] = useState(s?.check_cmd || ""), [quiet, setQuiet] = useState(!!s?.check_cmd), [adv, setAdv] = useState(false);
  const [hook, setHook] = useState<{ path: string; secret: string } | null>(null);
  const set = (p: Partial<When>) => setW((o) => ({ ...o, ...p }));
  const spec = mode === "event" ? "on event" : buildSpec(w);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!s) first.current?.focus(); }, [s]);

  const save = async () => {
    if (!s && !botId) return toast("Pick a member", true);
    if (!prompt.trim()) return toast("Say what to do", true);
    if (mode === "time" && quiet && !check.trim()) { setAdv(true); return toast("Skip quiet days needs a check command", true); }
    const body = { title: title.trim() || null, spec, prompt, check: mode === "time" && quiet ? check.trim() : null };
    if (s) { await api.patch(`/api/schedules/${s.id}`, body); toast("Saved"); onDone(s.id); }
    else { const r = await api.post<{ id: string }>(`/api/bots/${botId}/schedules`, body); toast("Schedule added"); onDone(r.id); }
  };
  const del = async () => { await api.del(`/api/schedules/${s!.id}`); toast("Deleted"); onDone(s!.id); };
  const pause = async () => { await api.patch(`/api/schedules/${s!.id}`, { enabled: !s!.enabled }); reload?.(); };
  const event = !!s && isEvent(s.spec);
  const sentence = mode === "event" ? "Runs when a signed request reaches its address."
    : `Runs ${specWords(spec).replace(/^Every/, "every").replace(/^Weekdays/, "on weekdays").replace(/^(\d)/, "on the $1")}.${s && spec === s.spec && s.enabled && s.next_run ? ` Next run ${nextWhen(s.next_run).join(" ").toLowerCase()}, in ${until(s.next_run)}.` : ""}`;

  return (
    <div className="sch2-ed">
      <div className="sch2-grid">
        <div className="col sch2-l">
          <Field label="Name"><input ref={first} value={title} maxLength={80} placeholder={prompt ? prompt.split("\n")[0].slice(0, 60) : "e.g. Daily expense review"} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="What to do"><textarea rows={7} value={prompt} maxLength={2000} placeholder="What the member should do each time, and when to tell you" onChange={(e) => setPrompt(e.target.value)} /></Field>
        </div>
        <div className="col sch2-r">
          <Field label="Member">{s ? <div className="sch2-member"><Face b={bot(s.bot_id)} size="xs" />{s.bot_name}</div>
            : <select value={botId} onChange={(e) => setBotId(e.target.value)}><option value="">Pick a member</option>{members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}</Field>
          <Field label="Starts"><Seg options={[["time", "At a time"], ["event", "When something happens"]] as const} value={mode} onChange={setMode} /></Field>
          {mode === "time" ? <>
            <Field label="How often">
              <div className="sch2-when">
                <select value={w.freq} onChange={(e) => set({ freq: e.target.value as Freq })} aria-label="How often">
                  <option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Every week</option>
                  <option value="monthly">Every month</option><option value="hours">Every few hours</option><option value="custom">Something else</option>
                </select>
                {w.freq === "weekly" && <select value={w.dow} onChange={(e) => set({ dow: e.target.value })} aria-label="Day">{Object.entries(DOW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
                {w.freq === "monthly" && <select value={w.dom} onChange={(e) => set({ dom: e.target.value })} aria-label="Day of the month">{Array.from({ length: 28 }, (_, i) => <option key={i} value={String(i + 1)}>{nth(i + 1)}</option>)}</select>}
                {w.freq === "hours" && <select value={w.hours} onChange={(e) => set({ hours: e.target.value })} aria-label="Hours">{["1", "2", "3", "4", "6", "8", "12"].map((h) => <option key={h} value={h}>{h === "1" ? "Every hour" : `Every ${h} hours`}</option>)}</select>}
                {["daily", "weekdays", "weekly", "monthly"].includes(w.freq) && <select className="sch2-time" value={w.time} onChange={(e) => set({ time: e.target.value })} aria-label="Time">
                  {(TIMES.includes(w.time) ? TIMES : [w.time, ...TIMES]).map((t) => <option key={t} value={t}>{t}</option>)}</select>}
                {w.freq === "custom" && <input className="pc-m" value={w.custom} placeholder="every 30 minutes" onChange={(e) => set({ custom: e.target.value })} aria-label="When" />}
              </div>
            </Field>
            <p className="small muted">{sentence}</p>
            <div className="sch2-quiet">
              <label className="row chk"><input type="checkbox" checked={quiet} onChange={(e) => { setQuiet(e.target.checked); if (e.target.checked && !check) setAdv(true); }} />
                <span className="col" style={{ gap: 2 }}><b className="small">Skip quiet days</b><span className="small faint">A quick check runs first on their computer, with no model. If nothing changed since last time, the run is skipped and costs nothing.</span></span></label>
              {quiet && <button className="sch2-q small" onClick={() => setAdv(!adv)} aria-expanded={adv}>{adv ? "Hide the check" : "Show the check"}</button>}
              {quiet && adv && <Field label="Check command" help="Runs in their workspace. Same output as last time means nothing new."><input className="pc-m" placeholder="python3 skills/blinkit/order_count.py" value={check} maxLength={500} onChange={(e) => setCheck(e.target.value)} /></Field>}
            </div>
          </> : <div className="col" style={{ gap: 6 }}>
            <p className="small muted">The member wakes when a signed request reaches this schedule's address: an email forwarder, a bank alert, any service that sends webhooks. What it sends is read as information, never as instructions.</p>
            {event ? (hook ? <div className="col" style={{ gap: 4 }}><code className="small sch2-code">{`https://${location.host}${hook.path}`}</code><code className="small sch2-code">{hook.secret}</code><p className="small faint">Sign with Standard Webhooks (HMAC-SHA256), or send the secret as a Bearer token.</p></div>
              : <BusyButton className="pc-pill o s" onClick={async () => setHook(await api.get(`/api/schedules/${s!.id}/hook`))}>Show address and secret</BusyButton>)
              : <p className="small faint">Save to get its address and secret.</p>}
          </div>}
          <p className="small faint">Each run gets its own short thread, so it starts fresh. If a run fails, it shows up in Needs you and on your phone.</p>
        </div>
      </div>
      <div className="sch2-foot">
        {s && <ConfirmButton className="sch2-q" ask="Delete it?" onConfirm={del}>Delete schedule</ConfirmButton>}
        {s && <BusyButton className="sch2-q" onClick={pause}>{s.enabled ? "Pause" : "Resume"}</BusyButton>}
        <span style={{ flex: 1 }} />
        <button className="pc-pill o s" onClick={onCancel}>Cancel</button>
        <BusyButton className="pc-pill s" onClick={save}>{s ? "Save changes" : "Add schedule"}</BusyButton>
      </div>
      {s && <History s={s} />}
    </div>);
}

function History({ s }: { s: Sched }) {
  const hist = useFetch(() => api.get<Run[]>(`/api/schedules/${s.id}/runs?limit=10`), [s.id, s.runs[0]?.id, s.runs[0]?.status]);
  return (
    <div className="sch2-hist">
      <p className="lib-lab">Recent runs</p>
      {!hist.data ? <Loader /> : !hist.data.length ? <p className="small faint">No runs yet.</p>
        : hist.data.map((r) => { const [word, cls] = result(r); return (
          <a key={r.id} className={`sch2-run${r.thread_id ? "" : " nolink"}`} href={r.thread_id ? `#/t/${r.thread_id}` : undefined}>
            <span className="pc-m">{`${dayLabel(r.fired_at)}, ${hm(r.fired_at)}`}</span>
            <span className="pc-m faint">{took(r)}</span>
            <span className={`res ${cls}`}><i />{r.kind === "manual" ? `${word} · run now` : r.kind === "event" ? `${word} · event` : word}</span>
            <span className="muted ell"><Inline text={flat(r.summary || r.note)} /></span>
            {r.thread_id ? <Icon name="chev" size={12} /> : <span />}
          </a>); })}
    </div>);
}
