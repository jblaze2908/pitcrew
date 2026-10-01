// Front door: picks which crew member takes a message, as one jev choice over the crew's jobs.
// Runs once per front-door message (never per turn): one System One call; any failure goes to the Crew Chief.
import { getSecret } from "./auth.js";
import type { RoutePick } from "../shared/types.js";

// What the router needs to know about a member: real ones, or a hypothetical crew on a dry run.
export type Candidate = { id: string; kind: string; name: string; job?: string };

const CHIEF_WHAT = "general requests, anything no other member's job covers, and goals that need several members";
// Below this the driver picks from the top candidates instead of a run starting with the wrong member.
export const SURE = 0.55;

// Members named in the message, as whole words (an optional @ in front). Two or more means a plan for the Crew Chief.
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const namedMembers = <B extends Candidate>(text: string, bots: B[]) => bots.filter((b) => b.kind !== "chief" && new RegExp(`(^|[^\\p{L}])@?${escRe(b.name)}(?![\\p{L}])`, "iu").test(text));

export const routeCriteria = (bots: Candidate[]) => Object.fromEntries(bots.map((b) => [b.id, { what: `${b.name}: ${b.kind === "chief" ? CHIEF_WHAT : b.job || b.name}`.slice(0, 400) }]));

export async function routeMessage(text: string, bots: Candidate[], { apiKey = getSecret("openrouter"), timeoutMs = 5000, model = process.env.JEV_MODEL || "~typesafe/jev-latest" }: { apiKey?: string | null; timeoutMs?: number; model?: string } = {}): Promise<RoutePick> {
  const chief = bots.find((b) => b.kind === "chief") || bots[0];
  const fallback = (by: string): RoutePick => ({ botId: chief.id, confidence: null, alternatives: [], by });
  if (bots.length < 2) return fallback("only member");
  if (!apiKey) return fallback("no OpenRouter key");
  const criteria = routeCriteria(bots), ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs), started = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/systemone", {
      method: "POST", signal: ctrl.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: JSON.stringify({ message: String(text).slice(0, 4000) }), questions: {
        member: { type: "choice", instructions: "Whose job covers this message from the crew's owner? Pick the Crew Chief when no one member's job clearly covers it.", criteria },
      } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json(), m = body.answers?.member;
    if (!m || !(m.choice in criteria)) throw new Error("no valid choice");
    const alternatives = Object.entries(m.probabilities || {}).filter(([id, p]) => id !== m.choice && id in criteria && (p as number) >= 0.15).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 2).map(([botId, p]) => ({ botId, p: p as number }));
    return { botId: m.choice, confidence: m.confidence, alternatives, by: `jev:${body.model}`, ms: Date.now() - started };
  } catch (e: any) {
    return { ...fallback(`failed: ${e.message.slice(0, 60)}`), ms: Date.now() - started };
  } finally { clearTimeout(t); }
}
