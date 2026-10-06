// Pit stops: what's waiting on you on top, then every decision by day (paged on the server), and the rules they left.
import { useState, type ReactNode } from "react";
import type { Learned, PitHistoryPage, PitHistoryRow, PitStop, Rule } from "../../../shared/types";
import { RuleLabel } from "../components/RuleLabel";
import { ListFilters, ListGroups, ListHeading, ListPage, ListPager, ListSearch, ListSelect, ListTabs, MemberSelect, RangeSelect, pageNote, useCursorPages, type Range } from "../components/ListPage";
import { PitCard } from "../components/PitCard";
import { effectLabel, Face } from "../components/ui";
import { api } from "../lib/api";
import { hm, plainWords, plural, when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useRoute } from "../lib/router";
import { pitLabel } from "../lib/steps";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

const PAGE = 12;
// Keys match PIT_KINDS / PIT_OUTCOMES in api/lists.ts.
const KINDS = [["", "All kinds"], ["pay", "Payments"], ["send", "Sending"], ["signin", "Sign-ins"], ["install", "Installs"], ["delete", "Deleting"], ["share", "Sharing"],
  ["site", "New sites"], ["run", "Commands and tools"], ["hire", "Crew changes"], ["memory", "Memory"]] as const;
const OUTCOMES = [["", "Any outcome"], ["approved", "Approved once"], ["standing", "Approved for longer"], ["denied", "Denied"], ["expired", "No answer"]] as const;
const SCOPE_WORDS: Record<string, string> = { thread: "Approved, this thread", always: "Approved, always", site: "Approved, this site", full: "Approved, whole site", retry: "Sent back to try again" };

// The gate's verification and taint suffixes stay on the card; the history keeps the action.
const tidy = (t: string) => plainWords(t.replace(/ · (verify|after untrusted|jev blocked)\b.*$/, ""));
/** The step in its own words: "Run <code>", "Ran a browser script on x.com", else the pit stop's title. */
function Sentence({ p }: { p: PitStop }) {
  const v = pitLabel(p);
  if (p.kind === "command") return <>{v.label} <code className="pc-m">{v.detail}</code></>;
  if (p.kind === "mcp" || (p.kind === "secret" && p.detail?.site?.host)) return <>{`${v.label}${v.detail ? ` ${v.detail}` : ""}`}</>;
  return <>{tidy(p.title)}</>;
}
function outcomeWords(p: Pick<PitStop, "status" | "scope" | "kind" | "effect" | "note">) {
  if (p.status === "expired") return "No answer, skipped";
  if (p.status === "denied") return p.scope === "block" ? "Denied, site blocked" : "Denied";
  if (p.kind === "engram") return plainWords(p.note) || "Decided";
  if (p.kind === "secret" || p.effect === "signin") return p.scope === "always" ? "Signed in, always" : "Signed in";
  return SCOPE_WORDS[p.scope || ""] || "Approved";
}

export function PitStops() {
  const { S } = useStore();
  const tab = useRoute().args[0] === "rules" ? "rules" : "decisions";
  const rules = useFetch(async () => { const [r, l] = await Promise.all([api.get<Rule[]>("/api/rules"), api.get<Learned[]>("/api/learned")]); return { rules: r, learned: l }; }, []);
  const nRules = rules.data ? mergeRules(rules.data.rules).length + rules.data.learned.filter((l) => l.streak >= l.need).length : null;
  return (
    <ListPage title="Pit stops" lede="Decisions your crew needed from you." className="pits">
      <ListTabs value={tab} tabs={[{ key: "decisions", label: "Decisions", href: "#/pitstops" }, { key: "rules", label: "Rules", count: nRules, href: "#/pitstops/rules" }]} />
      {tab === "rules" ? (rules.data ? <RulesTab {...rules.data} after={rules.reload} /> : null) : <>
        {S.pitstops.length > 0 && <>
          <ListHeading dot count={S.pitstops.length}>Waiting on you</ListHeading>
          <div className="lp-waiting">{S.pitstops.map((p) => <div key={p.id} className="lp-wait"><PitCard p={p} /></div>)}</div>
        </>}
        <History />
      </>}
    </ListPage>);
}

