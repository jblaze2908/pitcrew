// Rewind a finished run (H6): Copy and Rewind under the member's reply, a menu of what to take back, then a confirm sheet
// listing exactly what changes back before anything happens (runtime/rewind.ts does it, and audits it).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RewindPlan } from "../../../../shared/types";
import { Icon } from "../../components/Icon";
import { BusyButton } from "../../components/ui";
import { api } from "../../lib/api";
import { hm } from "../../lib/format";
import { toast } from "../../lib/toast";

type Mode = RewindPlan["mode"];
const REWIND_ICON = '<path d="M3 7a5 5 0 115 5"/><path d="M3 3v4h4"/>';
const Svg = ({ d, size = 13 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />;
const MODES: { mode: Mode; label: string; sub: string; icon: string }[] = [
  { mode: "both", label: "Rewind files and chat", sub: "back to before you sent this message", icon: REWIND_ICON },
  { mode: "chat", label: "Rewind chat only", sub: "files stay as they are now", icon: '<path d="M3 4h10M3 8h10M3 12h6"/>' },
  { mode: "files", label: "Rewind files only", sub: "keep the conversation", icon: '<path d="M4 2.5h5l3 3V13.5H4z"/>' },
];
const HINT = { A: "comes back", D: "removed: this run made it", M: "older version" } as const;

/** Copy and Rewind under a finished run's reply. */
export function ReplyActions({ text, turnId, name, onRewound }: { text: string; turnId: string; name: string; onRewound: () => void }) {
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<Mode | null>(null);
  const copy = () => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => {});
  return (
    <div className="acts-row">
      <button className="act" onClick={copy}><Svg d='<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3h8"/>' />Copy</button>
      <span className="rw-anchor">
        <button className={`act${menu ? " on" : ""}`} aria-expanded={menu} onClick={() => setMenu(!menu)}><Svg d={REWIND_ICON} />Rewind</button>
        {menu && <>
          <div className="scrim" onClick={() => setMenu(false)} />
          <div className="menu modes rw-menu" role="menu">{MODES.map((m) => (
            <button key={m.mode} className="op" role="menuitem" onClick={() => { setMenu(false); setSheet(m.mode); }}>
              <Svg d={m.icon} size={14} /><span><b>{m.label}</b><small>{m.sub}</small></span>
            </button>))}
          </div>
        </>}
      </span>
      {/* Portalled: the stream's mask would otherwise fade and clip a fixed overlay inside it. */}
      {sheet && createPortal(<RewindSheet turnId={turnId} mode={sheet} name={name} onClose={() => setSheet(null)} onDone={() => { setSheet(null); onRewound(); }} />, document.body)}
    </div>
  );
}

function RewindSheet({ turnId, mode, name, onClose, onDone }: { turnId: string; mode: Mode; name: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState<RewindPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<RewindPlan>(`/api/turns/${turnId}/rewind?mode=${mode}`, { quiet: true }).then(setP, (e) => setError(e.message)); }, [turnId, mode]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const label = MODES.find((m) => m.mode === mode)!.label;
  const go = async () => { const r = await api.post<{ restored: string[]; failed: unknown[] }>(`/api/turns/${turnId}/rewind`, { mode }); toast(r.failed.length ? `Rewound; ${r.failed.length} file${r.failed.length === 1 ? "" : "s"} couldn't change back` : "Rewound"); onDone(); };
  const back = p?.files.filter((f) => f.ok) || [], stuck = p?.files.filter((f) => !f.ok) || [];
  const blocked = !!p && mode !== "files" && p.rewound;
  return (
    <div className="rw-shade" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rw-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <h3>{`Rewind ${name} to ${p ? hm(p.at) : "…"}, before this run?`}</h3>
        {error && <p className="badc">{error}</p>}
        {p && <>
          {mode !== "chat" && <p>Pitcrew keeps a copy of the member's workspace before every run, so shell commands are covered too, not just edits.</p>}
          {mode !== "chat" && <div className="rw-grp">
            <div className="gh"><Icon name="folder" size={14} />Files in its workspace<small>{back.length ? `${back.length} change back` : "nothing to change back"}</small></div>
            {back.slice(0, 40).map((f) => <div key={f.path} className="fr"><span className={`k${f.kind}`}>{f.kind}</span><span className="pth">{f.path}</span><span className="hint">{HINT[f.kind]}</span></div>)}
            {back.length > 40 && <div className="fr"><span className="hint">{`and ${back.length - 40} more`}</span></div>}
            {stuck.map((f) => <div key={f.path} className="fr stuck"><span className="k">!</span><span className="pth">{f.path}</span><span className="hint">{`stays: ${f.why || "can't change back"}`}</span></div>)}
            {(p.otherThreads > 0 || p.partial) && <div className="fr note">{[p.otherThreads ? `Includes changes from ${p.otherThreads} other thread${p.otherThreads === 1 ? "" : "s"} of ${name} since then.` : "", p.partial ? "A run changed more files than Pitcrew lists (300); some may stay." : ""].filter(Boolean).join(" ")}</div>}
          </div>}
          {mode !== "files" && <div className="rw-grp">
            <div className="gh"><Svg d='<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>' size={14} />Conversation<small>{`${p.messages} message${p.messages === 1 ? "" : "s"} hidden`}</small></div>
            <div className="fr note">{`Your message and what followed move to "Rewound": still readable, no longer in ${name}'s context.`}</div>
          </div>}
          <p className="keep">{`Can't be undone outside Pitcrew: anything the run did on a website (sent, paid, posted) stays done. ${p.websites.length ? `This run used ${p.websites.join(", ")}.` : "This run touched no websites."}`}</p>
          {blocked && <p className="badc small">This run's chat was already rewound.</p>}
        </>}
        <div className="btns">
          <BusyButton className="pc-pill" busyLabel="Rewinding…" onClick={async () => { if (p && !blocked) await go(); }}>{label}</BusyButton>
          <button className="pc-pill o" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
