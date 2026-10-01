// Brain and computer for each crew member.
//   Brain: a Codex app-server per crew member inside the shared `pitcrew-brain` container (docker exec, stdio JSON-RPC).
//          It holds keys and threads; chat-only turns never touch a computer.
//   Computer: a hardened throwaway container per crew member, booted only when a turn first needs a runtime.
//          Stage 1 runs Codex's exec-server (the brain's shell and apply_patch execute here, via the exec gateway).
//          Stage 2, the desktop and Chromium, boots on the first browser or pixel tool.
// State lives on the host: /srv/pitcrew/bots/<id> (the computer's /bot) and /srv/pitcrew/brains/<id> (Codex home).
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, chownSync, chmodSync, writeFileSync, existsSync, lstatSync, symlinkSync, unlinkSync, copyFileSync, statSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { getSecret } from "./auth.js";
import { execFs } from "./execfs.js";
import { policyMount } from "./domains.js";
import type { Bot } from "../shared/types.js";
import type { ToolManifest, McpTool } from "./crew.js";

export const ROOT = process.env.PITCREW_ROOT || "/srv/pitcrew";
export const IMAGE = process.env.PITCREW_COMPUTER_IMAGE || "pitcrew-computer:1";
const BRAIN = process.env.PITCREW_BRAIN_CONTAINER || "pitcrew-brain";
const CODEX_BIN = "/opt/pitcrew/brain/codex"; // brain/Dockerfile links it to the native binary
const CREW_UID = 1500;
const MAX_UP = Number(process.env.PITCREW_MAX_COMPUTERS || 3);
const IDLE_MS = Number(process.env.PITCREW_IDLE_MS || 10 * 60 * 1000);
const BRAIN_IDLE_MS = 20 * 60 * 1000;
const HEX: Record<string, string> = { c1: "#4f7dff", c2: "#16c2c2", c3: "#2fcc80", c5: "#ff6fab", c6: "#9577ff" };

export const botDir = (id: string) => `${ROOT}/bots/${id}`;
// Inside the computer; on the host under botDir, so the control plane can read Playwright's snapshot files.
export const PW_OUT = "/bot/run/playwright";
// Playwright MCP waits this long after each action for triggered work (default 500 ms; click 589-620 → 196-226 ms, measured).
export const PW_SETTLE_MS = 100;
export const brainDir = (id: string) => `${ROOT}/brains/${id}`;
export const usageLog = (id: string) => `${ROOT}/brains/_usage/${id}.jsonl`;
export const chatgptAuthPath = () => `${ROOT}/chatgpt/auth.json`;
const docker = (args: string[], opts: { timeout?: number } = {}) => new Promise<{ ok: boolean; out: string; err: string }>((res) => execFile("docker", args, { timeout: 120000, ...opts }, (err, out, errOut) => res({ ok: !err, out: String(out || ""), err: String(errOut || "") })));
// Each crew member's Codex runs as its own uid, so a stray local shell couldn't read another member's threads.
export const brainUid = (id: string) => 20000 + (parseInt(createHash("sha1").update(id).digest("hex").slice(0, 6), 16) % 30000);

