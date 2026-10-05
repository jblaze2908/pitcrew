// The vault: logins, one-time-code seeds and cards that members fill by name and never see. Values are sealed with
// AES-256-GCM under vault.key (the data dir, 0600, made on first use), which never leaves the control plane. Only
// reveal() returns a value, and only the server-side fill (runtime/browser.ts fillSecret) calls it.
import { createHmac } from "node:crypto";
import { one, all, run, now, uid, audit, json } from "./db.js";
import { fileSecret, seal, unseal, httpErr } from "./auth.js";
import { cleanDomain } from "./domains.js";
import type { PitstopRow } from "./models.js";
import type { VaultEntry, VaultKind } from "../shared/types.js";

export const KINDS: VaultKind[] = ["login", "login+totp", "card"];
// What a member may ask to fill, per kind, and where each value lives in the sealed blob.
export const FIELDS: Record<VaultKind, string[]> = { login: ["username", "password"], "login+totp": ["username", "password", "totp"], card: ["card_number", "card_expiry", "card_cvc", "card_name"] };
const SLOT: Record<string, string> = { username: "username", password: "password", totp: "totp", card_number: "number", card_expiry: "expiry", card_cvc: "cvc", card_name: "holder" };
const SLOTS = [...new Set(Object.values(SLOT))];
type Values = Partial<Record<string, string>>;
interface VaultRow { id: string; name: string; site: string; kind: VaultKind; note: string; last4: string | null; blob: string; has: string; allowed: string; always: string; last_used: number | null; last_used_by: string | null; needs_update: string | null; created_at: number; updated_at: number }

let KEY: Buffer | null = null;
function key() {
  if (KEY) return KEY;
  const k = Buffer.from(fileSecret("vault.key", 32), "base64url");
  if (k.length !== 32) throw new Error("vault.key is damaged");
  return (KEY = k);
}

// ---------- TOTP (RFC 6238) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(s: string) {
  const t = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!t || !/^[A-Z2-7]+$/.test(t)) return null;
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of t) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 255); val &= (1 << bits) - 1; } }
  return Buffer.from(out);
}
export interface Totp { key: Buffer; digits: number; period: number; algo: "sha1" | "sha256" | "sha512" }
// A bare base32 seed or an otpauth://totp/ URI (what a QR code holds).
export function parseTotp(seed: string): Totp | null {
  let secret = seed, digits = 6, period = 30, algo: Totp["algo"] = "sha1";
  if (/^otpauth:/i.test(seed.trim())) {
    let u: URL; try { u = new URL(seed.trim()); } catch { return null; }
    if (u.host.toLowerCase() !== "totp") return null;
    secret = u.searchParams.get("secret") || "";
    digits = Number(u.searchParams.get("digits") || 6); period = Number(u.searchParams.get("period") || 30);
    algo = (u.searchParams.get("algorithm") || "SHA1").toLowerCase() as Totp["algo"];
  }
  const k = base32(secret);
  if (!k || k.length < 10 || ![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300) || !["sha1", "sha256", "sha512"].includes(algo)) return null;
  return { key: k, digits, period, algo };
}
export function totp(t: Totp, at = now()) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / t.period)));
  const h = createHmac(t.algo, t.key).update(c).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** t.digits).padStart(t.digits, "0");
}

// ---------- the driver's side: list, save, delete ----------
const meta = (r: VaultRow): VaultEntry => ({ id: r.id, name: r.name, site: r.site, kind: r.kind, note: r.note, last4: r.last4, has: json(r.has, []), allowed: json(r.allowed, []), always: json(r.always, []), last_used: r.last_used, last_used_by: r.last_used_by, updated_at: r.updated_at, needs_update: r.needs_update });
export const listVault = () => all<VaultRow>("SELECT * FROM vault ORDER BY name").map(meta);
const members = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String))].filter((id) => one("SELECT 1 FROM bots WHERE id=?", id));
const luhn = (n: string) => [...n].reverse().reduce((s, d, i) => s + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][+d] : +d), 0) % 10 === 0;

