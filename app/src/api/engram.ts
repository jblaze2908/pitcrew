// Settings → Engram: the link (URL + token), its test and unlink, member tokens, the digest card, decisions on mirrored
// proposals and the one-shot memory move. The token is write-only, like provider keys.
import { Hono } from "hono";
import { z } from "zod";
import { httpErr } from "../auth.js";
import { getBot } from "../crew.js";
import * as E from "../engram.js";
import { engramUrl } from "../engramStore.js";
import { signedIn, type Env } from "../http/guard.js";
import { jsonBody, raw, pick } from "../http/body.js";

const Link = z.object({ url: raw, token: raw });
const ArtifactQuery = z.object({
  q: z.string().max(100).optional(), member: z.string().regex(/^[\w-]{1,100}$/).optional(), status: z.enum(["public", "waiting", "private"]).optional(),
  kind: z.enum(["page", "pdf", "image", "other"]).optional(), imported: z.literal("1").optional(),
  cursor: z.string().regex(/^\d{1,15}:[\w-]{1,100}$/).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
});
const Decision = z.object({ decision: pick(["accept", "keep", "reject"] as const, null) });

export const engramRoutes = new Hono<Env>()
  .get("/api/engram", signedIn, (c) => c.json(E.status()))
  .put("/api/engram", signedIn, async (c) => { const b = await jsonBody(c, Link); return c.json(await E.setLink(b.url, b.token)); })
  .post("/api/engram/test", signedIn, async (c) => { await E.testLink(); return c.json(E.status()); })
  .delete("/api/engram", signedIn, (c) => c.json(E.unlink()))
  .post("/api/engram/members/:id/rotate", signedIn, async (c) => {
    const b = getBot(c.req.param("id")); if (!b) throw httpErr(404, "No such crew member");
    await E.linkMember(b); return c.json(E.status());
  })
  .get("/api/engram/artifacts", signedIn, async (c) => {
    const f = ArtifactQuery.safeParse(c.req.query()); if (!f.success) throw httpErr(400, "Invalid filter");
    return c.json(await E.listArtifacts(f.data));
  })
  .get("/api/engram/connections", signedIn, async (c) => c.json({ connections: await E.listConnections() }))
  .post("/api/engram/migrate", signedIn, (c) => c.json(E.startMigration()))
  .get("/api/engram/digest", signedIn, async (c) => { const d = await E.digest(); return c.json({ url: engramUrl(), at: d?.at ?? null, digest: d?.digest ?? null }); })
  .post("/api/engram/inbox/:id", signedIn, async (c) => {
    const b = await jsonBody(c, Decision); if (!b.decision) throw httpErr(400, "decision is accept, keep or reject");
    return c.json(await E.decideProposal(c.req.param("id"), b.decision));
  });