function ensureDirs(id: string) {
  const base = botDir(id);
  for (const d of ["", "/work", "/work/downloads", "/work/out", "/work/uploads", "/profile", "/run", "/config"]) {
    mkdirSync(base + d, { recursive: true });
    chownSync(base + d, CREW_UID, CREW_UID);
  }
}
// v1 kept Codex's home inside the computer's mount; move it out so threads resume and the computer can't read them.
function migrateCodexHome(id: string, uid: number) {
  const old = `${botDir(id)}/codex`, d = brainDir(id);
  if (existsSync(d) || !existsSync(old)) return;
  mkdirSync(`${ROOT}/brains`, { recursive: true });
  renameSync(old, d);
  try { unlinkSync(`${d}/auth.json`); } catch {}
  const own = (p: string) => { chownSync(p, uid, CREW_UID); if (statSync(p).isDirectory()) for (const e of readdirSync(p)) { const q = `${p}/${e}`; if (lstatSync(q).isSymbolicLink()) continue; own(q); } };
  own(d);
}
function ensureBrainDir(b: { id: string }) {
  const uid = brainUid(b.id), d = brainDir(b.id);
  migrateCodexHome(b.id, uid);
  mkdirSync(`${ROOT}/brains/_usage`, { recursive: true }); chownSync(`${ROOT}/brains/_usage`, CREW_UID, CREW_UID); chmodSync(`${ROOT}/brains/_usage`, 0o700);
  for (const x of ["", "/home"]) { mkdirSync(d + x, { recursive: true }); chownSync(d + x, uid, CREW_UID); }
  chmodSync(d, 0o700);
  return uid;
}

// Codex config for one crew member's brain; regenerated at every brain start.
function writeBrainConfig(b: Bot) {
  const q = (s: string) => JSON.stringify(String(s));
  const lines = [
    `# Written by the Pitcrew control plane at brain start. Edits here are overwritten.`,
    // With ChatGPT auth, Codex pulls the account's apps and plugins (Gmail, Drive…) into every thread: ~100k tokens of
    // tools per request (measured 2026-10-01) and authority no crew member was granted. Pitcrew supplies browser and
    // computer tools itself, behind jev.
    // Built-ins Pitcrew never serves: goal tools, request_user_input (answered "unhandled") and the skills catalogue.
    // ~7 KB less per model request (measured 2026-10-01, codex 0.156.1, keys checked with --strict-config).
    `[features]`, ...["apps", "plugins", "remote_plugin", "plugin_sharing", "recommended_plugins", "tool_suggest", "skill_mcp_dependency_install",
      "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "multi_agent", "realtime_conversation", "goals"].map((f) => `${f} = false`),
    `tool_call_mcp_elicitation = true`, ``,
    `[skills]`, `include_instructions = false`, ``, `[tools.experimental_request_user_input]`, `enabled = false`, ``,
    // Model traffic goes through the brain's loopback proxy: Anthropic prompt caching + billed-cost tap.
    `[model_providers.openrouter]`, `name = "OpenRouter"`, `base_url = "http://127.0.0.1:8788/${b.id}/openrouter"`, `env_key = "OPENROUTER_API_KEY"`, `wire_api = "responses"`, ``,
    `[model_providers.aigateway]`, `name = "Vercel AI Gateway"`, `base_url = "http://127.0.0.1:8788/${b.id}/aigateway"`, `env_key = "AI_GATEWAY_API_KEY"`, `wire_api = "responses"`, ``,
  ];
  for (const m of b.mcp || []) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(m.name) || !/^https:\/\//.test(m.url)) continue;
    lines.push(`[mcp_servers.${m.name}]`, `url = ${q(m.url)}`, ...(m.tokenSecret ? [`bearer_token_env_var = ${q("MCP_TOKEN_" + m.name.toUpperCase().replace(/-/g, "_"))}`] : []), ``);
  }
  const p = `${brainDir(b.id)}/config.toml`;
  writeFileSync(p, lines.join("\n"));
  chownSync(p, brainUid(b.id), CREW_UID);
}

// ChatGPT auth: one shared auth.json, symlinked into each brain home. If Codex refreshed it by replacing the link, copy it back.
function linkChatgpt(id: string) {
  const link = `${brainDir(id)}/auth.json`;
  try { if (lstatSync(link)) unlinkSync(link); } catch {}
  if (existsSync(chatgptAuthPath())) symlinkSync("/auth/auth.json", link);
}
function reclaimChatgpt(id: string) {
  const local = `${brainDir(id)}/auth.json`;
  try {
    const st = lstatSync(local);
    if (st.isFile() && (!existsSync(chatgptAuthPath()) || st.mtimeMs > statSync(chatgptAuthPath()).mtimeMs)) { copyFileSync(local, chatgptAuthPath()); chownSync(chatgptAuthPath(), CREW_UID, CREW_UID); chmodSync(chatgptAuthPath(), 0o660); }
  } catch {}
}

