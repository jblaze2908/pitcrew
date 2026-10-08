// The Engram link (Engram milestones M3–M5): Engram's inbox mirrored as pit stops, the weekly digest, a token and MCP
// server per member, profile, skills and memories at thread start, remember/forget, journal entries and Library files
// after each session, and the one-shot memory move. Off until a link token is saved.
// Engram's answers are untrusted data: size-capped, zod-shaped, cut to length; tokens never leave the secret store.
import { readFileSync, realpathSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { one, all, run, now, json, audit, getSetting, setSetting, marks } from "./db.js";
import { getSecret, putSecret, deleteSecret, secretMeta, httpErr, type HttpError } from "./auth.js";
import { getBot, listBots } from "./crew.js";
import { botDir, allBrains } from "./computer.js";
import { DEFAULT_URL, LINK_SECRET, memberSecret, engramUrl, linked, normaliseUrl, engramEligible, memberLinked } from "./engramStore.js";
import { bus } from "./runtime/bus.js";
import { addEvent } from "./runtime/threads.js";
import { active } from "./runtime/state.js";
import { tainted } from "./runtime/taint.js";
import type { Bot, ArtifactFilter, PublishedPage, EngramDecision, EngramDigest, EngramMigration, EngramProposal, EngramStatus, PitStop } from "../shared/types.js";
import type { PitstopRow, MemoryRow } from "./models.js";

const MAX_BYTES = 2 << 20, FILE_MAX = 10 << 20, PROFILE_MAX = 6000, SKILLS_INDEX_MAX = 2000;
const POLL_MS = 60000, DIGEST_MS = 3600000, SYNC_MS = 5 * 60000;
const GONE = "Decided in Engram";
const TOKEN = /^[\x21-\x7e]{16,500}$/;

// ---------- HTTP ----------
const clean = (s: string, n: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, n);
type Upstream = HttpError & { upstream?: number };
interface CallOpts { method?: string; body?: unknown; token?: string | null; base?: string; timeoutMs?: number }
async function readCapped(res: Response) {
  const chunks: Buffer[] = []; let n = 0;
  if (res.body) for await (const ch of res.body as unknown as AsyncIterable<Uint8Array>) { n += ch.length; if (n > MAX_BYTES) throw httpErr(502, "Engram's answer was too large"); chunks.push(Buffer.from(ch)); }
  return Buffer.concat(chunks);
}
// One request to Engram's link API. redirect: "error" so the bearer never follows a redirect to another host.
async function call(path: string, { method = "GET", body, token, base = engramUrl(), timeoutMs = 10000 }: CallOpts = {}): Promise<unknown> {
  const key = token ?? getSecret(LINK_SECRET);
  if (!key) throw httpErr(400, "Engram isn't linked");
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { method, redirect: "error", signal: ctrl.signal, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
    const buf = await readCapped(res);
    let data: any = null; try { data = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch {}
    if (!res.ok) { const e: Upstream = httpErr(502, `Engram said ${res.status}${typeof data?.error === "string" ? `: ${clean(data.error, 160)}` : ""}`); e.upstream = res.status; throw e; }
    return data;
  } catch (e: any) {
    if (e.status) throw e;
    throw httpErr(502, `Couldn't reach Engram: ${e.name === "AbortError" ? "timed out" : clean(String(e.message), 120)}`);
  } finally { clearTimeout(t); }
}
function shape<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw httpErr(502, `Engram sent an unexpected ${what}`);
  return r.data;
}

// ---------- shapes (Engram's app/shared/types.ts, trimmed to what Pitcrew uses) ----------
const cut = (n: number) => z.string().transform((s) => clean(s, n));
// An array whose bad items are dropped, not fatal, then capped.
const list = <T extends z.ZodType>(item: T, n: number) => z.array(z.unknown()).catch([]).transform((a) => a.flatMap((x) => { const r = item.safeParse(x); return r.success ? [r.data as z.output<T>] : []; }).slice(0, n));
const Id = z.string().regex(/^[\w-]{1,100}$/);
const Src = z.object({ kind: cut(20), label: cut(200) }).nullish().catch(null);
const ProposalZ = z.object({
  id: Id, kind: cut(20), agent: z.string().nullish().catch(null), title: cut(300), scope: cut(20), area: cut(60).catch(""),
  data: z.record(z.string(), z.unknown()).nullish().catch(null), source: Src, reasons: list(cut(300), 10), held: z.boolean().catch(false),
  replaces: z.object({ text: cut(1000), source: Src }).nullish().catch(null), status: z.string().optional(),
});
const InboxZ = z.object({ proposals: z.array(z.unknown()).max(1000) });
const DigestZ = z.object({
  week: cut(20), from: cut(20), to: cut(20), built_at: z.number().catch(0),
  waiting: z.object({ open: z.number(), held: z.number() }).catch({ open: 0, held: 0 }),
  runningOut: list(z.object({ date: cut(20), text: cut(300), area: cut(60).catch("") }), 20),
  changed: list(z.object({ text: cut(300), detail: cut(300).catch(""), tone: z.enum(["normal", "bad"]).catch("normal") }), 20),
  openLoops: list(z.object({ text: cut(300), area: cut(60).catch("") }), 20),
  journal: list(z.object({ day: cut(20), lines: list(cut(300), 20) }), 7),
});
const NewTokenZ = z.object({ agent: z.object({ id: Id, token_prefix: z.string().max(40).nullish().catch(null) }), token: z.string().regex(TOKEN) });
const SkillZ = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), description: cut(200).transform((s) => s.replace(/\s+/g, " ").trim()).catch("") });
const ConnZ = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,11}$/), name: cut(60) });
const MemZ = z.object({ id: Id, text: cut(2000) });
const SyncZ = z.object({ profile: z.object({ text: z.string() }).catch({ text: "" }), skills: list(SkillZ, 30), connections: list(ConnZ, 50),
  memories: list(MemZ, 60).optional(), household: z.boolean().optional() });
