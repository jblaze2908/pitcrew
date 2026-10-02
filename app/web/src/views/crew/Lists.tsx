// Memory and schedules: a small add row over a table.
import { useState } from "react";
import type { BotCard, Memory, Schedule } from "../../../../shared/types";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { toast } from "../../lib/toast";
import { SCOPE_LABEL } from "./ProfileTab";

// A linked member's memories live in Engram; this lists that member's own and adds or forgets there.
export function MemoryTab({ b, memory, memoryIn, error, reload }: { b: BotCard; memory: Memory[]; memoryIn: "pitcrew" | "engram"; error: string | null; reload: () => void }) {
  const [text, setText] = useState("");
  const engram = memoryIn === "engram";
  const add = async () => {
    if (!text.trim()) return;
    const r = await api.post<{ status?: string }>(`/api/bots/${b.id}/memory`, { text });
    if (r.status && r.status !== "accepted") toast("Engram is holding it for review in Pit stops");
    setText(""); reload();
  };
  const who = (m: Memory) => (engram ? m.source || "Engram" : m.source === "driver" ? "you" : "learned in a thread");
  return (
    <div className="col">
      {engram && <p className="small muted">{`In Engram, under ${SCOPE_LABEL[b.engram_scope]}. Engram is the source; edit or retract there for anything beyond forgetting.`}</p>}
      {error && <p className="small badc">{`Couldn't read Engram: ${error}`}</p>}
      <div className="row"><div style={{ flex: 1 }}><input placeholder="Add a fact this crew member should know" value={text} onChange={(e) => setText(e.target.value)} /></div><button className="pc-pill s" onClick={add}>Add</button></div>
      <div className="pc-card tight">
        {memory.length ? (
          <table className="tbl"><tbody>{memory.map((m) => (
            <tr key={m.id}>
              <td>{m.text}</td><td className="small faint">{who(m)}</td><td className="num faint small">{when(m.created_at)}</td>
              <td className="num"><button className="small faint" onClick={async () => { await api.post(`/api/bots/${b.id}/memory/${m.id}/forget`); reload(); }}>Forget</button></td>
            </tr>))}</tbody></table>
        ) : <p className="empty">Nothing remembered yet.</p>}
      </div>
    </div>
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
          <table className="tbl"><tbody>{list.map((s) => (
            <tr key={s.id}>
              <td className="pc-m">{s.spec}</td><td>{s.prompt}</td><td className="small faint">{s.next_run ? `next ${when(s.next_run)}` : ""}</td>
              <td className="num"><button className="small faint" onClick={async () => { await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled }); reload(); }}>{s.enabled ? "Pause" : "Resume"}</button></td>
            </tr>))}</tbody></table>
        ) : <p className="empty">No schedules.</p>}
      </div>
    </div>
  );
}
