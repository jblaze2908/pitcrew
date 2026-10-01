// The signed-in app: top bar, sidebar (nav and crew), and the routed view.
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { DockProvider } from "./components/Dock";
import { Face, hueStyle, Loader } from "./components/ui";
import { clock, usd } from "./lib/format";
import { startStream, useRoute, type Route } from "./lib/router";
import { useStore } from "./lib/store";
import { Crew } from "./views/Crew";
import { Hire } from "./views/Hire";
import { Library } from "./views/Library";
import { Live } from "./views/Live";
import { PitStops } from "./views/PitStops";
import { Settings } from "./views/Settings";
import { Telemetry } from "./views/Telemetry";
import { Thread } from "./views/Thread";
import { Wall } from "./views/Wall";

const CRUMB: Record<string, string> = { wall: "Pit wall", crew: "Crew", t: "Thread", pitstops: "Pit stops", telemetry: "Telemetry", library: "Library", settings: "Settings", hire: "Hire", live: "Live computer" };
const MOOD_LABEL: Record<string, [string | null, string]> = { needs: ["PIT STOP", "sig"], working: [null, ""], failed: ["FAIL", "bad"], sleep: ["GARAGE", ""], done: ["DONE", ""], idle: ["READY", ""] };

function View({ route }: { route: Route }) {
  const [a, b, c, d] = route.args;
  switch (route.name) {
    case "crew": return <Crew key={a} id={a} tab={b || "threads"} rest={[c, d]} />;
    case "t": return <Thread key={a} id={a} />;
    case "pitstops": return <PitStops />;
    case "telemetry": return <Telemetry />;
    case "library": return <Library />;
    case "settings": return <Settings tab={a || "general"} />;
    case "hire": return <Hire key={a || "new"} psId={a} />;
    case "live": return <Live key={a} id={a} />;
    default: return <Wall />;
  }
}

export function Shell() {
  const route = useRoute();
  // A layout effect runs before any view's fetch effect, so the stream is open first and less lands between the two.
  useLayoutEffect(() => { startStream(); }, []);
  return (
    <DockProvider>
      <div className="app">
        <TopBar crumb={CRUMB[route.name] || "Pit wall"} />
        <div className="shell">
          <Side route={route} />
          <main id="view"><View route={route} /></main>
        </div>
      </div>
    </DockProvider>
  );
}

function TopBar({ crumb }: { crumb: string }) {
  const { S } = useStore();
  const [now, setNow] = useState(clock);
  useEffect(() => { const t = setInterval(() => setNow(clock()), 20000); return () => clearInterval(t); }, []);
  return (
    <div className="pc-bar">
      <div className="l"><span className="hi">PITCREW</span><span className="dim">/</span><span>{crumb}</span>{S.paused && <span className="stop">CREW STOPPED</span>}</div>
      <div className="r">
        <span className="opt"><i className={`up ${S.computersUp ? "" : "off"}`} />{`${S.computersUp} computer${S.computersUp === 1 ? "" : "s"} up`}</span>
        <span>{`wk ${usd(S.week.usd)} / ${usd(S.weekCap)} cap`}</span>
        <span className="hi clock opt">{now}</span>
      </div>
    </div>
  );
}

function Side({ route }: { route: Route }) {
  const { S, threadBot } = useStore();
  const pending = S.pitstops.length;
  const nav = (id: string, label: string, href: string, count?: ReactNode, hot = false) => (
    <a className={`pc-nav ${route.name === id ? "on" : ""}`} href={href}>{label}{count != null && <em className={hot ? "hot" : ""}>{count}</em>}</a>
  );
  const openThread = route.name === "t" ? route.args[0] : null;
  const activeBot = route.name === "crew" ? route.args[0]
    : openThread ? threadBot ?? S.bots.find((x) => x.threads.some((t) => t.id === openThread))?.id : null;
  return (
    <aside className="side">
      <a href="#/" className="logo"><pc-logo size="sm" wordmark="" /></a>
      <nav>
        {nav("wall", "Pit wall", "#/", pending || null, pending > 0)}
        {nav("pitstops", "Pit stops", "#/pitstops")}
        {nav("telemetry", "Telemetry", "#/telemetry")}
        {nav("library", "Library", "#/library")}
        {nav("settings", "Settings", "#/settings")}
      </nav>
      <p className="pc-lab">Crew</p>
      <div className="crewlist">
        {S.bots.map((b) => {
          const [label, cls] = MOOD_LABEL[b.mood] || ["", ""];
          return (
            <a key={b.id} className={`pc-tile ${activeBot === b.id ? "on" : ""}`} style={hueStyle(b.hue)} href={`#/crew/${b.id}`}>
              <Face b={b} /><b>{b.name}</b>{b.mood === "working" ? <Loader /> : <small className={cls}>{label}</small>}
            </a>
          );
        })}
      </div>
      <div className="foot"><a className="pc-pill o s" href="#/hire">+ New crew member</a></div>
    </aside>
  );
}
