// Response delivery: compressed, revalidatable static files and gzipped JSON. node:zlib only.
import { statSync, readFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { brotliCompressSync, gzipSync, gzip, constants as Z } from "node:zlib";

export const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const MAX_CACHED = 4 << 20;
const cache = new Map(); // full path → one file version, its hash and its encodings

// Accept-Encoding with q-values; the first offer wins a tie, so br beats gzip.
export function negotiate(header, offers = ["br", "gzip"]) {
  const q = {};
  for (const part of String(header || "").toLowerCase().split(",")) {
    const [name, ...params] = part.split(";").map((s) => s.trim());
    if (name) q[name] = Number(params.map((p) => /^q=([\d.]+)$/.exec(p)?.[1]).find(Boolean) ?? 1);
  }
  let best = null, bw = 0;
  for (const o of offers) { const w = q[o] ?? q["*"] ?? 0; if (w > bw) { best = o; bw = w; } }
  return best;
}

// Compressed once per file version (keyed by mtime and size) and kept in memory; brotli 11 on app.js is a one-off cost.
function entry(full, st) {
  const key = `${st.mtimeMs}:${st.size}`, hit = cache.get(full);
  if (hit?.key === key) return hit;
  const raw = readFileSync(full), type = TYPES[extname(full)] || "application/octet-stream";
  const e = { key, type, raw, hash: createHash("sha256").update(raw).digest("base64url").slice(0, 22), modified: new Date(st.mtimeMs).toUTCString(), br: null, gzip: null };
  if (COMPRESSIBLE.test(type) && raw.length > 512) {
    const br = brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } }), gz = gzipSync(raw, { level: 9 });
    if (br.length < raw.length) e.br = br;
    if (gz.length < raw.length) e.gzip = gz;
  }
  cache.set(full, e);
  return e;
}
// Called once at boot for the app's own files, so the first load after a deploy doesn't wait on brotli (~100 ms).
export function warm(full) { try { const st = statSync(full); if (st.isFile() && st.size <= MAX_CACHED) entry(full, st); } catch {} }
// The client's tag matches if it names this content in any encoding; the 304 echoes the tag it holds.
const matched = (inm, hash) => String(inm || "").split(",").map((t) => t.trim()).find((t) => t === "*" || t.replace(/^W\//, "").replace(/^"|"$/g, "").replace(/\.(br|gzip)$/, "") === hash);

// Serves one file with a strong ETag, 304 on If-None-Match and per-client encoding. Returns false if it isn't a file.
export function serveFile(req, res, full, cacheControl) {
  let st; try { st = statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const type = TYPES[extname(full)] || "application/octet-stream";
  if (st.size > MAX_CACHED) { res.writeHead(200, { "Content-Type": type, "Cache-Control": cacheControl, "Content-Length": st.size }); createReadStream(full).pipe(res); return true; }
  const e = entry(full, st), enc = negotiate(req.headers["accept-encoding"], ["br", "gzip"].filter((k) => e[k]));
  const h = { "Content-Type": e.type, "Cache-Control": cacheControl, ETag: `"${e.hash}${enc ? `.${enc}` : ""}"`, "Last-Modified": e.modified };
  if (e.br || e.gzip) h.Vary = "Accept-Encoding";
  const tag = matched(req.headers["if-none-match"], e.hash);
  if (tag) { res.writeHead(304, { ...h, ETag: tag === "*" ? h.ETag : tag }); res.end(); return true; }
  const body = enc ? e[enc] : e.raw;
  if (enc) h["Content-Encoding"] = enc;
  res.writeHead(200, { ...h, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

// JSON over 1 KB is gzipped when the client takes it, on the zlib pool so a 200 KB thread doesn't block the loop.
export function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers };
  const len = Buffer.byteLength(data);
  if (h["Content-Type"] === "application/json" && len > 1024) {
    h.Vary = "Accept-Encoding";
    if (negotiate(res.req?.headers["accept-encoding"], ["gzip"])) {
      return gzip(data, { level: 6 }, (err, z) => {
        if (res.destroyed || res.headersSent) return;
        if (err) { res.writeHead(status, { ...h, "Content-Length": len }); return res.end(data); }
        res.writeHead(status, { ...h, "Content-Encoding": "gzip", "Content-Length": z.length }); res.end(z);
      });
    }
  }
  res.writeHead(status, { ...h, "Content-Length": len });
  res.end(data);
}
