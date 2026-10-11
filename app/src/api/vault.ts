// The vault, driver side: list, add, edit, delete and import. Values go in and never come out; responses carry only
// which fields are set (vault.ts meta).
import { Hono } from "hono";
import { all, one, run, json } from "../db.js";
import { httpErr } from "../auth.js";
import type { PitstopRow } from "../models.js";
import { pitRow } from "./views.js";
import * as R from "../runtime/index.js";
import { listVault, saveVault, removeVault } from "../vault.js";
import { signedIn, type Env } from "../http/guard.js";
import { readJson } from "../http/body.js";

// A saved value answers a "failed — update it in Vault" pit stop for that secret.
async function settleReminders(id: string) {
  for (const ps of all<{ id: string; detail: string }>("SELECT id, detail FROM pitstops WHERE kind='vault' AND status='pending'"))
    if (json(ps.detail, {}).secret?.id === id) await R.decide(ps.id, "approve", { note: "Updated in Vault" });
}

export const vaultRoutes = new Hono<Env>()
  .get("/api/vault", signedIn, (c) => c.json(listVault()))
  .post("/api/vault", signedIn, async (c) => c.json(saveVault(await readJson(c))))
  .put("/api/vault/:id", signedIn, async (c) => { const v = saveVault(await readJson(c), c.req.param("id")); if (!v.needs_update) await settleReminders(v.id); return c.json(v); })
  .delete("/api/vault/:id", signedIn, async (c) => { const r = removeVault(c.req.param("id")); await settleReminders(c.req.param("id")); return c.json(r); })
  // Only the rows the driver ticked arrive (the CSV is parsed in the browser); each becomes a login, or fails alone.
  .post("/api/vault/import", signedIn, async (c) => {
    const rows = ((await readJson(c)).rows || []).slice(0, 200) as Record<string, unknown>[];
    const added: string[] = [], failed: { name: string; error: string }[] = [];
    for (const r of rows) {
      try { added.push(saveVault({ kind: "login", name: r.name, site: r.site, username: r.username, password: r.password, allowed: r.allowed, always: r.always }).name); }
      catch (e: any) { failed.push({ name: String(r.name || r.site || "?").slice(0, 60), error: e.status ? e.message : "couldn't save" }); }
    }
    return c.json({ added, failed, vault: listVault() });
  })
  // The form in a member's "login" pit stop (runtime/browser.ts requestLogin): saves a login for that page's site, for
  // that member only, then lets its fill go on. The pit stop keeps the name, never a value.
  .post("/api/vault/login/:ps", signedIn, async (c) => {
    const ps = one<PitstopRow>("SELECT * FROM pitstops WHERE id=? AND kind='login' AND status='pending'", c.req.param("ps"));
    if (!ps) throw httpErr(404, "That request was already answered");
    const b = await readJson(c), d = json(ps.detail, {});
    const v = saveVault({ kind: "login", name: b.name || d.login?.name, site: d.login?.site, username: b.username, password: b.password, allowed: [ps.bot_id], always: b.always ? [ps.bot_id] : [] });
    run("UPDATE pitstops SET detail=? WHERE id=?", JSON.stringify({ ...d, saved: { id: v.id, name: v.name } }), ps.id);
    await R.decide(ps.id, "approve", { note: `Saved in Vault as ${v.name}` });
    return c.json(pitRow(one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", ps.id)));
  });
