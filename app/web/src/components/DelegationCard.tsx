// A question one member asked another; the newest "delegation" event for an id is the card.
import type { DelegationCard as Deleg } from "../../../shared/types";
import { usd } from "../lib/format";
import { useStore } from "../lib/store";
import { Face, Md } from "./ui";

const STATUS: Record<string, [string, string]> = { asking: ["Working…", ""], answered: ["Answered", "ok"], failed: ["Didn't finish", "bad"] };

export function DelegationCard({ d }: { d: Deleg }) {
  const { bot } = useStore();
  const to = bot(d.toBot);
  const name = to?.name || d.toName;
  const [label, tone] = STATUS[d.status] || [d.status, ""];
  return (
    <div className="deleg pc-card col">
      <div className="spread">
        <div className="row"><Face b={to} size="xs" mood={d.status === "asking" ? "working" : "idle"} /><b>{`Asked ${name}`}</b><span className={`pc-chip ${tone}`}>{label}</span></div>
        <a className="small faint" href={`#/t/${d.toThread}`}>Open their thread</a>
      </div>
      <p className="small muted">{d.question}</p>
      {d.answer && <details><summary className="small">{`Their answer${d.cost ? ` · ${usd(d.cost)} on ${name}'s cap` : ""}`}</summary><Md text={d.answer} /></details>}
    </div>
  );
}
