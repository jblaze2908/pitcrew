// The thread composer: steer or queue while a run goes, attachments by picker or paste, Stop, / commands.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedItem } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { BusyButton, Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { go } from "../../lib/router";
import { toast } from "../../lib/toast";

interface Attachment { path: string; name: string; preview: string | null }
const isImg = (n: string) => /\.(png|jpe?g|webp|gif)$/i.test(n);

// Typed alone in the composer, these act on the thread instead of being sent to the crew member.
interface Command { name: string; hint: string; when: "idle" | "running" | "any"; run: (threadId: string) => Promise<unknown> }
const COMMANDS: Command[] = [
  { name: "refresh", hint: "Reload tools and skills from Engram with your next message. That message misses the prompt cache.", when: "idle", run: (id) => api.post(`/api/threads/${id}/refresh`) },
  { name: "compact", hint: "Summarise this thread to free up context.", when: "idle", run: (id) => api.post(`/api/threads/${id}/compact`) },
  { name: "fresh", hint: "Start a new thread from this one's last reply.", when: "any", run: async (id) => { const r = await api.post<{ id: string }>(`/api/threads/${id}/fresh`); go(`#/t/${r.id}`); } },
  { name: "stop", hint: "Stop the run in progress.", when: "running", run: (id) => api.post(`/api/threads/${id}/interrupt`) },
];

const viaLabel = (via: string, fromName: string) => via === "schedule" ? "Scheduled" : via === "plan" || via === "resume" ? "Pitcrew" : via === "delegation" ? `${fromName} asks` : "Queued";
const fileName = (p: string) => p.split("/").pop()!.replace(/^[a-z0-9]+-/, "");

/** Messages waiting for the run to end, Claude Code style: they join the transcript only when they go to the member. */
function QueuedStack({ threadId, queued, fromName, onEdit }: { threadId: string; queued: QueuedItem[]; fromName: string; onEdit: (q: QueuedItem) => Promise<void> }) {
  if (!queued.length) return null;
  return (
    <div className="queued">
      {queued.map((q) => (
        <div key={q.id} className="qi">
          <span className="lab">{viaLabel(q.via, fromName)}</span>
          <span className="txt" title={q.display || q.text}>{q.display || q.text}</span>
          {q.attachments.length > 0 && <span className="n" title={q.attachments.map(fileName).join(", ")}>{`+${q.attachments.length} file${q.attachments.length > 1 ? "s" : ""}`}</span>}
          <span className="acts">
            <BusyButton onClick={() => api.post(`/api/threads/${threadId}/queue/${q.id}/send-now`)}>Send now</BusyButton>
            <BusyButton onClick={() => onEdit(q)}>Edit</BusyButton>
            <BusyButton className="x" onClick={() => api.del(`/api/threads/${threadId}/queue/${q.id}`)}>×</BusyButton>
          </span>
        </div>))}
    </div>
  );
}

// How much this thread runs without pit stops (server: runtime/autonomy.ts). YOLO is drawn in the bad tone so it's
// never on by accident or forgotten.
export const AUTONOMY = [
  ["ask", "Ask me", "Asks before sending, paying, signing in, installing, sharing, deleting or a new site."],
  ["handsfree", "Hands-free", "Stops only for paying, signing in, sending, sharing, deleting, look-alike or non-https sites, and your don'ts."],
  ["yolo", "YOLO", "No pit stops, paying and sending included. Only hard blocks, blocked sites and your don'ts stop it."],
] as const;

function ModePicker({ threadId, value, onChange }: { threadId: string; value: string; onChange: (a: string) => void }) {
  const [open, setOpen] = useState(false);
  const cur = AUTONOMY.find(([k]) => k === value) || AUTONOMY[0];
  const set = async (a: string) => {
    setOpen(false);
    if (a === value) return;
    await api.patch(`/api/threads/${threadId}`, { autonomy: a });
    onChange(a); toast(AUTONOMY.find(([k]) => k === a)![1]);
  };
  return (
    <span className="modepick">
      <button className={`chipb mode-${cur[0]}`} title="Pit stops for this thread" aria-expanded={open} onClick={() => setOpen(!open)}><i className="d7" />{cur[1]}<Icon name="chev" size={13} /></button>
      {open && <>
        <div className="scrim" onClick={() => setOpen(false)} />
        <div className="menu modes" role="menu">
          {AUTONOMY.map(([k, label, tip]) => (
            <button key={k} role="menuitemradio" aria-checked={k === value} className={`op mode-${k} ${k === value ? "on" : ""}`} onClick={() => set(k)}>
              <i className="d7" /><span><b>{label}</b><small>{tip}</small></span>{k === value && <Icon name="check" />}
            </button>))}
          <p className="ft">This thread only</p>
        </div>
      </>}
    </span>);
}

/** Context used, as a ring; click compacts the thread (same as /compact). */
function ContextRing({ threadId, ctx, running }: { threadId: string; ctx: { tokens: number | null; window: number | null }; running: boolean }) {
  if (!ctx.tokens || !ctx.window) return null;
  const pct = Math.min(100, (ctx.tokens / ctx.window) * 100), c = 2 * Math.PI * 6;
  return (
    <button className={`ring ${pct > 70 ? "hot" : ""}`} disabled={running} title={`${Math.round(ctx.tokens / 1000)}k of ${Math.round(ctx.window / 1000)}k tokens · click to compact`}
      onClick={async () => { await api.post(`/api/threads/${threadId}/compact`); toast("Compacting the thread"); }}>
      <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--surface-3)" strokeWidth="2.2" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" /></svg>
      {`${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.window / 1000)}k`}
    </button>);
}

