// Per-domain site policy: global and per crew member, keyed by registrable domain or a more specific host.
// The gate reads it on every browser action, so the table lives in memory and is reloaded only on writes; the known
// domains a member visited ride along for look-alike checks. Blocked domains are also written into the member's
// Chromium managed policy (mounted read-only into its computer), which Chrome re-reads without a restart.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { all, run, now, audit, json, getSetting, setSetting } from "./db.js";
import { siteOf, registrable, domainChain, normHost, checkoutWhy, lookalike, homograph, type Site } from "./sites.js";
import type { Bot, Decision } from "../shared/types.js";
import type { SiteRow, PitstopRow } from "./models.js";
import type { Policy } from "./jev.js";

export type SiteMode = SiteRow["mode"];
export type SiteEntry = Omit<SiteRow, "overrides"> & { overrides: Policy };
// What governs a host for a member: an entry (or a once-in-this-thread approval), or nothing yet.
export interface SiteRule { mode: SiteMode | "unknown"; entry: SiteEntry | Pick<SiteEntry, "scope" | "domain" | "mode" | "overrides"> | null; domain: string; once?: boolean }
// The gate's answer before jev: go on with a per-page policy, ask the driver about the domain, or refuse.
export interface SiteVerdict {
  action: "go" | "ask" | "refuse"; policy?: Policy; site?: Site; why?: string; local?: boolean; entry?: SiteRule["entry"]; once?: boolean;
  checkout?: string | null; full?: boolean; title?: string; warn?: boolean; detail?: Record<string, unknown>;
}

export const EFFECTS = ["read", "draft", "browse", "write_workspace", "signin", "install", "send", "pay", "delete", "share", "exec_untrusted"];
// "Allow site fully": every effect allowed on that site except pay, which always asks (financial floor).
export const FULL = Object.fromEntries(EFFECTS.filter((e) => e !== "pay").map((e) => [e, "allow"]));
export const MODES = ["allowed", "read", "blocked"];
const ORDER: Record<string, number> = { allow: 0, ask: 1, block: 2 };
const stricter = (a: Decision, b: Decision): Decision => ((ORDER[a] ?? 1) >= (ORDER[b] ?? 1) ? a : b);

let table: Map<string, SiteEntry> | null = null; // "scope|domain" → row
const rows = () => (table ??= new Map(all<SiteRow>("SELECT * FROM sites").map((r) => [`${r.scope}|${r.domain}`, { ...r, overrides: json(r.overrides, {}) }])));
const known = new Map<string, Set<string>>(); // bot id → Set(domain)
const once = new Map<string, Set<string>>();  // thread id → Set(domain) allowed once in that thread; never stored
export const knownDomains = (botId: string) => known.get(botId) || known.set(botId, new Set(all<{ domain: string }>("SELECT domain FROM known_hosts WHERE bot_id=?", botId).map((r) => r.domain))).get(botId)!;

// Valid entry keys: hostnames only (no IPs, schemes or paths), normalised.
export function cleanDomain(d: unknown) {
  let h = normHost(String(d || "").trim().replace(/^[a-z]+:\/\//i, "").split(/[/?#:]/)[0]);
  if (h.startsWith("*.")) h = h.slice(2);
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(h) && !/^[\d.]+$/.test(h) ? h : null;
}
const cleanOverrides = (o: unknown) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => EFFECTS.includes(k) && k !== "pay" && ["allow", "ask"].includes(v as string)));

// The entry that governs host for this member: the most specific entry wins within a level, the member's level wins
// over global, except that a global block always wins. Returns { mode: allowed|read|blocked|unknown, entry, domain }.
export function siteFor(botId: string, host: string, threadId: string | null = null): SiteRule {
  const chain = domainChain(host), t = rows(), domain = registrable(host);
  const pick = (scope: string) => chain.map((d) => t.get(`${scope}|${d}`)).find(Boolean);
  const g = pick("global"), m = pick(botId);
  if (g?.mode === "blocked") return { mode: "blocked", entry: g, domain };
  const e = m || g;
  if (e) return { mode: e.mode, entry: e, domain };
  if (threadId && once.get(threadId)?.has(domain)) return { mode: "allowed", entry: { scope: "thread", domain, mode: "allowed", overrides: {} }, domain, once: true };
  return { mode: "unknown", entry: null, domain };
}

