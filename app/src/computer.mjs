// One computer per crew member: a hardened, throwaway container running the desktop and `codex app-server`.
// The control plane speaks JSON-RPC to Codex over the container's stdio. State lives in /srv/pitcrew/bots/<id>.
import { spawn, execFile } from "node:child_process";
import { mkdirSync, chownSync, writeFileSync, existsSync, lstatSync, symlinkSync, unlinkSync, copyFileSync, statSync, readdirSync } from "node:fs";
import { getSecret } from "./auth.mjs";

export const ROOT = process.env.PITCREW_ROOT || "/srv/pitcrew";
export const IMAGE = process.env.PITCREW_COMPUTER_IMAGE || "pitcrew-computer:1";
const CREW_UID = 1500;
const MAX_UP = Number(process.env.PITCREW_MAX_COMPUTERS || 3);
const IDLE_MS = Number(process.env.PITCREW_IDLE_MS || 10 * 60 * 1000);

export const botDir = (id) => `${ROOT}/bots/${id}`;
export const chatgptAuthPath = () => `${ROOT}/chatgpt/auth.json`;
const docker = (args) => new Promise((res) => execFile("docker", args, { timeout: 60000 }, (err, out, errOut) => res({ ok: !err, out: String(out || ""), err: String(errOut || "") })));

function ensureDirs(id) {
  const base = botDir(id);
  for (const d of ["", "/work", "/work/downloads", "/work/out", "/work/uploads", "/profile", "/codex", "/run", "/config"]) {
    mkdirSync(base + d, { recursive: true });
    chownSync(base + d, CREW_UID, CREW_UID);
  }
}

// Codex reads providers and MCP servers from CODEX_HOME/config.toml; regenerated on every start.
function writeConfig(bot) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    `# Written by the Pitcrew control plane at computer start. Edits here are overwritten.`,
    `[model_providers.openrouter]`, `name = "OpenRouter"`, `base_url = "https://openrouter.ai/api/v1"`, `env_key = "OPENROUTER_API_KEY"`, `wire_api = "responses"`, ``,
    `[model_providers.aigateway]`, `name = "Vercel AI Gateway"`, `base_url = "https://ai-gateway.vercel.sh/v1"`, `env_key = "AI_GATEWAY_API_KEY"`, `wire_api = "responses"`, ``,
    `[mcp_servers.browser]`, `command = "playwright-mcp"`, `args = ["--cdp-endpoint", "http://127.0.0.1:9222"]`,
    `env = { PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright" }`, `tool_timeout_sec = 90`, ``,
    `[mcp_servers.computer]`, `command = "node"`, `args = ["/opt/pitcrew/computer-mcp.mjs"]`, `env = { DISPLAY = ":1" }`, `tool_timeout_sec = 60`, ``,
  ];
  for (const m of bot.mcp || []) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(m.name) || !/^https:\/\//.test(m.url)) continue;
    lines.push(`[mcp_servers.${m.name}]`, `url = ${q(m.url)}`, ...(m.tokenSecret ? [`bearer_token_env_var = ${q("MCP_TOKEN_" + m.name.toUpperCase().replace(/-/g, "_"))}`] : []), ``);
  }
  const p = `${botDir(bot.id)}/codex/config.toml`;
  writeFileSync(p, lines.join("\n"));
  chownSync(p, CREW_UID, CREW_UID);
}

// ChatGPT auth: one shared auth.json, symlinked in. If Codex refreshed it by replacing the link with a file, copy it back.
function linkChatgpt(id) {
  const link = `${botDir(id)}/codex/auth.json`;
  try { if (lstatSync(link)) unlinkSync(link); } catch {}
  if (existsSync(chatgptAuthPath())) symlinkSync("/auth/auth.json", link);
}
function reclaimChatgpt(id) {
  const local = `${botDir(id)}/codex/auth.json`;
  try {
    const st = lstatSync(local);
    if (st.isFile() && (!existsSync(chatgptAuthPath()) || st.mtimeMs > statSync(chatgptAuthPath()).mtimeMs)) {
      copyFileSync(local, chatgptAuthPath());
      chownSync(chatgptAuthPath(), CREW_UID, CREW_UID);
    }
  } catch {}
}

export class Computer {
  constructor(bot, hooks) {
    this.bot = bot; this.hooks = hooks;
    this.proc = null; this.ready = null; this.pending = new Map(); this.nextId = 1;
    this.loaded = new Set(); this.lastActive = Date.now(); this.startedAt = null; this.viewers = 0;
  }
  get name() { return `pc-bot-${this.bot.id}`; }
  get up() { return !!this.proc; }

