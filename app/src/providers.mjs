// Model providers: OpenRouter and Vercel AI Gateway by key, ChatGPT by device-code sign-in.
// Keys are write-only: stored encrypted, tested, never returned to the browser.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, chownSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { getSecret, putSecret, deleteSecret, secretMeta } from "./auth.mjs";
import { ROOT, IMAGE, chatgptAuthPath } from "./computer.mjs";
import { audit } from "./db.mjs";

export const PROVIDERS = {
  openrouter: { label: "OpenRouter", secret: "openrouter" },
  aigateway: { label: "Vercel AI Gateway", secret: "aigateway" },
  openai: { label: "ChatGPT plan", secret: null },
};
// Measured working on the ChatGPT plan in the POC (2026-09-30).
const CHATGPT_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
export const DEFAULT_MODEL = { openrouter: "anthropic/claude-sonnet-5.5", aigateway: "anthropic/claude-sonnet-5.5", openai: "gpt-6-astra" };

export function providerStatus() {
  const s = {};
  for (const [k, p] of Object.entries(PROVIDERS)) {
    if (p.secret) { const m = secretMeta(p.secret); s[k] = { label: p.label, connected: !!m, updatedAt: m?.updated_at ?? null, test: lastTest[k] ?? null }; }
    else s[k] = { label: p.label, connected: existsSync(chatgptAuthPath()), updatedAt: existsSync(chatgptAuthPath()) ? statSync(chatgptAuthPath()).mtimeMs : null, login: loginState.public() };
  }
  return s;
}
export const providerReady = (p) => (PROVIDERS[p]?.secret ? !!secretMeta(PROVIDERS[p].secret) : existsSync(chatgptAuthPath()));

const lastTest = {};
async function timed(url, init = {}, ms = 15000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

export async function testKey(provider, key) {
  let r;
  try {
    if (provider === "openrouter") {
      const res = await timed("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
      const body = await res.json().catch(() => ({}));
      r = res.ok ? { ok: true, detail: `Key works${body.data?.limit != null ? ` · limit $${body.data.limit}` : ""}` } : { ok: false, detail: `OpenRouter said ${res.status}: ${body.error?.message || "rejected"}` };
    } else if (provider === "aigateway") {
      const models = await (await timed("https://ai-gateway.vercel.sh/v1/models")).json().catch(() => ({ data: [] }));
      const cheap = (models.data || []).find((m) => /flash-lite|nano|mini|haiku/.test(m.id))?.id || models.data?.[0]?.id;
      const res = await timed("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: cheap, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) });
      const body = await res.json().catch(() => ({}));
      r = res.ok ? { ok: true, detail: `Key works (${cheap})` } : { ok: false, detail: `AI Gateway said ${res.status}: ${String(body.error?.message || "rejected").slice(0, 160)}` };
    } else throw new Error("unknown provider");
  } catch (e) { r = { ok: false, detail: `Couldn't reach ${PROVIDERS[provider]?.label}: ${e.message}` }; }
  lastTest[provider] = { ...r, at: Date.now() };
  return r;
}

export async function setKey(provider, key) {
  const p = PROVIDERS[provider];
  if (!p?.secret) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  if (typeof key !== "string" || key.trim().length < 10 || key.length > 400) throw Object.assign(new Error("That doesn't look like a key"), { status: 400 });
  const r = await testKey(provider, key.trim());
  // A key that fails its test is still saved when the failure is billing-side (AI Gateway 403), so the driver can fix billing later.
  if (r.ok || provider === "aigateway") putSecret(p.secret, key.trim());
  audit("driver", "provider.key.set", { provider, ok: r.ok });
  return r;
}
export function removeKey(provider) { const p = PROVIDERS[provider]; if (p?.secret) deleteSecret(p.secret); audit("driver", "provider.key.removed", { provider }); }

// Model catalogue + list prices, cached 6 h. Price per token in USD.
let catalog = { at: 0, openrouter: [], aigateway: [] };
export async function models(provider) {
  if (provider === "openai") return CHATGPT_MODELS.map((id) => ({ id, name: id, price: null }));
  if (Date.now() - catalog.at > 6 * 3600 * 1000) {
    try {
      const [or, gw] = await Promise.all([
        timed("https://openrouter.ai/api/v1/models").then((r) => r.json()).catch(() => ({ data: [] })),
        timed("https://ai-gateway.vercel.sh/v1/models").then((r) => r.json()).catch(() => ({ data: [] })),
      ]);
      catalog = {
        at: Date.now(),
        openrouter: (or.data || []).map((m) => ({ id: m.id, name: m.name, ctx: m.context_length, price: m.pricing ? { in: +m.pricing.prompt, out: +m.pricing.completion, cached: +(m.pricing.input_cache_read ?? m.pricing.prompt) } : null })),
        aigateway: (gw.data || []).map((m) => ({ id: m.id, name: m.name || m.id, ctx: m.context_window, price: m.pricing ? { in: +m.pricing.input, out: +m.pricing.output, cached: +(m.pricing.input_cache_read ?? m.pricing.input) } : null })),
      };
    } catch {}
  }
  return catalog[provider] || [];
}

// Cost of one turn at list price; ChatGPT-plan turns cost nothing extra.
export async function estimateCost(provider, model, u) {
  if (provider === "openai") return { usd: 0, basis: "plan" };
  const m = (await models(provider)).find((x) => x.id === model);
  if (!m?.price || Number.isNaN(m.price.in)) return { usd: 0, basis: "unknown" };
  const fresh = Math.max(0, u.input - u.cached);
  return { usd: fresh * m.price.in + u.cached * m.price.cached + u.output * m.price.out, basis: "list" };
}

// What OpenRouter itself reports for the key (a cross-check on our estimates).
export async function openrouterUsage() {
  const key = getSecret("openrouter");
  if (!key) return null;
  try { const b = await (await timed("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } })).json(); return b.data || null; } catch { return null; }
}

// Sign in with ChatGPT by device code: `codex login --device-auth` in a throwaway computer with only /auth mounted.
const loginState = {
  proc: null, url: null, code: null, status: "idle", error: null, startedAt: null,
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
  const scan = (d) => {
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
