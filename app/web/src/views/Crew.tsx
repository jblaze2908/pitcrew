// A crew member's page: header and tabs. Each tab lives in views/crew/.
import type { BotDetail } from "../../../shared/types";
import { RulesList, LearnedList } from "../components/Approvals";
import { SitesEditor } from "../components/SitesEditor";
import { Face } from "../components/ui";
import { api } from "../lib/api";
import { usd } from "../lib/format";
import { useLiveReload } from "../lib/live";
import { go } from "../lib/router";
import { useFetch } from "../lib/useFetch";
import { ComputerTab } from "./crew/ComputerTab";
import { FilesTab } from "./crew/FilesTab";
import { DataTab } from "./crew/DataTab";
import { MemoryTab, SchedulesTab } from "./crew/Lists";
import { ProfileTab } from "./crew/ProfileTab";
import { ThreadsTab } from "./crew/ThreadsTab";

const TABS = ["threads", "files", "data", "computer", "profile", "memory", "schedules", "rules", "sites"];

export function Crew({ id, tab, rest }: { id: string; tab: string; rest: (string | undefined)[] }) {
  const { data: d, error, reload } = useFetch(() => api.get<BotDetail>(`/api/bots/${id}`), [id]);
  // Only the live tabs follow events: threads (runs and pit stops) and computer (up, down, lease).
  useLiveReload((e) => "botId" in e.data && e.data.botId === id
    && (tab === "threads" ? ["thread", "turn", "pitstop"].includes(e.type) : tab === "computer" && ["computer", "lease"].includes(e.type)), reload);
  if (error && !d) return <div className="page"><p className="badc">{error}</p></div>;
  if (!d) return null;
  const b = d.bot;
  const newThread = async () => { const r = await api.post<{ id: string }>("/api/threads", { botId: id, title: "New thread" }); go(`#/t/${r.id}`); };

  let body;
  switch (tab) {
    case "threads": body = <ThreadsTab b={b} />; break;
    case "files": body = <FilesTab b={b} rest={rest} />; break;
    case "data": body = <DataTab b={b} />; break;
    case "computer": body = <ComputerTab b={b} reload={reload} />; break;
    case "profile": body = <ProfileTab key={b.id} b={b} />; break;
    case "memory": body = <MemoryTab b={b} memory={d.memory} global={d.global} error={d.memoryError} reload={reload} />; break;
    case "schedules": body = <SchedulesTab b={b} list={d.schedules} reload={reload} />; break;
    case "sites": body = <SitesEditor scope={b.id} help={`Sites for ${b.name}. These win over the crew-wide list in Settings, except a crew-wide block.`} />; break;
    default: body = <div className="col"><RulesList rules={d.rules} after={reload} /><LearnedList items={d.learned} after={reload} /></div>;
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