  ensure() {
    this.lastActive = Date.now();
    if (!this.ready) this.ready = this.#start().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async #start() {
    await makeRoom(this);
    const b = this.bot, id = b.id;
    ensureDirs(id); writeConfig(b); linkChatgpt(id);
    const net = `pc-net-${id}`;
    if (!(await docker(["network", "inspect", net])).ok) await docker(["network", "create", "--label", "pitcrew=computer", net]);
    await docker(["rm", "-f", this.name]);
    const env = { PATH: process.env.PATH };
    const envArgs = [];
    const orKey = getSecret("openrouter"), gwKey = getSecret("aigateway");
    if (orKey) { env.OPENROUTER_API_KEY = orKey; envArgs.push("-e", "OPENROUTER_API_KEY"); }
    if (gwKey) { env.AI_GATEWAY_API_KEY = gwKey; envArgs.push("-e", "AI_GATEWAY_API_KEY"); }
    for (const m of b.mcp || []) if (m.tokenSecret) {
      const v = getSecret(m.tokenSecret), n = "MCP_TOKEN_" + m.name.toUpperCase().replace(/-/g, "_");
      if (v) { env[n] = v; envArgs.push("-e", n); }
    }
    const mounts = ["-v", `${botDir(id)}:/bot`];
    if (existsSync(chatgptAuthPath())) mounts.push("-v", `${ROOT}/chatgpt:/auth`);
    // Keys reach the container as `-e NAME` read from this process's env, never on the command line.
    const args = ["run", "-i", "--rm", "--name", this.name, "--hostname", id.slice(0, 20).replace(/[^a-z0-9-]/gi, "-"), "--label", "pitcrew=computer",
      "--cpus", "1.5", "--memory", "2g", "--pids-limit", "768", "--shm-size", "512m",
      "--read-only", "--tmpfs", "/tmp:size=768m,mode=1777", "--tmpfs", `/home/crew:size=128m,uid=${CREW_UID},gid=${CREW_UID},mode=700`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", net, ...mounts, ...envArgs, IMAGE, "codex", "app-server"];
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.proc = proc; this.startedAt = Date.now();
    this.hooks.onState?.(this);
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        this.#dispatch(msg);
      }
    });
    let errTail = "";
    proc.stderr.on("data", (d) => { errTail = (errTail + d).slice(-4000); });
    proc.on("exit", (code) => {
      this.proc = null; this.ready = null; this.loaded.clear(); this.startedAt = null;
      for (const p of this.pending.values()) p.reject(new Error(`computer stopped (exit ${code})`));
      this.pending.clear();
      reclaimChatgpt(id);
      this.hooks.onExit?.(this, code, errTail);
      this.hooks.onState?.(this);
    });
    await this.request("initialize", { clientInfo: { name: "pitcrew", title: "Pitcrew", version: "1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 120000);
    this.notify("initialized", {});
    return this;
  }

  async #dispatch(msg) {
    this.lastActive = Date.now();
    if (msg.id !== undefined && msg.method) {
      let reply;
      try {
        const result = await this.hooks.onRequest(this, msg.method, msg.params);
        reply = result === undefined ? { id: msg.id, error: { code: -32601, message: "unhandled" } } : { id: msg.id, result };
      } catch (e) { reply = { id: msg.id, error: { code: -32000, message: String(e.message).slice(0, 200) } }; }
      this.#write(reply);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      msg.error ? p?.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpc: msg.error })) : p?.resolve(msg.result);
    } else if (msg.method) {
      this.hooks.onNotify(this, msg.method, msg.params || {});
    }
  }
  #write(obj) { this.proc?.stdin.write(JSON.stringify(obj) + "\n"); }
  request(method, params, timeoutMs = 60000) {
    if (!this.proc) return Promise.reject(new Error("computer is not running"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.#write({ id, method, params });
    });
  }
  notify(method, params) { this.#write({ method, params }); }
  async stop() { if (this.proc) await docker(["stop", "-t", "5", this.name]); }
}

const computers = new Map();
export const allComputers = () => [...computers.values()];
export function computerFor(bot, hooks) {
  let c = computers.get(bot.id);
  if (!c) { c = new Computer(bot, hooks); computers.set(bot.id, c); }
  c.bot = bot;
  return c;
}

// the host has ~7.7 GB; each computer idles at ~300 MiB and grows with pages. Stop the stalest idle one to make room.
async function makeRoom(self) {
  const up = allComputers().filter((c) => c.up && c !== self);
  if (up.length < MAX_UP) return;
  const idle = up.filter((c) => !self.hooks.isBusy(c) && c.viewers === 0).sort((a, b) => a.lastActive - b.lastActive);
  if (!idle.length) throw new Error(`All ${MAX_UP} computers are busy. Try again when a crew member finishes.`);
  await idle[0].stop();
}

// Runs once a minute: nothing persistent runs, so an idle computer goes back to the garage.
export function startIdleSweeper(isBusy) {
  setInterval(() => {
    for (const c of allComputers()) if (c.up && !isBusy(c) && c.viewers === 0 && Date.now() - c.lastActive > IDLE_MS) c.stop();
  }, 60000).unref();
}

// Containers from a previous control-plane process lost their stdio; remove them at boot.
export async function reapOrphans() {
  const r = await docker(["ps", "-aq", "--filter", "label=pitcrew=computer"]);
  const ids = r.out.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
}

// Library: files the crew made or downloaded, listed from the bot's workspace (bounded walk).
export function listFiles(id) {
  const base = `${botDir(id)}/work`, out = [];
  const walk = (rel, depth) => {
    if (depth > 4 || out.length > 500) return;
    let ents = [];
    try { ents = readdirSync(`${base}/${rel}`, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile()) { const st = statSync(`${base}/${r}`); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); }
    }
  };
  walk("", 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}
export { ensureDirs, docker };