const HouseholdZ = z.object({ household: z.boolean() });
const RememberZ = z.object({ status: z.enum(["accepted", "open", "held"]), id: Id, reasons: list(cut(300), 10) });
const MemListZ = z.object({ memories: list(MemZ.extend({ scope: cut(20).catch(""), area: cut(60).catch(""), created_at: z.number().catch(0), source: cut(200).catch("") }), 200) });
const ConnListZ = z.object({ connections: list(z.object({ id: ConnZ.shape.id, name: cut(60), status: z.enum(["ok", "warn", "signal"]).catch("warn"), detail: cut(200).catch(""),
  read: z.number().int().nonnegative().catch(0), write: z.number().int().nonnegative().catch(0) }), 50) });
const Url = z.string().max(400).regex(/^https:\/\/[^\s"<>]+$/);
// GET /link/artifacts: one artifact a member published, with its link state.
const LinkArtifactZ = z.object({ id: Id, title: z.string().max(300), kind: z.string().max(40), pitcrew_id: Id, version: z.number().int().positive(),
  mime: z.string().max(120).nullable(), size: z.number().nullable(), url: Url, public_url: Url.nullable(), share_pending: z.boolean(),
  ref: z.string().max(200).nullable(), created_at: z.number(), updated_at: z.number() });
// What deciding a share answers: Engram's proposal plus the artifact's link, now open to anyone.
const DecidedShareZ = z.object({ kind: z.literal("share"), public_url: Url, source: z.object({ ref: z.string().max(200).nullable().optional() }).nullable().optional() });
// What POST /link/artifacts answers: the artifact, its version, the private link and the public one once shared.
const PublishZ = z.object({ id: Id, version: z.number().int().positive(), url: Url, public_url: Url.nullable().catch(null), status: z.enum(["published", "share_pending"]) });

// ---------- settings ----------
let lastTest: EngramStatus["test"] = null, lastPoll: EngramStatus["poll"] = null;

async function testWith(base: string, token: string) {
  try {
    const r = shape(InboxZ, await call("/link/inbox", { base, token }), "inbox");
    lastTest = { ok: true, detail: `Linked · ${r.proposals.length} open in Engram's inbox`, at: now() };
  } catch (e: any) { lastTest = { ok: false, detail: e.upstream === 401 || e.upstream === 403 ? "Engram refused the token" : e.message, at: now() }; }
  return lastTest;
}
export const testLink = () => { const k = getSecret(LINK_SECRET); if (!k) throw httpErr(400, "Engram isn't linked"); return testWith(engramUrl(), k); };

// Nothing is saved unless Engram accepts the token. A new address drops the old address's member tokens.
export async function setLink(urlIn: unknown, tokenIn: unknown) {
  const url = normaliseUrl(urlIn || DEFAULT_URL);
  if (!urlIn && !DEFAULT_URL) throw httpErr(400, "Paste your Engram address");
  if (!url) throw httpErr(400, "Use an https:// address for Engram");
  const given = typeof tokenIn === "string" ? tokenIn.trim() : "", key = given || (url === engramUrl() ? getSecret(LINK_SECRET) : null);
  if (!key) throw httpErr(400, "Paste the link token from Engram → Agents → Link Pitcrew");
  if (!TOKEN.test(key)) throw httpErr(400, "That doesn't look like an Engram token");
  const t = await testWith(url, key);
  if (!t.ok) return status();
  if (url !== engramUrl()) dropMembers();
  setSetting("engram_url", url); putSecret(LINK_SECRET, key);
  audit("driver", "engram.linked", { url });
  await linkMissing();
  tick().catch(() => {});
  return status();
}

export function unlink() {
  dropMembers();
  deleteSecret(LINK_SECRET);
  run("DELETE FROM settings WHERE key='engram_digest'");
  for (const p of all<{ id: string }>("SELECT id FROM pitstops WHERE kind='engram' AND status='pending'")) closePit(p.id, "Engram unlinked");
  lastTest = lastPoll = null;
  audit("driver", "engram.unlinked");
  return status();
}
function dropMembers() {
  const ids = all<{ name: string }>("SELECT name FROM secrets WHERE name LIKE 'engram_member:%'").map((r) => r.name.slice("engram_member:".length));
  for (const id of ids) { deleteSecret(memberSecret(id)); restartIdle(id); }
  run("DELETE FROM engram_members"); run("DELETE FROM settings WHERE key LIKE 'engram_revoked:%'");
  synced.clear(); memCache.clear();
}

export function status(): EngramStatus {
  const meta = secretMeta(LINK_SECRET);
  const rows = new Map(all<{ bot_id: string; agent_id: string; token_prefix: string | null; created_at: number }>("SELECT * FROM engram_members").map((r) => [r.bot_id, r]));
  const sent = (kind: string) => one<{ n: number }>("SELECT COUNT(*) n FROM engram_sent WHERE kind=?", kind)!.n;
  return {
    linked: !!meta, url: engramUrl(), defaultUrl: DEFAULT_URL, updatedAt: meta?.updated_at ?? null, test: lastTest, poll: lastPoll,
    members: listBots().map((b) => {
      const r = secretMeta(memberSecret(b.id)) ? rows.get(b.id) : undefined;
      return { id: b.id, name: b.name, hue: b.hue, shape: b.shape, private: b.private, scope: b.engram_scope, eligible: engramEligible(b), linked: !!r, revoked: !r && revoked(b.id), agent: r?.agent_id ?? null, prefix: r?.token_prefix ?? null, at: r?.created_at ?? null };
    }),
    sent: { memories: sent("memory"), files: sent("file") }, migration: job,
  };
}

// ---------- members ----------
// Creates or rotates the member's Engram agent. Its new token reaches Codex at the next brain start, so an idle brain stops now.
// The connections picked at hire go once; Engram only applies them when it makes the agent, so your grant edits there stay.
export async function linkMember(b: Bot, by = "driver") {
  if (!engramEligible(b)) throw httpErr(400, `${b.name} is private: give its memories Money or Health in its profile to link it`);
  const hireKey = `engram_hire:${b.id}`, picked = json<unknown>(getSetting(hireKey), null), connections = Array.isArray(picked) ? picked : [];
  // Engram applies household only when it makes the agent; an existing one is toggled after (setHousehold).
  const had = one<{ household: number }>("SELECT household FROM engram_members WHERE bot_id=?", b.id);
  let res: unknown;
  try { res = await call("/link/members", { method: "POST", body: { pitcrew_id: b.id, name: b.name, hue: b.hue, area: null, scope: b.engram_scope, ...(connections.length ? { connections } : {}), ...(!had && b.engram_household ? { household: true } : {}) } }); }
  catch (e: any) {
    // Revoked in Engram: never retried on its own; the driver's Rotate asks again.
    // Its old token is dead too, so the member goes back to its own connectors.
    if (e.upstream === 409) { unlinkMember(b.id); setSetting(`engram_revoked:${b.id}`, "1"); throw httpErr(409, `${b.name} was revoked in Engram`); }
    throw e;
  }
  const r = shape(NewTokenZ, res, "member token");
  run("DELETE FROM settings WHERE key=?", `engram_revoked:${b.id}`);
  putSecret(memberSecret(b.id), r.token);
  run("INSERT INTO engram_members(bot_id,agent_id,token_prefix,created_at,scope,household) VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET agent_id=excluded.agent_id, token_prefix=excluded.token_prefix, created_at=excluded.created_at, scope=excluded.scope",
    b.id, r.agent.id, r.agent.token_prefix ?? null, now(), b.engram_scope, b.engram_household ? 1 : 0);
  run("DELETE FROM settings WHERE key=?", hireKey);
  audit(by, "engram.member.token", { botId: b.id, agent: r.agent.id, scope: b.engram_scope, connections });
  synced.delete(b.id); memCache.delete(b.id); restartIdle(b.id);
  if (had && !!had.household !== b.engram_household) await setHousehold(b, by).catch(() => {});
}
// Household facts are a grant on the member's existing Engram agent, so toggling it keeps the token.
export async function setHousehold(b: Bot, by = "driver") {
  const r = shape(HouseholdZ, await call(`/link/members/${encodeURIComponent(b.id)}/household`, { method: "POST", body: { household: b.engram_household } }), "household result");
  run("UPDATE engram_members SET household=? WHERE bot_id=?", r.household ? 1 : 0, b.id);
  audit(by, "engram.member.household", { botId: b.id, household: r.household });
}
// Called before a member's brain starts: a network call only when a linked member has no token, its scope changed, or
// its household grant differs from what Engram was last told.
export async function ensureMemberToken(b: Bot) {
  if (!linked() || !engramEligible(b) || revoked(b.id)) return;
  const m = one<{ scope: string | null; household: number }>("SELECT scope, household FROM engram_members WHERE bot_id=?", b.id);
  if (secretMeta(memberSecret(b.id)) && (m?.scope ?? "personal") === b.engram_scope) {
    if (m && !!m.household !== b.engram_household) await setHousehold(b, "system").catch(() => {});
    return;
  }
  await linkMember(b, "system").catch(() => {});
}
const revoked = (botId: string) => getSetting(`engram_revoked:${botId}`) === "1";
// A member turned private without its own scope leaves Engram: its token and its Engram MCP server go at the next brain start.
export function unlinkMember(botId: string) {
  if (!secretMeta(memberSecret(botId))) return;
  deleteSecret(memberSecret(botId)); run("DELETE FROM engram_members WHERE bot_id=?", botId);
  synced.delete(botId); memCache.delete(botId);
  audit("driver", "engram.member.unlinked", { botId }); restartIdle(botId);
}
// After a HIRE pit stop is approved: links whoever has no token yet (one POST per new member).
export async function linkMissing() {
  if (!linked()) return;
  for (const b of listBots()) await ensureMemberToken(b);
}
// After a hire, a privacy or a scope change, in the background: the member's next brain start has the right connectors.
export function memberChanged(b: Bot | undefined) {
  if (!b || !linked()) return;
  if (!engramEligible(b)) unlinkMember(b.id); else ensureMemberToken(b).catch(() => {});
}
function restartIdle(botId: string) {
  const br = allBrains().find((x) => x.bot.id === botId);
  if (br?.up && ![...active.keys()].some((t) => one("SELECT 1 FROM threads WHERE id=? AND bot_id=?", t, botId))) br.stop();
}

// ---------- inbox mirror ----------
const pitView = (p: PitstopRow): PitStop => ({ ...p, detail: json(p.detail, {}), jev: {}, learn: null });
function emitPit(id: string) {
  const p = one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id);
  if (p) bus.emit("pitstop", { id, botId: p.bot_id, threadId: null, status: p.status, pitstop: pitView(p) });
}
function closePit(id: string, note: string) {
  run("UPDATE pitstops SET status='expired', note=?, decided_at=? WHERE id=? AND status='pending'", note, now(), id);
  emitPit(id);
}
function toProposal(x: z.output<typeof ProposalZ>): EngramProposal {
  const text = typeof x.data?.text === "string" ? clean(x.data.text, 1000) : null;
  return { id: x.id, kind: x.kind, title: x.title, scope: x.scope, area: x.area, reasons: x.reasons, held: x.held, text,
    source: x.source ? { kind: x.source.kind, label: x.source.label } : null, replaces: x.replaces ? { text: x.replaces.text, source: x.replaces.source?.label ?? null } : null };
}
// One proposal, one pit stop (id eg_<proposal id>), however often it is seen. One that comes back after a "gone" reopens.
function openProposal(x: z.output<typeof ProposalZ>, agents: Map<string, string>) {
  const id = `eg_${x.id}`, prev = one<{ status: string; note: string | null }>("SELECT status, note FROM pitstops WHERE id=?", id);
  if (prev) {
    if (prev.status !== "expired" || prev.note !== GONE) return false;
    run("UPDATE pitstops SET status='pending', note=NULL, decided_at=NULL WHERE id=?", id);
  } else {
    const botId = (x.agent && agents.get(x.agent)) || "chief";
    run("INSERT INTO pitstops(id,bot_id,thread_id,turn_id,kind,effect,title,detail,jev,created_at,expires_at) VALUES(?,?,NULL,NULL,'engram','engram',?,?,'{}',?,?)",
      id, botId, x.title || "Engram proposal", JSON.stringify({ proposal: toProposal(x) }), now(), now() + 365 * 86400000);
    audit("engram", "pitstop.opened", { id, kind: "engram", title: x.title });
  }
  emitPit(id);
  return true;
}
export async function mirrorInbox() {
  const inbox = shape(InboxZ, await call("/link/inbox"), "inbox");
  const agents = new Map(all<{ bot_id: string; agent_id: string }>("SELECT bot_id, agent_id FROM engram_members").map((r) => [r.agent_id, r.bot_id]));
  const present = new Set<string>(); let opened = 0, closed = 0;
  for (const raw of inbox.proposals as any[]) {
    if (typeof raw?.id === "string" && (raw.status === undefined || raw.status === "open")) present.add(raw.id);
    const p = ProposalZ.safeParse(raw);
    // Engram's nightly tidy-ups (kind "dream", up to 20 a night) are reviewed in Engram's own inbox, not as pit stops.
    if (p.success && p.data.kind !== "dream" && p.data.scope !== "private" && (!p.data.status || p.data.status === "open") && openProposal(p.data, agents)) opened++;
  }
  // Global notes wait for the driver (memory tiers, 2026-10-04): nothing here accepts on their behalf.
  for (const ps of all<{ id: string; detail: string }>("SELECT id, detail FROM pitstops WHERE kind='engram' AND status='pending'"))
    if (!present.has(json(ps.detail, {}).proposal?.id)) { closePit(ps.id, GONE); closed++; }
  return { open: present.size, opened, closed };
}

export async function decideProposal(id: string, decision: EngramDecision, { auto = false } = {}) {
  const ps = one<PitstopRow>("SELECT * FROM pitstops WHERE id=? AND kind='engram'", id);
  if (!ps) throw httpErr(404, "No such pit stop");
  if (ps.status !== "pending") return pitView(ps);
  const pid = String(json(ps.detail, {}).proposal?.id || "");
  let res: unknown;
  try { res = await call(`/link/inbox/${encodeURIComponent(pid)}`, { method: "POST", body: { decision } }); }
  catch (e: any) { if (e.upstream === 404 || e.upstream === 409) { closePit(id, GONE); return pitView(one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id)!); } throw e; }
  const shared = decision === "accept" ? DecidedShareZ.safeParse(res) : null;
  const publicUrl = shared?.success ? shared.data.public_url : null;
  const note = publicUrl ? "Anyone with the link can open it" : decision === "accept" ? (auto ? "Saved automatically" : "Accepted") : decision === "keep" ? "Kept current" : "Rejected";
  const detail = publicUrl ? JSON.stringify({ ...json(ps.detail, {}), public_url: publicUrl }) : ps.detail;
  run("UPDATE pitstops SET status=?, scope='once', note=?, detail=?, decided_at=? WHERE id=? AND status='pending'", decision === "accept" ? "approved" : "denied", note, detail, now(), id);
  // The member that asked learns the link in its thread, so it can hand it on.
  const th = shared?.success && /^pitcrew:thread:(th_[\w-]{1,40})$/.exec(shared.data.source?.ref || "")?.[1];
  if (publicUrl && th && one("SELECT 1 FROM threads WHERE id=?", th))
    addEvent(th, null, "system", { text: `Anyone with the link can now open “${clean(ps.title.replace(/^Make public: /, ""), 200)}”: ${publicUrl}` });
  audit(auto ? "system" : "driver", `engram.${decision}`, { id, title: ps.title, ...(auto ? { auto: true } : {}) });
  emitPit(id);
  return pitView(one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id)!);
}

