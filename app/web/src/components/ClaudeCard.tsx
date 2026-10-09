// A Claude Code run a member started; the newest "claude" event for an id is the card. Steps stay grey sentences; its
// question, if any, is a pit stop of its own below (PitCard QuestionBody).
import type { ClaudeCard as Card } from "../../../shared/types";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { Md } from "./ui";

const LIVE = new Set(["queued", "working", "asking"]);
const mins = (ms: number) => (ms < 60000 ? "under a minute" : `${Math.round(ms / 60000)} min`);

export function ClaudeCard({ c }: { c: Card }) {
  const live = LIVE.has(c.status);
  const state = c.status === "queued" ? "waiting for another Claude Code run"
    : c.status === "working" ? `working · ${mins(Date.now() - c.startedAt)}`
    : c.status === "asking" ? "asked you a question"
    : c.status === "done" ? `done in ${mins((c.endedAt || c.startedAt) - c.startedAt)} · on your Claude plan`
    : c.status === "stopped" ? "stopped" : "didn't finish";
  const did = [c.read ? `read ${plural(c.read, "file")}` : "", c.edited.length ? `edited ${plural(c.edited.length, "file")}` : "", c.commands ? `ran ${plural(c.commands, "command")}` : "",
    c.questions ? `asked you ${plural(c.questions, "question")}` : ""].filter(Boolean).join(", ");
  return (
    <div className="cc pc-card col">
      <div className="row"><span className="cc-mark">CC</span><b>Claude Code</b><span className={`small ${c.status === "failed" ? "bad" : "faint"}`}>{`· ${state}`}</span>
        {live && <button className="small faint cc-stop" onClick={() => api.post(`/api/claude-code/${c.id}/stop`)}>Stop</button>}</div>
      <p className="small muted">{c.task}</p>
      {live ? c.steps.length > 0 && <div className="cc-steps small faint">{c.steps.map((s, i) => <span key={i}>{s}</span>)}</div>
        : did && <p className="small faint">{`${did[0].toUpperCase()}${did.slice(1)}${c.status === "done" ? "" : " before it stopped"}`}</p>}
      {c.error && <p className="small faint">{c.error}</p>}
      {c.answer && <div className="cc-ans"><Md text={c.answer} /></div>}
    </div>
  );
}
