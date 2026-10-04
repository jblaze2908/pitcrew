// Files view: browse a crew member's workspace on the host's disk (works with the computer off), the Library, and what
// each turn changed.
import { Hono } from "hono";
import { readFileSync, statSync, realpathSync, readdirSync, type Stats } from "node:fs";
import { join, normalize } from "node:path";
import { one, all, json } from "../db.js";
import { httpErr } from "../auth.js";
import { getBot, listBots } from "../crew.js";
import { botDir, listFiles } from "../computer.js";
import { objectText, type Change } from "../snapshot.js";
import { signedIn, type Env } from "../http/guard.js";

function workPath(botId: string, rel: unknown) {
  let base: string, full: string;
  try { base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(join(base, normalize(String(rel || "").replace(/^\/+/, "")))); } catch { return null; }
  return full === base || full.startsWith(base + "/") ? { base, full } : null;
}

export const fileRoutes = new Hono<Env>()
  .get("/api/library", signedIn, (c) => c.json(listBots().map((b) => ({ id: b.id, name: b.name, hue: b.hue, shape: b.shape, files: listFiles(b.id) }))))
  .get("/api/bots/:id/fs", signedIn, (c) => {
    const id = c.req.param("id");
    if (!getBot(id)) throw httpErr(404, "No such crew member");
    const rel = c.req.query("path") || "";
    const w = workPath(id, rel); if (!w) throw httpErr(404, "Not found");
    const st = statSync(w.full);
    if (st.isDirectory()) {
      const entries = readdirSync(w.full, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isFile()).map((e) => { let s: Stats | null = null; try { s = statSync(join(w.full, e.name)); } catch {} return { name: e.name, dir: e.isDirectory(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }; })
        .sort((a, b) => (+b.dir - +a.dir) || a.name.localeCompare(b.name)).slice(0, 1000);
      return c.json({ type: "dir", path: w.full.slice(w.base.length + 1), entries });
    }
    const out: { type: "file"; path: string; size: number; mtime: number; image: boolean; text?: string } = { type: "file", path: w.full.slice(w.base.length + 1), size: st.size, mtime: st.mtimeMs, image: /\.(png|jpe?g|webp|gif)$/i.test(w.full) };
    if (!out.image && st.size <= 1 << 20) { const buf = readFileSync(w.full); if (!buf.subarray(0, 8000).includes(0)) out.text = buf.toString("utf8"); }
    return c.json(out);
  })
  .get("/api/bots/:id/changes", signedIn, (c) => c.json(all<{ id: string; thread_id: string; started_at: number; changes: string; thread_title: string; cost_usd: number | null }>("SELECT t.id, t.thread_id, t.started_at, t.changes, t.cost_usd, th.title thread_title FROM turns t JOIN threads th ON th.id=t.thread_id WHERE t.bot_id=? AND t.changes IS NOT NULL ORDER BY t.started_at DESC LIMIT 40", c.req.param("id")).map((r) => ({ ...r, changes: json<Change[]>(r.changes, []) }))))
  .get("/api/turns/:id/diff", signedIn, (c) => {
    const t = one<{ bot_id: string; changes: string | null }>("SELECT bot_id, changes FROM turns WHERE id=?", c.req.param("id")); if (!t) throw httpErr(404, "No such run");
    const path = c.req.query("path") ?? null;
    const ch = json<Change[]>(t.changes, []).find((x) => x.path === path); if (!ch) throw httpErr(404, "Not changed in this run");
    return c.json({ ...ch, beforeText: ch.before ? objectText(t.bot_id, ch.before) : "", afterText: ch.after ? objectText(t.bot_id, ch.after) : "" });
  });