/** The image the next message edits: the newest one by default (Thread.tsx), or one the driver picked. */
export interface EditTarget { path: string; label: string; src: string }
interface ComposerProps {
  threadId: string; name: string; running: boolean; queued: QueuedItem[]; fromName: string; target?: EditTarget | null; onClearTarget?: () => void;
  autonomy: string; onAutonomy: (a: string) => void; ctx: { tokens: number | null; window: number | null };
}
export function Composer({ threadId, name, running, queued, fromName, target, onClearTarget, autonomy, onAutonomy, ctx }: ComposerProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [menuAt, setMenuAt] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(220, el.scrollHeight)}px`; } }, [text]);
  // Previews are object URLs; free whatever is left when the thread closes.
  const attsRef = useRef(atts);
  attsRef.current = atts;
  useEffect(() => () => attsRef.current.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)), []);

  const upload = async (files: File[]) => {
    for (const f of files) {
      const r = await api.post<{ path: string }>(`/api/threads/${threadId}/upload?name=${encodeURIComponent(f.name)}`, f, { raw: true });
      setAtts((list) => [...list, { path: r.path, name: f.name, preview: isImg(f.name) ? URL.createObjectURL(f) : null }]);
    }
  };
  // Edit pulls the message back into the box (ahead of any draft); sending it again re-queues or delivers it.
  const edit = async (q: QueuedItem) => {
    await api.del(`/api/threads/${threadId}/queue/${q.id}`);
    setText((t) => (t.trim() ? `${q.text}\n${t}` : q.text));
    setAtts((list) => [...list, ...q.attachments.filter((p) => !list.some((a) => a.path === p)).map((p) => ({ path: p, name: fileName(p), preview: null }))]);
    ta.current?.focus();
  };
  const remove = (a: Attachment) => { if (a.preview) URL.revokeObjectURL(a.preview); setAtts((list) => list.filter((x) => x !== a)); };
  const slash = /^\/(\S*)$/.exec(text);
  const cmds = slash && dismissed !== text ? COMMANDS.filter((c) => c.name.startsWith(slash[1].toLowerCase()) && (c.when === "any" || (c.when === "running") === running)) : [];
  const at = Math.min(menuAt, Math.max(0, cmds.length - 1));
  const runCmd = async (c: Command) => {
    setSending(true);
    try { await c.run(threadId); setText(""); } finally { setSending(false); ta.current?.focus(); }
  };
  const send = async () => {
    if (!text.trim() && !atts.length) return;
    const typed = !atts.length && COMMANDS.find((c) => `/${c.name}` === text.trim());
    if (typed) return runCmd(typed);
    setSending(true);
    try {
      await api.post(`/api/threads/${threadId}/messages`, { text, attachments: atts.map((a) => a.path), mode: running ? mode : "auto", ...(target ? { edit: { image: target.path } } : {}) });
      if (target) onClearTarget?.();
      setText(""); atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)); setAtts([]);
    } finally { setSending(false); ta.current?.focus(); }
  };

  return (
    <div className="composer">
      <QueuedStack threadId={threadId} queued={queued} fromName={fromName} onEdit={edit} />
      <div className="box">
        {cmds.length > 0 && (
          <div className="menu cmds">
            {cmds.map((c, i) => (
              <button key={c.name} className={`mi${i === at ? " on" : ""}`} onMouseEnter={() => setMenuAt(i)} onMouseDown={(e) => { e.preventDefault(); runCmd(c); }}>
                <span className="dot">/</span>
                <span className="col" style={{ gap: 2, minWidth: 0, textAlign: "left" }}><b>/{c.name}</b><span className="small faint">{c.hint}</span></span>
              </button>))}
          </div>)}
        {target && <div className="editing"><span className="pc-chip blue">Editing</span><img src={target.src} alt="" /><span className="small">{target.label}</span>
          <span className="small faint">your next message changes this image</span><span style={{ flex: 1 }} /><button className="x" title="Not an edit" onClick={onClearTarget}>×</button></div>}
        <div className={`atts ${atts.length ? "" : "hidden"}`}>
          {atts.map((a) => (
            <div key={a.path} className={`att ${a.preview ? "img" : ""}`} title={a.name}>
              {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="pc-m small">{a.name}</span>}
              <button className="x" title="Remove" onClick={() => remove(a)}>×</button>
            </div>))}
        </div>
        <textarea ref={ta} rows={1} placeholder={`Message ${name}…`} value={text} onChange={(e) => { setText(e.target.value); setMenuAt(0); }}
          onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } }}
          onKeyDown={(e) => {
            if (cmds.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMenuAt((at + (e.key === "ArrowDown" ? 1 : cmds.length - 1)) % cmds.length); return; }
              if (e.key === "Tab") { e.preventDefault(); setText(`/${cmds[at].name}`); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runCmd(cmds[at]); return; }
              if (e.key === "Escape") { e.preventDefault(); setDismissed(text); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }} />
        <div className="bar">
          <button className="chipb" title="Attach files or paste an image" onClick={() => file.current?.click()}><Icon name="attach" size={14} />Attach</button>
          <input ref={file} type="file" className="hidden" multiple onChange={async (e) => { const input = e.currentTarget; await upload([...(input.files || [])]); input.value = ""; }} />
          <ModePicker threadId={threadId} value={autonomy} onChange={onAutonomy} />
          <span style={{ flex: 1 }} />
          {running && <Seg options={[["steer", "Steer now"], ["queue", "Queue after"]] as const} value={mode} onChange={setMode} />}
          <ContextRing threadId={threadId} ctx={ctx} running={running} />
          {running && <button className="roundb stop" title="Stop the run" onClick={() => api.post(`/api/threads/${threadId}/interrupt`)}><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg></button>}
          <button className="roundb" title="Send (Enter)" disabled={sending} onClick={send}><Icon name="up" /></button>
        </div>
      </div>
    </div>
  );
}
