// The JSON API: every /api route, with errors as { error } and responses shaped like delivery.send().
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpError } from "../auth.js";
import type { Env } from "../http/guard.js";
import { deliver } from "../http/reply.js";
import { sessionRoutes } from "./session.js";
import { systemRoutes } from "./system.js";
import { crewRoutes } from "./crew.js";
import { threadRoutes } from "./threads.js";
import { pitstopRoutes } from "./pitstops.js";
import { fileRoutes } from "./files.js";
import { engramRoutes } from "./engram.js";
import { homeRoutes } from "./home.js";
import { vaultRoutes } from "./vault.js";

export const api = new Hono<Env>()
  .use("/api/*", deliver)
  .route("/", sessionRoutes)
  .route("/", systemRoutes)
  .route("/", crewRoutes)
  .route("/", threadRoutes)
  .route("/", pitstopRoutes)
  .route("/", fileRoutes)
  .route("/", engramRoutes)
  .route("/", homeRoutes)
  .route("/", vaultRoutes);
export type AppType = typeof api;

api.notFound((c) => c.json({ error: "Not found" }, 404));
api.onError((e: HttpError, c) => {
  const status = e.status || 500;
  if (status === 500) console.error(new Date().toISOString(), c.req.method, c.req.path, e.stack);
  return c.json({ error: status === 500 ? "Something went wrong on the pit wall." : e.message }, status as ContentfulStatusCode);
});
