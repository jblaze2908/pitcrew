// Event triggers: a schedule whose spec is "on event" fires when a signed webhook arrives at /api/hooks/<schedule id>.
// Signing is Standard Webhooks (HMAC-SHA256 over "id.timestamp.body", the scheme ChatGPT's MCP Events use), or a bearer
// token with the same secret for senders that can't sign. The payload is untrusted: it rides in the prompt as data and
// taints the thread, so sending, paying or signing in asks the driver for the next 10 minutes. Per request: one indexed
// read, one HMAC, at most one count over the last hour of this schedule's runs.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { one, now } from "../db.js";
import type { ScheduleRow } from "../models.js";

export const EVENT_SPEC = "on event";
export const isEventSpec = (spec: string) => spec.trim().toLowerCase() === EVENT_SPEC;
export const newHookSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

const SKEW_S = 300, PER_HOUR = 30, SEEN_MS = 10 * 60000;
const seen = new Map<string, number>(); // webhook-id → when, so a resent delivery fires once

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
/** null when the request is genuine, else why not. */
export function verifyHook(secret: string, h: (name: string) => string | undefined, body: Buffer, at = now()) {
  const bearer = /^Bearer (.+)$/.exec(h("authorization") || "")?.[1];
  if (bearer) return same(bearer, secret) ? null : "bad token";
  const id = h("webhook-id"), ts = h("webhook-timestamp"), sig = h("webhook-signature");
  if (!id || !ts || !sig) return "unsigned";
  if (!/^\d+$/.test(ts) || Math.abs(at / 1000 - Number(ts)) > SKEW_S) return "stale timestamp";
  const want = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.`).update(body).digest("base64");
  if (!sig.split(" ").some((p) => { const [v, s] = p.split(","); return v === "v1" && !!s && same(s, want); })) return "bad signature";
  for (const [k, t] of seen) if (at - t > SEEN_MS) seen.delete(k);
  if (seen.has(id)) return "duplicate";
  seen.set(id, at);
  return null;
}
/** A runaway sender can't burn the plan: 30 event runs an hour per schedule. */
export const overHookLimit = (scheduleId: string) => one<{ n: number }>("SELECT COUNT(*) n FROM schedule_runs WHERE schedule_id=? AND kind='event' AND fired_at>?", scheduleId, now() - 3600000)!.n >= PER_HOUR;
/** The payload as the member sees it: JSON pretty-printed when it parses, 4,000 chars at most. */
export function payloadText(body: Buffer) {
  const t = body.toString("utf8");
  try { return JSON.stringify(JSON.parse(t), null, 1).slice(0, 4000); } catch { return t.slice(0, 4000); }
}
export type HookSchedule = ScheduleRow & { hook_secret: string | null };
