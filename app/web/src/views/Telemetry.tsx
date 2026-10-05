// What the crew did and what it cost: four tiles, failures that still need a look, then runs and the activity log,
// both paged on the server. Runs are counted once, when they start, so every number here adds up the same way.
import { useState } from "react";
import type { ActivityPage, ActivityRow, PlanLimits, RunPage, RunRow, TelemetrySummary } from "../../../shared/types";
import { ListFilters, ListGroups, ListHeading, ListPage, ListPager, ListSearch, ListSelect, ListTabs, MemberSelect, RangeSelect, pageNote, useCursorPages, type Range } from "../components/ListPage";
import { ErrorText, Face } from "../components/ui";
import { api } from "../lib/api";
import { cap, dayLabel, hm, plainWords, plural, stamp, usd } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useRoute } from "../lib/router";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";

const RUNS_PAGE = 10, ACTIVITY_PAGE = 20;
// Keys match RUN_TRIGGERS and RUN_OUTCOMES in api/lists.ts.
const STARTED_BY: Record<string, string> = { driver: "You", schedule: "Schedule", email: "Email", plan: "Plan step", resume: "Restart", retro: "Review", check: "Done-check retry", surface: "Dashboard", teach: "Teach by doing" };
const TRIGGERS = [["", "Any trigger"], ["driver", "You"], ["schedule", "Schedule"], ["delegation", "Another member"], ["resume", "Restart"], ["email", "Email"], ["plan", "Plan step"], ["check", "Done-check retry"]] as const;
const OUTCOMES = [["", "Any outcome"], ["finished", "Finished"], ["failed", "Failed"], ["cut", "Cut by restart"], ["stopped", "Stopped"], ["running", "Running"]] as const;
const MOSTLY: Record<string, string> = { driver: "mostly your requests", schedule: "mostly scheduled runs", delegation: "mostly questions from the Crew Chief", email: "mostly email", resume: "mostly picking up after restarts", plan: "mostly plan steps" };
// The gate's effect classes (jev.ts) and who allowed a step, as runtime/activity.ts files them.
const EFFECTS = [["", "All kinds"], ["send", "Sent"], ["pay", "Paid"], ["signin", "Signed in"], ["delete", "Deleted"], ["share", "Shared"], ["install", "Installed"]] as const;
const BY = [["", "Allowed by anyone"], ["once", "You, once"], ["always", "You, always"], ["autonomy", "Hands-free or YOLO"], ["learned", "Learned from you"], ["jev", "Safety check"], ["rules", "Policy or site list"]] as const;

