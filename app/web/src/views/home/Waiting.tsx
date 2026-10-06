// Home's waiting rows (Draft M4b): each pit stop on one line with its main choice and Deny. An ask that should be read
// first (money, a message going out, a deletion, a long command) shows Review and opens into the full card (Draft M4a).
import { useState } from "react";
import type { PitStop } from "../../../../shared/types";
import { PitCard, pitHeading } from "../../components/PitCard";
import { Face } from "../../components/ui";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";

const SHOWN = 5;
const WEIGHTY = ["pay", "send", "delete", "share"];

/** The one-click choice when the line says it all, else null. PitCard's main button, at the narrowest scope it offers. */
function quick(p: PitStop): { label: string; scope: string } | null {
  const d = p.detail || {};
  if (WEIGHTY.includes(p.effect) || d.homograph || d.lookalike) return null;
  if (p.kind === "site") return p.thread_id ? { label: "Allow in this thread", scope: "thread" } : null;
  if (p.kind === "secret") return d.secret?.kind === "card" ? null : { label: "Allow for this task", scope: "thread" };
  if (p.kind === "command") { const c = String(d.command || ""); return c.length > 120 || c.includes("\n") ? null : { label: "Approve once", scope: "once" }; }
  if (p.kind === "mcp" || p.kind === "file") return { label: "Approve once", scope: "once" };
  return null;
}

export function Waiting({ pits }: { pits: PitStop[] }) {
  const { S } = useStore();
  const titles = new Map(S.bots.flatMap((b) => b.threads.map((t) => [t.id, t.title] as const)));
  return (
    <section className="wait" aria-label="Waiting on you">
      {pits.slice(0, SHOWN).map((p) => <Row key={p.id} p={p} where={(p.thread_id && titles.get(p.thread_id)) || ""} />)}
      {pits.length > SHOWN && <div className="wf"><a href="#/pitstops">{`${pits.length - SHOWN} more waiting`}</a></div>}
    </section>);
}

function Row({ p, where }: { p: PitStop; where: string }) {
  const { bot, name } = useStore();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState("");
  const q = quick(p);
  // The row stays until /api/state drops the pit stop (the stream refreshes it); until then it says what you chose.
  const decide = async (decision: "approve" | "deny", scope?: string) => {
    setBusy(true);
    try {
      await api.post(`/api/pitstops/${p.id}/decide`, { decision, scope });
      toast(decision === "approve" ? "Approved" : "Denied");
      setDone(decision === "approve" ? "Approved" : "Denied");
    } finally { setBusy(false); }
  };
  return (
    <div className={`wr${open ? " open" : ""}`}>
      <div className="line">
        <Face b={bot(p.bot_id)} size="xs" mood="needs" />
        <button className="what" aria-expanded={open} title={open ? "Fold" : "Every choice and the details"} onClick={() => setOpen(!open)}>
          {pitHeading(p)}<span>{` · ${name(p.bot_id)}${where ? `, in ${where}` : ""}`}</span>
        </button>
        <div className="acts">
          {done ? <span className="done">{done}</span>
            : open ? <button className="pc-pill o s" onClick={() => setOpen(false)}>Fold</button>
            : q ? <>
              <button className="pc-pill s" disabled={busy} onClick={() => decide("approve", q.scope)}>{q.label}</button>
              <button className="pc-pill o s" disabled={busy} onClick={() => decide("deny")}>Deny</button></>
            : <button className="pc-pill s" onClick={() => setOpen(true)}>Review</button>}
        </div>
      </div>
      {open && !done && <PitCard p={p} onDone={(r) => setDone(r?.status === "approved" ? "Approved" : "Denied")} />}
    </div>);
}
