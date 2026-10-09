// Model providers: OpenRouter and Vercel AI Gateway by key, ChatGPT by device-code sign-in.
// Keys are write-only: stored encrypted, tested, never returned to the browser.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, chownSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { getSecret, putSecret, deleteSecret, secretMeta, httpErr } from "./auth.js";
import { ROOT, IMAGE, chatgptAuthPath } from "./computer.js";
import { audit, getSetting, setSetting, json } from "./db.js";
import type { ProviderId, ProviderStatus } from "../shared/types.js";

export const PROVIDERS: Record<ProviderId, { label: string; secret: string | null }> = {
  openrouter: { label: "OpenRouter", secret: "openrouter" },
  aigateway: { label: "Vercel AI Gateway", secret: "aigateway" },
  openai: { label: "ChatGPT plan", secret: null },
};
// Measured working on the ChatGPT plan in the POC (2026-09-30).
const CHATGPT_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
export const DEFAULT_MODEL: Record<ProviderId, string> = { openrouter: "anthropic/claude-sonnet-5.5", aigateway: "anthropic/claude-sonnet-5.5", openai: "gpt-6-astra" };
const known = (p: string) => PROVIDERS[p as ProviderId] as (typeof PROVIDERS)[ProviderId] | undefined;

// Runs on every /api/state: one secret read per keyed provider, one stat for the ChatGPT sign-in.
export function providerStatus() {
  const s = {} as Record<ProviderId, ProviderStatus>;
  for (const [k, p] of Object.entries(PROVIDERS) as [ProviderId, (typeof PROVIDERS)[ProviderId]][]) {
    if (p.secret) { const m = secretMeta(p.secret); s[k] = { label: p.label, connected: !!m, updatedAt: m?.updated_at ?? null, test: lastTest[k] ?? null }; }
    else { let at: number | null = null; try { at = statSync(chatgptAuthPath()).mtimeMs; } catch {} s[k] = { label: p.label, connected: at != null, updatedAt: at, login: loginState.public() }; }
  }
  return s;
}
// Claude Code is a worker, not a model provider: members hand it tasks (runtime/claude.ts). Its login is written by
// deploy/claude-login.sh and only stat'ed here: on every thread's tool-list build and on Settings → Models.
export const claudeDir = () => `${ROOT}/claude`;
// All four answered on the driver's plan in Claude Code 2.1.287, at low and at max effort (checked 2026-10-09).
export const CLAUDE_MODELS = [{ id: "claude-fable-5-1", label: "Fable 5.1" }, { id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { id: "claude-haiku-5-5", label: "Haiku 5.5" }];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export function claudeStatus() {
  try { return { connected: true, updatedAt: statSync(`${claudeDir()}/.credentials.json`).mtimeMs }; } catch { return { connected: false, updatedAt: null as number | null }; }
}
export const providerReady = (p: string) => { const x = known(p); return x?.secret ? !!secretMeta(x.secret) : existsSync(chatgptAuthPath()); };

const lastTest: Partial<Record<string, { ok: boolean; detail: string; at: number }>> = {};
async function timed(url: string, init: RequestInit = {}, ms = 15000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

export async function testKey(provider: string, key: string) {
  let r: { ok: boolean; detail: string };
  try {
    if (provider === "openrouter") {
      const res = await timed("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
      const body: any = await res.json().catch(() => ({}));
      r = res.ok ? { ok: true, detail: `Key works${body.data?.limit != null ? ` · limit $${body.data.limit}` : ""}` } : { ok: false, detail: `OpenRouter said ${res.status}: ${body.error?.message || "rejected"}` };
    } else if (provider === "aigateway") {
      const models: any = await (await timed("https://ai-gateway.vercel.sh/v1/models")).json().catch(() => ({ data: [] }));
      const cheap = (models.data || []).find((m: { id: string }) => /flash-lite|nano|mini|haiku/.test(m.id))?.id || models.data?.[0]?.id;
      const res = await timed("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: cheap, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) });
      const body: any = await res.json().catch(() => ({}));
      r = res.ok ? { ok: true, detail: `Key works (${cheap})` } : { ok: false, detail: `AI Gateway said ${res.status}: ${String(body.error?.message || "rejected").slice(0, 160)}` };
    } else throw new Error("unknown provider");
  } catch (e: any) { r = { ok: false, detail: `Couldn't reach ${known(provider)?.label}: ${e.message}` }; }
  lastTest[provider] = { ...r, at: Date.now() };
  return r;
}

export async function setKey(provider: string, key: unknown) {
  const p = known(provider);
  if (!p?.secret) throw httpErr(400, "Unknown provider");
  if (typeof key !== "string" || key.trim().length < 10 || key.length > 400) throw httpErr(400, "That doesn't look like a key");
  const r = await testKey(provider, key.trim());
  // A key that fails its test is still saved when the failure is billing-side (AI Gateway 403), so the driver can fix billing later.
  if (r.ok || provider === "aigateway") { putSecret(p.secret, key.trim()); forgetOpenrouterUsage(); }
  audit("driver", "provider.key.set", { provider, ok: r.ok });
  return r;
}
export function removeKey(provider: string) { const p = known(provider); if (p?.secret) deleteSecret(p.secret); forgetOpenrouterUsage(); audit("driver", "provider.key.removed", { provider }); }

// Model catalogue + list prices, cached 6 h. Price per token in USD.
export interface Model { id: string; name: string; ctx?: number; price: { in: number; out: number; cached: number } | null }
let catalog: { at: number; openrouter: Model[]; aigateway: Model[] } = { at: 0, openrouter: [], aigateway: [] };
export async function models(provider: string): Promise<Model[]> {
  if (provider === "openai") return CHATGPT_MODELS.map((id) => ({ id, name: id, price: null }));
  if (Date.now() - catalog.at > 6 * 3600 * 1000) {
    try {
      const [or, gw] = await Promise.all([
        timed("https://openrouter.ai/api/v1/models").then((r) => r.json() as Promise<any>).catch(() => ({ data: [] })),
        timed("https://ai-gateway.vercel.sh/v1/models").then((r) => r.json() as Promise<any>).catch(() => ({ data: [] })),
      ]);
      catalog = {
        at: Date.now(),
        openrouter: (or.data || []).map((m) => ({ id: m.id, name: m.name, ctx: m.context_length, price: m.pricing ? { in: +m.pricing.prompt, out: +m.pricing.completion, cached: +(m.pricing.input_cache_read ?? m.pricing.prompt) } : null })),
        aigateway: (gw.data || []).map((m) => ({ id: m.id, name: m.name || m.id, ctx: m.context_window, price: m.pricing ? { in: +m.pricing.input, out: +m.pricing.output, cached: +(m.pricing.input_cache_read ?? m.pricing.input) } : null })),
      };
    } catch {}
  }
  return catalog[provider as "openrouter" | "aigateway"] || [];
}

// Cost of one turn at list price; ChatGPT-plan turns cost nothing extra.
export async function estimateCost(provider: string, model: string, u: { input: number; cached: number; output: number }) {
  if (provider === "openai") return { usd: 0, basis: "plan" };
  const m = (await models(provider)).find((x) => x.id === model);
  if (!m?.price || Number.isNaN(m.price.in)) return { usd: 0, basis: "unknown" };
  const fresh = Math.max(0, u.input - u.cached);
  return { usd: fresh * m.price.in + u.cached * m.price.cached + u.output * m.price.out, basis: "list" };
}

// What OpenRouter itself reports for the key (a cross-check on our estimates). Every telemetry view asks, so one
// outbound call a minute serves them all; concurrent askers share the in-flight call. A key change clears it.
let orUsage: { at: number; p: Promise<any> | null } = { at: 0, p: null };
export const forgetOpenrouterUsage = () => { orUsage = { at: 0, p: null }; };
export function openrouterUsage() {
  if (orUsage.p && Date.now() - orUsage.at < 60000) return orUsage.p;
  const key = getSecret("openrouter");
  if (!key) return Promise.resolve(null);
  // /credits (account balance) answers only management keys; an ordinary key gets 403 and we show its own cap instead.
  const get = (path: string) => timed(`https://openrouter.ai/api/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => (r.ok ? r.json() : {})).then((b: any) => b.data || null, () => null);
  orUsage = { at: Date.now(), p: Promise.all([get("key"), get("credits")]).then(([k, c]) => k && { ...k, balance: c ? c.total_credits - c.total_usage : null, credits: c ? { total: c.total_credits, used: c.total_usage } : null }) };
  return orUsage.p;
}

// ChatGPT plan usage as Codex reports it: primary is the 5-hour window, secondary the weekly one. Kept in settings so the
// last reading survives restarts; Codex pushes a fresh one after each turn on the plan. s is Codex's rateLimits payload.
const pickWindow = (w: any) => w && { usedPercent: w.usedPercent, windowMins: w.windowDurationMins ?? null, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null };
export function recordChatgptLimits(s: any) {
  if (!s || (s.limitId && s.limitId !== "codex") || (!s.primary && !s.secondary && !s.credits)) return;
  const prev = chatgptLimits() || {};  // an update may carry one window only; keep the other's last reading
  setSetting("chatgpt_limits", JSON.stringify({ at: Date.now(), plan: s.planType ?? prev.plan ?? null, primary: pickWindow(s.primary) ?? prev.primary ?? null, secondary: pickWindow(s.secondary) ?? prev.secondary ?? null,
    credits: s.credits ? { has: s.credits.hasCredits, unlimited: s.credits.unlimited, balance: s.credits.balance ?? null } : prev.credits ?? null, reached: s.rateLimitReachedType ?? null }));
}
export function chatgptLimits() { return json(getSetting("chatgpt_limits")); }

// Sign in with ChatGPT by device code: `codex login --device-auth` in a throwaway computer with only /auth mounted.
const loginState = {
  proc: null as ChildProcess | null, url: null as string | null, code: null as string | null, status: "idle", error: null as string | null, startedAt: null as number | null,
  public() { return { status: this.status, url: this.url, code: this.code, error: this.error, startedAt: this.startedAt }; },
};
export function startChatgptLogin() {
  if (loginState.proc) return loginState.public();
  const dir = `${ROOT}/chatgpt`;
  mkdirSync(dir, { recursive: true }); chownSync(dir, 1500, 1500); chmodSync(dir, 0o770);
  Object.assign(loginState, { url: null, code: null, status: "starting", error: null, startedAt: Date.now() });
  const proc = spawn("docker", ["run", "-i", "--rm", "--name", "pc-chatgpt-login", "--label", "pitcrew=computer", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/home/crew:uid=1500,gid=1500", "-e", "CODEX_HOME=/auth", "-v", `${dir}:/auth`, "--entrypoint", "codex", IMAGE, "login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
  loginState.proc = proc;
  let out = "";
  const scan = (d: Buffer) => {
    out += d.toString().replace(/\x1b\[[0-9;]*m/g, "");
    loginState.url ||= /https:\/\/\S+device\S*/.exec(out)?.[0] || null;
    loginState.code ||= /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(out)?.[1] || null;
    if (loginState.url && loginState.code) loginState.status = "waiting";
  };
  proc.stdout.on("data", scan); proc.stderr.on("data", scan);
  const killer = setTimeout(() => proc.kill(), 16 * 60 * 1000);
  proc.on("exit", (code) => {
    clearTimeout(killer); loginState.proc = null;
    if (code === 0 && existsSync(chatgptAuthPath())) { loginState.status = "connected"; chownSync(chatgptAuthPath(), 1500, 1500); chmodSync(chatgptAuthPath(), 0o660); audit("driver", "provider.chatgpt.connected"); }
    else { loginState.status = "failed"; loginState.error = out.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200) || `exit ${code}`; }
  });
  return loginState.public();
}
export function cancelChatgptLogin() { loginState.proc?.kill(); loginState.status = "idle"; }
export function signOutChatgpt() { try { unlinkSync(chatgptAuthPath()); } catch {} loginState.status = "idle"; audit("driver", "provider.chatgpt.signed_out"); }
