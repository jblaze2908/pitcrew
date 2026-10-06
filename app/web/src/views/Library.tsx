// One Library: published items (a link you can open anywhere) and working files (still on the member's computer), with a
// preview pane. Per view: one published-list call per filter change (the server pages it) and one workspace listing.
import { useEffect, useRef, useState } from "react";
import type { KeptSurface, LibraryBot, PublishedArtifact, PublishedPage } from "../../../shared/types";
import { Icon } from "../components/Icon";
import { Surface } from "../components/Surface";
import { Face } from "../components/ui";
import { api, fileUrl } from "../lib/api";
import { dayLabel, hm, kb, stamp } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

type View = "all" | "published" | "working";
type Time = "any" | "today" | "week" | "month";
interface Filter { view: View; q: string; member: string; type: string; time: Time }
type State = "public" | "private" | "waiting" | "working";
interface Item {
  key: string; title: string; type: string; botId: string; botName: string; hue: string | null; shape: string | null; at: number; state: State;
  versions: PublishedArtifact[]; nVersions: number; file?: { path: string; size: number };
}

// ---------- types: a word and an icon instead of bytes ----------
const ICON: Record<string, string> = {
  Doc: '<path d="M4 1.8h5.5L13 5.3v8.9H4zM9.5 1.8v3.5H13M6.3 8.3h4.4M6.3 10.8h4.4"/>',
  Table: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M2.5 6.5h11M2.5 9.8h11M6.5 6.5V13"/>',
  Dashboard: '<path d="M3 13.5V8.5M6.5 13.5V4M10 13.5V7M13.5 13.5V10"/>',
  Skill: '<path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z"/>',
  Video: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M7 6.3v3.4l3-1.7z" fill="currentColor"/>',
  PDF: '<path d="M4 1.8h5.5L13 5.3v8.9H4zM9.5 1.8v3.5H13M6 9.5h4M6 12h2.5"/>',
  "Web page": '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
  Image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.8" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  Script: '<path d="M6 5L3 8l3 3M10 5l3 3-3 3"/>',
  Data: '<path d="M5.5 2.5c-1.5 0-2 .8-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.2.5 2 2 2M10.5 2.5c1.5 0 2 .8 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.2-.5 2-2 2"/>',
  File: '<path d="M4 1.8h5.5L13 5.3v8.9H4zM9.5 1.8v3.5H13"/>',
};
const TypeIcon = ({ type, size = 18 }: { type: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON[type] || ICON.File }} />);
const EXT: [RegExp, string][] = [[/\.(md|txt|docx?|rtf|odt)$/i, "Doc"], [/\.(csv|tsv|xlsx?|ods|db|sqlite3?)$/i, "Table"], [/\.pdf$/i, "PDF"], [/\.(png|jpe?g|webp|gif|svg|heic)$/i, "Image"],
  [/\.(mp4|mov|webm|m4v)$/i, "Video"], [/\.html?$/i, "Web page"], [/\.(py|js|mjs|ts|sh|rb)$/i, "Script"], [/\.(json|ya?ml|toml|xml)$/i, "Data"]];
const byExt = (name: string) => EXT.find(([re]) => re.test(name))?.[1] || "File";
function pubType(a: PublishedArtifact) {
  const k = a.kind.toLowerCase(), m = (a.mime || "").toLowerCase();
  if (k === "dashboard" || k === "skill") return k === "dashboard" ? "Dashboard" : "Skill";
  if (m.includes("html")) return "Web page";
  if (m === "application/pdf" || k === "pdf") return "PDF";
  if (m.startsWith("image/") || k === "image") return "Image";
  if (m.startsWith("video/")) return "Video";
  if (m.includes("csv") || m.includes("spreadsheet")) return "Table";
  if (m.startsWith("text/") || k === "page") return "Doc";
  return byExt(a.title);
}
/** "october-budget.csv" → "October budget": the row says what it is; Details keeps the real path. */
const pretty = (path: string) => { const s = (path.split("/").pop() || path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(); return s ? s[0].toUpperCase() + s.slice(1) : path; };

// ---------- filters live in the hash, so other views can link to a filtered list ----------
const TIMES: [Time, string][] = [["any", "Any time"], ["today", "Today"], ["week", "Past 7 days"], ["month", "Past 30 days"]];
const since: Record<Time, number> = { any: 0, today: 86400000, week: 7 * 86400000, month: 30 * 86400000 };
function parse(arg: string): Filter {
  const [path, query = ""] = arg.split("?"), p = new URLSearchParams(query);
  const t = p.get("time") as Time;
  return { view: path === "published" ? "published" : path === "files" ? "working" : "all", q: p.get("q") || "", member: p.get("member") || "", type: p.get("type") || "", time: TIMES.some(([k]) => k === t) ? t : "any" };
}
// #/library/<all|published|files>?member=…: the router splits on "/", so the view is a path segment and the rest a query.
const hashOf = (f: Filter) => { const p = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && k !== "view" && !(k === "time" && v === "any"))); return `#/library/${f.view === "working" ? "files" : f.view}${p.size ? `?${p}` : ""}`; };

