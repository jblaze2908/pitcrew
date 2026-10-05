// End-to-end check of a running Pitcrew, from inside the app container:
//   <key source> | docker exec -i pitcrew-app node /app/deploy-e2e.mjs [--key-from-stdin]
// Uses a temporary session row (deleted at the end); approves pit stops as the driver would; prints PASS/FAIL lines only.
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { connect } from "node:net";

const B = "http://127.0.0.1:8330";
const db = new DatabaseSync("/srv/pitcrew/data/pitcrew.db");
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
db.prepare("INSERT INTO sessions(hash,created_at,expires_at) VALUES(?,?,?)").run(hash, Date.now(), Date.now() + 3600e3);
const H = { "X-Pitcrew": "1", "Content-Type": "application/json", Cookie: `pc_s=${token}` };
const api = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${j.error || ""}`); return j; };
const results = [];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const want = (s) => !only || only === s;
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the thread's run to finish, approving pit stops (once) along the way. Returns the new events.
async function runAndWait(threadId, text, { approve = true, timeoutMs = 600000, sinceId } = {}) {
  const before = sinceId ?? Math.max(0, ...(await api("GET", `/api/threads/${threadId}`)).events.map((e) => e.id));
  if (text) await api("POST", `/api/threads/${threadId}/messages`, { text });
  const t0 = Date.now(), approved = [];
  await sleep(3000);
  while (Date.now() - t0 < timeoutMs) {
    const pend = await api("GET", "/api/pitstops?status=pending");
    for (const p of pend.filter((p) => p.thread_id === threadId && p.kind !== "hire")) {
      approved.push(`${p.effect}: ${p.title.slice(0, 70)}`);
      await api("POST", `/api/pitstops/${p.id}/decide`, { decision: approve ? "approve" : "deny", scope: "once" });
    }
    const v = await api("GET", `/api/threads/${threadId}`);
    if (!v.thread.running && v.thread.status !== "running") {
      const evs = v.events.filter((e) => e.id > before);
      return { evs, approved, secs: Math.round((Date.now() - t0) / 1000), view: v };
    }
    await sleep(3000);
  }
  throw new Error("run timed out");
}
const lastAgent = (evs) => evs.filter((e) => e.kind === "agent").map((e) => e.data.text).join("\n");

try {
  if (process.argv.includes("--key-from-stdin")) {
    let key = ""; for await (const c of process.stdin) key += c;
    key = key.trim().replace(/^OPENROUTER_API_KEY=/, "").replace(/^["']|["']$/g, "");
    const r = await api("PUT", "/api/providers/openrouter/key", { key });
    check("OpenRouter key saved and tested", r.ok, r.detail);
  }
  if (only === "ops") {
    const l0 = await api("POST", "/api/providers/openai/login");
    let l = l0; for (let i = 0; i < 20 && !["waiting", "failed"].includes(l.status); i++) { await sleep(1500); l = (await api("GET", "/api/providers")).openai.login; }
    check("Sign in with ChatGPT shows a device code", l.status === "waiting" && /^https:\/\//.test(l.url || "") && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,6}$/.test(l.code || ""), `status=${l.status} url=${l.url ? new URL(l.url).host + new URL(l.url).pathname : "none"}`);
    await api("POST", "/api/providers/openai/cancel");
    const k = await api("POST", "/api/kill");
    const s1 = await api("GET", "/api/state");
    const th = s1.bots[0].threads[0].id;
    await api("POST", `/api/threads/${th}/messages`, { text: "ping" }); await sleep(800);
    const ev = (await api("GET", `/api/threads/${th}`)).events.at(-1);
    check("kill switch stops the crew and refuses new runs", s1.paused && ev.kind === "error" && /kill switch/i.test(ev.data.text), ev.data.text);
    const s2 = await api("POST", "/api/resume");
    check("resume clears the kill switch", s2.paused === false);
    throw Object.assign(new Error("done"), { done: true });
  }
  const st = await api("GET", "/api/state");
  const chief = st.bots.find((b) => b.kind === "chief");
  check("Crew Chief is built in", !!chief, chief ? `${chief.provider} · ${chief.model}` : "");
  // --probe: run the browser chore on a temporary OpenRouter/Claude crew member (retired afterwards), leaving the Chief alone.
  let botId = "chief";
  if (process.argv.includes("--probe")) { const b = await api("POST", "/api/hire", { name: "E2E probe", job: "Temporary test crew member", provider: "openrouter", model: "anthropic/claude-sonnet-5.5", weekly_cap_usd: 2 }); botId = b.id; globalThis.probeId = b.id;
    for (const t of (await api("GET", `/api/bots/${b.id}`)).bot.threads) await api("PATCH", `/api/threads/${t.id}`, { test: true }); }
  const { id: th } = await api("POST", "/api/threads", { botId, title: "E2E · browser form", test: true });
  globalThis.e2eThreads = [th];
  const comp = async () => (await api("GET", `/api/bots/${botId}`)).bot.computer;
  if (process.argv.includes("--probe")) {
    // Lazy stages: chat needs no computer; a command boots the computer but not the desktop.
    const r0 = await runAndWait(th, "What is 17 times 3? Answer with just the number, without using any tools.");
    const c0 = await comp();
    check("chat-only turn starts no computer", /51/.test(lastAgent(r0.evs)) && !c0.up, `said ${lastAgent(r0.evs).slice(0, 20)} · computer up=${c0.up} · ${r0.secs}s`);
    const r1s = await runAndWait(th, "Run `uname -n; echo pitcrew > /bot/work/lazy.txt; cat /bot/work/lazy.txt` in the shell and reply with its output.");
    const c1 = await comp();
    check("shell turn boots the computer, not the desktop", c1.up && !c1.desktop && /pitcrew/.test(lastAgent(r1s.evs)), `computer up=${c1.up} desktop=${c1.desktop} · ${r1s.secs}s`);
    const ch = await api("GET", `/api/bots/${botId}/changes`);
    const lazy = ch.flatMap((r) => r.changes.map((c) => ({ ...c, turn: r.id }))).find((c) => c.path === "lazy.txt");
    const d = lazy && await api("GET", `/api/turns/${lazy.turn}/diff?path=lazy.txt`);
    check("Files view recorded the shell's write with a diff", lazy?.status === "added" && /pitcrew/.test(d?.afterText || ""), lazy ? `${lazy.status} ${lazy.path}` : "not recorded");
  }

  // 1. Browser chore on the bot's own computer, gated by jev.
  const r1 = await runAndWait(th, "Using your browser tools: open https://httpbin.org/forms/post, fill Customer name 'Pitcrew v1', choose size Medium, tick Onion, and submit the order. Then read the page and reply with ONLY: custname=<value> size=<value>.");
  const tools = r1.evs.filter((e) => e.kind === "tool");
  check("browser tools ran on the computer", tools.some((e) => e.data.type === "browser"), `${tools.length} tool calls in ${r1.secs}s`);
  check("jev raised a pit stop for the submit", r1.approved.length > 0, r1.approved.join(" | ") || "none");
  if (process.argv.includes("--probe")) { const c2 = await comp(); check("browser turn booted the desktop", c2.desktop, `desktop=${c2.desktop}`); }
  check("form submitted, result read back", /custname=Pitcrew v1/i.test(lastAgent(r1.evs)) && /size=medium/i.test(lastAgent(r1.evs)), lastAgent(r1.evs).slice(0, 100));
  const run1 = (await api("GET", "/api/telemetry/runs?limit=50")).rows.find((r) => r.thread_id === th);
  check("run recorded with tokens and cost", run1 && run1.input_tokens > 0, run1 ? `${run1.status} in=${run1.input_tokens} cached=${run1.cached_tokens} out=${run1.output_tokens} cost=$${run1.cost_usd.toFixed(4)} (${run1.cost_basis})` : "missing");

  if (want("browser")) {
    const gates = db.prepare("SELECT action, data FROM audit WHERE actor='jev' AND ts>? ORDER BY id").all(Date.now() - 20 * 60e3).map((r) => `${r.action} ${JSON.parse(r.data).call?.tool || JSON.parse(r.data).call?.command || ""} [${JSON.parse(r.data).effect}]`);
    console.log("   jev:", gates.join(" | ") || "no gate decisions logged");
  }
  if (only === "browser") throw Object.assign(new Error("done"), { done: true });
  // 2. Generative UI: a surface with a comparison, a chart and a form; the form round-trips.
  const r2 = await runAndWait(th, "Call render_surface to show me three made-up electricity plans (Basic, Saver, Green) side by side with a Compare table, a BarChart of monthly cost in rupees, and a Form (action 'meter') asking for my meter number. Then just say 'shown'.");
  const sf = r2.evs.find((e) => e.kind === "surface");
  const surface = sf && r2.view.surfaces.find((s) => s.id === sf.data.id);
  const types = new Set(); const walk = (n) => { if (!n) return; types.add(n.type); (n.children || []).forEach(walk); }; walk(surface?.spec?.root);
  check("agent rendered a validated surface", !!surface, surface ? [...types].join(",") : "no surface");
  check("surface has Compare, BarChart and Form", ["Compare", "BarChart", "Form"].every((t) => types.has(t)));
  if (surface) {
    const before = Math.max(...r2.view.events.map((e) => e.id));
    await api("POST", `/api/surfaces/${surface.id}/action`, { action: "meter", values: { meter: "BES-448812" } });
    const r3 = await runAndWait(th, null, { sinceId: before });
    check("form submission reached the crew", r3.evs.some((e) => e.kind === "user" && /BES-448812/.test(e.data.text)) && /448812|meter/i.test(lastAgent(r3.evs)), lastAgent(r3.evs).slice(0, 90));
  }

  // 3. Memory and the Crew Chief's hire proposal (HITL).
  const { id: th2 } = await api("POST", "/api/threads", { botId: "chief", title: "E2E · crew", test: true });
  const r4 = await runAndWait(th2, "Remember this: my electricity provider is BESCOM. Also, I ask you about my utility bills every week; propose a dedicated crew member for bills with propose_crew_member. Keep your reply to one line.");
  const mem = (await api("GET", "/api/bots/chief")).memory;
  check("remember tool stored a memory", mem.some((m) => /BESCOM/i.test(m.text)), mem.map((m) => m.text).join(" | ").slice(0, 100));
  const hire = (await api("GET", "/api/pitstops?status=pending")).find((p) => p.kind === "hire");
  check("Crew Chief proposal became a HIRE pit stop", !!hire, hire ? hire.title.slice(0, 90) : "none");
  if (hire) {
    await api("POST", `/api/pitstops/${hire.id}/decide`, { decision: "approve", spec: { weekly_cap_usd: 2 } });
    const s2 = await api("GET", "/api/state");
    const nb = s2.bots.find((b) => b.kind === "specialist" && b.created_at > Date.now() - 600000);
    check("approving the HIRE created the crew member", !!nb, nb ? `${nb.name} · cap $${nb.weekly_cap_usd}` : "");
  }

  // 4. Live view: WebSocket → VNC handshake through the control plane, to a computer the browser chore left running.
  const rfb = await new Promise((resolve) => {
    const s = connect(8330, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let got = Buffer.alloc(0), upgraded = false;
    s.on("connect", () => s.write(`GET /live/${globalThis.probeId || "chief"}/ws HTTP/1.1\r\nHost: 127.0.0.1:8330\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nCookie: pc_s=${token}\r\n\r\n`));
    s.on("data", (d) => {
      got = Buffer.concat([got, d]);
      if (!upgraded) { const i = got.indexOf("\r\n\r\n"); if (i < 0) return; if (!/^HTTP\/1.1 101/.test(got.toString())) { s.destroy(); return resolve(got.toString().split("\r\n")[0]); } upgraded = true; got = got.subarray(i + 4); }
      if (got.length >= 2) { const len = got[1] & 127; if (got.length >= 2 + len) { s.destroy(); resolve(got.subarray(2, 2 + len).toString().trim()); } }
    });
    setTimeout(() => { s.destroy(); resolve("timeout"); }, 8000);
  });
  check("live view bridges to the computer's VNC", /^RFB 003\.\d{3}$/.test(rfb), rfb);
  const unauth = await fetch(B + "/api/state").then((r) => r.status);
  check("API refuses unauthenticated requests", unauth === 401);
} catch (e) {
  if (!e.done) check("e2e ran to completion", false, e.message);
} finally {
  for (const t of globalThis.e2eThreads || []) await api("PATCH", `/api/threads/${t}`, { archived: true }).catch(() => {});
  if (globalThis.probeId) await api("POST", `/api/bots/${globalThis.probeId}/archive`).catch(() => {});
  db.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
