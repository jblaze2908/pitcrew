// Standing approvals and learned patterns, shown on Pit stops (crew-wide) and each member's Rules tab.
import type { Learned, Rule } from "../../../shared/types";
import { api } from "../lib/api";
import { when } from "../lib/format";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { EffectChip } from "./ui";

const BROWSER_RULE: Record<string, string> = { run_code_unsafe: "Run browser scripts", evaluate: "Run page JavaScript", navigate: "Open pages", click: "Click", type: "Type" };
/** Rule labels are stored as matched ("browser browser_run_code_unsafe", "run python3 bot/work/x.py"); say them as an action. */
export function RuleLabel({ label }: { label: string }) {
  const [, core, scope = ""] = /^(.*?)( \(this thread\))?$/.exec(label.replace(/(\/?bot\/work\/)/g, "")) || [];
  const br = /^browser browser_(\w+)$/.exec(core);
  const run = /^run (.+)$/.exec(core);
  const body = br ? BROWSER_RULE[br[1]] || `Browser: ${br[1].replace(/_/g, " ")}` : run ? <>Run <code className="pc-m">{run[1]}</code></> : core;
  return <>{body}{scope && <span className="faint">{scope}</span>}</>;
}

export function RulesList({ rules, after }: { rules: Rule[]; after: () => void }) {
  const { name } = useStore();
  return (
    <div className="pc-card tight">
      {rules.length ? (
        <table className="tbl">
          <thead><tr><th>Standing approval</th><th>Effect</th><th>Crew</th><th>Since</th><th /></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id}>
              <td><RuleLabel label={r.label} /></td><td><EffectChip kind={r.effect} /></td><td>{r.bot_name || name(r.bot_id)}</td><td className="small faint">{when(r.created_at)}</td>
              <td className="num"><button className="small faint" onClick={async () => { await api.post(`/api/rules/${r.id}/revoke`); toast("Revoked"); after(); }}>Revoke</button></td>
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
                <td>{l.label}</td><td><EffectChip kind={l.effect} /></td><td>{l.bot_name || l.bot_id}</td>
                <td className="num pc-m small">{`${l.approvals}${l.denials ? ` · ${l.denials} denied` : ""}`}</td>
                <td><span className={`pc-chip ${on ? "ok" : ""}`}>{on ? "No longer asks" : `${l.streak} of ${l.need}`}</span></td>
                <td className="num">{on && <button className="small faint" onClick={async () => { await api.post(`/api/learned/${l.id}/reset`); toast("It will ask again"); after(); }}>Ask again</button>}</td>
              </tr>);
          })}</tbody>
        </table>
      ) : <p className="empty">Nothing learned yet. Approve the same kind of action twice in a row and the crew stops asking, unless it signs in, installs, sends, pays, deletes or shares.</p>}
    </div>
  );
}
