// Standing approvals and learned patterns, shown on Pit stops (crew-wide) and each member's Rules tab.
import type { Learned, Rule } from "../../../shared/types";
import { api } from "../lib/api";
import { when } from "../lib/format";
import { toast } from "../lib/toast";

export function RulesList({ rules, after }: { rules: Rule[]; after: () => void }) {
  return (
    <div className="pc-card tight">
      {rules.length ? (
        <table className="tbl">
          <thead><tr><th>Standing approval</th><th>Effect</th><th>Crew</th><th>Since</th><th /></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id}>
              <td className="pc-m">{r.label}</td><td><pc-effect key={r.effect} kind={r.effect}>{r.effect}</pc-effect></td><td>{r.bot_name || r.bot_id}</td><td className="small faint">{when(r.created_at)}</td>
              <td className="num"><button className="small sig" onClick={async () => { await api.post(`/api/rules/${r.id}/revoke`); toast("Revoked"); after(); }}>Revoke</button></td>
            </tr>))}
          </tbody>
        </table>
      ) : <p className="empty">No standing approvals. Approve with "Always" or "For this thread" to create one.</p>}
    </div>
  );
}

export function LearnedList({ items, after }: { items: Learned[]; after: () => void }) {
  return (
    <div className="pc-card tight scrollx">
      {items.length ? (
        <table className="tbl">
          <thead><tr><th>Learned from your approvals</th><th>Effect</th><th>Crew</th><th className="num">Approved</th><th>State</th><th /></tr></thead>
          <tbody>{items.map((l) => {
            const on = l.streak >= l.need;
            return (
              <tr key={l.id}>
                <td>{l.label}</td><td><pc-effect key={l.effect} kind={l.effect}>{l.effect.replace("_", " ")}</pc-effect></td><td>{l.bot_name || l.bot_id}</td>
                <td className="num pc-m small">{`${l.approvals}${l.denials ? ` · ${l.denials} denied` : ""}`}</td>
                <td><span className={`pc-chip ${on ? "ok" : ""}`}>{on ? "no longer asks" : `${l.streak} of ${l.need}`}</span></td>
                <td className="num">{on && <button className="small sig" onClick={async () => { await api.post(`/api/learned/${l.id}/reset`); toast("It will ask again"); after(); }}>Ask again</button>}</td>
              </tr>);
          })}</tbody>
        </table>
      ) : <p className="empty">Nothing learned yet. Approve the same kind of action twice in a row and the crew stops asking, unless it signs in, installs, sends, pays, deletes or shares.</p>}
    </div>
  );
}
