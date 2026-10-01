// Serves the read-mostly part of Codex's exec-server protocol from the workspace on the host's disk, so context loading
// (AGENTS.md, .git probes, skills) and file writes never boot a computer. Called per fs request from a turn
// (~30 per chat-only turn, measured 2026-10-01); each is one or two lstat/read calls on local disk.
// Safety: only paths under /bot map to the bot's own dir; ".." and any symlink on the path fall back to the computer,
// which resolves links inside its own filesystem. Nothing outside /srv/pitcrew/bots/<id> is ever read or written here.
import { lstatSync, readFileSync, writeFileSync, readdirSync, chownSync } from "node:fs";
import { botDir } from "./computer.js";
import type { Stats } from "node:fs";

// Where a file:// URI lands on the host: a root probe, a missing path, or an existing one.
type Resolved = { probe?: true; host?: string; missing?: true; parentOk?: boolean; uri?: string };

const NOT_FOUND = { code: -32004, message: "No such file or directory (os error 2)" };
const FALLBACK = { fallback: true } as const;
const MAX_READ = 16 << 20;
// Probes Codex makes outside /bot; the computer image has none of these, so "not found" is the true answer.
const ROOT_PROBES = /^\/(\.git|\.(codex|claude|cursor)-plugin\/plugin\.json)$/;

function resolve(id: string, uri: unknown): Resolved | null {
  if (typeof uri !== "string" || !uri.startsWith("file:///")) return null;
  let p: string; try { p = decodeURIComponent(uri.slice(7)); } catch { return null; }
  if (p.split("/").includes("..")) return null;
  if (!(p === "/bot" || p.startsWith("/bot/"))) return ROOT_PROBES.test(p) ? { probe: true } : null;
  const base = botDir(id), rel = p.slice(4).split("/").filter(Boolean);
  // Walk the components: a symlink anywhere means the host and the computer could disagree, so let the computer answer.
  let cur = base;
  for (let i = 0; i < rel.length; i++) {
    cur += `/${rel[i]}`;
    let st: Stats; try { st = lstatSync(cur); } catch (e: any) { return e.code === "ENOENT" || e.code === "ENOTDIR" ? { host: cur, missing: true, parentOk: i === rel.length - 1 } : null; }
    if (st.isSymbolicLink()) return null;
  }
  return { host: cur, uri: `file://${p}` };
}

const meta = (st: Stats) => ({ isDirectory: st.isDirectory(), isFile: st.isFile(), isSymlink: false, size: st.size, createdAtMs: 0, modifiedAtMs: Math.floor(st.mtimeMs) });

// The reply is the exec-server JSON-RPC body: { result } | { error } | { fallback: true } (let the computer answer).
export function execFs(id: string, method: string, params: Record<string, any>): Record<string, any> {
  if (method === "environmentConfig/read")
    return { result: { userHomeDir: "file:///home/crew", codexHomeDir: "file:///tmp/codex-exec", hostname: id.slice(0, 20), config: { layers: [], cloudInsertionIndex: 0 }, requirements: { layers: [], cloudInsertionIndex: 0 } } };
  const r = resolve(id, params.path);
  if (!r) return FALLBACK;
  if (r.probe) return method === "fs/writeFile" ? FALLBACK : { error: NOT_FOUND };
  switch (method) {
    case "fs/getMetadata": return r.missing ? { error: NOT_FOUND } : { result: meta(lstatSync(r.host!)) };
    case "fs/canonicalize": return r.missing ? { error: NOT_FOUND } : { result: { path: r.uri } };
    case "fs/readFile": {
      if (r.missing) return { error: NOT_FOUND };
      const st = lstatSync(r.host!);
      if (!st.isFile() || st.size > MAX_READ) return FALLBACK;
      return { result: { dataBase64: readFileSync(r.host!).toString("base64") } };
    }
    case "fs/writeFile": {
      if (typeof params.dataBase64 !== "string" || (r.missing && !r.parentOk)) return FALLBACK;
      if (!r.missing && !lstatSync(r.host!).isFile()) return FALLBACK;
      writeFileSync(r.host!, Buffer.from(params.dataBase64, "base64"));
      chownSync(r.host!, 1500, 1500);
      return { result: {} };
    }
    case "fs/walk": {
      if (r.missing) return { error: NOT_FOUND };
      const o = params.options || {}, maxDepth = o.maxDepth ?? 6, maxDirs = o.maxDirectories ?? 2000, maxEntries = o.maxEntries ?? 20000;
      const entries: { path: string; kind: "directory" | "file" }[] = []; let dirs = 0, truncated = false, sawLink = false;
      const walk = (host: string, uri: string, depth: number) => {
        if (depth > maxDepth || truncated) return;
        let ents: import("node:fs").Dirent[]; try { ents = readdirSync(host, { withFileTypes: true }); } catch { return; }
        for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= maxEntries) { truncated = true; return; }
          if (e.isSymbolicLink()) { sawLink = true; return; }
          const u = `${uri}/${e.name}`;
          if (e.isDirectory()) {
            if (o.pruneHiddenDirectories && e.name.startsWith(".")) continue;
            if (++dirs > maxDirs) { truncated = true; return; }
            entries.push({ path: u, kind: "directory" });
            walk(`${host}/${e.name}`, u, depth + 1);
          } else if (e.isFile()) entries.push({ path: u, kind: "file" });
        }
      };
      walk(r.host!, r.uri!, 1);
      return sawLink ? FALLBACK : { result: { entries, errors: [], truncated } };
    }
  }
  return FALLBACK;
}
