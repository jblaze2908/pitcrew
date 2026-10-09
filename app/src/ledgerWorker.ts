// Runs a dashboard's queries against one ledger file, read-only, off the main thread: node:sqlite is synchronous, so a
// slow query here can be killed (ledger.ts terminates the worker at its deadline) instead of stalling every request.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

interface Job { path: string; queries: { name: string; sql: string; params?: Record<string, string | number | null> }[]; maxRows: number }
const { path, queries, maxRows } = workerData as Job;
const out: Record<string, { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | { error: string }> = {};
let db: DatabaseSync | null = null;
try {
  db = new DatabaseSync(path, { readOnly: path !== ":memory:" });
  for (const q of queries) {
    try {
      const rows: Record<string, unknown>[] = [];
      let truncated = false;
      for (const r of db.prepare(q.sql).iterate(q.params || {}) as Iterable<Record<string, unknown>>) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push({ ...r });
      }
      out[q.name] = { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated };
    } catch (e: any) { out[q.name] = { error: String(e.message || e).slice(0, 200) }; }
  }
} catch (e: any) {
  for (const q of queries) out[q.name] = { error: `Couldn't open the ledger: ${String(e.message || e).slice(0, 160)}` };
} finally { db?.close(); }
parentPort!.postMessage(out);
