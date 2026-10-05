// Phone push through the driver's ntfy topic: a new pit stop or a failed scheduled run, with Approve / Deny buttons the
// phone calls directly. Each button is a capability link: HMAC-signed for one pit stop and one decision, dead once the
// pit stop is decided or expires, so the phone needs no session. Money, hires, plans and member changes only get Open.
// Skipped while the driver has Pitcrew open and visible (a presence beat every 60 s). Per pit stop: one HTTPS POST.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting, one, audit, now } from "../db.js";
import { getSecret, putSecret, deleteSecret, macKey } from "../auth.js";
import type { PitstopRow } from "../models.js";

const HOST = process.env.PITCREW_HOST || "pitcrew.example.com";
const PHONE_APPROVES = new Set(["command", "mcp", "file", "site", "secret"]);
const NEVER_FROM_PHONE = new Set(["pay"]);
const PRESENT_MS = 90000;
let seenAt = 0;
export const markPresent = () => { seenAt = now(); };

export function pushConfig() { const url = getSetting("push_url", "") || ""; return { url, token: !!getSecret("push_token") }; }
export function setPushConfig(url: string, token?: string | null) {
  const u = url.trim();
  if (u && !/^https:\/\/[^\s/]+\/[\w-]{1,64}$/.test(u)) throw Object.assign(new Error("Give the topic URL, like https://ntfy.example.com/pitcrew-crew"), { status: 400 });
  setSetting("push_url", u);
  if (token === "") deleteSecret("push_token"); else if (token) putSecret("push_token", token);
  audit("driver", "push.configured", { set: !!u });
}

const sign = (body: string) => createHmac("sha256", macKey("push")).update(body).digest("base64url");
export const actToken = (id: string, decision: "approve" | "deny", exp: number) => { const b = `${id}.${decision}.${exp}`; return `${b}.${sign(b)}`; };
/** The pit stop and decision a button stands for, or null when the link is forged or stale. */
export function readActToken(tok: string, at = now()) {
  const m = /^(ps_[\w-]+|eg_[\w-]+)\.(approve|deny)\.(\d+)\.([\w-]+)$/.exec(tok);
  if (!m || Number(m[3]) < at) return null;
  const want = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`)), got = Buffer.from(m[4]);
  return want.length === got.length && timingSafeEqual(want, got) ? { id: m[1], decision: m[2] as "approve" | "deny" } : null;
}
export const phoneMayApprove = (p: Pick<PitstopRow, "kind" | "effect">) => PHONE_APPROVES.has(p.kind) && !NEVER_FROM_PHONE.has(p.effect);

type Action = { action: "http" | "view"; label: string; url: string; method?: string; clear?: boolean };
async function send(msg: { title: string; message: string; click: string; actions?: Action[]; priority?: number; tags?: string[] }) {
  const url = getSetting("push_url", "");
  if (!url || now() - seenAt < PRESENT_MS) return false;
  const base = url.replace(/\/[^/]+$/, ""), topic = url.split("/").pop()!, token = getSecret("push_token");
  const res = await fetch(base, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ topic, ...msg, title: msg.title.slice(0, 120), message: msg.message.slice(0, 800) }) });
  return res.ok;
}
/** A new pit stop on the phone. Engram proposals wait for the inbox; they're never urgent. */
export function pushPitStop(p: PitstopRow, botName: string) {
  if (p.kind === "engram") return;
  const open = `https://${HOST}/${p.thread_id ? `#/t/${p.thread_id}` : "#/pitstops"}`, act = (d: "approve" | "deny") => `https://${HOST}/api/push/act/${actToken(p.id, d, p.expires_at)}`;
  const actions: Action[] = [
    ...(phoneMayApprove(p) ? [{ action: "http" as const, label: "Approve", url: act("approve"), method: "POST", clear: true }] : []),
    { action: "http", label: "Deny", url: act("deny"), method: "POST", clear: true },
    { action: "view", label: "Open", url: open },
  ];
  send({ title: `${botName} needs you`, message: p.title, click: open, actions, priority: 4, tags: ["checkered_flag"] }).catch(() => {});
}
export function pushRunFailed(botName: string, spec: string, why: string, threadId: string | null) {
  const open = `https://${HOST}/${threadId ? `#/t/${threadId}` : "#/schedules"}`;
  send({ title: `${botName}'s scheduled run failed`, message: `${spec}: ${why || "no reason given"}`, click: open, actions: [{ action: "view", label: "Open", url: open }], priority: 3, tags: ["warning"] }).catch(() => {});
}
export const pushTest = () => send({ title: "Pitcrew", message: "Phone notifications work. Pit stops will show up here with Approve and Deny.", click: `https://${HOST}/` });
export const pitForAct = (id: string) => one<PitstopRow>("SELECT * FROM pitstops WHERE id=?", id);
