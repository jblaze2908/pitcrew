// Engram link state: the URL, the encrypted link token and each member's own token. No network here, so the brain
// config (computer.ts) reads it without importing the link client. Per call: one or two indexed secret reads.
import { getSetting } from "./db.js";
import { getSecret, secretMeta } from "./auth.js";
import type { Bot } from "../shared/types.js";

export const DEFAULT_URL = "https://engram.example.com";
export const LINK_SECRET = "engram_link";
export const memberSecret = (botId: string) => `engram_member:${botId}`;
export const engramUrl = () => getSetting("engram_url") || DEFAULT_URL;
export const linked = () => !!secretMeta(LINK_SECRET);
// A private member joins Engram only with its own scope (finance or health), so no other member's grants reach its memories.
export const engramEligible = (b: Pick<Bot, "private" | "engram_scope">) => !b.private || b.engram_scope !== "personal";
// Linked, eligible and holding its own token: its memories live in Engram. Two indexed reads per call.
export const memberLinked = (b: Pick<Bot, "id" | "private" | "engram_scope">) => linked() && engramEligible(b) && !!secretMeta(memberSecret(b.id));

// https only, no credentials or query; plain http only when PITCREW_ENGRAM_INSECURE=1 (tests, local dev).
export function normaliseUrl(v: unknown) {
  let u: URL; try { u = new URL(String(v || "").trim()); } catch { return null; }
  const insecure = process.env.PITCREW_ENGRAM_INSECURE === "1" && u.protocol === "http:";
  if ((u.protocol !== "https:" && !insecure) || u.username || u.password || u.search || u.hash) return null;
  const s = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return s.length <= 200 ? s : null;
}

export interface McpServer { name: string; url: string; envVar: string | null; token: string | null }
const envName = (name: string) => "MCP_TOKEN_" + name.toUpperCase().replace(/-/g, "_");
// A member's MCP servers for its Codex config. Linked (and eligible) with its own Engram token: Engram alone, so no
// upstream connector token reaches the brain. Otherwise the member's own connector list, as before.
export function brainMcp(b: Bot): McpServer[] {
  const token = linked() && engramEligible(b) ? getSecret(memberSecret(b.id)) : null;
  if (token) return [{ name: "engram", url: `${engramUrl()}/mcp`, envVar: envName("engram"), token }];
  return (b.mcp || []).filter((m) => /^[a-z][a-z0-9_-]{0,31}$/.test(m.name) && /^https:\/\//.test(m.url))
    .map((m) => ({ name: m.name, url: m.url, envVar: m.tokenSecret ? envName(m.name) : null, token: m.tokenSecret ? getSecret(m.tokenSecret) : null }));
}