// ---------- JSON-RPC over a child's stdio (shared by brain sessions and MCP clients) ----------
type Handlers = { onRequest?: (method: string, params: any) => unknown; onNotify?: (method: string, params: any) => void; onExit?: (code: number | null, errTail: string) => void; name: string };
export class Rpc {
  proc: ChildProcessWithoutNullStreams; name: string; closed = false;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(); nextId = 1;
  constructor(proc: ChildProcessWithoutNullStreams, { onRequest, onNotify, onExit, name }: Handlers) {
    this.proc = proc; this.pending = new Map(); this.nextId = 1; this.name = name;
    let buf = "", errTail = "";
    proc.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        this.#dispatch(msg, onRequest, onNotify);
      }
    });
    proc.stderr.on("data", (d) => { errTail = (errTail + d).slice(-4000); });
    proc.on("exit", (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${name} stopped (exit ${code})`));
      this.pending.clear();
      onExit?.(code, errTail);
    });
  }
  async #dispatch(msg: any, onRequest: Handlers["onRequest"], onNotify: Handlers["onNotify"]) {
    if (msg.id !== undefined && msg.method) {
      let reply;
      try { const result = await onRequest?.(msg.method, msg.params); reply = result === undefined ? { id: msg.id, error: { code: -32601, message: "unhandled" } } : { id: msg.id, result }; }
      catch (e: any) { reply = { id: msg.id, error: { code: -32000, message: String(e.message).slice(0, 200) } }; }
      this.write(reply);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      msg.error ? p?.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpc: msg.error })) : p?.resolve(msg.result);
    } else if (msg.method) onNotify?.(msg.method, msg.params || {});
  }
  write(obj: unknown) { if (!this.closed) this.proc.stdin.write(JSON.stringify(obj) + "\n"); }
  request<T = any>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${this.name} is not running`));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
}