/** 9.8M, 64K, 512: token counts at a glance. */
const compact = (n: number | null | undefined) => {
  const v = n || 0, f = (x: number, u: string) => `${x < 10 ? x.toFixed(1).replace(/\.0$/, "") : Math.round(x)}${u}`;
  return v >= 1e6 ? f(v / 1e6, "M") : v >= 1e3 ? f(v / 1e3, "K") : String(v);
};
const took = (r: RunRow) => {
  if (!r.ended_at) return "—";
  const s = Math.max(0, Math.round((r.ended_at - r.started_at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
};
const whenRun = (t: number) => (dayLabel(t) === "Today" ? `Today ${hm(t)}` : stamp(t));
type Outcome = { word: string; tone: "" | "bad" | "warn" | "q" };
const outcomeOf = (r: RunRow): Outcome => r.status === "completed" ? { word: "", tone: "" } : r.status === "failed" ? { word: "Failed", tone: "bad" }
  : r.status === "interrupted" ? (r.error === "Control plane restarted" ? { word: "Cut by restart", tone: "warn" } : { word: "Stopped", tone: "q" }) : { word: "Running", tone: "q" };

export function Telemetry() {
  const tab = useRoute().args[0] === "activity" ? "activity" : "runs";
  const [days, setDays] = useState<Range>("7");
  const sum = useFetch(() => api.get<TelemetrySummary>(`/api/telemetry?days=${days}`), [days], { keep: true });
  useLiveReload((e) => e.type === "turn", sum.reload, 2000);
  const t = sum.data;
  return (
    <ListPage title="Telemetry" lede="What your crew did and what it cost." className="tele" right={<RangeSelect value={days} onChange={setDays} />}>
      {sum.error && !t && <p className="lp-empty bad">{sum.error}</p>}
      {t && <Tiles t={t} days={days} />}
      {t && (t.failures.length > 0 || t.cut.runs > 0) && <NeedsLook t={t} />}
      <ListTabs value={tab} tabs={[{ key: "runs", label: "Runs", count: t?.runs.started ?? null, href: "#/telemetry" }, { key: "activity", label: "Activity", href: "#/telemetry/activity" }]} />
      {tab === "runs" ? <Runs days={days} /> : <Activity />}
    </ListPage>);
}

function planLeft(c: PlanLimits | null) {
  const w = c?.secondary || c?.primary;
  if (!w || (w.resetsAt && w.resetsAt <= Date.now())) return "";
  return ` ${100 - w.usedPercent}% of the plan's ${w.windowMins === 10080 ? "weekly" : w.windowMins === 300 ? "5-hour" : ""} window left.`.replace("  ", " ");
}

function Tiles({ t, days }: { t: TelemetrySummary; days: Range }) {
  const { bot, name } = useStore();
  const r = t.runs, b = t.busiest && bot(t.busiest.botId), week = days === "7";
  const split = [`${r.finished} finished`, r.failed ? <span key="f" className="lp-bad">{`${r.failed} failed`}</span> : null, r.cut ? `${r.cut} cut by a restart` : null,
    r.stopped ? `${r.stopped} stopped` : null, r.running ? `${r.running} running` : null].filter(Boolean);
  const cached = t.tokens.input ? Math.round((t.tokens.cached / t.tokens.input) * 100) : 0;
  return (
    <div className="tele-tiles">
      <div className="pc-feat tele-spend">
        <p className="tl">Spent</p>
        <p className="big"><span className="num">{usd(t.spend.usd)}</span>{week && t.spend.cap > 0 && <small>{`of ${usd(t.spend.cap)} this week`}</small>}</p>
        {week && t.spend.cap > 0 && <div className="cap"><i style={{ width: `${Math.min(100, (t.spend.usd / t.spend.cap) * 100).toFixed(1)}%` }} /></div>}
        <p className="s2">{`${t.spend.allPlan ? `Every run was covered by your ${t.chatgpt?.plan ? `ChatGPT ${t.chatgpt.plan}` : "ChatGPT"} plan.` : t.spend.usd ? "Billed by the provider, or a list-price estimate." : "Nothing billed."}${planLeft(t.chatgpt)}`}</p>
      </div>
      <div className="tile"><p className="tl">Runs</p><p className="big">{r.started}</p><p className="s2">{split.map((x, i) => <span key={i}>{i ? " · " : ""}{x}</span>)}</p></div>
      <div className="tile"><p className="tl">Busiest</p>
        {t.busiest ? <><p className="big row1">{b ? <Face b={b} size="sm" mood="idle" /> : <i className="lp-ghost sm" />}{t.busiest.runs}<small>{t.busiest.runs === 1 ? "run" : "runs"}</small></p>
          <p className="s2">{`${b ? name(t.busiest.botId) : "A former member"}${t.busiest.trigger && MOSTLY[t.busiest.trigger] ? `, ${MOSTLY[t.busiest.trigger]}` : ""}`}</p></>
          : <><p className="big">—</p><p className="s2">No runs in this range.</p></>}
      </div>
      <div className="tile"><p className="tl">Tokens</p><p className="big">{compact(t.tokens.input)}<small>in</small></p><p className="s2">{`${compact(t.tokens.output)} out${cached ? ` · ${cached}% from cache` : ""}`}</p></div>
    </div>);
}

function NeedsLook({ t }: { t: TelemetrySummary }) {
  const { bot, name } = useStore();
  const by = (r: RunRow) => (r.trigger === "delegation" ? (r.from_bot ? name(r.from_bot) : "Another member") : STARTED_BY[r.trigger] || "You");
  return <>
    {t.failures.length > 0 && <ListHeading count={t.failuresTotal}>Needs a look</ListHeading>}
    <div className="tele-fails">
      {t.failures.map((r) => { const b = bot(r.bot_id); return (
        <div key={r.id} className="tele-fail">
          {b ? <Face b={b} size="sm" mood="failed" /> : <i className="lp-ghost sm" />}
          <div className="main">
            <p className="h">{r.thread_title}<span>{`${b?.name || "A former member"} · ${whenRun(r.started_at).replace(/^Today/, "today")} · ${by(r)}`}</span></p>
            <ErrorText raw={r.error || "The run failed without saying why."} className="lp-err" />
          </div>
          <a className="pc-pill o s" href={`#/t/${r.thread_id}`}>Open thread</a>
        </div>); })}
      {t.cut.runs > 0 && <p className="tele-cut">{`${plural(t.cut.runs, "run")} ${t.cut.runs === 1 ? "was" : "were"} cut by a server restart; ${t.cut.resumed === t.cut.runs ? (t.cut.runs === 1 ? "it picked up again on its own." : `${t.cut.runs === 2 ? "both" : "all"} picked up again on their own.`) : `${t.cut.resumed} picked up again on ${t.cut.resumed === 1 ? "its" : "their"} own.`}`}</p>}
    </div>
  </>;
}

function Runs({ days }: { days: Range }) {
  const { bot, name } = useStore();
  const [q, setQ] = useState(""), [member, setMember] = useState(""), [trigger, setTrigger] = useState(""), [outcome, setOutcome] = useState("");
  const key = new URLSearchParams({ days, limit: String(RUNS_PAGE), ...(q ? { q } : {}), ...(member ? { bot: member } : {}), ...(trigger ? { trigger } : {}), ...(outcome ? { outcome } : {}) }).toString();
  const pg = useCursorPages<RunRow, RunPage>((before) => api.get(`/api/telemetry/runs?${key}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { quiet: true }), key, RUNS_PAGE);
  useLiveReload((e) => pg.first && e.type === "turn", pg.reload, 2000);
  const rows = (pg.page || pg.data)?.rows || [];
  const filtered = !!(q || member || trigger || outcome);
  return <>
    <ListFilters>
      <ListSearch value={q} onChange={setQ} placeholder="Search runs" />
      <MemberSelect value={member} onChange={setMember} />
      <ListSelect value={trigger} onChange={setTrigger} options={TRIGGERS} label="Started by" />
      <ListSelect value={outcome} onChange={setOutcome} options={OUTCOMES} label="Outcome" />
    </ListFilters>
    <div className={pg.stale ? "lp-list stale" : "lp-list"}>
      {pg.data && !rows.length ? <p className="lp-empty">{filtered ? "No runs match these filters." : "No runs in this range."}</p> : <>
        <div className="tele-run hd"><span>When</span><span>Member</span><span>Thread</span><span>Started by</span><span>Took</span><span>Tokens</span><span className="r">Outcome</span></div>
        {rows.map((r) => { const b = bot(r.bot_id), o = outcomeOf(r); return (
          <a key={r.id} className="tele-run" href={`#/t/${r.thread_id}`}>
            <span className="m">{whenRun(r.started_at)}</span>
            <span className="lp-who">{b ? <Face b={b} size="xs" mood="idle" /> : <i className="lp-ghost" />}<span className={b ? "" : "q"}>{b?.name || "A former member"}</span></span>
            <span className="x">{r.thread_title}</span>
            <span className="by">{r.trigger === "delegation" ? (r.from_bot ? name(r.from_bot) : "Another member") : STARTED_BY[r.trigger] || "You"}</span>
            <span className="m">{took(r)}</span>
            <span className="m">{r.input_tokens || r.output_tokens ? `${compact(r.input_tokens)} in · ${compact(r.output_tokens)} out` : "—"}</span>
            <span className={`r ${o.tone ? `t-${o.tone}` : ""}`}>{o.word}</span>
          </a>); })}
      </>}
    </div>
    {pg.data && <ListPager note={pageNote(pg.from, rows.length, pg.total, "runs")} newer={rows.length ? pg.newer : undefined} older={rows.length ? pg.older : undefined}>
      <a className="lp-link" href="/api/export" download="">Export everything</a>
    </ListPager>}
  </>;
}

