import type { BotCard } from "../../../../shared/types";
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { go } from "../../lib/router";
import { toast } from "../../lib/toast";

export function ComputerTab({ b, reload }: { b: BotCard; reload: () => void }) {
  const c = b.computer;
  return (
    <div className="pc-card col">
      <div className="spread">
        <div className="col" style={{ gap: 4 }}>
          <div className="row"><b className="pc-h3">{`${b.name}'s computer`}</b><span className={`pc-chip ${c.desktop ? "ok" : c.up ? "blue" : ""}`}>{c.desktop ? "desktop live" : c.up ? "runtime up" : "off"}</span></div>
          <p className="small muted">{c.desktop ? `Up since ${when(c.startedAt)} with its desktop and browser.`
            : c.up ? `Up since ${when(c.startedAt)} for commands; the desktop starts on the first browser action.`
            : "In the garage. Chat needs no computer: it starts on the first command or browser action, or when you want to look."}</p>
        </div>
        <div className="row">
          {c.desktop ? <a className="pc-pill s" href={`#/live/${b.id}`}>Live view</a>
            : <BusyButton className="pc-pill s" busyLabel="Starting…" onClick={async () => { await api.post(`/api/bots/${b.id}/computer/start`).catch(() => {}); go(`#/live/${b.id}`); }}>Start and watch</BusyButton>}
          {c.up && <button className="pc-pill o s" onClick={async () => { await api.post(`/api/bots/${b.id}/computer/stop`); toast("Computer stopped"); reload(); }}>Stop</button>}
        </div>
      </div>
      <p className="small faint">Logins you make in the live view stay in this crew member's browser only. Other crew members can't see them.</p>
    </div>
  );
}