// Values are write-only: an empty or missing one keeps what's stored. Nothing about a value comes back but "set".
export function saveVault(input: Record<string, unknown>, id: string | null = null): VaultEntry {
  const prev = id ? one<VaultRow>("SELECT * FROM vault WHERE id=?", id) : null;
  if (id && !prev) throw httpErr(404, "No such secret");
  const kind = (input.kind ?? prev?.kind) as VaultKind;
  if (!KINDS.includes(kind)) throw httpErr(400, "kind is login, login+totp or card");
  const name = String(input.name ?? prev?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw httpErr(400, "Give it a name");
  const siteIn = String(input.site ?? prev?.site ?? "").trim(), site = siteIn ? cleanDomain(siteIn) : "";
  if (site === null) throw httpErr(400, "site is a domain like example.com");
  if (!site && kind !== "card") throw httpErr(400, "A login needs the site it signs in to");
  const rid = prev?.id || uid("vs"), vals: Values = prev ? json(unseal(key(), prev.blob, prev.id), {}) : {};
  for (const s of SLOTS) {
    const v = input[s];
    if (typeof v !== "string" || !v) continue;
    vals[s] = s === "password" ? v : v.trim();
  }
  for (const s of SLOTS) if (!FIELDS[kind].some((f) => SLOT[f] === s)) delete vals[s];
  if (vals.totp && !parseTotp(vals.totp)) throw httpErr(400, "The one-time-code seed isn't a base32 secret or an otpauth:// link");
  if (vals.number) { vals.number = vals.number.replace(/[\s-]/g, ""); if (!/^\d{12,19}$/.test(vals.number) || !luhn(vals.number)) throw httpErr(400, "That card number doesn't check out"); }
  if (vals.cvc && !/^\d{3,4}$/.test(vals.cvc)) throw httpErr(400, "CVC is 3 or 4 digits");
  const has = FIELDS[kind].filter((f) => vals[SLOT[f]]);
  if (kind === "card" ? !vals.number : !has.length) throw httpErr(400, kind === "card" ? "A card needs its number" : "Set at least one value");
  if (kind === "login+totp" && !vals.totp) throw httpErr(400, "login + TOTP needs the one-time-code seed");
  const allowed = input.allowed !== undefined ? members(input.allowed) : json<string[]>(prev?.allowed, []);
  // Cards always ask: no member skips the pit stop for one.
  const always = kind === "card" ? [] : (input.always !== undefined ? members(input.always) : json<string[]>(prev?.always, [])).filter((x) => allowed.includes(x));
  const note = String(input.note ?? prev?.note ?? "").trim().slice(0, 80), last4 = kind === "card" ? vals.number!.slice(-4) : null;
  const blob = seal(key(), JSON.stringify(vals), rid), changed = SLOTS.some((s) => typeof input[s] === "string" && input[s]);
  try {
    // A new value is the driver's fix for a failed sign-in, so it clears "needs update".
    if (prev) run("UPDATE vault SET name=?, site=?, kind=?, note=?, last4=?, blob=?, has=?, allowed=?, always=?, needs_update=?, updated_at=? WHERE id=?", name, site, kind, note, last4, blob, JSON.stringify(has), JSON.stringify(allowed), JSON.stringify(always), changed ? null : prev.needs_update, now(), rid);
    else run("INSERT INTO vault(id,name,site,kind,note,last4,blob,has,allowed,always,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rid, name, site, kind, note, last4, blob, JSON.stringify(has), JSON.stringify(allowed), JSON.stringify(always), now(), now());
  } catch (e: any) { if (/UNIQUE/.test(e.message)) throw httpErr(409, `There's already a secret called "${name}"`); throw e; }
  // Which fields changed, by name only.
  audit("driver", prev ? "vault.updated" : "vault.added", { id: rid, name, site, kind, set: SLOTS.filter((s) => typeof input[s] === "string" && input[s]), allowed, always });
  return meta(one<VaultRow>("SELECT * FROM vault WHERE id=?", rid)!);
}
export function removeVault(id: string) {
  const r = one<VaultRow>("SELECT * FROM vault WHERE id=?", id);
  if (!r) throw httpErr(404, "No such secret");
  run("DELETE FROM vault WHERE id=?", id);
  for (const g of grants.values()) g.delete(id);
  audit("driver", "vault.removed", { id, name: r.name });
  return { removed: 1 };
}

// ---------- the crew's side: find by name, check, reveal at fill time ----------
export type Secret = Omit<VaultEntry, "has" | "allowed" | "always"> & { has: string[]; allowed: string[]; always: string[]; blob: string };
export function findSecret(name: string): Secret | null {
  const r = one<VaultRow>("SELECT * FROM vault WHERE name=? COLLATE NOCASE", String(name || "").trim());
  return r ? { ...meta(r), blob: r.blob } : null;
}
export const usableBy = (botId: string) => listVault().filter((s) => s.allowed.includes(botId));
// The page's host is the secret's site or a subdomain of it: accounts.bescom.co.in passes for bescom.co.in.
export const siteMatch = (host: string, site: string) => !!site && (host === site || host.endsWith(`.${site}`));
// The value to type for one field, decrypted (or the TOTP computed) at the moment of the fill.
export function reveal(s: Pick<Secret, "id" | "blob">, field: string, at = now()) {
  const v: Values = json(unseal(key(), s.blob, s.id), {}), raw = v[SLOT[field]];
  if (!raw) return null;
  if (field !== "totp") return raw;
  const t = parseTotp(raw);
  return t ? totp(t, at) : null;
}
export function markUsed(id: string, botId: string) { run("UPDATE vault SET last_used=?, last_used_by=? WHERE id=?", now(), botId, id); }

// Per-thread approvals ("Allow for this task"): in memory, like a site allowed once, so a restart asks again.
const grants = new Map<string, Set<string>>(); // thread id → secret ids
export const granted = (threadId: string, secretId: string) => !!grants.get(threadId)?.has(secretId);
export function applySecretChoice(ps: PitstopRow, status: string, scope: string) {
  const s = json(ps.detail, {}).secret;
  if (status !== "approved" || !s?.id || s.kind === "card") return;
  if (scope === "thread" && ps.thread_id) (grants.get(ps.thread_id) || grants.set(ps.thread_id, new Set()).get(ps.thread_id)!).add(s.id);
  if (scope === "always") {
    const r = one<VaultRow>("SELECT allowed, always FROM vault WHERE id=?", s.id);
    if (!r) return;
    const allowed = json<string[]>(r.allowed, []), always = json<string[]>(r.always, []);
    if (!always.includes(ps.bot_id)) run("UPDATE vault SET allowed=?, always=?, updated_at=? WHERE id=?", JSON.stringify([...new Set([...allowed, ps.bot_id])]), JSON.stringify([...always, ps.bot_id]), now(), s.id);
  }
  audit("driver", "vault.granted", { id: s.id, name: s.name, botId: ps.bot_id, threadId: ps.thread_id, scope });
}

// A sign-in that failed: flagged until the driver saves a new value, and no member fills it meanwhile. Returns true
// only the first time, so one failure opens one pit stop.
export function flagNeedsUpdate(id: string, why: string) {
  const r = run("UPDATE vault SET needs_update=? WHERE id=? AND needs_update IS NULL", why.slice(0, 200), id);
  if (r.changes) audit("crew", "vault.needs_update", { id, why: why.slice(0, 200) });
  return Number(r.changes) > 0;
}
// The same field of the same secret filled again in one thread within RETRY_MS of a fill that looked fine: the first
// one didn't work, so it's treated as a failure instead of a blind retry.
export const RETRY_MS = 10 * 60000;
const fills = new Map<string, { fields: Set<string>; at: number }>(); // `${thread}|${secret}` → last fill
export function isRetry(threadId: string, secretId: string, fields: string[]) {
  const f = fills.get(`${threadId}|${secretId}`);
  return !!f && now() - f.at < RETRY_MS && fields.some((x) => f.fields.has(x));
}
export function noteFill(threadId: string, secretId: string, fields: string[]) {
  const k = `${threadId}|${secretId}`, f = fills.get(k), fresh = f && now() - f.at < RETRY_MS;
  fills.set(k, { fields: new Set([...(fresh ? f.fields : []), ...fields]), at: now() });
}

// Values filled in a thread, for SCRUB_MS after the last fill: every browser result there (snapshots, page text, page JS
// output, network bodies, replays, errors) has them replaced with «secret» before the model, events or snapshot files
// see it. Passwords, one-time codes, card numbers and CVCs only, plus their JSON- and form-encoded spellings; a value
// transformed any other way (base64, split up) isn't caught, which is why page code that reads fields is also refused
// in the window (readsFields). In memory only. Per browser result: a few split/joins, nothing in threads with no fill.
export const SCRUB_MS = 30 * 60000, SCRUBBED = "«secret»";
export const SCRUB_FIELDS = new Set(["password", "totp", "card_number", "card_cvc"]);
const filled = new Map<string, { values: Set<string>; until: number }>(); // thread id → values
export function noteFilled(threadId: string, values: string[]) {
  const f = filled.get(threadId) || { values: new Set<string>(), until: 0 };
  // Under 4 characters (a 3-digit CVC) would blank every matching number on the page; those rely on the clear-after-submit.
  for (const v of values) if (v.length >= 4) for (const s of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+")]) f.values.add(s);
  f.until = now() + SCRUB_MS;
  filled.set(threadId, f);
}
export function scrubbing(threadId: string) {
  const f = filled.get(threadId);
  if (f && f.until < now()) filled.delete(threadId);
  return f && f.until >= now() ? [...f.values].sort((a, b) => b.length - a.length) : null;
}
export function scrubFilled<T extends string | null | undefined>(threadId: string, text: T): T {
  const vs = text ? scrubbing(threadId) : null;
  return vs ? (vs.reduce((t, v) => t.split(v).join(SCRUBBED), text as string) as T) : text;
}
// While a fill is fresh, what could lift a filled value past the scrubber is refused: page JS that reads form fields
// (deliberately broad: any .value, FormData or field selector), Playwright code (it runs in Node with the whole request
// log), and results saved straight to a file. Lasts only the scrub window; one regex per page-code call in it.
const READS = /password|passwd|\bpwd\b|\botp\b|totp|one.?time|\bcvc\b|\bcvv\b|card.?number|\.value\b|\bvalue\s*\(|inputValue|FormData|\.elements\b|getAttribute\(\s*["'`]value|\binput\b|textarea|aria-ref|\[ref=/i;
export function vaultRefusal(threadId: string, tool: string, args: Record<string, unknown>) {
  if (!/^browser_/.test(tool) || !scrubbing(threadId)) return null;
  const after = "for 30 minutes after a vault fill in this thread, so a filled secret can't be read back";
  if (tool === "browser_run_code_unsafe") return `Playwright code is off ${after}; use browser_evaluate or the page itself`;
  if (args.filename) return `saving a browser result to a file is off ${after} (the file would skip redaction); read it inline`;
  if (tool === "browser_evaluate" && READS.test(String(args.function ?? ""))) return `page JavaScript that reads form fields is refused ${after}`;
  return null;
}
