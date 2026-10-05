// What the crew did this week, what it cost, and what's left with each provider.
import type { ReactNode } from "react";
import type { OpenRouterUsage, PlanLimits, PlanWindow, Telemetry as T } from "../../../shared/types";
import { ErrorText, Meter, Track } from "../components/ui";
import { api } from "../lib/api";
import { ago, cap, plural, tokens, until, usd, when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { go } from "../lib/router";
import { useFetch } from "../lib/useFetch";

// What started a run (the turns' trigger values), in plain words.
const TRIGGER: Record<string, string> = { driver: "You", schedule: "Schedule", email: "Email", delegation: "Another member", plan: "Plan step", resume: "Picked up again",
  retro: "Review", check: "Done-check retry", surface: "Dashboard", teach: "Teach by doing" };
const usedTone =(pct: number) => (pct >= 90 ? "bad" : pct >= 70 ? "hot" : "");

export function Telemetry() {
  const { data: t, error, reload } = useFetch(() => api.get<T>("/api/telemetry"), []);
  useLiveReload((e) => e.type === "turn", reload, 2000);
  if (error && !t) return <div className="page"><p className="badc">{error}</p></div>;
  if (!t) return null;
  const ps = t.pitstops;
  return (
    <div className="page">
      <div className="spread"><h1 className="pc-h2">Telemetry</h1><div className="row"><a className="pc-pill o s" href="/api/export" download="">Export everything (JSON)</a></div></div>
      <div className="grid2">
        <div className="pc-card col"><p className="pc-lab">Handled this week</p><span className="big num">{String(t.handled)}</span><p className="small muted">runs completed</p></div>
        <div className="pc-card col"><p className="pc-lab">Asked of you</p><span className="big num">{String(ps?.total || 0)}</span>
          <p className="small muted">{`pit stops · ${ps?.approved || 0} approved · ${ps?.denied || 0} denied · ${ps?.expired || 0} expired · crew waited ${Math.round((ps?.wait_ms || 0) / 60000)} min on you`}</p></div>
      </div>
      <p className="pc-lab">What's left with each provider</p>
      <div className="grid2"><OpenRouterLeft o={t.openrouter} /><PlanLeft c={t.chatgpt} /></div>
      <p className="pc-lab">Spend by crew member (this week; billed by the provider, list-price estimate otherwise)</p>
      <div className="pc-card col">{t.bots.map((b) => (
        <div key={b.id} className="col" style={{ gap: 4 }}>
          <div className="spread">
            <div className="row"><pc-bot key={`${b.hue}.${b.shape}`} size="xs" hue={b.hue} shape={b.shape} /><b>{b.name}</b><span className="small faint">{`${plural(b.runs, "run")}${b.failed ? ` · ${b.failed} failed` : ""}`}</span></div>
            <span className="pc-m small">{`${usd(b.spend)} / ${usd(b.cap)}`}</span>
          </div>
          <Track pct={(b.spend / (b.cap || 1)) * 100} hue={b.hue} shape={b.shape} />
        </div>))}
      </div>
      {t.byModel.length > 0 && <>
        <p className="pc-lab">By model</p>
        <div className="pc-card tight scrollx"><table className="tbl">
          <thead><tr><th>Provider</th><th>Model</th><th className="num">Runs</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cost</th></tr></thead>
          <tbody>{t.byModel.map((m) => (
            <tr key={`${m.provider}/${m.model}`}><td>{m.provider}</td><td className="pc-m">{m.model}</td><td className="num">{m.runs}</td><td className="num">{tokens(m.input)}</td><td className="num">{tokens(m.output)}</td><td className="num">{m.provider === "openai" ? "plan" : usd(m.usd)}</td></tr>))}
          </tbody>
        </table></div>
      </>}
      <p className="pc-lab">Runs</p>
      <div className="pc-card tight scrollx">
        {t.runs.length ? <table className="tbl">
          <thead><tr><th>Started</th><th>Crew</th><th>Thread</th><th>Trigger</th><th>Outcome</th><th className="num">Tokens in/out</th><th className="num">Cost</th></tr></thead>
          <tbody>{t.runs.map((r) => (
            <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => go(`#/t/${r.thread_id}`)}>
              <td className="small faint nw">{when(r.started_at)}</td><td className="nw">{r.bot_name}</td><td className="what">{r.thread_title}</td><td className="small">{TRIGGER[r.trigger] || cap(r.trigger)}</td>
              <td className="outc"><span className={`pc-chip ${r.status === "completed" ? "ok" : r.status === "failed" ? "bad" : ""}`}>{cap(r.status)}</span>{r.error && <ErrorText raw={r.error} />}</td>
              <td className="num pc-m small">{`${tokens(r.input_tokens)} / ${tokens(r.output_tokens)}`}</td>
              <td className="num pc-m" title={r.cost_basis === "billed" ? "Billed by the provider" : r.cost_basis === "list" ? "Estimate from list price" : ""}>
                {r.cost_basis === "plan" ? "plan" : r.cost_basis === "unknown" ? "?" : `${usd(r.cost_usd)}${r.cost_basis === "list" ? " est." : ""}`}</td>
            </tr>))}
          </tbody>
        </table> : <p className="empty">No runs yet.</p>}
      </div>
    </div>
  );
}