// The Library's Published tab: one Engram call per view or filter change, ≤ 100 rows a page; Engram filters and pages.
// Engram is the record, so revoked links and forgotten files drop out; a member deleted here keeps its files under its id.
export async function listArtifacts(f: ArtifactFilter = {}): Promise<PublishedPage> {
  const empty: PublishedPage = { items: [], next: null, counts: { total: 0, waiting: 0, imported: 0 } };
  if (!linked()) return empty;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  const r = shape(z.object({ artifacts: z.array(z.unknown()).max(100), next: z.string().max(120).nullable(),
    counts: z.object({ total: z.number().int(), waiting: z.number().int(), imported: z.number().int() }) }),
    await call(`/link/artifacts${qs.size ? `?${qs}` : ""}`), "artifact list");
  const bots = new Map(listBots().map((b) => [b.id, b]));
  const items = r.artifacts.flatMap((x) => {
    const a = LinkArtifactZ.safeParse(x); if (!a.success) return [];
    const b = bots.get(a.data.pitcrew_id), th = /^pitcrew:thread:(th_[\w-]{1,40})$/.exec(a.data.ref || "")?.[1];
    const { pitcrew_id, ref, ...rest } = a.data;
    return [{ ...rest, title: clean(rest.title, 200), imported: !ref, bot_id: pitcrew_id, bot_name: b?.name ?? pitcrew_id, hue: b?.hue ?? null, shape: b?.shape ?? null,
      thread_id: th && one("SELECT 1 FROM threads WHERE id=?", th) ? th : null }];
  });
  return { items, next: r.next, counts: r.counts };
}

