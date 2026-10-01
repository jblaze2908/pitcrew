// A crew plan as a living todo. Each "plan" event carries a full snapshot; the newest one for an id is the card.
import type { PlanItemView, PlanSnapshot } from "../../../shared/types";
import { api } from "../lib/api";
import { plainText, usd } from "../lib/format";
import { useStore } from "../lib/store";
import { ConfirmButton, Face, Loader, Md } from "./ui";

const ITEM_LABEL: Record<string, string> = { todo: "waits", doing: "on track", done: "done", failed: "didn't finish", cancelled: "cancelled" };
const ITEM_MOOD: Record<string, string> = { doing: "working", done: "done", failed: "failed" };
const nothing = (x: string | null | undefined) => !x || /^nothing\.?$/i.test(x.trim());

export function PlanCard({ P }: { P: PlanSnapshot }) {
  const { chief } = useStore();
  const grade = (c: string) => P.checks?.find((x) => x.text.trim().toLowerCase() === c.trim().toLowerCase());
  return (
    <div className="deleg plan pc-card">
      <div className="ph">
        <Face b={chief} size="xs" mood={P.status === "running" ? "working" : "idle"} />
        <b className="pc-h3" style={{ flex: 1, minWidth: 0 }}>{P.goal}</b>
        <span className="pc-m small faint">{P.status === "done" ? `DONE · ${usd(P.spend)}` : P.status === "stopped" ? "STOPPED BY YOU" : `${usd(P.spend)} OF ${usd(P.budget)}`}</span>
        {P.status === "running" && <ConfirmButton className="pc-pill o s" ask="Stop?" onConfirm={() => api.post(`/api/plans/${P.id}/stop`)}>Stop plan</ConfirmButton>}
      </div>
      {P.constraints?.length > 0 && (
        <div className="cons"><p className="pc-lab">Your constraints</p>
          {P.constraints.map((c, i) => { const k = grade(c); return (
            <div key={i} className="con">
              <span className={`pc-chip ${k?.status === "met" ? "ok" : k?.status === "unmet" ? "bad" : ""}`}>{k?.status || "open"}</span>
              <span>{c}{k?.note && <span className="faint">{` · ${k.note}`}</span>}</span>
            </div>); })}
        </div>)}
      {P.status === "done" && P.answer && <div className="pans"><Md text={P.answer} /></div>}
      {P.items.map((i) => <PlanItem key={i.key} i={i} />)}
      {P.sweep && (
        <div className="sweep"><p className="pc-lab">Alternatives check</p>
          {P.sweep.map((x, k) => <p key={k} className="small"><b>{`${x.who}: `}</b><span style={x.found ? { color: "var(--data)" } : undefined}>{plainText(x.text).slice(0, 260)}</span></p>)}
        </div>)}
      {P.log?.length > 0 && <div className="plog">{P.log.slice(-4).map((l, k) => <p key={k}>{`Chief · ${l.text}`}</p>)}</div>}
    </div>
  );
}

function PlanItem({ i }: { i: PlanItemView }) {
  const { bot } = useStore();
  const who = bot(i.owner) || { name: i.ownerName };
  const r = i.result;
  const box = i.status === "done" ? "done" : i.status === "doing" ? "doing" : i.reopened && i.status === "todo" ? "re" : "";
  return (
    <div className={`it ${["todo", "cancelled"].includes(i.status) ? "dim" : ""}`}>
      <span className={`box ${box}`} />
      <Face b={"hue" in who ? who : null} size="sm" mood={ITEM_MOOD[i.status] || "idle"} />
      <div className="col" style={{ gap: 3, minWidth: 0 }}>
        <b className="small">{who.name}<span className="k">{`${i.key}${i.after?.length ? ` · after ${i.after.join(", ")}` : ""}${i.reopened ? " · again" : ""}`}</span></b>
        <p className="small muted">{i.task}</p>
        {i.why && <p className="why">{`Why again: ${i.why} · run ${i.runs} of ${i.allowed}`}</p>}
        {r?.answer && <p className="small ans">{plainText(r.answer).slice(0, 320)}</p>}
        {r && !nothing(r.assumed) && <p className="small" style={{ color: "var(--warn)" }}>{`Assumed: ${r.assumed}`}</p>}
        {r && !nothing(r.options) && <p className="small" style={{ color: "var(--data)" }}>{`Other options: ${r.options}`}</p>}
      </div>
      <span className="col" style={{ gap: 4, alignItems: "flex-end" }}>
        <span className={`st ${i.status === "done" ? "ok" : ""}`}>{i.status === "doing" && <Loader />}{ITEM_LABEL[i.status] || i.status}{i.cost ? ` · ${usd(i.cost)}` : ""}</span>
        {i.toThread && <a className="small faint" href={`#/t/${i.toThread}`}>Open</a>}
      </span>
    </div>
  );
}
