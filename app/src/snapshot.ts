// Workspace snapshots, for "what did this turn change?" regardless of how (apply_patch, sed, npm, a script).
// Runs twice per turn (start, end). Cost: one lstat per file; files are re-hashed only when size or mtime moved, using
// the bot's previous manifest. Bounded at MAX_FILES; contents ≤ MAX_KEEP (text or not) are kept, deduped by hash, in a
// root-only shadow dir outside the bot's mount, so a crew member can't see or rewrite its own history. They are the
// restore points for rewinding a run (runtime/rewind.ts): a changed file costs one write of its new bytes, once per content.
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, unlinkSync, chownSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { botDir, ROOT, CREW_UID } from "./computer.js";
import { textLines } from "../shared/text.js";

// mode: permission bits, recorded when the file is hashed (manifests from before it have none).
export interface FileState { size: number; mtime: number; hash: string | null; text: boolean; mode?: number }
export interface Snapshot { files: Record<string, FileState>; truncated: boolean }
// mode: the file's permission bits before the turn, so a restore puts an executable back executable.
export interface Change { path: string; status: "added" | "deleted" | "modified"; text: boolean; size: number; before: string | null; after: string | null; lines: number; mode?: number | null }

// .playwright-mcp: browser snapshot files from before they moved to PW_OUT; tool output, not the crew's work.
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo", ".pnpm-store", "target", ".playwright-mcp", ".scratch"]);
const MAX_FILES = 5000, MAX_TEXT = 1 << 20, MAX_KEEP = 4 << 20;
// Per member; past it the oldest objects not in the current manifest go (pruneShadow), so old runs lose their restore point first.
const SHADOW_MAX = Number(process.env.PITCREW_SHADOW_MAX || 1 << 30);
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
      if (st.size <= MAX_KEEP) {
        try {
          const buf = readFileSync(`${base}/${r}`);
          hash = createHash("sha256").update(buf).digest("hex");
          text = st.size <= MAX_TEXT && isText(buf);
          if (!existsSync(`${shadow(id)}/objects/${hash}`)) writeFileSync(`${shadow(id)}/objects/${hash}`, buf, { mode: 0o600 });
        } catch {}
      }
      files[r] = { size: st.size, mtime: st.mtimeMs, hash, text, mode: st.mode & 0o777 };
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

// Counted the way the diff view splits lines, so a run's "+17" matches its file's diff.
const lines = (id: string, hash: string | null) => { try { return textLines(readFileSync(`${shadow(id)}/objects/${hash}`, "utf8")).length; } catch { return 0; } };

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
      lines: (b?.text ? lines(id, b.hash) : 0) - (a?.text ? lines(id, a.hash) : 0), mode: a?.mode ?? null });
    if (out.length >= 300) break;
  }
  return out;
}

export function objectText(id: string, hash: string) {
  if (!/^[0-9a-f]{64}$/.test(hash || "")) return null;
  // Binary and over-1 MiB objects are restore points only (MAX_KEEP); a diff never gets their bytes as text.
  try { const buf = readFileSync(`${shadow(id)}/objects/${hash}`); return buf.length <= MAX_TEXT && isText(buf) ? buf.toString("utf8") : null; } catch { return null; }
}

// ---------- restore points ----------
// What each path should go back to, from the change lists of a run and every run after it (oldest first): the earliest
// run that touched a path saw it as it was before the rewound run. hash null: it didn't exist then. unknown: it existed
// but was too big to keep (no hash), so it can't come back.
export interface Target { path: string; hash: string | null; mode: number | null; unknown: boolean }
export function restoreTargets(lists: Change[][]) {
  const out = new Map<string, Target>();
  for (const list of lists) for (const c of list || []) {
    if (out.has(c.path)) continue;
    out.set(c.path, { path: c.path, hash: c.before, mode: c.mode ?? null, unknown: c.status !== "added" && !c.before });
  }
  return [...out.values()];
}

// One line of a rewind's confirm sheet. kind: D = the run made it and it goes, A = it comes back, M = an older version.
export interface RestoreItem { path: string; kind: "A" | "D" | "M"; hash: string | null; mode: number | null; ok: boolean; why?: string }
const SAFE_SEG = /^(?!\.\.?$)[^/\0]+$/;
export const safeRel = (rel: string) => typeof rel === "string" && rel.length > 0 && rel.length < 1024 && rel.split("/").every((s) => SAFE_SEG.test(s));
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
function currentHash(full: string) { try { const st = lstatSync(full); return st.isFile() ? sha(readFileSync(full)) : st.isSymbolicLink() ? "link" : "other"; } catch { return null; } }

