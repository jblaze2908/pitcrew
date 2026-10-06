// Permissions: the stop switch, the safety check, the mode new threads start in, approvals you've given, sites, the vault.
import type { Learned, Rule, State } from "../../../../shared/types";
import { RuleLabel } from "../../components/RuleLabel";
import { VaultSettings } from "../../components/Vault";
import { ConfirmButton, Face, Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useFetch } from "../../lib/useFetch";
import { useSetting } from "./General";
import { day, Row, Section, TabHead, Wide, useSaved } from "./kit";
import { Sites } from "./Sites";

type Mode = State["newThreadMode"];
// Labels only; the API keeps ask/handsfree/yolo. YOLO stays grey: its risk is in the words, not a colour.
const MODES: readonly (readonly [Mode, string, string])[] = [
  ["ask", "Ask first", "Asks before sending, paying, signing in, installing, sharing, deleting or opening a new site."],
  ["handsfree", "Hands-free", "Asks only for paying, signing in, sending, sharing, deleting and look-alike or non-https sites."],
  ["yolo", "YOLO", "Never stops to ask, paying and sending included. Blocked sites, hard blocks and house rules still hold."],
];

export function Permissions({ check, item }: { check: boolean; item?: string }) {
  // A vault entry (#/settings/vault/<id> or /new) opens its editor in place of the tab.
  if (item) return <VaultSettings item={item} />;
  return (
    <>
      <TabHead title="Permissions" intro="What the crew may do on its own, and the switch that stops everything." />
      <Stop />
      <AskingFirst check={check} />
      <Approvals />
      <Section id="sites" title="Sites" intro="Which sites the crew may open and how much it may do there. A member's own list wins, except Blocked here. Paying always asks.">
        <Wide className="st-flush"><Sites scope="global" /></Wide>
      </Section>
      <VaultSettings />
    </>
  );
}

function Stop() {
  const { S, setS, refresh } = useStore();
  return (
    <Section id="stop" title="Stop the crew">
      <Row label={S.paused ? "The crew is stopped" : "Stop every member now"}
        help={S.paused ? "Nothing runs and schedules wait until you resume." : "Interrupts every run, turns down waiting pit stops, shuts every computer and pauses schedules until you resume."}>
        {S.paused ? <button className="pc-pill s" onClick={async () => setS(await api.post("/api/resume"))}>Resume the crew</button>
          : <ConfirmButton className="pc-pill o s" armedClass="danger" ask="Stop everything?" onConfirm={async () => {
              const r = await api.post<{ inFlight: unknown[] }>("/api/kill");
              toast(`Stopped. ${r.inFlight.length} run${r.inFlight.length === 1 ? " was" : "s were"} mid-flight.`);
              await refresh();
            }}>Stop the crew</ConfirmButton>}
      </Row>
    </Section>
  );
}

function AskingFirst({ check }: { check: boolean }) {
  const { S } = useStore();
  const save = useSetting();
  const [modeSaved, flashMode] = useSaved();
  return (
    <Section id="asking" title="Asking first" intro="What a single member may do without asking lives on that member's Settings page.">
      <Row label="Safety check" help={check ? "Before a consequential action, a second model reads it and decides whether to ask you. Runs on your OpenRouter key."
        : <>Off: there's no OpenRouter key, so every consequential action asks you. Add one under <a href="#/settings/models">Models</a>.</>}>
        <span className="st-val">{check ? "On" : "Off"}</span>
      </Row>
      <Row label="New threads start in" help="Change it in any thread from its message box. Threads from schedules, email and other members ask first." saved={modeSaved}
        below={<div className="st-legend three">{MODES.map(([k, l, d]) => <div key={k}><b>{l}</b><span>{d}</span></div>)}</div>}>
        <Seg options={MODES.map(([k, l]) => [k, l] as const)} value={S.newThreadMode || "ask"} onChange={(m) => save({ newThreadMode: m }, flashMode)} />
      </Row>
    </Section>
  );
}

function Approvals() {
  const { bot, name } = useStore();
  const f = useFetch(() => Promise.all([api.get<Rule[]>("/api/rules"), api.get<Learned[]>("/api/learned")]), []);
  if (f.error && !f.data) return <p className="badc">{f.error}</p>;
  if (!f.data) return null;
  const [rules, learned] = f.data, taught = learned.filter((l) => l.streak > 0);
  const who = (id: string, n?: string) => n || name(id);
  return (
    <Section id="approvals" title="Approvals you've given" intro="Kinds of action you said yes to. Remove one and that member asks again.">
      {!rules.length && !taught.length && <Wide><p className="st-empty">None yet. Approve a pit stop with Always, or the same kind of action twice in a row, and it shows here.</p></Wide>}
      {rules.map((r) => (
        <Wide key={`r${r.id}`} className="st-member">
          <Face b={bot(r.bot_id)} size="xs" />
          <div className="st-rl"><p className="st-l"><RuleLabel label={r.label} /></p><p className="st-h">{`${who(r.bot_id, r.bot_name)} · you chose Always on ${day(r.created_at)}`}</p></div>
          <div className="st-ctl"><button className="st-q" onClick={async () => { await api.post(`/api/rules/${r.id}/revoke`); f.reload(); }}>Remove</button></div>
        </Wide>))}
      {taught.map((l) => {
        const on = l.streak >= l.need, left = l.need - l.streak;
        return (
          <Wide key={`l${l.id}`} className="st-member">
            <Face b={bot(l.bot_id)} size="xs" />
            <div className="st-rl"><p className="st-l">{l.label}</p>
              <p className="st-h">{`${who(l.bot_id, l.bot_name)} · ${on ? `learned from ${plural(l.streak, "yes", "yeses")} in a row, no longer asks` : `approved ${plural(l.streak, "time")}, asks ${plural(left, "more time")} before it stops asking`}`}</p></div>
            <div className="st-ctl"><button className="st-q" onClick={async () => { await api.post(`/api/learned/${l.id}/reset`); f.reload(); }}>Ask again</button></div>
          </Wide>);
      })}
    </Section>
  );
}
