// Site policy at the gate: browser and pixel actions pass the member's per-domain policy first: blocked or private
// targets are refused, an unknown domain waits on one "open this site?" pit stop (shared by every action that lands on
// it meanwhile), and the rest go on with that page's effective policy. Observing an undecided page (snapshot,
// screenshot) doesn't ask. Per call: in-memory lookups (domains.ts); a pit stop only for an undecided domain.
import { audit } from "../db.js";
import { confirmationOf } from "../sites.js";
import { siteVerdict, recordVisit, type SiteVerdict } from "../domains.js";
import type { Rpc } from "../computer.js";
import type { Call } from "../jev.js";
import type { Bot } from "../../shared/types.js";
import { active, snapshots } from "./state.js";
import { addEvent } from "./threads.js";
import { pitStop } from "./pitstops.js";
import { readTabs } from "./pageText.js";
import { hostOf } from "./util.js";

const refusals = new Map<string, string>(); // thread id → why the last browser action was refused, for the agent's tool result
const siteAsks = new Map<string, Promise<string>>(); // bot|thread|domain → pending pit stop
export const takeRefusal = (threadId: string) => { const r = refusals.get(threadId); refusals.delete(threadId); return r; };
export async function siteStep(b: Bot, threadId: string, call: Call): Promise<Pick<SiteVerdict, "policy" | "full" | "site" | "checkout"> | null> {
  if (call.kind !== "mcp" || !["browser", "computer"].includes(call.server!)) return { policy: b.policy };
  const a = call.arguments || {};
  const navigating = call.tool === "browser_navigate" || (call.tool === "browser_tabs" && a.action === "new" && !!a.url);
  const observing = !navigating && (call.server === "computer" ? /^(screenshot|scroll)$/.test(call.tool!) : /^browser_(snapshot|take_screenshot|wait_for|console_messages|tabs|resize|navigate_back)$/.test(call.tool!));
  const opts = { navigating, typing: /^browser_(type|fill_form|press_key)$|^(type|key)$/.test(call.tool!), pageCheckout: a.page_checkout, title: a.page_title };
  const url = navigating ? a.url : a.page_url;
  let sv = siteVerdict(b, threadId, url, opts);
  if (sv.action === "go" || (observing && sv.action === "ask")) return sv;
  if (sv.action === "ask") {
    const key = `${b.id}|${threadId}|${sv.site!.domain}`;
    if (!siteAsks.has(key)) siteAsks.set(key, pitStop({ botId: b.id, threadId, kind: "site", effect: sv.warn ? "ask" : "browse", title: sv.title!, detail: sv.detail! }).finally(() => siteAsks.delete(key)));
    const d = await siteAsks.get(key);
    sv = d === "approved" ? siteVerdict(b, threadId, url, opts) : { action: "refuse", site: sv.site, why: `the driver didn't allow ${sv.site!.domain}${d === "expired" ? " (the pit stop expired)" : ""}` };
    if (sv.action === "go") return sv;
  }
  refusals.set(threadId, `Not done: ${sv.why}. Don't try to reach it another way; tell the driver if you need it.`);
  audit("jev", "site.refused", { botId: b.id, threadId, tool: call.tool, host: sv.site?.host || null, why: sv.why });
  addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Not opened: ${sv.why}.`, tone: "bad" });
  return null;
}

// After every browser action: if it landed on a blocked or private site (redirect, link, popup), go back or close that
// tab at once; an undecided domain is flagged (its next action waits on the driver); a page that reads like an order or
// payment confirmation raises a bad-tone system event and an audit entry, once per page. Per action: a regex pass over
// the title and snapshot (capped at 60 KB), plus one browser call only when a blocked landing has to be undone.
const confirmSeen = new Map<string, string>(); // thread id → last confirmation (url|phrase) alerted
// Receipts in an order history read like confirmations ("Order placed"), so moving between history pages, or opening a
// URL directly, never alerts: neither can place an order. A click from a cart or checkout onto a receipt still does.
const HISTORY = /\/(account\/|my-?)?(orders?|purchases|order-history|purchase-history)(\/|$)/i;
const inHistory = (u: string | null) => { try { return !!u && HISTORY.test(new URL(u).pathname); } catch { return false; } };
export const mayConfirm = (tool: string, url: string | null, before: string | null) => !/^browser_(navigate|navigate_back|navigate_forward|reload|tabs)$/.test(tool) && !(inHistory(url) && inHistory(before));
export async function afterAction(b: Bot, threadId: string, codexId: string, mcp: Rpc, { tool, text, snap, url, before = null, tabsBefore = null }: { tool: string; text: string; snap: string | null; url: string | null; before?: string | null; tabsBefore?: number | null }) {
  const title = /^- Page Title: (.*)$/m.exec(text || "")?.[1] || null, notes: string[] = [];
  const seen = snapshots.get(codexId);
  if (seen && seen.url === url) seen.title = title;
  if (url && url !== before) {
    const sv = siteVerdict(b, threadId, url, {});
    if (sv.action === "refuse") {
      const tabs = readTabs(text)?.count, newTab = !!(tabs && tabsBefore && tabs > tabsBefore);
      try { await mcp.request("tools/call", newTab ? { name: "browser_tabs", arguments: { action: "close" } } : { name: "browser_navigate_back", arguments: {} }, 30000); } catch {}
      snapshots.delete(codexId);
      audit("jev", "site.left", { botId: b.id, threadId, tool, host: sv.site?.host || null, why: sv.why, closedTab: newTab });
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Left ${sv.site?.host || "a page"}: ${sv.why}.`, tone: "bad" });
      notes.push(`Blocked: that landed on ${sv.site?.host || url}, and ${sv.why}. ${newTab ? "The new tab was closed" : "The browser went back"}; take a fresh snapshot, and don't try to reach it another way.`);
    } else if (sv.action === "ask") notes.push(`Note: ${sv.site!.domain} isn't approved for you yet; your next action on it waits for the driver.`);
    else if (sv.site?.domain && !sv.local) recordVisit(b.id, sv.site.domain);
  }
  const phrase = confirmationOf(`${title || ""}\n${String(snap || "").slice(0, 60000)}`)?.slice(0, 80);
  if (phrase && url && mayConfirm(tool, url, before) && confirmSeen.get(threadId) !== `${url}|${phrase}`) {
    confirmSeen.set(threadId, `${url}|${phrase}`);
    const host = hostOf(url);
    audit("jev", "page.confirmation", { botId: b.id, threadId, tool, host, phrase });
    addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `${b.name} is on what looks like an order or payment confirmation on ${host} (“${phrase}”). Check that this was meant to happen.`, tone: "bad" });
  }
  return notes.join("\n") || null;
}
