// The API's data shapes, shared by the server (app/src) and the web app (app/web). JSON over the wire, so times are
// epoch milliseconds and JSON columns arrive parsed. Extend here, not in either side, so a renamed field breaks the build.

export type Hue = "c1" | "c2" | "c3" | "c5" | "c6";
export type Shape = "square" | "round" | "blob";
export type Mood = "idle" | "working" | "needs" | "done" | "failed" | "sleep";
export type ProviderId = "openrouter" | "aigateway" | "openai";
export type Effect = "read" | "draft" | "browse" | "write_workspace" | "signin" | "install" | "send" | "pay" | "delete" | "share" | "exec_untrusted" | "hire" | "plan_limit" | "unknown";
export type Decision = "allow" | "ask" | "block";

export interface Personality {
  role?: string; quirks?: string[]; signoff?: string; callMe?: string; plain?: boolean;
  warmth?: number; talk?: number; humour?: number;
}
export interface McpConnector { name: string; url: string; tokenSecret: string | null }

/** A crew member as stored (bots table, JSON columns parsed). */
export interface Bot {
  id: string; name: string; job: string; kind: "chief" | "specialist" | string;
  hue: Hue; shape: Shape; personality: Personality;
  provider: ProviderId; model: string; fallback: string; weekly_cap_usd: number;
  policy: Record<string, Decision>; mcp: McpConnector[];
  archived: boolean; private: boolean; created_at: number;
}
export interface ThreadSummary { id: string; title: string; status: ThreadStatus; created_at: number; updated_at: number; pinned: number }
/** A crew member as /api/state shows it: the row plus live view-model fields. */
export interface BotCard extends Bot {
  threads: ThreadSummary[]; mood: Mood; spend: number;
  computer: { up: boolean; desktop: boolean; startedAt: number | null; lease: boolean };
}

export interface ProviderStatus {
  label: string; connected: boolean; updatedAt: number | null;
  test?: { ok: boolean; detail: string; at: number } | null;
  login?: { status: string; url: string | null; code: string | null; error: string | null; startedAt: number | null };
}

export interface PitStop {
  id: string; bot_id: string; thread_id: string | null; turn_id: string | null;
  kind: "command" | "mcp" | "file" | "hire" | "lease" | "site" | "plan" | string;
  effect: Effect | string; title: string; detail: Record<string, any>; jev: Record<string, any>;
  status: "pending" | "approved" | "denied" | "expired"; scope: string | null; note: string | null;
  created_at: number; expires_at: number; decided_at: number | null;
  learn: { label: string; streak: number; need: number } | null;
}

export interface State {
  driverName: string; paused: boolean; defaultProvider: ProviderId; plainVoice: boolean; plans: boolean;
  bots: BotCard[]; pitstops: PitStop[]; providers: Record<ProviderId, ProviderStatus>;
  today: { usd: number; runs: number }; week: { usd: number; runs: number }; weekCap: number; computersUp: number;
}

export type ThreadStatus = "idle" | "running" | "needs";
/** Where a thread came from: the front door, or another member (a delegation or a plan step). */
export type Origin =
  | { kind: "routed"; by: string; confidence?: number | null; from?: string }
  | { kind: "delegated"; fromBot: string; fromThread: string; delegationId?: string; planId?: string; itemKey?: string };

export interface Thread {
  id: string; bot_id: string; title: string; codex_id: string | null; pinned: number; status: ThreadStatus;
  ctx_tokens: number | null; ctx_window: number | null; carry: string | null; archived: number;
  /** JSON string of Origin, or null. */
  origin: string | null; created_at: number; updated_at: number; running: boolean;
}

export type EventKind = "user" | "agent" | "tool" | "system" | "error" | "shot" | "changes" | "pitstop" | "surface" | "delegation" | "plan";
export interface ThreadEvent<D = Record<string, any>> { id: number; thread_id: string; turn_id: string | null; kind: EventKind; data: D; ts: number }

export interface ThreadView { thread: Thread; bot: Bot; events: ThreadEvent[]; pitstops: PitStop[]; surfaces: { id: string; title: string; spec: any; saved: number }[] }

// ---------- front door ----------
export interface RoutePick {
  botId: string; confidence: number | null; alternatives: { botId: string; p?: number }[];
  /** "jev:<model>" | "named" | "names" | "driver" | "only member" | "no OpenRouter key" | "failed: …" */
  by: string; named?: string[]; ms?: number;
}
export type AskResult = { threadId: string; botId: string } | { choose: string[] };
export interface Ask {
  id: string; botId: string; title: string; status: ThreadStatus; running: boolean; updatedAt: number;
  origin: Origin; answer: string | null;
  /** Absent when the thread never ran a plan. */
  plan?: { status: PlanStatus; members: string[]; done: number; total: number } | null;
}

// ---------- delegation and plans ----------
export interface DelegationCard { id: string; toBot: string; toName: string; toThread: string; question: string; status: "asking" | "answered" | "failed"; answer?: string; cost?: number }

export type PlanStatus = "running" | "done" | "stopped";
export type PlanItemStatus = "todo" | "doing" | "done" | "failed" | "cancelled";
/** A member's reply in a plan, split into the handoff shape. */
export interface Handoff { answer: string; data?: string; assumed: string; unchecked: string; options: string }
export interface PlanItemView {
  key: string; owner: string; ownerName: string; task: string; status: PlanItemStatus; after: string[];
  why: string | null; reopened: number; runs: number; allowed: number; toThread: string | null; cost: number;
  result: Handoff | null;
}
export interface ConstraintCheck { text: string; status: "met" | "unmet" | "untested"; note: string }
/** The plan snapshot carried by a "plan" thread event; each new one replaces the last for the same id. */
export interface PlanSnapshot {
  id: string; goal: string; constraints: string[]; status: PlanStatus; answer: string | null; checks: ConstraintCheck[] | null;
  budget: number; spend: number; chiefRuns: number; chiefLimit: number; live: 0 | 1 | null;
  log: { at: number; text: string }[]; sweep: { who: string; text: string; found: boolean }[] | null;
  items: PlanItemView[];
}
