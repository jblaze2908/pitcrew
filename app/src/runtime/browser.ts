// Browser and pixel tools run on the crew member's computer, booting it (and its desktop) on first use.
// The gate sees the grounded element; the computer's MCP server sees only the model's own arguments.
// browser_read is ours: a gated browser_snapshot turned into text. Page JS and Playwright code run like any other tool:
// gated per call (gate.ts never lets a fully allowed site skip jev for them), with secrets masked and size capped.
import { getBot } from "../crew.js";
import { audit, driverName } from "../db.js";
import { chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PW_SETTLE_MS, botDir, type Brain, type Rpc } from "../computer.js";
import type { ToolResult } from "../shots.js";
import { siteOf, lookalike, homograph } from "../sites.js";
import { siteVerdict, siteTag, knownDomains } from "../domains.js";
import { FIELDS, SCRUB_FIELDS, findSecret, usableBy, siteMatch, reveal, markUsed, granted, isRetry, noteFill, noteFilled, scrubbing, scrubFilled, flagNeedsUpdate, vaultRefusal, type Secret } from "../vault.js";
import { bus } from "./bus.js";
import { active, snapshots } from "./state.js";
import { addEvent } from "./threads.js";
import { computer } from "./machines.js";
import { gate } from "./gate.js";
import { waitLease } from "./lease.js";
import { pitStop } from "./pitstops.js";
import { takeRefusal, afterAction } from "./sitegate.js";
import { planLive } from "./plans.js";
import { ground, pixelContext, snapshotOf, noteSnapshot } from "./grounding.js";
import { SNAP_LINK, SNAP_MODES, DATA_TOOLS, shapeSnapshot, verifyLine, snapshotToText, readTabs, pageHead, maskSecrets, capData, linkPath } from "./pageText.js";
import { short, summariseArgs, hostOf, say, debugArgs } from "./util.js";

// A dynamic tool call from the brain (item/tool/call): p.threadId is Codex's thread id.
// A call from inside a Code Mode script (Codex gives those ids "exec-…"); the thread draws it under that script.
const viaScript = (p: { callId?: string }) => (String(p.callId || "").startsWith("exec-") ? { viaScript: true } : {});
export interface ToolCall { tool: string; threadId: string; callId?: string; arguments?: Record<string, any> }