function History() {
  const { bot } = useStore();
  const [q, setQ] = useState(""), [member, setMember] = useState(""), [kind, setKind] = useState(""), [outcome, setOutcome] = useState(""), [days, setDays] = useState<Range>("7");
  const key = new URLSearchParams({ days, limit: String(PAGE), ...(q ? { q } : {}), ...(member ? { bot: member } : {}), ...(kind ? { kind } : {}), ...(outcome ? { outcome } : {}) }).toString();
  const pg = useCursorPages<PitHistoryRow, PitHistoryPage>((before) => api.get(`/api/pitstops/history?${key}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { quiet: true }), key, PAGE);
  useLiveReload((e) => pg.first && e.type === "pitstop", pg.reload, 800);
  const rows = (pg.page || pg.data)?.rows || [];
  const filtered = !!(q || member || kind || outcome);
  return <>
    <ListHeading>History</ListHeading>
    <ListFilters right={<RangeSelect value={days} onChange={setDays} />}>
      <ListSearch value={q} onChange={setQ} placeholder="Search decisions" />
      <MemberSelect value={member} onChange={setMember} />
      <ListSelect value={kind} onChange={setKind} options={KINDS} label="Kind" />
      <ListSelect value={outcome} onChange={setOutcome} options={OUTCOMES} label="Outcome" />
    </ListFilters>
    <div className={pg.stale ? "lp-list stale" : "lp-list"}>
      {pg.data && !rows.length ? <p className="lp-empty">{filtered ? "No decisions match these filters." : "No decisions in this range yet."}</p> : (
        <ListGroups rows={rows} at={(p) => p.created_at} keyOf={(p) => p.id}>{(p) => {
          const b = bot(p.bot_id), body = <>
            <span className="lp-time">{hm(p.created_at)}</span>
            <span className="lp-who">{b ? <Face b={b} size="xs" mood="idle" /> : <i className="lp-ghost" />}<span>{b?.name || "A former member"}</span></span>
            <span className="lp-what"><Sentence p={p} />{p.thread_title && <small>{p.thread_title}</small>}</span>
            <span className={`lp-out${p.status === "expired" ? " q" : ""}`}>{outcomeWords(p)}</span></>;
          return p.thread_id ? <a className="lp-row pit-row" href={`#/t/${p.thread_id}`}>{body}</a> : <div className="lp-row pit-row">{body}</div>;
        }}</ListGroups>)}
    </div>
    {rows.length > 0 && <ListPager note={pageNote(pg.from, rows.length, pg.total, "decisions")} newer={pg.newer} older={pg.older} />}
  </>;
}

interface RuleItem { key: string; botId: string; label: ReactNode; how: string; effect: string; since: number | null; act: () => Promise<unknown>; actLabel: string }
/** Standing approvals stored twice for one member (same words) read as one rule; Revoke ends every copy. */
function mergeRules(rules: (Rule & { thread_id?: string | null })[]) {
  const by = new Map<string, Rule[]>();
  for (const r of rules) { const k = `${r.bot_id}\u0000${r.label}`; by.set(k, [...(by.get(k) || []), r]); }
  return [...by.values()];
}

function RulesTab({ rules, learned, after }: { rules: Rule[]; learned: Learned[]; after: () => void }) {
  const { bot } = useStore();
  const items: RuleItem[] = [
    ...mergeRules(rules).map((list): RuleItem => {
      const r = list[0], thread = / \(this thread\)$/.test(r.label);
      return { key: r.id, botId: r.bot_id, label: <RuleLabel label={r.label} />, how: thread ? "This thread" : "Always", effect: r.effect, since: Math.min(...list.map((x) => x.created_at)), actLabel: "Revoke",
        act: async () => { for (const x of list) await api.post(`/api/rules/${x.id}/revoke`); toast("Revoked"); after(); } };
    }),
    ...learned.filter((l) => l.streak >= l.need).map((l): RuleItem => ({ key: `l${l.id}`, botId: l.bot_id, label: l.label, how: `Learned after ${l.approvals} approvals`, effect: l.effect, since: null, actLabel: "Ask again",
      act: async () => { await api.post(`/api/learned/${l.id}/reset`); toast("It will ask again"); after(); } })),
  ];
  const live = items.filter((i) => bot(i.botId)), former = items.filter((i) => !bot(i.botId));
  const learning = learned.filter((l) => l.streak < l.need && bot(l.bot_id));
  const row = (i: RuleItem) => { const b = bot(i.botId); return (
    <div key={i.key} className="lp-row rule-row">
      <span className="lp-what">{i.label}</span>
      <span className="lp-who">{b ? <Face b={b} size="xs" mood="idle" /> : <i className="lp-ghost" />}<span>{b?.name || "A former member"}</span></span>
      <span className="lp-sub">{`${i.how} · ${effectLabel(i.effect)}${i.since ? ` · since ${when(i.since)}` : ""}`}</span>
      <button className="lp-act" onClick={i.act}>{i.actLabel}</button>
    </div>); };
  return <>
    {live.length ? <div className="lp-list rules">{live.map(row)}</div>
      : <p className="lp-empty">No rules yet. Approve with "Allow similar always" or "in this thread", or approve the same kind of step twice in a row, and the crew stops asking.</p>}
    {former.length > 0 && <details className="lp-fold"><summary>{`${plural(former.length, "rule")} from former members`}</summary><div className="lp-list rules">{former.map(row)}</div></details>}
    {learning.length > 0 && <>
      <ListHeading count={learning.length}>Still learning</ListHeading>
      <p className="lp-note">Approve these a few more times in a row and the crew stops asking. Signing in, installing, sending, paying, deleting and sharing always ask.</p>
      <div className="lp-list rules">{learning.map((l) => { const b = bot(l.bot_id); return (
        <div key={l.id} className="lp-row rule-row">
          <span className="lp-what">{l.label}</span>
          <span className="lp-who">{b && <Face b={b} size="xs" mood="idle" />}<span>{b?.name}</span></span>
          <span className="lp-sub">{`${l.streak} of ${l.need} approvals · ${effectLabel(l.effect)}`}</span><span />
        </div>); })}</div>
    </>}
  </>;
}
