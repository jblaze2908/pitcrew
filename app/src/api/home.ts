// Home: "Since you last looked" (runtime/inbox.ts) and the crew activity log (runtime/activity.ts).
import { Hono } from "hono";
import { audit } from "../db.js";
import * as R from "../runtime/index.js";
import { signedIn, type Env } from "../http/guard.js";

export const homeRoutes = new Hono<Env>()
  .get("/api/inbox", signedIn, (c) => c.json(R.inbox()))
  .post("/api/inbox/read", signedIn, (c) => { const n = R.markAllSeen(); audit("driver", "inbox.read_all", { threads: n }); return c.json({ ok: true }); })
  // ?bot=&effect=&by=&before=<cursor>&limit=; the cost per page is in activity()'s comment.
  .get("/api/activity", signedIn, (c) => { const q = c.req.query(); return c.json(R.activity({ bot: q.bot || null, effect: q.effect || null, by: q.by || null, before: q.before || null, limit: Number(q.limit) || 50 })); });
