// Rows as the SQLite store holds them (db.ts schema): JSON columns are still strings and flags are 0/1.
// The parsed, API-facing shapes live in shared/types.ts.
import type { ThreadStatus, PlanStatus, PlanItemStatus } from "../shared/types.js";

export interface BotRow {
  id: string; name: string; job: string; kind: string; hue: string; shape: string; personality: string;
  provider: string; model: string; fallback: string; weekly_cap_usd: number; policy: string; mcp: string;
  archived: number; private: number; created_at: number; engram_scope: string; engram_household: number; house_rules: string; soul: string; changelog_seen: number;
}
export interface ThreadRow {
  id: string; bot_id: string; title: string; codex_id: string | null; pinned: number; status: ThreadStatus;
  ctx_tokens: number | null; ctx_window: number | null; carry: string | null; archived: number;
  origin: string | null; autonomy: string; tools_sig: string | null; title_auto: number; notes: string | null; created_at: number; updated_at: number;
}
export interface TurnRow {
  id: string; thread_id: string; bot_id: string; codex_turn_id: string | null; status: string; trigger: string;
  provider: string | null; model: string | null; input_tokens: number; cached_tokens: number; output_tokens: number;
  cost_usd: number; cost_basis: string; error: string | null; started_at: number; ended_at: number | null; changes: string | null;
  criteria: string | null; grade: string | null; rewound_at: number | null;
}
export interface EventRow { id: number; thread_id: string; turn_id: string | null; kind: string; data: string; ts: number; rewound: number | null }
export interface PitstopRow {
  id: string; bot_id: string; thread_id: string | null; turn_id: string | null; kind: string; effect: string;
  title: string; detail: string; jev: string; status: "pending" | "approved" | "denied" | "expired";
  scope: string | null; note: string | null; created_at: number; decided_at: number | null; expires_at: number;
}
export interface RuleRow { id: string; bot_id: string; thread_id: string | null; effect: string; match: string; label: string; created_at: number; revoked_at: number | null }
export interface LearnedRow { bot_id: string; pattern: string; effect: string; label: string; approvals: number; denials: number; streak: number; updated_at: number }
export interface MemoryRow { id: string; bot_id: string; text: string; source: string; created_at: number; updated_at: number; forgotten_at: number | null }
export interface ScheduleRow {
  id: string; bot_id: string; thread_id: string | null; spec: string; prompt: string;
  next_run: number | null; last_run: number | null; enabled: number; created_at: number; hook_secret?: string | null; check_cmd?: string | null; check_last?: string | null; grade?: number;
  /** A short name for the Schedules page; backfilled from the prompt for older rows (runtime/schedules.ts). */
  title?: string | null;
}
export interface ScheduleRunRow {
  id: string; schedule_id: string; bot_id: string; thread_id: string | null; turn_id: string | null;
  kind: "time" | "manual" | "event" | "after"; due_at: number; fired_at: number; started_at: number | null; ended_at: number | null;
  status: "queued" | "running" | "quiet" | "reported" | "failed" | "interrupted" | "cancelled" | "skipped";
  note: string | null; summary: string | null; input_tokens: number | null; cost_usd: number | null;
}
export interface SurfaceRow { id: string; thread_id: string; bot_id: string; title: string; spec: string; saved: number; created_at: number }
export interface SiteRow { scope: string; domain: string; mode: "allowed" | "read" | "blocked"; overrides: string; by: string; created_at: number; updated_at: number }
export interface PlanRow {
  id: string; thread_id: string; goal: string; constraints: string; status: PlanStatus; answer: string | null; checks: string | null;
  budget_usd: number; created_at: number; ended_at: number | null; live: 0 | 1 | null; swept: number;
  limits: string | null; log: string | null; sweep: string | null;
}
export interface PlanItemRow {
  id: string; plan_id: string; seq: number; key: string; owner_bot: string; task: string; after: string; status: PlanItemStatus;
  result: string | null; why: string | null; reopened: number; history: string; to_thread: string | null; cost_usd: number;
  started_at: number | null; ended_at: number | null;
}
