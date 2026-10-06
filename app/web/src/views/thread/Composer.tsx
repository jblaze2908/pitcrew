// The thread composer: steer or queue while a run goes, attachments by picker or paste, Stop, / commands.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedItem } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { attachmentName, isImagePath } from "../../lib/images";
import { go } from "../../lib/router";
import { ContextRing, ModePicker, QueuedStack } from "./ComposerParts";

interface Attachment { path: string; name: string; preview: string | null }

// Typed alone in the composer, these act on the thread instead of being sent to the crew member.
interface Command { name: string; hint: string; when: "idle" | "running" | "any"; run: (threadId: string) => Promise<unknown> }
const COMMANDS: Command[] = [
  { name: "refresh", hint: "Reload tools and skills with your next message. That message costs a little more.", when: "idle", run: (id) => api.post(`/api/threads/${id}/refresh`) },
  { name: "compact", hint: "Summarise this thread to free up context.", when: "idle", run: (id) => api.post(`/api/threads/${id}/compact`) },
  { name: "fresh", hint: "Start a new thread from this one's last reply.", when: "any", run: async (id) => { const r = await api.post<{ id: string }>(`/api/threads/${id}/fresh`); go(`#/t/${r.id}`); } },
  { name: "stop", hint: "Stop the run in progress.", when: "running", run: (id) => api.post(`/api/threads/${id}/interrupt`) },
];

/** The image the next message edits: the newest one by default (Thread.tsx), or one the driver picked. */
interface EditTarget { path: string; label: string; src: string }
interface ComposerProps {
  threadId: string; name: string; running: boolean; queued: QueuedItem[]; fromName: string; target?: EditTarget | null; onClearTarget?: () => void;
  autonomy: string; onAutonomy: (a: string) => void; ctx: { tokens: number | null; window: number | null };
  /** The side question panel (SideAsk): open, and its toggle (also ⌘; from Thread). */
  side?: boolean; onSide?: () => void;
}
const SIDE_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘;" : "Ctrl ;";
export function Composer({ threadId, name, running, queued, fromName, target, onClearTarget, autonomy, onAutonomy, ctx, side, onSide }: ComposerProps) {
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
      setAtts((list) => [...list, { path: r.path, name: f.name, preview: isImagePath(f.name) ? URL.createObjectURL(f) : null }]);
    }
  };
  // Edit pulls the message back into the box (ahead of any draft); sending it again re-queues or delivers it.
  const edit = async (q: QueuedItem) => {
    await api.del(`/api/threads/${threadId}/queue/${q.id}`);
    setText((t) => (t.trim() ? `${q.text}\n${t}` : q.text));
    setAtts((list) => [...list, ...q.attachments.filter((p) => !list.some((a) => a.path === p)).map((p) => ({ path: p, name: attachmentName(p), preview: null }))]);
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
          {onSide && <button className={`chipb${side ? " on" : ""}`} aria-pressed={!!side} title={`Ask ${name} something without steering it or adding to the thread (${SIDE_KEY})`} onClick={onSide}>Side question <kbd>{SIDE_KEY}</kbd></button>}
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
