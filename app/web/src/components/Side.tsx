// The sidebar lists threads, not members: what needs you, what's on track, then pinned and recent. It folds to a rail.
import { useState } from "react";
import type { BotCard, ThreadSummary } from "../../../shared/types";
import { usd } from "../lib/format";
import { type Route } from "../lib/router";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";
import { Face, Loader } from "./ui";

type Row = ThreadSummary & { b: BotCard };
const RAIL_KEY = "pc.rail";
const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } };

/** Groups the state's threads (12 a member) once per render; cheap at crew sizes. */
function groups(bots: BotCard[], pendingThreads: Set<string>) {
  const rows: Row[] = bots.flatMap((b) => b.threads.map((t) => ({ ...t, b })));
  const needs = rows.filter((t) => t.status === "needs" || pendingThreads.has(t.id));
  const seen = new Set(needs.map((t) => t.id));
  const track = rows.filter((t) => !seen.has(t.id) && t.status === "running");
  track.forEach((t) => seen.add(t.id));
  const pinned = rows.filter((t) => !seen.has(t.id) && t.pinned);
  pinned.forEach((t) => seen.add(t.id));
  const midnight = new Date().setHours(0, 0, 0, 0);
  const rest = rows.filter((t) => !seen.has(t.id)).sort((a, b) => b.updated_at - a.updated_at);
  return { needs, track, pinned, today: rest.filter((t) => t.updated_at >= midnight), earlier: rest.filter((t) => t.updated_at < midnight).slice(0, 10) };
}

export function Side({ route }: { route: Route }) {
  const { S } = useStore();
  const [rail, setRail] = useState(readRail);
  const toggle = () => { const v = !rail; setRail(v); try { localStorage.setItem(RAIL_KEY, v ? "1" : "0"); } catch { /* private window */ } };
  const pending = S.pitstops.filter((p) => p.kind !== "engram");
  const g = groups(S.bots, new Set(pending.map((p) => p.thread_id).filter(Boolean) as string[]));
  const open = route.name === "t" ? route.args[0] : null;
  const active = S.bots.filter((b) => b.mood === "needs" || b.mood === "working");
  const faces = S.bots.length <= 6 ? S.bots : active.slice(0, 4);
  const more = S.bots.length - faces.length;
  const shells = S.bots.filter((b) => b.computer.up).length, screens = S.bots.filter((b) => b.computer.desktop).length;
  // Crew is "on" for the index and for a member's page; a count shows quietly, a badge loudly.
  // fresh: Home's unread runs, in the data tone, quieter than a pit stop's badge and shown only when none waits.
  const nav = (id: string, icon: string, label: string, href: string, badge?: number | null, count?: number, fresh?: number) => (
    <a className={`nv ${route.name === id && (id !== "crew" || !route.args[0] || rail) ? "on" : ""}`} href={href} title={label}>
      <Icon name={icon} />{!rail && <span>{label}</span>}{badge ? (rail ? <i className="bd" /> : <em className="hot">{badge}</em>)
        : fresh ? (rail ? <i className="bd new" /> : <em className="new" title={`${fresh} finished since you last looked`}>{fresh}</em>) : count && !rail ? <em>{count}</em> : null}
    </a>);
  const row = (t: Row) => (
    <a key={t.id} className={`tr ${open === t.id ? "on" : ""}`} href={`#/t/${t.id}`} title={`${t.title} · ${t.b.name}`}>
      <Face b={t.b} size="xs" mood={t.status === "needs" ? "needs" : t.status === "running" ? "working" : "idle"} />
      <span className="t">{t.title}</span>
      {t.status === "running" ? <Loader /> : g.needs.includes(t) ? <i className="dot" /> : null}
    </a>);
  const group = (label: string, list: Row[], cls = "") => list.length > 0 && (
    <><p className={`grp ${cls}`}>{label}{cls ? ` · ${list.length}` : ""}</p>{list.map(row)}</>);

  if (rail) return (
    <aside className="side folded">
      <a href="#/" className="logo" title="Home"><pc-logo size="sm" wordmark="none" /></a>
      <button className="ib" title="Show the sidebar" onClick={toggle}><Icon name="rail" /></button>
      <a className="ib nb" href="#/new" title="New thread"><Icon name="plus" /></a>
      <span className="sep" />
      {nav("wall", "home", "Home", "#/", pending.length, undefined, S.unread)}
      {nav("threads", "threads", "Threads", "#/threads")}
      {nav("crew", "crew", "Crew", "#/crew")}
      {nav("schedules", "clock", "Schedules", "#/schedules")}
      {nav("pitstops", "flag", "Pit stops", "#/pitstops")}
      {nav("library", "library", "Library", "#/library")}
      <span style={{ flex: 1 }} />
      <div className="faces">{active.slice(0, 5).map((b) => <a key={b.id} href={`#/crew/${b.id}`} title={b.name}><Face b={b} size="sm" /></a>)}</div>
      {nav("settings", "gear", "Settings", "#/settings")}
    </aside>);

  return (
    <aside className="side">
      <div className="top"><a href="#/" className="logo"><pc-logo size="sm" /></a><button className="ib" title="Fold the sidebar" onClick={toggle}><Icon name="rail" /></button></div>
      {S.paused && <a className="stopped" href="#/">Crew stopped · resume</a>}
      <a className={`newt ${route.name === "new" ? "on" : ""}`} href="#/new"><Icon name="plus" />New thread</a>
      <nav>
        {nav("wall", "home", "Home", "#/", pending.length, undefined, S.unread)}
        {nav("threads", "threads", "Threads", "#/threads")}
        {nav("crew", "crew", "Crew", "#/crew", null, S.bots.length)}
        {nav("schedules", "clock", "Schedules", "#/schedules")}
        {nav("pitstops", "flag", "Pit stops", "#/pitstops")}
        {nav("library", "library", "Library", "#/library")}
      </nav>
      <div className="tl">
        {group("Needs you", g.needs, "sig")}
        {group("On track", g.track, "on")}
        {group("Pinned", g.pinned)}
        {group("Today", g.today)}
        {group("Earlier", g.earlier)}
      </div>
      <div className="crew">
        {faces.map((b) => <a key={b.id} href={`#/crew/${b.id}`} title={b.name}><Face b={b} size="sm" /></a>)}
        {more > 0 && <span className="more" title={`${more} more in the garage`}>{`+${more}`}</span>}
        <a className="add" href="#/hire" title="New crew member"><Icon name="plus" size={14} /></a>
        <span style={{ flex: 1 }} />
        <a className="ib" href="#/telemetry" title="Telemetry"><Icon name="chart" /></a>
        <a className="ib" href="#/settings" title="Settings"><Icon name="gear" /></a>
      </div>
      <div className="stat"><span>{shells || screens ? `${shells} shell${shells === 1 ? "" : "s"} · ${screens} screen${screens === 1 ? "" : "s"}` : "all in the garage"}</span><span>{`wk ${usd(S.week.usd)} / ${usd(S.weekCap)}`}</span></div>
    </aside>);
}
