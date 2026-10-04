// Pitcrew's own dynamic tools: surfaces, shared screenshots, memory, schedules, finding threads, hiring, and the
// Chief's delegation and plans. Browser and pixel tools go on to runtimeTool.
import { one, run, now, uid, audit, getSetting } from "../db.js";
import { getBot, listBots, normaliseSpec } from "../crew.js";
import { validateSurface } from "../surfaces.js";
import { resolveSurface, ledgerPath, listLedgers, mayRead, runQueries } from "../ledger.js";
import { imageFrom, saveShot, type ToolResult } from "../shots.js";
import type { Brain } from "../computer.js";
import { active } from "./state.js";
import { addEvent, findThreads, threadLink, readThread, addThreadNote, NOTES_MAX } from "./threads.js";
import { viewSkill } from "./skills.js";
import { harnessHelp, TOPICS } from "../manual.js";
import { CHANGELOG } from "../changelog.js";
import { suggest } from "./retro.js";
import { crewOverview, soulProposal, retireProposal, memberChange, memberFiles, fileDeletion, triageSuggestion, openSuggestions } from "./manage.js";
import { computer } from "./machines.js";
import { pitStop } from "./pitstops.js";
import { addSchedule, listSchedules, updateSchedule, deleteSchedule, lastScheduledRun } from "./schedules.js";
import { askCrew } from "./delegation.js";
import { planTool } from "./plans.js";
import { runtimeTool, type ToolCall } from "./browser.js";
import { IST, say } from "./util.js";
import { remember, forget, publishFile } from "../engram.js";
import { noteLearned } from "./learned.js";
import { memberLinked } from "../engramStore.js";

const ist = (t: number | null) => (t ? new Date(t + IST).toISOString().slice(0, 16).replace("T", " ") : "—");

