// Home's "Since you last looked": runs that finished while you were away, unread until you open their thread
// (server: runtime/inbox.ts). Quiet scheduled runs are listed but never count as new.
import type { Inbox, InboxItem } from "../../../../shared/types";
import { Face } from "../../components/ui";
import { api } from "../../lib/api";
import { sinceLabel } from "../../lib/format";
import { useLiveReload } from "../../lib/live";
import { useStore } from "../../lib/store";
import { useFetch } from "../../lib/useFetch";

const KIND: Record<InboxItem["kind"], string> = { scheduled: "Scheduled", delegation: "Delegation finished", run: "Run finished" };

export function Since() {
  const { refresh } = useStore();
  const box = useFetch(() => api.get<Inbox>("/api/inbox", { quiet: true }), [], { keep: true });
  // A run ending or a pit stop opening changes what's new or what waits on you.
  useLiveReload((e) => e.type === "turn" || e.type === "pitstop", box.reload, 800);
  if (!box.data) return <section className="since" />;
  const { items, unread } = box.data, oldest = items.filter((i) => i.unread).at(-1);
  const readAll = async () => { await api.post("/api/inbox/read"); box.reload(); refresh(); };
  return (
    <section className="since">
      <div className="hd">
        <div><h2 className="pc-h2">Since you last looked</h2><p className="sub">{unread && oldest ? `${unread} new since ${sinceLabel(oldest.endedAt)}` : "Nothing new"}</p></div>
        {unread > 0 && <button className="mark" onClick={readAll}>Mark all read</button>}
      </div>
      {items.length ? <div className="list">{items.map((i) => <Row key={i.turnId} i={i} />)}</div>
        : <p className="empty">Finished runs land here: scheduled checks, answers to the Chief, and anything that ended while you were away.</p>}
    </section>
  );
}

function Row({ i }: { i: InboxItem }) {
  const { bot } = useStore();
  const b = bot(i.botId);
  const sub = i.kind === "delegation" ? `asked by ${bot(i.fromBot)?.name || "another member"}` : i.sub;
  const meta = [i.kind !== "scheduled" && i.status === "failed" ? "Run failed" : KIND[i.kind], sinceLabel(i.endedAt), i.waiting ? "waiting on you" : ""].filter(Boolean).join(" · ");
  return (
    <a className={`it${i.unread ? "" : " read"}`} href={`#/t/${i.threadId}`} title={i.unread ? "New · opening the thread marks it read" : undefined}>
      <i className={`dot${i.unread ? "" : " r"}`} />
      <Face b={b} size="sm" mood="idle" />
      <div className="body">
        <p className="who"><b>{b?.name || "A former member"}</b>{sub && <span className="k">{` · ${sub}`}</span>}</p>
        <p className={`txt${i.status === "failed" ? " soft" : ""}`}>{i.status === "quiet" ? `QUIET: ${i.text}` : i.text}</p>
        <p className="t">{meta}</p>
      </div>
      <span className="k">›</span>
    </a>
  );
}