// The JSON a browser_run_code_unsafe call returned: its "### Result" section, else the whole text; null if neither parses.
function codeResult<T>(raw: string): T | null { try { return JSON.parse((/### Result\n([\s\S]*?)(?:\n### |$)/.exec(raw)?.[1] ?? raw).trim()); } catch { return null; } }
export async function runtimeTool(br: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, t0 = Date.now();
  const kind = p.tool.startsWith("browser_") ? "browser" : "computer", reading = p.tool === "browser_read";
  if (p.tool === "browser_replay_request") return replayRequest(br, threadId, p);
  if (p.tool === "browser_fill_secret") return fillSecret(br, threadId, p);
  const shut = vaultRefusal(threadId, p.tool, p.arguments || {});
  if (shut) { audit("crew", "vault.read_refused", { botId: b.id, threadId, tool: p.tool }); return say(`Not run: ${shut}.`, false); }
  if (kind === "browser" && !(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off. Answer from your memory and say what you couldn't check.", false);
  // `snapshot` (what the result shows of the page afterwards) is ours; Playwright never sees it.
  const { snapshot: snapArg, ...given } = p.arguments || {};
  // jev judges the code it can see; a snippet loaded from a file would run unread.
  if (p.tool === "browser_run_code_unsafe" && given.filename) return say("Pass the Playwright function inline as code; loading it from a file isn't supported here.", false);
  const tool = reading ? "browser_snapshot" : kind === "browser" ? p.tool : p.tool.replace(/^computer_/, "");
  const args: Record<string, any> = reading ? (given.target ? { target: String(given.target) } : {}) : tool === "browser_take_screenshot" && !given.type && !given.filename ? { ...given, type: "jpeg" } : given;
  const g = kind === "browser" ? ground(snapshots.get(p.threadId), tool, args) : { grounded: pixelContext(args, snapshots.get(p.threadId)), effect: null, label: "" };
  const host = hostOf(g.grounded.page_url);
  const title = `${reading ? "read" : tool.replace(/^browser_/, "").replace(/_/g, " ")} ${short(g.label || summariseArgs(args), 140)}${host ? ` on ${host}` : ""}`.trim();
  bus.emit("activity", { threadId, botId: b.id, text: title });
  const ok = await gate(br, threadId, { kind: "mcp", server: kind, tool, arguments: g.grounded, ...(g.effect ? { effect: g.effect } : {}) }, { kind: "mcp", title, detail: { server: kind, tool, args: g.grounded } });
  const timing: Record<string, number> = { gate: Date.now() - t0 }; // includes a lease wait and jev's remote check (p50 336 ms for browser, measured)
  if (!ok) { addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: "declined", timing }); return say(takeRefusal(threadId) || "Not done: this action was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const comp = computer(b);
  try {
    if (!comp.desktopUp) bus.emit("activity", { threadId, botId: b.id, text: comp.up ? "Starting the desktop…" : "Starting the computer…" });
    let t = Date.now();
    const mcp = await comp.mcp(kind);
    comp.touch();
    timing.boot = Date.now() - t; t = Date.now();
    if (kind === "browser" && tool !== "browser_tabs" && needsFront(mcp, comp.viewers)) await frontTab(mcp);
    if (kind === "browser" && comp.viewers > 0 && /^browser_(click|select_option)$/.test(tool) && args.target) await glideTo(mcp, args);
    const tabsBefore = tabCounts.get(mcp);
    timing.prep = Date.now() - t; t = Date.now();
    const r = await mcp.request("tools/call", { name: tool, arguments: kind === "computer" ? { ...args, _watched: comp.viewers > 0 } : args }, 120000);
    timing.run = Date.now() - t;
    const content: McpContent[] = Array.isArray(r.content) ? r.content : [];
    // After a vault fill, filled values are scrubbed from the result and from the snapshot file it links (vault.ts).
    const text = scrubFilled(threadId, maskSecrets(tool, content.filter((x) => x.type === "text").map((x) => x.text).join("\n")));
    let out = text;
    if (kind === "browser") {
      scrubSnapshotFile(b.id, threadId, text);
      const prev = snapshots.get(p.threadId), url = /^- Page URL: (\S+)/m.exec(text)?.[1] || prev?.url || null, snap = scrubFilled(threadId, snapshotOf(b.id, text));
      const mode = SNAP_MODES.includes(snapArg) ? snapArg : undefined;
      if (reading) out = snap == null ? text : `${pageHead(text)}\n\n${snapshotToText(snap)}`;
      else out = `${SNAP_LINK.test(text) ? `${verifyLine(tool, text, { before: prev?.url, tabsBefore })}\n` : ""}${shapeSnapshot(DATA_TOOLS.test(tool) ? capData(text) : text, snap, { prev, url, mode })}`;
      noteSnapshot(p.threadId, snap, url, { scoped: !!(args.target || args.depth), seen: !reading && mode !== "none" });
      const post = await afterAction(b, threadId, p.threadId, mcp, { tool, text, snap, url, before: prev?.url, tabsBefore });
      if (post) out = `${post}\n\n${out}`;
      const tb = readTabs(text); if (tb) noteTabs(mcp, tb.count);
    }
    addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: r.isError ? "failed" : "completed", output: text.slice(0, 8000), timing });
    return { success: !r.isError, contentItems: toContentItems([{ type: "text", text: out }, ...content.filter((x) => x.type !== "text")], { codeMode: String(p.callId || "").startsWith("exec-") }) };
  } catch (e: any) {
    addEvent(threadId, turnId, "tool", { type: kind, title, ...viaScript(p), server: kind, tool, input: debugArgs(args), status: "failed", error: e.message });
    return say(`The computer couldn't run ${tool}: ${e.message}`, false);
  }
}

// ---------- replaying a captured request ----------
// browser_replay_request: re-send request #index from the page's own session with a changed body, merged JSON fields or
// query. The original headers (auth, device ids) are copied inside one Playwright call and never reach the model; jev
// judges the method, URL and the change. Per call: one MCP read of the request line, one gate, one run_code.
export const REPLAY_MAX = 24000;
const LINE = /^#\d+ \[(\w+)\] (\S+)/m;
export function replayTarget(details: string, query?: Record<string, unknown> | null) {
  const m = LINE.exec(details);
  if (!m) return null;
  let url: URL;
  try { url = new URL(m[2]); } catch { return null; }
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  return { method: m[1].toUpperCase(), url: url.toString() };
}
// The Playwright function that replays it. Spec values are JSON-embedded, so nothing the model sent becomes code.
export function replayCode(spec: { method: string; source: string; url: string; body?: unknown; merge?: Record<string, unknown> | null }) {
  return `async (page) => {
  const spec = ${JSON.stringify(spec)};
  const src = (await page.requests()).reverse().find((r) => r.url() === spec.source && r.method() === spec.method);
  const headers = src ? await src.allHeaders() : {};
  for (const k of Object.keys(headers)) if (/^(:|host$|content-length$|cookie$|accept-encoding$)/i.test(k)) delete headers[k];
  let data = spec.body !== undefined ? (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body)) : src ? src.postData() ?? undefined : undefined;
  if (spec.merge) { let base = {}; try { base = JSON.parse(data || "{}"); } catch {} data = JSON.stringify({ ...base, ...spec.merge }); }
  const r = await page.request.fetch(spec.url, { method: spec.method, headers, data, failOnStatusCode: false, maxRedirects: 0 });
  return { status: r.status(), type: r.headers()["content-type"] || "", text: (await r.text()).slice(0, 4000000), found: !!src };
}`;
}
async function replayRequest(br: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, a = p.arguments || {};
  if (!(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off.", false);
  const index = Number(a.index);
  if (!Number.isInteger(index) || index < 1) return say("index: the request's number from browser_network_requests", false);
  const comp = computer(b), mcp = await comp.mcp("browser");
  comp.touch();
  const details = ((await mcp.request("tools/call", { name: "browser_network_request", arguments: { index } }, 30000)).content || []).map((x: McpContent) => x.text || "").join("\n");
  const target = replayTarget(details, a.query && typeof a.query === "object" ? a.query : null);
  if (!target) return say(`Request #${index} wasn't found; list them again with browser_network_requests.`, false);
  const source = LINE.exec(details)![2], method = String(a.method || target.method).toUpperCase();
  const change = { ...(a.body !== undefined ? { body: a.body } : {}), ...(a.merge && typeof a.merge === "object" ? { merge: a.merge } : {}), ...(a.query ? { query: a.query } : {}) };
  const page_url = snapshots.get(p.threadId)?.url || null, host = hostOf(target.url);
  const title = `replay ${method} ${short(target.url.replace(/^https?:\/\//, ""), 120)}`;
  const ok = await gate(br, threadId, { kind: "mcp", server: "browser", tool: "browser_replay_request", arguments: { method, url: target.url, ...change, page_url } }, { kind: "mcp", title, detail: { server: "browser", tool: "browser_replay_request", args: { method, url: target.url, ...change } } });
  if (!ok) { addEvent(threadId, turnId, "tool", { type: "browser", title, ...viaScript(p), server: "browser", tool: p.tool, input: debugArgs(a), status: "declined" }); return say(takeRefusal(threadId) || "Not done: this replay was declined at a pit stop. Don't retry it another way; tell the driver what didn't happen.", false); }
  const r = await mcp.request("tools/call", { name: "browser_run_code_unsafe", arguments: { code: replayCode({ method, source, url: target.url, body: a.body, merge: a.merge && typeof a.merge === "object" ? a.merge : null }) } }, 120000);
  const raw = scrubFilled(threadId, (r.content || []).map((x: McpContent) => x.text || "").join("\n"));
  const res = codeResult<{ status: number; type: string; text: string; found: boolean }>(raw);
  if (res) res.text = scrubFilled(threadId, String(res.text));
  addEvent(threadId, turnId, "tool", { type: "browser", title: `${title}${host ? ` on ${host}` : ""}`, ...viaScript(p), server: "browser", tool: p.tool, input: debugArgs(a), status: r.isError || !res ? "failed" : "completed", output: res ? `HTTP ${res.status} · ${res.text.length} chars` : raw.slice(0, 2000) });
  if (!res) return say(`The replay failed: ${raw.slice(0, 600)}`, false);
  const head = `HTTP ${res.status}${res.type ? ` · ${res.type.split(";")[0]}` : ""}${res.found ? "" : " · sent without the original's headers (it's no longer in the page's request log)"}`;
  if (typeof a.save === "string" && a.save) {
    const file = workFile(b.id, a.save);
    if (!file) return say(`${head}\nsave must be a path under /bot/work; nothing was saved.`, false);
    writeAsBot(b.id, file, res.text);
    return say(`${head}\nSaved ${(res.text.length / 1024).toFixed(0)} KB to ${a.save}.`);
  }
  return say(`${head}\n${res.text.length > REPLAY_MAX ? `${res.text.slice(0, REPLAY_MAX)}\n…\nTruncated at ${REPLAY_MAX / 1000} KB of ${(res.text.length / 1000).toFixed(0)} KB: pass save (a path under /bot/work) for the whole body.` : res.text}`);
}
// ---------- filling a vault secret ----------
// browser_fill_secret: fill fields from a vault secret by name and submit, in ONE Playwright call, so the member never
// gets a turn while a value sits in the page. The value is decrypted (a TOTP computed) here, JSON-embedded in the code
// and never returned: the result is ours, and anything that echoes back is scrubbed (vault.ts). The page's host is
// checked against the secret's site before asking and again inside the call. Per call: one approval check (a pit
// stop the first time in a thread, every time for a card), one run_code. deps.mcp lets tests stand in for the computer.
export interface FillField { field: string; target: string; value: string }
export function fillCode(spec: { site: string; card: boolean; fields: FillField[]; submit: string | null; clear: string[] }) {
  return `async (page) => {
  const spec = ${JSON.stringify(spec)};
  // A card's fields may sit in a payment provider's frame (any https host); the page itself must be the site when one is set.
  const onSite = (u, any) => { try { const x = new URL(u), h = x.hostname.toLowerCase(); return x.protocol === "https:" && (any || h === spec.site || h.endsWith("." + spec.site)); } catch { return false; } };
  const okHost = (u) => onSite(u, spec.card && !spec.site), okFrame = (u) => onSite(u, spec.card);
  const hide = (e) => spec.fields.reduce((t, f) => t.split(f.value).join("«secret»"), String((e && e.message) || e)).split("\\n")[0].slice(0, 300);
  const loc = (t) => page.locator(/^f?\\d*e\\d+$/.test(t) ? "aria-ref=" + t : t);
  if (!okHost(page.url())) return { ok: false, why: "page", url: page.url() };
  const frames = new Set([page.mainFrame()]), filled = [];
  // Empties every field still holding a password, code or card value, and says whether a password box and an error show.
  const sweep = async () => {
    const out = { left: 0, pw: false, err: false };
    for (const fr of frames) {
      const r = await fr.evaluate((vals) => { let left = 0, pw = false;
        for (const i of document.querySelectorAll("input,textarea")) { if (i.value && vals.includes(i.value)) { left++; i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); } if (i.type === "password" && i.offsetParent !== null) pw = true; }
        return { left, pw, err: /\\b(incorrect|invalid|wrong|didn.?t match|not recognized|try again|failed|locked)\\b/i.test(((document.body && document.body.innerText) || "").slice(0, 20000)) };
      }, spec.clear).catch(() => null);
      if (r) { out.left += r.left; out.pw = out.pw || r.pw; out.err = out.err || r.err; }
    }
    return out;
  };
  try {
    for (const f of spec.fields) {
      const h = await loc(f.target).elementHandle({ timeout: 10000 });
      const fr = await h.ownerFrame();
      if (!fr || !okFrame(fr.url())) { await sweep(); return { ok: false, why: "frame", field: f.field, url: fr ? fr.url() : null }; }
      const [tag, type] = await h.evaluate((e) => [e.tagName.toLowerCase(), (e.getAttribute("type") || "text").toLowerCase()]);
      if (tag !== "input" || (f.field === "password" ? type !== "password" : type === "password" && f.field !== "card_cvc")) { await sweep(); return { ok: false, why: "field", field: f.field, type: tag === "input" ? type : tag }; }
      frames.add(fr);
      await h.fill(f.value, { timeout: 10000 });
      filled.push(f.field);
    }
    const before = page.url();
    if (spec.submit) await loc(spec.submit).click({ timeout: 10000 }); else await loc(spec.fields[spec.fields.length - 1].target).press("Enter", { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    const s = await sweep();
    return { ok: true, filled, url: page.url(), moved: page.url() !== before, ...s };
  } catch (e) { await sweep().catch(() => {}); return { ok: false, why: "error", filled, error: hide(e) }; }
}`;
}
type FillResult = { ok: boolean; why?: string; field?: string; type?: string; url?: string | null; filled?: string[]; moved?: boolean; left?: number; pw?: boolean; err?: boolean; error?: string };
const WHY: Record<string, (r: FillResult) => string> = {
  page: (r) => `the page moved to ${hostOf(r.url) || "another site"} before the fill`,
  frame: (r) => `the ${r.field} box sits in a frame from ${hostOf(r.url) || "another site"}`,
  field: (r) => `the ref given for ${r.field} is a ${r.type} ${r.field === "password" ? "field, not a password box" : r.type === "password" ? "box" : "element, not a text box"}`,
  error: (r) => r.error || "Playwright failed",
};
const asks = new Map<string, Promise<string>>(); // thread|secret → pending sign-in pit stop, shared by calls that land meanwhile
const roleName = (el: string) => /^[a-z]+(\s+"(?:[^"\\]|\\.)*")?/.exec(el)?.[0] || "element"; // no value after the name

export async function fillSecret(br: Brain, threadId: string, p: ToolCall, deps: { mcp?: Pick<Rpc, "request"> } = {}): Promise<ToolResult> {
  const b = getBot(br.bot.id)!, turnId = active.get(threadId)?.turnId, a = p.arguments || {}, driver = driverName();
  if (!(await planLive(threadId))) return say("This plan runs on what the crew already knows: the driver turned live lookups off.", false);
  const sec = findSecret(String(a.secret || ""));
  const refuse = (why: string, event = true) => {
    audit("crew", "vault.refused", { botId: b.id, threadId, secret: sec?.name || String(a.secret || "").slice(0, 60), why });
    if (event) addEvent(threadId, turnId, "system", { text: `Not filled: ${why}.`, tone: "bad" });
    return say(`Not filled: ${why}. Don't type it another way or retry; tell ${driver} what's waiting.`, false);
  };
  if (!sec) { const mine = usableBy(b.id); return say(`No secret called "${short(a.secret, 60)}". ${mine.length ? `Yours: ${mine.map((s) => `"${s.name}" (${s.site || "card"})`).join(", ")}.` : `${driver} hasn't given you any; they keep them in Settings → Permissions → Vault.`}`, false); }
  if (!sec.allowed.includes(b.id)) return refuse(`${b.name} isn't allowed to use "${sec.name}" (${driver} sets who may in Settings → Permissions → Vault)`);
  if (sec.needs_update) return refuse(`"${sec.name}" failed before and waits for ${driver} to update it in Vault`);
  const card = sec.kind === "card", given = Array.isArray(a.fields) ? a.fields : [];
  const fields = given.map((f: any) => ({ field: String(f?.field || ""), target: String(f?.target || f?.ref || "") }));
  const bad = fields.find((f: { field: string; target: string }) => !FIELDS[sec.kind].includes(f.field) || !f.target);
  if (!fields.length || fields.length > 4 || bad || new Set(fields.map((f: { field: string }) => f.field)).size < fields.length) return say(`fields: 1 to 4 of {field, target}, field one of ${FIELDS[sec.kind].join(", ")}, target a ref from the latest snapshot.`, false);
  const missing = fields.find((f: { field: string }) => !sec.has.includes(f.field));
  if (missing) return say(`"${sec.name}" has no ${missing.field} saved; ask ${driver} to add it in Settings → Permissions → Vault.`, false);
  const submit = a.submit ? String(a.submit) : null;
  if (card && !submit) return say("A card fill needs submit: the ref of the pay button. It fills and pays in one step once the driver approves.", false);
  const seen = snapshots.get(p.threadId), url = seen?.url;
  if (!url) return say("Take a snapshot of the sign-in page first, so Pitcrew can check which site it is.", false);
  const s = siteOf(url);
  if (!s || !["http", "https"].includes(s.scheme)) return refuse(`${short(url, 80)} isn't a web page`);
  if (!s.https) return refuse(`${s.host} isn't https: anything typed there can be read in transit`);
  if (s.ip) return refuse(`${s.host} is a network address, not a site`);
  if ((!card || sec.site) && !siteMatch(s.host, sec.site)) { const like = lookalike(s.host, [sec.site]); return refuse(`"${sec.name}" is for ${sec.site}, and this page is ${s.host}${like ? ` (it looks like ${like.domain}: ${like.why})` : ""}`); }
  const sv = siteVerdict(b, threadId, url, {});
  if (sv.action !== "go") return refuse(sv.why || `${s.domain} isn't approved for ${b.name} yet`);
  const names = fields.map((f: { field: string }) => f.field) as string[];
  if (isRetry(threadId, sec.id, names)) { failedSignIn(b, threadId, sec, s.host, "a member filled it again within minutes: the last sign-in with it didn't work"); return say(`Not filled again: you filled "${sec.name}" here minutes ago, so that sign-in didn't work. Don't retry; ${driver} was asked to update it in Vault.`, false); }
  if (!(await waitLease(b.id, threadId, { kind: "mcp", server: "browser", tool: "browser_fill_secret", arguments: { page_url: url } }))) return say(`Not done: ${driver} has the computer.`, false);

  // Approval: a member on the "always" list, or one already allowed for this thread, goes on; anyone else asks. Cards ask every time.
  if (card || !(sec.always.includes(b.id) || granted(threadId, sec.id))) {
    const g = ground(seen, "browser_fill_form", { fields: fields.map((f: { target: string }) => ({ target: f.target })), ...(submit ? { target: submit } : {}) }).grounded.grounded_elements || [];
    const label = (ref: string) => roleName(g.find((e: { ref: string }) => e.ref === ref)?.element || "");
    const homo = homograph(s.host), like = card ? lookalike(s.host, [...knownDomains(b.id)]) : null;
    const warn = homo || like ? `This looks like ${homo?.brand || like?.brand} but is ${s.host}: ${[homo?.why, like?.why].filter(Boolean).join("; ")}. ` : "";
    const title = `${warn}${card ? `${b.name} wants to pay on ${s.host} with card “${sec.name}” ••${sec.last4}` : `${b.name} wants to sign in to ${s.host} with “${sec.name}”`} · verify: ${siteTag(s)}`;
    const detail = { secret: { id: sec.id, name: sec.name, kind: sec.kind, site: sec.site, last4: sec.last4 }, fields: fields.map((f: { field: string; target: string }) => ({ field: f.field, element: label(f.target) })), submit: submit ? label(submit) : "Enter",
      site: { domain: s.domain, host: s.host, https: s.https, url: s.url.slice(0, 500) }, lookalike: like, homograph: homo };
    const key = `${threadId}|${sec.id}`, ask = () => pitStop({ botId: b.id, threadId, kind: "secret", effect: card ? "pay" : "signin", title, detail });
    let d: string;
    if (card) d = await ask();
    else { if (!asks.has(key)) asks.set(key, ask().finally(() => asks.delete(key))); d = await asks.get(key)!; }
    if (d !== "approved") return refuse(d === "expired" ? "the pit stop expired before the driver answered" : `${driver} said no`, false);
  }

  const at = Date.now(), filling: FillField[] = fields.map((f: { field: string; target: string }) => ({ ...f, value: reveal(sec, f.field, at) || "" }));
  const clear = filling.filter((f) => SCRUB_FIELDS.has(f.field)).map((f) => f.value);
  noteFilled(threadId, clear); // before the call, so anything that echoes during it is scrubbed too
  const title = card ? `Used card ${sec.name} on ${s.host}` : `Signed in to ${s.host} with ${sec.name}`;
  const input = debugArgs({ secret: sec.name, fields: fields.map((f: { field: string; target: string }) => ({ field: f.field, target: f.target })), submit });
  try {
    const mcp = deps.mcp || (await (async () => { const comp = computer(b), m = await comp.mcp("browser"); comp.touch(); return m; })());
    const r = await mcp.request("tools/call", { name: "browser_run_code_unsafe", arguments: { code: fillCode({ site: sec.site, card, fields: filling, submit, clear }) } }, 120000);
    const raw = scrubFilled(threadId, (r.content || []).map((x: McpContent) => x.text || "").join("\n"));
    scrubSnapshotFile(b.id, threadId, raw);
    const res = codeResult<FillResult>(raw);
    markUsed(sec.id, b.id);
    audit("crew", "vault.filled", { botId: b.id, threadId, id: sec.id, name: sec.name, host: s.host, fields: names, ok: !!res?.ok });
    if (!res || !res.ok) {
      const why = res ? (WHY[res.why || ""] || WHY.error)(res) : short(raw, 300);
      addEvent(threadId, turnId, "tool", { type: "browser", title, server: "browser", tool: p.tool, input, status: "failed", error: `Not filled: ${why}` });
      return say(`Not filled: ${why}. Nothing was submitted, and any box it filled was emptied. Take a fresh snapshot and pass the right refs.`, false);
    }
    noteFill(threadId, sec.id, names);
    // The site kept the password, or still shows a password box with an error: wrong or stale credentials.
    const failed = !card && names.some((n) => n === "password" || n === "totp") && ((res.left || 0) > 0 || (!!res.pw && !!res.err && !res.moved));
    if (failed) {
      const why = res.err ? `${s.host} showed an error after submit` : `${s.host} kept the sign-in form after submit`;
      failedSignIn(b, threadId, sec, s.host, why);
      addEvent(threadId, turnId, "tool", { type: "browser", title, server: "browser", tool: p.tool, input, status: "failed", error: `Sign-in didn't work: ${why}` });
      return say(`Signing in to ${s.host} with "${sec.name}" didn't work (${why}). The filled values were emptied. Don't retry: ${driver} was asked to update it in Vault. Tell them what you were doing.`, false);
    }
    const out = `Filled ${names.join(", ")} from "${sec.name}" and ${submit ? "clicked submit" : "pressed Enter"} on ${s.host}${res.moved ? `; the page is now ${hostOf(res.url) || "elsewhere"}` : ""}. The values never reach you. Take a snapshot to see where it landed.`;
    addEvent(threadId, turnId, "tool", { type: "browser", title, server: "browser", tool: p.tool, input, status: "completed", output: out });
    return say(out);
  } catch (e: any) {
    addEvent(threadId, turnId, "tool", { type: "browser", title, server: "browser", tool: p.tool, input, status: "failed", error: scrubFilled(threadId, String(e.message)) });
    return say(`The computer couldn't fill it: ${scrubFilled(threadId, String(e.message))}`, false);
  }
}
// One failure, one pit stop: "BESCOM login failed — update it in Vault", linking to its edit form. It blocks nothing.
function failedSignIn(b: { id: string; name: string }, threadId: string, sec: Secret, host: string, why: string) {
  addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Sign-in with ${sec.name} on ${host} didn't work: ${why}. It's marked "needs update" in Vault.`, tone: "bad" });
  if (flagNeedsUpdate(sec.id, why)) pitStop({ botId: b.id, threadId, kind: "vault", effect: "ask", title: `${sec.name} failed — update it in Vault`, detail: { secret: { id: sec.id, name: sec.name, kind: sec.kind, site: sec.site }, host, why }, expiresMin: 7 * 24 * 60 }).catch(() => {});
}
// Playwright writes each action's snapshot to a file in the member's computer; after a fill, that file is scrubbed too.
function scrubSnapshotFile(botId: string, threadId: string, text: string) {
  const abs = scrubbing(threadId) ? linkPath(SNAP_LINK.exec(text)?.[1]) : null;
  if (!abs) return;
  const f = `${botDir(botId)}${abs.slice("/bot".length)}`;
  try { if (lstatSync(f).isFile()) { const t = readFileSync(f, "utf8"), c = scrubFilled(threadId, t); if (c !== t) writeFileSync(f, c); } } catch {}
}

// A /bot/work path as its host file, with its folder made, or null when it would leave the work dir. Folders it makes
// belong to the work dir's owner (the bot's uid), never root: the control plane runs as root, the bot doesn't.
export function workFile(botId: string, path: string) {
  const rel = path.replace(/^\/bot\/work\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return null;
  const root = `${botDir(botId)}/work`, f = `${root}/${rel}`;
  try {
    const made = mkdirSync(dirname(f), { recursive: true });
    if (!realpathSync(dirname(f)).startsWith(realpathSync(root))) return null;
    if (made) { const o = statSync(root); for (let d = dirname(f); d.length >= made.length; d = dirname(d)) chownSync(d, o.uid, o.gid); }
    return f;
  } catch { return null; }
}
// Writes a file the bot must be able to change afterwards: owned like its work dir.
export function writeAsBot(botId: string, file: string, data: string) {
  writeFileSync(file, data);
  const o = statSync(`${botDir(botId)}/work`);
  try { chownSync(file, o.uid, o.gid); } catch {}
}

// Codex hands a dynamic tool's result to an exec script (nested call ids "exec-…") as ONE string, its text and image
// data URLs joined by newlines (codex-rs tools/src/tool_output.rs, 0.156). So there an image result is the bare data URL,
// which image(result) shows. Text items never carry base64: unknown blocks become a placeholder, not JSON.
type McpContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: unknown } };
const noBase64 = (s: unknown) => String(s).replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, "[base64 data omitted]").replace(/[A-Za-z0-9+/]{2000,}={0,2}/g, "[base64 data omitted]");
export function toContentItems(content: McpContent[], { codeMode = false } = {}): ToolResult["contentItems"] {
  const items = content.map((x) => x.type === "image" ? { type: "inputImage", imageUrl: `data:${x.mimeType || "image/png"};base64,${x.data}` }
    : { type: "inputText", text: noBase64(x.type === "text" ? x.text : x.type === "resource" && typeof x.resource?.text === "string" ? x.resource.text : `[${x.type} content omitted]`) });
  const images = items.filter((x) => x.type === "inputImage");
  return codeMode && images.length ? images.slice(0, 1) : items;
}

// ---------- tab focus ----------
// Playwright drives its own current tab, which needn't be Chrome's foreground one (a popup opened, the driver switched
// tabs in the live view, or a fresh MCP session adopted tab 0). Then the live view shows another tab, and Chrome throttles
// the background tab's animation frames, so clicks wait on stability checks and time out. Before each action, bring the
// agent's tab to the front. Costs two local MCP calls, only while more than one tab is open.
// Only when something could have moved the foreground: the first action of a session, a change in the tab count (a popup,
// a closed tab), or a driver watching the live view (they can switch tabs there). Otherwise the agent's tab is still in
// front, and the check cost two MCP calls per action (the Blinkit backfill ran 165 navigations with 3 tabs open).
const tabCounts = new WeakMap<Rpc, number>(); // browser MCP session → tab count from its last response
const fronted = new WeakSet<Rpc>();            // sessions whose current tab was brought to the front since the count last changed
export const needsFront = (mcp: Rpc, viewers = 0) => viewers > 0 || !fronted.has(mcp);
export function noteTabs(mcp: Rpc, count: number) { if (tabCounts.get(mcp) !== count) fronted.delete(mcp); tabCounts.set(mcp, count); }
export async function frontTab(mcp: Rpc) {
  if (tabCounts.get(mcp) === 1) { fronted.add(mcp); return; }
  try {
    const call = (args: Record<string, unknown>) => mcp.request("tools/call", { name: "browser_tabs", arguments: args }, 15000);
    const t = readTabs(((await call({ action: "list" })).content || []).map((x) => x.text || "").join("\n"));
    tabCounts.set(mcp, t?.count ?? 1);
    if (t && t.count > 1) await call({ action: "select", index: t.current });
    fronted.add(mcp);
  } catch {}
}

// While the driver watches, move the pointer onto the element first and let the live-view pointer finish its glide,
// so the press lands where the pointer already is instead of mid-flight. Unwatched runs skip it.
// The glide (pointer.js, 250 ms) starts when the hover moves the mouse; the hover's own settle wait has used part of it.
const GLIDE_MS = 250;
async function glideTo(mcp: Rpc, args: Record<string, any>) {
  try { await mcp.request("tools/call", { name: "browser_hover", arguments: { element: args.element || "target", target: args.target } }, 15000); } catch {}
  await new Promise((r) => setTimeout(r, Math.max(0, GLIDE_MS - PW_SETTLE_MS)));
}
