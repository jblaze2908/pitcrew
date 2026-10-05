// The runtime's in-memory state, shared by its modules. Nothing here survives a restart (see bootRuntime).
import type { Snapshot } from "../snapshot.js";

export type TokenUsage = Record<string, number>; // Codex's inputTokens, cachedInputTokens, outputTokens, …
// quietFrom: a scheduled run's thread updated_at before it started, put back if the run ends QUIET (nothing notable).
export interface ActiveTurn { turnId: string; codexTurnId: string | null; base: TokenUsage | null; total: TokenUsage | null; last: TokenUsage | null; usageFrom: number; snap?: Snapshot; quietFrom?: number; extraUsd?: number; editOf?: string | null }
export interface TurnEnd { turnId: string; status: string; cost: number }
export interface Lease { since: number; waiters: ((ok: boolean) => void)[]; ask?: Promise<boolean> | null }
// The browser snapshot the agent last saw: text is the diff base, lines are its ref lines for grounding.
export interface Seen { url: string | null; text: string | null; lines: string[]; title?: string | null }

export const active = new Map<string, ActiveTurn>();   // our thread id → { turnId, codexTurnId, base, total, last }
export const byCodex = new Map<string, string>();      // codex thread id → our thread id
export const waits = new Map<string, (decision: string) => void>(); // pitstop id → resolve(decision)
export const leases = new Map<string, Lease>();        // bot id → { since, waiters: [] }
export const items = new Map<string, any>();           // codex item id → item (for file-change paths)
// A shell command still running: what the Terminal tab shows after a reload. Capped at OUT_CAP; dropped on item/completed.
export interface LiveCommand { itemId: string; threadId: string; command: string; cwd: string | null; startedAt: number; output: string; gate: { effect: string; decision: string } | null }
export const liveCommands = new Map<string, LiveCommand>(); // codex item id → its command so far
export const OUT_CAP = 64_000;
// jev's call on a shell command, kept from the gate until the command's item completes (Terminal shows it per line).
export const shellVerdicts = new Map<string, { effect: string; decision: string }>(); // `${threadId}\n${command}` → verdict
export const turnWaiters = new Map<string, ((r: TurnEnd) => void)[]>(); // our thread id → [resolve] for the next finished turn (delegation)
export const usage = new Map<string, TokenUsage>();    // codex thread id → last total usage
export const snapshots = new Map<string, Seen>();      // codex thread id → { url, text, lines } from the last browser snapshot the agent saw (noteSnapshot)
export const wakeFor = new Map<string, string>();      // Chief thread id → item key it was woken for, until it acts or its turn ends
