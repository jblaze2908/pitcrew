// Grounding: Playwright MCP acts on bare refs ("e44"). Resolve them against the snapshot the agent itself read, so jev
// judges 'button "Submit order"' on httpbin.org, not "e44". Runs once per browser action; the lookup is a line scan.
// Playwright MCP writes the snapshot it takes after each action to a file (PW_OUT, see computer.ts) and returns only a
// link, so read that file too: otherwise refs from any page but the last explicit snapshot ground to nothing.
import { execFs } from "../execfs.js";
import { checkoutWhy } from "../sites.js";
import { snapshots, type Seen } from "./state.js";
import { SNAP_LINK, SNAP_INLINE, linkPath } from "./pageText.js";

// The snapshot a response carries: inline (explicit browser_snapshot) or in the linked file (one local read per action).
export function snapshotOf(botId: string, text: string): string | null {
  const inline = SNAP_INLINE.exec(text)?.[1];
  if (inline != null) return inline;
  const abs = linkPath(SNAP_LINK.exec(text)?.[1]);
  const r = abs ? execFs(botId, "fs/readFile", { path: `file://${abs}` }) : null;
  return r?.result ? Buffer.from(r.result.dataBase64, "base64").toString("utf8") : null;
}
// text is the diff base (what the agent last saw); lines are ref lines for grounding. A scoped or unseen snapshot
// (target/depth, browser_read) adds refs but keeps the diff base, which stays valid only on the same page.
export function noteSnapshot(codexId: string, snap: string | null, url: string | null, { scoped = false, seen = true } = {}) {
  if (!snap?.includes("[ref=")) return;
  const prev = snapshots.get(codexId), same = prev && prev.url === url, lines = snap.split("\n").filter((l) => l.includes("[ref="));
  if (scoped || !seen) snapshots.set(codexId, { url, text: same ? prev.text : null, lines: same ? [...new Set([...lines, ...prev.lines])] : lines });
  else snapshots.set(codexId, { url, text: snap, lines });
}

const CONSEQUENTIAL_PAY = /\b(pay|buy|purchase|place order|checkout|check out|transfer|subscribe|donate|confirm payment)\b/i;
const CONSEQUENTIAL_SEND = /\b(submit|send|post|publish|reply|confirm|sign up|register|book|reserve|apply|delete|remove|unsubscribe|cancel (my )?(order|subscription|account))\b/i;
// Snapshot lines carry attributes for the model ([cursor=pointer], [active]); people only need role and name.
export const tidyElement = (s: unknown) => String(s || "").replace(/\s*\[[a-z-]+(=[^\]]*)?\]/g, "").replace(/:\s*$/, "").trim();
export const roleOf = (element: string | null | undefined) => /^([a-z]+)\b/.exec(element || "")?.[1] || null;
export function ground(snap: Seen | null | undefined, tool: string, args: Record<string, any>) {
  const find = (ref: string) => snap?.lines.find((l) => l.includes(`[ref=${ref}]`))?.replace(/\[ref=[^\]]+\]/, "").replace(/^\s*-\s*/, "").trim().slice(0, 160);
  const refs: string[] = [args.target, args.ref, ...(Array.isArray(args.fields) ? args.fields.map((f) => f.target || f.ref) : [])].filter(Boolean);
  const elements = refs.map((r) => ({ ref: r, element: find(r) || "(not in the last snapshot)" }));
  const why = checkoutWhy({ url: snap?.url, title: snap?.title, lines: snap?.lines });
  const grounded: Record<string, any> = { ...args, page_url: snap?.url || null, ...(snap?.title ? { page_title: snap.title } : {}), ...(why ? { page_checkout: why } : {}), ...(elements.length ? { grounded_elements: elements } : {}) };
  let effect: string | null = null;
  const label = elements.map((e) => tidyElement(e.element)).join(" ");
  // A plain link click is navigation; links that pay, send or delete still get their consequential class.
  if (/^browser_(click|press_key|select_option)$/.test(tool) && elements.length)
    effect = CONSEQUENTIAL_PAY.test(label) ? "pay" : CONSEQUENTIAL_SEND.test(label) ? "send" : tool === "browser_click" && elements.every((e) => roleOf(e.element) === "link") ? "browse" : null;
  return { grounded, effect, label };
}
// Pixel actions carry the browser page the agent last saw (URL, title, checkout signal) plus its own `target` words, so
// the site policy and jev judge them in context. The screen may have moved on since; there's no OCR in the image.
export const pixelContext = (args: Record<string, any>, snap: Seen | undefined) => (snap?.url ? { ...args, page_url: snap.url, ...(snap.title ? { page_title: snap.title } : {}), ...((w) => (w ? { page_checkout: w } : {}))(checkoutWhy({ url: snap.url, title: snap.title, lines: snap.lines })) } : args);
