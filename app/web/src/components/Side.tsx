// The sidebar (Draft M3a): New thread, Search and three links, the crew one row each, then recent threads by title.
// Threads, Crew and Pit stops left the link list: All threads ends Recents, the Crew heading opens the Crew page, and
// Home's waiting rows open Pit stops. It folds to a rail that keeps every link.
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { BotCard, ThreadSummary } from "../../../shared/types";
import { go, type Route } from "../lib/router";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";
import { Face } from "./ui";

const RAIL_KEY = "pc.rail";
const RECENTS = 10, CREW_ROWS = 8;
const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } };

/** Waiting threads first, then running, then the newest; pinned ones always make the list. Runs once per render over
 *  the state's threads (12 a member), so it stays cheap at crew sizes. */
function recentsOf(bots: BotCard[], waiting: Set<string>) {
  const rows = bots.flatMap((b) => b.threads).sort((a, b) => b.updated_at - a.updated_at);
  const needs = rows.filter((t) => t.status === "needs" || waiting.has(t.id)), first = new Set(needs);
  const running = rows.filter((t) => t.status === "running" && !first.has(t));
  running.forEach((t) => first.add(t));
  const rest = rows.filter((t) => !first.has(t));
  return { needs, running, rest: rest.filter((t, i) => i < RECENTS || t.pinned) };
}

/** Search lives on the Threads page; this opens it with the box focused. */
const openSearch = () => {
  go("#/threads");
  setTimeout(() => document.querySelector<HTMLInputElement>(".tsearch input")?.focus(), 60);
};
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function Side({ route }: { route: Route }) {
  const { S } = useStore();
  const [rail, setRail] = useState(readRail);
  const toggle = () => { const v = !rail; setRail(v); try { localStorage.setItem(RAIL_KEY, v ? "1" : "0"); } catch { /* private window */ } };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) { e.preventDefault(); openSearch(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const pending = S.pitstops.filter((p) => p.kind !== "engram");
  const r = recentsOf(S.bots, new Set(pending.map((p) => p.thread_id).filter(Boolean) as string[]));
  const open = route.name === "t" ? route.args[0] : null, member = route.name === "crew" ? route.args[0] || "" : null;
  const crew = S.bots.slice(0, CREW_ROWS), more = S.bots.length - crew.length;
  const initial = (S.driverName || "?").trim().charAt(0).toUpperCase();

  // A pit stop count shows in orange; with none waiting, Home's unread runs show in the quieter data tone.
  const badge = pending.length ? (rail ? <i className="bd" /> : <em className="hot">{pending.length}</em>)
    : S.unread ? (rail ? <i className="bd new" /> : <em className="new" title={`${S.unread} finished since you last looked`}>{S.unread}</em>) : null;
  const nav = (on: boolean, icon: string, label: string, href: string, extra?: ReactNode, onClick?: (e: MouseEvent) => void) => (
    <a className={`nv${on ? " on" : ""}`} href={href} title={label} onClick={onClick}><Icon name={icon} />{!rail && <span>{label}</span>}{extra}</a>);
  const search = (e: MouseEvent) => { e.preventDefault(); openSearch(); };
  const links = <>
    {nav(false, "search", "Search", "#/threads", !rail && <kbd>/</kbd>, search)}
    {nav(route.name === "wall", "home", "Home", "#/", badge)}
    {nav(route.name === "schedules", "clock", "Schedules", "#/schedules")}
    {nav(route.name === "library", "library", "Library", "#/library")}
  </>;
  // The face carries the member's state (asleep with its z, working with its light, done, needs you): sm is the smallest size that shows all of it.
  const face = (b: BotCard) => <Face b={b} size="sm" />;

  if (rail) return (
    <aside className="side folded">
      <a href="#/" className="logo" title="Home"><pc-logo size="sm" wordmark="none" /></a>
      <button className="ib" title="Show the sidebar" onClick={toggle}><Icon name="rail" /></button>
      <a className={`nv${route.name === "new" ? " on" : ""}`} href="#/new" title="New thread"><Icon name="plus" /></a>
      {links}
      {nav(route.name === "threads", "threads", "All threads", "#/threads")}
      <span className="sep" />
      {nav(member === "", "crew", "Crew", "#/crew")}
      {crew.map((b) => <a key={b.id} className={`fc${member === b.id ? " on" : ""}`} href={`#/crew/${b.id}`} title={b.name}>{face(b)}</a>)}
      <span style={{ flex: 1 }} />
      {nav(route.name === "settings", "gear", "Settings", "#/settings")}
      <a className="me" href="#/settings/account" title={S.driverName}>{initial}</a>
    </aside>);

  const row = (t: ThreadSummary, mark?: "wait" | "run") => (
    <a key={t.id} className={`tr${open === t.id ? " on" : ""}`} href={`#/t/${t.id}`} title={t.title}>
      <span className="t">{t.title}</span>
      {mark === "wait" ? <i className="dot" title="Waiting on you" /> : mark === "run" ? <i className="dot run" title="Working" /> : null}
    </a>);

  return (
    <aside className="side">
      <div className="top"><a href="#/" className="logo"><pc-logo size="sm" /></a><button className="ib" title="Fold the sidebar" onClick={toggle}><Icon name="rail" /></button></div>
      {S.paused && <a className="stopped" href="#/">The crew is stopped · Resume</a>}
      <a className={`newt${route.name === "new" ? " on" : ""}`} href="#/new"><span className="pl"><Icon name="plus" size={12} /></span>New thread</a>
      <nav>{links}</nav>
      <div className="tl">
        <div className="hd"><a href="#/crew" className={member === "" ? "on" : ""} title="The Crew page">Crew</a><a className="ib" href="#/hire" title="Hire someone"><Icon name="plus" size={14} /></a></div>
        {crew.map((b) => (
          <a key={b.id} className={`mr${member === b.id ? " on" : ""}`} href={`#/crew/${b.id}`} title={b.job ? `${b.name} · ${b.job}` : b.name}>
            {face(b)}<span className="t">{b.name}</span>{b.mood === "working" && <span className="st">working</span>}
          </a>))}
        {more > 0 && <a className="tr all" href="#/crew">{`${more} more`}</a>}
        <div className="hd"><span>Recents</span></div>
        {r.needs.map((t) => row(t, "wait"))}
        {r.running.map((t) => row(t, "run"))}
        {r.rest.map((t) => row(t))}
        <a className={`tr all${route.name === "threads" ? " on" : ""}`} href="#/threads">All threads</a>
      </div>
      <div className="foot">
        <span className="me">{initial}</span>
        <a className="nm" href="#/settings/account">{S.driverName}</a>
        <a className={`ib${route.name === "settings" ? " on" : ""}`} href="#/settings" title="Settings"><Icon name="gear" /></a>
      </div>
    </aside>);
}