/** What a restore would do, path by path, leaving out paths already as they were. Per path: one lstat, and one read
 * and hash of the current file when it exists. */
export function planRestore(id: string, targets: Target[]): RestoreItem[] {
  const base = `${botDir(id)}/work`, out: RestoreItem[] = [];
  for (const t of targets) {
    if (!safeRel(t.path)) continue;
    const cur = currentHash(`${base}/${t.path}`);
    if (t.unknown) { out.push({ path: t.path, kind: cur ? "M" : "A", hash: null, mode: t.mode, ok: false, why: "too big to keep a copy" }); continue; }
    if (t.hash === null) { if (cur) out.push({ path: t.path, kind: "D", hash: null, mode: null, ok: cur !== "other", ...(cur === "other" ? { why: "now a folder" } : {}) }); continue; }
    if (cur === t.hash) continue;
    const kept = existsSync(`${shadow(id)}/objects/${t.hash}`);
    out.push({ path: t.path, kind: cur ? "M" : "A", hash: t.hash, mode: t.mode, ok: kept && cur !== "other", ...(!kept ? { why: "no copy kept" } : cur === "other" ? { why: "now a folder" } : {}) });
  }
  return out;
}

// Parent folders of a path, created as needed, refusing a link anywhere on the way: the control plane runs as root and
// a member could have planted work/x -> /srv to make a restore write outside its workspace.
function safeParent(base: string, rel: string) {
  let dir = base;
  for (const s of rel.split("/").slice(0, -1)) {
    dir = `${dir}/${s}`;
    let st; try { st = lstatSync(dir); } catch { mkdirSync(dir); try { chownSync(dir, CREW_UID, CREW_UID); } catch {} continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return dir;
}

/** Puts each ok item back: a kept copy is written beside the file and renamed over it (a link there is replaced, never
 * followed); a file the run made is removed. Returns the paths done and those that couldn't be. */
export function restoreFiles(id: string, items: RestoreItem[]) {
  const base = `${botDir(id)}/work`, done: string[] = [], failed: { path: string; why: string }[] = [];
  for (const it of items) {
    if (!it.ok || !safeRel(it.path)) { failed.push({ path: it.path, why: it.why || "not restorable" }); continue; }
    try {
      const dir = safeParent(base, it.path);
      if (!dir) { failed.push({ path: it.path, why: "a folder on the way is a link" }); continue; }
      const full = `${base}/${it.path}`;
      if (it.hash === null) {
        let st; try { st = lstatSync(full); } catch { done.push(it.path); continue; }
        if (st.isDirectory()) { failed.push({ path: it.path, why: "now a folder" }); continue; }
        unlinkSync(full); done.push(it.path); continue;
      }
      const buf = readFileSync(`${shadow(id)}/objects/${it.hash}`);
      if (sha(buf) !== it.hash) { failed.push({ path: it.path, why: "the kept copy is damaged" }); continue; }
      const tmp = `${dir}/.pitcrew-restore-${randomBytes(6).toString("hex")}`;
      writeFileSync(tmp, buf, { mode: 0o600, flag: "wx" });
      try { chownSync(tmp, CREW_UID, CREW_UID); } catch {}
      chmodSync(tmp, it.mode ?? 0o644);
      renameSync(tmp, full);
      done.push(it.path);
    } catch (e: any) { failed.push({ path: it.path, why: String(e.code || e.message).slice(0, 80) }); }
  }
  return { done, failed };
}

/** Keeps a member's shadow under SHADOW_MAX by removing the oldest objects the current manifest doesn't use. At most
 * hourly per member, after a turn (turns.ts): one readdir and one stat per object. */
const pruned = new Map<string, number>();
export function pruneShadow(id: string, max = SHADOW_MAX, at = Date.now()) {
  if (max === SHADOW_MAX && at - (pruned.get(id) || 0) < 3600_000) return 0;
  pruned.set(id, at);
  const dir = `${shadow(id)}/objects`, live = new Set(Object.values(previous(id)).map((f) => f.hash));
  let names: string[]; try { names = readdirSync(dir); } catch { return 0; }
  const objs = names.flatMap((n) => { try { const st = statSync(`${dir}/${n}`); return [{ n, size: st.size, t: st.mtimeMs }]; } catch { return []; } }).sort((a, b) => a.t - b.t);
  let total = objs.reduce((s, o) => s + o.size, 0), removed = 0;
  for (const o of objs) {
    if (total <= max) break;
    if (live.has(o.n)) continue;
    try { unlinkSync(`${dir}/${o.n}`); total -= o.size; removed++; } catch {}
  }
  return removed;
}

