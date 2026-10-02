// Kept surfaces and the files on each member's computer.
import type { KeptSurface, LibraryBot, PublishedArtifact } from "../../../shared/types";
import { Surface } from "../components/Surface";
import { api, fileUrl } from "../lib/api";
import { kb, when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

export function Library() {
  const { data, error, reload } = useFetch(async () => {
    // Engram being down must not hide the crew's own files, so its list fails on its own.
    const [files, surfaces, published] = await Promise.all([api.get<LibraryBot[]>("/api/library"), api.get<KeptSurface[]>("/api/surfaces"),
      api.get<PublishedArtifact[]>("/api/engram/artifacts", { quiet: true }).catch((e: Error) => e)]);
    return { files, surfaces, published };
  }, []);
  useLiveReload((e) => e.type === "turn", reload, 2000);
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  if (!data) return null;
  return (
    <div className="page">
      <h1 className="pc-h2">Library</h1>
      {data.published instanceof Error ? <p className="small badc">{`Published files: ${data.published.message}`}</p>
        : data.published.length > 0 && <>
        <p className="pc-lab">Published</p>
        <div className="pc-card tight"><table className="tbl"><tbody>{data.published.map((a) => (
          <tr key={a.id}>
            <td><div className="row">{a.hue && a.shape && <pc-bot key={`${a.hue}.${a.shape}`} size="xs" hue={a.hue} shape={a.shape} />}
              <a href={a.url} target="_blank" rel="noreferrer"><b>{a.title}</b></a></div>
              <span className="small faint">{`${a.bot_name} · ${a.kind}${a.version > 1 ? ` · v${a.version}` : ""}${a.size ? ` · ${kb(a.size)}` : ""}`}</span></td>
            <td className="small">{a.public_url ? <a href={a.public_url} target="_blank" rel="noreferrer">Public link</a>
              : a.share_pending ? <a className="faint" href="#/pitstops">Public link waits for you</a> : <span className="faint">Private</span>}</td>
            <td className="num small faint">{when(a.updated_at)}</td>
            <td className="num">{a.thread_id && <a className="small" href={`#/t/${a.thread_id}`}>Thread</a>}</td>
          </tr>))}
        </tbody></table></div>
      </>}
      {data.surfaces.length > 0 && <>
        <p className="pc-lab">Kept surfaces</p>
        <div className="col">{data.surfaces.map((s) => (
          <Surface key={s.id} s={s} extra={<a className="small faint" href={`#/t/${s.thread_id}`}>{s.bot_name}</a>}
            onAction={async (action, values) => { await api.post(`/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); }} />))}
        </div>
      </>}
      <p className="pc-lab">Files from the crew's computers</p>
      {data.files.map((b) => (
        <div key={b.id} className="pc-card tight">
          <div className="row" style={{ padding: "14px 16px" }}><pc-bot key={`${b.hue}.${b.shape}`} size="xs" hue={b.hue} shape={b.shape} /><b>{b.name}</b><span className="small faint">{`${b.files.length} file${b.files.length === 1 ? "" : "s"}`}</span></div>
          {b.files.length > 0 && <table className="tbl"><tbody>{b.files.slice(0, 100).map((f) => (
            <tr key={f.path}><td className="pc-m small">{f.path}</td><td className="num small faint">{kb(f.size)}</td><td className="num small faint">{when(f.mtime)}</td>
              <td className="num"><a className="small" href={fileUrl(b.id, f.path)}>Download</a></td></tr>))}
          </tbody></table>}
        </div>))}
    </div>
  );
}
