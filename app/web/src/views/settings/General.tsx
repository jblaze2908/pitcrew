// General: your name, the theme, and the crew-wide voice and plans switches.
import { useState } from "react";
import type { State } from "../../../../shared/types";
import { Seg } from "../../components/ui";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { Row, Section, TabHead, TextSave, Toggle, useSaved } from "./kit";

type Theme = "system" | "dark" | "light";
const THEMES = [["system", "System"], ["dark", "Dark"], ["light", "Light"]] as const;

// theme-boot.js reads the same key before first paint and follows the computer's setting while it says "system".
function readTheme(): Theme {
  try { const t = localStorage.getItem("pc-theme"); if (t === "system" || t === "light") return t; } catch { /* private mode */ }
  return "dark";
}
function applyTheme(t: Theme) {
  const light = t === "light" || (t === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  try { localStorage.setItem("pc-theme", t); } catch { /* private mode */ }
}

/** Patches one crew-wide setting and flashes that row's "Saved". */
export function useSetting() {
  const { setS } = useStore();
  return async (patch: Partial<State>, flash: () => void) => { setS(await api.patch<State>("/api/settings", patch)); flash(); };
}

export function General() {
  const { S } = useStore();
  const save = useSetting();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [nameSaved, flashName] = useSaved(), [themeSaved, flashTheme] = useSaved(), [voiceSaved, flashVoice] = useSaved(), [plansSaved, flashPlans] = useSaved();
  return (
    <>
      <TabHead title="General" intro="How Pitcrew looks, and how the crew talks to you." />
      <Section title="You">
        <Row label="Your name" help="The crew calls you this." saved={nameSaved}>
          <TextSave value={S.driverName} onSave={(v) => save({ driverName: v }, flashName)} />
        </Row>
        <Row label="Theme" help="System follows your computer's light or dark setting." saved={themeSaved}>
          <Seg options={THEMES} value={theme} onChange={(t) => { applyTheme(t); setTheme(t); flashTheme(); }} />
        </Row>
      </Section>
      <Section title="How the crew works">
        <Row label="Plain voice for everyone" help="Members drop their personality and write plainly. Pit stops and anything about money are always plain." saved={voiceSaved}>
          <Toggle label="Plain voice for everyone" on={S.plainVoice} onChange={(v) => save({ plainVoice: v }, flashVoice)} />
        </Row>
        <Row label="Crew plans" help="When an ask needs several members, the Crew Chief splits it into a checklist and works through it. New Chief threads pick this up." saved={plansSaved}>
          <Toggle label="Crew plans" on={S.plans} onChange={(v) => save({ plans: v }, flashPlans)} />
        </Row>
      </Section>
    </>
  );
}
