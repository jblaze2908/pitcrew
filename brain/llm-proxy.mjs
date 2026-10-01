// Loopback proxy between each crew member's Codex (in the brain) and the model providers.
// 1. Anthropic models on OpenRouter only cache with an explicit top-level cache_control (Codex can't add body fields);
//    measured 2026-10-01: a cached step cost $0.0016 vs $0.0159 uncached for the same 7.6k-token prefix.
// 2. Taps the provider's own usage/cost from the stream into /brains/_usage/<bot>.jsonl, keyed by the Pitcrew turn id,
//    so telemetry uses billed cost instead of list-price estimates. Runs once per model request; the tap is a line scan.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = 8788;
const UPSTREAM = { openrouter: "https://openrouter.ai/api/v1", aigateway: "https://ai-gateway.vercel.sh/v1" };

function rewrite(provider, body) {
  let turn = null;
  // Codex flattens turn metadata into client_metadata["x-codex-turn-metadata"]; it's ours, not the provider's.
  const meta = body.client_metadata?.["x-codex-turn-metadata"];
  if (meta) { try { turn = JSON.parse(meta).pitcrew_turn || null; } catch {} delete body.client_metadata; }
  if (provider === "openrouter" && /^anthropic\//.test(body.model || "") && !body.cache_control) body.cache_control = { type: "ephemeral" };
  return turn;
}

function record(bot, provider, model, turn, usage, id, sizes, ms) {
  if (!usage) return;
  const d = usage.input_tokens_details || {};
  appendFileSync(`/brains/_usage/${bot}.jsonl`, JSON.stringify({ ts: Date.now(), provider, model, turn, id: id || null, input: usage.input_tokens || 0, cached: d.cached_tokens || 0,
    cacheWrite: d.cache_write_tokens || 0, output: usage.output_tokens || 0, cost: typeof usage.cost === "number" ? usage.cost : null, sizes, ms }) + "\n");
}

createServer(async (req, res) => {
  const m = /^\/([a-z0-9][a-z0-9-]{0,40})\/(openrouter|aigateway)(\/.*)$/.exec(req.url || "");
  if (!m) { res.writeHead(404).end(); return; }
  const [, bot, provider, path] = m;
  const chunks = []; for await (const c of req) chunks.push(c);
  let raw = Buffer.concat(chunks), turn = null, model = null, sizes = null;
  if (req.method === "POST" && /json/.test(req.headers["content-type"] || "")) {
    try {
      const body = JSON.parse(raw); model = body.model; turn = rewrite(provider, body); raw = Buffer.from(JSON.stringify(body));
      // Request shape in bytes, so a context blow-up (huge tools or instructions) is visible in telemetry.
      sizes = Object.fromEntries(["instructions", "input", "tools"].map((k) => [k, body[k] ? JSON.stringify(body[k]).length : 0]));
      sizes.tools_n = Array.isArray(body.tools) ? body.tools.length : 0;
      if (Array.isArray(body.tools)) sizes.top_tools = body.tools.map((x) => [x.name || x.type, JSON.stringify(x).length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    } catch {}
  }
  const headers = { ...req.headers }; delete headers.host; delete headers["content-length"]; delete headers.connection; delete headers["accept-encoding"];
  // Time to first byte and total, so a turn's wall time splits into model time and everything else.
  const t0 = Date.now(), ms = { ttfb: null, total: null };
  let up;
  try { up = await fetch(UPSTREAM[provider] + path, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw }); }
  catch (e) { res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `proxy: ${e.message}` } })); return; }
  const out = {}; up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
  res.writeHead(up.status, out);
  if (!up.body) { res.end(); return; }
  const sse = /event-stream/.test(up.headers.get("content-type") || "");
  let tail = "", whole = "";
  const dec = new TextDecoder();
  for await (const chunk of up.body) {
    ms.ttfb ??= Date.now() - t0;
    res.write(chunk);
    const text = dec.decode(chunk, { stream: true });
    if (sse) {
      tail += text;
      let i;
      while ((i = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, i); tail = tail.slice(i + 1);
        if (!line.startsWith("data: ") || !line.includes('"usage"')) continue;
        try { const e = JSON.parse(line.slice(6)); if (/^response\.(completed|incomplete|failed)$/.test(e.type)) { ms.total = Date.now() - t0; record(bot, provider, model, turn, e.response?.usage, e.response?.id, sizes, ms); } } catch {}
      }
    } else if (whole.length < 4 << 20) whole += text;
  }
  res.end();
  if (!sse && whole.includes('"usage"')) { try { const b = JSON.parse(whole); ms.total = Date.now() - t0; record(bot, provider, model, turn, b.usage, b.id, sizes, ms); } catch {} }
}).listen(PORT, "127.0.0.1");
