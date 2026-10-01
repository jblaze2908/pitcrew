// Loopback proxy between each crew member's Codex (in the brain) and the model providers.
// 1. Anthropic models on OpenRouter only cache with an explicit top-level cache_control (Codex can't add body fields);
//    measured 2026-10-01: a cached step cost $0.0016 vs $0.0159 uncached for the same 7.6k-token prefix. Plus a
//    breakpoint on the shared prefix and a per-member cache key, so a member's new threads reuse it (see markPrefix).
// 2. Taps the provider's own usage/cost from the stream into /brains/_usage/<bot>.jsonl, keyed by the Pitcrew turn id,
//    so telemetry uses billed cost instead of list-price estimates. Runs once per model request; the tap is a line scan.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = 8788;
const UPSTREAM = { openrouter: "https://openrouter.ai/api/v1", aigateway: "https://ai-gateway.vercel.sh/v1" };

let breakpoints = true; // off for this process once OpenRouter rejects one (see below)

function rewrite(bot, provider, body) {
  let turn = null;
  // Codex flattens turn metadata into client_metadata["x-codex-turn-metadata"]; it's ours, not the provider's.
  const meta = body.client_metadata?.["x-codex-turn-metadata"];
  if (meta) { try { turn = JSON.parse(meta).pitcrew_turn || null; } catch {} delete body.client_metadata; }
  if (provider !== "openrouter") return { turn, mark: null };
  // Codex keys the cache by thread id; OpenRouter pins provider routing by it, so a new thread could land on another
  // provider's cold cache. Tools, instructions and developer message are the same across a member's threads.
  if (body.prompt_cache_key) body.prompt_cache_key = `pitcrew-${bot}`;
  if (!/^anthropic\//.test(body.model || "")) return { turn, mark: null };
  if (!body.cache_control) body.cache_control = { type: "ephemeral" };
  return { turn, mark: breakpoints ? markPrefix(body) : null };
}

// Anthropic only reads the cache where an earlier request wrote it, and the automatic breakpoint sits at the end of
// the conversation, so a new thread never hit the shared prefix (measured: first turns 33% cached vs 84% later).
// A second breakpoint at the end of the leading developer message writes one there. OpenRouter's Responses API takes
// it as prompt_cache_breakpoint on an input_text part (converted to Anthropic cache_control); returns the marked part.
function markPrefix(body) {
  const first = Array.isArray(body.input) ? body.input[0] : null;
  if (first?.type !== "message" || first.role !== "developer" || !Array.isArray(first.content)) return null;
  const part = first.content.findLast((c) => c.type === "input_text");
  if (!part || part.prompt_cache_breakpoint) return null;
  part.prompt_cache_breakpoint = { mode: "explicit" };
  return part;
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
  let raw = Buffer.concat(chunks), turn = null, model = null, sizes = null, plain = null;
  if (req.method === "POST" && /json/.test(req.headers["content-type"] || "")) {
    try {
      const body = JSON.parse(raw); model = body.model;
      const r = rewrite(bot, provider, body); turn = r.turn; raw = Buffer.from(JSON.stringify(body));
      if (r.mark) plain = () => { delete r.mark.prompt_cache_breakpoint; return Buffer.from(JSON.stringify(body)); };
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
  const send = (b) => fetch(UPSTREAM[provider] + path, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : b });
  try {
    up = await send(raw);
    // The breakpoint is documented but untested against live traffic: if a marked request is refused and the same
    // request without it isn't, stop marking for this process rather than fail turns.
    if (plain && up.status === 400) {
      await up.body?.cancel();
      up = await send(plain());
      if (up.ok) { breakpoints = false; console.error("llm-proxy: OpenRouter refused prompt_cache_breakpoint; prefix breakpoints off"); }
    }
  }
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
