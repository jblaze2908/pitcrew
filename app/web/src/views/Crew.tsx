// A crew member's page: a three-line header and four tabs. Each tab lives in views/crew/.
import type { BotCard, BotDetail, State } from "../../../shared/types";
import { Face } from "../components/ui";
import { api } from "../lib/api";
import { useLiveReload } from "../lib/live";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { FilesTab } from "./crew/FilesTab";
import { MemoryTab } from "./crew/Lists";
import { OverviewTab } from "./crew/OverviewTab";
import { ProfileTab } from "./crew/ProfileTab";

const TABS = [["overview", "Overview"], ["files", "Files"], ["memory", "Memory"], ["settings", "Settings"]] as const;
// Old links still open, on the tab (and section) that now holds them.
const OLD: Record<string, [string, string?]> = {
  threads: ["overview"], schedules: ["overview"], computer: ["overview"], data: ["files", "tables"],
  sites: ["settings", "permissions"], rules: ["settings", "permissions"], profile: ["settings"],
};

/** "GPT-6 Sol on your ChatGPT plan · asleep" */
function metaLine(b: BotCard, S: State) {
  const how = b.provider === "openai" ? "on your ChatGPT plan" : `via ${S.providers[b.provider]?.label || b.provider}`;
  const state = b.mood === "working" ? "working" : b.mood === "needs" ? "waiting on you" : b.computer.up ? "awake" : "asleep";
  return `${b.model || "No model"} ${how} · ${state}`;
}

export function Crew({ id, tab: asked, rest: given }: { id: string; tab: string; rest: (string | undefined)[] }) {
  const [tab, section] = OLD[asked] || [TABS.some(([k]) => k === asked) ? asked : "overview"];
  const rest = section ? [section, ...given] : given;
  const { S, bot } = useStore();
  const { data: d, error, reload } = useFetch(() => api.get<BotDetail>(`/api/bots/${id}`), [id]);
  // Overview follows runs, pit stops and the computer; the other tabs fetch their own data.
  useLiveReload((e) => tab === "overview" && "botId" in e.data && e.data.botId === id && ["thread", "turn", "pitstop", "computer", "lease"].includes(e.type), reload);
  if (error && !d) return <div className="page"><p className="badc">{error}</p></div>;
  if (!d) return null;
  // The live store wins (mood, computer, spend, and each settings save after refresh); the fetch fills the rest.
  const live = bot(id);
  const b: BotCard = live ? { ...d.bot, ...live } : d.bot;

  return (
    <div className="page mp">
      <header className="mh">
        <Face b={b} size="lg" />
        <div className="mh-t">
          <h1>{b.name}</h1>
          {b.personality?.role && <p className="role">{b.personality.role}</p>}
          <p className="meta">{metaLine(b, S)}</p>
        </div>
      </header>
      <nav className="mtabs">{TABS.map(([k, l]) => <a key={k} href={`#/crew/${id}/${k}`} className={tab === k ? "on" : ""}>{l}</a>)}</nav>
      {tab === "files" ? <FilesTab b={b} rest={rest} />
        : tab === "memory" ? <MemoryTab b={b} memory={d.memory} global={d.global} error={d.memoryError} reload={reload} />
        : tab === "settings" ? <ProfileTab key={b.id} b={b} d={d} section={rest[0]} reload={reload} />
        : <OverviewTab b={b} d={d} />}
    </div>
  );
}
