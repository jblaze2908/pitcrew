// Minimal MCP stdio server: pixel-level computer use on the bot's own X display.
// Every action returns a fresh screenshot, so the model sees the result without an extra call.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const DISPLAY = process.env.DISPLAY || ":1";
const env = { ...process.env, DISPLAY };
const x = (...args) => execFileSync("xdotool", args, { env });
// JPEG: the model is billed by pixel size, not bytes, and every later request resends the image; JPEG keeps that payload small.
const shot = () => execFileSync("import", ["-window", "root", "-quality", "80", "jpeg:-"], { env, maxBuffer: 32 << 20 }).toString("base64");
const frame = () => createHash("sha1").update(execFileSync("import", ["-window", "root", "-depth", "8", "rgb:-"], { env, maxBuffer: 16 << 20 })).digest("hex");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// The live-view pointer glides for ~0.5 s; clicking after it arrives keeps the press where the pointer is shown.
// Only worth waiting for while someone watches: the control plane passes _watched.
const GLIDE = 520;
const glide = (a) => (a._watched ? pause(GLIDE) : null);
// Instead of a fixed 700 ms after every action: wait 200 ms for the reaction to start, then until two frames 100 ms
// apart match (capped at 700 ms, so an animated page costs what it always did).
async function settle() {
  const end = Date.now() + 700;
  await pause(200);
  let a = frame();
  while (Date.now() < end) { await pause(100); const b = frame(); if (b === a) return; a = b; }
}

const TOOLS = {
  screenshot: { description: "Capture the whole 1280x800 screen.", props: {}, run: () => {} },
  click: { description: "Left-click at pixel (x, y). target = what you are clicking, as shown on screen (e.g. 'Submit order button').", props: { x: "integer", y: "integer", target: "string", button: "integer" }, req: ["x", "y", "target"],
    run: async (a) => { x("mousemove", "--sync", String(a.x), String(a.y)); await glide(a); x("click", String(a.button || 1)); } },
  double_click: { description: "Double-click at pixel (x, y). target = what you are clicking.", props: { x: "integer", y: "integer", target: "string" }, req: ["x", "y", "target"],
    run: async (a) => { x("mousemove", "--sync", String(a.x), String(a.y)); await glide(a); x("click", "--repeat", "2", "1"); } },
  type: { description: "Type text at the current focus. field = the field being typed into.", props: { text: "string", field: "string" }, req: ["text", "field"], run: (a) => x("type", "--delay", "25", "--", a.text) },
  key: { description: "Press a key or chord, e.g. Return, Tab, ctrl+l, ctrl+a, BackSpace. purpose = what the key press does here.", props: { keys: "string", purpose: "string" }, req: ["keys", "purpose"], run: (a) => x("key", "--", a.keys) },
  scroll: { description: "Scroll the page at (x, y). direction up|down, amount in notches.", props: { x: "integer", y: "integer", direction: "string", amount: "integer" }, req: ["direction"],
    run: (a) => { if (a.x != null) x("mousemove", String(a.x), String(a.y)); x("click", "--repeat", String(a.amount || 3), a.direction === "up" ? "4" : "5"); } },
};

const schema = (t) => ({ type: "object", properties: Object.fromEntries(Object.entries(t.props).map(([k, v]) => [k, { type: v }])), required: t.req || [] });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let buf = "";
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pitcrew-computer", version: "0.1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: schema(t) })) } });
    else if (m.method === "tools/call") {
      const t = TOOLS[m.params.name];
      try {
        if (!t) throw new Error(`unknown tool ${m.params.name}`);
        await t.run(m.params.arguments || {});
        if (m.params.name !== "screenshot") await settle();
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${m.params.name} ok` }, { type: "image", data: shot(), mimeType: "image/jpeg" }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: String(e.message).slice(0, 300) }] } });
      }
    } else send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
