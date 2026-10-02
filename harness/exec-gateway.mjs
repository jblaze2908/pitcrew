// Lazy door to each crew member's computer, speaking Codex's exec-server protocol (JSON-RPC over WebSocket).
// Codex reads context through it at every turn (AGENTS.md, .git probes, skills). Those reads, and file writes, are
// answered by the control plane straight from the workspace on the host's disk; the computer boots only when something
// must execute (process/*) or a path can't be served safely from disk. Then this replays `initialize` to the real
// exec-server and becomes a byte pipe. Measured 2026-10-01: a chat-only turn sends ~30 reads and no process calls.
import { createServer, connect } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const BOOT_SOCK = "/run/pitcrew/boot.sock";
const LOCAL = new Set(["environmentConfig/read", "fs/getMetadata", "fs/readFile", "fs/canonicalize", "fs/walk", "fs/writeFile"]);

// One persistent connection to the control plane, shared by all sessions; replies match by id. Every turn sends
// several fs probes (AGENTS.md, .git, skills), each of which used to pay a connect and accept. Reconnects on next use.
let ctl = null, nextId = 1;
const waiting = new Map();
function ctlSocket() {
  if (ctl && !ctl.destroyed) return ctl;
  const s = connect(BOOT_SOCK);
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let r; try { r = JSON.parse(buf.slice(0, i)); } catch { r = null; } buf = buf.slice(i + 1);
      const w = r && waiting.get(r.id);
      if (w) { waiting.delete(r.id); delete r.id; w(r); }
    }
  });
  s.on("error", () => {});
  s.on("close", () => { if (ctl === s) ctl = null; for (const w of waiting.values()) w({ ok: false, error: "control plane connection closed" }); waiting.clear(); });
  return (ctl = s);
}
function control(msg, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: "control plane timeout" }); }, timeoutMs);
    waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    ctlSocket().write(JSON.stringify({ ...msg, id }) + "\n");
  });
}