// Home's activity log, moved here: everything done on your behalf, from the gate's own records (runtime/activity.ts).
function Activity() {
  const { bot } = useStore();
  const [member, setMember] = useState(""), [effect, setEffect] = useState(""), [by, setBy] = useState("");
  const key = new URLSearchParams({ limit: String(ACTIVITY_PAGE), ...(member ? { bot: member } : {}), ...(effect ? { effect } : {}), ...(by ? { by } : {}) }).toString();
  const pg = useCursorPages<ActivityRow, ActivityPage>((before) => api.get(`/api/activity?${key}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { quiet: true }), key, ACTIVITY_PAGE);
  useLiveReload((e) => pg.first && (e.type === "pitstop" || e.type === "turn"), pg.reload, 1500);
  const rows = (pg.page || pg.data)?.rows || [];
  return <>
    <ListFilters>
      <MemberSelect value={member} onChange={setMember} />
      <ListSelect value={effect} onChange={setEffect} options={EFFECTS} label="Kind" />
      <ListSelect value={by} onChange={setBy} options={BY} label="Allowed by" />
    </ListFilters>
    <div className={pg.stale ? "lp-list stale" : "lp-list"}>
      {pg.data && !rows.length ? <p className="lp-empty">{member || effect || by ? "Nothing matches these filters." : "Nothing done on your behalf yet."}</p> : (
        <ListGroups rows={rows} at={(r) => r.at} keyOf={(r) => r.id}>{(r) => {
          const b = bot(r.botId), body = <>
            <span className="lp-time">{hm(r.at)}</span>
            <span className="lp-who">{b ? <Face b={b} size="xs" mood="idle" /> : <i className="lp-ghost" />}<span>{b?.name || "A former member"}</span></span>
            <span className="lp-what">{cap(plainWords(r.what))}</span>
            <span className="lp-out">{`${plainWords(r.by.who)}${r.by.how ? `, ${plainWords(r.by.how)}` : ""}`}</span></>;
          return r.threadId ? <a className="lp-row pit-row" href={`#/t/${r.threadId}`}>{body}</a> : <div className="lp-row pit-row">{body}</div>;
        }}</ListGroups>)}
    </div>
    {rows.length > 0 && <ListPager note={`Reads, browsing and drafts show only when you approved one.`} newer={pg.newer} older={pg.older} />}
  </>;
}