// ---------- digest ----------
type Cached = { at: number; digest: EngramDigest };
let digesting: Promise<unknown> | null = null;
export async function refreshDigest() {
  const d = shape(DigestZ, await call("/link/digest"), "digest");
  setSetting("engram_digest", JSON.stringify({ at: now(), digest: d }));
  return d;
}
// Fetched at most hourly (the poll refreshes it); a failed refresh keeps showing the last digest.
export async function digest(): Promise<Cached | null> {
  if (!linked()) return null;
  const c = json<Cached | null>(getSetting("engram_digest"), null);
  if (!c || now() - c.at > DIGEST_MS) try { await (digesting ??= refreshDigest().finally(() => { digesting = null; })); } catch {}
  return json<Cached | null>(getSetting("engram_digest"), null) ?? c;
}

// ---------- profile and skills at thread start ----------
interface Ctx { profile: string | null; skills: { name: string; description: string }[]; connections?: Record<string, string> }
const synced = new Map<string, { tried: number; good: Ctx | null }>();
// Per thread start or resume (never per turn), 4 s timeout: a new thread or a /refresh (fresh) always asks; a resume
// at most once per member per 5 minutes. A failure keeps the last good bundle. Skills are names only (bodies load via
// get("skill:<name>"); nothing on disk); the Chief also gets the profile, cut on a line to PROFILE_MAX.
export async function threadContext(b: Bot, fresh = false): Promise<Ctx | null> {
  if (!memberLinked(b)) return null;
  let s = synced.get(b.id);
  if (fresh || !s || now() - s.tried > SYNC_MS) {
    const tried = now();
    try {
      const bundle = shape(SyncZ, await call(`/link/sync?pitcrew_id=${encodeURIComponent(b.id)}`, { timeoutMs: 4000 }), "sync bundle");
      s = { tried, good: { profile: fitProfile(bundle.profile.text), skills: bundle.skills, connections: Object.fromEntries(bundle.connections.map((c) => [c.id, c.name])) } };
      if (bundle.memories) memCache.set(b.id, new Map(bundle.memories.map((m) => [m.id, m.text])));
      if (bundle.household !== undefined) adoptHousehold(b.id, bundle.household);
    } catch { s = { tried, good: s?.good ?? null }; }
    synced.set(b.id, s);
  }
  return s.good && { profile: b.kind === "chief" ? s.good.profile : null, skills: s.good.skills };
}
// A household grant changed in Engram itself (not what Pitcrew last sent) becomes the member's setting here too.
function adoptHousehold(botId: string, h: boolean) {
  const m = one<{ household: number }>("SELECT household FROM engram_members WHERE bot_id=?", botId);
  if (!m || !!m.household === h) return;
  run("UPDATE engram_members SET household=? WHERE bot_id=?", h ? 1 : 0, botId);
  run("UPDATE bots SET engram_household=? WHERE id=?", h ? 1 : 0, botId);
  audit("engram", "engram.member.household", { botId, household: h });
}
function fitProfile(text: string) {
  const t = clean(text, 1 << 20).trim();
  if (t.length <= PROFILE_MAX) return t || null;
  return `${t.slice(0, t.lastIndexOf("\n", PROFILE_MAX) > 0 ? t.lastIndexOf("\n", PROFILE_MAX) : PROFILE_MAX)}\n(cut to fit)`;
}
// A connection's name for an Engram tool step ("google__gmail_search" → "Google (Gmail, Calendar, Drive)"), from the last
// sync of that member; null before the first one. A map lookup, per tool event.
export const connName = (botId: string, tool: string) => { const id = /^([a-z0-9-]+)__/.exec(tool)?.[1]; return (id && synced.get(botId)?.good?.connections?.[id]) || null; };
export const skillsIndex = (skills: Ctx["skills"]) => {
  let out = "";
  for (const s of skills) { const line = `- ${s.name}${s.description ? ` — ${s.description}` : ""}\n`; if (out.length + line.length > SKILLS_INDEX_MAX) break; out += line; }
  return out.trimEnd();
};