// Minimal WebSocket framing. Client→server frames are masked; we send unmasked to Codex, masked to the computer.
function frame(op, payload, mask) {
  const n = payload.length;
  const len = n < 126 ? Buffer.from([n | (mask ? 128 : 0)]) : n < 65536 ? Buffer.from([126 | (mask ? 128 : 0), n >> 8, n & 255]) : Buffer.concat([Buffer.from([127 | (mask ? 128 : 0), 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
  if (!mask) return Buffer.concat([Buffer.from([0x80 | op]), len, payload]);
  const key = randomBytes(4), body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from([0x80 | op]), len, key, body]);
}
// Parses whole frames from buf; returns { frames: [{op, data, raw}], rest }.
function parse(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const total = off + (masked ? 4 : 0) + len;
    if (buf.length < total) break;
    const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
    if (masked) { const k = buf.subarray(off, off + 4); for (let i = 0; i < data.length; i++) data[i] ^= k[i & 3]; }
    frames.push({ op: buf[0] & 15, data, raw: buf.subarray(0, total) });
    buf = buf.subarray(total);
  }
  return { frames, rest: buf };
}

let info = null; // environment info of the computer image, fetched once from the control plane

createServer((client) => {
  let head = Buffer.alloc(0), bot = null, buf = Buffer.alloc(0), mode = "handshake", initParams = null, up = null;
  const queue = [];
  let busy = false;
  const send = (obj) => client.write(frame(1, Buffer.from(JSON.stringify(obj))));
  client.on("error", () => {});
  client.on("close", () => up?.destroy());

  async function goRemote(firstRaw) {
    mode = "switching";
    const t0 = Date.now();
    const r = await control({ op: "ensure", bot });
    if (!r.ok) { mode = "local"; return { error: r.error }; }
    up = connect(7700, r.host);
    await new Promise((res, rej) => { up.once("connect", res); up.once("error", rej); }).catch((e) => { up = null; });
    if (!up) { mode = "local"; return { error: "couldn't reach the computer" }; }
    const key = randomBytes(16).toString("base64");
    up.write(`GET / HTTP/1.1\r\nHost: ${r.host}:7700\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    // Wait for 101, then replay the session start and swallow its reply.
    let ub = Buffer.alloc(0);
    await new Promise((resolve) => {
      let gotHead = false;
      const onData = (d) => {
        ub = Buffer.concat([ub, d]);
        if (!gotHead) {
          if (!ub.includes("\r\n\r\n")) return;
          if (!/^HTTP\/1\.1 101/.test(ub.toString("latin1", 0, 20))) { up.destroy(); return resolve(); }
          gotHead = true; ub = ub.subarray(ub.indexOf("\r\n\r\n") + 4);
          up.write(frame(1, Buffer.from(JSON.stringify({ id: "pitcrew-init", method: "initialize", params: { ...initParams, resumeSessionId: null } })), true));
          up.write(frame(1, Buffer.from(JSON.stringify({ method: "initialized", params: {} })), true));
        }
        // Swallow our replayed initialize reply; anything after it is Codex's and is forwarded once we hand over.
        const { frames, rest } = parse(ub);
        const i = frames.findIndex((f) => f.op === 1 && f.data.includes('"pitcrew-init"'));
        if (i >= 0) { ub = Buffer.concat([...frames.slice(i + 1).map((f) => f.raw), rest]); up.off("data", onData); resolve(); }
      };
      up.on("data", onData);
      setTimeout(resolve, 15000);
    });
    if (up.destroyed) { mode = "local"; up = null; return { error: "the computer refused the session" }; }
    let last = 0;
    const touch = () => { const t = Date.now(); if (t - last > 30000) { last = t; control({ op: "touch", bot }); } };
    if (ub.length) client.write(ub);
    up.on("data", (x) => { touch(); client.write(x); });
    up.on("close", () => client.destroy());
    up.on("error", () => client.destroy());
    up.write(firstRaw);
    for (const q of queue.splice(0)) up.write(q.raw);
    if (buf.length) { up.write(buf); buf = Buffer.alloc(0); }
    mode = "remote";
    console.error(`gateway ${bot}: computer handover in ${Date.now() - t0} ms (boot ${r.bootMs ?? "?"} ms)`);
    client.on("data", (x) => { if (mode === "remote") { touch(); up.write(x); } });
    return { ok: true };
  }

  async function handle(f) {
    if (f.op === 8) { client.end(frame(8, Buffer.alloc(0))); return; }
    if (f.op === 9) { client.write(frame(10, f.data)); return; }
    if (f.op !== 1) return;
    let msg; try { msg = JSON.parse(f.data); } catch { return; }
    if (msg.method === "initialize") { initParams = msg.params || {}; info ||= (await control({ op: "info" })).info; return send({ id: msg.id, result: { sessionId: randomUUID(), environmentInfo: info } }); }
    if (msg.method === "initialized" || msg.id === undefined) return;
    if (msg.method === "environment/info") { info ||= (await control({ op: "info" })).info; return send({ id: msg.id, result: info }); }
    if (LOCAL.has(msg.method)) {
      const r = await control({ op: "fs", bot, method: msg.method, params: msg.params || {} });
      if (!r.fallback) return send(r.error ? { id: msg.id, error: r.error } : { id: msg.id, result: r.result });
    }
    const g = await goRemote(f.raw);
    if (g.error) send({ id: msg.id, error: { code: -32000, message: `Pitcrew couldn't start the computer: ${g.error}` } });
  }

  async function pump() {
    if (busy) return; busy = true;
    while (queue.length && mode === "local") { const f = queue.shift(); await handle(f); }
    busy = false;
  }

  client.on("data", (d) => {
    if (mode === "remote") return;
    if (mode === "handshake") {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 16384) client.destroy(); return; }
      const req = head.toString("latin1", 0, end);
      const m = /^GET \/([a-z0-9][a-z0-9-]{0,40}) HTTP\/1\.1\r\n/.exec(req), k = /\r\nsec-websocket-key: *([^\r\n]+)/i.exec(req);
      if (!m || !k) return client.end("HTTP/1.1 404 Not Found\r\n\r\n");
      bot = m[1];
      const accept = createHash("sha1").update(k[1].trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      mode = "local"; d = head.subarray(end + 4);
    }
    buf = Buffer.concat([buf, d]);
    const { frames, rest } = parse(buf); buf = rest;
    queue.push(...frames);
    if (mode === "local") pump();
  });
}).listen(7700, "127.0.0.1");
