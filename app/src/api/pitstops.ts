// Pit stops and what the driver's answers leave behind: standing rules, learned patterns and per-site policy.
import { Hono } from "hono";
import { z } from "zod";
import { one, all, run, now, audit } from "../db.js";
import { httpErr } from "../auth.js";
import * as R from "../runtime/index.js";
import { getBot } from "../crew.js";
import { listSites, setSite, removeSite, MODES } from "../domains.js";
import { signedIn, type Env } from "../http/guard.js";
import { readJson, jsonBody, pick, field } from "../http/body.js";
import { pitRow, LEARNED, liveLearned } from "./views.js";
import type { LearnedRow, PitstopRow } from "../models.js";

const SCOPES = ["once", "thread", "always", "site", "full", "block"] as const;
const Decide = z.object({ decision: pick(["approve"], "deny"), scope: pick(SCOPES, "once"), note: field((v) => v || ""), spec: field((v) => v || null) });
const Batch = z.object({ ids: field((v): unknown[] => (v || []).slice(0, 50)), decision: pick(["approve"], "deny") });

// Sites: per-domain policy, global (scope=global) or per crew member (scope=<bot id>).
const siteScope = (scope: unknown) => { if (scope === "global" || getBot(String(scope || ""))) return String(scope); throw httpErr(400, "scope is global or a crew member id"); };

export const pitstopRoutes = new Hono<Env>()
  .get("/api/pitstops", signedIn, (c) => {
    const st = c.req.query("status");
    return c.json(st === "pending" ? all<PitstopRow>("SELECT * FROM pitstops WHERE status='pending' ORDER BY created_at").map(pitRow) : all<PitstopRow>("SELECT * FROM pitstops ORDER BY created_at DESC LIMIT 200").map(pitRow));
  })
  .post("/api/pitstops/:id/decide", signedIn, async (c) => { const b = await jsonBody(c, Decide); return c.json(pitRow(await R.decide(c.req.param("id"), b.decision, { scope: b.scope, note: b.note, spec: b.spec })) ?? { ok: true }); })
  .post("/api/pitstops/batch", signedIn, async (c) => {
    const b = await jsonBody(c, Batch);
    const out: unknown[] = [];
    for (const id of b.ids) {
      const ps = one<{ kind: string }>("SELECT kind FROM pitstops WHERE id=?", id as string);
      if (ps && ps.kind !== "hire") out.push(await R.decide(id as string, b.decision, { scope: "once", note: "batch" }));
    }
    return c.json({ decided: out.length });
  })
  .get("/api/sites", signedIn, (c) => { const scope = siteScope(c.req.query("scope")); return c.json({ scope, modes: MODES, sites: listSites(scope) }); })
  // domain, mode and overrides are cleaned by setSite itself (domains.ts).
  .put("/api/sites", signedIn, async (c) => { const b = await readJson(c); return c.json(setSite(siteScope(b.scope), b.domain, b.mode, b.overrides)); })
  .delete("/api/sites", signedIn, (c) => c.json(removeSite(siteScope(c.req.query("scope")), String(c.req.query("domain") || ""))))
  .get("/api/rules", signedIn, (c) => c.json(all("SELECT r.*, b.name bot_name FROM rules r JOIN bots b ON b.id=r.bot_id WHERE r.revoked_at IS NULL ORDER BY r.created_at DESC")))
  .post("/api/rules/:id/revoke", signedIn, (c) => { const id = c.req.param("id"); run("UPDATE rules SET revoked_at=? WHERE id=?", now(), id); audit("driver", "rule.revoked", { id }); return c.json({ ok: true }); })
  .get("/api/learned", signedIn, (c) => c.json(liveLearned(all<LearnedRow>(`${LEARNED} ORDER BY l.updated_at DESC LIMIT 200`))))
  // "Ask again": the pattern starts over and needs a fresh run of approvals; its history stays for the audit trail.
  .post("/api/learned/:id/reset", signedIn, (c) => { const id = c.req.param("id"); run("UPDATE learned SET streak=0, updated_at=? WHERE rowid=?", now(), Number(id)); audit("driver", "learned.reset", { id }); return c.json({ ok: true }); });
