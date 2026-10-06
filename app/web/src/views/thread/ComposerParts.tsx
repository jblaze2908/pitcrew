// The composer's satellites: the queued stack above the box, the pit-stop mode picker and the context ring.
import { useState } from "react";
import type { QueuedItem } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { attachmentName } from "../../lib/images";
import { toast } from "../../lib/toast";

const viaLabel = (via: string, fromName: string) => via === "schedule" ? "Scheduled" : via === "plan" ? "Plan step" : via === "resume" ? "Pick up" : via === "retro" ? "Review" : via === "delegation" ? `${fromName} asks` : "Queued";

/** Messages waiting for the run to end, Claude Code style: they join the transcript only when they go to the member. */
export function QueuedStack({ threadId, queued, fromName, onEdit }: { threadId: string; queued: QueuedItem[]; fromName: string; onEdit: (q: QueuedItem) => Promise<void> }) {
  if (!queued.length) return null;
  return (
    <div className="queued">
      {queued.map((q) => (
        <div key={q.id} className="qi">
          <span className="lab">{viaLabel(q.via, fromName)}</span>
          <span className="txt" title={q.display || q.text}>{q.display || q.text}</span>
          {q.attachments.length > 0 && <span className="n" title={q.attachments.map(attachmentName).join(", ")}>{`+${plural(q.attachments.length, "file")}`}</span>}
          <span className="acts">
            <BusyButton onClick={() => api.post(`/api/threads/${threadId}/queue/${q.id}/send-now`)}>Send now</BusyButton>
            <BusyButton onClick={() => onEdit(q)}>Edit</BusyButton>
            <BusyButton className="x" onClick={() => api.del(`/api/threads/${threadId}/queue/${q.id}`)}>×</BusyButton>
          </span>
        </div>))}
    </div>
  );
}

// How much this thread runs without pit stops (server: runtime/autonomy.ts). Labels only; the API keeps ask/handsfree/yolo.
const AUTONOMY = [
  ["ask", "Ask first", "Asks before sending, paying, signing in, installing, sharing, deleting or a new site."],
  ["handsfree", "Hands-free", "Stops only for paying, signing in, sending, sharing, deleting, look-alike or non-https sites, and house rules."],
  ["yolo", "YOLO", "No pit stops, paying and sending included. Only hard blocks, blocked sites and house rules stop it."],
] as const;

export function ModePicker({ threadId, value, onChange }: { threadId: string; value: string; onChange: (a: string) => void }) {
  const [open, setOpen] = useState(false);
  const cur = AUTONOMY.find(([k]) => k === value) || AUTONOMY[0];
  const set = async (a: string) => {
    setOpen(false);
    if (a === value) return;
    await api.patch(`/api/threads/${threadId}`, { autonomy: a });
    onChange(a); toast(AUTONOMY.find(([k]) => k === a)![1]);
  };
  return (
    <span className="modepick">
      <button className="chipb mode" title="Pit stops for this thread" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true"><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" /></svg>{cur[1]}<Icon name="chev" size={13} /></button>
      {open && <>
        <div className="scrim" onClick={() => setOpen(false)} />
        <div className="menu modes" role="menu">
          {AUTONOMY.map(([k, label, tip]) => (
            <button key={k} role="menuitemradio" aria-checked={k === value} className={`op mode-${k} ${k === value ? "on" : ""}`} onClick={() => set(k)}>
              <i className="d7" /><span><b>{label}</b><small>{tip}</small></span>{k === value && <Icon name="check" />}
            </button>))}
          <p className="ft">This thread only</p>
        </div>
      </>}
    </span>);
}

// Below this share of the window the meter stays hidden. Pitcrew has no summarise trigger of its own (Codex compacts by
// itself, runtime/notify.ts), so this only warns; a click summarises now, same as /compact.
const CTX_WARN = 0.8;
/** How full the context is, shown only from CTX_WARN on: a ring and one plain sentence, no token counts. */
export function ContextRing({ threadId, ctx, running }: { threadId: string; ctx: { tokens: number | null; window: number | null }; running: boolean }) {
  if (!ctx.tokens || !ctx.window || ctx.tokens / ctx.window < CTX_WARN) return null;
  const pct = Math.min(100, (ctx.tokens / ctx.window) * 100), c = 2 * Math.PI * 6;
  return (
    <button className="ring" disabled={running} title="Summarise older messages now"
      onClick={async () => { await api.post(`/api/threads/${threadId}/compact`); toast("Summarising older messages"); }}>
      <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--surface-3)" strokeWidth="2.2" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" /></svg>
      {`${Math.round(pct)}% full · summarising older messages soon`}
    </button>);
}
