// Notifications: pit stops and failed scheduled runs on the phone, through an ntfy topic. The token is write-only.
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";
import { Row, SecretRow, Section, TabHead, TextSave, useSaved } from "./kit";

type Push = { url: string; token: boolean };

export function Notifications() {
  const f = useFetch(() => api.get<Push>("/api/push"), []);
  const [urlSaved, flashUrl] = useSaved();
  if (f.error && !f.data) return <p className="badc">{f.error}</p>;
  if (!f.data) return null;
  const d = f.data;
  const test = async () => { const r = await api.post<{ ok: boolean }>("/api/push/test"); toast(r.ok ? "Sent. Check your phone" : "Couldn't reach the topic", !r.ok); };
  return (
    <>
      <TabHead title="Notifications" intro="Pit stops and failed scheduled runs on your phone. Nothing is pushed while Pitcrew is open in front of you." />
      <Section title="Phone" intro="Through an ntfy topic you subscribe to. Pit stops come with Approve and Deny; paying, hiring and plan changes only open Pitcrew."
        action={d.url ? <BusyButton className="pc-pill o s" onClick={test}>Send a test</BusyButton> : undefined}>
        <Row label="Topic address" help="Like https://ntfy.example.com/pitcrew-crew" saved={urlSaved}>
          <TextSave wide value={d.url} placeholder="https://ntfy.example.com/pitcrew-crew" onSave={async (url) => { await api.put("/api/push", { url }); f.reload(); flashUrl(); }} />
        </Row>
        <SecretRow label="Access token" help="Only if the topic is protected." has={d.token} placeholder="Paste the token"
          onSave={async (token) => { await api.put("/api/push", { url: d.url, token }); f.reload(); }}
          onRemove={async () => { await api.put("/api/push", { url: d.url, token: null }); f.reload(); }} />
      </Section>
    </>
  );
}
