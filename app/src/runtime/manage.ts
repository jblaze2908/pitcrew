// The Crew Chief as crew manager: it reads how every member is set up and doing, proposes SOUL changes (the driver
// approves), and tidies the crew's suggestions. It never changes another member directly. Private members show their
// setup only: their memory, runs and threads stay with the driver. Per call: a few indexed reads per member.
import { one, all, run, now, json, audit } from "../db.js";
import { getBot, listBots, soulOf, SOUL_MAX, updateBot } from "../crew.js";
import { listSkills } from "./skills.js";

export function crewOverview(memberName?: string) {
  const bots = listBots().filter((x) => x.kind !== "chief" && (!memberName || x.name.toLowerCase() === memberName.toLowerCase() || x.id === memberName));
  if (!bots.length) return null;
  const week = now() - 7 * 86400000;
  return bots.map((b) => {
    const skills = listSkills(b.id);
    const lines = [`## ${b.name}${b.private ? " (private)" : ""}: ${b.job || "no job set"}`,
      `SOUL${b.soul?.trim() ? "" : " (default, from job and voice)"}: ${soulOf(b).replace(/\n/g, " ").slice(0, 600)}`,
      b.house_rules?.trim() ? `House rules: ${b.house_rules.replace(/\n/g, "; ").slice(0, 300)}` : "House rules: none",
      `Skills (${skills.length}): ${skills.map((s) => `${s.name} (${s.uses ? `${s.uses} loads` : "never loaded"}${s.stale ? ", stale" : ""})`).join(", ") || "none"}`];
    if (!b.private) {
      const mem = one<{ n: number; c: number }>("SELECT COUNT(*) n, COALESCE(SUM(length(text)),0) c FROM memory WHERE bot_id=? AND forgotten_at IS NULL", b.id)!;
      const runs = all<{ status: string; trigger: string; started_at: number; ended_at: number | null; input_tokens: number }>("SELECT status,trigger,started_at,ended_at,input_tokens FROM turns WHERE bot_id=? ORDER BY started_at DESC LIMIT 5", b.id);
      const retros = one<{ n: number }>("SELECT COUNT(*) n FROM turns WHERE bot_id=? AND trigger='retro' AND started_at>?", b.id, week)!.n;
      const ideas = one<{ n: number }>("SELECT COUNT(*) n FROM improvements WHERE bot_id=? AND status='open'", b.id)!.n;
      lines.push(`Agent memory: ${mem.n} notes, ${mem.c} / 3000 chars`,
        `Last runs: ${runs.map((r) => `${r.trigger} ${r.status} ${r.ended_at ? Math.round((r.ended_at - r.started_at) / 1000) : "?"}s ${Math.round(r.input_tokens / 1000)}k`).join("; ") || "none"}`,
        `Retros this week: ${retros}; open suggestions: ${ideas}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

// A SOUL rewrite for the driver to approve (pit stop kind "soul"); approving applies it (pitstops.ts).
export function soulProposal(memberName: string, soul: string, why: string) {
  const b = listBots().find((x) => x.kind !== "chief" && (x.name.toLowerCase() === memberName.toLowerCase() || x.id === memberName));
  if (!b) return { error: `No crew member called "${memberName}".` };
  const text = soul.trim();
  if (!text) return { error: "The SOUL is empty." };
  if (text.length > SOUL_MAX) return { error: `A SOUL is at most ${SOUL_MAX} chars (this is ${text.length}).` };
  return { bot: b, detail: { member: b.id, memberName: b.name, before: b.soul || "", soul: text, why: why.slice(0, 600) } };
}
export function applySoul(detail: { member?: string; soul?: string }) {
  if (detail.member && typeof detail.soul === "string" && getBot(detail.member)) { updateBot(detail.member, { soul: detail.soul } as any); audit("driver", "soul.applied", { botId: detail.member }); }
}

// Folds one open suggestion into another (its evidence and votes move over) or adds evidence; accepting and dismissing
// stay with the driver.
export function triageSuggestion(id: string, { mergeInto = null, note = "" }: { mergeInto?: string | null; note?: string }) {
  const s = one<{ id: string; evidence: string; votes: number; title: string }>("SELECT id,evidence,votes,title FROM improvements WHERE id=? AND status='open'", id);
  if (!s) return "No open suggestion with that id.";
  if (mergeInto) {
    const t = one<{ id: string; evidence: string }>("SELECT id,evidence FROM improvements WHERE id=? AND status='open'", mergeInto);
    if (!t || t.id === s.id) return "No other open suggestion with that id to merge into.";
    run("UPDATE improvements SET votes=votes+?, evidence=?, updated_at=? WHERE id=?", s.votes, `${t.evidence}\n— merged “${s.title}”: ${s.evidence}`.slice(-4000), now(), t.id);
    run("UPDATE improvements SET status='merged', updated_at=? WHERE id=?", now(), s.id);
    return `Merged into ${t.id}.`;
  }
  if (!note.trim()) return "Pass merge_into or a note.";
  run("UPDATE improvements SET evidence=?, updated_at=? WHERE id=?", `${s.evidence}\n— Chief: ${note.trim()}`.slice(-4000), now(), s.id);
  return "Note added.";
}
export const openSuggestions = () => all<{ id: string; title: string; area: string; votes: number; bot_id: string }>("SELECT id,title,area,votes,bot_id FROM improvements WHERE status='open' ORDER BY votes DESC, updated_at DESC LIMIT 40");
