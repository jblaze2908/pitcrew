// Code Mode scripts: Codex's `exec` source and output reach only the model; the app-server emits just the script's nested
// tool calls (ids "exec-<uuid>", one per call, not per script) — measured 2026-10-02, codex 0.156.1. The thread's
// rollout file has both, so they're read from there. Per call: one read of the rollout's new bytes since the last
// offset, on a script's first nested call and at turn end; never per item.
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { brainDir } from "../computer.js";
import { addEvent } from "./threads.js";

const CODE_MAX = 20_000, OUT_MAX = 4_000;
type Track = { path: string; offset: number; shown: Set<string>; done: Set<string> };
const tracks = new Map<string, Track>(); // codex thread id → its rollout

/** Remember where a thread's rollout lives (thread.path from start/resume/fork). Only files under that member's brain dir. */
export function setRollout(botId: string, codexId: string, containerPath: unknown) {
  if (typeof containerPath !== "string" || !containerPath.startsWith(`/brains/${botId}/`)) return;
  const host = brainDir(botId) + containerPath.slice(`/brains/${botId}`.length);
  let size = 0;
  try { size = statSync(host).size; } catch {}
  // Start at the current end: earlier scripts were shown (or predate this), so only new ones are read.
  const old = tracks.get(codexId);
  tracks.set(codexId, { path: host, offset: old?.path === host ? old.offset : size, shown: old?.shown ?? new Set(), done: old?.done ?? new Set() });
}

function readNew(t: Track, botId: string): string[] {
  let fd: number | null = null;
  try {
    const real = realpathSync(t.path);
    if (!real.startsWith(realpathSync(brainDir(botId)) + "/")) return [];
    fd = openSync(real, "r");
    const size = statSync(real).size;
    if (size <= t.offset) return [];
    const buf = Buffer.alloc(Math.min(size - t.offset, 8 << 20));
    const n = readSync(fd, buf, 0, buf.length, t.offset);
    const text = buf.subarray(0, n).toString("utf8"), end = text.lastIndexOf("\n");
    if (end < 0) return [];
    t.offset += Buffer.byteLength(text.slice(0, end + 1));  // a half-written last line waits for the next read
    return text.slice(0, end).split("\n");
  } catch { return []; } finally { if (fd != null) closeSync(fd); }
}

const outText = (o: unknown) => (typeof o === "string" ? o : Array.isArray(o) ? o.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "");

/** New scripts become "Ran a script" steps (the code); finished ones add their output, merged into that step by callId. */
export function scanScripts(threadId: string, turnId: string | null | undefined, botId: string, codexId: string) {
  const t = tracks.get(codexId);
  if (!t) return;
  for (const line of readNew(t, botId)) {
    let p: any;
    try { p = JSON.parse(line)?.payload; } catch { continue; }
    if (p?.type === "custom_tool_call" && p.name === "exec" && typeof p.call_id === "string" && !t.shown.has(p.call_id)) {
      t.shown.add(p.call_id);
      addEvent(threadId, turnId, "tool", { type: "script", title: "Ran a script", callId: p.call_id, code: String(p.input || "").slice(0, CODE_MAX), status: "inProgress" });
    } else if (p?.type === "custom_tool_call_output" && t.shown.has(p.call_id) && !t.done.has(p.call_id)) {
      t.done.add(p.call_id);
      const out = outText(p.output);
      addEvent(threadId, turnId, "tool", { type: "scriptResult", callId: p.call_id, output: out.slice(0, OUT_MAX), status: /^Script (failed|error)/i.test(out) ? "failed" : "completed" });
    }
  }
}
export const forgetRollout = (codexId: string) => tracks.delete(codexId);
