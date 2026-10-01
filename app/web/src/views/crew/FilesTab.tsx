// Workspace browser and per-run diffs. Reads the host's copy of the workspace, so it works with the computer off.
// Routes: files/<turnId | ->/<path>, and files/projects/<path>.
import { useState, type ReactNode } from "react";
import type { BotCard, ChangeRun, FileDiff, FsNode, Project } from "../../../../shared/types";
import { Diff } from "../../components/Diff";
import { Seg } from "../../components/ui";
import { api, fileUrl } from "../../lib/api";
import { when } from "../../lib/format";
import { go } from "../../lib/router";
import { useFetch } from "../../lib/useFetch";

export function FilesTab({ b, rest }: { b: BotCard; rest: (string | undefined)[] }) {
  const projects = rest[0] === "projects";
  return (
    <div className="col">
      <div className="seg"><a className={projects ? "" : "on"} href={`#/crew/${b.id}/files`}>Files</a><a className={projects ? "on" : ""} href={`#/crew/${b.id}/files/projects`}>Projects</a></div>
      {projects ? <Projects key={rest[1] || ""} b={b} encPath={rest[1]} /> : <Files b={b} turnId={rest[0]} encPath={rest[1]} />}
    </div>
  );
}

const chipFor = (status: string) => `pc-chip ${status === "added" ? "ok" : status === "deleted" ? "bad" : "blue"}`;
let splitPref = false; // kept across files for the session, like the old view

