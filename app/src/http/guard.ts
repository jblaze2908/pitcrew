// Who may call what: the driver's session cookie, and the cross-site rule for anything that isn't a GET.
import { createMiddleware } from "hono/factory";
import type { HttpBindings } from "@hono/node-server";
import * as A from "../auth.js";

export type Env = { Bindings: HttpBindings };

export const cookie = (header: string | undefined, name: string) => (header || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
export const authed = (cookieHeader: string | undefined) => A.sessionValid(cookie(cookieHeader, "pc_s"));
export const sameOrigin = (origin: string | undefined, host: string | undefined) => !origin || origin === `https://${host}` || origin === `http://${host}`;

// Runs per route, once it matched (an unknown route is a plain 404): non-GET needs the same origin and X-Pitcrew: 1,
// then a session unless the route is open.
const guard = (open: boolean) => createMiddleware<Env>(async (c, next) => {
  if (c.req.method !== "GET" && (!sameOrigin(c.req.header("origin"), c.req.header("host")) || c.req.header("x-pitcrew") !== "1")) throw A.httpErr(403, "Cross-site request refused");
  if (!open && !authed(c.req.header("cookie"))) throw A.httpErr(401, "Sign in");
  await next();
});
export const signedIn = guard(false), anyone = guard(true);