// The member's policy as it applies on one page: the site's overrides replace effects, pay never drops below ask,
// and on checkout/payment pages pay and send always ask. Typing on plain http asks too. A read site keeps browse,
// read and workspace writes as the member has them and asks for everything else, whatever the member's policy says.
export function effectivePolicy(base: Policy, site: SiteRule | null, { checkout = false, insecure = false } = {}): Policy {
  const p: Policy = { ...base, ...(site?.mode === "allowed" ? site.entry?.overrides : {}) };
  if (site?.mode === "read") for (const e of EFFECTS) if (!["browse", "read", "write_workspace"].includes(e)) p[e] = stricter(base[e] ?? "ask", "ask");
  p.pay = stricter(base.pay ?? "ask", "ask");
  if (checkout) p.send = stricter(p.send ?? "ask", "ask");
  if (insecure) { p.draft = stricter(p.draft ?? "ask", "ask"); p.signin = stricter(p.signin ?? "ask", "ask"); }
  return p;
}
export const fullyAllowed = (p: Policy) => EFFECTS.every((e) => e === "pay" || p[e] === "allow");

// What the gate does with a browser action before jev: refuse, ask the driver about the domain, or go on with a
// per-page policy. url is the navigation target (navigate, new tab) or the page the action runs on. Per call: a few
// Map lookups; the look-alike scan runs only for a domain the driver hasn't decided on.
const LOCAL_SCHEMES = new Set(["about", "chrome-error"]);
export function siteVerdict(b: Pick<Bot, "id" | "name" | "policy">, threadId: string | null, url: string | null | undefined, { navigating = false, typing = false, pageCheckout = null, title = null, lines = null }: { navigating?: boolean; typing?: boolean; pageCheckout?: string | null; title?: string | null; lines?: string[] | null } = {}): SiteVerdict {
  if (!url) return { action: "go", policy: b.policy };
  const s = siteOf(url);
  if (!s) return navigating ? { action: "refuse", why: `"${String(url).slice(0, 80)}" isn't a web address` } : { action: "go", policy: b.policy };
  if (!["http", "https"].includes(s.scheme)) {
    if (LOCAL_SCHEMES.has(s.scheme)) return { action: "go", policy: b.policy, site: s };
    return navigating ? { action: "refuse", site: s, why: `${s.scheme}: pages are blocked` } : { action: "go", policy: b.policy, site: s };
  }
  if (s.ip === "private") return { action: "refuse", site: s, why: `${s.host} is a private network address (host, containers or cloud metadata)` };
  if (s.ip === "loopback") return { action: "go", policy: b.policy, site: s, local: true };
  const sf = siteFor(b.id, s.host, threadId);
  if (sf.mode === "blocked") return { action: "refuse", site: s, why: `${sf.entry!.domain} is blocked${sf.entry!.scope === "global" ? " for the whole crew" : ` for ${b.name}`}` };
  const checkout = pageCheckout || checkoutWhy({ url, title, lines });
  if (sf.mode === "unknown") {
    const ref = [...knownDomains(b.id), ...allowedDomains(b.id)];
    s.lookalike = lookalike(s.host, ref); s.homograph = homograph(s.host);
    const like = s.lookalike?.brand || s.homograph?.brand, why = [s.homograph?.why, s.lookalike?.why].filter(Boolean).join("; ");
    const warn = s.homograph || s.lookalike ? `This looks like ${like || "another site"} but is ${s.homograph ? `${s.host} (${s.homograph.unicode})` : s.domain}: ${why}. ` : "";
    const visited = knownDomains(b.id).has(s.domain);
    return { action: "ask", site: s, checkout, title: `${warn}${b.name} wants to open ${s.domain} (${s.https ? "https" : "NOT https"}, ${visited ? "visited before" : "first visit"})`,
      warn: !!warn, detail: { site: s.domain, host: s.host, url: s.url.slice(0, 500), https: s.https, lookalike: s.lookalike, homograph: s.homograph } };
  }
  const policy = effectivePolicy(b.policy, sf, { checkout: !!checkout, insecure: typing && !s.https });
  return { action: "go", site: s, entry: sf.entry, once: !!sf.once, checkout, policy, full: fullyAllowed(policy) && !checkout };
}
// "on paypal.com, https": what a pit stop for a sensitive action must show so the driver can check the site.
export const siteTag = (s: Site | null | undefined) => (s?.domain ? `on ${s.domain}${s.host !== s.domain ? ` (${s.host})` : ""}, ${s.https ? "https" : "NOT https"}` : "");