function Files({ b, turnId, encPath }: { b: BotCard; turnId?: string; encPath?: string }) {
  const path = encPath ? decodeURIComponent(encPath) : "";
  const runs = useFetch(() => api.get<ChangeRun[]>(`/api/bots/${b.id}/changes`), [b.id]);
  const open = (t: string | null | undefined, p?: string) => go(`#/crew/${b.id}/files/${t || "-"}${p != null ? `/${encodeURIComponent(p)}` : ""}`);
  const inRun = !!turnId && turnId !== "-";
  return (
    <div className="files">
      <div className="col">
        <p className="pc-lab">Changes by run</p>
        <div className="col" style={{ gap: 2 }}>
          {runs.data && !runs.data.length && <p className="small faint">No changes recorded yet. Every run's file changes land here, whether made by a patch, a command or a script.</p>}
          {runs.data?.map((r) => (
            <div key={r.id} className={`run ${r.id === turnId ? "on" : ""}`}>
              <button className="runhead" onClick={() => open(r.id)}><span className="small">{r.thread_title}</span><span className="pc-m small faint">{`${r.changes.length} · ${when(r.started_at)}`}</span></button>
              {r.id === turnId && <div className="col" style={{ gap: 0 }}>{r.changes.map((c) => (
                <button key={c.path} className={`cfile ${c.path === path ? "on" : ""}`} onClick={() => open(r.id, c.path)}><span className={chipFor(c.status)}>{c.status[0].toUpperCase()}</span><span className="pc-m small">{c.path}</span></button>))}
              </div>}
            </div>))}
        </div>
        <p className="pc-lab" style={{ marginTop: 12 }}>Workspace /bot/work</p>
        <div className="tree"><Dir b={b} rel="" depth={0} selected={inRun ? null : path} onFile={(p) => open("-", p)} /></div>
      </div>
      <div className="pc-card tight viewer">
        {inRun && path ? <RunDiff key={`${turnId}/${path}`} b={b} turnId={turnId!} path={path} />
          : path ? <FileView key={path} b={b} path={path} />
          : <p className="empty">{inRun ? "Pick a file from this run to see its diff." : "Pick a file to view it, or a run to review what changed."}</p>}
      </div>
    </div>
  );
}

// Folders load their entries the first time they open.
function Dir({ b, rel, depth, selected, onFile }: { b: BotCard; rel: string; depth: number; selected: string | null; onFile: (p: string) => void }) {
  const { data } = useFetch(() => api.get<FsNode>(`/api/bots/${b.id}/fs?path=${encodeURIComponent(rel)}`, { quiet: true }), [b.id, rel]);
  if (!data || data.type !== "dir") return null;
  return <>{data.entries.map((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.dir ? <Folder key={p} b={b} rel={p} name={e.name} depth={depth} selected={selected} onFile={onFile} />
      : <button key={p} className={`tf ${p === selected ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onFile(p)}>{e.name}</button>;
  })}</>;
}

function Folder({ name, depth, ...rest }: { b: BotCard; rel: string; name: string; depth: number; selected: string | null; onFile: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className={`tf dir ${open ? "open" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>{name}</button>
      {open && <div><Dir depth={depth + 1} {...rest} /></div>}
    </div>
  );
}

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="vhead"><span className="pc-m small">{title}</span><span style={{ flex: 1 }} />{children}</div>;
}

function RunDiff({ b, turnId, path }: { b: BotCard; turnId: string; path: string }) {
  const { data: d, error } = useFetch(() => api.get<FileDiff>(`/api/turns/${turnId}/diff?path=${encodeURIComponent(path)}`), [turnId, path]);
  const [split, setSplit] = useState(splitPref);
  if (!d && !error) return null;
  return (
    <>
      <Head title={`${path} · ${d?.status || ""}`}>
        <Seg options={[["unified", "unified"], ["split", "split"]] as const} value={split ? "split" : "unified"} onChange={(m) => { splitPref = m === "split"; setSplit(splitPref); }} />
        {d?.status !== "deleted" && <a className="pc-pill o s" href={fileUrl(b.id, path)}>Download</a>}
      </Head>
      {!d ? <p className="empty">Couldn't load this change.</p>
        : !d.text ? <p className="empty">{`Binary file ${d.status}. ${d.size} bytes.`}</p>
        : <Diff before={d.beforeText} after={d.afterText} split={split} />}
    </>
  );
}

function FileView({ b, path }: { b: BotCard; path: string }) {
  const { data: f, error } = useFetch(() => api.get<FsNode>(`/api/bots/${b.id}/fs?path=${encodeURIComponent(path)}`), [b.id, path]);
  if (!f && !error) return null;
  const url = fileUrl(b.id, path);
  const file = f?.type === "file" ? f : null;
  return (
    <>
      <Head title={path}><span className="pc-m small faint">{file ? `${file.size} bytes · ${when(file.mtime)}` : ""}</span><a className="pc-pill o s" href={url}>Download</a></Head>
      {!file ? <p className="empty">Not found.</p>
        : file.image ? <div style={{ padding: 16 }}><img src={`${url}?inline=1`} style={{ maxWidth: "100%", borderRadius: 10 }} /></div>
        : file.text != null ? <div className="code">{file.text.split("\n").map((l, i) => <div key={i} className="dl"><span className="ln">{String(i + 1)}</span><code>{l}</code></div>)}</div>
        : <p className="empty">Binary or large file. Download it to open.</p>}
    </>
  );
}

// px0 runs per project in its own read-only container; the frame is sandboxed, so it never shares Pitcrew's origin.
function Projects({ b, encPath }: { b: BotCard; encPath?: string }) {
  const { data: list, error } = useFetch(() => api.get<Project[]>(`/api/bots/${b.id}/projects`), [b.id]);
  if (error && !list) return <p className="badc">{error}</p>;
  if (!list) return null;
  if (!list.length) return <div className="pc-card"><p className="empty">{`No code projects in ${b.name}'s workspace yet. A folder with .git, package.json, go.mod, pyproject.toml or similar shows up here.`}</p></div>;
  return <ProjectFrame b={b} list={list} path={encPath ? decodeURIComponent(encPath) : list[0].path} />;
}

function ProjectFrame({ b, list, path }: { b: BotCard; list: Project[]; path: string }) {
  const opened = useFetch(() => api.post<{ url: string }>(`/api/bots/${b.id}/projects/open`, { path }, { quiet: true }), [b.id, path]);
  return (
    <div className="col">
      <div className="row">
        <select className="projsel" value={path} onChange={(e) => go(`#/crew/${b.id}/files/projects/${encodeURIComponent(e.target.value)}`)}>
          {list.map((p) => <option key={p.path} value={p.path}>{`${p.path}${p.git ? " · git" : ""}`}</option>)}
        </select>
        <span className="pc-chip ok">read-only</span>
        {opened.error ? <span className="small badc">{opened.error}</span> : !opened.data && <span className="small faint">Starting the code view…</span>}
        <span style={{ flex: 1 }} />
        {opened.data && <a className="small" href={opened.data.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>}
      </div>
      <iframe className="codeview" sandbox="allow-scripts allow-popups allow-downloads" referrerPolicy="no-referrer" title={`${path}, read-only`} src={opened.data?.url} />
    </div>
  );
}
