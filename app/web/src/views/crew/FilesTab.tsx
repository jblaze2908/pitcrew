import { useEffect, useRef, useState } from "react";
import type { BotCard, ChangeRun, FileChange, FileDiff, FsNode, Project } from "../../../../shared/types";
import { Diff } from "../../components/Diff";
import { Seg } from "../../components/ui";
import { api, fileUrl } from "../../lib/api";
import { dayLabel, hm, kb, plural, usd, when } from "../../lib/format";
import { go } from "../../lib/router";
import { useFetch } from "../../lib/useFetch";
import { DataTab } from "./DataTab";

// Routes: files[/<turnId>[/<path>]] · files/workspace[/<path>] · files/projects[/<path>] · files/tables
const VIEWS = [["changes", "Changes", "Every file a run changed, however it changed it. Newest first."], ["workspace", "Workspace", "Its own files."],
  ["projects", "Code projects", "Folders in its workspace that hold code, read-only."], ["tables", "Tables", "The small databases it keeps for recurring work, and the dashboards built on them."]] as const;

export function FilesTab({ b, rest }: { b: BotCard; rest: (string | undefined)[] }) {
  const mode = VIEWS.find(([k]) => k !== "changes" && k === rest[0])?.[0] || "changes";
  const runs = useFetch(() => api.get<ChangeRun[]>(`/api/bots/${b.id}/changes`), [b.id]);
  const base = `#/crew/${b.id}/files`;
  const [, title, intro] = VIEWS.find(([k]) => k === mode)!;
  return (
    <div className="fset">
      <div>
        <nav className="sn">{VIEWS.map(([k, l]) => <a key={k} className={mode === k ? "on" : ""} href={k === "changes" ? base : `${base}/${k}`}>{l}</a>)}</nav>
        <p className="moved">How-tos it has written now live under Memory.</p>
      </div>
      <div className="fc">
        <div className="tabhead"><h2>{title}</h2><p className="intro">{intro}</p></div>
        {mode === "projects" ? <Projects key={rest[1] || ""} b={b} encPath={rest[1]} />
          : mode === "workspace" ? <Workspace b={b} runs={runs.data || []} path={rest[1] ? decodeURIComponent(rest[1]) : ""} />
          : mode === "tables" ? <DataTab b={b} />
          : <Changes b={b} runs={runs.data} error={runs.error} turnId={rest[0]} path={rest[1] ? decodeURIComponent(rest[1]) : ""} />}
      </div>
    </div>
  );
}

const chip = (status: string) => (status === "added" ? ["ok", "New"] : status === "deleted" ? ["bad", "Deleted"] : ["blue", "Edited"]);
const Delta = ({ n }: { n: number }) => (n ? <span className={n > 0 ? "plus" : "minus"}>{n > 0 ? `+${n}` : `−${-n}`}</span> : null);
const net = (cs: FileChange[]) => cs.reduce((a, c) => { const l = c.lines || 0; return l > 0 ? [a[0] + l, a[1]] : [a[0], a[1] - l]; }, [0, 0]);
export function Tally({ cs }: { cs: FileChange[] }) {
  const [add, del] = net(cs);
  return <>{add ? <span className="plus">{`+${add}`}</span> : null}{del ? <span className="minus">{`−${del}`}</span> : null}</>;
}
const split = (p: string) => { const i = p.lastIndexOf("/"); return [i < 0 ? "" : p.slice(0, i + 1), p.slice(i + 1)]; };
const Path = ({ p }: { p: string }) => { const [dir, name] = split(p); return <span className="pc-m small trunc"><span className="faint">{dir}</span>{name}</span>; };

// Each day once (a Map, so a run that arrives out of order still joins its day), then that day's runs.
function byDay(runs: ChangeRun[]) {
  const days = new Map<string, ChangeRun[]>();
  for (const r of runs) { const d = dayLabel(r.started_at); days.set(d, [...(days.get(d) || []), r]); }
  return [...days];
}

let splitPref = false; // kept across runs for the session
function Changes({ b, runs, error, turnId, path }: { b: BotCard; runs: ChangeRun[] | null; error: string | null; turnId?: string; path: string }) {
  const [split, setSplit] = useState(splitPref);
  const [open, setOpen] = useState<Set<string>>(() => new Set(turnId ? [turnId] : []));
  useEffect(() => { if (runs?.length && !turnId) setOpen((s) => (s.size ? s : new Set([runs[0].id]))); }, [runs, turnId]);
  if (error && !runs) return <p className="badc">{error}</p>;
  if (!runs) return null;
  if (!runs.length) return <p className="none">No changes yet. Every run's file changes land here, whether made by a patch, a command or a script.</p>;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const onSplit = (v: boolean) => { splitPref = v; setSplit(v); };
  return (
    <div className="changes2">
      {turnId && !runs.some((r) => r.id === turnId) && <p className="none">That run is older than the 40 kept here.</p>}
      {byDay(runs).map(([day, rs]) => (
        <div key={day}>
          <p className="grp">{day}</p>
          {rs.map((r) => <Run key={r.id} b={b} r={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} path={r.id === turnId ? path : ""} split={split} onSplit={onSplit} />)}
        </div>))}
      <p className="foot">Changes from the last 40 runs are kept here. Older files are still in Workspace.</p>
    </div>
  );
}

