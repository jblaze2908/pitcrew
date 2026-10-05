// Each member's brain and computer, wired to the runtime through their hooks.
import { one, getSetting } from "../db.js";
import { getBot } from "../crew.js";
import { brainFor, computerFor, type Computer, type BrainHooks, type ComputerHooks } from "../computer.js";
import { bus } from "./bus.js";
import { active, leases } from "./state.js";
import { getThread, addSystemForBot } from "./threads.js";
import { finishTurn } from "./turns.js";
import { onNotify } from "./notify.js";
import { onRequest } from "./requests.js";
import { releaseLease } from "./lease.js";
import type { Bot } from "../../shared/types.js";

export function isBusy(c: Computer) { return [...active.keys()].some((t) => getThread(t)?.bot_id === c.bot.id) || one("SELECT 1 FROM pitstops WHERE bot_id=? AND status='pending' AND kind NOT IN ('hire','engram','vault')", c.bot.id); }
export const isThinking = (botId: string) => [...active.keys()].some((t) => getThread(t)?.bot_id === botId);

const brainHooks: BrainHooks = {
  onNotify: (br, method, p) => onNotify(br, method, p),
  onRequest: (br, method, p) => onRequest(br, method, p),
  onBrainExit: (br, code, errTail) => {
    for (const [tid] of active) if (getThread(tid)?.bot_id === br.bot.id) finishTurn(tid, "failed", `The crew member's brain stopped (exit ${code}).`);
    if (code && code !== 143 && code !== 137 && code !== null) addSystemForBot(br.bot.id, `Brain stopped unexpectedly (exit ${code}). ${errTail.split("\n").filter(Boolean).slice(-1)[0] || ""}`.trim());
  },
};
export const computerHooks: ComputerHooks = {
  isBusy,
  getBot,
  paused: () => getSetting("paused") === "1",
  onState: (c) => {
    bus.emit("computer", { botId: c.bot.id, up: c.up, desktop: c.desktopUp, startedAt: c.startedAt });
    // The desktop the driver held is gone; a lease on it would block the crew with no screen to hand back from.
    if (!c.up && leases.has(c.bot.id)) releaseLease(c.bot.id, "computer.lease_released", "The computer stopped while you had control, so control went back to the crew.");
  },
  onComputerBoot: (botId) => { for (const [tid, a] of active) if (getThread(tid)?.bot_id === botId) bus.emit("activity", { threadId: tid, botId, text: "Computer up" }); },
};
export const computer = (bot: Bot) => computerFor(bot, computerHooks);
export const brain = (bot: Bot) => brainFor(bot, brainHooks);