function OpenRouterLeft({ o }: { o: OpenRouterUsage | null }) {
  const card = (kids: ReactNode) => <div className="pc-card col"><p className="pc-lab">OpenRouter</p>{kids}</div>;
  if (!o) return card(<p className="small muted">No OpenRouter key connected.</p>);
  const spent = <p className="small faint">{`Spent on this key: ${usd(o.usage_daily ?? 0)} today · ${usd(o.usage_weekly ?? 0)} this week · ${usd(o.usage ?? 0)} all time.`}</p>;
  if (o.balance != null) return card(<><span className="big num">{usd(o.balance)}</span><p className="small muted">credits left on the account</p>{spent}</>);
  if (o.limit != null) {
    const used = o.limit ? ((o.limit - (o.limit_remaining ?? 0)) / o.limit) * 100 : 0;
    return card(<><span className="big num">{usd(o.limit_remaining ?? 0)}</span><p className="small muted">{`left of this key's ${usd(o.limit)} cap${o.limit_reset ? ` · resets ${o.limit_reset}` : ""}`}</p><Meter pct={used} tone={usedTone(used)} />{spent}</>);
  }
  return card(<><span className="big num">No cap</span><p className="small muted">This key has no spend cap. The account's credit balance is only shown to management keys.</p>{spent}</>);
}

function PlanLeft({ c }: { c: PlanLimits | null }) {
  const card = (kids: ReactNode) => <div className="pc-card col"><div className="spread"><p className="pc-lab">ChatGPT plan</p>{c?.plan && <span className="pc-chip">{c.plan}</span>}</div>{kids}</div>;
  if (!c?.primary && !c?.secondary) return card(<p className="small muted">{c?.connected ? "Couldn't read usage from OpenAI yet. Try again in a minute." : "ChatGPT plan not connected."}</p>);
  const name = (w: PlanWindow, d: string) => (w.windowMins === 300 ? "5-hour window" : w.windowMins === 10080 ? "Weekly" : w.windowMins ? `${Math.round(w.windowMins / 60)}-hour window` : d);
  const row = (w: PlanWindow, d: string) => {
    const reset = !!w.resetsAt && w.resetsAt <= Date.now(), used = reset ? 0 : w.usedPercent;
    return (
      <div className="col" style={{ gap: 4 }}>
        <div className="spread"><b>{name(w, d)}</b><span className="pc-m small">{`${100 - used}% left`}</span></div>
        <Meter pct={used} tone={usedTone(used)} />
        <p className="small faint">{reset ? "Reset since this reading" : w.resetsAt ? `Resets in ${until(w.resetsAt)} · ${when(w.resetsAt)}` : ""}</p>
      </div>
    );
  };
  const cr = c.credits;
  return card(<>
    {c.reached && <span className="pc-chip bad">Limit reached</span>}
    {c.primary && row(c.primary, "Short window")}
    {c.secondary && row(c.secondary, "Long window")}
    {cr?.has && <p className="small muted">{cr.unlimited ? "Credits: unlimited" : `Credits: ${cr.balance ?? "available"}`}</p>}
    <p className="small faint">{`As of ${ago(c.at)}, from OpenAI. Counts Codex use anywhere on this account.`}</p>
  </>);
}