function Run({ b, r, open, onToggle, path, split, onSplit }: { b: BotCard; r: ChangeRun; open: boolean; onToggle: () => void; path: string; split: boolean; onSplit: (v: boolean) => void }) {
  const [file, setFile] = useState<string | null>(path || r.changes[0]?.path || null);
  const [add, del] = net(r.changes);
  return (
    <div className="run">
      <div className="runh">
        <button className="rt" onClick={onToggle} aria-expanded={open}>
          <span className={`rc${open ? " on" : ""}`} />
          <span className="mn"><span className="t">{r.thread_title}</span>
            <span className="m">{`${hm(r.started_at)} · ${plural(r.changes.length, "file")}${add || del ? " · " : ""}`}<Tally cs={r.changes} />{r.cost_usd ? ` · ${usd(r.cost_usd)}` : ""}</span></span>
        </button>
        <a className="lk2" href={`#/t/${r.thread_id}`}>Open thread</a>
      </div>
      {open && r.changes.map((c) => <FileRow key={c.path} b={b} turnId={r.id} c={c} open={file === c.path} focus={c.path === path} onToggle={() => setFile(file === c.path ? null : c.path)} split={split} onSplit={onSplit} />)}
    </div>
  );
}

// While a file's diff is open, the +/− comes from that diff alone, so the row hides its own count.
function FileRow({ b, turnId, c, open, focus, onToggle, split, onSplit }: { b: BotCard; turnId: string; c: FileChange; open: boolean; focus: boolean; onToggle: () => void; split: boolean; onSplit: (v: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "start" }); }, [focus]);
  const gone = c.status === "deleted", word = c.status === "added" ? "new" : gone ? "deleted" : "";
  return (
    <div ref={ref} className="fl2">
      <button className="flh" onClick={onToggle} aria-expanded={open}>
        <span className={`n${gone ? " gone" : ""}`}><Path p={c.path} /></span>
        <span className="c">{word}{!open && c.lines ? <>{word ? " · " : ""}<Delta n={c.lines} /></> : null}</span>
      </button>
      {open && <div className="dbox">
        <div className="dh"><span className="trunc">{c.path}</span>
          <span className="acts">{!gone && <><a className="lk2" href={`#/crew/${b.id}/files/workspace/${encodeURIComponent(c.path)}`}>Open in workspace</a><a className="lk2" href={fileUrl(b.id, c.path)}>Download</a></>}
            <Seg options={[["unified", "Unified"], ["split", "Split"]] as const} value={split ? "split" : "unified"} onChange={(m) => onSplit(m === "split")} /></span></div>
        <RunDiff turnId={turnId} path={c.path} split={split} />
      </div>}
    </div>
  );
}

export function FileBlock({ b, turnId, c, open, focus, split, onToggle }: { b: BotCard; turnId: string; c: FileChange; open: boolean; focus: boolean; split: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "start" }); }, [focus]);
  const [tone, label] = chip(c.status);
  return (
    <div ref={ref} className="fd">
      <div className="fdh">
        <button className="fdt" onClick={onToggle}><span className={`chev ${open ? "" : "r"}`} /><span className={`pc-chip ${tone}`}>{label}</span><span className={c.status === "deleted" ? "gone" : ""}><Path p={c.path} /></span><span className="pc-m small"><Delta n={c.lines || 0} /></span></button>
        {c.status !== "deleted" && <><a className="small lk" href={`#/crew/${b.id}/files/workspace/${encodeURIComponent(c.path)}`}>Open in workspace</a><a className="small lk" href={fileUrl(b.id, c.path)}>Download</a></>}
      </div>
      {open && <RunDiff turnId={turnId} path={c.path} split={split} />}
    </div>
  );
}

function RunDiff({ turnId, path, split }: { turnId: string; path: string; split: boolean }) {
  const { data: d, error } = useFetch(() => api.get<FileDiff>(`/api/turns/${turnId}/diff?path=${encodeURIComponent(path)}`, { quiet: true }), [turnId, path]);
  if (!d && !error) return <p className="empty">Loading…</p>;
  return !d ? <p className="empty">Couldn't load this change.</p>
    : !d.text ? <p className="empty">{`Binary file ${d.status}. ${kb(d.size || 0)}.`}</p>
    : <Diff before={d.beforeText} after={d.afterText} split={split} />;
}

