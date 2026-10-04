// The API's data shapes, shared by the server (app/src) and the web app (app/web). JSON over the wire, so times are
// epoch milliseconds and JSON columns arrive parsed. Extend here, not in either side, so a renamed field breaks the build.

export type Hue = "c1" | "c2" | "c3" | "c5" | "c6";
export type Shape = "square" | "round" | "blob";
export type Mood = "idle" | "working" | "needs" | "done" | "failed" | "sleep";
export type ProviderId = "openrouter" | "aigateway" | "openai";
export type Effect = "read" | "draft" | "browse" | "write_workspace" | "signin" | "install" | "send" | "pay" | "delete" | "share" | "exec_untrusted" | "hire" | "plan_limit" | "engram" | "unknown";
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
  /** Where its memories live in Engram; a private member needs finance or health so other members can't read them. */
  engram_scope: EngramScope;
  /** Reads Engram's household facts (addresses, account last-4s, family); off unless you tick it. */
  engram_household: boolean;
  /** The driver's prose rules for this member, one per line ("Never place orders on Blinkit"); jev reads them on every judged call. */
  house_rules: string;
  /** The driver's SOUL for this member: who it is, its job, voice and working style (crew.ts soulOf); empty = made from job and voice. */
  soul: string;
}
export type EngramScope = "personal" | "finance" | "health";
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
  kind: "command" | "mcp" | "file" | "hire" | "lease" | "site" | "plan" | "engram" | string;
  effect: Effect | string; title: string; detail: Record<string, any>; jev: Record<string, any>;
  status: "pending" | "approved" | "denied" | "expired"; scope: string | null; note: string | null;
  created_at: number; expires_at: number; decided_at: number | null;
  learn: { label: string; streak: number; need: number } | null;
  /** What "allow similar" would cover, for a pending command or tool pit stop. */
  similar?: string | null;
}

export interface State {
  driverName: string; paused: boolean; defaultProvider: ProviderId; plainVoice: boolean; plans: boolean;
  bots: BotCard[]; pitstops: PitStop[]; providers: Record<ProviderId, ProviderStatus>;
  today: { usd: number; runs: number }; week: { usd: number; runs: number }; weekCap: number; computersUp: number;
  engram: { linked: boolean; url: string };
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
  /** ask | handsfree | yolo: how much the thread runs without pit stops (runtime/autonomy.ts). */
  autonomy: string;
}

export type EventKind = "user" | "agent" | "tool" | "system" | "error" | "shot" | "changes" | "pitstop" | "surface" | "delegation" | "plan" | "learned";
export interface ThreadEvent<D = Record<string, any>> { id: number; thread_id: string; turn_id: string | null; kind: EventKind; data: D; ts: number }

/** A message waiting for the thread's run to end; it enters the transcript only when it goes to the member. via: the trigger. */
export interface QueuedItem { id: string; text: string; attachments: string[]; via: string; display: string | null; created_at: number }
export interface ThreadView { thread: Thread; bot: Bot; events: ThreadEvent[]; pitstops: PitStop[]; surfaces: { id: string; title: string; spec: any; saved: number }[]; queued: QueuedItem[] }

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

// ---------- other endpoints the web app reads ----------
export interface Session { setup: boolean; authed: boolean }
export interface Memory { id: string; bot_id: string; text: string; source: string; created_at: number; updated_at: number }
/** last: the latest run (runtime/schedules.ts lastScheduledRun): when, how it ended, the first line of its reply. */
export interface Schedule { id: string; bot_id: string; thread_id: string | null; spec: string; prompt: string; enabled: number; next_run: number | null; created_at: number; last?: { at: number; status: string; summary: string; threadId?: string } | null }
export interface Rule { id: string; bot_id: string; bot_name?: string; label: string; effect: string; created_at: number }
export interface Learned { id: number; bot_id: string; bot_name?: string; label: string; effect: string; streak: number; need: number; approvals: number; denials: number }
/** GET /api/bots/:id */
/** memory: the member's own (agent tier, in Pitcrew); global: notes it filed in Engram, null when unlinked. */
export interface BotDetail { bot: BotCard; memory: Memory[]; global: Memory[] | null; memoryIn: "pitcrew" | "engram"; memoryError: string | null; schedules: Schedule[]; rules: Rule[]; learned: Learned[] }
/** A connection a new member could read through Engram (GET /api/engram/connections). */
export interface EngramConnection { id: string; name: string; status: "ok" | "warn" | "signal"; detail: string; read: number; write: number }
/** A row of BotCard.threads, or of GET /api/bots/:id/threads?q= (which adds archived and a snippet). */
export interface ThreadRow { id: string; title: string; status?: ThreadStatus; pinned?: number; archived?: number; snippet?: string; created_at: number; updated_at: number }

export type SiteMode = "allowed" | "read" | "blocked";
export interface SiteRow { scope: string; domain: string; mode: SiteMode; overrides: Record<string, Decision>; by: string; created_at: number; updated_at: number }
export interface SitesView { scope: string; modes: SiteMode[]; sites: SiteRow[] }

export interface ModelInfo { id: string; name: string; price?: { in: number; out: number } | null }

export interface FileChange { path: string; status: "added" | "modified" | "deleted" | string; lines?: number; before?: string | null; after?: string | null }
export interface ChangeRun { id: string; thread_id: string; started_at: number; thread_title: string; changes: FileChange[] }
export interface FileDiff extends FileChange { text?: boolean; size?: number; beforeText: string; afterText: string }
export interface FsEntry { name: string; dir: boolean; size: number; mtime: number }
export type FsNode = { type: "dir"; path: string; entries: FsEntry[] } | { type: "file"; path: string; size: number; mtime: number; image: boolean; text?: string };
export interface Project { path: string; git?: boolean }

