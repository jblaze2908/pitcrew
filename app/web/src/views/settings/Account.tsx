// Account: change the password, sign out.
import { useState } from "react";
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { Row, Section, TabHead } from "./kit";

export function Account() {
  const [cur, setCur] = useState(""), [next, setNext] = useState("");
  return (
    <>
      <TabHead title="Account" intro="The password that opens Pitcrew, and this browser's session." />
      <Section title="Password" action={<BusyButton className="pc-pill s" onClick={async () => { await api.post("/api/password", { current: cur, next }); location.reload(); }}>Change password</BusyButton>}>
        <Row label="Current password"><input className="st-in" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Row>
        <Row label="New password" help="At least 12 characters."><input className="st-in" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Row>
      </Section>
      <Section title="Session">
        <Row label="Sign out" help="Signs this browser out of Pitcrew.">
          <BusyButton className="pc-pill o s" onClick={async () => { await api.post("/api/logout"); location.reload(); }}>Sign out</BusyButton>
        </Row>
      </Section>
    </>
  );
}
