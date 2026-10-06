// System notes in a thread: restarts, mode changes, retros, memories and done-checks, each one quiet grey line.
import { useState, type ReactNode } from "react";
import type { ThreadEvent } from "../../../../shared/types";
import { BusyButton, Inline } from "../../components/ui";
import { api } from "../../lib/api";
import { plainWords } from "../../lib/format";
import { useFetch } from "../../lib/useFetch";
import type { EventCtx } from "./Events";

// Every system event in a thread is one quiet line: a small icon and a grey sentence aligned with the reply text.
const NOTE_ICON = {
  restart: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
  mark: '<path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/>',
  tools: '<path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7" fill="var(--ground)"/><circle cx="10" cy="11" r="1.7" fill="var(--ground)"/>',
  retro: '<path d="M3 4h7M3 8h10M3 12h5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
  quiet: '<path d="M12.5 10A5 5 0 0 1 6 3.5a5 5 0 1 0 6.5 6.5z"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  alert: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 11h.01"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5h.01"/>',
  mail: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M3 4.5l5 4 5-4"/>',
  compact: '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>',
  rewind: '<path d="M6.5 4.5L3 8l3.5 3.5M3 8h10"/>',
} as const;
type NoteIcon = keyof typeof NOTE_ICON;
export function Note({ icon, bad, title, children }: { icon: NoteIcon; bad?: boolean; title?: string; children: ReactNode }) {
  return <p className={`tnote${bad ? " bad" : ""}`} title={title}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: NOTE_ICON[icon] }} />
    <span>{children}</span></p>;
}
/** Stored notes come with and without a full stop; each sentence ends once, with a space before any inline action. */
// Older done-check notes repeat the grader's own "Couldn't confirm" after ours.
const once = (s: string) => s.replace(/(couldn'?t confirm):?\s+couldn'?t confirm:?/gi, "$1");
export const said = (raw: string) => { const s = once(raw).trim(); return `${/[.!?…:)”"]$/.test(s) ? s : `${s}.`} `; };

type Learned = { memory_id: string; text: string; state: "saved" | "held" | "known" | "replaced" | "undone" };
const LEARNED_SAID: Record<Learned["state"], string> = { saved: "Remembered", held: "Waiting for your review before it's shared", known: "Already knew", replaced: "Remembered, replacing an older note", undone: "Undone" };
/** What this run remembered, one note per memory with Undo inline; read from the turn, so an undo shows after a reload. */
export function LearnedNotes({ d }: { d: Record<string, any> }) {
  const f = useFetch(() => api.get<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned`, { quiet: true }), [d.turnId]);
  const [items, setItems] = useState<Learned[] | null>(null);
  const list = items ?? f.data?.items ?? null;
  if (!list?.length) return null;
  const undo = async (m: Learned) => setItems((await api.post<{ items: Learned[] }>(`/api/turns/${d.turnId}/learned/${encodeURIComponent(m.memory_id)}/undo`)).items);
  return <>{list.map((m) => (
    <Note key={m.memory_id} icon="mark">{said(`${LEARNED_SAID[m.state]}: ${m.text}`)}
      {m.state === "saved" && <BusyButton className="lnk" busyLabel="Undoing…" onClick={() => undo(m)}>Undo</BusyButton>}</Note>))}</>;
}

const MODE_SAID: Record<string, string> = {
  ask: "You switched this thread to Ask first: it asks before sending, paying, signing in, installing, sharing or deleting.",
  handsfree: "You switched this thread to Hands-free: it stops only for paying, signing in, sending, sharing and deleting.",
  yolo: "You switched this thread to YOLO: no pit stops, paying and sending included. Hard blocks and house rules still apply.",
};
// Mode notes are stored with the server's long sentence (api/threads.ts AUTONOMY_NOTE); the label before the colon names the mode.
const modeOf = (t: string) => /^Ask first:/.test(t) ? "ask" : /^Hands-free:/.test(t) ? "handsfree" : /^YOLO:/.test(t) ? "yolo" : null;
const isRestart = (e: ThreadEvent) => e.kind === "system" && /^Pitcrew restarted/.test(e.data.text || "");
const CONTINUE = "Say continue to pick it up.";
const isRemembered = (t: string) => /^(Remembered|Sent to Engram for [^:]*review): /.test(t);

/** Notes that fold into a neighbour: a restart into the resume or "continue" right after it, and "Remembered" into the
 * run's memory notes (LearnedNotes). Also the newest mode note, the only one offering a way back. One pass per events change. */
export function noteFolds(events: ThreadEvent[]) {
  const hide = new Set<number>(), learned = new Set<string>();
  let modeNote: number | null = null;
  for (const e of events) {
    if (e.kind === "learned" && e.turn_id) learned.add(e.turn_id);
    if (e.kind === "system" && modeOf(e.data.text || "")) modeNote = e.id;
  }
  events.forEach((e, i) => {
    if (isRestart(e)) {
      const next = events.slice(i + 1, i + 5).find((x) => x.kind === "user" || x.kind === "system");
      if (next && ((next.kind === "user" && next.data.via === "resume") || next.data.text === CONTINUE)) hide.add(e.id);
    }
    if (e.kind === "system" && e.turn_id && learned.has(e.turn_id) && isRemembered(e.data.text || "")) hide.add(e.id);
  });
  return { hide, modeNote };
}

/** A retro's note: "Looking back at the run · <why> · <what changed>" (runtime/turns.ts) as a sentence, the change behind Details. */
function RetroNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const parts = text.split(" · "), why = parts.length > 2 ? parts[1] : null, outcome = parts.slice(why ? 2 : 1).join(" · ");
  return <>
    <Note icon="retro">{said(`How this run went: ${why || outcome || "looked back at it"}`)}
      {why && outcome && <button className="lnk" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>}</Note>
    {open && <p className="tnote sub"><span>{said(`Looking back on it: ${outcome}`)}</span></p>}
  </>;
}

export function SystemNote({ e, c }: { e: ThreadEvent; c: EventCtx }) {
  const d = e.data, t = String(d.text || "");
  // A restart cut the run (runtime/lifecycle.ts): nothing broke on the member's side, so no red.
  if (isRestart(e)) return <Note icon="restart">Pitcrew restarted during this run, so it stopped partway.</Note>;
  if (t === CONTINUE) return <Note icon="restart">{"Pitcrew restarted, so the last run stopped partway. "}{c.onContinue && <button className="lnk" onClick={c.onContinue}>Pick up where it left off</button>}</Note>;
  // A mode change isn't a failure: older YOLO notes were stored with the bad tone.
  const mode = modeOf(t);
  if (mode) return <Note icon="shield">{`${MODE_SAID[mode]} `}{mode !== "ask" && e.id === c.modeNote && c.autonomy === mode && c.onAutonomy && <button className="lnk" onClick={() => c.onAutonomy!("ask")}>Back to Ask first</button>}</Note>;
  if (d.retro) return <RetroNote text={t} />;
  const icon: NoteIcon = /tools changed|^Tools and skills reload/.test(t) ? "tools" : /^(Remembered|Noted for this thread|Learned|Sent to Engram)/.test(t) ? "mark"
    : /compact/i.test(t) ? "compact" : /^Rewound/.test(t) ? "rewind" : /^(Usage limit|Scheduled|Changed schedule|Cancelled schedule)/.test(t) ? "clock"
    : /untrusted content/.test(t) ? "shield" : /^Published/.test(t) ? "check" : d.tone === "bad" ? "alert" : "info";
  return <Note icon={icon} bad={d.tone === "bad"}>{said(plainWords(t).replace(/^Sent to Engram for [^:]*review: /, "Waiting for your review before it's shared: "))}</Note>;
}

/** A user event that isn't the driver typing (a schedule, a resume, a retro) as a note; null for a real message. */
export function userNote(d: Record<string, any>): ReactNode {
  switch (d.via) {
    // The retry prompt itself: the done-check's own "trying again" note already says it.
    case "check": return <></>;
    case "retro": return <Note icon="retro">{said(String(d.display || "Looked back at the run").replace(/^Retro\b/, "Looked back at the run").replace(/ · /g, ": "))}</Note>;
    case "teach": return <Note icon="mark">{said(String(d.display || "Save as skill").replace(/ · /g, ", "))}</Note>;
    case "resume": return <Note icon="restart">{/^Pitcrew restarted/.test(d.text || "") ? "Pitcrew restarted and picked up where it left off." : "The usage limit reset, so it picked up where it left off."}</Note>;
    case "email": return <Note icon="mail">{said(d.display || "An email arrived")}</Note>;
    // A scheduled run's prompt is the same every time: a note, not a message bubble.
    case "schedule": return <Note icon="clock">{/^\[Event\]/.test(d.text || "") ? said(d.display || "An event arrived") : said(`Scheduled run, ${String(d.text || "").replace(/^\[Scheduled: ([^\]]+)\][\s\S]*/, "$1")}`)}</Note>;
  }
  return null;
}

type Crit = { text: string; verdict: "pass" | "fail" | "unknown"; why: string; check?: string; out?: string };
const VERDICT_WORD: Record<string, string> = { pass: "Passed", fail: "Failed", unknown: "Not checked" };
const bare = (why: string) => why.replace(/^not checked: /, "");
/** The proof behind a done-check note: each criterion, the command that checked it and that command's output. */
function CheckDetails({ crit }: { crit: Crit[] }) {
  return <div className="chk-d">{crit.map((c, i) => <div key={i} className={`chk-c ${c.verdict}`}>
    <span>{`${VERDICT_WORD[c.verdict] || "Not checked"}: ${c.text}`}{c.why && <span className="faint">{` · ${bare(c.why)}`}</span>}</span>
    {c.check && <code>{`$ ${c.check}`}</code>}
    {c.out && <pre>{c.out}</pre>}
  </div>)}</div>;
}

/** A done-check result (runtime/donecheck.ts) as a note: checked with its proof one click away, a retry, not confirmed
 * (soft red, with Send back), or why not. Older events carry headline/why/evidence instead of criteria. */
export function CheckLine({ d }: { d: Record<string, any> }) {
  const [open, setOpen] = useState(false), [sent, setSent] = useState("");
  const crit = (Array.isArray(d.criteria) ? d.criteria : []) as Crit[], fail = crit.find((c) => c.verdict === "fail");
  const toggle = (label: string) => crit.length > 0 && <button className="lnk" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : label}</button>;
  const details = open && <CheckDetails crit={crit} />;
  // Going back once isn't a failure yet.
  if (d.status === "retrying") return <><Note icon="check">{fail ? said(`Not confirmed yet: ${fail.text}, so it went back to fix it`) : once(`The done-check couldn't confirm ${d.headline}, so it's trying again (${d.attempt} of ${d.of}). `)}{toggle("Details")}</Note>{details}</>;
  if (d.status === "failed") {
    const send = async () => { try { await api.post(`/api/turns/${d.root}/check/retry`, undefined, { quiet: true }); setSent("Sent back."); } catch (e: any) { setSent(said(e.message || "Couldn't send it back")); } };
    return <><Note icon="alert" bad>{said(`Not confirmed: ${fail?.text || d.headline}${fail?.why ? ` — ${fail.why}` : ""}`)}
      {sent ? <span className="faint">{`${sent} `}</span> : d.root && <><BusyButton className="lnk" busyLabel="Sending back…" onClick={send}>Send back</BusyButton>{" "}</>}{toggle("Details")}</Note>{details}</>;
  }
  if (d.status !== "passed") {
    const u = crit.find((c) => c.verdict === "unknown"), ok = crit.filter((c) => c.verdict === "pass").length;
    return <><Note icon="check">{said(u ? `${ok ? `Checked ${ok} of ${crit.length}. ` : ""}Not checked: ${u.text} — ${bare(u.why)}` : `Not checked: ${d.why || "no grader"}`)}{toggle("Details")}</Note>{details}</>;
  }
  const src = d.proof?.file ? `/shots/${d.proof.botId}/${d.proof.file}` : null, ran = crit.some((c) => c.check);
  const how = `${ran ? "Checked by running the member's check commands" : "Graded by a second model"} against ${d.n} criteri${d.n === 1 ? "on" : "a"}${d.attempt ? " after one more try" : ""}`;
  const head = d.evidence ? <>{"Checked: "}<Inline text={said(d.evidence)} /></> : crit.length ? said(crit.length === 1 ? `Checked: ${crit[0].text}` : `Checked: all ${crit.length} criteria`) : "Checked. ";
  return <><Note icon="check" title={how}>{head}{ran && toggle("Proof")}{ran && src && " "}{src && <a className="lnk" href={src} target="_blank" rel="noopener">{ran ? "Screenshot" : "Proof"}</a>}</Note>{details}</>;
}
