import { useEffect, useRef, useState } from "react";
import type { ArtifactFilter, KeptSurface, LibraryBot, PublishedArtifact, PublishedPage } from "../../../shared/types";
import { Surface } from "../components/Surface";
import { Seg } from "../components/ui";
import { api, fileUrl } from "../lib/api";
import { kb, plural, when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

type Tab = "published" | "surfaces" | "files";
type Filter = Omit<ArtifactFilter, "cursor" | "limit">;
const KEYS = ["q", "member", "status", "kind", "imported"] as const;

// #/library/<tab>?member=…&status=… — filters live in the hash so other views can link to a filtered list.
export function Library({ arg }: { arg: string }) {
  const [path, query = ""] = arg.split("?");
  const tab: Tab = path === "surfaces" || path === "files" ? path : "published";
  const surfaces = useFetch(() => api.get<KeptSurface[]>("/api/surfaces"), []);
  const nSurfaces = surfaces.data?.length ?? 0;
  const tabs: [Tab, string][] = [["published", "Published"], ...(nSurfaces || tab === "surfaces" ? [["surfaces", `Surfaces · ${nSurfaces}`] as [Tab, string]] : []), ["files", "Files"]];
  return (
    <div className="page">
      <h1 className="pc-h2">Library</h1>
      <div className="tabs">{tabs.map(([k, l]) => <a key={k} href={`#/library/${k}`} className={tab === k ? "on" : ""}>{l}</a>)}</div>
      {tab === "published" ? <Published initial={new URLSearchParams(query)} />
        : tab === "surfaces" ? <Surfaces list={surfaces.data} />
        : <Files />}
    </div>
  );
}

function Published({ initial }: { initial: URLSearchParams }) {
  const { S } = useStore();
  const [f, setF] = useState<Filter>(() => Object.fromEntries(KEYS.flatMap((k) => (initial.get(k) ? [[k, initial.get(k)!]] : []))) as Filter);
  const [q, setQ] = useState(f.q || "");
  const [extra, setMore] = useState<{ key: string; items: PublishedArtifact[]; next: string | null } | null>(null);
  const key = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const page = useFetch(async () => ({ key, ...(await api.get<PublishedPage>(`/api/engram/artifacts?${key}`, { quiet: true })) }), [key], { keep: true });
  const stale = !!page.data && page.data.key !== key;
  const set = (patch: Partial<Filter>) => setF((o) => ({ ...o, ...patch }));

  useEffect(() => { const t = setTimeout(() => set({ q: q.trim() || undefined }), 250); return () => clearTimeout(t); }, [q]);
  // replaceState keeps typing out of the history and fires no hashchange, so this view isn't remounted.
  useEffect(() => { history.replaceState(null, "", `#/library/published${key ? `?${key}` : ""}`); }, [key]);
  // Show-more pages belong to the filter they were loaded under, so they drop out when the new first page arrives.
  const more = extra && extra.key === page.data?.key ? extra : null;
  const paged = useRef(false); paged.current = !!more;
  useLiveReload((e) => e.type === "turn" && !paged.current, page.reload, 2000);

  const loadMore = async () => {
    const next = more?.next ?? page.data?.next; if (!next) return;
    const r = await api.get<PublishedPage>(`/api/engram/artifacts?${key}${key ? "&" : ""}cursor=${encodeURIComponent(next)}`);
    setMore({ key, items: [...(more?.items || []), ...r.items], next: r.next });
  };
  const c = page.data?.counts, items = [...(page.data?.items || []), ...(more?.items || [])], next = more ? more.next : page.data?.next;
  const filtered = KEYS.some((k) => f[k]);
  const members = S.bots.filter((b) => !b.archived || f.member === b.id);

  return (
    <div className="col">
      <div className="lib-bar">
        <input type="search" placeholder="Search titles and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search published files" />
        <Seg value={f.status || "all"} onChange={(v) => set({ status: v === "all" ? undefined : v })}
          options={[["all", "All"], ["waiting", c?.waiting ? `Waiting · ${c.waiting}` : "Waiting"], ["public", "Public"], ["private", "Private"]] as const} />
        <select value={f.member || ""} onChange={(e) => set({ member: e.target.value || undefined })} aria-label="Crew member">
          <option value="">Everyone</option>{members.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={f.kind || ""} onChange={(e) => set({ kind: (e.target.value || undefined) as Filter["kind"] })} aria-label="Type">
          <option value="">Any type</option><option value="page">Pages and text</option><option value="pdf">PDFs</option><option value="image">Images</option><option value="other">Other</option>
        </select>
        {(c?.imported || f.imported) ? <label className="small faint lib-imp"><input type="checkbox" checked={!!f.imported} onChange={(e) => set({ imported: e.target.checked ? "1" : undefined })} />
          {`Imported · ${c?.imported ?? 0}`}</label> : null}
      </div>
      {/* min-height: a short result doesn't shrink the page, so the bar stays put while you type. */}
      <div className="lib-res">
        {page.error && !page.data ? <p className="small badc">{`Published files: ${page.error}`}</p>
          : !page.data ? null
          : items.length === 0 ? <p className="small faint">{filtered ? "Nothing matches." : "Nothing published yet. A crew member publishes a file when it's something to read, keep or share."}</p>
          : <>
            <p className="small faint">{filtered ? plural(items.length, "file") + (next ? "+" : "") : `${plural(c?.total ?? items.length, "file")} published`}</p>
            <div className={`pc-card tight arts${stale ? " stale" : ""}`}>{items.map((a) => <Row key={a.id} a={a} />)}</div>
            {next && !stale && <button className="pc-pill" onClick={loadMore}>Show more</button>}
          </>}
      </div>
    </div>
  );
}

function Row({ a }: { a: PublishedArtifact }) {
  const meta = [a.bot_name, a.version > 1 ? `v${a.version}` : "", a.size ? kb(a.size) : "", when(a.updated_at)].filter(Boolean).join(" · ");
  return (
    <div className="art">
      <div className="row art-t">{a.hue && a.shape && <pc-bot key={`${a.hue}.${a.shape}`} size="xs" hue={a.hue} shape={a.shape} />}
        <a href={a.url} target="_blank" rel="noreferrer"><b>{a.title}</b></a>{a.imported && <span className="small faint">imported</span>}</div>
      <span className="small faint art-m">{meta}</span>
      <span className="small art-s">{a.public_url ? <a href={a.public_url} target="_blank" rel="noreferrer">Anyone with link</a>
        : a.share_pending ? <a href="#/pitstops">Sharing waits for you</a> : <span className="faint">Only you</span>}</span>
      <span className="small art-th">{a.thread_id && <a href={`#/t/${a.thread_id}`}>Thread</a>}</span>
    </div>
  );
}

function Surfaces({ list }: { list: KeptSurface[] | null }) {
  if (!list) return null;
  if (!list.length) return <p className="small faint">No kept surfaces.</p>;
  return <div className="col">{list.map((s) => (
    <Surface key={s.id} s={s} extra={<a className="small faint" href={`#/t/${s.thread_id}`}>{s.bot_name}</a>}
      onAction={async (action, values) => { await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); }} />))}
  </div>;
}

// The raw workspaces: one collapsed row per member, opened on demand.
function Files() {
  const { data, error, reload } = useFetch(() => api.get<LibraryBot[]>("/api/library"), []);
  const [open, setOpen] = useState<string | null>(null);
  useLiveReload((e) => e.type === "turn", reload, 2000);
  if (error && !data) return <p className="badc">{error}</p>;
  if (!data) return null;
  const bots = data.filter((b) => b.files.length);
  if (!bots.length) return <p className="small faint">No files on the crew's computers.</p>;
  return <div className="col">{bots.map((b) => (
    <div key={b.id} className="pc-card tight">
      <button className="row lib-fold" onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
        <pc-bot key={`${b.hue}.${b.shape}`} size="xs" hue={b.hue} shape={b.shape} /><b>{b.name}</b><span className="small faint">{plural(b.files.length, "file")}</span>
        <span className="small faint lib-chev">{open === b.id ? "Hide" : "Show"}</span></button>
      {open === b.id && <table className="tbl"><tbody>{b.files.slice(0, 100).map((f) => (
        <tr key={f.path}><td className="pc-m small">{f.path}</td><td className="num small faint">{kb(f.size)}</td><td className="num small faint">{when(f.mtime)}</td>
          <td className="num"><a className="small" href={fileUrl(b.id, f.path)}>Download</a></td></tr>))}
      </tbody></table>}
    </div>))}
  </div>;
}
