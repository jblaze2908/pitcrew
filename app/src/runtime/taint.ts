// Untrusted content from Engram (email bodies, web pages, untrusted connections): a thread that received some has its
// outbound actions ask the driver for 10 minutes, the same window Engram applies to its own write tools (spec §8).
// Kept in SQLite so a restart inside the window doesn't lift it.
import { now, one, run } from "../db.js";

const TAINT_MS = 10 * 60000;
// Effects that leave the box or spend authority; everything else keeps its normal gate.
export const OUTBOUND = new Set(["send", "pay", "share", "signin", "delete", "install", "exec_untrusted"]);

// One primary-key read per gated tool call.
export const tainted = (threadId: string | null | undefined) => !!threadId && !!one("SELECT 1 FROM thread_taint WHERE thread_id=? AND at>?", threadId, now() - TAINT_MS);
// True when this starts a new window, so the caller says so once instead of on every untrusted result.
// Expired rows are pruned here, on the rare write, so reads never scan.
export function taint(threadId: string) {
  const fresh = !tainted(threadId), t = now();
  run("DELETE FROM thread_taint WHERE at<=?", t - TAINT_MS);
  run("INSERT INTO thread_taint(thread_id,at) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET at=excluded.at", threadId, t);
  return fresh;
}

const UNTRUSTED_SOURCES = new Set(["email", "web"]);
// Engram marks untrusted results three ways: _meta.engram.untrusted on gateway calls, a leading notice line, and
// records whose trust or source says so (search hits, get). Bounded walk: at most 2,000 nodes, depth 6, per result.
export function engramUntrusted(result: unknown) {
  const r = result as Record<string, any> | null;
  if (!r || typeof r !== "object") return false;
  const content = r.content || r.contentItems;
  if (Array.isArray(content) && content.some((x) => x?.type === "text" && typeof x.text === "string" && x.text.startsWith("Untrusted content:"))) return true;
  let budget = 2000;
  const walk = (v: any, depth: number): boolean => {
    if (!v || typeof v !== "object" || depth > 6 || --budget < 0) return false;
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v._meta?.engram?.untrusted === true || v.trust === "untrusted" || UNTRUSTED_SOURCES.has(v.source?.kind)) return true;
    return Object.values(v).some((x) => walk(x, depth + 1));
  };
  return walk(r, 0);
}
