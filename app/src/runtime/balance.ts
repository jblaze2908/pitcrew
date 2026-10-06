// The OpenRouter balance: one notice (in the app, and once on the phone) when 90% of it is used. Checked every 15 min
// at most, off the request path; /api/state only reads the stored result.
import { getSetting, setSetting } from "../db.js";
import { openrouterUsage } from "../providers.js";
import { pushBalance } from "./push.js";

const WARN_AT = 0.9;
export interface BalanceAlert { id: string; text: string }
interface Reading { at: number; used: number; total: number; id: string }

const read = (k: string): Reading | null => { try { return JSON.parse(getSetting(k) as string); } catch { return null; } };
const money = (n: number) => `$${n.toFixed(2)}`;

/** Account credits when the key can see them (a management key), else the key's own limit. A top-up changes the total and so starts a new notice. */
export async function checkBalance() {
  const u: any = await Promise.resolve(openrouterUsage()).catch(() => null);
  const pair = u?.credits?.total > 0 ? { used: u.credits.used, total: u.credits.total, what: "credits" } : u?.limit > 0 ? { used: u.usage, total: u.limit, what: "key" } : null;
  if (!pair) { setSetting("or_balance", ""); return; }
  const r: Reading = { at: Date.now(), used: pair.used, total: pair.total, id: `or:${pair.what}:${pair.total}` };
  setSetting("or_balance", JSON.stringify(r));
  if (r.used / r.total >= WARN_AT && getSetting("or_balance_pushed") !== r.id) {
    setSetting("or_balance_pushed", r.id);
    pushBalance(alertText(r));
  }
}
const alertText = (r: Reading) => `OpenRouter is ${Math.round((r.used / r.total) * 100)}% used: ${money(Math.max(0, r.total - r.used))} left of ${money(r.total)}. Top up before the crew runs out.`;

export function balanceAlerts(): BalanceAlert[] {
  const r = read("or_balance");
  if (!r || r.used / r.total < WARN_AT || getSetting("or_balance_dismissed") === r.id) return [];
  return [{ id: r.id, text: alertText(r) }];
}
export const dismissAlert = (id: string) => { if (read("or_balance")?.id === id) setSetting("or_balance_dismissed", id); };

export function startBalanceWatch() {
  const tick = () => checkBalance().catch(() => {});
  setTimeout(tick, 30000).unref();
  setInterval(tick, 15 * 60000).unref();
}