// ---------- workspace ----------
function Workspace({ b, runs, path }: { b: BotCard; runs: ChangeRun[]; path: string }) {
  // Newest run that touched each path, from the runs already loaded for Changes.
  const touched = new Map<string, ChangeRun>();
  for (const r of runs) for (const c of r.changes) if (!touched.has(c.path)) touched.set(c.path, r);
  const open = (p: string) => go(`#/crew/${b.id}/files/workspace/${encodeURIComponent(p)}`);
  return (
    <div className="files">
      <aside className="rail tree"><Dir b={b} rel="" depth={0} selected={path} touched={touched} onFile={open} /></aside>
      <div className="pc-card tight viewer">{path ? <FileView key={path} b={b} path={path} by={touched.get(path)} /> : <p className="empty">Pick a file to view it.</p>}</div>
    </div>
  );
}

type TreeProps = { b: BotCard; rel: string; depth: number; selected: string; touched: Map<string, ChangeRun>; onFile: (p: string) => void };
function Dir({ b, rel, depth, selected, touched, onFile }: TreeProps) {
  const { data } = useFetch(() => api.get<FsNode>(`/api/bots/${b.id}/fs?path=${encodeURIComponent(rel)}`, { quiet: true }), [b.id, rel]);
  if (!data || data.type !== "dir") return null;
  const dot = (n: string) => n.startsWith(".");
  const entries = [...data.entries].sort((x, y) => Number(dot(x.name)) - Number(dot(y.name)));
  return <>{entries.map((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name, pad = { paddingLeft: 8 + depth * 14 }, t = touched.get(p);
    return e.dir ? <Folder key={p} b={b} rel={p} name={e.name} depth={depth} selected={selected} touched={touched} onFile={onFile} />
      : <button key={p} className={`tf ${p === selected ? "on" : ""} ${dot(e.name) ? "dim" : ""}`} style={pad} onClick={() => onFile(p)}><span className="trunc">{e.name}</span>{t && <span className="ch">{`changed ${dayLabel(t.started_at) === "Today" ? hm(t.started_at) : when(t.started_at)}`}</span>}</button>;
  })}</>;
}

function Folder({ name, depth, ...rest }: TreeProps & { name: string }) {
  const [open, setOpen] = useState(() => rest.selected.startsWith(`${rest.rel}/`)); // the path to a deep-linked file starts open
  return (
    <div>
      <button className={`tf dir ${open ? "open" : ""} ${name.startsWith(".") ? "dim" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>{name}</button>
      {open && <div><Dir depth={depth + 1} {...rest} /></div>}
    </div>
  );
}

function FileView({ b, path, by }: { b: BotCard; path: string; by?: ChangeRun }) {
  const { data: f, error } = useFetch(() => api.get<FsNode>(`/api/bots/${b.id}/fs?path=${encodeURIComponent(path)}`), [b.id, path]);
  if (!f && !error) return null;
  const url = fileUrl(b.id, path);
  const file = f?.type === "file" ? f : null;
  return (
    <>
      <div className="vhead">
        <Path p={path} />
        {file && <span className="pc-m small faint">{`${kb(file.size)}${file.text != null ? ` · ${plural(file.text.split("\n").length, "line")}` : ""}`}</span>}
        <span style={{ flex: 1 }} />
        {by && <span className="pc-m small faint">{`last changed ${when(by.started_at)} by `}<a className="lk" href={`#/crew/${b.id}/files/${by.id}/${encodeURIComponent(path)}`}>{by.thread_title}</a></span>}
        <a className="pc-pill o s" href={url}>Download</a>
      </div>
      {!file ? <p className="empty">Not found.</p>
        : file.image ? <div style={{ padding: 16 }}><img src={`${url}?inline=1`} style={{ maxWidth: "100%", borderRadius: 10 }} /></div>
        : file.text != null ? <div className="code">{file.text.split("\n").map((l, i) => <div key={i} className="dl"><span className="ln">{String(i + 1)}</span><code>{l}</code></div>)}</div>
        : <p className="empty">Binary or large file. Download it to open.</p>}
    </>
  );
}

// ---------- projects ----------
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
        <span className="small faint">Read-only</span>
        {opened.error ? <span className="small badc">{opened.error}</span> : !opened.data && <span className="small faint">Starting the code view…</span>}
        <span style={{ flex: 1 }} />
        {opened.data && <a className="small" href={opened.data.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>}
      </div>
      <iframe className="codeview" sandbox="allow-scripts allow-popups allow-downloads" referrerPolicy="no-referrer" title={`${path}, read-only`} src={opened.data?.url} />
    </div>
  );
}