// ---------- brain session (one Codex app-server per crew member) ----------
export interface BrainHooks {
  onNotify: (br: Brain, method: string, params: any) => void;
  onRequest: (br: Brain, method: string, params: any) => unknown;
  onBrainExit?: (br: Brain, code: number | null, errTail: string) => void;
}
export class Brain {
  bot: Bot; hooks: BrainHooks; rpc: Rpc | null = null; ready: Promise<Brain> | null = null; loaded = new Set<string>(); lastActive = Date.now();
  // mems: codex thread id → Map(memory id → text) that thread has been told, so a turn can pass only what changed.
  mems = new Map<string, Map<string, string>>();
  constructor(bot: Bot, hooks: BrainHooks) { this.bot = bot; this.hooks = hooks; }
  get up() { return !!this.rpc && !this.rpc.closed; }
  ensure() {
    this.lastActive = Date.now();
    if (!this.ready) this.ready = this.#start().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  // Starts a stopped brain without refreshing a running one's idle clock (the thread view calls this on every open).
  prewarm() { if (!this.ready) this.ensure().catch(() => {}); }
  async #start() {
    const b = this.bot, uid = ensureBrainDir(b);
    ensureDirs(b.id); writeBrainConfig(b); linkChatgpt(b.id);
    const env: Record<string, string | undefined> = { PATH: process.env.PATH }, envArgs = ["-e", `CODEX_HOME=/brains/${b.id}`, "-e", `HOME=/brains/${b.id}/home`];
    const put = (k: string, v: string | null) => { if (v) { env[k] = v; envArgs.push("-e", k); } };
    put("OPENROUTER_API_KEY", getSecret("openrouter")); put("AI_GATEWAY_API_KEY", getSecret("aigateway"));
    for (const m of b.mcp || []) if (m.tokenSecret) put("MCP_TOKEN_" + m.name.toUpperCase().replace(/-/g, "_"), getSecret(m.tokenSecret));
    // Keys reach the brain as `-e NAME` read from this process's env, never on the command line; computers never get them.
    // The native binary, not npm's node wrapper: ~45 ms and ~47 MB RSS less per member. The image sets the wrapper's env.
    const proc = spawn("docker", ["exec", "-i", "--user", `${uid}:${CREW_UID}`, "-w", `/brains/${b.id}`, ...envArgs, BRAIN, CODEX_BIN, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
    this.rpc = new Rpc(proc, {
      name: "brain",
      onRequest: (m, p) => { this.lastActive = Date.now(); return this.hooks.onRequest(this, m, p); },
      onNotify: (m, p) => { this.lastActive = Date.now(); this.hooks.onNotify(this, m, p); },
      onExit: (code, tail) => { this.rpc = null; this.ready = null; this.loaded.clear(); this.mems.clear(); reclaimChatgpt(b.id); this.hooks.onBrainExit?.(this, code, tail); },
    });
    await this.rpc.request("initialize", { clientInfo: { name: "pitcrew", title: "Pitcrew", version: "1.1" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 60000);
    this.rpc.notify("initialized", {});
    // Lazy: Codex connects only when a turn first runs a command; the gateway then boots the computer.
    await this.rpc.request("environment/add", { environmentId: "computer", execServerUrl: `ws://127.0.0.1:7700/${b.id}` });
    return this;
  }
  request<T = any>(method: string, params: unknown, t?: number): Promise<T> { this.lastActive = Date.now(); return this.rpc ? this.rpc.request<T>(method, params, t) : Promise.reject(new Error("brain is not running")); }
  async stop() { if (this.rpc) this.rpc.proc.kill(); }
}

// One-shot Codex app-server under its own CODEX_HOME that asks OpenAI for the plan's usage, so it counts use from anywhere
// on the account, not only Pitcrew's runs, and Codex refreshes the token itself. Per call: one docker exec + one backend read.
const LIMITS = { id: "_limits" };
export async function readPlanLimits() {
  if (!existsSync(chatgptAuthPath())) return null;
  const uid = ensureBrainDir(LIMITS); linkChatgpt(LIMITS.id);
  const proc = spawn("docker", ["exec", "-i", "--user", `${uid}:${CREW_UID}`, "-w", `/brains/${LIMITS.id}`, "-e", `CODEX_HOME=/brains/${LIMITS.id}`, "-e", `HOME=/brains/${LIMITS.id}/home`, BRAIN, CODEX_BIN, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new Rpc(proc, { name: "limits", onExit: () => reclaimChatgpt(LIMITS.id) });
  try {
    await rpc.request("initialize", { clientInfo: { name: "pitcrew", title: "Pitcrew", version: "1.1" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 15000);
    rpc.notify("initialized", {});
    const r = await rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true }, 15000);
    return r.rateLimitsByLimitId?.codex ?? r.rateLimits;
  } finally { proc.stdin.end(); setTimeout(() => proc.kill(), 5000).unref(); }  // EOF lets Codex exit after saving a refreshed token
}

// ---------- computer (machine) ----------
export interface ComputerHooks {
  isBusy: (c: Computer) => unknown;
  getBot: (id: string) => Bot | undefined;
  paused?: () => boolean;
  onState?: (c: Computer) => void;
  onComputerBoot?: (botId: string) => void;
}
export type ToolKind = "browser" | "computer";
export class Computer {
  bot: Bot; hooks: ComputerHooks; ready: Promise<Computer> | null = null; desk: Promise<void> | null = null;
  mcps: Partial<Record<ToolKind, Rpc>> = {}; starting: Partial<Record<ToolKind, Promise<Rpc>>> = {};
  up = false; desktopUp = false; startedAt: number | null = null; viewers = 0; lastActive = Date.now();
  constructor(bot: Bot, hooks: ComputerHooks) { this.bot = bot; this.hooks = hooks; }
  get name() { return `pc-bot-${this.bot.id}`; }
  touch() { this.lastActive = Date.now(); }
  ensure() {
    this.touch();
    if (!this.ready) this.ready = this.#start().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  async #start() {
    await makeRoom(this);
    const b = this.bot, id = b.id, net = `pc-net-${id}`;
    ensureDirs(id);
    if (!(await docker(["network", "inspect", net])).ok) await docker(["network", "create", "--label", "pitcrew=computer", net]);
    await docker(["rm", "-f", this.name]);
    const r = await docker(["run", "-d", "--rm", "--name", this.name, "--hostname", id.slice(0, 20).replace(/[^a-z0-9-]/gi, "-"), "--label", "pitcrew=computer",
      "--cpus", "1.5", "--memory", "2g", "--pids-limit", "768", "--shm-size", "512m",
      "--read-only", "--tmpfs", "/tmp:size=768m,mode=1777", "--tmpfs", `/home/crew:size=128m,uid=${CREW_UID},gid=${CREW_UID},mode=700`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", net, "-v", `${botDir(id)}:/bot`, ...policyMount(id),
      "-e", `PITCREW_HUE=${HEX[b.hue] || HEX.c1}`, "-e", `PITCREW_NAME=${b.name.replace(/[^\w .'-]/g, "")}`, IMAGE]);
    if (!r.ok) throw new Error(`Couldn't start the computer: ${r.err.trim().slice(0, 200)}`);
    // The brain joins this bot's network to reach its exec-server; nothing else is on it.
    const c = await docker(["network", "connect", net, BRAIN]);
    if (!c.ok && !/already exists/.test(c.err)) throw new Error(`Couldn't connect the brain: ${c.err.trim().slice(0, 200)}`);
    for (let i = 0; i < 40; i++) { if ((await docker(["exec", this.name, "node", "-e", "require('net').connect(7700,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"])).ok) break; await new Promise((r) => setTimeout(r, 250)); }
    this.up = true; this.startedAt = Date.now();
    this.hooks.onState?.(this);
    this.#watch();
    return this;
  }
  // `docker wait` returns when the container exits (stopped, crashed or idle-swept).
  #watch() {
    execFile("docker", ["wait", this.name], { timeout: 0 }, () => {
      this.up = false; this.desktopUp = false; this.ready = null; this.desk = null; this.startedAt = null;
      for (const m of Object.values(this.mcps)) try { m!.proc.kill(); } catch {}
      this.mcps = {};
      docker(["network", "disconnect", `pc-net-${this.bot.id}`, BRAIN]);
      this.hooks.onState?.(this);
    });
  }
  // Speculative boot at turn start, alongside the first model request. Only into a free slot: it never evicts another
  // member's computer, and a kill switch thrown while it boots stops it again.
  prewarm(desktop: boolean) {
    if (this.ready || allComputers().filter((c) => c !== this && c.ready).length >= MAX_UP) return;
    this.ensure().then<unknown>(() => (this.hooks.paused?.() ? this.stop() : desktop && this.desktop())).catch(() => {});
  }
  async desktop() {
    await this.ensure(); this.touch();
    if (!this.desk) this.desk = (async () => {
      const r = await docker(["exec", this.name, "pitcrew-desktop"], { timeout: 90000 });
      if (!r.ok || !/desktop-up/.test(r.out)) { this.desk = null; throw new Error(`The desktop didn't start: ${(r.out + r.err).trim().slice(-200)}`); }
      this.desktopUp = true; this.hooks.onState?.(this);
    })();
    return this.desk;
  }
  // MCP servers that live inside the computer (Playwright over CDP, pixel control), reached over docker exec stdio.
  // Neither touches Chrome or X before its first tool call, so spawn + initialize (449-631 ms for Playwright, measured)
  // overlaps the desktop boot (~1.26 s) instead of following it.
  async mcp(kind: ToolKind): Promise<Rpc> {
    const live = this.mcps[kind];
    if (live && !live.closed) { await this.desktop(); return live; }
    await this.ensure();
    this.starting[kind] ??= this.#spawnMcp(kind).finally(() => { delete this.starting[kind]; });
    return (await Promise.all([this.starting[kind], this.desktop()]))[0];
  }
  // Playwright's per-action snapshot files go to PW_OUT, not the default ./.playwright-mcp in the workspace, where they
  // showed up as the run's "changed files". --codegen none drops the "Ran Playwright code" block from every result.
  async #spawnMcp(kind: ToolKind) {
    const cmd = kind === "browser" ? ["-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", this.name, "playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9222", "--output-dir", PW_OUT, "--output-max-size", String(32 << 20), "--codegen", "none", "--timeout-settle", String(PW_SETTLE_MS)] : ["-e", "DISPLAY=:1", this.name, "node", "/opt/pitcrew/computer-mcp.mjs"];
    const rpc = new Rpc(spawn("docker", ["exec", "-i", ...cmd], { stdio: ["pipe", "pipe", "pipe"] }), { name: `${kind} tools` });
    try { await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pitcrew", version: "1.1" } }, 30000); }
    catch (e: any) { rpc.proc.kill(); throw e; }
    rpc.notify("notifications/initialized", {});
    this.mcps[kind] = rpc;
    return rpc;
  }
  async stop() { if (this.up) await docker(["stop", "-t", "5", this.name]); }
}

const brains = new Map<string, Brain>(), computers = new Map<string, Computer>();
export const allComputers = () => [...computers.values()];
export const allBrains = () => [...brains.values()];
export function brainFor(bot: Bot, hooks: BrainHooks) { let x = brains.get(bot.id); if (!x) { x = new Brain(bot, hooks); brains.set(bot.id, x); } x.bot = bot; return x; }
export function computerFor(bot: Bot, hooks: ComputerHooks) { let x = computers.get(bot.id); if (!x) { x = new Computer(bot, hooks); computers.set(bot.id, x); } x.bot = bot; return x; }

// the host has ~7.7 GB; a computer idles at ~300 MiB with its desktop. Stop the stalest idle one to make room.
async function makeRoom(self: Computer) {
  const up = allComputers().filter((c) => c.up && c !== self);
  if (up.length < MAX_UP) return;
  const idle = up.filter((c) => !self.hooks.isBusy(c) && c.viewers === 0).sort((a, b) => a.lastActive - b.lastActive);
  if (!idle.length) throw new Error(`All ${MAX_UP} computers are busy. Try again when a crew member finishes.`);
  await idle[0].stop();
}

// Once a minute: idle computers go back to the garage; idle brain sessions exit (threads stay on disk).
export function startIdleSweeper(isBusy: (c: Computer) => unknown, isThinking: (botId: string) => boolean) {
  setInterval(() => {
    for (const c of allComputers()) if (c.up && !isBusy(c) && c.viewers === 0 && Date.now() - c.lastActive > IDLE_MS) c.stop();
    for (const b of allBrains()) if (b.up && !isThinking(b.bot.id) && Date.now() - b.lastActive > BRAIN_IDLE_MS) b.stop();
  }, 60000).unref();
}

// The exec gateway in the brain asks for a computer here; only the brain container mounts this socket's directory.
export function startBootSocket(hooks: ComputerHooks) {
  const dir = `${ROOT}/run`, path = `${dir}/boot.sock`;
  mkdirSync(dir, { recursive: true });
  try { unlinkSync(path); } catch {}
  createServer((s) => {
    let buf = "";
    s.setEncoding("utf8"); s.on("error", () => {});
    // A request with an `id` keeps the connection open and its reply carries the id (the gateway's one persistent
    // connection, so per-turn fs probes skip a connect each); without one, reply and close.
    const reply = (msg: any, r: Record<string, unknown>) => (msg?.id !== undefined ? s.write(JSON.stringify({ ...r, id: msg.id }) + "\n") : s.end(JSON.stringify(r) + "\n"));
    s.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg: any; try { msg = JSON.parse(line); } catch { s.end('{"ok":false,"error":"bad request"}\n'); return; }
        bootOp(hooks, msg).then((r) => { if (!s.destroyed) reply(msg, r); });
      }
    });
  }).listen(path, () => chmodSync(path, 0o666));
}
async function bootOp(hooks: ComputerHooks, msg: any): Promise<Record<string, unknown>> {
  if (msg.op === "info") return { ok: true, info: (await toolManifest().catch(() => ({}) as Partial<ToolManifest>)).execInfo || null };
  const bot = hooks.getBot(msg.bot);
  if (!bot) return { ok: false, error: "no such crew member" };
  const c = computerFor(bot, hooks);
  if (msg.op === "touch") { c.touch(); return { ok: true }; }
  if (msg.op === "fs") { let r: Record<string, unknown>; try { r = execFs(bot.id, String(msg.method), msg.params || {}); } catch { r = { fallback: true }; } if (c.up) c.touch(); return r; }
  try { const t0 = Date.now(), was = c.up; await c.ensure(); hooks.onComputerBoot?.(bot.id); return { ok: true, host: c.name, bootMs: was ? 0 : Date.now() - t0 }; }
  catch (e: any) { return { ok: false, error: e.message }; }
}

// Containers from a previous control-plane process lost their sessions; remove them at boot.
export async function reapOrphans() {
  const r = await docker(["ps", "-aq", "--filter", "label=pitcrew=computer"]);
  const ids = r.out.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
  await docker(["restart", "-t", "3", BRAIN]);
}

// Tool manifests for the computer's MCP servers, read once from the image (no desktop needed to list tools).
let manifest: ToolManifest | null = null;
export async function toolManifest(): Promise<ToolManifest> {
  if (manifest) return manifest;
  const cache = `${ROOT}/data/tools-manifest.json`;
  const img = (await docker(["image", "inspect", "-f", "{{.Id}}", IMAGE])).out.trim();
  try { const c = JSON.parse(readFileSync(cache, "utf8")); if (c.image === img) return (manifest = c); } catch {}
  const list = async (args: string[]): Promise<McpTool[]> => {
    const rpc = new Rpc(spawn("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", args[0], IMAGE, ...args.slice(1)], { stdio: ["pipe", "pipe", "pipe"] }), { name: "manifest" });
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pitcrew", version: "1.1" } }, 60000);
    rpc.notify("notifications/initialized", {});
    const r = await rpc.request("tools/list", {}, 60000);
    rpc.proc.kill();
    return r.tools;
  };
  // The exec-server's own environment info, so the gateway can answer `initialize` before any computer exists.
  const exec = new Rpc(spawn("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", "codex", IMAGE, "exec-server", "--listen", "stdio"], { stdio: ["pipe", "pipe", "pipe"] }), { name: "exec-info" });
  const execInfo = (await exec.request("initialize", { clientName: "codex-environment", resumeSessionId: null }, 60000)).environmentInfo;
  exec.proc.kill();
  manifest = { image: img, execInfo, browser: await list(["playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9"]), computer: await list(["node", "/opt/pitcrew/computer-mcp.mjs"]) };
  writeFileSync(cache, JSON.stringify(manifest));
  return manifest;
}

// Library: files the crew made or downloaded, listed from the bot's workspace (bounded walk).
export function listFiles(id: string) {
  const base = `${botDir(id)}/work`, out: { path: string; size: number; mtime: number }[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4 || out.length > 500) return;
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(`${base}/${rel}`, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile()) { const st = statSync(`${base}/${r}`); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); }
    }
  };
  walk("", 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}
export { ensureDirs, docker };
