// Workspace snapshots, for "what did this turn change?" regardless of how (apply_patch, sed, npm, a script).
// Runs twice per turn (start, end). Cost: one lstat per file; files are re-hashed only when size or mtime moved, using
// the bot's previous manifest. Bounded at MAX_FILES; text contents ≤ MAX_TEXT are kept, deduped by hash, in a
// root-only shadow dir outside the bot's mount, so a crew member can't see or rewrite its own history.
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { botDir, ROOT } from "./computer.mjs";

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo", ".pnpm-store", "target"]);
const MAX_FILES = 5000, MAX_TEXT = 1 << 20;
const shadow = (id) => `${ROOT}/data/shadow/${id}`;
const last = new Map(); // bot id → previous manifest, to skip re-hashing unchanged files

const isText = (buf) => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return false; return true; };

export function snapshot(id) {
  const base = `${botDir(id)}/work`, prev = last.get(id) || {}, files = {};
  let count = 0, truncated = false;
  mkdirSync(`${shadow(id)}/objects`, { recursive: true, mode: 0o700 });
  const walk = (rel) => {
    let ents; try { ents = readdirSync(rel ? `${base}/${rel}` : base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(r); continue; }
      if (!e.isFile()) continue;
      if (++count > MAX_FILES) { truncated = true; return; }
      let st; try { st = lstatSync(`${base}/${r}`); } catch { continue; }
      const p = prev[r];
      if (p && p.size === st.size && p.mtime === st.mtimeMs) { files[r] = p; continue; }
      let hash = null, text = false;
      if (st.size <= MAX_TEXT) {
        try {
          const buf = readFileSync(`${base}/${r}`);
          hash = createHash("sha256").update(buf).digest("hex");
          text = isText(buf);
          if (text && !existsSync(`${shadow(id)}/objects/${hash}`)) writeFileSync(`${shadow(id)}/objects/${hash}`, buf, { mode: 0o600 });
        } catch {}
      }
      files[r] = { size: st.size, mtime: st.mtimeMs, hash, text };
    }
  };
  walk("");
  last.set(id, files);
  return { files, truncated };
}

const lines = (id, hash) => { try { return readFileSync(`${shadow(id)}/objects/${hash}`, "utf8").split("\n").length; } catch { return 0; } };

// Compares two snapshots. Line counts are a cheap size signal for the summary; the real diff happens in the browser.
export function changes(id, before, after) {
  const out = [];
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const p of [...paths].sort()) {
    const a = before.files[p], b = after.files[p];
    if (a && b && a.size === b.size && a.mtime === b.mtime) continue;
    if (a && b && a.hash && a.hash === b.hash) continue;
    const status = !a ? "added" : !b ? "deleted" : "modified";
    out.push({ path: p, status, text: !!(b || a).text, size: (b || a).size, before: a?.hash || null, after: b?.hash || null,
      lines: (b?.text ? lines(id, b.hash) : 0) - (a?.text ? lines(id, a.hash) : 0) });
    if (out.length >= 300) break;
  }
  return out;
}

export function objectText(id, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash || "")) return null;
  try { return readFileSync(`${shadow(id)}/objects/${hash}`, "utf8"); } catch { return null; }
}
