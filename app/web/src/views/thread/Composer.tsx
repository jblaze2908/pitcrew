// The thread composer: steer or queue while a run goes, attachments by picker or paste, Stop.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Seg } from "../../components/ui";
import { api } from "../../lib/api";

interface Attachment { path: string; name: string; preview: string | null }
const isImg = (n: string) => /\.(png|jpe?g|webp|gif)$/i.test(n);

export function Composer({ threadId, name, running }: { threadId: string; name: string; running: boolean }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
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
  const remove = (a: Attachment) => { if (a.preview) URL.revokeObjectURL(a.preview); setAtts((list) => list.filter((x) => x !== a)); };
  const send = async () => {
    if (!text.trim() && !atts.length) return;
    setSending(true);
    try {
      await api.post(`/api/threads/${threadId}/messages`, { text, attachments: atts.map((a) => a.path), mode: running ? mode : "auto" });
      setText(""); atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)); setAtts([]);
    } finally { setSending(false); ta.current?.focus(); }
  };

  return (
    <div className="composer">
      <div className="box">
        <div className={`atts ${atts.length ? "" : "hidden"}`}>
          {atts.map((a) => (
            <div key={a.path} className={`att ${a.preview ? "img" : ""}`} title={a.name}>
              {a.preview ? <img src={a.preview} alt={a.name} /> : <span className="pc-m small">{a.name}</span>}
              <button className="x" title="Remove" onClick={() => remove(a)}>×</button>
            </div>))}
        </div>
        <textarea ref={ta} rows={1} placeholder={`Message ${name}…`} value={text} onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="bar">
          <button className="attach" title="Attach files or paste an image" onClick={() => file.current?.click()}>+ Attach</button>
          <input ref={file} type="file" className="hidden" multiple onChange={async (e) => { const input = e.currentTarget; await upload([...(input.files || [])]); input.value = ""; }} />
          <span className="small faint hint">Enter to send · Shift+Enter for a new line</span>
          <span style={{ flex: 1 }} />
          {running && <Seg options={[["steer", "Steer now"], ["queue", "Queue after"]] as const} value={mode} onChange={setMode} />}
          {running && <button className="pc-pill o s" onClick={() => api.post(`/api/threads/${threadId}/interrupt`)}>Stop</button>}
          <button className="pc-pill s" disabled={sending} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
