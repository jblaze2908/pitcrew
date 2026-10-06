// Settings: six tabs on one template (views/settings/kit.tsx). Old links (#/settings/phone, /engram, /vault/<id>…)
// land on the tab that holds them now, scrolled to their section.
import { useEffect } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { useFetch } from "../lib/useFetch";
import { Account } from "./settings/Account";
import { Connections } from "./settings/Connections";
import { General } from "./settings/General";
import { Models, type Providers } from "./settings/Models";
import { Notifications } from "./settings/Notifications";
import { Permissions } from "./settings/Permissions";

const TABS = [["general", "General"], ["models", "Models"], ["notifications", "Notifications"], ["connections", "Connections"], ["permissions", "Permissions"], ["account", "Account"]] as const;
type Tab = (typeof TABS)[number][0];
const MOVED: Record<string, [Tab, string?]> = {
  phone: ["notifications"], email: ["connections", "email"], engram: ["connections", "memory"], memory: ["connections", "memory"],
  sites: ["permissions", "sites"], vault: ["permissions", "vault"], safety: ["permissions", "stop"],
};

export function Settings({ tab: asked, item }: { tab: string; item?: string }) {
  const { S } = useStore();
  const prov = useFetch(() => api.get<Providers>("/api/providers"), []);
  const [tab, section] = (TABS.some(([k]) => k === asked) ? [asked as Tab] : MOVED[asked] || ["general"]) as [Tab, string?];
  const vaultItem = asked === "vault" ? item : undefined;
  useEffect(() => {
    if (!prov.data) return;
    // After the tab's own fetches draw, so the section is there to scroll to; a plain tab opens at the top.
    const t = setTimeout(() => document.getElementById(section && !vaultItem ? `st-${section}` : "st-top")?.scrollIntoView({ block: "start" }), section ? 120 : 0);
    return () => clearTimeout(t);
  }, [tab, section, vaultItem, !!prov.data]);
  if (prov.error && !prov.data) return <div className="page"><p className="badc">{prov.error}</p></div>;
  if (!prov.data) return null;
  const p = prov.data, noKey = !Object.values(p).some((x) => x.connected);
  const dot: Partial<Record<Tab, boolean>> = { models: noKey, permissions: S.paused };
  return (
    <div className="page st-page" id="st-top">
      <h1>Settings</h1>
      <div className="st-grid">
        <nav className="st-nav" aria-label="Settings">
          {TABS.map(([k, l]) => <a key={k} href={`#/settings/${k}`} className={tab === k ? "on" : ""} aria-current={tab === k ? "page" : undefined}>{l}{dot[k] && <i className="st-dot" aria-label="needs attention" />}</a>)}
        </nav>
        <div className="st-body">
          {tab === "general" && <General />}
          {tab === "models" && <Models prov={p} reload={prov.reload} />}
          {tab === "notifications" && <Notifications />}
          {tab === "connections" && <Connections />}
          {tab === "permissions" && <Permissions check={!!p.openrouter?.connected} item={vaultItem} />}
          {tab === "account" && <Account />}
        </div>
      </div>
    </div>
  );
}
