// Your asks: the latest front-door threads with their live state and short answers, so most asks need no click.
import { useEffect, useState } from "react";
import type { Ask } from "../../../shared/types";
import { api } from "../lib/api";
import { ago, plainText } from "../lib/format";
import { useStore } from "../lib/store";
import { Face, Loader } from "./ui";

/** Refetches when /api/state changes (an ask's thread moved) or `version` bumps (you just sent one). */
export function AsksList({ version }: { version: number }) {
  const { S } = useStore();
  const [list, setList] = useState<Ask[]>([]);
  useEffect(() => {
    let live = true;
    api.get<Ask[]>("/api/asks", { quiet: true }).catch(() => []).then((l) => { if (live) setList(l); });
    return () => { live = false; };
  }, [version, S]);
  if (!list.length) return null;
  return (
    <section className="pc-card asks">
      <div className="spread asks-h"><p className="pc-lab">Your asks</p><span className="small faint">Each one has its own thread</span></div>
      {list.map((a) => <AskRow key={a.id} a={a} />)}
    </section>
  );
}

function AskRow({ a }: { a: Ask }) {
  const { S, bot } = useStore();
  const b = bot(a.botId);
  const members = (a.plan?.members || []).map(bot).filter((x) => !!x);
  const pit = a.status === "needs" || S.pitstops.some((p) => p.thread_id === a.id);
  const sub = pit ? "Waiting on you" : a.answer ? plainText(a.answer) : a.plan ? `Plan: ${a.plan.done} of ${a.plan.total} done` : a.running ? "Starting…" : "";
  const state = pit ? <span className="pc-chip hot">Pit stop</span>
    : a.running || a.plan?.status === "running"
      ? <span className="row" style={{ gap: 6 }}><Loader /><span className="small faint">{a.plan ? `${a.plan.done} of ${a.plan.total}` : "Working"}</span></span>
      : <span className="small faint">{`${a.answer ? "Answered" : "Done"} · ${ago(a.updatedAt)}`}</span>;
  return (
    <a className="askrow" href={`#/t/${a.id}`}>
      <span className="faces"><Face b={b} size="sm" mood={a.running ? "working" : pit ? "needs" : "idle"} />{members.slice(0, 3).map((x) => <Face key={x.id} b={x} size="sm" />)}</span>
      <span className="col" style={{ gap: 2, minWidth: 0 }}><span className="t ell">{a.title}</span><span className="small faint ell">{sub}</span></span>
      <span className="pc-chip">{b?.name || "?"}</span>
      {state}
    </a>
  );
}