const allowedDomains = (botId: string) => [...rows().values()].filter((r) => r.mode !== "blocked" && (r.scope === "global" || r.scope === botId)).map((r) => registrable(r.domain));
export function recordVisit(botId: string, domain: string) {
  const k = knownDomains(botId);
  run("INSERT INTO known_hosts(bot_id,domain,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(bot_id,domain) DO UPDATE SET visits=visits+1, last_seen=excluded.last_seen", botId, domain, now(), now());
  k.add(domain);
}

export function listSites(scope: string) { return [...rows().values()].filter((r) => r.scope === scope).sort((a, b) => a.domain.localeCompare(b.domain)); }
export function setSite(scope: string, domain: unknown, mode: unknown, overrides: unknown = {}, by = "driver") {
  const d = cleanDomain(domain);
  if (!d || !MODES.includes(mode as string)) throw Object.assign(new Error("Give a domain like example.com and a mode (allowed, read or blocked)"), { status: 400 });
  const o = mode === "allowed" ? cleanOverrides(overrides) : {};
  run(`INSERT INTO sites(scope,domain,mode,overrides,by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(scope,domain) DO UPDATE SET mode=excluded.mode, overrides=excluded.overrides, by=excluded.by, updated_at=excluded.updated_at`, scope, d, mode as string, JSON.stringify(o), by, now(), now());
  table = null;
  audit(by === "driver" ? "driver" : "system", "site.set", { scope, domain: d, mode, overrides: o, by });
  refreshBrowserPolicy(scope);
  return { scope, domain: d, mode, overrides: o };
}
export function removeSite(scope: string, domain: string) {
  const r = run("DELETE FROM sites WHERE scope=? AND domain=?", scope, normHost(domain));
  table = null;
  audit("driver", "site.removed", { scope, domain: normHost(domain) });
  refreshBrowserPolicy(scope);
  return { removed: Number(r.changes) };
}

// A domain pit stop's answer: thread/once → this thread only (memory), site → allowed, full → allowed with every
// effect but pay, block (on a denial) → blocked. A plain denial stores nothing.
export function applySiteChoice(ps: PitstopRow, status: string, scope: string) {
  const d = json(ps.detail, {}), domain = d.site;
  if (!domain) return;
  if (status === "approved" && ["once", "thread"].includes(scope)) {
    if (ps.thread_id) (once.get(ps.thread_id) || once.set(ps.thread_id, new Set()).get(ps.thread_id)!).add(domain);
    audit("driver", "site.allowed_once", { botId: ps.bot_id, threadId: ps.thread_id, domain });
  } else if (status === "approved" && ["site", "full", "always"].includes(scope)) setSite(ps.bot_id, domain, "allowed", scope === "full" ? FULL : {}, `pitstop:${ps.id}`);
  else if (status === "denied" && scope === "block") setSite(ps.bot_id, domain, "blocked", {}, `pitstop:${ps.id}`);
  if (status === "approved") recordVisit(ps.bot_id, domain);
}

