// A crew plan as a living todo. Each "plan" event carries a full snapshot; the newest one for an id is the card.
import type { PlanItemView, PlanSnapshot } from "../../../shared/types";
import { api } from "../lib/api";
import { plainText, usd } from "../lib/format";
import { useStore } from "../lib/store";
import { ConfirmButton, Face, Loader, Md } from "./ui";

const ITEM_LABEL: Record<string, string> = { todo: "Waiting", doing: "Working", done: "Done", failed: "Didn't finish", cancelled: "Cancelled" };
const ITEM_MOOD: Record<string, string> = { doing: "working", done: "done", failed: "failed" };
const nothing = (x: string | null | undefined) => !x || /^nothing\.?$/i.test(x.trim());

const spendLine = (P: PlanSnapshot) => P.status === "done" ? `done · ${usd(P.spend)}` : P.status === "stopped" ? "stopped by you" : `${usd(P.spend)} of ${usd(P.budget)}`;
const doneOf = (P: PlanSnapshot) => [P.items.filter((i) => i.status === "done").length, P.items.length] as const;

/** The plan in the chat when the work panel can show it: goal, progress and who's on it now; the full todo opens in the panel. */
export function PlanChip({ P, onOpen }: { P: PlanSnapshot; onOpen: () => void }) {
  const { bot } = useStore();
  const [n, of] = doneOf(P);
  const doing = P.items.filter((i) => i.status === "doing");
  const now = doing.length ? `${doing.map((i) => i.ownerName).join(", ")} ${doing.length > 1 ? "are" : "is"} on ${doing.map((i) => i.key).join(", ")}${doing.some((i) => i.reopened) ? ", again" : ""}` : P.log?.length ? P.log[P.log.length - 1].text : P.status === "done" ? "Everyone's done." : "Waiting to start.";
  return (
    <button className="deleg planchip pc-card" onClick={onOpen}>
      <span className="row" style={{ gap: 10, flexWrap: "nowrap" }}><b className="pc-h3 trunc" style={{ flex: 1 }}>{P.goal}</b><span className="pc-m small faint">{`${n} of ${of} · ${spendLine(P)}`}</span></span>
      <span className="bar"><i style={{ width: `${of ? (n / of) * 100 : 0}%` }} /></span>
      <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
        {doing.length > 0 && <span className="faces">{doing.map((i) => <Face key={i.key} b={bot(i.owner) || null} size="xs" mood="working" />)}</span>}
        <span className="small muted trunc" style={{ flex: 1 }}>{now}</span><span className="small faint">Open plan ›</span>
      </span>
    </button>);
}

export function PlanCard({ P, flat }: { P: PlanSnapshot; flat?: boolean }) {
  const { chief } = useStore();
  const grade = (c: string) => P.checks?.find((x) => x.text.trim().toLowerCase() === c.trim().toLowerCase());
  const [n, of] = doneOf(P);
  return (
    <div className={flat ? "plan flat" : "deleg plan pc-card"}>
      <div className="ph">
        {!flat && <Face b={chief} size="xs" mood={P.status === "running" ? "working" : "idle"} />}
        <b className="pc-h3" style={{ flex: 1, minWidth: 0 }}>{P.goal}</b>
        <span className="pc-m small faint">{spendLine(P)}</span>
        {P.status === "running" && <ConfirmButton className="pc-pill o s" ask="Stop?" onConfirm={() => api.post(`/api/plans/${P.id}/stop`)}>Stop plan</ConfirmButton>}
      </div>
      {flat && <span className="bar"><i style={{ width: `${of ? (n / of) * 100 : 0}%` }} /></span>}
      {P.constraints?.length > 0 && (
        <div className="cons"><p className="pc-lab">Your constraints</p>
          {P.constraints.map((c, i) => { const k = grade(c); return (
            <div key={i} className="con">
              <span className={`pc-chip ${k?.status === "met" ? "ok" : k?.status === "unmet" ? "bad" : ""}`}>{k?.status === "met" ? "Met" : k?.status === "unmet" ? "Not met" : "Open"}</span>
              <span>{c}{k?.note && <span className="faint">{` · ${k.note}`}</span>}</span>
            </div>); })}
        </div>)}
      {P.status === "done" && P.answer && <div className="pans"><Md text={P.answer} /></div>}
      {flat && <p className="pc-lab">{`Todo · ${n} of ${of}`}</p>}
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
