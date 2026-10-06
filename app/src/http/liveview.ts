// Live view: noVNC speaks WebSocket; the computer's x11vnc listens on a unix socket in its bot dir. Bridge them here, behind auth.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { getBot } from "../crew.js";
import { botDir, allComputers } from "../computer.js";
import { authed, sameOrigin } from "./guard.js";

export function liveView(req: IncomingMessage, sock: Duplex) {
  const m = /^\/live\/([\w-]+)\/ws$/.exec(new URL(req.url!, "http://x").pathname);
  if (!m || !authed(req.headers.cookie) || !sameOrigin(req.headers.origin, req.headers.host) || !getBot(m[1]) || !req.headers["sec-websocket-key"]) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const path = `${botDir(m[1])}/run/vnc.sock`;
  // A socket file can outlive its computer (a deploy restarts them); only a running desktop has a live one.
  if (!existsSync(path) || !allComputers().find((c) => c.bot.id === m[1])?.desktopUp) { sock.end("HTTP/1.1 409 Conflict\r\n\r\n"); return; }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const proto = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).includes("binary") ? "Sec-WebSocket-Protocol: binary\r\n" : "";
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
  const comp = allComputers().find((c) => c.bot.id === m[1]);
  if (comp) comp.viewers++;
  const vnc = connect(path);
  const frame = (op: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
    sock.write(Buffer.concat([head, payload]));
  };
  vnc.on("data", (d) => frame(2, d));
  let buf = Buffer.alloc(0);
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked) return sock.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { frame(8, Buffer.alloc(0)); return sock.end(); }
      if (op === 9) frame(10, data);
      else if (op === 2 || op === 0 || op === 1) vnc.write(data);
    }
  });
  // Once per viewer: destroy() re-fires close/error on both sockets, and a second decrement would let the idle sweeper
  // stop a computer another tab still watches.
  let closed = false;
  const close = () => { if (closed) return; closed = true; if (comp && comp.viewers > 0) { comp.viewers--; comp.lastActive = Date.now(); } vnc.destroy(); sock.destroy(); };
  vnc.on("close", close); vnc.on("error", close); sock.on("close", close); sock.on("error", close);
}
