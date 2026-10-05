import { useEffect, useRef, useState } from "react";
import type { BotCard, ChangeRun, FileChange, FileDiff, FsNode, Project } from "../../../../shared/types";
import { Diff } from "../../components/Diff";
import { Seg } from "../../components/ui";
import { api, fileUrl } from "../../lib/api";
import { dayLabel, hm, kb, plural, usd, when } from "../../lib/format";
import { go } from "../../lib/router";
import { useFetch } from "../../lib/useFetch";

// Routes: files[/<turnId>[/<path>]] · files/workspace[/<path>] · files/projects[/<path>]
export function FilesTab({ b, rest }: { b: BotCard; rest: (string | undefined)[] }) {
  const mode = rest[0] === "projects" ? "projects" : rest[0] === "workspace" ? "workspace" : "changes";
  const runs = useFetch(() => api.get<ChangeRun[]>(`/api/bots/${b.id}/changes`), [b.id]);
  const base = `#/crew/${b.id}/files`;
  return (
    <div className="col">
      <div className="row">
        <div className="seg">
          <a className={mode === "changes" ? "on" : ""} href={base}>Changes{runs.data?.length ? <em>{runs.data.length}</em> : null}</a>
          <a className={mode === "workspace" ? "on" : ""} href={`${base}/workspace`}>Workspace</a>
          <a className={mode === "projects" ? "on" : ""} href={`${base}/projects`}>Projects</a>
        </div>
        <span style={{ flex: 1 }} />
        <span className="small faint">{mode === "changes" ? "Every run's file changes, however they were made" : mode === "workspace" ? "Its own files" : ""}</span>
      </div>
      {mode === "projects" ? <Projects key={rest[1] || ""} b={b} encPath={rest[1]} />
        : mode === "workspace" ? <Workspace b={b} runs={runs.data || []} path={rest[1] ? decodeURIComponent(rest[1]) : ""} />
        : <Changes b={b} runs={runs.data} error={runs.error} turnId={rest[0]} path={rest[1] ? decodeURIComponent(rest[1]) : ""} />}
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

// Day, then thread: repeat runs of one thread nest as time rows instead of repeating its title.
function group(runs: ChangeRun[]) {
  const days: { day: string; threads: { id: string; title: string; runs: ChangeRun[] }[]; n: number }[] = [];
  for (const r of runs) {
    const day = dayLabel(r.started_at);
    let d = days.at(-1);
    if (d?.day !== day) days.push((d = { day, threads: [], n: 0 }));
    d.n++;
    const t = d.threads.find((x) => x.id === r.thread_id);
    t ? t.runs.push(r) : d.threads.push({ id: r.thread_id, title: r.thread_title, runs: [r] });
  }
  return days;
}

function Changes({ b, runs, error, turnId, path }: { b: BotCard; runs: ChangeRun[] | null; error: string | null; turnId?: string; path: string }) {
  if (error && !runs) return <p className="badc">{error}</p>;
  if (!runs) return null;
  if (!runs.length) return <div className="pc-card"><p className="empty">No changes recorded yet. Every run's file changes land here, whether made by a patch, a command or a script.</p></div>;
  const run = turnId ? runs.find((r) => r.id === turnId) : runs[0];
  const open = (id: string) => go(`#/crew/${b.id}/files/${id}`);
  return (
    <div className="files">
      <aside className="rail">
        {group(runs).map((d) => (
          <div key={d.day}>
            <p className="day"><span>{d.day}</span><span>{plural(d.n, "run")}</span></p>
            {d.threads.map((t) => (
              <div key={t.id} className={`th ${t.runs.some((r) => r === run) ? "on" : ""}`}>
                {t.runs.length === 1
                  ? <button className="thb" onClick={() => open(t.runs[0].id)}><b>{t.title}</b><RunLine r={t.runs[0]} /></button>
                  : <><button className="thb" onClick={() => open(t.runs[0].id)}><b>{t.title}</b></button>
                    {t.runs.map((r) => <button key={r.id} className={`thr ${r === run ? "on" : ""}`} onClick={() => open(r.id)}><i />{<RunLine r={r} />}</button>)}</>}
              </div>))}
          </div>))}
      </aside>
      {run ? <RunView key={run.id} b={b} run={run} nth={runs.filter((r) => r.thread_id === run.thread_id).reverse().indexOf(run) + 1} of={runs.filter((r) => r.thread_id === run.thread_id).length} path={path} />
        : <div className="pc-card"><p className="empty">This run is older than the 40 kept here.</p></div>}
    </div>
  );
}
const RunLine = ({ r }: { r: ChangeRun }) => <span className="rn"><span className="t">{hm(r.started_at)}</span><span>{plural(r.changes.length, "file")}</span><Tally cs={r.changes} /></span>;

let splitPref = false; // kept across runs for the session
function RunView({ b, run, nth, of, path }: { b: BotCard; run: ChangeRun; nth: number; of: number; path: string }) {
  const [split, setSplit] = useState(splitPref);
  const [open, setOpen] = useState<Set<string>>(() => new Set([path || run.changes[0]?.path]));
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  return (
    <section className="col runview">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ gap: 4, minWidth: 0, flex: 1 }}>
          <p className="pc-h3 trunc">{run.thread_title}</p>
          <p className="pc-m small faint">{`run ${when(run.started_at)} · ${plural(run.changes.length, "file")} `}<Tally cs={run.changes} />{run.cost_usd ? ` · ${usd(run.cost_usd)}` : ""}{of > 1 ? ` · run ${nth} of ${of} in this thread` : ""}</p>
        </div>
        <a className="small lk" href={`#/t/${run.thread_id}`}>Open thread</a>
        <Seg options={[["unified", "Unified"], ["split", "Split"]] as const} value={split ? "split" : "unified"} onChange={(m) => { splitPref = m === "split"; setSplit(splitPref); }} />
        <button className="pc-pill o s" onClick={() => setOpen(open.size ? new Set() : new Set(run.changes.map((c) => c.path)))}>{open.size ? "Collapse all" : "Expand all"}</button>
      </div>
      {run.changes.map((c) => <FileBlock key={c.path} b={b} turnId={run.id} c={c} open={open.has(c.path)} focus={c.path === path} split={split} onToggle={() => toggle(c.path)} />)}
    </section>
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
        <span className="pc-chip ok">Read-only</span>
        {opened.error ? <span className="small badc">{opened.error}</span> : !opened.data && <span className="small faint">Starting the code view…</span>}
        <span style={{ flex: 1 }} />
        {opened.data && <a className="small" href={opened.data.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>}
      </div>
      <iframe className="codeview" sandbox="allow-scripts allow-popups allow-downloads" referrerPolicy="no-referrer" title={`${path}, read-only`} src={opened.data?.url} />
    </div>
  );
}
