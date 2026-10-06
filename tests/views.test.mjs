// Read models the web app polls (/api/state, /api/asks, /api/learned, /api/threads): what they return, batched reads
// included. No Docker, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/pitcrew-views-`);
mkdirSync(`${root}/data`);
Object.assign(process.env, { PITCREW_ROOT: root, PITCREW_DATA: `${root}/data`, PITCREW_JEV_SHADOW: "0" });

const A = await import("../app/dist/src/auth.js");
const { run, now } = await import("../app/dist/src/db.js");
const C = await import("../app/dist/src/crew.js");
const { state } = await import("../app/dist/src/api/views.js");
const { api } = await import("../app/dist/src/api/index.js");

C.ensureChief();
const cookie = `pc_s=${A.newSession()}`;
const get = async (path) => {
  const res = await api.fetch(new Request(`http://pit.test${path}`, { headers: { cookie } }), { outgoing: { headersSent: false } });
  assert.equal(res.status, 200, path);
  return res.json();
};
const thread = (id, botId, origin = null, at = now()) => run("INSERT INTO threads(id,bot_id,title,origin,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, botId, id, origin && JSON.stringify(origin), at, at);
const say = (threadId, kind, text) => run("INSERT INTO events(thread_id,kind,data,ts) VALUES(?,?,?,?)", threadId, kind, JSON.stringify({ text }), now());

test("state: each member's mood and week spend come from its own runs", () => {
  const a = C.createBot(C.normaliseSpec({ name: "Alpha", job: "a" })), b = C.createBot(C.normaliseSpec({ name: "Beta", job: "b" }));
  thread("th_va", a.id); thread("th_vb", b.id);
  run("INSERT INTO turns(id,thread_id,bot_id,status,started_at,cost_usd) VALUES('tu_va1','th_va',?, 'completed', ?, 0.25), ('tu_va2','th_va',?, 'failed', ?, 0.5), ('tu_vb1','th_vb',?, 'completed', ?, 1)",
    a.id, now() - 2000, a.id, now() - 1000, b.id, now() - 500);
  const S = state(), card = (id) => S.bots.find((x) => x.id === id);
  assert.equal(card(a.id).mood, "failed", "the newest run decides");
  assert.equal(card(b.id).mood, "sleep", "a finished run on a sleeping computer");
  assert.equal(card(a.id).spend, 0.75);
  assert.equal(card(b.id).spend, 1);
  assert.equal(card("chief").spend, 0);
});

test("/api/asks: the newest routed threads with their last answer and plan progress", async () => {
  thread("th_ask1", "chief", { kind: "routed", by: "named" }, now() - 10); thread("th_ask2", "chief", { kind: "routed", by: "router" }, now());
  say("th_ask1", "agent", "first answer"); say("th_ask1", "user", "more?"); say("th_ask1", "agent", "final answer");
  run("INSERT INTO plans(id,thread_id,goal,constraints,status,budget_usd,created_at) VALUES('pl_old','th_ask1','g','[]','done',1,1), ('pl_new','th_ask1','g','[]','running',1,2)");
  run("INSERT INTO plan_items(id,plan_id,seq,key,owner_bot,task,after,status) VALUES('pi1','pl_new',0,'a','chief','t','[]','done'), ('pi2','pl_new',1,'b','chief','t','[]','doing'), ('pi3','pl_new',2,'c','x','t','[]','cancelled'), ('pi4','pl_old',0,'a','y','t','[]','done')");
  const asks = await get("/api/asks"), one = asks.find((x) => x.id === "th_ask1"), two = asks.find((x) => x.id === "th_ask2");
  assert.deepEqual(asks.slice(0, 2).map((x) => x.id), ["th_ask2", "th_ask1"]);
  assert.equal(one.answer, "final answer");
  assert.deepEqual(one.plan, { status: "running", members: ["chief"], done: 1, total: 2 }, "the latest plan, cancelled items left out");
  assert.equal(two.answer, null);
  assert.equal("plan" in two, false, "no plan, no key");
});

test("/api/learned shows only patterns the member's policy still allows", async () => {
  const m = C.createBot(C.normaliseSpec({ name: "Learner", job: "l" }));
  C.updateBot(m.id, { policy: { send: "allow" } });
  run("INSERT INTO learned(bot_id,pattern,effect,label,approvals,updated_at) VALUES(?,?,?,?,?,?), (?,?,?,?,?,?)", m.id, "p_send", "send", "s", 2, now(), m.id, "p_pay", "pay", "p", 2, now());
  const rows = (await get("/api/learned")).filter((l) => l.bot_id === m.id);
  assert.deepEqual(rows.map((l) => l.pattern), ["p_send"]);
});

test("/api/threads: each row's snippet is its last message, past later tool events", async () => {
  const m = C.createBot(C.normaliseSpec({ name: "Lister", job: "l" }));
  thread("th_ls", m.id);
  say("th_ls", "user", "hello"); say("th_ls", "agent", "**done** it");
  run("INSERT INTO events(thread_id,kind,data,ts) VALUES('th_ls','tool','{}',?)", now());
  const page = await get(`/api/threads?bot=${m.id}`), row = [...page.pinned, ...page.rows].find((r) => r.id === "th_ls");
  assert.equal(row.snippet, "done it");
});

test("India-time day and week starts the totals use, and the clock notes show", async () => {
  const U = await import("../app/dist/src/runtime/util.js"), Sp = await import("../app/dist/src/runtime/spend.js");
  const t = Date.parse("2026-10-07T20:00:00Z"); // Thu 8 Oct, 01:30 IST
  assert.equal(U.istDayAt(t), Date.parse("2026-10-07T18:30:00Z"));
  assert.equal(U.istDayAt(t, 9, 15), Date.parse("2026-10-08T03:45:00Z"));
  assert.equal(Sp.weekStart(t), Date.parse("2026-10-04T18:30:00Z"), "Monday 5 Oct, 00:00 IST");
  assert.equal(Sp.weekStart(Date.parse("2026-10-04T18:30:00Z")), Date.parse("2026-10-04T18:30:00Z"), "Monday midnight starts its own week");
  assert.equal(U.istClock(t), "01:30");
  assert.equal(U.istStamp(t), "2026-10-08 01:30");
});

test("creating or editing a schedule never returns its webhook secret; the hook route does", async () => {
  const m = C.createBot(C.normaliseSpec({ name: "Hooked", job: "h" }));
  const send = async (method, path, body) => {
    const res = await api.fetch(new Request(`http://pit.test${path}`, { method, body: JSON.stringify(body), headers: { cookie, "x-pitcrew": "1", "content-type": "application/json" } }), { outgoing: { headersSent: false } });
    assert.equal(res.status, 200, path); return res.json();
  };
  const made = await send("POST", `/api/bots/${m.id}/schedules`, { spec: "on event", prompt: "Sort the new invoice", check: "ls" });
  assert.equal("hook_secret" in made, false); assert.equal("check_last" in made, false);
  const edited = await send("PATCH", `/api/schedules/${made.id}`, { prompt: "Sort every new invoice" });
  assert.equal(edited.prompt, "Sort every new invoice");
  assert.equal("hook_secret" in edited, false); assert.equal("check_last" in edited, false);
  const hook = await get(`/api/schedules/${made.id}/hook`);
  assert.ok(hook.secret && hook.secret.length >= 16, "the driver still reads it from the hook route");
});

test("/api/bots/:id/changes?thread= reaches a thread's older runs past the member's 40 newest", async () => {
  const m = C.createBot(C.normaliseSpec({ name: "Changer", job: "c" }));
  thread("th_ch_old", m.id); thread("th_ch_busy", m.id);
  const ch = JSON.stringify([{ path: "a.txt", status: "added" }]);
  run("INSERT INTO turns(id,thread_id,bot_id,status,started_at,changes) VALUES(?,?,?,?,?,?)", "tu_ch_old", "th_ch_old", m.id, "completed", 1, ch);
  for (let i = 0; i < 41; i++) run("INSERT INTO turns(id,thread_id,bot_id,status,started_at,changes) VALUES(?,?,?,?,?,?)", `tu_ch_${i}`, "th_ch_busy", m.id, "completed", 100 + i, ch);
  assert.equal((await get(`/api/bots/${m.id}/changes`)).some((r) => r.id === "tu_ch_old"), false);
  assert.deepEqual((await get(`/api/bots/${m.id}/changes?thread=th_ch_old`)).map((r) => r.id), ["tu_ch_old"]);
});

test("a stored schedule whose spec no longer parses is switched off, not thrown out of the tick", async () => {
  const { tickSchedules } = await import("../app/dist/src/runtime/schedules.js");
  const { one } = await import("../app/dist/src/db.js");
  run("INSERT INTO schedules(id,bot_id,spec,prompt,next_run,enabled,created_at) VALUES(?,?,?,?,?,1,?)", "sc_stale", "chief", "every 5 minutes", "x", now() - 1000, now());
  assert.doesNotThrow(() => tickSchedules());
  assert.equal(one("SELECT enabled FROM schedules WHERE id=?", "sc_stale").enabled, 0);
});
