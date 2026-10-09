// Bound dashboards: a surface can name a ledger (a SQLite file in its member's /bot/work) and carry queries instead of
// values. Pitcrew runs them when the surface is viewed, so the numbers always match the ledger and no model runs per view.
// Safety: the file is realpath-confined to that member's work dir and opened read-only with extensions off, each query is
// one SELECT/WITH statement (so no ATTACH can reach another file), and a worker enforces a deadline and a row cap.
// Cost: one stat per view; queries run only when the ledger changed (cache keyed on the file's and its WAL's mtime+size).
import { Worker } from "node:worker_threads";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { botDir } from "./computer.js";
import { CONTROLS, controlDefaults } from "../shared/pui.js";

export const LEDGER_EXT = /\.(db|sqlite|sqlite3)$/i, MAX_QUERIES = 20, MAX_SQL = 3000, MAX_ROWS = 500, DEADLINE_MS = 3000;
export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | { error: string };

// A ledger path as the member wrote it (relative to /bot/work, or under /bot/work), as its host path, or null.
export function ledgerPath(botId: string, source: unknown): string | null {
  const rel = String(source || "").replace(/^\/bot\/work\//, "");
  if (!rel || rel.startsWith("/") || !LEDGER_EXT.test(rel) || rel.split("/").includes("..")) return null;
  try {
    const root = realpathSync(`${botDir(botId)}/work`), f = realpathSync(`${root}/${rel}`);
    return f.startsWith(`${root}/`) && statSync(f).isFile() ? f : null;
  } catch { return null; }
}

// Why a query can't run, or null. Strings, quoted names and comments are blanked first, so a keyword inside them
// doesn't count and a ";" inside a string doesn't end the statement. One pass over the text.
const blank = (s: string) => s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, " ");
/** The :name parameters a statement binds (outside strings and comments): the surface's control values. */
export const paramsOf = (sql: string) => [...new Set([...blank(sql).matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map((m) => m[1]))];
export function sqlProblem(sql: unknown): string | null {
  const s = String(sql || "");
  if (!s.trim()) return "empty query";
  if (s.length > MAX_SQL) return `longer than ${MAX_SQL} chars`;
  const bare = blank(s).trim().replace(/;\s*$/, "");
  if (bare.includes(";")) return "one statement only";
  if (!/^(select|with)\b/i.test(bare)) return "must be a SELECT (or WITH … SELECT)";
  const bad = /\b(attach|detach|pragma|vacuum|reindex|analyze|insert|update|delete|replace|create|drop|alter|begin|commit|rollback|savepoint|release|load_extension)\b/i.exec(bare);
  return bad ? `"${bad[1]}" isn't allowed: dashboards only read` : null;
}

const cache = new Map<string, QueryResult>(); // ledger version + sql → result; insertion order is the eviction order
const CACHE_MAX = 300;
const version = (f: string) => [f, `${f}-wal`].map((p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } }).join("|");

export type Params = Record<string, string | number | boolean>;
// Runs the named queries against one ledger (or ":memory:", an empty database for arithmetic on control values), binding
// each statement's :params from `params`. Cached results come back without starting a worker; the key holds the params.
export async function runQueries(file: string, queries: Record<string, string>, params: Params = {}): Promise<{ results: Record<string, QueryResult>; asOf: number | null }> {
  const v = file === ":memory:" ? "mem" : version(file), results: Record<string, QueryResult> = {}, todo: { name: string; sql: string; params: Params; key: string }[] = [];
  for (const [name, sql] of Object.entries(queries)) {
    const why = sqlProblem(sql);
    if (why) { results[name] = { error: why }; continue; }
    const p: Params = Object.fromEntries(paramsOf(sql).map((k) => [k, k in params ? (typeof params[k] === "boolean" ? Number(params[k]) : params[k]) : null] as [string, any]));
    const key = `${v}\n${sql}\n${JSON.stringify(p)}`, hit = cache.get(key);
    if (hit) results[name] = hit; else todo.push({ name, sql, params: p, key });
  }
  if (todo.length) {
    const got = await new Promise<Record<string, QueryResult>>((resolve) => {
      const w = new Worker(new URL("./ledgerWorker.js", import.meta.url), { workerData: { path: file, queries: todo, maxRows: MAX_ROWS }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
      const fail = (msg: string) => resolve(Object.fromEntries(todo.map((q) => [q.name, { error: msg }])));
      const t = setTimeout(() => { w.terminate(); fail(`took longer than ${DEADLINE_MS / 1000} s`); }, DEADLINE_MS);
      w.once("message", (m) => { clearTimeout(t); resolve(m); w.terminate(); });
      w.once("error", (e) => { clearTimeout(t); fail(String(e.message).slice(0, 200)); });
    });
    for (const q of todo) {
      results[q.name] = got[q.name] || { error: "no result" };
      if (!("error" in results[q.name]) || !/longer than/.test((results[q.name] as { error: string }).error)) {
        cache.set(q.key, results[q.name]);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
    }
  }
  let asOf: number | null = null;
  if (file !== ":memory:") try { asOf = Math.max(statSync(file).mtimeMs, (() => { try { return statSync(`${file}-wal`).mtimeMs; } catch { return 0; } })()); } catch {}
  return { results, asOf };
}

// ---------- reading another member's ledger ----------
// Crew members read each other's ledgers read-only; the owner is the only writer (its own shell). A private member's
// ledgers stay with it. Returns the ledgers a member keeps (bounded walk: depth 3, 50 files) or one query's rows.
export function listLedgers(botId: string) {
  const root = `${botDir(botId)}/work`, out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 3 || out.length >= 50) return;
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(`${root}/${rel}`, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1); else if (e.isFile() && LEDGER_EXT.test(e.name)) out.push(r);
    }
  };
  walk("", 0);
  return out;
}
export const mayRead = (reader: { id: string }, owner: { id: string; private: boolean }) => reader.id === owner.id || !owner.private;