// ---------- memories: a linked member keeps its own in Engram ----------
// Per member: its own active memories as of the last sync, kept current by remember/forget here. Turns read this map,
// so a normal turn makes no Engram call; memories added in Engram itself arrive with the next sync (≤ 5 min on resume).
const memCache = new Map<string, Map<string, string>>();
// null before the first good sync: the caller then sends no memory list rather than an empty one.
export const engramMemories = (botId: string) => { const m = memCache.get(botId); return m ? [...m].map(([id, text]) => ({ id, text })) : null; };

// One POST per remember. In a thread that read untrusted content Engram holds it for review instead of accepting it.
export async function remember(b: Bot, text: string, { id = null, threadId = null, by = "member", validUntil = null, review = false }: { id?: string | null; threadId?: string | null; by?: "member" | "driver"; validUntil?: string | null; review?: boolean } = {}) {
  const cache = memCache.get(b.id), supersedes = id && cache?.has(id) ? id : null;
  const res = shape(RememberZ, await call("/link/memories", { method: "POST", body: { pitcrew_id: b.id, text, supersedes,
    ...(threadId ? { ref: `pitcrew:thread:${threadId}` } : {}), ...(validUntil ? { valid_until: validUntil } : {}), untrusted: tainted(threadId), by, ...(review ? { review: true } : {}) } }), "memory result");
  // Engram answers a restatement with the existing id; known marks it so "Learned this run" won't offer to undo it.
  const known = res.status === "accepted" && !supersedes && !!cache?.has(res.id);
  if (res.status === "accepted" && cache) { if (supersedes) cache.delete(supersedes); cache.set(res.id, text); }
  else if (res.status !== "accepted") mirrorInbox().catch(() => {});
  audit(by === "driver" ? "driver" : b.id, `engram.remember.${res.status}`, { botId: b.id, id: res.id, threadId });
  return { ...res, replaced: res.status === "accepted" ? supersedes : null, known };
}
export async function forget(b: Bot, id: string, by = "member") {
  if (!/^[\w-]{1,100}$/.test(id)) throw httpErr(400, "No such memory");
  await call(`/link/memories/${encodeURIComponent(id)}/forget`, { method: "POST", body: { pitcrew_id: b.id } });
  memCache.get(b.id)?.delete(id);
  audit(by === "driver" ? "driver" : b.id, "engram.forget", { botId: b.id, id });
}
// The member's Memory tab: one GET per view.
export async function listMemories(b: Bot) {
  return shape(MemListZ, await call(`/link/memories?pitcrew_id=${encodeURIComponent(b.id)}`), "memory list").memories;
}
// The hire form's connection picker: what a new member could read through Engram.
export async function listConnections() {
  if (!linked()) return [];
  return shape(ConnListZ, await call("/link/connections"), "connection list").connections;
}

