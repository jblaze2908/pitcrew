// Workspace snapshots, for "what did this turn change?" regardless of how (apply_patch, sed, npm, a script).
// Runs twice per turn (start, end). Cost: one lstat per file; files are re-hashed only when size or mtime moved, using
// the bot's previous manifest. Bounded at MAX_FILES; text contents ≤ MAX_TEXT are kept, deduped by hash, in a
// root-only shadow dir outside the bot's mount, so a crew member can't see or rewrite its own history.
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { botDir, ROOT } from "./computer.js";

export interface FileState { size: number; mtime: number; hash: string | null; text: boolean }
export interface Snapshot { files: Record<string, FileState>; truncated: boolean }
export interface Change { path: string; status: "added" | "deleted" | "modified"; text: boolean; size: number; before: string | null; after: string | null; lines: number }

// .playwright-mcp: browser snapshot files from before they moved to PW_OUT; tool output, not the crew's work.
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo", ".pnpm-store", "target", ".playwright-mcp", ".scratch"]);
const MAX_FILES = 5000, MAX_TEXT = 1 << 20;
const shadow = (id: string) => `${ROOT}/data/shadow/${id}`;
const last = new Map<string, Record<string, FileState>>(); // bot id → previous manifest, to skip re-hashing unchanged files
// The manifest is also kept on disk, so the first turn after a restart doesn't re-hash the whole workspace.
const manifestPath = (id: string) => `${shadow(id)}/manifest.json`;
function previous(id: string) {
  if (!last.has(id)) { let m: any = null; try { m = JSON.parse(readFileSync(manifestPath(id), "utf8")); } catch {} last.set(id, m && typeof m === "object" && !Array.isArray(m) ? m : {}); }
  return last.get(id)!;
}

const isText = (buf: Buffer) => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return false; return true; };

export function snapshot(id: string): Snapshot {
  const base = `${botDir(id)}/work`, prev = previous(id), files: Record<string, FileState> = {};
  let count = 0, truncated = false, reused = 0;
  mkdirSync(`${shadow(id)}/objects`, { recursive: true, mode: 0o700 });
  const walk = (rel: string) => {
    let ents: import("node:fs").Dirent[]; try { ents = readdirSync(rel ? `${base}/${rel}` : base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(r); continue; }
      if (!e.isFile()) continue;
      if (++count > MAX_FILES) { truncated = true; return; }
      let st: import("node:fs").Stats; try { st = lstatSync(`${base}/${r}`); } catch { continue; }
      const p = prev[r];
      if (p && p.size === st.size && p.mtime === st.mtimeMs) { files[r] = p; reused++; continue; }
      let hash: string | null = null, text = false;
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
  // Rewritten only when something changed: a no-op turn costs no write.
  if (reused !== Object.keys(files).length || reused !== Object.keys(prev).length) {
    try { writeFileSync(`${manifestPath(id)}.tmp`, JSON.stringify(files), { mode: 0o600 }); renameSync(`${manifestPath(id)}.tmp`, manifestPath(id)); } catch {}
  }
  return { files, truncated };
}

const lines = (id: string, hash: string | null) => { try { return readFileSync(`${shadow(id)}/objects/${hash}`, "utf8").split("\n").length; } catch { return 0; } };

// Compares two snapshots. Line counts are a cheap size signal for the summary; the real diff happens in the browser.
export function changes(id: string, before: Snapshot, after: Snapshot) {
  const out: Change[] = [];
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const p of [...paths].sort()) {
    const a = before.files[p], b = after.files[p];
    if (a && b && a.size === b.size && a.mtime === b.mtime) continue;
    if (a && b && a.hash && a.hash === b.hash) continue;
    const status = !a ? "added" : !b ? "deleted" : "modified";
    out.push({ path: p, status, text: !!(b || a)!.text, size: (b || a)!.size, before: a?.hash || null, after: b?.hash || null,
      lines: (b?.text ? lines(id, b.hash) : 0) - (a?.text ? lines(id, a.hash) : 0) });
    if (out.length >= 300) break;
  }
  return out;
}

export function objectText(id: string, hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash || "")) return null;
  try { return readFileSync(`${shadow(id)}/objects/${hash}`, "utf8"); } catch { return null; }
}

// Names of files in the member's .scratch (bounded walk: 5,000 files), so a run that tidied working files away reads as
// "tidied", not as hundreds of deletions. Only walked when a run deleted something.
export function scratchNames(id: string) {
  const names = new Set<string>(), root = `${botDir(id)}/work/.scratch`;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || names.size >= 5000) return;
    let ents: Dirent[] = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (e.isDirectory()) walk(`${dir}/${e.name}`, depth + 1); else names.add(e.name); }
  };
  walk(root, 0);
  return names;
}
