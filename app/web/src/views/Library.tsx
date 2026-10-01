// Kept surfaces and the files on each member's computer.
import type { KeptSurface, LibraryBot } from "../../../shared/types";
import { Surface } from "../components/Surface";
import { api, fileUrl } from "../lib/api";
import { kb, when } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";

export function Library() {
  const { data, error, reload } = useFetch(async () => {
    const [files, surfaces] = await Promise.all([api.get<LibraryBot[]>("/api/library"), api.get<KeptSurface[]>("/api/surfaces")]);
    return { files, surfaces };
  }, []);
  useLiveReload((e) => e.type === "turn", reload, 2000);
  if (error && !data) return <div className="page"><p className="badc">{error}</p></div>;
  if (!data) return null;
  return (
    <div className="page">
      <h1 className="pc-h2">Library</h1>
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