// ---------- Move memories to Engram ----------
let job: EngramMigration = { running: false, line: "", startedAt: null, endedAt: null, summary: null };
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const wasSent = (botId: string, kind: string, ref: string) => !!one("SELECT 1 FROM engram_sent WHERE bot_id=? AND kind=? AND ref=?", botId, kind, ref);
const markSent = (botId: string, kind: string, ref: string) => run("INSERT OR IGNORE INTO engram_sent(bot_id,kind,ref,sent_at) VALUES(?,?,?,?)", botId, kind, ref, now());
// Read inside the member's workspace only: the path resolves under work/ and the file itself is no link.
function readWork(botId: string, rel: string) {
  const base = realpathSync(`${botDir(botId)}/work`), full = realpathSync(`${base}/${rel}`);
  if (!full.startsWith(base + "/")) return null;
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = fstatSync(fd); return st.isFile() && st.size <= FILE_MAX ? readFileSync(fd) : null; } finally { closeSync(fd); }
}

// ---------- artifacts: one workspace file published to Engram ----------
// Private to the driver; public only once they approve the share (Engram's inbox, mirrored as a pit stop). Passing the
// id of an artifact this member published makes a new version at the same link. One POST per publish, ≤ 10 MB.
export async function publishFile(b: Bot, path: string, o: { title?: string; id?: string | null; public?: boolean; description?: string; threadId?: string | null } = {}) {
  const rel = path.replace(/^\/bot\/work\//, "").replace(/^\.?\/+/, "");
  if (!rel || rel.split("/").includes("..")) throw httpErr(400, "Give a file under /bot/work");
  let buf: Buffer | null = null;
  try { buf = readWork(b.id, rel); } catch { throw httpErr(404, `No file at /bot/work/${clean(rel, 200)}`); }
  if (!buf) throw httpErr(400, `Not a file under /bot/work, or over 10 MB: ${clean(rel, 200)}`);
  const id = o.id && /^[\w-]{1,100}$/.test(o.id) ? o.id : undefined;
  const res = shape(PublishZ, await call("/link/artifacts", { method: "POST", timeoutMs: 60000, body: {
    pitcrew_id: b.id, title: clean(o.title || basename(rel), 200), filename: clean(basename(rel), 120), content_base64: buf.toString("base64"),
    ...(id ? { id } : {}), ...(o.description ? { description: clean(o.description, 2000) } : {}), ...(o.public ? { public: true } : {}),
    ...(o.threadId ? { ref: `pitcrew:thread:${o.threadId}` } : {}) } }), "publish result");
  if (res.status === "share_pending") mirrorInbox().catch(() => {});
  audit(b.id, "engram.published", { botId: b.id, id: res.id, version: res.version, path: rel, share: res.status === "share_pending" });
  return res;
}

export const migration = () => job;
// Runs in the background; GET /api/engram shows its progress line. Private members without their own scope are skipped, and nothing in
// Pitcrew is deleted. What was sent is recorded, so a second run sends only what's new (Engram dedupes as well).
export function startMigration() {
  if (!linked()) throw httpErr(400, "Link Engram first");
  if (job.running) return job;
  job = { running: true, line: "Starting…", startedAt: now(), endedAt: null, summary: [] };
  migrating = migrate().catch((e) => { job.line = `Stopped: ${e.message}`; }).finally(() => {
    job.running = false; job.endedAt = now();
    audit("driver", "engram.migrated", { members: job.summary?.map((s) => ({ name: s.name, memories: s.memories, files: s.files, failed: s.failed })) });
  });
  return job;
}
let migrating: Promise<void> | null = null;
export const migrationDone = () => migrating;
async function migrate() {
  for (const b of listBots().filter(engramEligible)) {
    const row = { name: b.name, memories: 0, files: 0, skipped: 0, tooBig: 0, failed: 0 };
    job.summary!.push(row);
    if (!secretMeta(memberSecret(b.id))) try { await linkMember(b); } catch (e: any) { job.line = `${b.name}: ${e.message}`; }
    const mems = all<Pick<MemoryRow, "id" | "text" | "created_at">>("SELECT id,text,created_at FROM memory WHERE bot_id=? AND forgotten_at IS NULL ORDER BY created_at", b.id);
    const ref = (m: { id: string; text: string }) => `${m.id}:${sha(m.text).slice(0, 16)}`;
    const todo = mems.filter((m) => !wasSent(b.id, "memory", ref(m)));
    row.skipped += mems.length - todo.length;
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      job.line = `${b.name}: memories ${i + batch.length} of ${todo.length}`;
      try {
        const res: any = await call("/link/import/memories", { method: "POST", timeoutMs: 30000, body: { pitcrew_id: b.id, items: batch.map((m) => ({ text: m.text, created_at: m.created_at })) } });
        for (const m of batch) markSent(b.id, "memory", ref(m));
        const dup = Number.isInteger(res?.duplicates) ? Math.min(res.duplicates, batch.length) : 0;
        row.memories += batch.length - dup; row.skipped += dup;
      } catch { row.failed += batch.length; }
    }
  }
  const t = job.summary!.reduce((a, s) => ({ m: a.m + s.memories, x: a.x + s.failed }), { m: 0, x: 0 });
  job.line = `Done: ${t.m} memories sent${t.x ? `, ${t.x} failed (run it again to retry)` : ""}.`;
}

