// Signing in: first-run setup (gated by the setup token), login, logout and password change.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { setSetting, audit } from "../db.js";
import * as A from "../auth.js";
import { anyone, signedIn, authed, cookie, type Env } from "../http/guard.js";
import { jsonBody, raw, truthy } from "../http/body.js";

const Setup = z.object({ token: raw, password: raw, driverName: truthy((v) => String(v).slice(0, 40)) });
const Login = z.object({ password: raw });
const Password = z.object({ current: raw, next: raw });

const login = (c: Context) => c.header("Set-Cookie", `pc_s=${A.newSession()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Strict`);

export const sessionRoutes = new Hono<Env>()
  .get("/api/session", anyone, (c) => c.json({ setup: A.setupDone(), authed: authed(c.req.header("cookie")) }))
  .post("/api/setup", anyone, async (c) => {
    const b = await jsonBody(c, Setup);
    A.setupPassword(b.token, b.password);
    if (b.driverName !== undefined) setSetting("driver_name", b.driverName);
    login(c); return c.json({ ok: true });
  })
  .post("/api/login", anyone, async (c) => { const b = await jsonBody(c, Login); A.checkPassword(b.password); login(c); audit("driver", "login"); return c.json({ ok: true }); })
  .post("/api/logout", signedIn, (c) => { A.endSession(cookie(c.req.header("cookie"), "pc_s")); c.header("Set-Cookie", "pc_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"); return c.json({ ok: true }); })
  .post("/api/password", signedIn, async (c) => { const b = await jsonBody(c, Password); A.checkPassword(b.current); A.setPassword(b.next); A.endAllSessions(); audit("driver", "password.changed"); return c.json({ ok: true, relogin: true }); });
