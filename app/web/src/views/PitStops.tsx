// Everything waiting on you (with batch decide), the standing approvals, what was learned, and the history.
import { useState } from "react";
import type { Learned, PitStop, Rule } from "../../../shared/types";
import { LearnedList, RulesList } from "../components/Approvals";
import { PitCard } from "../components/PitCard";
import { EffectChip } from "../components/ui";
import { api } from "../lib/api";
import { when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

interface Data { pending: PitStop[]; history: PitStop[]; rules: Rule[]; learned: Learned[] }

export function PitStops() {
  const { bot } = useStore();
  const { data, error, reload } = useFetch(async (): Promise<Data> => {
    const [pending, history, rules, learned] = await Promise.all([
      api.get<PitStop[]>("/api/pitstops?status=pending"), api.get<PitStop[]>("/api/pitstops"), api.get<Rule[]>("/api/rules"), api.get<Learned[]>("/api/learned")]);
    return { pending, history, rules, learned };
  }, []);
  useLiveReload((e) => e.type === "pitstop", reload);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  if (!data) return null;

  const toggle = (id: string, on: boolean) => setPicks((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const batch = async (decision: "approve" | "deny") => {
    if (!picks.size) return toast("Pick some pit stops first");
    await api.post("/api/pitstops/batch", { ids: [...picks], decision });
    toast(`${decision === "approve" ? "Approved" : "Denied"} ${picks.size}`);
    setPicks(new Set()); reload();
  };
  return (
    <div className="page">
      <div className="spread"><h1 className="pc-h2">Pit stops</h1>
        {data.pending.length > 1 && <div className="row"><button className="pc-pill sig s" onClick={() => batch("approve")}>Approve selected</button><button className="pc-pill o s" onClick={() => batch("deny")}>Deny selected</button></div>}
      </div>
      {data.pending.length ? (
        <div className="col">{data.pending.map((p) => (
          <div key={p.id} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            {p.kind !== "hire" && p.kind !== "engram" ? <input type="checkbox" style={{ marginTop: 22 }} checked={picks.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /> : <span style={{ width: 13 }} />}
            <div style={{ flex: 1 }}><PitCard p={p} /></div>
          </div>))}
        </div>
      ) : (
        <div className="pc-card empty"><pc-bot size="lg" hue="c3" mood="done" /><p style={{ marginTop: 12 }}>Nothing waiting. Ignored pit stops expire after 30 minutes and nothing happens.</p></div>
      )}
      <p className="pc-lab">Standing approvals</p><RulesList rules={data.rules} after={reload} />
      <p className="pc-lab">Learned</p><LearnedList items={data.learned} after={reload} />
      <p className="pc-lab">History</p>
      <div className="pc-card tight scrollx">
        <table className="tbl">
          <thead><tr><th>When</th><th>Crew</th><th>Effect</th><th>What</th><th>Outcome</th><th>Decided by</th></tr></thead>
          <tbody>{data.history.filter((p) => p.status !== "pending").slice(0, 80).map((p) => (
            <tr key={p.id}>
              <td className="small faint">{when(p.created_at)}</td><td>{bot(p.bot_id)?.name || p.bot_id}</td><td><EffectChip kind={p.effect} /></td><td>{p.title}</td>
              <td><span className={`pc-chip ${p.status === "approved" ? "ok" : p.status === "denied" ? "bad" : ""}`}>{p.status}</span></td>
              <td className="small faint">{p.kind === "engram" ? p.note || "Engram" : p.status === "expired" ? "timeout" : p.scope || "once"}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
