// Side question (⌘;): ask what the member is doing without steering it. Answers come from the thread's record on a
// tool-less ChatGPT plan ask (server: runtime/side.ts) and live only in this panel: closing it forgets them.
import { useEffect, useRef, useState } from "react";
import { Face, Loader } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";

interface Turn { q: string; a?: string; error?: string }
interface Looks { name: string; hue?: string; shape?: string }

export function SideAsk({ threadId, b, running, onClose }: { threadId: string; b: Looks; running: boolean; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), body = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [turns]);
  const ask = async () => {
    const q = text.trim();
    if (!q || busy) return;
    // Earlier answers ride along so a follow-up ("is that counted?") has its referent; the server keeps none of it.
    const history = turns.filter((t) => t.a).slice(-4).map((t) => ({ q: t.q, a: t.a! }));
    setText(""); setBusy(true); setTurns((l) => [...l, { q }]);
    try {
      const r = await api.post<{ answer: string }>(`/api/threads/${threadId}/side`, { question: q, history }, { quiet: true });
      setTurns((l) => l.map((t, i) => (i === l.length - 1 ? { ...t, a: r.answer } : t)));
    } catch (e) {
      setTurns((l) => l.map((t, i) => (i === l.length - 1 ? { ...t, error: (e as Error).message } : t)));
    } finally { setBusy(false); input.current?.focus(); }
  };
  return (
    <aside className="btw" aria-label="Side question">
      <div className="bh">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="ic"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></svg>
        <b>Side question</b><small>· not added to the thread</small>
        <button className="x" title="Close (Esc) · forgets these answers" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <div ref={body} className="bb">
        {!turns.length && <p className="hint">{`Ask ${b.name} what it's doing, what it found or what's next. It won't see the question or change course.`}</p>}
        {turns.map((t, i) => (
          <div key={i} className="pair">
            <div className="bq">{t.q}</div>
            <div className="ba"><Face b={b} size="xs" mood="idle" />{t.a ? <div>{t.a}</div> : t.error ? <div className="err0">{t.error}</div> : <Loader />}</div>
          </div>))}
      </div>
      <div className="bi">
        <textarea ref={input} rows={1} placeholder="Ask without steering…" value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } if (e.key === "Escape") { e.preventDefault(); onClose(); } }} />
      </div>
      <p className="bf"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>
        {`Answers from what it has done so far. Gone when you close it${running ? ` · ${b.name} keeps working` : ""}`}</p>
    </aside>
  );
}
