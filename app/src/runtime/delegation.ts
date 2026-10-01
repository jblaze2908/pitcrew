// Delegation: the Crew Chief asks another member and waits for the answer. The member works in its own thread under
// its own policy, cap and computer; none of the Chief's authority travels with the question. One level deep: only the
// Chief has the tool.
import { run, now, uid, audit, getSetting } from "../db.js";
import { listBots } from "../crew.js";
import type { ToolResult } from "../shots.js";
import type { Bot } from "../../shared/types.js";
import { active } from "./state.js";
import { addEvent, threadLink } from "./threads.js";
import { sendMessage, blockedReason, nextTurn, lastAgentText } from "./turns.js";
import { short, say } from "./util.js";

const ASK_WAIT_MS = 10 * 60000;
export function findMember(q: unknown, exceptId: string) {
  const s = String(q || "").trim().toLowerCase();
  const crew = listBots().filter((x) => x.id !== exceptId);
  return crew.find((x) => x.id === q) || crew.find((x) => x.name.toLowerCase() === s) || crew.find((x) => s && x.name.toLowerCase().startsWith(s)) || null;
}
export async function askCrew(from: Bot, threadId: string, a: Record<string, any>): Promise<ToolResult> {
  const driver = getSetting("driver_name", "the driver");
  if (from.kind !== "chief") return say("Only the Crew Chief can ask other crew members.", false);
  const to = findMember(a.member, from.id);
  if (!to) return say(`No crew member called "${short(a.member, 60)}". Your crew: ${listBots().filter((x) => x.id !== from.id).map((x) => x.name).join(", ")}.`, false);
  if (to.private) return say(`${to.name} is private: only ${driver} talks to it. Suggest ${driver} asks ${to.name} directly.`, false);
  const question = String(a.question || "").trim().slice(0, 4000);
  if (!question) return say("Pass the question.", false);
  const why = blockedReason(to);
  if (why) return say(`Couldn't ask ${to.name}: ${why}`, false);
  const id = uid("dg"), toThread = uid("th");
  run("INSERT INTO threads(id,bot_id,title,origin,created_at,updated_at) VALUES(?,?,?,?,?,?)", toThread, to.id, `From ${from.name}: ${short(question, 80)}`, JSON.stringify({ kind: "delegated", fromBot: from.id, fromThread: threadId, delegationId: id }), now(), now());
  run("INSERT INTO delegations(id,from_bot,from_thread,to_bot,to_thread,question,status,created_at) VALUES(?,?,?,?,?,?,?,?)", id, from.id, threadId, to.id, toThread, question, "asking", now());
  const card = { id, toBot: to.id, toName: to.name, toThread, question: short(question, 300) };
  addEvent(threadId, active.get(threadId)?.turnId, "delegation", { ...card, status: "asking" });
  audit(from.id, "delegation.asked", { id, to: to.id, fromThread: threadId, toThread });
  const done = nextTurn(toThread);
  // Recorded whenever it ends, also after the Chief stopped waiting.
  done.then((r) => {
    const answer = lastAgentText(toThread, r.turnId), status = r.status === "completed" ? "answered" : "failed";
    run("UPDATE delegations SET status=?, answer=?, cost_usd=?, ended_at=? WHERE id=?", status, answer, r.cost, now(), id);
    addEvent(threadId, null, "delegation", { ...card, status, answer: short(answer, 4000), cost: r.cost });
    audit(to.id, "delegation.ended", { id, status, cost: r.cost });
  });
  await sendMessage(toThread, { text: `${from.name} is asking you this for ${driver}. Answer it fully in your reply; your reply goes back to ${from.name}. Anything that needs ${driver}'s approval still comes to them as a pit stop.\n\n${question}`, trigger: "delegation", display: question });
  const r = await Promise.race([done, new Promise<null>((res) => setTimeout(() => res(null), ASK_WAIT_MS).unref())]);
  if (!r) return say(`${to.name} is still working after 10 minutes. Their answer will appear in this thread when it's ready, and in theirs: ${threadLink(toThread)}. Tell ${driver} that.`);
  const answer = lastAgentText(toThread, r.turnId);
  if (r.status !== "completed") return say(`${to.name}'s run ended ${r.status}${answer ? `. Last thing they said:\n${answer}` : ""}. Their thread: ${threadLink(toThread)}`, false);
  return say(`${to.name} answered (their thread: ${threadLink(toThread)}):\n\n${answer || "(no text reply)"}`);
}
