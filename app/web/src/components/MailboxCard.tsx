// A member's email address (runtime/mail.ts): its handle, who else may wake it, and what happens to other mail.
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { BusyButton, Field, Seg } from "./ui";

export function MailboxCard({ botId, name, domain, onSaved }: { botId: string; name: string; domain: string; onSaved: () => void }) {
  const f = useFetch(() => api.get<{ box: { handle: string; senders: string[]; others: "hold" | "drop" } | null }>(`/api/bots/${botId}/mailbox`), [botId]);
  const [handle, setHandle] = useState<string | null>(null), [senders, setSenders] = useState<string | null>(null), [others, setOthers] = useState<"hold" | "drop" | null>(null);
  if (!f.data) return null;
  const box = f.data.box, h = handle ?? box?.handle ?? name.toLowerCase().replace(/[^a-z0-9]+/g, ""), snd = senders ?? (box?.senders || []).join(", "), oth = others ?? box?.others ?? "hold";
  const save = async () => { await api.put(`/api/bots/${botId}/mailbox`, { handle: h, senders: snd.split(/[\s,]+/).filter(Boolean), others: oth }); f.reload(); onSaved(); toast("Saved"); };
  const off = async () => { await api.put(`/api/bots/${botId}/mailbox`, { off: true }); f.reload(); onSaved(); };
  return (
    <div className="pc-card col">
      <div className="spread"><b className="pc-h3">{name}</b><span className={`pc-chip ${box ? "ok" : ""}`}>{box ? `${box.handle}@${domain}` : "No address"}</span></div>
      <div className="row" style={{ alignItems: "flex-end" }}><Field label="Address"><input value={h} onChange={(e) => setHandle(e.target.value)} /></Field><span className="small faint" style={{ paddingBottom: 10 }}>{`@${domain}`}</span></div>
      <Field label="Who else may wake it" help="Addresses, or a whole domain as @bescom.co.in"><input placeholder="@bescom.co.in, billing@airtel.in" value={snd} onChange={(e) => setSenders(e.target.value)} /></Field>
      <Field label="Anyone else"><Seg options={[["hold", "Hold for me"], ["drop", "Drop"]] as const} value={oth} onChange={setOthers} /></Field>
      <div className="row"><BusyButton className="pc-pill s" onClick={save}>{box ? "Save" : "Give it an address"}</BusyButton>{box && <BusyButton className="pc-pill o s" onClick={off}>Turn off</BusyButton>}</div>
    </div>
  );
}