// ---------- the driver's view of a member's data ----------
// Table names come from the ledger itself (the member chose them), so they are quoted, never spliced bare.
const ident = (n: string) => `"${n.replace(/"/g, '""')}"`, lit = (n: string) => `'${n.replace(/'/g, "''")}'`;
const TABLES = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
export interface LedgerInfo { path: string; size: number; asOf: number | null; tables: { name: string; rows: number | null; columns: string[] }[]; error?: string }
// Every ledger a member keeps, with its tables, row counts and columns. Two worker runs per ledger, cached per version.
export async function ledgerOverview(botId: string): Promise<LedgerInfo[]> {
  const out: LedgerInfo[] = [];
  for (const path of listLedgers(botId)) {
    const file = ledgerPath(botId, path);
    if (!file) continue;
    const size = statSync(file).size, t = await runQueries(file, { t: TABLES }), r0 = t.results.t;
    if ("error" in r0) { out.push({ path, size, asOf: t.asOf, tables: [], error: r0.error }); continue; }
    const names = r0.rows.map((x) => String(x.name)).slice(0, 30), q: Record<string, string> = {};
    names.forEach((n, i) => { q[`c${i}`] = `SELECT count(*) AS n FROM ${ident(n)}`; q[`k${i}`] = `SELECT name FROM pragma_table_info(${lit(n)})`; });
    const r = (await runQueries(file, q)).results;
    const rows = (k: string) => { const x = r[k]; return x && !("error" in x) ? x.rows : null; };
    out.push({ path, size, asOf: t.asOf, tables: names.map((n, i) => ({ name: n, rows: Number(rows(`c${i}`)?.[0]?.n ?? NaN) || (rows(`c${i}`) ? 0 : null), columns: (rows(`k${i}`) || []).map((x) => String(x.name)) })) });
  }
  return out;
}
// The newest 50 rows of one table (by rowid when it has one), for the driver to look at.
export async function tablePreview(botId: string, path: string, table: string) {
  const file = ledgerPath(botId, path);
  if (!file) return { error: "No such ledger" };
  const t = (await runQueries(file, { t: TABLES })).results.t;
  if ("error" in t || !t.rows.some((x) => x.name === table)) return { error: "No such table" };
  const r = (await runQueries(file, { a: `SELECT * FROM ${ident(table)} ORDER BY rowid DESC LIMIT 50`, b: `SELECT * FROM ${ident(table)} LIMIT 50` })).results;
  const ok = !("error" in r.a) ? r.a : r.b;
  return "error" in ok ? { error: ok.error } : { columns: ok.columns, rows: ok.rows };
}

// ---------- binding ----------
// Which props a bound component gets from its query's rows. A bound component may leave these out of its spec.
export const BOUND: Record<string, string[]> = {
  Picker: ["options"], Tabs: ["options"], Stat: ["value"], Meter: ["value", "max"], Text: ["text"], Table: ["rows"], List: ["items"], Timeline: ["items"],
  BarChart: ["data"], Donut: ["data"], LineChart: ["series"], Sparkline: ["values"],
};
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const first = (r: Record<string, unknown>, k: string, i = 0) => (r[k] !== undefined ? r[k] : Object.values(r)[i]);
const str = (v: unknown, max: number) => (v == null ? "" : String(v)).slice(0, max);
const TONES = new Set(["default", "muted", "ok", "bad", "blue", "up", "down", "flat"]);
const STATES = new Set(["done", "running", "needs", "failed"]);
const HUES = new Set(["blue", "magenta", "violet", "teal", "amber", "grey", "bad"]);

