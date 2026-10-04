// Requests answered on the raw Node response, before the API: health, the code view proxy, workspace files and shared
// screenshots (cookie-authed downloads), and the static web app and noVNC.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync, createReadStream, realpathSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { getBot } from "../crew.js";
import { botDir } from "../computer.js";
import { serveShot, SHOT_NAME } from "../shots.js";
import { send, serveFile as serveCached } from "../delivery.js";
import { proxyCode } from "../code.js";
import { authed } from "./guard.js";

// Files from a crew member's workspace, served as downloads only (never rendered inline).
function serveFile(req: IncomingMessage, res: ServerResponse, botId: string, rel: string) {
  if (!getBot(botId)) return send(res, 404, "Not found");
  let base: string, full: string;
  try { base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(join(base, normalize(decodeURIComponent(rel)))); } catch { return send(res, 404, "Not found"); }
  if (!full.startsWith(base + "/") || !statSync(full).isFile()) return send(res, 404, "Not found");
  // Images may render inline (thumbnails); everything else is a download. Inline responses are sandboxed.
  const IMG: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
  const inline = new URL(req.url!, "http://x").searchParams.get("inline") === "1" && IMG[extname(full).toLowerCase()];
  res.writeHead(200, inline
    ? { "Content-Type": inline, "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Length": statSync(full).size }
    : { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${full.split("/").pop()!.replace(/[^\w.-]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Content-Length": statSync(full).size });
  createReadStream(full).pipe(res);
}

// App files revalidate on every load (no-cache + ETag, so a deploy shows at once); vendored noVNC keeps a day.
function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, web: string, novnc: string) {
  let root = web, rel = path;
  if (path.startsWith("/novnc/")) { root = novnc; rel = path.slice(6); }
  if (!/^\/[\w./-]*$/.test(rel) || rel.includes("..")) return send(res, 404, "Not found");
  let full = join(root, rel);
  if (root === web && (rel === "/" || !existsSync(full) || !extname(rel))) full = join(web, "index.html");
  if (!serveCached(req, res, full, root === novnc ? "public, max-age=86400" : "no-cache")) send(res, 404, "Not found");
}

// Answers the request and returns true, or returns false to leave it to the API.
export function serveRaw(req: IncomingMessage, res: ServerResponse, url: URL, web: string, novnc: string) {
  if (url.pathname === "/healthz") { send(res, 200, "ok"); return true; }
  if (url.pathname.startsWith("/code/")) { proxyCode(req, res); return true; } // token-authed, sandboxed: see code.ts
  const fm = /^\/files\/([\w-]+)\/(.+)$/.exec(url.pathname);
  if (fm) { if (authed(req.headers.cookie)) serveFile(req, res, fm[1], fm[2]); else send(res, 401, "Sign in"); return true; }
  const sm = /^\/shots\/([\w-]+)\/([^/]+)$/.exec(url.pathname);
  if (sm) { if (!authed(req.headers.cookie)) send(res, 401, "Sign in"); else if (getBot(sm[1]) && SHOT_NAME.test(sm[2])) serveShot(res, sm[1], sm[2]); else send(res, 404, "Not found"); return true; }
  if (!url.pathname.startsWith("/api/")) { serveStatic(req, res, url.pathname, web, novnc); return true; }
  // No API route answers HEAD (Hono would run the GET route for it).
  if (req.method === "HEAD") { send(res, 404, { error: "Not found" }); return true; }
  return false;
}
