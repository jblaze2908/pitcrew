// Projects: a read-only code view of a crew member's project folder, served by px0 (MIT, github.com/px0-ai/px0).
// Containment, from the outside in:
//   - The browser frames it sandboxed, and every /code/ response carries a CSP sandbox too, so px0 (and any HTML the
//     crew wrote, served raw) runs at an opaque origin: no Pitcrew cookies, no Pitcrew API, no parent page.
//   - The proxy below forwards only px0's read endpoints; staging, commits, push/pull, agent edits and LSP installs 403.
//   - px0 itself runs in a throwaway container: workspace mounted read-only, no git keys, and an --internal network
//     that only the control plane joins, so it has no way out (its update check and telemetry just fail).
// Auth is the 32-char token in the path: a sandboxed frame sends no cookies, so the token is the capability.
import { randomBytes } from "node:crypto";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync } from "node:fs";
import { botDir, docker } from "./computer.js";

export interface Project { path: string; name: string; git: boolean; markers: string[] }
interface Session { token: string; botId: string; path: string; lastUsed: number; open: number; host?: string; port?: number; stop?: () => Promise<unknown> }
export interface CodeBackend { start(s: Session): Promise<{ host: string; port: number; stop: () => Promise<unknown> }> }

const IMAGE = process.env.PITCREW_CODE_IMAGE || "pitcrew-px0:1";
const NET = "pc-code";
const APP = process.env.PITCREW_APP_CONTAINER || "pitcrew-app";
const IDLE_MS = 15 * 60000;
const MARKERS = [".git", "package.json", "go.mod", "pyproject.toml", "Cargo.toml", "requirements.txt", "pom.xml", "build.gradle", "Gemfile", "composer.json", "deno.json", "Makefile"];
const SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next"]);

// Folders under /bot/work that look like code. Bounded walk (depth 3, 50 results); a project's own subfolders aren't
// searched for nested projects. Runs when the Projects view opens, not per request.
export function listProjects(botId: string) {
  const base = `${botDir(botId)}/work`, out: Project[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 3 || out.length >= 50) return;
    let ents: import("node:fs").Dirent[]; try { ents = readdirSync(rel ? `${base}/${rel}` : base, { withFileTypes: true }); } catch { return; }
    const found = MARKERS.filter((m) => ents.some((e) => e.name === m));
    if (rel && found.length) { out.push({ path: rel, name: rel.split("/").pop()!, git: found.includes(".git"), markers: found }); return; }
    for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".") && !SKIP.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
  };
  walk("", 0);
  return out;
}

// One px0 per crew member at a time; opening another project replaces it.
const sessions = new Map<string, Session>(); // token → { token, botId, path, host, port, stop, lastUsed, open }

const dockerBackend: CodeBackend = {
  async start(s) {
    if (!(await docker(["network", "inspect", NET])).ok) await docker(["network", "create", "--internal", "--label", "pitcrew=code", NET]);
    const c = await docker(["network", "connect", NET, APP]);
    if (!c.ok && !/already exists/.test(c.err)) throw new Error(`Couldn't reach the code view network: ${c.err.trim().slice(0, 160)}`);
    const name = `pc-code-${s.botId}`;
    await docker(["rm", "-f", name]);
    const r = await docker(["run", "-d", "--rm", "--name", name, "--label", "pitcrew=code", "--network", NET,
      "--read-only", "--tmpfs", "/tmp:size=64m,mode=1777", "--tmpfs", "/home/px0:size=32m,uid=1500,gid=1500,mode=700", "-e", "HOME=/home/px0",
      "--user", "1500:1500", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "384m", "--cpus", "1", "--pids-limit", "128",
      "-v", `${botDir(s.botId)}/work:/work:ro`, IMAGE,
      "-host", "0.0.0.0", "-port", "7777", "-base-path", `/code/${s.token}/`, "-no-agent", "-no-telemetry", "-no-open", "-no-lsp", "-quiet", `/work/${s.path}`]);
    if (!r.ok) throw new Error(`Couldn't start the code view: ${r.err.trim().slice(0, 200)}`);
    return { host: name, port: 7777, stop: () => docker(["rm", "-f", name]) };
  },
};
let backend = dockerBackend;
export const setCodeBackend = (b: CodeBackend) => { backend = b; }; // tests run px0 directly

export async function openProject(botId: string, path: string) {
  const project = listProjects(botId).find((p) => p.path === path);
  if (!project) throw Object.assign(new Error("Not a project folder"), { status: 404 });
  for (const s of sessions.values()) {
    if (s.botId !== botId) continue;
    if (s.path === path) { s.lastUsed = Date.now(); return { url: `/code/${s.token}/`, project }; }
    closeSession(s);
  }
  const s: Session = { token: randomBytes(24).toString("base64url"), botId, path, lastUsed: Date.now(), open: 0 };
  Object.assign(s, await backend.start(s));
  sessions.set(s.token, s);
  for (let i = 0; i < 40; i++) { if (await probe(s)) return { url: `/code/${s.token}/`, project }; await new Promise((r) => setTimeout(r, 150)); }
  closeSession(s);
  throw new Error("The code view didn't start in time");
}
function closeSession(s: Session) { sessions.delete(s.token); s.stop?.().catch?.(() => {}); }
const probe = (s: Session) => new Promise<boolean>((res) => request({ host: s.host, port: s.port, path: `/code/${s.token}/api/meta`, timeout: 1000 }, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false)).end());