// ---------- journal: one entry per session ----------
// A session is a thread's turns until it has been idle 15 min. Its entry says what was asked, what ran and how it ended,
// and links the thread, its plan and the artifacts it published. Looks back 24 h at most.
const EPISODE_IDLE = 15 * 60000, EPISODE_LOOKBACK = 24 * 3600000, EPISODES_PER_TICK = 10;
type TurnRow = { id: string; status: string; cost_usd: number | null; changes: string | null; ended_at: number };
const STEP: Record<string, string> = { commandExecution: "shell", fileChange: "edits", webSearch: "web search", dynamicToolCall: "tools" };
async function sendEpisodes() {
  const t = now(), since = t - EPISODE_LOOKBACK;
  // Only linked members' threads, so skipped ones can't hold the per-tick slots (they did: 4 sent, 42 stuck behind 6).
  const ids = listBots().filter((b) => memberLinked(b)).map((b) => b.id);
  if (!ids.length) return;
  // Per tick: one grouped read of the last day's turns (indexed by nothing; a single user's day is small).
  const due = all<{ thread_id: string; bot_id: string; last: number; upto: number | null }>(
    `SELECT tu.thread_id, tu.bot_id, MAX(tu.ended_at) last, ep.upto FROM turns tu LEFT JOIN engram_episodes ep ON ep.thread_id=tu.thread_id
     WHERE tu.ended_at > ? AND tu.bot_id IN (${marks(ids)}) GROUP BY tu.thread_id HAVING last < ? AND last > COALESCE(ep.upto, 0) ORDER BY last LIMIT ?`,
    since, ...ids, t - EPISODE_IDLE, EPISODES_PER_TICK * 3);
  let sent = 0;
  for (const d of due) {
    if (sent >= EPISODES_PER_TICK) break;
    const b = getBot(d.bot_id);
    if (!b || active.has(d.thread_id)) continue;
    const from = Math.max(d.upto ?? 0, since);
    const turns = all<TurnRow>("SELECT id, status, cost_usd, changes, ended_at FROM turns WHERE thread_id=? AND ended_at > ? AND ended_at <= ? ORDER BY started_at", d.thread_id, from, d.last);
    if (!turns.length) continue;
    try { await sendEpisode(b, d.thread_id, turns, from); }
    catch (e: any) { if (e.upstream === 404) return; continue; } // an Engram without /link/episodes: try again next tick
    run("INSERT INTO engram_episodes(thread_id,upto) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET upto=excluded.upto", d.thread_id, d.last);
    sent++;
  }
}
async function sendEpisode(b: Bot, threadId: string, turns: TurnRow[], from: number) {
  const ids = turns.map((x) => x.id), qs = marks(ids);
  const title = one<{ title: string }>("SELECT title FROM threads WHERE id=?", threadId)?.title || "Thread";
  const ev = (kind: string, order: string) => json<{ text?: string; display?: string }>(one<{ data: string }>(`SELECT data FROM events WHERE thread_id=? AND kind=? AND (turn_id IN (${qs}) OR (turn_id IS NULL AND ts > ?)) ORDER BY id ${order} LIMIT 1`, threadId, kind, ...ids, from)?.data, {});
  const steps = all<{ type: string; n: number }>(`SELECT COALESCE(json_extract(data,'$.server'), json_extract(data,'$.type')) type, COUNT(*) n FROM events WHERE thread_id=? AND kind='tool' AND turn_id IN (${qs}) GROUP BY 1 ORDER BY 2 DESC`, threadId, ...ids);
  const files = turns.flatMap((x) => json<{ path: string; status: string }[] | null>(x.changes, null) ?? []).filter((c) => c.status !== "deleted");
  const cost = turns.reduce((a, x) => a + (x.cost_usd || 0), 0), last = turns.at(-1)!;
  const outputs: { kind: string; ref: string; label: string }[] = [{ kind: "thread", ref: `pitcrew:thread:${threadId}`, label: clean(title, 200) }];
  const plan = one<{ id: string; goal: string; status: string; answer: string | null }>("SELECT id, goal, status, answer FROM plans WHERE thread_id=? ORDER BY created_at DESC LIMIT 1", threadId);
  if (plan) outputs.push({ kind: "plan", ref: `pitcrew:plan:${plan.id}`, label: clean(plan.goal, 200) });
  // What publish_file put out in this session (its thread events), one link per artifact.
  const published = all<{ id: string; title: string }>(`SELECT DISTINCT json_extract(data,'$.artifact.id') id, json_extract(data,'$.artifact.title') title FROM events
    WHERE thread_id=? AND kind='system' AND turn_id IN (${qs}) AND json_extract(data,'$.artifact.id') IS NOT NULL`, threadId, ...ids);
  for (const a of published.slice(0, 18)) outputs.push({ kind: "artifact", ref: a.id, label: clean(a.title || a.id, 200) });
  // Engram keeps episodes up to 20,000 chars (e96a015); these caps stay under it, so outcomes arrive whole, not cut at 600.
  const asked = ev("user", "ASC"), reply = ev("agent", "DESC").text || "";
  const text = [`${b.name} · ${title}`,
    asked.display || asked.text ? `Asked: ${clean(asked.display || asked.text || "", 2000)}` : "",
    `Ran: ${turns.length} ${turns.length === 1 ? "run" : "runs"}${steps.length ? ` · ${steps.map((s) => `${STEP[s.type] || s.type} ${s.n}`).join(", ")}` : ""}${files.length ? ` · ${files.length} ${files.length === 1 ? "file" : "files"} changed` : ""} · $${cost.toFixed(2)}`,
    plan ? `Plan: ${clean(plan.goal, 200)} (${plan.status})${plan.answer ? `. Answer: ${clean(plan.answer, 4000)}` : ""}` : "",
    last.status !== "completed" ? `Last run ${last.status}.` : "",
    reply ? `Ended with: ${clean(reply, 12000)}` : ""].filter(Boolean).join("\n");
  await call("/link/episodes", { method: "POST", body: { pitcrew_id: b.id, text, at: last.ended_at, outputs } });
}

// ---------- the poll ----------
let ticking = false;
// Every 60 s: when unlinked, one secret lookup and nothing else; linked, one GET /link/inbox, the digest when stale, and
// a journal entry for each session that went idle (sendEpisodes).
export async function tick() {
  if (!linked() || ticking) return;
  ticking = true;
  try {
    const r = await mirrorInbox();
    lastPoll = { ok: true, detail: `${r.open} open in Engram`, at: now() };
  } catch (e: any) { lastPoll = { ok: false, detail: e.message, at: now() }; }
  try { await digest(); } catch {}
  try { await sendEpisodes(); } catch {} finally { ticking = false; }
}
export function startEngram() { setInterval(() => { tick().catch(() => {}); }, POLL_MS).unref(); setTimeout(() => { tick().catch(() => {}); }, 5000).unref(); }
