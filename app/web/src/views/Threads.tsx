// Every thread across the crew: pinned, then by day or by member, with sub-threads nested under the thread that asked.
// Test and probe threads stay hidden unless asked for; pages come 12 at a time from the server.
import { useEffect, useRef, useState } from "react";
import type { ThreadKid, ThreadListRow, ThreadPage } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { ListFilters, ListGroups, ListPage, ListPager, ListSearch, MemberSelect } from "../components/ListPage";
import { Face, Loader } from "../components/ui";
import { api } from "../lib/api";
import { dayLabel, hm, plainWords, plural, stamp } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";

const PAGE = 12;
type Mode = "recent" | "member";
const recentGroup = (t: number) => { const d = dayLabel(t); return d === "Today" || d === "Yesterday" ? d : "Earlier"; };
const timeOf = (t: number) => (recentGroup(t) === "Earlier" ? stamp(t) : hm(t));

export function Threads() {
  const { S, bot, name } = useStore();
  const [q, setQ] = useState(""), [member, setMember] = useState(""), [mode, setMode] = useState<Mode>("recent");
  const [test, setTest] = useState(false), [archived, setArchived] = useState(false);
  const key = new URLSearchParams({ limit: String(PAGE), ...(q ? { q } : {}), ...(member ? { bot: member } : {}), ...(test ? { test: "1" } : {}), ...(archived ? { archived: "1" } : {}) }).toString();
  const first = useFetch(async () => ({ key, ...(await api.get<ThreadPage>(`/api/threads?${key}`, { quiet: true })) }), [key], { keep: true });
  // "Show more" pages belong to the filters they were loaded under and drop out when those change.
  const [extra, setExtra] = useState<{ key: string; rows: ThreadListRow[]; kids: ThreadPage["kids"]; next: string | null } | null>(null);
  const more = extra && extra.key === first.data?.key ? extra : null;
  const paged = useRef(false); paged.current = !!more;
  useLiveReload((e) => e.type === "thread" && !paged.current, first.reload, 1500);

  const d = first.data;
  const loadMore = async () => {
    const next = more ? more.next : d?.next; if (!next || !d) return;
    const r = await api.get<ThreadPage>(`/api/threads?${d.key}&before=${encodeURIComponent(next)}`);
    setExtra({ key: d.key, rows: [...(more?.rows || []), ...r.rows], kids: { ...(more?.kids || {}), ...r.kids }, next: r.next });
  };
  const rows = [...(d?.rows || []), ...(more?.rows || [])], kids = { ...(d?.kids || {}), ...(more?.kids || {}) }, next = more ? more.next : d?.next;
  const pinned = d?.pinned || [];
  const waiting = new Map(S.pitstops.filter((p) => p.kind !== "engram" && p.thread_id).map((p) => [p.thread_id!, plainWords(p.title.replace(/ · (verify|after untrusted|jev blocked)\b.*$/, ""))]));
  const shown = pinned.length + rows.length;
  const hidden = d?.hidden?.test ? [plural(d.hidden.test, "test thread")] : [];
  const byMember = (r: ThreadListRow) => (bot(r.bot_id) ? name(r.bot_id) : "Former members");
  const memberSorted = mode === "member" ? [...pinned, ...rows].sort((a, b) => byMember(a).localeCompare(byMember(b)) || b.updated_at - a.updated_at) : [];
  const stale = !!d && d.key !== key;
  const item = (r: ThreadListRow) => <ThreadItem r={r} kids={kids[r.id] || []} waiting={waiting.get(r.id) ?? (r.status === "needs" ? "Needs you" : null)} />;

  return (
    <ListPage title="Threads" lede={archived ? "Archived threads." : undefined} className="threads2">
      <ListFilters right={<label className="lp-switch"><input type="checkbox" checked={test} onChange={(e) => setTest(e.target.checked)} /><i />Show test threads</label>}>
        <ListSearch wide value={q} onChange={setQ} placeholder="Search titles and messages" />
        <div className="lp-seg" role="group" aria-label="Group by">{([["recent", "Recent"], ["member", "By member"]] as const).map(([k, l]) => <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>{l}</button>)}</div>
        <MemberSelect value={member} onChange={setMember} />
      </ListFilters>
      <div className={stale ? "lp-list stale" : "lp-list"}>
        {d && !shown ? <p className="lp-empty">{q ? "Nothing matches that." : archived ? "No archived threads." : "No threads yet."}</p>
          : mode === "member" ? <ListGroups rows={memberSorted} at={(r) => r.updated_at} group={byMember} keyOf={(r) => r.id}>{item}</ListGroups>
          : <>
            {pinned.length > 0 && <ListGroups rows={pinned} at={(r) => r.updated_at} group={() => "Pinned"} keyOf={(r) => r.id}>{item}</ListGroups>}
            <ListGroups rows={rows} at={(r) => r.updated_at} group={(r) => recentGroup(r.updated_at)} keyOf={(r) => r.id}>{item}</ListGroups>
          </>}
      </div>
      {d && <ListPager note={`${d.total != null ? `${shown} of ${d.total} threads` : plural(shown, "thread")}${hidden.length ? ` · ${hidden.join(" and ")} not listed` : ""}`}>
        <button className="lp-link" onClick={() => setArchived(!archived)}>{archived ? "Current threads" : "Archived"}</button>
        {next && <button className="pc-pill o s" onClick={loadMore}>Show more</button>}
      </ListPager>}
    </ListPage>);
}

function ThreadItem({ r, kids, waiting }: { r: ThreadListRow; kids: ThreadKid[]; waiting: string | null }) {
  const { bot } = useStore();
  const b = bot(r.bot_id), running = r.status === "running";
  const replied = kids.filter((k) => k.replied).length;
  // Open while a member is still on it; finished asks fold to one line.
  const [open, setOpen] = useState(() => kids.some((k) => k.status === "running" || !k.replied));
  useEffect(() => { if (kids.some((k) => k.status === "running")) setOpen(true); }, [kids]);
  return <>
    <div className="lp-row th-row">
      {b ? <Face b={b} size="sm" mood={waiting ? "needs" : running ? "working" : "idle"} /> : <i className="lp-ghost sm" />}
      <div className="th-main">
        <a className="th-title" href={`#/t/${r.id}`}>{r.title}{r.pinned ? <Icon name="pin" size={13} /> : null}</a>
        {waiting ? <p className="th-pv need">{waiting}</p> : <p className="th-pv">{running && <Loader />}{r.snippet}</p>}
        {kids.length > 0 && <button className={`th-sub${open ? " open" : ""}`} onClick={() => setOpen(!open)}><Icon name="chev" size={11} />{`Asked ${plural(kids.length, "member")} · ${replied === kids.length ? (kids.length === 1 ? "replied" : "all replied") : `${replied} replied`}`}</button>}
      </div>
      <span className={`th-member${b ? "" : " q"}`}>{b?.name || "A former member"}</span>
      <span className="lp-time">{timeOf(r.updated_at)}</span>
    </div>
    {open && kids.length > 0 && <div className="th-kids">{kids.map((k) => { const kb = bot(k.bot_id); return (
      <a key={k.id} className="th-kid" href={`#/t/${k.id}`}>
        {kb ? <Face b={kb} size="xs" mood={k.status === "running" ? "working" : "idle"} /> : <i className="lp-ghost xs" />}
        <span className="th-member">{kb?.name || "A former member"}</span>
        <span className="th-pv">{k.status === "running" && <Loader />}{k.snippet || k.title}</span>
        <span className="lp-time">{k.status === "running" ? "now" : timeOf(k.updated_at)}</span>
      </a>); })}</div>}
  </>;
}