// What the browser may reach. Anything else (git stage/commit/push/pull, agent/*, lsp/*, settings writes, PR posting) is refused.
const READ_GET = /^(|static\/(?!.*\.\.)[\w./-]+|api\/(meta|metrics|tree|find|file|raw|markdown|diff|gutter|stream|git\/stream|git\/log|search|outline|def|session|settings|agent\/harnesses|agent\/job|pr\/meta))$/;
const READ_POST = /^api\/(session|close|git\/refresh|reindex)$/;
export const allowed = (method: string | undefined, sub: string) => ((method === "GET" || method === "HEAD") && READ_GET.test(sub)) || (method === "POST" && READ_POST.test(sub));

const CODE_CSP = "sandbox allow-scripts allow-popups allow-downloads; default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'";

// px0 in Pitcrew's clothes. px0 discovers themes from [data-theme] rules and, with no localStorage in the sandbox,
// always starts on "github-dark", so a later rule for that id wins the cascade. Its other themes stay selectable.
// Colours mirror the Pitcrew design system tokens (app/web/ds/theme.css).
const PITCREW_THEME = `
:root[data-theme="github-dark"] {
  --theme-name: "Pitcrew"; color-scheme: dark;
  --bg: #0f0f12; --bg2: #0a0a0c; --bg3: #18181d; --bg4: #202026;
  --fg: #f0f0f3; --dim: #a9a9b4; --faint: #76767f;
  --line: #25252c; --accent: #7196ff; --accent-fg: #a9c0ff;
  --sel: rgba(113,150,255,.22); --mark: rgba(242,193,78,.26); --mark-active: #f2c14e; --cur: #15151a;
  --shadow: 0 8px 24px rgba(0,0,0,.5);
  --k: #b39dff; --kt: #16c2c2; --nf: #7196ff; --nc: #f2c14e; --nb: #16c2c2; --nv: #f0f0f3; --no: #ff6fab; --na: #a9a9b4;
  --nt: #2fcc80; --nd: #9577ff; --np: #7196ff; --s: #3ad483; --m: #ff6fab; --o: #a9a9b4; --p: #8b8b95; --c: #6f6f78; --cp: #9577ff; --err: #ff6b5e;
  --gi: #3ad483; --gd: #ff6b5e; --gi-bg: rgba(58,212,131,.13); --gd-bg: rgba(255,107,94,.13);
  --mono: "IBM Plex Mono", ui-monospace, monospace; --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
:root[data-theme="github-dark"] body { font-family: "IBM Plex Sans", ui-sans-serif, sans-serif; }
img[src*="px0.ai/logo"] { display: none; }
/* Read-only here: the proxy refuses every git write, so the controls for them only mislead. */
#git-token-nudge, #git-commit-section, .git-sync-actions, #pr-readonly-note, .stage-tick { display: none !important; }
`;
const PITCREW_FONTS = '@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap");\n';

// Per request to /code/…: one map lookup, a regex, and a streamed pipe (px0's event stream stays open).
export function proxyCode(req: IncomingMessage, res: ServerResponse) {
  // Match and forward the normalised path, never the raw one, so "/static/../api/git/push" can't slip past the list.
  const u = new URL(req.url!, "http://x");
  const m = /^\/code\/([\w-]{32})\/(.*)$/.exec(u.pathname);
  const s = m && sessions.get(m[1]);
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", CODE_CSP);
  res.setHeader("Access-Control-Allow-Origin", "*"); // the frame's origin is opaque ("null"); the path token is the auth
  res.setHeader("Cache-Control", "no-store");
  const deny = (status: number, error: string) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error })); };
  if (!s) return deny(404, "This code view has closed. Open the project again from Pitcrew.");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST" }); return res.end(); }
  if (!allowed(req.method, m![2])) return deny(403, "Read-only in Pitcrew: ask the crew member to make this change.");
  s.lastUsed = Date.now(); s.open++;
  const target = `${s.host}:${s.port}`;
  // px0 accepts POSTs only from its own origin; the sandboxed frame says "null", so speak for it.
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target, origin: `http://${target}` };
  delete headers.cookie; delete headers.authorization;
  const themed = m![2] === "static/themes.css";
  if (themed) delete headers["accept-encoding"];
  const up = request({ host: s.host, port: s.port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
    const h = { ...r.headers }; delete h["set-cookie"]; delete h["content-security-policy"]; delete h["x-frame-options"];
    if (!themed || r.statusCode !== 200) { res.writeHead(r.statusCode!, h); return r.pipe(res); }
    // ~16 KB, once per page load: buffer it to put the font import first and the Pitcrew theme last.
    const chunks: Buffer[] = []; r.on("data", (c) => chunks.push(c));
    r.on("end", () => { const body = PITCREW_FONTS + Buffer.concat(chunks).toString("utf8") + PITCREW_THEME; delete h["content-length"]; res.writeHead(200, { ...h, "content-type": "text/css; charset=utf-8" }); res.end(body); });
  });
  const done = () => { s.open = Math.max(0, s.open - 1); s.lastUsed = Date.now(); };
  res.on("close", () => { done(); up.destroy(); });
  up.on("error", () => { if (!res.headersSent) deny(502, "The code view stopped."); else res.destroy(); });
  req.pipe(up);
}

// Once a minute: a code view nobody has touched for 15 minutes (and with no stream open) goes away.
export function startCodeSweeper() {
  setInterval(() => { for (const s of sessions.values()) if (!s.open && Date.now() - s.lastUsed > IDLE_MS) closeSession(s); }, 60000).unref();
}
// Code views from a previous control-plane process have tokens nobody holds any more.
export async function reapCode() {
  const r = await docker(["ps", "-aq", "--filter", "label=pitcrew=code"]);
  const ids = r.out.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
}
