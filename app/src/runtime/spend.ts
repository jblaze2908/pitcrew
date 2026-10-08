// What runs cost: the week's spend per member, billed usage per turn, and the ChatGPT plan's limits.
import { statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { one, now } from "../db.js";
import { usageLog, readPlanLimits } from "../computer.js";
import { providerReady, recordChatgptLimits, chatgptLimits } from "../providers.js";
import { localParts, dayAtPlus } from "./util.js";
import type { TokenUsage } from "./state.js";

// Monday 00:00 in the driver's time zone.
export function weekStart(t = now()) {
  return dayAtPlus(t, -((localParts(t).dow + 6) % 7));
}
export const weekSpend = (botId: string) => one<{ s: number }>("SELECT COALESCE(SUM(cost_usd),0) s FROM turns WHERE bot_id=? AND started_at>=?", botId, weekStart())!.s;

// The brain's LLM proxy logs each model request's provider-reported usage and cost, keyed by turn.
// Read once per finished turn, from the log's size when the turn started: the file only grows, so a full read would too.
export const logSize = (botId: string) => { try { return statSync(usageLog(botId)).size; } catch { return 0; } };
export function billedUsage(botId: string, turnId: string, from = 0) {
  let lines: any[] = [];
  try {
    const fd = openSync(usageLog(botId), "r");
    try { const size = fstatSync(fd).size, at = from <= size ? from : 0, buf = Buffer.alloc(size - at); readSync(fd, buf, 0, buf.length, at); lines = buf.toString("utf8").split("\n").filter((l) => l.includes(turnId)).map((l) => JSON.parse(l)); }
    finally { closeSync(fd); }
  } catch { return null; }
  if (!lines.length) return null;
  const sum = (k: string) => lines.reduce((s, x) => s + (x[k] || 0), 0);
  return { input: sum("input"), cached: sum("cached"), output: sum("output"), cost: lines.every((x) => typeof x.cost === "number") ? sum("cost") : null, requests: lines.length };
}

// Telemetry page: reads the plan's usage from OpenAI at most once a minute (single flight), else the last reading.
let limitsRead: { at: number; p: Promise<unknown> | null } = { at: 0, p: null };
export async function planLimits() {
  if (providerReady("openai") && Date.now() - limitsRead.at > 60000) {
    limitsRead = { at: Date.now(), p: readPlanLimits().then(recordChatgptLimits, (e) => console.error("plan limits:", e.message)) };
  }
  await limitsRead.p;
  return { connected: providerReady("openai"), ...chatgptLimits() };
}
export const subtract = (x: TokenUsage, y: TokenUsage | undefined): TokenUsage => Object.fromEntries(Object.keys(x).map((k) => [k, (x[k] || 0) - (y?.[k] || 0)]));
