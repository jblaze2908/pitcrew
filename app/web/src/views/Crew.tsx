// A crew member's page: header and tabs. Each tab lives in views/crew/.
import type { BotDetail } from "../../../shared/types";
import { RulesList, LearnedList } from "../components/Approvals";
import { SitesEditor } from "../components/SitesEditor";
import { Face } from "../components/ui";
import { api } from "../lib/api";
import { usd } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { ComputerTab } from "./crew/ComputerTab";
import { FilesTab } from "./crew/FilesTab";
import { DataTab } from "./crew/DataTab";
import { MemoryTab, SchedulesTab } from "./crew/Lists";
import { ProfileTab } from "./crew/ProfileTab";
import { ThreadsTab } from "./crew/ThreadsTab";

// Five tabs (Draft F11). The old tab names still open, folded into the tab that now holds them.
const TABS = ["threads", "files", "computer", "memory", "settings"];
const OLD: Record<string, string> = { schedules: "threads", data: "files", sites: "computer", profile: "settings", rules: "settings" };

export function Crew({ id, tab: asked, rest }: { id: string; tab: string; rest: (string | undefined)[] }) {
  const tab = OLD[asked] || asked;
  const { bot } = useStore();
  const { data: d, error, reload } = useFetch(() => api.get<BotDetail>(`/api/bots/${id}`), [id]);
  // Only the live tabs follow events: threads (runs and pit stops) and computer (up, down, lease).
  useLiveReload((e) => "botId" in e.data && e.data.botId === id
    && (tab === "threads" ? ["thread", "turn", "pitstop"].includes(e.type) : tab === "computer" && ["computer", "lease"].includes(e.type)), reload);
  if (error && !d) return <div className="page"><p className="badc">{error}</p></div>;
  if (!d) return null;
  // The page fetches the member once (with all its threads); face, mood and computer follow the live store.
  const live = bot(id);
  const b = live ? { ...d.bot, hue: live.hue, shape: live.shape, mood: live.mood, computer: live.computer } : d.bot;
  const newThread = async () => { const r = await api.post<{ id: string }>("/api/threads", { botId: id, title: "New thread" }); go(`#/t/${r.id}`); };

  let body;
  switch (tab) {
    case "threads": body = <div className="col" style={{ gap: 28 }}><ThreadsTab b={b} /><section className="col"><p className="pc-lab">Schedules</p><SchedulesTab b={b} list={d.schedules} reload={reload} /></section></div>; break;
    case "files": body = <div className="col" style={{ gap: 28 }}><FilesTab b={b} rest={rest} /><section className="col"><p className="pc-lab">Data</p><DataTab b={b} /></section></div>; break;
    case "computer": body = <div className="col" style={{ gap: 28 }}><ComputerTab b={b} reload={reload} /><section className="col"><p className="pc-lab">Sites</p><SitesEditor scope={b.id} help={`Sites for ${b.name}. These win over the crew-wide list in Settings, except a crew-wide block.`} /></section></div>; break;
    case "memory": body = <MemoryTab b={b} memory={d.memory} global={d.global} error={d.memoryError} reload={reload} />; break;
    default: body = <div className="col" style={{ gap: 28 }}><ProfileTab key={b.id} b={b} /><section className="col"><p className="pc-lab">Standing rules</p><RulesList rules={d.rules} after={reload} /><LearnedList items={d.learned} after={reload} /></section></div>;
  }
  return (
    <div className="page">
      <div className="spread">
        <div className="row" style={{ gap: 16 }}>
          <Face b={b} size="lg" />
          <div className="col" style={{ gap: 4 }}>
            <h1 className="pc-h2">{b.name}</h1><p className="muted">{b.job}</p>
            <div className="row"><span className="pc-chip">{b.provider}</span><span className="pc-chip">{b.model}</span><span className="pc-chip">{`${usd(b.spend)} / ${usd(b.weekly_cap_usd)} wk`}</span></div>
          </div>
        </div>
        <button className="pc-pill" onClick={newThread}>+ New thread</button>
      </div>
      <div className="tabs">{TABS.map((t) => <a key={t} href={`#/crew/${id}/${t}`} className={tab === t ? "on" : ""}>{t[0].toUpperCase() + t.slice(1)}</a>)}</div>
      {body}
    </div>
  );
}
