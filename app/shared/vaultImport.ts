// Parsers for what the driver imports into the vault, run in the browser so a whole export never reaches the server:
// Google Password Manager's CSV and Google Authenticator's "Transfer accounts" QR (otpauth-migration://). Only the rows
// the driver ticks are sent, one secret at a time. Shared so the tests exercise the same code.

export interface CsvLogin { name: string; url: string; site: string; username: string; password: string }
// RFC 4180: quoted fields, "" escapes, newlines inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}
// Google's export: name,url,username,password(,note). The note column is dropped here: it can hold recovery codes.
export function parseGoogleCsv(text: string): CsvLogin[] {
  const [head, ...rows] = parseCsv(text);
  const col = (n: string) => (head || []).findIndex((h) => h.trim().toLowerCase() === n);
  const [ni, ui, li, pi] = ["name", "url", "username", "password"].map(col);
  if (ui < 0 || pi < 0) throw new Error("This doesn't look like a Google Passwords export (it needs url and password columns)");
  return rows.map((r) => {
    const url = (r[ui] || "").trim();
    let site = ""; try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) site = u.hostname.toLowerCase().replace(/^www\./, ""); } catch {}
    return { name: ((ni >= 0 ? r[ni] : "") || site || url).trim().slice(0, 60), url, site, username: li >= 0 ? r[li] || "" : "", password: r[pi] || "" };
  }).filter((x) => x.password || x.username);
}

// ---------- Google Authenticator export ----------
export interface OtpAccount { name: string; issuer: string; secret: string; algorithm: "SHA1" | "SHA256" | "SHA512" | "MD5"; digits: 6 | 8; type: "totp" | "hotp"; uri: string }
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(b: Uint8Array) {
  let bits = 0, val = 0, out = "";
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(val >>> bits) & 31]; } val &= (1 << bits) - 1; }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}
// Minimal protobuf reader: [field, value] pairs, value a number (varint) or bytes (length-delimited).
function pb(buf: Uint8Array) {
  const out: [number, number | Uint8Array][] = []; let i = 0;
  const varint = () => { let r = 0, m = 1, b: number; do { if (i >= buf.length) throw new Error("truncated"); b = buf[i++]; r += (b & 127) * m; m *= 128; } while (b & 128); return r; };
  while (i < buf.length) {
    const tag = varint(), f = Math.floor(tag / 8), w = tag % 8;
    if (w === 0) out.push([f, varint()]);
    else if (w === 2) { const n = varint(); if (i + n > buf.length) throw new Error("truncated"); out.push([f, buf.subarray(i, i + n)]); i += n; }
    else if (w === 1 || w === 5) i += w === 1 ? 8 : 4;
    else throw new Error("not a migration payload");
  }
  return out;
}
const utf8 = (b: unknown) => (b instanceof Uint8Array ? new TextDecoder().decode(b) : "");
const ALGO = ["SHA1", "SHA1", "SHA256", "SHA512", "MD5"] as const;
// otpauth-migration://offline?data=<base64 MigrationPayload>; each OtpParameters: secret 1, name 2, issuer 3,
// algorithm 4, digits 5 (1 six, 2 eight), type 6 (1 hotp, 2 totp).
export function parseMigration(text: string): OtpAccount[] {
  const t = text.trim();
  if (!/^otpauth-migration:\/\//i.test(t)) throw new Error("Not an otpauth-migration:// link");
  const data = /[?&]data=([^&]+)/.exec(t)?.[1];
  if (!data) throw new Error("The link has no data");
  const b64 = decodeURIComponent(data).replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return pb(bytes).filter(([f, v]) => f === 1 && v instanceof Uint8Array).map(([, v]) => {
    const p = pb(v as Uint8Array), get = (n: number) => p.find(([f]) => f === n)?.[1];
    const secret = base32Encode((get(1) as Uint8Array) || new Uint8Array()), name = utf8(get(2)), issuer = utf8(get(3));
    const algorithm = ALGO[Number(get(4) || 0)] || "SHA1", digits = get(5) === 2 ? 8 : 6, type = get(6) === 1 ? "hotp" : "totp";
    const label = encodeURIComponent(issuer ? `${issuer}:${name}` : name);
    return { name, issuer, secret, algorithm, digits, type, uri: `otpauth://${type}/${label}?secret=${secret}${issuer ? `&issuer=${encodeURIComponent(issuer)}` : ""}&algorithm=${algorithm}&digits=${digits}&period=30` } as OtpAccount;
  });
}
