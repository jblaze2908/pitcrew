// The signed-in app: the sidebar (links, crew, recent threads) and the routed view.
import { Component, useEffect, useLayoutEffect, type ReactNode } from "react";
import { api } from "./lib/api";
import { DockProvider } from "./components/Dock";
import { Side } from "./components/Side";
import { startStream, useRoute, type Route } from "./lib/router";
import { Crew } from "./views/Crew";
import { CrewIndex } from "./views/CrewIndex";
import { Hire } from "./views/Hire";
import { Library } from "./views/Library";
import { Live } from "./views/Live";
import { PitStops } from "./views/PitStops";
import { Schedules } from "./views/Schedules";
import { Settings } from "./views/Settings";
import { Telemetry } from "./views/Telemetry";
import { Thread } from "./views/Thread";
import { Threads } from "./views/Threads";
import { Wall } from "./views/Wall";

function View({ route }: { route: Route }) {
  const [a, b, c, d] = route.args;
  switch (route.name) {
    case "crew": return a ? <Crew key={a} id={a} tab={b || "threads"} rest={[c, d]} /> : <CrewIndex />;
    case "threads": return <Threads />;
    // Home is the new-thread page (Draft M4b); #/new focuses its box, #/new/<member> starts on that member.
    case "new": return <Wall to={a} focus />;
    case "t": return <Thread key={a} id={a} />;
    case "pitstops": return <PitStops />;
    case "schedules": return <Schedules />;
    case "telemetry": return <Telemetry />;
    case "library": return <Library key={a} arg={a || ""} />;
    case "settings": return <Settings tab={a || "general"} item={b} />;
    case "hire": return <Hire key={a || "new"} psId={a} />;
    case "live": return <Live key={a} id={a} />;
    default: return <Wall />;
  }
}

/** A view that throws shows a line instead of blanking the whole app; keyed by the address, so moving on resets it. */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error(e); }
  render() {
    return this.state.failed
      ? <div className="page"><p className="muted">This page hit an error. <button className="link" onClick={() => location.reload()}>Reload</button></p></div>
      : this.props.children;
  }
}

export function Shell() {
  const route = useRoute();
  // A layout effect runs before any view's fetch effect, so the stream is open first and less lands between the two.
  useLayoutEffect(() => { startStream(); }, []);
  // While Pitcrew is in view, phone pushes stay off (runtime/push.ts): a beat every 60 s and on coming back.
  useEffect(() => {
    const beat = () => { if (document.visibilityState === "visible") api.post("/api/presence", undefined, { quiet: true }).catch(() => {}); };
    beat(); const t = setInterval(beat, 60000); document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", beat); };
  }, []);
  return (
    <DockProvider>
      <div className="app">
        <div className="shell">
          <Side route={route} />
          <main id="view"><Guard key={location.hash}><View route={route} /></Guard></main>
        </div>
      </div>
    </DockProvider>
  );
}