// Agent memory's cap (chars across a member's memories): small enough to sit in every thread's instructions (~750
// tokens, estimate), so it gets rewritten instead of growing.
export const AGENT_MEMORY_MAX = 3000;
// Why a note isn't about the driver (so it belongs in agent memory), or null. Paths, files and task state are the
// member's working knowledge, not facts about the driver.
export function notGlobal(text: string) {
  if (/\/bot\/|\.(db|py|mjs|js|csv|json|md)\b/i.test(text)) return "it names files or paths in your workspace";
  if (/\b(ledger|update\.py|schedule[sd]?|backfill|cursor|script|endpoint)\b/i.test(text)) return "it's about how your task runs";
  return null;
}
export async function dynamicTool(c: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(c.bot.id)!, a = p.arguments || {};
  switch (p.tool) {
    case "render_surface": {
      const { id: given, ...spec } = a;
      const v = validateSurface(spec);
      if (!v.ok) return say(`VALIDATION_FAILED. Fix these and call render_surface again:\n${v.errors.join("\n")}`, false);
      // With an id, the member's own surface changes in place: its card redraws where it first appeared, and a kept
      // dashboard stays kept. Without one, a new surface.
      const prev = given ? one<{ id: string; saved: number }>("SELECT id, saved FROM surfaces WHERE id=? AND bot_id=?", String(given), b.id) : null;
      if (given && !prev) return say(`No surface ${given} of yours to update; omit id to make a new one.`, false);
      const id = prev?.id || uid("sf");
      if (prev) run("UPDATE surfaces SET title=?, spec=? WHERE id=?", spec.title, JSON.stringify(spec), id);
      else run("INSERT INTO surfaces(id,thread_id,bot_id,title,spec,created_at) VALUES(?,?,?,?,?,?)", id, threadId, b.id, spec.title, JSON.stringify(spec), now());
      const shown = await resolveSurface({ id, title: spec.title, spec, saved: prev?.saved ?? 0 }, b.id);
      addEvent(threadId, active.get(threadId)?.turnId, "surface", { id, title: spec.title, ...(prev ? { updated: true } : {}) }, { surface: shown });
      // A bound surface reports each query's outcome, so a bad column or an empty result gets fixed now, not seen later.
      const errs = shown.data?.errors || [];
      const checks = spec.queries ? `\nQueries against ${spec.source}: ${errs.length ? `${errs.length} failed:\n${errs.join("\n")}` : "all ran."}` : "";
      return say(`${prev ? "Updated" : "Rendered"} surface ${id} for the driver.${checks}${v.actions!.length ? ` Its actions (${v.actions!.join(", ")}) will come back to you as a message.` : ""}`);
    }
    case "share_screenshot": {
      const caption = String(a.caption || "").trim().slice(0, 300);
      if (!caption) return say("Give the screenshot a caption", false);
      const screen = a.source === "screen";
      const sa = screen ? {} : { type: "jpeg", ...(a.full_page ? { fullPage: true } : {}), ...(a.element && (a.ref || a.target) ? { element: String(a.element), target: String(a.ref || a.target) } : {}) }; // 0.0.82 names it target
      // Through runtimeTool, so the lease, the gate and the tool log apply as for any screenshot.
      const r = await runtimeTool(c, threadId, { ...p, tool: screen ? "computer_screenshot" : "browser_take_screenshot", arguments: sa });
      if (!r.success) return r;
      const img = imageFrom(r, b.id);
      const shot = img && (await saveShot(b.id, computer(b).name, img));
      if (!shot) return say("The screenshot was taken but couldn't be saved for the driver.", false);
      addEvent(threadId, active.get(threadId)?.turnId, "shot", { botId: b.id, file: shot.file, caption, bytes: shot.bytes });
      audit("crew", "screenshot.shared", { botId: b.id, threadId, file: shot.file, bytes: shot.bytes, original: shot.original });
      return say("Shared with the driver in this chat.");
    }
    case "remember": {
      const turnId = active.get(threadId)?.turnId, text = String(a.text || "").trim().slice(0, 500);
      if (!text) return say("Nothing to remember", false);
      const until = /^\d{4}-\d{2}-\d{2}$/.test(String(a.valid_until || "")) ? String(a.valid_until) : null;
      if (a.valid_until && !until) return say("valid_until must be a date as YYYY-MM-DD", false);
      const scope = ["session", "agent", "global"].includes(a.scope) ? a.scope : "agent";
      if (scope === "session") {
        const notes = addThreadNote(threadId, text);
        if (notes == null) return say(`This thread's notes are full (${NOTES_MAX} chars): fold older notes into one.`, false);
        addEvent(threadId, turnId, "system", { text: `Noted for this thread: ${text}` });
        return say("Noted for this thread; it carries over if the thread restarts.");
      }
      if (scope === "global") {
        if (!memberLinked(b)) return say("Global notes live in Engram, and you aren't linked to it. Keep it as agent memory instead.", false);
        const why = notGlobal(text);
        if (why) return say(`Not global: ${why}. Save it with scope "agent" (your own memory) instead.`, false);
        try {
          const r = await remember(b, text, { id: a.id ? String(a.id) : null, threadId, validUntil: until, review: true });
          noteLearned(turnId, threadId, b.id, r.id, text, r.status !== "accepted" ? "held" : r.known ? "known" : r.replaced ? "replaced" : "saved");
          if (r.status === "accepted") return say(r.known ? `Engram already knows this [${r.id}].` : `Saved in Engram as [${r.id}].`);
          addEvent(threadId, turnId, "system", { text: `Sent to Engram for ${getSetting("driver_name", "the driver")}'s review: ${text}` });
          return say(`Sent to Engram for ${getSetting("driver_name", "the driver")}'s review${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}. It isn't shared until they accept it.`);
        } catch (e: any) { return say(`Couldn't send it to Engram: ${e.message}`, false); }
      }
      // Agent memory: the member's own, in Pitcrew, written freely. The cap makes it consolidate instead of growing.
      const local = until ? `${text} (valid until ${until})` : text;
      const id = a.id && one("SELECT 1 FROM memory WHERE id=? AND bot_id=? AND forgotten_at IS NULL", a.id, b.id) ? String(a.id) : uid("me");
      const used = one<{ n: number }>("SELECT COALESCE(SUM(length(text)),0) n FROM memory WHERE bot_id=? AND forgotten_at IS NULL AND id<>?", b.id, id)!.n;
      if (used + local.length > AGENT_MEMORY_MAX) return say(`Your memory is full (${AGENT_MEMORY_MAX} chars, ${used} used). Rewrite older memories into fewer (pass id) or forget stale ones, then save this.`, false);
      noteLearned(turnId, threadId, b.id, id, local, id === a.id ? "replaced" : "saved");
      if (id === a.id) run("UPDATE memory SET text=?, updated_at=? WHERE id=?", local, now(), id);
      else run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.id, local, `thread:${threadId}`, now(), now());
      c.mems.get(p.threadId)?.set(id, local); // this thread already knows; other threads get it on their next turn
      addEvent(threadId, turnId, "system", { text: `Remembered: ${local}` });
      return say(`Saved to your memory as [${id}].`);
    }
    case "forget": {
      const id = String(a.id || "");
      // me_… ids are the member's own memory in Pitcrew; anything else is an Engram id.
      if (!id.startsWith("me_") && memberLinked(b)) {
        try { await forget(b, id); } catch (e: any) { return say(`Couldn't forget it in Engram: ${e.message}`, false); }
        return say("Forgotten in Engram.");
      }
      run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), id, b.id);
      c.mems.get(p.threadId)?.delete(id);
      return say("Forgotten.");
    }
    case "schedule_task": {
      try {
        const s = addSchedule(b.id, threadId, String(a.when || ""), String(a.prompt || ""));
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Scheduled “${s.prompt.slice(0, 80)}” ${s.spec} (next ${ist(s.next_run)} IST)` });
        return say(`Scheduled ${s.id}: ${s.spec}.`);
      } catch (e: any) { return say(e.message, false); }
    }
    case "list_schedules": {
      const list = listSchedules(b.id);
      return say(list.length ? list.map((s) => { const l = lastScheduledRun(s); return `${s.id} · ${s.spec}${s.enabled ? ` · next ${ist(s.next_run)} IST` : " · paused"}${l ? ` · last run ${ist(l.at)} IST: ${l.status}${l.summary ? `, "${l.summary}"` : ""}` : " · not run yet"}\n  ${s.prompt}`; }).join("\n") : "No schedules.");
    }
    case "update_schedule": {
      try {
        const s = updateSchedule(String(a.id || ""), b.id, { ...(a.when != null ? { spec: String(a.when) } : {}), ...(a.prompt != null ? { prompt: String(a.prompt) } : {}),
          ...(typeof a.paused === "boolean" ? { enabled: !a.paused } : {}) }, "crew");
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Changed schedule “${s.prompt.slice(0, 80)}”: ${s.spec}${s.enabled ? ` (next ${ist(s.next_run)} IST)` : ", paused"}` });
        return say(`Updated ${s.id}: ${s.spec}${s.enabled ? "" : ", paused"}.`);
      } catch (e: any) { return say(e.message, false); }
    }
    case "cancel_schedule": {
      try {
        const s = deleteSchedule(String(a.id || ""), b.id, "crew");
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Cancelled schedule “${s.prompt.slice(0, 80)}” (${s.spec})` });
        return say(`Cancelled ${s.id}.`);
      } catch (e: any) { return say(e.message, false); }
    }
    case "publish_file": {
      if (!memberLinked(b)) return say("Publishing needs Engram, and this crew member isn't linked to it.", false);
      try {
        const r = await publishFile(b, String(a.path || ""), { title: a.title ? String(a.title) : undefined, id: a.id ? String(a.id) : null, public: a.public === true, description: a.description ? String(a.description) : undefined, threadId });
        const title = String(a.title || String(a.path || "").split("/").pop());
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Published “${title}”${r.version > 1 ? ` (version ${r.version})` : ""}: ${r.url}`, artifact: { id: r.id, title, url: r.url, public_url: r.public_url, version: r.version } });
        // One link per artifact (Engram): sharing changes who may open it, never the URL.
        const driver = getSetting("driver_name", "the driver");
        const who = r.public_url ? "anyone with the link can open it" : r.status === "share_pending" ? `only ${driver} until they approve sharing it in Pit stops` : `only ${driver} can open it`;
        return say(`Published as ${r.id}, version ${r.version}. Link (${who}): ${r.url} To update it, publish again with id ${r.id}.`);
      } catch (e: any) { return say(`Couldn't publish: ${e.message}`, false); }
    }
    case "query_ledger": {
      const who = String(a.member || "").trim().toLowerCase();
      const owner = who ? listBots().find((x) => x.id === who || x.name.toLowerCase() === who) : b;
      if (!owner) return say(`No crew member called "${a.member}".`, false);
      if (!mayRead(b, owner)) return say(`${owner.name} is private; its ledgers stay with it.`, false);
      if (!a.source) { const l = listLedgers(owner.id); return say(l.length ? `${owner.name}'s ledgers (under /bot/work):\n${l.map((x) => `- ${x}`).join("\n")}` : `${owner.name} keeps no ledgers.`); }
      const file = ledgerPath(owner.id, a.source);
      if (!file) return say(`${owner.name} has no ledger at ${a.source}; call query_ledger without source to list them.`, false);
      const r = (await runQueries(file, { q: String(a.sql || "") })).results.q;
      if ("error" in r) return say(`Query failed: ${r.error}`, false);
      const body = JSON.stringify(r.rows);
      return say(`${r.rows.length} row${r.rows.length === 1 ? "" : "s"}${r.truncated ? " (cut at 500)" : ""} from ${owner.name}'s ${a.source}:\n${body.length > 24000 ? `${body.slice(0, 24000)}…` : body}`);
    }
    case "crew_overview": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const o = crewOverview(a.member ? String(a.member) : undefined);
      const ideas = openSuggestions();
      return o ? say(`${o}${ideas.length ? `\n\n## Open suggestions\n${ideas.map((i) => `- ${i.id} · ${i.title} (${i.area}, ${i.votes}×, from ${getBot(i.bot_id)?.name || i.bot_id})`).join("\n")}` : ""}`) : say(`No crew member called "${a.member}".`, false);
    }
    case "propose_soul": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const pr = soulProposal(String(a.member || ""), String(a.soul || ""), String(a.why || ""));
      if ("error" in pr) return say(pr.error!, false);
      const decision = await pitStop({ botId: b.id, threadId, kind: "soul", effect: "soul", title: `New SOUL for ${pr.bot!.name}`, detail: pr.detail! });
      return say(decision === "approved" ? `${pr.bot!.name}'s SOUL is updated; its new threads use it.` : decision === "expired" ? `${getSetting("driver_name", "the driver")} didn't answer; the SOUL is unchanged and the proposal expired.` : `${getSetting("driver_name", "the driver")} kept the current SOUL.`, decision === "approved");
    }
    case "propose_retire": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const pr = retireProposal(String(a.member || ""), String(a.why || ""));
      if ("error" in pr) return say(pr.error!, false);
      const decision = await pitStop({ botId: b.id, threadId, kind: "retire", effect: "retire", title: `Retire ${pr.bot!.name}`, detail: pr.detail! });
      const driver = getSetting("driver_name", "the driver");
      return say(decision === "approved" ? `${pr.bot!.name} is retired; its schedules are off. Your crew list updates in your next thread.` : decision === "expired" ? `${driver} didn't answer; ${pr.bot!.name} stays and the proposal expired.` : `${driver} kept ${pr.bot!.name}.`, decision === "approved");
    }
    case "propose_member_change": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const pr = memberChange(String(a.member || ""), a.changes, String(a.why || ""));
      if ("error" in pr) return say(pr.error!, false);
      const fields = pr.detail!.diff.map((d) => d.field);
      const decision = await pitStop({ botId: b.id, threadId, kind: "member", effect: "member", title: `Change ${pr.bot!.name}: ${fields.join(", ")}`, detail: pr.detail! });
      const driver = getSetting("driver_name", "the driver");
      return say(decision === "approved" ? `${pr.bot!.name} is updated (${fields.join(", ")}); its next run uses it.` : decision === "expired" ? `${driver} didn't answer; nothing changed and the proposal expired.` : `${driver} kept ${pr.bot!.name} as it was.`, decision === "approved");
    }
    case "member_files": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const r = memberFiles(String(a.member || ""), String(a.path || ""));
      return "error" in r ? say(r.error!, false) : say(r.text!);
    }
    case "delete_member_files": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      const pr = fileDeletion(String(a.member || ""), a.paths, String(a.why || ""));
      if ("error" in pr) return say(pr.error!, false);
      const n = pr.detail!.paths.length;
      const decision = await pitStop({ botId: b.id, threadId, kind: "files", effect: "delete", title: `Delete ${n} item${n === 1 ? "" : "s"} from ${pr.bot!.name}'s files`, detail: pr.detail! });
      const driver = getSetting("driver_name", "the driver");
      return say(decision === "approved" ? `Deleted from ${pr.bot!.name}'s workspace: ${pr.detail!.paths.map((p) => p.path).join(", ")}.` : decision === "expired" ? `${driver} didn't answer; nothing was deleted and the proposal expired.` : `${driver} kept the files.`, decision === "approved");
    }
    case "triage_suggestion": {
      if (b.kind !== "chief") return say("Only the Crew Chief manages the crew.", false);
      return say(triageSuggestion(String(a.id || ""), { mergeInto: a.merge_into ? String(a.merge_into) : null, note: String(a.note || "") }));
    }
    case "suggest_improvement": {
      const s = { area: String(a.area || "other"), title: String(a.title || "").trim(), evidence: String(a.evidence || "").trim(), proposal: String(a.proposal || "").trim() };
      if (!s.title || !s.evidence) return say("A suggestion needs a title and the evidence (runs, numbers, what happened).", false);
      const r = suggest(b.id, threadId, s);
      return say(r.repeat ? "Already suggested; your evidence was added to it." : `Filed as ${r.id} for ${getSetting("driver_name", "the driver")} to review.`);
    }
    case "harness_help": {
      const page = harnessHelp(String(a.topic || ""), getSetting("driver_name", "the driver"));
      return page ? say(page) : say(`Topics: ${TOPICS.join(", ")}.`, false);
    }
    case "whats_new": {
      // Members count what they've read, so a note added later shows up exactly once (changelog.ts: append only).
      const seen = Math.min(Number(one<{ n: number }>("SELECT changelog_seen n FROM bots WHERE id=?", b.id)?.n || 0), CHANGELOG.length);
      run("UPDATE bots SET changelog_seen=? WHERE id=?", CHANGELOG.length, b.id);
      const fresh = CHANGELOG.slice(seen);
      return say(fresh.length ? fresh.map((x) => `- ${x.date}: ${x.note}`).join("\n") : "Nothing new since you last looked.");
    }
    case "skill_view": {
      const s = viewSkill(b.id, String(a.name || ""), a.file ? String(a.file) : "SKILL.md");
      if (!s) return say(`No skill "${a.name}"${a.file ? ` with ${a.file}` : ""} in /bot/work/skills.`, false);
      return say(`${s.text}${s.files.length ? `\n\nFiles in this skill: ${s.files.join(", ")}` : ""}`);
    }
    case "read_thread": {
      const id = /th_[\w-]{4,40}/.exec(String(a.thread || ""))?.[0];
      const r = id ? readThread(id, Number(a.after) || 0) : null;
      if (!r) return say("No such thread; give its id or link (from find_threads).", false);
      const owner = getBot(r.botId);
      // A member reads its own threads; the Chief also reads non-private members' (it coordinates them).
      if (r.botId !== b.id && !(b.kind === "chief" && owner && !owner.private)) return say("That thread belongs to another crew member.", false);
      return say(`${r.title}\n\n${r.text || "(nothing after that point)"}${r.next ? `\n\n[more: call read_thread with after: ${r.next}]` : "\n\n[end of thread]"}`);
    }
    case "find_threads": {
      const found = findThreads(b.id, a.query, { exclude: threadId, limit: Math.min(Number(a.limit) || 8, 20) });
      if (!found.length) return say(`No other threads match "${String(a.query || "").slice(0, 80)}".`);
      const day = (t: number) => new Date(t + IST).toISOString().slice(0, 16).replace("T", " ");
      return say(found.map((t) => `- [${t.title}](${threadLink(t.id)}) · last active ${day(t.updated_at)} IST${t.archived ? " · archived" : ""}${t.of ? ` · matched ${t.matched}/${t.of} terms` : ""}${t.snippet ? `\n  ${t.snippet}` : ""}`).join("\n")
        + "\n\nGive the driver the matching thread as a markdown link exactly as written above.");
    }
    case "ask_crew_member": return askCrew(b, threadId, a);
    case "plan": return planTool(b, threadId, a);
    case "propose_crew_member": {
      if (b.kind !== "chief") return say("Only the Crew Chief can propose crew members.", false);
      const spec = normaliseSpec(a);
      pitStop({ botId: b.id, threadId, kind: "hire", effect: "hire", title: `Hire ${spec.name}: ${spec.job.slice(0, 120)}`, detail: { spec }, expiresMin: 7 * 24 * 60 });
      return say(`Proposal sent. ${getSetting("driver_name", "The driver")} reviews it as a HIRE pit stop; don't create anything else for it.`);
    }
    default:
      if (/^(browser|computer)_/.test(p.tool)) return runtimeTool(c, threadId, p);
      return say(`Unknown tool ${p.tool}`, false);
  }
}
