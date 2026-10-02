// Pitcrew's own dynamic tools: surfaces, shared screenshots, memory, schedules, finding threads, hiring, and the
// Chief's delegation and plans. Browser and pixel tools go on to runtimeTool.
import { one, run, now, uid, audit, getSetting } from "../db.js";
import { getBot, normaliseSpec } from "../crew.js";
import { validateSurface } from "../surfaces.js";
import { imageFrom, saveShot, type ToolResult } from "../shots.js";
import type { Brain } from "../computer.js";
import { active } from "./state.js";
import { addEvent, findThreads, threadLink } from "./threads.js";
import { computer } from "./machines.js";
import { pitStop } from "./pitstops.js";
import { addSchedule } from "./schedules.js";
import { askCrew } from "./delegation.js";
import { planTool } from "./plans.js";
import { runtimeTool, type ToolCall } from "./browser.js";
import { IST, say } from "./util.js";
import { remember, forget, publishFile } from "../engram.js";
import { noteLearned } from "./learned.js";
import { memberLinked } from "../engramStore.js";

export async function dynamicTool(c: Brain, threadId: string, p: ToolCall): Promise<ToolResult> {
  const b = getBot(c.bot.id)!, a = p.arguments || {};
  switch (p.tool) {
    case "render_surface": {
      const v = validateSurface(a);
      if (!v.ok) return say(`VALIDATION_FAILED. Fix these and call render_surface again:\n${v.errors.join("\n")}`, false);
      const id = uid("sf");
      run("INSERT INTO surfaces(id,thread_id,bot_id,title,spec,created_at) VALUES(?,?,?,?,?,?)", id, threadId, b.id, a.title, JSON.stringify(a), now());
      addEvent(threadId, active.get(threadId)?.turnId, "surface", { id, title: a.title }, { surface: { id, title: a.title, spec: a, saved: 0 } });
      return say(`Rendered surface ${id} for the driver.${v.actions!.length ? ` Its actions (${v.actions!.join(", ")}) will come back to you as a message.` : ""}`);
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
      if (memberLinked(b)) {
        try {
          const r = await remember(b, text, { id: a.id ? String(a.id) : null, threadId, validUntil: until });
          noteLearned(turnId, threadId, b.id, r.id, text, r.status !== "accepted" ? "held" : r.known ? "known" : r.replaced ? "replaced" : "saved");
          if (r.status === "accepted") {
            if (r.replaced) c.mems.get(p.threadId)?.delete(r.replaced);
            c.mems.get(p.threadId)?.set(r.id, text);
            addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Remembered in Engram: ${text}` });
            return say(`Saved in Engram as [${r.id}].`);
          }
          addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Sent to Engram for review: ${text}` });
          return say(`Engram is holding this for ${getSetting("driver_name", "the driver")} to review${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}. It isn't a memory until they accept it.`);
        } catch (e: any) { return say(`Couldn't save it to Engram: ${e.message}`, false); }
      }
      // Pitcrew's own table has no expiry column, so the date goes in the text.
      const local = until ? `${text} (valid until ${until})` : text;
      const id = a.id && one("SELECT 1 FROM memory WHERE id=? AND bot_id=?", a.id, b.id) ? a.id : uid("me");
      noteLearned(turnId, threadId, b.id, id, local, id === a.id ? "replaced" : "saved");
      if (id === a.id) run("UPDATE memory SET text=?, updated_at=? WHERE id=?", local, now(), id);
      else run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.id, local, `thread:${threadId}`, now(), now());
      c.mems.get(p.threadId)?.set(id, local); // this thread already knows; other threads get it on their next turn
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Remembered: ${local}` });
      return say(`Saved as [${id}].`);
    }
    case "forget": {
      if (memberLinked(b)) {
        try { await forget(b, String(a.id || "")); } catch (e: any) { return say(`Couldn't forget it in Engram: ${e.message}`, false); }
        c.mems.get(p.threadId)?.delete(String(a.id));
        return say("Forgotten in Engram.");
      }
      run("UPDATE memory SET forgotten_at=? WHERE id=? AND bot_id=?", now(), String(a.id), b.id);
      c.mems.get(p.threadId)?.delete(String(a.id));
      return say("Forgotten.");
    }
    case "schedule_task": {
      try {
        const s = addSchedule(b.id, threadId, String(a.when || ""), String(a.prompt || ""));
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Scheduled “${s.prompt.slice(0, 80)}” ${s.spec} (next ${new Date(s.next_run + IST).toISOString().slice(0, 16).replace("T", " ")} IST)` });
        return say(`Scheduled ${s.id}: ${s.spec}.`);
      } catch (e: any) { return say(e.message, false); }
    }
    case "publish_file": {
      if (!memberLinked(b)) return say("Publishing needs Engram, and this crew member isn't linked to it.", false);
      try {
        const r = await publishFile(b, String(a.path || ""), { title: a.title ? String(a.title) : undefined, id: a.id ? String(a.id) : null, public: a.public === true, description: a.description ? String(a.description) : undefined, threadId });
        const title = String(a.title || String(a.path || "").split("/").pop());
        addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Published “${title}”${r.version > 1 ? ` (version ${r.version})` : ""}: ${r.url}`, artifact: { id: r.id, title, url: r.url, public_url: r.public_url, version: r.version } });
        const share = r.status === "share_pending" ? ` A public link waits for ${getSetting("driver_name", "the driver")}'s approval in Pit stops.` : r.public_url ? ` Public link: ${r.public_url}` : "";
        return say(`Published as ${r.id}, version ${r.version}. Private link (only ${getSetting("driver_name", "the driver")} can open it): ${r.url}${share} To update it, publish again with id ${r.id}.`);
      } catch (e: any) { return say(`Couldn't publish: ${e.message}`, false); }
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