// Global presets, seeded once (a settings flag), so a preset the driver deletes stays deleted. Read: browse and read
// only. Subdomain entries (developer.mozilla.org) cover that host, not the rest of the domain.
export const PRESETS: Record<"read" | "full", string[]> = { read: ["wikipedia.org", "wikimedia.org", "medium.com", "stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com", "askubuntu.com",
  "claude.ai", "claude.com", "anthropic.com", "github.com", "githubusercontent.com", "developer.mozilla.org", "docs.python.org", "npmjs.com", "pypi.org", "arxiv.org",
  "news.ycombinator.com", "duckduckgo.com"], full: ["excalidraw.com"] };
export function seedPresets() {
  if (getSetting("sites_seeded") === "1") return 0;
  let n = 0;
  for (const [mode, list] of Object.entries(PRESETS)) for (const d of list)
    n += Number(run("INSERT OR IGNORE INTO sites(scope,domain,mode,overrides,by,created_at,updated_at) VALUES('global',?,?,?,'preset',?,?)", d, mode === "full" ? "allowed" : mode, JSON.stringify(mode === "full" ? FULL : {}), now(), now()).changes);
  setSetting("sites_seeded", "1");
  table = null;
  audit("system", "sites.seeded", { added: n });
  return n;
}
seedPresets();

// ---------- the browser's own copy ----------
// /srv/pitcrew/policy/<bot>/pitcrew.json = the image's managed policy (copied into the app image at build) plus this
// member's blocked domains. The directory is mounted read-only over Chrome's managed policy dir; written in place so
// the mount sees it, and Chrome reloads it (~9 s, measured on CfT 154). No base file (dev, tests) → no mount.
const ROOT = process.env.PITCREW_ROOT || "/srv/pitcrew";
const BASE = process.env.PITCREW_CHROME_POLICY || "/app/chrome-policy.json";
export const POLICY_DIR = "/etc/opt/chrome_for_testing/policies/managed";
let base: Record<string, any> | null | undefined;
const basePolicy = () => { if (base === undefined) try { base = JSON.parse(readFileSync(BASE, "utf8")); } catch { base = null; } return base; };
const policyDir = (botId: string) => `${ROOT}/policy/${botId}`;
export function browserPolicy(botId: string) {
  const b = basePolicy();
  if (!b) return null;
  const entries = [...rows().values()].filter((r) => r.scope === "global" || r.scope === botId);
  const blocked = [...new Set(entries.filter((r) => r.mode === "blocked" && siteFor(botId, r.domain).mode === "blocked").map((r) => r.domain))];
  // A more specific allowed host under a blocked domain (member's own, or global without a global block over it).
  const allowed = entries.filter((r) => r.mode !== "blocked" && !["blocked", "unknown"].includes(siteFor(botId, r.domain).mode) && blocked.some((d) => r.domain.endsWith(`.${d}`))).map((r) => r.domain);
  return { ...b, URLBlocklist: [...(b.URLBlocklist || []), ...blocked], URLAllowlist: [...new Set([...(b.URLAllowlist || []), ...allowed])] };
}
export function writeBrowserPolicy(botId: string) {
  const p = browserPolicy(botId);
  if (!p) return null;
  mkdirSync(policyDir(botId), { recursive: true, mode: 0o755 });
  writeFileSync(`${policyDir(botId)}/pitcrew.json`, JSON.stringify(p), { mode: 0o644 });
  return policyDir(botId);
}
// docker run args for a computer: its policy dir over Chrome's, read-only, or nothing. Once per computer start.
export function policyMount(botId: string): string[] {
  try { const dir = writeBrowserPolicy(botId); return dir ? ["-v", `${dir}:${POLICY_DIR}:ro`] : []; } catch { return []; }
}
function refreshBrowserPolicy(scope: string) {
  if (!basePolicy()) return;
  let ids = [scope];
  if (scope === "global") try { ids = readdirSync(`${ROOT}/policy`); } catch { ids = []; }
  for (const id of ids) if (existsSync(policyDir(id))) try { writeBrowserPolicy(id); } catch {}
}
