// SQLite store for the control plane. One file, WAL mode; every write is synchronous and small. synchronous=NORMAL skips
// the per-commit fsync (0.56 → 0.005 ms, measured): a power cut can lose the last commits, never corrupt the file.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export const DATA = process.env.PITCREW_DATA || "/srv/pitcrew/data";
export const db = new DatabaseSync(`${DATA}/pitcrew.db`);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, job TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'specialist',
  hue TEXT NOT NULL DEFAULT 'c1', shape TEXT NOT NULL DEFAULT 'square', personality TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL DEFAULT 'openrouter', model TEXT NOT NULL DEFAULT '', fallback TEXT NOT NULL DEFAULT '',
  weekly_cap_usd REAL NOT NULL DEFAULT 10, policy TEXT NOT NULL DEFAULT '{}', mcp TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, codex_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle', ctx_tokens INTEGER, ctx_window INTEGER, carry TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), bot_id TEXT NOT NULL, codex_turn_id TEXT,
  status TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'driver', provider TEXT, model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, cost_basis TEXT NOT NULL DEFAULT 'none', error TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, id);
CREATE TABLE IF NOT EXISTS pitstops (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT, turn_id TEXT, kind TEXT NOT NULL, effect TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL, jev TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  scope TEXT, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pitstops_status ON pitstops(status, created_at);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT, effect TEXT NOT NULL, match TEXT NOT NULL, label TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS learned (
  bot_id TEXT NOT NULL, pattern TEXT NOT NULL, effect TEXT NOT NULL, label TEXT NOT NULL,
  approvals INTEGER NOT NULL DEFAULT 0, denials INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (bot_id, pattern, effect));
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, forgotten_at INTEGER);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT, spec TEXT NOT NULL, prompt TEXT NOT NULL,
  next_run INTEGER, last_run INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS surfaces (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, title TEXT NOT NULL, spec TEXT NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
-- One row per gate decision, for distilling a local classifier. call is redacted before insert (see jev.mjs redact).
CREATE TABLE IF NOT EXISTS jev_labels (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('rule','jev','standing','learned','fail-closed')),
  call TEXT NOT NULL, verdict TEXT NOT NULL, decision TEXT NOT NULL, pitstop_id TEXT,
  driver_decision TEXT CHECK (driver_decision IN ('approved','denied','expired')), driver_scope TEXT);
CREATE INDEX IF NOT EXISTS jev_labels_ts ON jev_labels(ts);
CREATE INDEX IF NOT EXISTS jev_labels_pitstop ON jev_labels(pitstop_id);
-- Every /api/state poll runs mood, weekSpend and the day/week totals per bot; ruleFor runs on every gated tool call.
CREATE INDEX IF NOT EXISTS turns_bot ON turns(bot_id, started_at);
CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at);
CREATE INDEX IF NOT EXISTS threads_bot ON threads(bot_id, archived, pinned, updated_at);
CREATE INDEX IF NOT EXISTS rules_match ON rules(bot_id, match, effect);
`);

// Columns added after v1 shipped; ALTER fails harmlessly once they exist.
for (const sql of ["ALTER TABLE turns ADD COLUMN changes TEXT"]) { try { db.exec(sql); } catch {} }

export const now = () => Date.now();
export const uid = (p) => `${p}_${randomBytes(9).toString("base64url")}`;
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export const json = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

export const getSetting = (k, d = null) => one("SELECT value FROM settings WHERE key=?", k)?.value ?? d;
export const setSetting = (k, v) => run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));

export const LABEL_DAYS = 120;
export const pruneLabels = (at = now()) => run("DELETE FROM jev_labels WHERE ts<?", at - LABEL_DAYS * 86400000).changes;

// Append-only: nothing in the code base updates or deletes audit rows.
export function audit(actor, action, data = {}) {
  run("INSERT INTO audit(ts,actor,action,data) VALUES(?,?,?,?)", now(), actor, action, JSON.stringify(data));
}
