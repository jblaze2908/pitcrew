// The vault, driver side: list, add, edit, delete and import. Values go in and never come out; responses carry only
// which fields are set (vault.ts meta).
import { Hono } from "hono";
import { all, json } from "../db.js";
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
      try { added.push(saveVault({ kind: "login", name: r.name, site: r.site, username: r.username, password: r.password, allowed: r.allowed }).name); }
      catch (e: any) { failed.push({ name: String(r.name || r.site || "?").slice(0, 60), error: e.status ? e.message : "couldn't save" }); }
    }
    return c.json({ added, failed, vault: listVault() });
  });
