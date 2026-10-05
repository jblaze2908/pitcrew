// The signed-in app: the sidebar (threads, nav, crew) and the routed view.
import { useLayoutEffect } from "react";
import { DockProvider } from "./components/Dock";
import { Side } from "./components/Side";
import { startStream, useRoute, type Route } from "./lib/router";
import { Crew } from "./views/Crew";
import { Hire } from "./views/Hire";
import { Library } from "./views/Library";
import { Live } from "./views/Live";
import { PitStops } from "./views/PitStops";
import { Settings } from "./views/Settings";
import { Telemetry } from "./views/Telemetry";
import { Thread } from "./views/Thread";
import { Wall } from "./views/Wall";

function View({ route }: { route: Route }) {
  const [a, b, c, d] = route.args;
  switch (route.name) {
    case "crew": return <Crew key={a} id={a} tab={b || "threads"} rest={[c, d]} />;
    case "t": return <Thread key={a} id={a} />;
    case "pitstops": return <PitStops />;
    case "telemetry": return <Telemetry />;
    case "library": return <Library key={a} arg={a || ""} />;
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
        <div className="shell">
          <Side route={route} />
          <main id="view"><View route={route} /></main>
        </div>
      </div>
    </DockProvider>
  );
}