export interface Run {
  id: string; thread_id: string; bot_id: string; bot_name: string; thread_title: string; trigger: string; status: string; error: string | null;
  started_at: number; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_basis: string;
}
export interface OpenRouterUsage { balance?: number | null; limit?: number | null; limit_remaining?: number | null; limit_reset?: string | null; usage?: number; usage_daily?: number; usage_weekly?: number }
export interface PlanWindow { usedPercent: number; windowMins?: number; resetsAt?: number | null }
export interface PlanLimits { connected?: boolean; plan?: string; reached?: boolean; primary?: PlanWindow | null; secondary?: PlanWindow | null; credits?: { has: boolean; unlimited?: boolean; balance?: string | number | null } | null; at?: number }
export interface Telemetry {
  bots: { id: string; name: string; hue: Hue; shape: Shape; cap: number; spend: number; runs: number; failed: number }[];
  runs: Run[]; handled: number;
  pitstops: { total: number; approved: number | null; denied: number | null; expired: number | null; wait_ms: number } | null;
  byModel: { provider: string; model: string; runs: number; usd: number | null; input: number | null; output: number | null }[];
  openrouter: OpenRouterUsage | null; chatgpt: PlanLimits | null;
}
export interface LibraryBot { id: string; name: string; hue: Hue; shape: Shape; files: { path: string; size: number; mtime: number }[] }
/** A file a crew member published to Engram (an artifact), as the Library lists it. thread_id: where it was published. */
export interface PublishedArtifact {
  id: string; title: string; kind: string; version: number; mime: string | null; size: number | null; url: string; public_url: string | null;
  share_pending: boolean; imported: boolean; created_at: number; updated_at: number; bot_id: string; bot_name: string; hue: Hue | null; shape: Shape | null; thread_id: string | null;
}
export interface ArtifactFilter { q?: string; member?: string; status?: "public" | "waiting" | "private"; kind?: "page" | "pdf" | "image" | "other"; imported?: "1"; cursor?: string; limit?: number }
/** counts cover every member and filter: total (published from threads), waiting (a public link waits for you), imported. */
export interface PublishedPage { items: PublishedArtifact[]; next: string | null; counts: { total: number; waiting: number; imported: number } }
/** data: set for a dashboard bound to a ledger (ledger.ts): its file, when it last changed, and any query that failed. */
export interface Surface { id: string; title: string; spec: any; saved?: number; data?: { source: string; asOf: number | null; errors: string[] } }
export interface KeptSurface extends Surface { thread_id: string; bot_id: string; bot_name: string; hue: Hue; created_at: number }

/** Server-sent events on /api/stream. The thread-only kinds (event, delta, activity, context, queue) arrive only with ?thread=. */
export interface StreamEvents {
  thread: { id: string; botId?: string; status: ThreadStatus; title?: string };
  turn: { threadId: string; turnId: string; status: string; cost?: number; botId: string };
  pitstop: { id: string; botId: string; threadId: string | null; status: PitStop["status"]; pitstop?: PitStop };
  computer: { botId: string; up: boolean; desktop: boolean; startedAt: number | null };
  paused: { paused: boolean };
  lease: { botId: string; held: boolean };
  event: { id: number; threadId: string; turnId: string | null; kind: EventKind; data: Record<string, any>; ts: number; pitstop?: PitStop; surface?: Surface };
  delta: { threadId: string; itemId: string; text: string };
  activity: { threadId: string; botId?: string; text: string };
  context: { threadId: string; tokens: number; window: number };
  queue: { threadId: string; queued: QueuedItem[] };
}
export type StreamType = keyof StreamEvents;

// ---------- Engram link (Engram's own shapes, as Pitcrew keeps them) ----------
/** An Engram proposal mirrored as a pit stop: PitStop.detail.proposal for kind "engram". */
export interface EngramProposal {
  id: string; kind: string; title: string; scope: string; area: string; reasons: string[]; held: boolean;
  source: { kind: string; label: string } | null; replaces: { text: string; source: string | null } | null; text: string | null;
}
export type EngramDecision = "accept" | "keep" | "reject";
export interface EngramDigest {
  week: string; from: string; to: string; built_at: number;
  waiting: { open: number; held: number };
  runningOut: { date: string; text: string; area: string }[];
  changed: { text: string; detail: string; tone: "normal" | "bad" }[];
  openLoops: { text: string; area: string }[];
  journal: { day: string; lines: string[] }[];
}
export interface EngramMigration {
  running: boolean; line: string; startedAt: number | null; endedAt: number | null;
  summary: { name: string; memories: number; files: number; skipped: number; tooBig: number; failed: number }[] | null;
}
export interface EngramStatus {
  linked: boolean; url: string; defaultUrl: string; updatedAt: number | null;
  test: { ok: boolean; detail: string; at: number } | null;
  poll: { ok: boolean; detail: string; at: number } | null;
  members: { id: string; name: string; hue: Hue; shape: Shape; private: boolean; scope: EngramScope; eligible: boolean; linked: boolean; revoked: boolean; agent: string | null; prefix: string | null; at: number | null }[];
  sent: { memories: number; files: number };
  migration: EngramMigration;
}
