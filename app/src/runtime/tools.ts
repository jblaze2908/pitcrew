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
import { remember, forget } from "../engram.js";
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
      const text = String(a.text || "").trim().slice(0, 500);
      if (!text) return say("Nothing to remember", false);
      if (memberLinked(b)) {
        try {
          const r = await remember(b, text, { id: a.id ? String(a.id) : null, threadId });
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
      const id = a.id && one("SELECT 1 FROM memory WHERE id=? AND bot_id=?", a.id, b.id) ? a.id : uid("me");
      if (id === a.id) run("UPDATE memory SET text=?, updated_at=? WHERE id=?", text, now(), id);
      else run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, b.id, text, `thread:${threadId}`, now(), now());
      c.mems.get(p.threadId)?.set(id, text); // this thread already knows; other threads get it on their next turn
      addEvent(threadId, active.get(threadId)?.turnId, "system", { text: `Remembered: ${text}` });
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