// The component with its bound props filled from rows (column names as documented in the catalogue), or a bad-tone Text
// saying what went wrong. Pure; the caps match the catalogue's, so a bound surface renders like a literal one.
export function fill(n: Record<string, any>, r: QueryResult | undefined): Record<string, any> {
  const { bind, ...rest } = n;
  if (!r) return { type: "Text", text: `No query named "${bind}"`, tone: "bad" };
  if ("error" in r) return { type: "Text", text: `${n.title || n.label || n.type}: ${r.error}`, tone: "bad" };
  const rows = r.rows, r0 = rows[0] || {};
  switch (n.type) {
    case "Stat": return { ...rest, value: rows.length ? first(r0, "value") ?? "—" : "—", ...(r0.delta != null ? { delta: str(r0.delta, 60) } : {}), ...(TONES.has(String(r0.tone)) ? { tone: r0.tone } : {}) };
    case "Meter": return { ...rest, value: num(first(r0, "value")) || 0, max: num(r0.max ?? Object.values(r0)[1] ?? rest.max) || 1 };
    case "Text": return { ...rest, text: str(first(r0, "text"), 2000) || " " };
    case "Table": return { ...rest, rows: rows.slice(0, 200) };
    case "List": return { ...rest, items: rows.slice(0, 100).map((x) => ({ title: str(first(x, "title"), 200), ...(x.detail != null ? { detail: str(x.detail, 400) } : {}), ...(x.meta != null ? { meta: str(x.meta, 80) } : {}) })) };
    case "Timeline": return { ...rest, items: rows.slice(0, 100).map((x) => ({ text: str(first(x, "text"), 300), ...(x.time != null ? { time: str(x.time, 60) } : {}), ...(STATES.has(String(x.state)) ? { state: x.state } : {}) })) };
    case "BarChart": case "Donut": return { ...rest, data: rows.slice(0, n.type === "Donut" ? 8 : 60).map((x) => ({ label: str(first(x, "label"), 80), value: num(first(x, "value", 1)) || 0, ...(HUES.has(String(x.hue)) ? { hue: x.hue } : {}) })) };
    case "Picker": case "Tabs": return { ...rest, options: rows.slice(0, n.type === "Tabs" ? 8 : 50).map((x) => { const v = str(first(x, "value"), 200); return { value: v, label: str(x.label ?? v, 200) }; }) };
    case "Sparkline": return { ...rest, values: rows.slice(0, 200).map((x) => num(first(x, "value")) || 0) };
    case "LineChart": {
      const by = new Map<string, { x: string; y: number | null }[]>();
      for (const x of rows) { const k = str(x.series ?? n.title ?? "value", 80); if (!by.has(k) && by.size >= 5) continue; const y = x.y !== undefined ? x.y : Object.values(x)[1]; (by.get(k) || by.set(k, []).get(k)!).push({ x: str(first(x, "x"), 40), y: y == null || y === "" ? null : num(y) || 0 }); }
      return { ...rest, series: [...by].map(([name, points]) => ({ name, points: points.slice(0, 200) })) };
    }
    default: return rest;
  }
}

// The control values to query with: each control's default, overridden by what the driver set (only known controls,
// coerced to the control's kind; a slider stays inside its range).
export function controlState(root: any, given: Record<string, unknown> = {}): Params {
  const out: Params = controlDefaults(root), kinds: Record<string, any> = {};
  const walk = (n: any) => { if (!n || typeof n !== "object") return; if (CONTROLS.includes(n.type) && n.name) kinds[n.name] ??= n; (n.children || []).forEach(walk); };
  walk(root);
  for (const [k, v] of Object.entries(given)) {
    const c = kinds[k];
    if (!c || v == null) continue;
    if (c.type === "Slider") { const x = Number(v); if (Number.isFinite(x)) out[k] = Math.min(Number(c.max), Math.max(Number(c.min), x)); }
    else if (c.type === "Switch") out[k] = v === true || v === "true" || v === 1;
    else out[k] = String(v).slice(0, 200);
  }
  return out;
}

// A stored surface as the driver sees it: queries run with the control values, bound props filled, plus when the ledger
// last changed. A surface without a source runs its queries on an empty in-memory database.
export async function resolveSurface<S extends { bot_id?: string; spec: any }>(s: S, botId = s.bot_id, given: Record<string, unknown> = {}): Promise<S & { data?: { source: string | null; asOf: number | null; errors: string[] } }> {
  const spec = s.spec;
  if (!spec?.queries || !botId) return s;
  const file = spec.source ? ledgerPath(botId, spec.source) : ":memory:";
  const { results, asOf } = file ? await runQueries(file, spec.queries, controlState(spec.root, given)) : { results: Object.fromEntries(Object.keys(spec.queries).map((k) => [k, { error: `ledger ${spec.source} not found` }])), asOf: null };
  const walk = (n: any): any => (!n || typeof n !== "object" ? n : { ...(n.bind ? fill(n, results[n.bind]) : n), ...(n.children ? { children: n.children.map(walk) } : {}) });
  const errors = Object.entries(results).flatMap(([k, r]) => ("error" in r ? [`${k}: ${r.error}`] : []));
  const { source, queries, ...shown } = spec;
  return { ...s, spec: { ...shown, root: walk(spec.root) }, data: { source: source ?? null, asOf, errors } };
}
