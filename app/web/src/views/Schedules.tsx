// Schedules (H1): what the crew does on its own and how each run went. One row per schedule with its last 14 runs as
// dots; a row opens to its run history and its settings (time or event trigger, the cheap check, the prompt).
import { Fragment, useState } from "react";
import { BusyButton, Face, Field, Inline, Loader, Seg } from "../components/ui";
import { api } from "../lib/api";
import { flat, sinceLabel, tokens, until } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

interface Run {
  id: string; thread_id: string | null; kind: "time" | "manual" | "event"; due_at: number; fired_at: number; started_at: number | null; ended_at: number | null;
  status: "queued" | "running" | "quiet" | "reported" | "failed" | "interrupted" | "cancelled" | "skipped"; note: string | null; summary: string | null; input_tokens: number | null; cost_usd: number | null;
}
interface Sched {
  id: string; bot_id: string; bot_name: string; spec: string; prompt: string; next_run: number | null; enabled: number; check_cmd: string | null;
  runs: Run[]; week: { runs: number; ok: number; tokens: number; cost: number };
}

const LATE_MS = 5 * 60000;
const DOW: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const nth = (n: number) => `${n}${[, "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10] || "th"}`;
/** The spec in words: "Every day at 22:00", "On the 1st at 08:30", "When its webhook fires". */
export function specWords(spec: string) {
  let m: RegExpExecArray | null;
  if (/^on event$/i.test(spec)) return "When its webhook fires";
  if ((m = /^daily (\S+)$/i.exec(spec))) return `Every day at ${m[1]}`;
  if ((m = /^weekdays (\S+)$/i.exec(spec))) return `Weekdays at ${m[1]}`;
  if ((m = /^weekly (\w+) (\S+)$/i.exec(spec))) return `Every ${DOW[m[1].toLowerCase()] || m[1]} at ${m[2]}`;
  if ((m = /^monthly (\d+) (\S+)$/i.exec(spec))) return `On the ${nth(+m[1])} of each month at ${m[2]}`;
  if ((m = /^every (\d+) (\w+)$/i.exec(spec))) return `Every ${m[1]} ${m[2]}`;
  return spec;
}
const took = (r: Run) => (r.started_at && r.ended_at ? secs(r.ended_at - r.started_at) : "—");
const secs = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`; };
const late = (r: Run) => (r.kind === "time" && r.started_at ? r.started_at - r.due_at : 0);
/** One word and a dot class for a run: the dot strip and the history share it. */
function result(r: Run): [string, string] {
  if (r.status === "queued" || r.status === "running") return [r.status === "queued" ? "Queued" : "Running", "live"];
  if (r.status === "failed" || r.status === "interrupted") return [r.status === "failed" ? "Failed" : "Cut by a restart", "bad"];
  if (r.status === "skipped" || r.status === "cancelled") return [r.status === "skipped" ? "Skipped" : "Cancelled", "hollow"];
  if (late(r) > LATE_MS) return [`Late ${Math.round(late(r) / 60000)} min`, "late"];
  return r.status === "quiet" ? ["Quiet", "quiet"] : ["Alerted you", "news"];
}

export function Schedules() {
  const f = useFetch(() => api.get<Sched[]>("/api/schedules"), []);
  const [open, setOpen] = useState<string | null>(null);
  if (f.error && !f.data) return <div className="page"><p className="badc">{f.error}</p></div>;
  if (!f.data) return null;
  return (
    <div className="page">
      <div><h1 className="pc-h2">Schedules</h1><p className="muted small" style={{ marginTop: 6 }}>What your crew does on its own, and how each run went. Times are India time.</p></div>
      {!f.data.length ? <div className="pc-card"><p className="muted">No schedules yet. Ask a member to check something every day, or to watch for an email.</p></div>
        : <div className="pc-card sch" style={{ padding: 0 }}>
          <table className="tbl"><thead><tr><th>Member</th><th>When</th><th>Next run</th><th>Last 14 runs</th><th>Success</th><th>Per run</th><th /></tr></thead>
            <tbody>{f.data.map((s) => <Fragment key={s.id}>
              <Row s={s} open={open === s.id} onOpen={() => setOpen(open === s.id ? null : s.id)} reload={f.reload} />
              {open === s.id && <tr className="sch-open"><td colSpan={7}><Detail s={s} reload={f.reload} /></td></tr>}
            </Fragment>)}</tbody></table>
        </div>}
    </div>
  );
}

function Row({ s, open, onOpen, reload }: { s: Sched; open: boolean; onOpen: () => void; reload: () => void }) {
  const { bot } = useStore();
  const b = bot(s.bot_id), done = s.runs.filter((r) => r.ended_at), avg = done.length ? done.reduce((n, r) => n + (r.input_tokens || 0), 0) / done.length : 0;
  const avgMs = done.filter((r) => r.started_at).reduce((n, r, _, a) => n + (r.ended_at! - r.started_at!) / a.length, 0);
  const failed = s.runs.filter((r) => result(r)[1] === "bad").length, skipped = s.runs.filter((r) => r.status === "skipped").length;
  const ok = s.runs.filter((r) => ["quiet", "news", "late"].includes(result(r)[1])).length;
  const toggle = async () => { await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled }); reload(); };
  const now = async () => { await api.post(`/api/schedules/${s.id}/run`); toast("Started"); setTimeout(reload, 1500); };
  return (
    <tr className={`sch-row ${open ? "on" : ""} ${s.enabled ? "" : "off"}`} onClick={onOpen}>
      <td><span className="row" style={{ gap: 10 }}><Face b={b} size="sm" /><span className="col" style={{ gap: 2 }}><b>{s.bot_name}</b><span className="small faint ell">{s.prompt.split("\n")[0]}</span></span></span></td>
      <td><span className="col" style={{ gap: 2 }}><span>{specWords(s.spec)}</span><span className="small faint">{/^on event$/i.test(s.spec) ? "webhook" : "time trigger"}{s.check_cmd ? " · with a check" : ""}</span></span></td>
      <td className="pc-m small">{!s.enabled ? "Paused" : s.next_run ? <span className="col" style={{ gap: 2 }}><span>{sinceLabel(s.next_run).replace(/^(\d)/, "Today $1")}</span><span className="faint">{`in ${until(s.next_run)}`}</span></span> : "On the next event"}</td>
      <td><span className="dots">{Array.from({ length: 14 }, (_, i) => { const r = [...s.runs].reverse()[i - (14 - s.runs.length)]; return <i key={i} className={r ? result(r)[1] : "none"} title={r ? `${sinceLabel(r.fired_at)} · ${result(r)[0]}` : ""} />; })}</span></td>
      <td className="pc-m small">{s.runs.length ? <span className="col" style={{ gap: 2 }}><span>{`${ok} of ${s.runs.length}`}</span><span className="faint">{[failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ")}</span></span> : <span className="faint">never run</span>}</td>
      <td className="pc-m small">{done.length ? <span className="col" style={{ gap: 2 }}><span>{`${Math.round(avg / 1000)}k tokens`}</span><span className="faint">{secs(avgMs)}</span></span> : "—"}</td>
      <td onClick={(e) => e.stopPropagation()}><span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <BusyButton className="pc-pill s" onClick={now}>Run now</BusyButton>
        <BusyButton className="pc-pill o s" onClick={toggle}>{s.enabled ? "Pause" : "Resume"}</BusyButton>
      </span></td>
    </tr>);
}

function Detail({ s, reload }: { s: Sched; reload: () => void }) {
  const event = /^on event$/i.test(s.spec);
  const [mode, setMode] = useState<"time" | "event">(event ? "event" : "time");
  const [spec, setSpec] = useState(event ? "daily 09:00" : s.spec), [check, setCheck] = useState(s.check_cmd || ""), [prompt, setPrompt] = useState(s.prompt);
  const hist = useFetch(() => api.get<Run[]>(`/api/schedules/${s.id}/runs?limit=30`), [s.id, s.runs[0]?.id, s.runs[0]?.status]);
  const [hook, setHook] = useState<{ path: string; secret: string } | null>(null);
  const save = async () => {
    await api.patch(`/api/schedules/${s.id}`, { spec: mode === "event" ? "on event" : spec, prompt, check: mode === "time" ? check || null : null });
    toast("Saved"); reload();
  };
  return (
    <div className="sch-detail">
      <div className="sch-hist">
        {!hist.data ? <Loader /> : !hist.data.length ? <p className="small faint">No runs yet.</p>
          : <table className="tbl"><thead><tr><th>Due</th><th>Started</th><th>Took</th><th>Result</th><th>Reply</th></tr></thead><tbody>
            {hist.data.map((r) => { const [word, cls] = result(r); return (
              <tr key={r.id} className={r.thread_id ? "link" : ""} onClick={() => r.thread_id && (location.hash = `#/t/${r.thread_id}`)}>
                <td className="pc-m small">{r.kind === "time" ? sinceLabel(r.due_at) : r.kind === "event" ? "event" : "run now"}</td>
                <td className="pc-m small">{r.started_at ? sinceLabel(r.started_at) : "—"}</td>
                <td className="pc-m small">{took(r)}</td>
                <td><span className={`res ${cls}`}><i />{word}</span></td>
                <td className="small muted ell"><Inline text={flat(r.summary || r.note)} /></td>
              </tr>); })}
          </tbody></table>}
      </div>
      <div className="sch-cfg col">
        <Field label="Trigger"><Seg options={[["time", "At a time"], ["event", "When something happens"]] as const} value={mode} onChange={setMode} /></Field>
        {mode === "time" ? <>
          <Field label="When" help={'"daily 22:00", "weekdays 09:00", "weekly mon 09:00", "monthly 1 08:30", "every 6 hours"'}><input value={spec} onChange={(e) => setSpec(e.target.value)} /></Field>
          <Field label="Only wake when (optional)" help="A shell command on the member's computer, run first with no model. Same output as last time: the run is skipped and costs no tokens."><input className="pc-m" placeholder="python3 skills/blinkit/order_count.py" value={check} onChange={(e) => setCheck(e.target.value)} /></Field>
        </> : <div className="col" style={{ gap: 6 }}>
          <p className="small muted">The member wakes when a signed request reaches this schedule's address: an email forwarder, a bank alert, any service that sends webhooks. What it sends reaches the member as untrusted data.</p>
          {event && (hook ? <div className="col" style={{ gap: 4 }}><code className="small">{`https://${location.host}${hook.path}`}</code><code className="small">{hook.secret}</code><p className="small faint">Sign with Standard Webhooks (HMAC-SHA256), or send the secret as a Bearer token.</p></div>
            : <BusyButton className="pc-pill o s" onClick={async () => setHook(await api.get(`/api/schedules/${s.id}/hook`))}>Show address and secret</BusyButton>)}
          {!event && <p className="small faint">Save to get its address and secret.</p>}
        </div>}
        <Field label="Prompt"><textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
        <div className="row"><BusyButton className="pc-pill s" onClick={save}>Save</BusyButton></div>
        <p className="small faint">Each run gets its own thread, so it doesn't re-read your chat with the member. A failed run lands under Needs you and on your phone.</p>
      </div>
    </div>);
}
