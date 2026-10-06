// SQLite store for the control plane. One file, WAL mode; every write is synchronous and small. synchronous=NORMAL skips
// the per-commit fsync (0.56 → 0.005 ms, measured): a power cut can lose the last commits, never corrupt the file.
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
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
-- One row per gate decision, for distilling a local classifier. call is redacted before insert (see jev.ts redact).
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
-- Per-domain policy: scope is 'global' or a bot id; domain is a registrable domain or a more specific host.
CREATE TABLE IF NOT EXISTS sites (
  scope TEXT NOT NULL, domain TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('allowed','read','blocked')), overrides TEXT NOT NULL DEFAULT '{}',
  by TEXT NOT NULL DEFAULT 'driver', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, domain));
-- Registrable domains a crew member has landed on with the driver's say-so; look-alike checks compare against them.
CREATE TABLE IF NOT EXISTS known_hosts (
  bot_id TEXT NOT NULL, domain TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 1, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (bot_id, domain));
`);

db.exec(`CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY, from_bot TEXT NOT NULL, from_thread TEXT NOT NULL, to_bot TEXT NOT NULL, to_thread TEXT NOT NULL,
  question TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, cost_usd REAL, created_at INTEGER NOT NULL, ended_at INTEGER)`);
// Plans (prototype, behind the "plans" setting): the Crew Chief's living todo, run by Pitcrew.
db.exec(`CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, goal TEXT NOT NULL, constraints TEXT NOT NULL, status TEXT NOT NULL,
  answer TEXT, checks TEXT, budget_usd REAL NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, owner_bot TEXT NOT NULL, task TEXT NOT NULL,
  after TEXT NOT NULL, status TEXT NOT NULL, result TEXT, why TEXT, reopened INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]',
  to_thread TEXT, cost_usd REAL NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER)`);
// Engram link: each member's Engram agent (its token is in secrets), and what "Move memories to Engram" already sent.
db.exec(`CREATE TABLE IF NOT EXISTS engram_members (bot_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_prefix TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS engram_sent (bot_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (bot_id, kind, ref));
-- Journal entries: per thread, the end time of the last turn already sent to Engram.
CREATE TABLE IF NOT EXISTS engram_episodes (thread_id TEXT PRIMARY KEY, upto INTEGER NOT NULL);
-- Threads that received untrusted Engram content: outbound effects ask until at + 10 min (runtime/taint.ts).
CREATE TABLE IF NOT EXISTS thread_taint (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
-- What each turn remembered, for its "Learned this run" card (runtime/learned.ts).
CREATE TABLE IF NOT EXISTS turn_memories (
  turn_id TEXT NOT NULL, memory_id TEXT NOT NULL, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (turn_id, memory_id))`);
// Messages waiting for a thread's run to end (runtime/queue.ts); in the store so a restart doesn't drop them.
// Workspace scripts jev allowed or the driver approved, by content hash: the same bytes run again without asking.
db.exec(`CREATE TABLE IF NOT EXISTS script_trust (bot_id TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(bot_id, sha))`);
// Loads of a member's own skills through skill_view (runtime/skills.ts): usage and staleness.
db.exec(`CREATE TABLE IF NOT EXISTS skill_usage (bot_id TEXT NOT NULL, name TEXT NOT NULL, uses INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(bot_id, name))`);
// Harness ideas the crew files with suggest_improvement (runtime/retro.ts), for the driver to accept or dismiss.
db.exec(`CREATE TABLE IF NOT EXISTS improvements (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT, area TEXT NOT NULL, title TEXT NOT NULL, norm TEXT NOT NULL,
  evidence TEXT NOT NULL, proposal TEXT NOT NULL, status TEXT NOT NULL, votes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS queued (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]',
  trigger TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS queued_thread ON queued(thread_id, created_at)`);
// Images the crew made (images.ts): one row per file, with the version it was edited from and when the driver kept it.
db.exec(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT, path TEXT NOT NULL, parent_id TEXT, model TEXT,
  cost REAL, kept_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS images_path ON images(bot_id, path)`);
// One row per schedule firing (schedules.ts): when it was due, when its turn started and ended, and how it ended.
// status: queued → running → quiet | reported | failed | interrupted | cancelled, or skipped (the check saw no change).
db.exec(`CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, turn_id TEXT,
  kind TEXT NOT NULL, due_at INTEGER NOT NULL, fired_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, status TEXT NOT NULL,
  note TEXT, summary TEXT, input_tokens INTEGER, cost_usd REAL);
CREATE INDEX IF NOT EXISTS schedule_runs_sched ON schedule_runs(schedule_id, fired_at);
CREATE INDEX IF NOT EXISTS schedule_runs_thread ON schedule_runs(thread_id, status);
CREATE INDEX IF NOT EXISTS schedule_runs_turn ON schedule_runs(turn_id)`);
// The vault (vault.ts): blob holds every value sealed under vault.key, bound to the row id. has names the fields set,
// so listing never decrypts. allowed: members that may use it; always: those that skip the per-thread ask.
// needs_update: why a sign-in with it failed, until the driver saves a new value (the source of truth is theirs).
db.exec(`CREATE TABLE IF NOT EXISTS vault (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, site TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('login','login+totp','card')), note TEXT NOT NULL DEFAULT '', last4 TEXT, blob TEXT NOT NULL, has TEXT NOT NULL DEFAULT '[]',
  allowed TEXT NOT NULL DEFAULT '[]', always TEXT NOT NULL DEFAULT '[]', last_used INTEGER, last_used_by TEXT, needs_update TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
// Member email (runtime/mail.ts): one address per member and who may wake it.
db.exec(`CREATE TABLE IF NOT EXISTS mailboxes (bot_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, senders TEXT NOT NULL DEFAULT '[]', others TEXT NOT NULL DEFAULT 'hold', created_at INTEGER NOT NULL)`);
// Columns added after v1 shipped; ALTER fails harmlessly once they exist.
for (const sql of ["ALTER TABLE turns ADD COLUMN changes TEXT", "ALTER TABLE jev_labels ADD COLUMN shadow TEXT",
  "ALTER TABLE threads ADD COLUMN origin TEXT", "ALTER TABLE bots ADD COLUMN private INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE plans ADD COLUMN live INTEGER", "ALTER TABLE plans ADD COLUMN swept INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE plans ADD COLUMN limits TEXT", "ALTER TABLE plans ADD COLUMN log TEXT", "ALTER TABLE plans ADD COLUMN sweep TEXT",
  "ALTER TABLE bots ADD COLUMN engram_scope TEXT NOT NULL DEFAULT 'personal'", "ALTER TABLE engram_members ADD COLUMN scope TEXT",
  "ALTER TABLE bots ADD COLUMN engram_household INTEGER NOT NULL DEFAULT 0", "ALTER TABLE engram_members ADD COLUMN household INTEGER NOT NULL DEFAULT 0",
  // Done-check (runtime/donecheck.ts): the run's success criteria and the grader's result. Rewind (runtime/rewind.ts):
  // when a run, and the events after its message, were rewound out of the member's conversation. schedules.grade: the
  // schedule's runs get a done-check (off by default).
  "ALTER TABLE threads ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'ask'", "ALTER TABLE threads ADD COLUMN tools_sig TEXT", "ALTER TABLE bots ADD COLUMN house_rules TEXT NOT NULL DEFAULT ''", "ALTER TABLE threads ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 1", "ALTER TABLE schedules ADD COLUMN hook_secret TEXT", "ALTER TABLE schedules ADD COLUMN check_cmd TEXT", "ALTER TABLE schedules ADD COLUMN check_last TEXT", "ALTER TABLE threads ADD COLUMN notes TEXT", "ALTER TABLE bots ADD COLUMN soul TEXT NOT NULL DEFAULT ''", "ALTER TABLE bots ADD COLUMN changelog_seen INTEGER NOT NULL DEFAULT 0", "ALTER TABLE jev_labels ADD COLUMN allowed_by TEXT", "ALTER TABLE turns ADD COLUMN criteria TEXT", "ALTER TABLE turns ADD COLUMN grade TEXT", "ALTER TABLE turns ADD COLUMN rewound_at INTEGER", "ALTER TABLE events ADD COLUMN rewound INTEGER", "ALTER TABLE schedules ADD COLUMN title TEXT", "ALTER TABLE schedules ADD COLUMN grade INTEGER NOT NULL DEFAULT 0", ]) { try { db.exec(sql); } catch {} }
// When the driver last opened each thread (runtime/inbox.ts). Set to now on the boot that adds it, so the inbox starts
// empty instead of listing a week of runs nobody marked seen.
try { db.exec("ALTER TABLE threads ADD COLUMN seen_at INTEGER"); db.prepare("UPDATE threads SET seen_at=?").run(Date.now()); } catch {}
// Probe, e2e and test threads (created with test: true); the Threads page hides them. Rows from before the flag are
// guessed once, by title or member name, on the boot that adds the column.
export function backfillTestThreads() {
  return db.prepare(`UPDATE threads SET test=1 WHERE test=0 AND (lower(title) LIKE 'e2e%' OR lower(title) LIKE '%probe%' OR lower(title) LIKE 'smoke test%'
    OR lower(title) = 'test' OR lower(title) LIKE 'test %' OR lower(title) LIKE 'test:%' OR lower(title) LIKE '[test]%'
    OR bot_id IN (SELECT id FROM bots WHERE lower(name) LIKE 'e2e%' OR lower(name) LIKE '%probe%'))`).run().changes;
}
try { db.exec("ALTER TABLE threads ADD COLUMN test INTEGER NOT NULL DEFAULT 0"); backfillTestThreads(); } catch {}
// The list pages walk these newest first from a cursor (api/lists.ts); threads_parent must match the expression there.
db.exec(`CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at);
CREATE INDEX IF NOT EXISTS threads_parent ON threads(json_extract(origin,'$.fromThread'));
CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, started_at);
CREATE INDEX IF NOT EXISTS pitstops_created ON pitstops(created_at)`);
// The inbox reads turns by end time; the activity log pages jev_labels newest first, per member or per effect.
db.exec(`CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
CREATE INDEX IF NOT EXISTS jev_labels_bot ON jev_labels(bot_id, ts);
CREATE INDEX IF NOT EXISTS jev_labels_effect ON jev_labels(json_extract(verdict,'$.effect'), ts)`);

// A row as SQLite returns it; callers name the shape they expect (models.ts).
export type Row = Record<string, any>;
type Param = SQLInputValue | undefined;

export const now = () => Date.now();
export const uid = (p: string) => `${p}_${randomBytes(9).toString("base64url")}`;
// Prepared once per SQL text: preparing costs about 5 µs on a primary-key read, 30 µs on a list query (measured), on
// every call. Bounded, oldest out, because IN (?,…) lists make one text per length.
const stmts = new Map<string, StatementSync>(), STMT_MAX = 500;
function stmt(sql: string) {
  let s = stmts.get(sql);
  if (!s) {
    if (stmts.size >= STMT_MAX) stmts.delete(stmts.keys().next().value!);
    stmts.set(sql, (s = db.prepare(sql)));
  }
  return s;
}
export const one = <T = Row>(sql: string, ...a: Param[]) => stmt(sql).get(...(a as SQLInputValue[])) as T | undefined;
export const all = <T = Row>(sql: string, ...a: Param[]) => stmt(sql).all(...(a as SQLInputValue[])) as T[];
export const run = (sql: string, ...a: Param[]) => stmt(sql).run(...(a as SQLInputValue[]));
/** "?,?,?" for an IN list of xs. */
export const marks = (xs: readonly unknown[]) => xs.map(() => "?").join(",");
// Parsed JSON columns are dynamic; callers that care name T.
// A NULL column parses as null without throwing (JSON.parse(null) reads "null"), so null falls back to the default too.
export const json = <T = any>(s: unknown, d: any = null): T => { if (s == null || s === "") return d; try { return JSON.parse(s as string) ?? d; } catch { return d; } };

export function getSetting(k: string, d: string): string;
export function getSetting(k: string): string | null;
export function getSetting(k: string, d: string | null = null) { return one<{ value: string }>("SELECT value FROM settings WHERE key=?", k)?.value ?? d; }
export const setSetting = (k: string, v: unknown) => run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));

export const LABEL_DAYS = 120;
export const pruneLabels = (at = now()) => run("DELETE FROM jev_labels WHERE ts<?", at - LABEL_DAYS * 86400000).changes;

// Append-only: nothing in the code base updates or deletes audit rows.
export function audit(actor: string, action: string, data: Record<string, unknown> = {}) {
  run("INSERT INTO audit(ts,actor,action,data) VALUES(?,?,?,?)", now(), actor, action, JSON.stringify(data));
}
