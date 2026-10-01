// Read-only HTTP view of /bot/work on loopback, because the browser blocks file:// (Playwright MCP's default, kept).
// Only Host 127.0.0.1/localhost (no DNS rebinding), and every response is CSP-sandboxed to an opaque origin, so a
// downloaded page can't read the rest of the workspace the way a same-origin page could.
import { createServer } from "node:http";
import { createReadStream, realpathSync, statSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const PORT = Number(process.env.PITCREW_FILES_PORT || 7780), ROOT = realpathSync("/bot/work");
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const TYPES = { ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/csv", ".log": "text/plain", ".xml": "text/xml",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
const BASE = { "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

createServer((req, res) => {
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...BASE, "Content-Type": type, ...extra }); res.end(req.method === "HEAD" ? undefined : body); };
  const fail = (code, msg) => send(code, "text/plain; charset=utf-8", msg);
  if (!HOSTS.has(req.headers.host || "")) return fail(421, "Wrong host");
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Read-only");
  let rel; try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return fail(400, "Bad path"); }
  let full, st; try { full = realpathSync(join(ROOT, rel)); st = statSync(full); } catch { return fail(404, "Not found"); }
  if (full !== ROOT && !full.startsWith(`${ROOT}/`)) return fail(403, "Outside /bot/work");
  if (st.isDirectory()) {
    if (!rel.endsWith("/")) return send(301, "text/plain", "", { Location: `${encodeURI(rel)}/` });
    try { if (statSync(join(full, "index.html")).isFile()) { full = join(full, "index.html"); st = statSync(full); } } catch {}
  }
  if (st.isDirectory()) {
    const names = readdirSync(full, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();
    return send(200, "text/html; charset=utf-8", `<!doctype html><meta charset="utf-8"><title>${esc(rel)}</title><h1>${esc(rel)}</h1><ul>${names.map((n) => `<li><a href="${esc(encodeURIComponent(n.replace(/\/$/, "")) + (n.endsWith("/") ? "/" : ""))}">${esc(n)}</a></li>`).join("")}</ul>`);
  }
  if (!st.isFile()) return fail(404, "Not found");
  const type = TYPES[extname(full).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { ...BASE, "Content-Type": /^text\/|json|xml|svg/.test(type) ? `${type}; charset=utf-8` : type, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(full).on("error", () => res.destroy()).pipe(res);
}).on("error", (e) => process.exit(e.code === "EADDRINUSE" ? 0 : 1)).listen(PORT, "127.0.0.1");
