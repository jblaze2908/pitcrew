// Logs JSON-RPC methods Codex sends to an exec-server over WebSocket (client frames are masked).
import { createServer, connect } from "node:net";
const [, , listenPort, host, port] = process.argv;
createServer((c) => {
  const up = connect(+port, host);
  let buf = Buffer.alloc(0), shook = false;
  c.on("data", (d) => {
    up.write(d);
    if (!shook) { if (d.includes("\r\n\r\n")) { shook = true; d = d.subarray(d.indexOf("\r\n\r\n") + 4); console.log(`${Date.now()} CONNECT`); } else return; }
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      const s = data.toString(); try { const j = JSON.parse(s); console.log(`${Date.now()} → ${s.slice(0, 400)}`); } catch { console.log(`${Date.now()} → [${(buf[0] & 15)}] ${s.slice(0, 80)}`); }
    }
  });
  let sbuf = Buffer.alloc(0), sshook = false;
  up.on("data", (d) => {
    c.write(d);
    if (!sshook) { if (!d.includes("\r\n\r\n")) return; sshook = true; d = d.subarray(d.indexOf("\r\n\r\n") + 4); }
    sbuf = Buffer.concat([sbuf, d]);
    while (sbuf.length >= 2) {
      let len = sbuf[1] & 127, off = 2;
      if (len === 126) { if (sbuf.length < 4) return; len = sbuf.readUInt16BE(2); off = 4; } else if (len === 127) { if (sbuf.length < 10) return; len = Number(sbuf.readBigUInt64BE(2)); off = 10; }
      if (sbuf.length < off + len) return;
      const s = sbuf.subarray(off, off + len).toString(); sbuf = sbuf.subarray(off + len);
      console.log(`${Date.now()} ← ${s.slice(0, 700)}`);
    }
  });
  const close = () => { up.destroy(); c.destroy(); };
  c.on("close", close); up.on("close", close); c.on("error", close); up.on("error", close);
}).listen(+listenPort, "0.0.0.0");
