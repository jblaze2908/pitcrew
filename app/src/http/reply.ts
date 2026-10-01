// API responses as delivery.send() shapes them: no-store, a Content-Length, and JSON over 1 KB gzipped when the client
// takes it (on the zlib pool). Per API response: one re-read of the serialised body; gzip only past 1 KB.
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { createMiddleware } from "hono/factory";
import { negotiate } from "../delivery.js";
import type { Env } from "./guard.js";

const gzipped = promisify(gzip);

export const deliver = createMiddleware<Env>(async (c, next) => {
  await next();
  if (c.env.outgoing.headersSent) return; // a stream that wrote its own head (SSE)
  const res = c.res, type = res.headers.get("content-type") || "text/plain; charset=utf-8";
  const data = Buffer.from(await res.arrayBuffer());
  const h: Record<string, string> = { "Content-Type": type, "Cache-Control": "no-store" };
  let out = data;
  if (type === "application/json" && data.length > 1024) {
    h.Vary = "Accept-Encoding";
    if (negotiate(c.req.header("accept-encoding"), ["gzip"])) try { out = await gzipped(data, { level: 6 }); h["Content-Encoding"] = "gzip"; } catch {}
  }
  h["Content-Length"] = String(out.length);
  c.res = undefined; // replace, don't merge: the handler's own headers are carried over below
  const merged = new Headers(h);
  for (const [k, v] of res.headers) if (k !== "content-type" && k !== "content-length") k === "set-cookie" ? merged.append(k, v) : merged.set(k, v);
  c.res = new Response(out, { status: res.status, headers: merged });
});
