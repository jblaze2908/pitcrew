// Settings over the HTTP API: the "New threads start in" default and where it applies. No Docker, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/pitcrew-settings-`);
mkdirSync(`${root}/data`);
Object.assign(process.env, { PITCREW_ROOT: root, PITCREW_DATA: `${root}/data`, PITCREW_JEV_SHADOW: "0" });

const A = await import("../app/dist/src/auth.js");
const { one } = await import("../app/dist/src/db.js");
const C = await import("../app/dist/src/crew.js");
const { state } = await import("../app/dist/src/api/views.js");
const { api } = await import("../app/dist/src/api/index.js");
const { newThreadAutonomy } = await import("../app/dist/src/runtime/autonomy.js");

C.ensureChief();
const bills = C.createBot(C.normaliseSpec({ name: "Bills", job: "Pays bills" }));
const cookie = `pc_s=${A.newSession()}`;
async function req(method, path, body) {
  const res = await api.fetch(new Request(`http://pit.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { cookie, "x-pitcrew": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) } }), { outgoing: { headersSent: false } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const modeOf = (id) => one("SELECT autonomy FROM threads WHERE id=?", id).autonomy;
const newThread = async () => (await req("POST", "/api/threads", { botId: bills.id, title: "Try" })).body.id;

test("new threads start in Ask first until the driver picks another mode", async () => {
  assert.equal(state().newThreadMode, "ask");
  assert.equal(modeOf(await newThread()), "ask");
});

test("New threads start in: saved in settings, applied to threads the driver starts, junk ignored", async () => {
  const r = await req("PATCH", "/api/settings", { newThreadMode: "handsfree" });
  assert.equal(r.status, 200); assert.equal(r.body.newThreadMode, "handsfree");
  assert.equal(modeOf(await newThread()), "handsfree");
  assert.equal((await req("PATCH", "/api/settings", { newThreadMode: "yolo" })).body.newThreadMode, "yolo");
  const t = await newThread();
  assert.equal(modeOf(t), "yolo");
  // A continuation is a new thread too.
  assert.equal(modeOf((await req("POST", `/api/threads/${t}/fresh`)).body.id), "yolo");
  assert.equal((await req("PATCH", "/api/settings", { newThreadMode: "everything" })).body.newThreadMode, "yolo", "an unknown mode is ignored");
  assert.equal((await req("PATCH", "/api/settings", { plainVoice: true })).body.newThreadMode, "yolo", "other settings leave it alone");
  // Each thread keeps its own mode when the default changes later.
  await req("PATCH", "/api/settings", { newThreadMode: "ask" });
  assert.equal(modeOf(t), "yolo");
  assert.equal(newThreadAutonomy(), "ask");
});

test("threads Pitcrew opens itself (pinned at hire) keep Ask first whatever the default", async () => {
  await req("PATCH", "/api/settings", { newThreadMode: "yolo" });
  const helper = C.createBot(C.normaliseSpec({ name: "Helper", job: "Helps" }));
  assert.equal(one("SELECT autonomy FROM threads WHERE bot_id=? AND pinned=1", helper.id).autonomy, "ask");
  await req("PATCH", "/api/settings", { newThreadMode: "ask" });
});

test("the mail relay secret comes only from its own signed-in endpoint", async () => {
  const mail = await req("GET", "/api/mail");
  assert.equal(mail.status, 200); assert.equal(JSON.stringify(mail.body).includes("secret"), false);
  const s = await req("GET", "/api/mail/secret");
  assert.equal(s.status, 200); assert.ok(s.body.secret.length >= 16);
  const anon = await api.fetch(new Request("http://pit.test/api/mail/secret", { headers: { "x-pitcrew": "1" } }), { outgoing: { headersSent: false } });
  assert.equal(anon.status, 401);
});