export function Library({ arg }: { arg: string }) {
  if (arg.split("?")[0] === "surfaces") return <Surfaces />;
  return <Lib initial={parse(arg)} />;
}

function Lib({ initial }: { initial: Filter }) {
  const { S } = useStore();
  const [f, setF] = useState<Filter>(initial);
  const [q, setQ] = useState(f.q);
  const [sel, setSel] = useState<string | null>(null);
  const [extra, setMore] = useState<{ key: string; items: PublishedArtifact[]; next: string | null } | null>(null);
  const set = (patch: Partial<Filter>) => setF((o) => ({ ...o, ...patch }));
  // Engram filters by text and member; type and time are ours, so they don't cost a call.
  const key = new URLSearchParams(Object.entries({ q: f.q, member: f.member }).filter(([, v]) => v)).toString();
  const page = useFetch(async () => ({ key, ...(await api.get<PublishedPage>(`/api/engram/artifacts?${key}`, { quiet: true })) }), [key], { keep: true });
  const files = useFetch(() => api.get<LibraryBot[]>("/api/library"), []);
  const surfaces = useFetch(() => api.get<KeptSurface[]>("/api/surfaces", { quiet: true }), []);
  const stale = !!page.data && page.data.key !== key;

  useEffect(() => { const t = setTimeout(() => set({ q: q.trim() }), 250); return () => clearTimeout(t); }, [q]);
  // replaceState keeps typing out of the history and fires no hashchange, so this view isn't remounted.
  useEffect(() => { history.replaceState(null, "", hashOf(f)); }, [f]);
  const more = extra && extra.key === page.data?.key ? extra : null;
  const paged = useRef(false); paged.current = !!more;
  useLiveReload((e) => e.type === "turn" && !paged.current, () => { page.reload(); files.reload(); }, 2000);
  const loadMore = async () => {
    const next = more?.next ?? page.data?.next; if (!next) return;
    const r = await api.get<PublishedPage>(`/api/engram/artifacts?${key}${key ? "&" : ""}cursor=${encodeURIComponent(next)}`);
    setMore({ key, items: [...(more?.items || []), ...r.items], next: r.next });
  };

  const looks = new Map(S.bots.map((b) => [b.id, b]));
  const pubRaw = [...(page.data?.items || []), ...(more?.items || [])], next = more ? more.next : page.data?.next;
  // Same member, same title: one row with its versions, newest first.
  const groups = new Map<string, PublishedArtifact[]>();
  for (const a of pubRaw) { const k = `${a.bot_id}\u0000${a.title.trim().toLowerCase()}`; groups.set(k, [...(groups.get(k) || []), a]); }
  const published: Item[] = [...groups.entries()].map(([k, list]) => {
    const v = [...list].sort((x, y) => y.updated_at - x.updated_at), a = v[0];
    return { key: `p:${k}`, title: a.title, type: pubType(a), botId: a.bot_id, botName: a.bot_name, hue: a.hue, shape: a.shape, at: a.updated_at,
      state: v.some((x) => x.share_pending) ? "waiting" : a.public_url ? "public" : "private", versions: v, nVersions: v.reduce((n, x) => n + x.version, 0) };
  });
  const ql = f.q.toLowerCase();
  const working: Item[] = (files.data || []).flatMap((b) => b.files.flatMap((x) => {
    // A skill is its SKILL.md; the scripts and references beside it are parts of it, not items.
    const skill = /^skills\/([^/]+)\/(.+)$/.exec(x.path);
    if (skill && skill[2] !== "SKILL.md") return [];
    const title = skill ? pretty(skill[1]) : pretty(x.path);
    if (ql && !`${title} ${x.path}`.toLowerCase().includes(ql)) return [];
    if (f.member && b.id !== f.member) return [];
    return [{ key: `w:${b.id}:${x.path}`, title, type: skill ? "Skill" : byExt(x.path), botId: b.id, botName: b.name, hue: b.hue, shape: b.shape, at: x.mtime, state: "working" as State, versions: [], nVersions: 0, file: { path: x.path, size: x.size } }];
  }));
  // With more published pages to load, older working files wait too, so the merged list stays in time order.
  const oldestPub = next && published.length ? Math.min(...published.map((i) => i.at)) : 0;
  const pool = f.view === "published" ? published : f.view === "working" ? working : [...published, ...working.filter((w) => w.at >= oldestPub)];
  const cut = f.time === "any" ? 0 : Date.now() - since[f.time];
  const items = pool.filter((i) => (!f.type || i.type === f.type) && i.at >= cut).sort((x, y) => y.at - x.at);
  const types = [...new Set([...published, ...working].map((i) => i.type))].sort();
  const members = S.bots.filter((b) => !b.archived || f.member === b.id);
  const selected = items.find((i) => i.key === sel) || items[0] || null;
  const nPub = !f.q && !f.member && page.data ? page.data.counts.total : published.length, plus = next ? "+" : "";

  const days: [string, Item[]][] = [];
  for (const i of items) { const d = Date.now() - i.at < 6 * 86400000 ? dayLabel(i.at) : "Earlier"; const g = days.find(([l]) => l === d); if (g) g[1].push(i); else days.push([d, [i]]); }
  const loading = !files.data || (!page.data && !page.error);
  const filtered = !!(f.q || f.member || f.type || f.time !== "any");

  return (
    <div className="page lib2">
      <div className="lib-top">
        <div><h1 className="lib-h1">Library</h1><p className="lib-sub">Everything your crew has made, in one place. Published items have a link you can open anywhere; working files stay on the member's computer until they publish them.</p></div>
        <label className="lib-search"><Icon name="search" size={14} /><input type="search" placeholder="Search titles and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" /></label>
      </div>
      <div className="lib-bar2">
        <div className="lib-seg" role="tablist">{([["all", "All", nPub + working.length], ["published", "Published", nPub], ["working", "Working files", working.length]] as const).map(([v, l, n]) => (
          <button key={v} role="tab" aria-selected={f.view === v} className={f.view === v ? "on" : ""} onClick={() => set({ view: v })}>{l}{page.data && files.data ? <b>{`${n}${v !== "working" ? plus : ""}`}</b> : null}</button>))}</div>
        <select className="lib-dd" value={f.member} onChange={(e) => set({ member: e.target.value })} aria-label="Member"><option value="">All members</option>{members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <select className="lib-dd" value={f.type} onChange={(e) => set({ type: e.target.value })} aria-label="Type"><option value="">Any type</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select className="lib-dd" value={f.time} onChange={(e) => set({ time: e.target.value as Time })} aria-label="Time">{TIMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {surfaces.data && surfaces.data.length > 0 && <a className="small faint lib-kept" href="#/library/surfaces">{`Saved from threads · ${surfaces.data.length}`}</a>}
      </div>
      {page.error && f.view !== "working" && <p className="small badc">{`Published items couldn't load: ${page.error}`}</p>}
      {files.error && f.view !== "published" && <p className="small badc">{`Working files couldn't load: ${files.error}`}</p>}
      <div className="lib-cols">
        <div className={`lib-listcol${stale ? " stale" : ""}`}>
          {loading ? null : !items.length ? <p className="small faint lib-none">{filtered ? "Nothing matches." : f.view === "working" ? "No working files on the crew's computers." : "Nothing here yet. A member publishes something when it's worth reading, keeping or sharing."}</p>
            : days.map(([label, list]) => (
              <section key={label}>
                <p className="lib-grp">{label}</p>
                <div className="lib-list">{list.map((i) => <Row key={i.key} i={i} on={selected?.key === i.key} onPick={() => setSel(i.key)} face={looks.get(i.botId) ?? i} />)}</div>
              </section>))}
          {next && !stale && f.view !== "working" && <button className="pc-pill o s lib-more" onClick={loadMore}>Show more</button>}
        </div>
        {selected && <Preview i={selected} face={looks.get(selected.botId) ?? selected} />}
      </div>
    </div>
  );
}

const STATE_WORD: Record<State, [string, string]> = { public: ["Published", "Anyone with the link"], private: ["Published", "Only you"], waiting: ["Waiting for you", "Asked for a public link"], working: ["Working file", "On their computer"] };

function Row({ i, on, onPick, face }: { i: Item; on: boolean; onPick: () => void; face: { hue: string | null; shape: string | null } }) {
  const [word, sub] = STATE_WORD[i.state];
  const d = dayLabel(i.at);
  return (
    <button className={`lib-row${on ? " on" : ""}`} onClick={onPick} aria-pressed={on}>
      <span className="lib-ic"><TypeIcon type={i.type} /></span>
      <span className="lib-tt"><b>{i.title}</b><span className="lib-meta">{i.type}<i>·</i><Face b={{ hue: face.hue || "c1", shape: face.shape || "square" }} size="xs" />{i.botName}{i.nVersions > 1 && <><i>·</i>{`${i.nVersions} versions`}</>}</span></span>
      <span className={`lib-st ${i.state}`}>{word}<small>{sub}</small></span>
      <span className="lib-tm pc-m">{d === "Today" || d === "Yesterday" ? hm(i.at) : stamp(i.at)}</span>
    </button>);
}

function Preview({ i, face }: { i: Item; face: { hue: string | null; shape: string | null } }) {
  const { threadTitle } = useStore();
  const head = i.versions[0];
  const d = dayLabel(i.at);
  const updated = d === "Today" || d === "Yesterday" ? `${d.toLowerCase()} at ${hm(i.at)}` : `on ${stamp(i.at)}`;
  const size = head?.size ?? i.file?.size ?? null;
  return (
    <aside className="lib-pv" aria-label="Preview">
      <p className="lib-kind"><TypeIcon type={i.type} size={15} />{`${i.type} · updated ${updated}`}</p>
      <h2>{i.title}</h2>
      <p className="lib-from"><Face b={{ hue: face.hue || "c1", shape: face.shape || "square" }} size="xs" />{i.botName}{head?.thread_id && <>, in <a href={`#/t/${head.thread_id}`}>{threadTitle(head.thread_id) || "its thread"}</a></>}</p>
      {i.state === "working" ? <>
        <div className="lib-state"><b>Working file</b><p>{`It's on ${i.botName}'s computer. Ask them to publish it if you want a link you can open anywhere.`}</p></div>
        <div className="lib-acts">
          <a className="pc-pill s" href={fileUrl(i.botId, i.file!.path)} target="_blank" rel="noreferrer">Open</a>
          <a className="pc-pill o s" href={`#/crew/${i.botId}/files`}>{`${i.botName}'s files`}</a>
        </div>
      </> : <>
        <div className={`lib-state${i.state === "waiting" ? " waiting" : ""}`}>
          <b>{STATE_WORD[i.state][0]}</b>
          <p>{i.state === "public" ? "Anyone with the link can open it." : i.state === "waiting" ? `${i.botName} asked for a link anyone can open. It waits for your OK in Needs you.` : "Only you can open it. Turn on the link to share it with someone."}</p>
        </div>
        <div className="lib-acts">
          <a className="pc-pill s" href={head.url} target="_blank" rel="noreferrer">Open</a>
          {i.state === "waiting" ? <a className="pc-pill o s" href="#/pitstops">Review</a>
            : <>
              {/* Pitcrew can't change a link itself (Engram has no such link call); both open the page where you do it. */}
              {i.state === "private" && <a className="pc-pill o s" href={head.url} target="_blank" rel="noreferrer" title="Opens its page, where you turn the link on">Turn on link</a>}
              {i.state === "public" && <button className="pc-pill o s" onClick={() => navigator.clipboard?.writeText(head.public_url || "").then(() => toast("Link copied"), () => toast("Couldn't copy", true))}>Copy link</button>}
              <a className="pc-pill o s" href={head.url} target="_blank" rel="noreferrer" title="Opens its page, where you unpublish it">Unpublish</a>
            </>}
        </div>
        <p className="lib-lab">Versions</p>
        <div className="lib-vers">{i.versions.map((v, n) => (
          <a key={v.id} className={`lib-ver${n === 0 ? " now" : ""}`} href={v.url} target="_blank" rel="noreferrer">
            <span className="pc-m">{`v${v.version}`}</span><span>{n === 0 ? (v.version > 1 ? `Latest of ${v.version} at this link` : "Latest") : v.version > 1 ? `${v.version} versions at another link` : "Published separately"}</span><span className="pc-m faint">{stamp(v.updated_at)}</span>
          </a>))}</div>
      </>}
      <p className="lib-lab">Details</p>
      <dl className="lib-kv">
        <dt>Type</dt><dd>{size ? `${i.type}, ${kb(size)}` : i.type}</dd>
        <dt>Made by</dt><dd>{i.botName}</dd>
        {i.file ? <><dt>File</dt><dd className="pc-m small">{i.file.path}</dd></> : head?.imported ? <><dt>From</dt><dd>Imported</dd></> : null}
        {head && <><dt>First published</dt><dd>{stamp(Math.min(...i.versions.map((v) => v.created_at)))}</dd></>}
      </dl>
    </aside>);
}

function Surfaces() {
  const list = useFetch(() => api.get<KeptSurface[]>("/api/surfaces"), []);
  return (
    <div className="page lib2">
      <div className="col" style={{ gap: 6 }}><a className="small faint" href="#/library">Library ›</a><h1 className="lib-h1">Saved from threads</h1></div>
      {!list.data ? null : !list.data.length ? <p className="small faint">Nothing saved from threads yet.</p>
        : <div className="col">{list.data.map((s) => (
          <Surface key={s.id} s={s} extra={<a className="small faint" href={`#/t/${s.thread_id}`}>{s.bot_name}</a>} />))}</div>}
    </div>);
}
