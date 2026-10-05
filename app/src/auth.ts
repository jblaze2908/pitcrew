// Single-driver auth and secret storage. Password → scrypt; sessions → random tokens stored hashed;
// provider keys → AES-256-GCM under a master key that never leaves /srv/pitcrew/data.
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DATA, one, run, now, getSetting, setSetting, audit } from "./db.js";

const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fileSecret(name: string, bytes: number) {
  const p = `${DATA}/${name}`;
  if (!existsSync(p)) writeFileSync(p, randomBytes(bytes).toString("base64url"), { mode: 0o600 });
  return readFileSync(p, "utf8").trim();
}
const MASTER = Buffer.from(fileSecret("master.key", 32), "base64url");

// The setup token gates first-run password creation, so a public URL can't be claimed by whoever arrives first.
export const setupDone = () => !!getSetting("password");
export function ensureSetupToken() { if (!setupDone()) fileSecret("setup-token", 18); }

export function setupPassword(token: unknown, password: unknown) {
  if (setupDone()) throw httpErr(409, "Already set up");
  const expected = fileSecret("setup-token", 18);
  if (!safeEq(token, expected)) throw httpErr(403, "Setup token doesn't match");
  setPassword(password);
  audit("driver", "setup.password");
}

export function setPassword(password: unknown) {
  if (typeof password !== "string" || password.length < 12) throw httpErr(400, "Use at least 12 characters");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 });
  setSetting("password", `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`);
}

// Global limiter: a single-driver app has one legitimate client, so failures anywhere count together.
let failures: number[] = [];
export function checkPassword(password: unknown) {
  const t = now();
  failures = failures.filter((f) => t - f < 15 * 60 * 1000);
  if (failures.length >= 10) throw httpErr(429, "Too many attempts. Try again in 15 minutes.");
  const [, salt, hash] = (getSetting("password") || "").split("$");
  const ok = !!salt && typeof password === "string" &&
    timingSafeEqual(scryptSync(password, Buffer.from(salt, "base64url"), 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 }), Buffer.from(hash, "base64url"));
  if (!ok) { failures.push(t); audit("anon", "login.failed"); throw httpErr(401, "Wrong password"); }
  failures = [];
  return true;
}

export function newSession() {
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(hash,created_at,expires_at) VALUES(?,?,?)", sha(token), now(), now() + SESSION_MS);
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  return token;
}
export const sessionValid = (token: string | undefined) => !!token && !!one("SELECT 1 FROM sessions WHERE hash=? AND expires_at>?", sha(token), now());
export const endSession = (token: string | undefined) => token && run("DELETE FROM sessions WHERE hash=?", sha(token));
export const endAllSessions = () => run("DELETE FROM sessions");

/** A key for one purpose (push links, …), derived from the master key so nothing new is stored. */
export const macKey = (purpose: string) => createHash("sha256").update(MASTER).update(`pitcrew:${purpose}`).digest();
export function putSecret(name: string, value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", MASTER, iv);
  const data = Buffer.concat([c.update(String(value), "utf8"), c.final()]);
  const blob = [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
  run("INSERT INTO secrets(name,blob,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at", name, blob, now());
}
export function getSecret(name: string): string | null {
  const row = one<{ blob: string }>("SELECT blob FROM secrets WHERE name=?", name);
  if (!row) return null;
  const [iv, tag, data] = row.blob.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", MASTER, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
export const secretMeta = (name: string) => one<{ updated_at: number }>("SELECT updated_at FROM secrets WHERE name=?", name) || null;
export const deleteSecret = (name: string) => run("DELETE FROM secrets WHERE name=?", name);

function safeEq(a: unknown, b: string) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
// An error the HTTP layer answers with this status and message (anything else is a 500).
export type HttpError = Error & { status?: number };
export function httpErr(status: number, message: string): HttpError { const e: HttpError = new Error(message); e.status = status; return e; }
