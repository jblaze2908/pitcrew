// Crew activity: everything done on your behalf, from the gate's own records (server: runtime/activity.ts). Filters by
// member, effect and who allowed it; "Older" pages back by cursor.
import { useEffect, useState } from "react";
import type { ActivityPage, ActivityRow } from "../../../../shared/types";
import { EffectChip, Face } from "../../components/ui";
import { api } from "../../lib/api";
import { plainWords, stamp } from "../../lib/format";
import { useLiveReload } from "../../lib/live";
import { useStore } from "../../lib/store";
import { useFetch } from "../../lib/useFetch";

// The gate's effect classes (jev.ts DEFAULT_POLICY); there is no "publish" class, so sharing stands for it.
const EFFECTS = [["send", "Sent"], ["pay", "Paid"], ["signin", "Signed in"], ["delete", "Deleted"], ["share", "Shared"], ["install", "Installed"]] as const;
const BY = [["", "Allowed by anyone"], ["once", "You · once"], ["always", "You · always"], ["autonomy", "Hands-free or YOLO"], ["learned", "Learned from you"], ["jev", "Safety check"], ["rules", "Policy or site list"]] as const;
const PAGE = 30;

export function Activity() {
  const { S, bot } = useStore();
  const [member, setMember] = useState(""), [effect, setEffect] = useState(""), [by, setBy] = useState("");
  const [older, setOlder] = useState<ActivityRow[]>([]), [next, setNext] = useState<string | null>(null);
  const qs = (before?: string | null) => new URLSearchParams({ limit: String(PAGE), ...(member ? { bot: member } : {}), ...(effect ? { effect } : {}), ...(by ? { by } : {}), ...(before ? { before } : {}) }).toString();
  const page = useFetch(() => api.get<ActivityPage>(`/api/activity?${qs()}`, { quiet: true }), [member, effect, by], { keep: true });
  useEffect(() => { setOlder([]); setNext(page.data?.next ?? null); }, [page.data]);
  // Pit stop answers and finished runs add rows; a page you scrolled back to stays put.
  useLiveReload((e) => older.length === 0 && (e.type === "pitstop" || e.type === "turn"), page.reload, 1500);
  const more = async () => { const p = await api.get<ActivityPage>(`/api/activity?${qs(next)}`); setOlder((l) => [...l, ...p.rows]); setNext(p.next); };
  const rows = [...(page.data?.rows || []), ...older], filtered = !!(member || effect || by);
  return (
    <section className="activity">
      <h2 className="pc-h2">Activity</h2>
      <p className="sub">Everything done on your behalf, across the crew</p>
      <div className="filters">
        <select className={`ch${member ? " on" : ""}`} value={member} onChange={(e) => setMember(e.target.value)} aria-label="Member">
          <option value="">All members</option>{S.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {EFFECTS.map(([k, l]) => <button key={k} className={`ch${effect === k ? " on" : ""}`} aria-pressed={effect === k} onClick={() => setEffect(effect === k ? "" : k)}>{l}</button>)}
        <select className={`ch${by ? " on" : ""}`} value={by} onChange={(e) => setBy(e.target.value)} aria-label="Allowed by">
          {BY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {page.data && (rows.length ? (
        <div className="lg">
          <div className="lh"><span>When</span><span>Member</span><span>Effect</span><span>What</span><span>Allowed by</span></div>
          {rows.map((r) => {
            const b = bot(r.botId), body = (
              <><span className="tm">{stamp(r.at)}</span><span className="who"><Face b={b} size="xs" mood="idle" /><span className="nm">{b?.name || "A former member"}</span></span>
                <span><EffectChip kind={r.effect} /></span>
                <span className="w" title={plainWords(r.what)}>{plainWords(r.what)}</span><span className="by"><b>{plainWords(r.by.who)}</b>{r.by.how ? ` · ${plainWords(r.by.how)}` : ""}</span></>);
            return r.threadId ? <a key={r.id} className="lr" href={`#/t/${r.threadId}`}>{body}</a> : <div key={r.id} className="lr">{body}</div>;
          })}
        </div>) : <p className="empty">{filtered ? "Nothing matches these filters." : "Nothing done on your behalf yet."}</p>)}
      <div className="foot">
        <span>Reads, browsing and drafts show only when you approved one.</span>
        {next && <button className="pc-pill o s" onClick={more}>Older</button>}
      </div>
    </section>
  );
}
