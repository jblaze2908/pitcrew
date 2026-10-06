// Home's timeline (Draft M4b): finished runs, running work and actions done for you in one list, newest first. Today is
// open; Yesterday folds to one line. Reads and browsing never show: the activity log only keeps actions that changed something.
import type { ReactNode } from "react";
import type { ActivityPage, ActivityRow, BotCard, Inbox, InboxItem } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { Face, Loader } from "../../components/ui";
import { api } from "../../lib/api";
import { hm, plainWords, plural } from "../../lib/format";
import { useLiveReload } from "../../lib/live";
import { useStore } from "../../lib/store";
import { useFetch } from "../../lib/useFetch";

// Days follow IST like the rest of the app (lib/format); IST has no DST, so a day starts at a fixed offset from UTC.
const DAY = 86400000, IST = 19800000;
const ACTIONS_SHOWN = 6, ACTIVITY_PAGE = 40, READ_KEEP = 8; // READ_KEEP: runtime/inbox.ts keeps that many read runs

interface Ev { key: string; at: number; b?: BotCard; mood?: string; text: ReactNode; quote?: string; unread?: boolean; failed?: boolean; quiet?: boolean; live?: boolean; href?: string; action?: boolean }

export function Today() {
  const { S, bot, name, refresh, threadTitle } = useStore();
  // Per Home view: one inbox read (at most 80 turns) and one activity page (two indexed reads of 41 rows); both are
  // refetched once per burst of run or pit stop events. Running work comes from the state, with no fetch.
  const box = useFetch(() => api.get<Inbox>("/api/inbox", { quiet: true }), [], { keep: true });
  const acts = useFetch(() => api.get<ActivityPage>(`/api/activity?limit=${ACTIVITY_PAGE}`, { quiet: true }), [], { keep: true });
  useLiveReload((e) => e.type === "turn" || e.type === "pitstop", () => { box.reload(); acts.reload(); }, 1000);

  const midnight = Math.floor((Date.now() + IST) / DAY) * DAY - IST, yesterday = midnight - DAY;
  const runEv = (i: InboxItem): Ev => {
    // A scheduled run's thread title ends in its date ("… · 5 Oct"); the row's time already says when.
    const who = name(i.botId), title = (i.sub || threadTitle(i.threadId) || "a thread").replace(/ · \d{1,2} [A-Z][a-z]{2}$/, "").replace(/\.$/, "");
    // Scheduled prompts ask for a "QUIET:" reply when nothing changed.
    const quiet = i.status === "quiet" || /^QUIET:/i.test(i.text || "");
    const text = i.kind === "delegation" ? <>{who} answered {name(i.fromBot)}</>
      : i.kind === "scheduled" || quiet ? <>{who} ran <b>{title}</b>{quiet ? ", nothing new" : ""}</>
      : i.status === "failed" ? <>{who} couldn't finish <b>{title}</b></>
      : <>{who} finished <b>{title}</b></>;
    return { key: i.turnId, at: i.endedAt, b: bot(i.botId), text, quote: quiet ? undefined : i.text, unread: i.unread,
      failed: i.status === "failed", quiet, href: `#/t/${i.threadId}` };
  };
  const actEv = (r: ActivityRow): Ev => {
    const where = threadTitle(r.threadId);
    return { key: r.id, at: r.at, b: bot(r.botId), text: <>{name(r.botId)}: {plainWords(r.what)}{where && <>, in <b>{where}</b></>}</>,
      href: r.threadId ? `#/t/${r.threadId}` : undefined, action: true };
  };
  const running: Ev[] = S.bots.flatMap((b) => b.threads.filter((t) => t.status === "running").map((t) => (
    { key: `run.${t.id}`, at: t.updated_at, b, mood: "working", text: <>{b.name} is working on <b>{t.title}</b></>, live: true, href: `#/t/${t.id}` })));

  const runs = box.data?.items || [], rows = acts.data?.rows || [];
  const day = (from: number, to: number) => [...runs.filter((i) => i.endedAt >= from && i.endedAt < to).map(runEv), ...rows.filter((r) => r.at >= from && r.at < to).map(actEv)];
  // Older rows past what was loaded may also belong to the day, so its counts read "40+".
  const actsCut = (from: number) => !!acts.data?.next && (rows.at(-1)?.at ?? 0) >= from;
  const runsCut = (from: number) => runs.filter((i) => !i.unread).length >= READ_KEEP && (runs.at(-1)?.endedAt ?? 0) >= from;
  const today = trim([...running, ...day(midnight, Infinity)]), yest = trim(day(yesterday, midnight));
  const yRuns = new Set(runs.filter((i) => i.endedAt >= yesterday && i.endedAt < midnight && i.status !== "failed" && i.status !== "quiet").map((i) => i.threadId)).size;
  const yActs = rows.filter((r) => r.at >= yesterday && r.at < midnight).length;
  const ySummary = [yRuns && `${plural(yRuns, "thread")}${runsCut(yesterday) ? "+" : ""} finished`, yActs && `${plural(yActs, "thing")}${actsCut(yesterday) ? "+" : ""} changed`].filter(Boolean).join(", ");
  const unread = box.data?.unread || 0;
  const readAll = async () => { await api.post("/api/inbox/read"); box.reload(); refresh(); };

  return (
    <section className="day">
      <div className="dh"><h2>Today</h2>{unread > 0 && <button className="mark" onClick={readAll}>Mark all read</button>}</div>
      {today.list.map((e) => <Row key={e.key} e={e} />)}
      {today.more > 0 && <More n={today.more} cut={actsCut(midnight)} when="today" />}
      {!today.list.length && box.data && acts.data && <p className="none">Nothing yet today.</p>}
      {yest.list.length > 0 && (
        <details className="yest">
          <summary><b>Yesterday</b><span>{ySummary}</span><Icon name="chev" /></summary>
          {yest.list.map((e) => <Row key={e.key} e={e} />)}
          {yest.more > 0 && <More n={yest.more} cut={actsCut(yesterday)} when="yesterday" />}
        </details>)}
    </section>);
}

/** Newest first, with actions past the first few folded into one line so a busy day doesn't bury the replies. */
function trim(evs: Ev[]) {
  evs.sort((a, b) => b.at - a.at);
  let n = 0;
  const list = evs.filter((e) => !e.action || ++n <= ACTIONS_SHOWN);
  return { list, more: Math.max(0, n - ACTIONS_SHOWN) };
}

const More = ({ n, cut, when }: { n: number; cut: boolean; when: string }) => (
  <a className="ev more" href="#/telemetry"><span /><span /><p className="s">{`${n}${cut ? "+" : ""} more ${n === 1 && !cut ? "action" : "actions"} ${when} · All activity`}</p></a>);

function Row({ e }: { e: Ev }) {
  const body = <>
    <span className="tm">{hm(e.at)}</span>
    <Face b={e.b} size="xs" mood={e.mood || "idle"} />
    <div className="bd">
      <p className={`s${e.quiet ? " quiet" : ""}`}>{e.unread && <i className="u" title="New since you last looked" />}{e.text}{e.live && <Loader />}</p>
      {e.quote && <p className={`q${e.failed ? " bad" : ""}`}>{e.quote}</p>}
    </div>
  </>;
  return e.href ? <a className="ev" href={e.href}>{body}</a> : <div className="ev">{body}</div>;
}
