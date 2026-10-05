// Memory and schedules: a small add row over a table.
import { useState } from "react";
import type { BotCard, Memory, Schedule } from "../../../../shared/types";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { toast } from "../../lib/toast";
import { SCOPE_LABEL } from "./ProfileTab";

// A linked member's memories live in Engram (shown as "shared memory"); this lists that member's own and adds or forgets there.
// Two tiers: the member's own memory (it writes freely, capped at 3,000 chars) and global notes in Engram (about you,
// for the whole crew; a member's go through your review, yours save directly).
export function MemoryTab({ b, memory, global, error, reload }: { b: BotCard; memory: Memory[]; global: Memory[] | null; error: string | null; reload: () => void }) {
  const used = memory.reduce((n, m) => n + m.text.length, 0);
  return (
    <div className="col">
      <MemoryList b={b} title={`Own memory · ${used} / 3,000 chars`} help={`${b.name}'s working knowledge: how its job runs, site quirks, where things are. Only it reads this.`} items={memory} scope="agent" reload={reload} />
      {global && <MemoryList b={b} title="Shared with the whole crew" help={`Facts about you that ${b.name} saved for everyone, kept as ${SCOPE_LABEL[b.engram_scope]}. Its new ones wait for your review in the memory app; ones you add here save directly.`} items={global} scope="global" reload={reload} />}
      {error && <p className="small badc">{`Couldn't read shared memory: ${error}`}</p>}
    </div>
  );
}
function MemoryList({ b, title, help, items, scope, reload }: { b: BotCard; title: string; help: string; items: Memory[]; scope: "agent" | "global"; reload: () => void }) {
  const [text, setText] = useState("");
  const add = async () => { if (!text.trim()) return; await api.post(`/api/bots/${b.id}/memory`, { text, scope }); setText(""); reload(); };
  // Shared memories carry the memory app's source ("pitcrew:Finance Strategist"); show who added it.
  const who = (m: Memory) => (scope === "global" ? (m.source ? `added by ${m.source.replace(/^pitcrew:/, "")}` : "shared memory") : m.source === "driver" ? "you" : "learned in a thread");
  return (
    <section className="col">
      <p className="pc-lab">{title}</p><p className="small muted">{help}</p>
      <div className="row"><div style={{ flex: 1 }}><input placeholder={scope === "agent" ? "Add something this member should know for its job" : "Add a fact about you for the whole crew"} value={text} onChange={(e) => setText(e.target.value)} /></div><button className="pc-pill s" onClick={add}>Add</button></div>
      <div className="pc-card tight">
        {items.length ? (
          <table className="tbl"><tbody>{items.map((m) => (
            <tr key={m.id}>
              <td>{m.text}</td><td className="small faint">{who(m)}</td><td className="num faint small">{when(m.created_at)}</td>
              <td className="num"><button className="small faint" onClick={async () => { await api.post(`/api/bots/${b.id}/memory/${m.id}/forget`); reload(); }}>Forget</button></td>
            </tr>))}</tbody></table>
        ) : <p className="empty">Nothing yet.</p>}
      </div>
    </section>
  );
}

export function SchedulesTab({ b, list, reload }: { b: BotCard; list: Schedule[]; reload: () => void }) {
  const [spec, setSpec] = useState(""), [prompt, setPrompt] = useState("");
  const add = async () => { await api.post(`/api/bots/${b.id}/schedules`, { spec, prompt }); setSpec(""); setPrompt(""); reload(); };
  return (
    <div className="col">
      <div className="grid2">
        <input placeholder="daily 09:00 · weekly mon 08:30 · every 6 hours" value={spec} onChange={(e) => setSpec(e.target.value)} />
        <div className="row"><div style={{ flex: 1 }}><input placeholder="What to do" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div><button className="pc-pill s" onClick={add}>Add</button></div>
      </div>
      <div className="pc-card tight">
        {list.length ? (
          <table className="tbl"><tbody>{list.map((s) => <ScheduleRow key={s.id} s={s} reload={reload} />)}</tbody></table>
        ) : <p className="empty">No schedules.</p>}
      </div>
    </div>
  );
}

function ScheduleRow({ s, reload }: { s: Schedule; reload: () => void }) {
  const [edit, setEdit] = useState<{ spec: string; prompt: string } | null>(null);
  const patch = async (b: object) => { await api.patch(`/api/schedules/${s.id}`, b); setEdit(null); reload(); };
  const remove = async () => { if (!window.confirm(`Delete the schedule “${s.prompt.slice(0, 60)}”?`)) return; await api.del(`/api/schedules/${s.id}`); toast("Schedule deleted"); reload(); };
  if (edit) return (
    <tr>
      <td><input value={edit.spec} onChange={(e) => setEdit({ ...edit, spec: e.target.value })} aria-label="When" /></td>
      <td colSpan={2}><textarea rows={3} value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} aria-label="What to do" style={{ width: "100%" }} /></td>
      <td className="num"><div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="small" onClick={() => patch(edit)}>Save</button><button className="small faint" onClick={() => setEdit(null)}>Cancel</button></div></td>
    </tr>
  );
  return (
    <tr>
      <td className="pc-m">{s.spec}</td><td>{s.prompt}</td>
      <td className="small faint">{s.enabled ? (s.next_run ? `Next ${when(s.next_run)}` : "") : "Paused"}
        {s.last && <><br /><a className={s.last.status === "failed" ? "badc" : "faint"} href={s.last.threadId ? `#/t/${s.last.threadId}` : undefined} title={s.last.summary}>{`last ${when(s.last.at)} · ${s.last.status}${s.last.summary ? ` · ${s.last.summary.slice(0, 60)}` : ""}`}</a></>}</td>
      <td className="num"><div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="small faint" onClick={() => setEdit({ spec: s.spec, prompt: s.prompt })}>Edit</button>
        <button className="small faint" onClick={() => patch({ enabled: !s.enabled })}>{s.enabled ? "Pause" : "Resume"}</button>
        <button className="small faint" onClick={remove}>Delete</button></div></td>
    </tr>
  );
}
