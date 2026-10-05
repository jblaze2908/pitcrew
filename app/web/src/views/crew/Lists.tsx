// Memory: one "Remember…" field, what only this member reads, what the whole crew reads, and its how-tos.
import { useState } from "react";
import type { BotCard, Memory } from "../../../../shared/types";
import { Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { HowTos } from "./DataTab";
import { SCOPE_LABEL } from "./ProfileTab";

type Scope = "agent" | "global";

// Own memory is capped at 3,000 characters and only it reads it. Shared memory (when linked) is about you, for the
// whole crew: a member's new notes wait for your review there; ones you add here save directly.
export function MemoryTab({ b, memory, global, error, reload }: { b: BotCard; memory: Memory[]; global: Memory[] | null; error: string | null; reload: () => void }) {
  const [text, setText] = useState(""), [scope, setScope] = useState<Scope>("agent");
  const add = async () => { if (!text.trim()) return; await api.post(`/api/bots/${b.id}/memory`, { text, scope }); setText(""); reload(); };
  const used = memory.reduce((n, m) => n + m.text.length, 0);
  return (
    <div className="mem">
      <div className="remember">
        <input placeholder={scope === "agent" ? `Remember… something ${b.name} should know for its job` : "Remember… a fact about you for the whole crew"} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} aria-label="Remember" />
        {global && <Seg options={[["agent", "Only this member"], ["global", "Whole crew"]] as const} value={scope} onChange={setScope} />}
        <button className="pc-pill s" disabled={!text.trim()} onClick={add}>Remember</button>
      </div>
      <MemoryList b={b} title="Only this member" note={`${used.toLocaleString("en-IN")} of 3,000 characters`} help={`How its job runs, site quirks, where things are. Only ${b.name} reads this.`} items={memory} scope="agent" reload={reload} />
      {global && <MemoryList b={b} title="Shared with the crew" help={`Facts about you that every member can read, kept under ${SCOPE_LABEL[b.engram_scope]}. New ones ${b.name} saves wait for your review in shared memory.`} items={global} scope="global" reload={reload} />}
      {error && <p className="small badc">{`Couldn't read shared memory: ${error}`}</p>}
      <section>
        <h3>How-tos</h3>
        <p className="intro">{`Steps ${b.name} wrote down once it worked out how a task runs. Kept in its workspace.`}</p>
        <HowTos b={b} />
      </section>
    </div>
  );
}

function MemoryList({ b, title, note, help, items, scope, reload }: { b: BotCard; title: string; note?: string; help: string; items: Memory[]; scope: Scope; reload: () => void }) {
  // Shared memories carry their source ("pitcrew:Finance Strategist"); show who added it.
  const who = (m: Memory) => (scope === "global" ? (m.source ? `added by ${m.source.replace(/^pitcrew:/, "")}` : "shared memory") : m.source === "driver" ? "you" : "learned in a thread");
  return (
    <section>
      <div className="ms-hrow"><h3>{title}</h3>{note && <span className="ms-h">{note}</span>}</div>
      <p className="intro">{help}</p>
      <div className="mrows">
        {items.length ? items.map((m) => (
          <div key={m.id} className="mrow">
            <div className="grow"><p>{m.text}</p><p className="ms-h">{`${who(m)} · ${when(m.created_at)}`}</p></div>
            <button className="lk2" onClick={async () => { await api.post(`/api/bots/${b.id}/memory/${m.id}/forget`); reload(); }}>Forget</button>
          </div>))
          : <p className="none">Nothing yet.</p>}
      </div>
    </section>
  );
}
