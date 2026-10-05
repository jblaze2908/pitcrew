// The pit wall's own settings and feeds: state, the live stream, settings, providers and models, the kill switch,
// telemetry, export and the audit log.
import { Hono } from "hono";
import { z } from "zod";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { all, setSetting, audit } from "../db.js";
import { httpErr, getSecret } from "../auth.js";
import * as P from "../providers.js";
import * as R from "../runtime/index.js";
import { signedIn, type Env } from "../http/guard.js";
import { readJson, jsonBody, given, pick, raw } from "../http/body.js";
import { state } from "./views.js";
import { telemetrySummary } from "./lists.js";

const PROVIDER_IDS = ["openrouter", "aigateway", "openai"] as const;
const Settings = z.object({
  driverName: given((v) => String(v).trim().slice(0, 40) || "Driver"),
  defaultProvider: pick(PROVIDER_IDS, null),
  plainVoice: given((v) => (v ? "1" : "0")),
  plans: given((v) => (v ? "1" : "0")),
});
const Key = z.object({ key: raw });

const Push = z.object({ url: given((v) => String(v)), token: given((v) => (v === null ? "" : String(v))) });

export const systemRoutes = new Hono<Env>()
  .get("/api/state", signedIn, (c) => c.json(state()))
  // Phone push (runtime/push.ts): the topic, a test, the presence beat that keeps pushes off while Pitcrew is in view.
  .get("/api/push", signedIn, (c) => c.json(R.pushConfig()))
  .put("/api/push", signedIn, async (c) => { const b = await jsonBody(c, Push); R.setPushConfig(b.url ?? R.pushConfig().url, b.token); return c.json(R.pushConfig()); })
  .post("/api/push/test", signedIn, async (c) => c.json({ ok: await R.pushTest().catch(() => false) }))
  .post("/api/presence", signedIn, (c) => { R.markPresent(); return c.json({ ok: true }); })
  // A phone button: no session, the link itself is the proof (one pit stop, one decision, until it's decided or expires).
  .post("/api/push/act/:token", async (c) => {
    const t = R.readActToken(c.req.param("token")), p = t && R.pitForAct(t.id);
    if (!t || !p) throw httpErr(404, "Not found");
    if (p.status !== "pending") return c.text(`Already ${p.status}.`, 410);
    if (t.decision === "approve" && !R.phoneMayApprove(p)) return c.text("Open Pitcrew to approve this one.", 403);
    await R.decide(p.id, t.decision, { scope: p.kind === "site" ? "thread" : "once", note: "from your phone" });
    audit("driver", "pitstop.phone", { id: p.id, decision: t.decision });
    return c.text(t.decision === "approve" ? "Approved." : "Denied.");
  })
  // ?thread=<id> also subscribes to that thread's transcript (events, deltas, activity, context); the rest is global.
  .get("/api/stream", signedIn, (c) => {
    const thread = c.req.query("thread"), res = c.env.outgoing;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": hi\n\n"); R.bus.add(res, /^[\w-]{1,64}$/.test(thread || "") ? thread! : null);
    return RESPONSE_ALREADY_SENT;
  })
  .patch("/api/settings", signedIn, async (c) => {
    const sent = await readJson(c), b = Settings.parse(sent);
    if (b.driverName !== undefined) setSetting("driver_name", b.driverName);
    if (b.defaultProvider) setSetting("default_provider", b.defaultProvider);
    if (b.plainVoice !== undefined) setSetting("plain_voice", b.plainVoice);
    if (b.plans !== undefined) setSetting("plans", b.plans);
    audit("driver", "settings.updated", { fields: Object.keys(sent) });
    return c.json(state());
  })

  // Providers
  .get("/api/providers", signedIn, (c) => c.json(P.providerStatus()))
  .put("/api/providers/:p/key", signedIn, async (c) => { const b = await jsonBody(c, Key); return c.json(await P.setKey(c.req.param("p"), b.key)); })
  .delete("/api/providers/:p/key", signedIn, (c) => { P.removeKey(c.req.param("p")); return c.json(P.providerStatus()); })
  .post("/api/providers/:p/test", signedIn, async (c) => { const p = c.req.param("p"), k = getSecret(p); if (!k) throw httpErr(400, "No key saved"); return c.json(await P.testKey(p, k)); })
  .post("/api/providers/openai/login", signedIn, (c) => c.json(P.startChatgptLogin()))
  .post("/api/providers/openai/cancel", signedIn, (c) => { P.cancelChatgptLogin(); return c.json(P.providerStatus()); })
  .post("/api/providers/openai/signout", signedIn, (c) => { P.signOutChatgpt(); return c.json(P.providerStatus()); })
  .get("/api/models", signedIn, async (c) => {
    const q = (c.req.query("q") || "").toLowerCase();
    const list = await P.models(c.req.query("provider") || "openrouter");
    // No q: the whole catalogue (the model picker filters it client-side); with q, the best 60.
    return c.json(q ? list.filter((m) => m.id.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q)).slice(0, 60) : list);
  })

  // Kill switch
  .post("/api/kill", signedIn, async (c) => c.json(await R.killSwitch()))
  .post("/api/resume", signedIn, (c) => { R.resumeCrew(); return c.json(state()); })

  // Telemetry, export
  .get("/api/telemetry", signedIn, async (c) => { const [openrouter, chatgpt] = await Promise.all([P.openrouterUsage(), R.planLimits()]); return c.json({ ...telemetrySummary(c.req.query()), openrouter, chatgpt }); })
  .get("/api/export", signedIn, (c) => {
    const dump = { exportedAt: new Date().toISOString(), note: "Pitcrew export. Provider keys and auth tokens are never included.",
      settings: all("SELECT key,value FROM settings WHERE key!='password'"), bots: all("SELECT * FROM bots"), threads: all("SELECT * FROM threads"), turns: all("SELECT * FROM turns"),
      events: all("SELECT * FROM events"), pitstops: all("SELECT * FROM pitstops"), rules: all("SELECT * FROM rules"), learned: all("SELECT * FROM learned"), memory: all("SELECT * FROM memory"),
      schedules: all("SELECT * FROM schedules"), surfaces: all("SELECT * FROM surfaces"), audit: all("SELECT * FROM audit") };
    audit("driver", "export");
    return c.body(JSON.stringify(dump), 200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="pitcrew-export-${new Date().toISOString().slice(0, 10)}.json"` });
  })
  .get("/api/audit", signedIn, (c) => c.json(all("SELECT * FROM audit ORDER BY id DESC LIMIT 300")));
