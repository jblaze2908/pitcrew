// The Engram link against a stub of Engram's link API (node:http): settings, inbox mirror, decisions, digest, member
// tokens and Codex MCP config, profile and skills at thread start, the memory move, unlink. No Docker, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/pitcrew-engram-`);
mkdirSync(`${root}/data`);
Object.assign(process.env, { PITCREW_ROOT: root, PITCREW_DATA: `${root}/data`, PITCREW_ENGRAM_INSECURE: "1", PITCREW_JEV_SHADOW: "0" });

// ---------- the stub ----------
const LINK = "link-token-0123456789abcdef";
const E = { proposals: [], skills: [], calls: [], revoked: new Set(), decisions: [], members: [], memImports: [], artImports: [], n: 0,
  mems: {}, remembered: [], forgot: [], episodes: [], hold: false, connections: [{ id: "google", name: "Google", status: "ok", detail: "Fine", read: 6, write: 4 }],
  digest: { week: "2026-W40", from: "2026-09-28", to: "2026-10-04", built_at: Date.now(), waiting: { open: 3, held: 1 },
    runningOut: [{ date: "2026-10-20", text: "Passport renewal window", area: "home" }], changed: [{ text: "Rent went up", detail: "", tone: "bad" }],
    openLoops: [{ text: "Car insurance quote", area: "home" }], journal: [{ day: "2026-10-01", lines: ["Paid electricity"] }] } };
const memberToken = (id) => E.members.filter((m) => m.pitcrew_id === id).length ? `member-${id}-${E.n}-0123456789abcdef` : null;
const srv = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const url = new URL(req.url, "http://x"), body = raw ? JSON.parse(raw) : null;
  E.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
  const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const pid = url.searchParams.get("pitcrew_id") || body?.pitcrew_id, own = () => (E.mems[pid] ??= []);
  if (url.pathname === "/link/sync" && req.headers.authorization === `Bearer ${LINK}`)
    return send(200, { agent: `ag_${pid}`, profile: { target: "crew-chief", text: "Jai prefers short answers.\nBills are paid on the 1st.", lines: 2, budget: 80, lint: [] }, skills: E.skills,
      memories: own().map(({ id, text }) => ({ id, text })), scope: "personal", at: Date.now() });
  if (req.headers.authorization !== `Bearer ${LINK}`) return send(401, { error: "Missing or invalid token" });
  const decided = /^\/link\/inbox\/([\w-]+)$/.exec(url.pathname);
  if (req.method === "GET" && url.pathname === "/link/inbox") return send(200, { proposals: E.proposals, at: Date.now() });
  if (req.method === "POST" && decided) { E.decisions.push({ id: decided[1], ...body }); E.proposals = E.proposals.filter((p) => p.id !== decided[1]); return send(200, { ok: true }); }
  if (req.method === "GET" && url.pathname === "/link/digest") return send(200, E.digest);
  if (req.method === "POST" && url.pathname === "/link/members") {
    if (E.revoked.has(body.pitcrew_id)) return send(409, { error: "This member was revoked" });
    E.members.push(body); E.n++;
    return send(200, { agent: { id: `ag_${body.pitcrew_id}`, name: body.name, kind: "pitcrew", profile: "pitcrew-member", grants: [], skills: [], token_prefix: `eng_${E.n}`, created_at: Date.now(), revoked: false }, token: memberToken(body.pitcrew_id) });
  }
  if (req.method === "GET" && url.pathname === "/link/connections") return send(200, { connections: E.connections });
  if (req.method === "GET" && url.pathname === "/link/memories") return send(200, { scope: "personal", memories: own().map((m) => ({ ...m, scope: "personal", area: "home", created_at: 1, source: `pitcrew:${pid}` })) });
  if (req.method === "POST" && url.pathname === "/link/memories") {
    E.remembered.push(body);
    if (body.untrusted || E.hold) return send(200, { status: "held", id: `p_${E.remembered.length}`, reasons: ["Saved during a Pitcrew turn that read untrusted content"] });
    const id = `m_${E.remembered.length}`;
    E.mems[pid] = [{ id, text: body.text }, ...own().filter((m) => m.id !== body.supersedes)];
    return send(200, { status: "accepted", id, reasons: [] });
  }
  const forgot = /^\/link\/memories\/([\w-]+)\/forget$/.exec(url.pathname);
  if (req.method === "POST" && forgot) { E.forgot.push({ id: forgot[1], ...body }); E.mems[pid] = own().filter((m) => m.id !== forgot[1]); return send(200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/link/episodes") { E.episodes.push(body); return send(200, { status: "accepted", id: `j_${E.episodes.length}` }); }
  if (req.method === "POST" && url.pathname === "/link/import/memories") { E.memImports.push(body); return send(200, { accepted: body.items.length }); }
  if (req.method === "POST" && url.pathname === "/link/import/artifacts") { E.artImports.push(body); return send(200, { id: `ar_${E.artImports.length}` }); }
  send(404, { error: "Not found" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());
const calls = (path) => E.calls.filter((c) => c.path === path).length;

// ---------- Pitcrew ----------
const A = await import("../app/dist/src/auth.js");
const { run, one, all, now } = await import("../app/dist/src/db.js");
const C = await import("../app/dist/src/crew.js");
const { brainConfig, brainDir } = await import("../app/dist/src/computer.js");
const { brainMcp } = await import("../app/dist/src/engramStore.js");
const G = await import("../app/dist/src/engram.js");
const { state } = await import("../app/dist/src/api/views.js");
const { api } = await import("../app/dist/src/api/index.js");

C.ensureChief();
const bills = C.createBot(C.normaliseSpec({ name: "Bills", job: "Pays bills" }));
const diary = C.createBot(C.normaliseSpec({ name: "Diary", job: "Private notes" }));
C.updateBot(diary.id, { private: true, mcp: [{ name: "notes", url: "https://mcp.example/notes", tokenSecret: "notes_tok" }] });
C.updateBot(bills.id, { mcp: [{ name: "gh", url: "https://mcp.example/gh", tokenSecret: "gh_tok" }] });
A.putSecret("gh_tok", "ghp-upstream-secret"); A.putSecret("notes_tok", "notes-upstream-secret");

const cookie = `pc_s=${A.newSession()}`;
async function req(method, path, body) {
  const res = await api.fetch(new Request(`http://pit.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { cookie, "x-pitcrew": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) } }), { outgoing: { headersSent: false } });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

test("a crew that never links: no Engram calls, connectors as before, nothing in the instructions", async () => {
  assert.equal(state().engram.linked, false);
  await G.tick();
  assert.equal(E.calls.length, 0);
  const cfg = brainConfig(C.getBot(bills.id));
  assert.match(cfg, /\[mcp_servers\.gh\]\nurl = "https:\/\/mcp\.example\/gh"\nbearer_token_env_var = "MCP_TOKEN_GH"/);
  assert.doesNotMatch(cfg, /engram/);
  assert.equal(await G.threadContext(C.getBot("chief")), null);
  assert.doesNotMatch(C.instructions(C.getBot("chief"), []), /Engram/);
});

test("settings: a refused token saves nothing; a good one links every non-private member; the token never comes back", async () => {
  const bad = await req("PUT", "/api/engram", { url: BASE, token: "wrong-token-0123456789" });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.linked, false);
  assert.equal(bad.body.test.ok, false);
  assert.equal(A.getSecret("engram_link"), null);
  assert.equal((await req("PUT", "/api/engram", { url: "ftp://engram.example", token: LINK })).status, 400);

  const ok = await req("PUT", "/api/engram", { url: `${BASE}/`, token: LINK });
  assert.equal(ok.body.linked, true);
  assert.equal(ok.body.url, BASE);
  assert.ok(!ok.text.includes(LINK) && !ok.text.includes("member-"), "no token in the status");
  assert.deepEqual(E.members.map((m) => m.pitcrew_id).sort(), ["bills", "chief"]);
  assert.deepEqual(E.members.find((m) => m.pitcrew_id === "bills"), { pitcrew_id: "bills", name: "Bills", hue: C.getBot("bills").hue, area: null, scope: "personal" });
  const rows = Object.fromEntries(ok.body.members.map((m) => [m.id, m]));
  assert.equal(rows.chief.linked, true); assert.equal(rows.bills.agent, "ag_bills"); assert.equal(rows.diary.linked, false); assert.equal(rows.diary.private, true);
  assert.equal(A.getSecret("engram_member:diary"), null);
  const t = await req("POST", "/api/engram/test");
  assert.equal(t.body.test.ok, true);
  assert.match(t.body.test.detail, /0 open/);
  assert.equal(state().engram.linked, true);
});

const proposal = (id, extra = {}) => ({ id, kind: "memory", agent: null, title: `Proposal ${id}`, scope: "personal", area: "home", data: { text: `Text of ${id}` },
  source: { kind: "email", label: "Re: rent" }, reasons: ["Email content is never trusted on its own"], held: true, replaces: null, status: "open", created_at: Date.now(), ...extra });

test("the inbox mirror opens one pit stop per proposal, skips private and malformed ones, and closes what Engram decided", async () => {
  E.proposals = [
    proposal("p1", { replaces: { id: "m0", text: "Rent is 30k", source: { kind: "you", label: "you" } } }),
    proposal("p2", { scope: "private" }),
    proposal("p3", { agent: "ag_bills", title: "x".repeat(5000) }),
    proposal("../evil"),
  ];
  const r = await G.mirrorInbox();
  assert.equal(r.opened, 2);
  await G.mirrorInbox(); await G.tick();
  const pits = () => all("SELECT * FROM pitstops WHERE kind='engram' ORDER BY id");
  assert.deepEqual(pits().map((p) => p.id), ["eg_p1", "eg_p3"], "no duplicates across polls");
  const p1 = pits()[0], d1 = JSON.parse(p1.detail).proposal;
  assert.equal(p1.bot_id, "chief"); assert.equal(p1.effect, "engram"); assert.equal(p1.status, "pending");
  assert.deepEqual(d1.reasons, ["Email content is never trusted on its own"]);
  assert.deepEqual(d1.replaces, { text: "Rent is 30k", source: "you" });
  assert.equal(pits()[1].bot_id, "bills");
  assert.equal(pits()[1].title.length, 300);
  assert.notEqual(state().bots.find((b) => b.id === "chief").mood, "needs", "an Engram proposal doesn't make its member look stuck");
  assert.equal(state().pitstops.filter((p) => p.kind === "engram").length, 2);

  E.proposals = E.proposals.filter((p) => p.id !== "p1");
  const closed = await G.mirrorInbox();
  assert.equal(closed.closed, 1);
  const gone = one("SELECT status, note FROM pitstops WHERE id='eg_p1'");
  assert.deepEqual({ ...gone }, { status: "expired", note: "Decided in Engram" });
});

test("decisions go to Engram: Keep current, Accept, and the generic approve/deny; kill switch and batch leave them alone", async () => {
  E.proposals.push(proposal("p4"), proposal("p5"));
  await G.mirrorInbox();
  const keep = await req("POST", "/api/engram/inbox/eg_p3", { decision: "keep" });
  assert.equal(keep.body.status, "denied"); assert.equal(keep.body.note, "Kept current");
  assert.deepEqual(E.decisions.at(-1), { id: "p3", decision: "keep" });
  assert.equal((await req("POST", "/api/engram/inbox/eg_p4", { decision: "maybe" })).status, 400);
  await req("POST", "/api/pitstops/batch", { ids: ["eg_p4"], decision: "approve" });
  assert.equal(one("SELECT status FROM pitstops WHERE id='eg_p4'").status, "pending", "batch skips Engram proposals");
  const R = await import("../app/dist/src/runtime/index.js");
  await R.killSwitch(); R.resumeCrew();
  assert.equal(one("SELECT status FROM pitstops WHERE id='eg_p4'").status, "pending", "the kill switch doesn't reject memories");
  const acc = await req("POST", "/api/pitstops/eg_p4/decide", { decision: "approve" });
  assert.equal(acc.body.status, "approved");
  assert.deepEqual(E.decisions.at(-1), { id: "p4", decision: "accept" });
  await req("POST", "/api/pitstops/eg_p5/decide", { decision: "deny" });
  assert.deepEqual(E.decisions.at(-1), { id: "p5", decision: "reject" });
  await G.mirrorInbox();
  assert.equal(all("SELECT 1 FROM pitstops WHERE kind='engram' AND status='pending'").length, 0);
});

test("the digest card reads Engram's digest once an hour", async () => {
  run("DELETE FROM settings WHERE key='engram_digest'");
  const before = calls("/link/digest");
  const d = await req("GET", "/api/engram/digest");
  assert.equal(d.body.url, BASE);
  assert.equal(d.body.digest.week, "2026-W40");
  assert.deepEqual(d.body.digest.waiting, { open: 3, held: 1 });
  assert.equal(d.body.digest.changed[0].tone, "bad");
  await req("GET", "/api/engram/digest"); await G.tick();
  assert.equal(calls("/link/digest") - before, 1, "cached for the hour");
});

test("linked members run Engram as their only MCP server, with their own token; private members keep their connectors", async () => {
  const b = C.getBot("bills"), cfg = brainConfig(b);
  assert.match(cfg, new RegExp(`\\[mcp_servers\\.engram\\]\\nurl = "${BASE.replace(/[.]/g, "\\.")}/mcp"\\nbearer_token_env_var = "MCP_TOKEN_ENGRAM"`));
  assert.doesNotMatch(cfg, /mcp_servers\.gh|MCP_TOKEN_GH/);
  const servers = brainMcp(b);
  assert.deepEqual(servers.map((s) => [s.name, s.envVar]), [["engram", "MCP_TOKEN_ENGRAM"]]);
  assert.ok(!servers.some((s) => s.token === "ghp-upstream-secret"), "no upstream token reaches the brain");
  const old = A.getSecret("engram_member:bills");
  assert.equal(servers[0].token, old);
  const rot = await req("POST", "/api/engram/members/bills/rotate");
  assert.equal(rot.status, 200);
  assert.notEqual(A.getSecret("engram_member:bills"), old);
  assert.equal(brainMcp(C.getBot("bills"))[0].token, A.getSecret("engram_member:bills"));

  E.revoked.add("bills");
  const rev = await req("POST", "/api/engram/members/bills/rotate");
  assert.equal(rev.status, 409); assert.match(rev.body.error, /revoked in Engram/);
  const st = (await req("GET", "/api/engram")).body.members.find((m) => m.id === "bills");
  assert.equal(st.revoked, true); assert.equal(st.linked, false);
  assert.match(brainConfig(C.getBot("bills")), /mcp_servers\.gh/, "a revoked member falls back to its own connectors");
  const n = calls("/link/members");
  await G.ensureMemberToken(C.getBot("bills")); await G.linkMissing();
  assert.equal(calls("/link/members"), n, "never retried on its own");
  E.revoked.delete("bills");
  assert.equal((await req("POST", "/api/engram/members/bills/rotate")).status, 200);
  assert.equal(brainMcp(C.getBot("bills"))[0].name, "engram");
  const priv = brainConfig(C.getBot("diary"));
  assert.match(priv, /mcp_servers\.notes/); assert.doesNotMatch(priv, /engram/);
  assert.equal((await req("POST", "/api/engram/members/diary/rotate")).status, 400);
});

test("thread start: the Chief gets Engram's profile, every linked member its skills as names; nothing is written to disk", async () => {
  E.skills = [{ name: "pay-bills", description: "Pay the monthly bills", version: 2 },
    { name: "tidy", description: "Tidy the\ndownloads", version: 1 }, { name: "bare", version: 1 }, { name: "../up", description: "x", version: 1 }];
  const before = calls("/link/sync");
  const ctx = await G.threadContext(C.getBot("chief"));
  assert.match(ctx.profile, /Jai prefers short answers/);
  assert.deepEqual(ctx.skills, [{ name: "pay-bills", description: "Pay the monthly bills" }, { name: "tidy", description: "Tidy the downloads" }, { name: "bare", description: "" }]);
  assert.equal(existsSync(`${brainDir("chief")}/home/.agents`), false, "no skill files");
  const ins = C.instructions(C.getBot("chief"), [], { profile: ctx.profile, skills: G.skillsIndex(ctx.skills) });
  assert.match(ins, /How .* works, from Engram[^\n]*\nJai prefers short answers\./);
  assert.match(ins, /load it with the engram get tool \(id "skill:<name>"\)[^\n]*\n- pay-bills — Pay the monthly bills\n- tidy — Tidy the downloads\n- bare\n/);
  assert.equal((await G.threadContext(C.getBot("bills"))).profile, null, "only the Chief gets the profile");
  await G.threadContext(C.getBot("chief"));
  assert.equal(calls("/link/sync") - before, 2, "one sync per member per 5 minutes");
  await G.threadContext(C.getBot("chief"), true);
  assert.equal(calls("/link/sync") - before, 3, "a new thread or /refresh always syncs");
  assert.equal(await G.threadContext(C.getBot("diary")), null);
});

test("Move memories to Engram sends each linked member's memories and Library files once, and keeps Pitcrew's", async () => {
  const t0 = Date.UTC(2026, 0, 2);
  for (const [id, bot, text, at] of [["me_a", "chief", "Prefers aisle seats", t0], ["me_b", "bills", "Electricity is BESCOM", t0 + 1000], ["me_c", "diary", "Private thought", t0 + 2000]])
    run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at) VALUES(?,?,?,?,?,?)", id, bot, text, "driver", at, at);
  run("INSERT INTO memory(id,bot_id,text,source,created_at,updated_at,forgotten_at) VALUES(?,?,?,?,?,?,?)", "me_d", "bills", "Forgotten", "driver", t0, t0, t0);
  const work = (id) => `${root}/bots/${id}/work`;
  for (const d of ["out", "downloads"]) mkdirSync(`${work("bills")}/${d}`, { recursive: true });
  mkdirSync(`${work("diary")}/out`, { recursive: true });
  writeFileSync(`${work("bills")}/out/receipt-oct.pdf`, "%PDF-1.4 receipt");
  writeFileSync(`${work("bills")}/downloads/statement.csv`, "date,amount\n");
  writeFileSync(`${work("bills")}/scratch.txt`, "not in the library");
  writeFileSync(`${work("bills")}/out/huge.bin`, Buffer.alloc((6 << 20) + 1));
  writeFileSync(`${work("diary")}/out/secret.txt`, "private");

  const st = await req("POST", "/api/engram/migrate");
  assert.equal(st.body.running, true);
  await G.migrationDone();
  const sent = E.memImports.flatMap((m) => m.items.map((i) => ({ pid: m.pitcrew_id, ...i })));
  assert.deepEqual(sent, [{ pid: "chief", text: "Prefers aisle seats", created_at: t0 }, { pid: "bills", text: "Electricity is BESCOM", created_at: t0 + 1000 }]);
  assert.deepEqual(E.artImports.map((a) => [a.pitcrew_id, a.title, a.kind, a.mime]).sort(), [["bills", "receipt-oct.pdf", "receipt", "application/pdf"], ["bills", "statement.csv", "statement", "text/csv"]]);
  assert.equal(Buffer.from(E.artImports.find((a) => a.title === "receipt-oct.pdf").content_base64, "base64").toString(), "%PDF-1.4 receipt");
  const status = (await req("GET", "/api/engram")).body;
  assert.match(status.migration.line, /^Done: 2 memories and 2 files sent\.$/);
  assert.equal(status.migration.summary.find((s) => s.name === "Bills").tooBig, 1);
  assert.ok(!status.migration.summary.some((s) => s.name === "Diary"), "private members are skipped");
  assert.deepEqual(status.sent, { memories: 2, files: 2 });

  G.startMigration(); await G.migrationDone();
  assert.equal(E.memImports.length, 2, "nothing sent twice");
  assert.equal(E.artImports.length, 2);
  assert.equal(all("SELECT 1 FROM memory WHERE forgotten_at IS NULL").length, 3, "Pitcrew's memories stay");
});

test("a private member joins Engram only under Money or Health; its token carries that scope", async () => {
  const before = E.members.length;
  assert.equal((await req("PATCH", "/api/bots/diary", { engram_scope: "health" })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(E.members.slice(before).map((m) => [m.pitcrew_id, m.scope]), [["diary", "health"]]);
  assert.equal(brainMcp(C.getBot("diary"))[0].name, "engram");
  const row = (await req("GET", "/api/engram")).body.members.find((m) => m.id === "diary");
  assert.deepEqual([row.private, row.scope, row.eligible, row.linked], [true, "health", true, true]);
  await G.ensureMemberToken(C.getBot("diary"));
  assert.equal(E.members.length, before + 1, "same scope: no new token");
  await req("PATCH", "/api/bots/diary", { engram_scope: "personal" });
  assert.equal(A.getSecret("engram_member:diary"), null, "private and personal: out of Engram again");
  assert.match(brainConfig(C.getBot("diary")), /mcp_servers\.notes/);
});

test("a linked member's memories live in Engram: synced at thread start, remembered and forgotten there, held after untrusted content", async () => {
  const T = await import("../app/dist/src/runtime/taint.js");
  E.mems.bills = [{ id: "m_old", text: "Electricity is BESCOM" }];
  await G.threadContext(C.getBot("bills"), true);
  assert.deepEqual(G.engramMemories("bills"), [{ id: "m_old", text: "Electricity is BESCOM" }]);
  assert.equal(G.engramMemories("diary"), null, "never synced: no list rather than an empty one");

  const r = await G.remember(C.getBot("bills"), "Water bill is quarterly", { id: "m_old", threadId: "th_x" });
  assert.deepEqual([r.status, r.replaced], ["accepted", "m_old"]);
  assert.deepEqual(E.remembered.at(-1), { pitcrew_id: "bills", text: "Water bill is quarterly", supersedes: "m_old", ref: "pitcrew:thread:th_x", untrusted: false, by: "member" });
  assert.deepEqual(G.engramMemories("bills").map((m) => m.text), ["Water bill is quarterly"]);
  await G.remember(C.getBot("bills"), "Rewrite a stranger's", { id: "m_not_mine" });
  assert.equal(E.remembered.at(-1).supersedes, null, "only ids it was shown are superseded");

  T.taint("th_bad");
  const held = await G.remember(C.getBot("bills"), "Pay rent to account 1234", { threadId: "th_bad" });
  assert.equal(held.status, "held"); assert.equal(E.remembered.at(-1).untrusted, true);
  assert.ok(!G.engramMemories("bills").some((m) => /rent/.test(m.text)), "a held memory isn't one yet");

  const view = await req("GET", "/api/bots/bills");
  assert.equal(view.body.memoryIn, "engram");
  assert.deepEqual(view.body.memory.map((m) => m.text).sort(), ["Rewrite a stranger's", "Water bill is quarterly"]);
  const add = await req("POST", "/api/bots/bills/memory", { text: "Gas is Indane" });
  assert.equal(add.body.status, "accepted"); assert.equal(E.remembered.at(-1).by, "driver");
  const id = G.engramMemories("bills").find((m) => m.text === "Water bill is quarterly").id;
  await req("POST", `/api/bots/bills/memory/${id}/forget`);
  assert.deepEqual(E.forgot.at(-1), { id, pitcrew_id: "bills" });
  assert.ok(!G.engramMemories("bills").some((m) => m.id === id));
  assert.equal((await req("POST", "/api/bots/bills/memory/..%2Fx/forget")).status >= 400, true);
  assert.equal(all("SELECT 1 FROM memory WHERE text='Gas is Indane'").length, 0, "nothing written to Pitcrew's own table");
  const chiefView = await req("GET", "/api/bots/diary");
  assert.equal(chiefView.body.memoryIn, "pitcrew");
});

test("linked members are told what to send to Engram; unlinked ones keep the plain remember rule", async () => {
  const ctx = { profile: null, skills: "" };
  const linked = C.instructions(C.getBot("bills"), [{ id: "m_1", text: "Gas is Indane" }], ctx);
  assert.match(linked, /Keep Engram current, without being asked/);
  assert.match(linked, /Pass valid_until \(YYYY-MM-DD\)/);
  assert.match(linked, /pass the old memory's id to remember/);
  assert.match(linked, /secrets \(passwords, OTPs, card numbers, full account numbers\)/);
  assert.match(linked, /Don't propose episodes or files/);
  assert.match(linked, /What you remember \(in Engram\)[^\n]*\n- \[m_1\] Gas is Indane/);
  assert.doesNotMatch(linked, /filed under/, "Personal needs no scope line");
  assert.doesNotMatch(linked, /When .* tells you a durable fact/);
  const money = C.instructions({ ...C.getBot("bills"), engram_scope: "finance" }, [], ctx);
  assert.match(money, /with scope finance\./); assert.match(money, /filed under Money \(scope finance\), which other crew members can't read/);
  const plain = C.instructions(C.getBot("bills"), []);
  assert.match(plain, /tells you a durable fact or preference worth keeping, call remember/);
  assert.doesNotMatch(plain, /Engram/);
  assert.ok(linked.length - plain.length < 2600, `the Engram rules stay small (${linked.length - plain.length} chars)`);

  await G.remember(C.getBot("bills"), "Car insurance quote is 14,200", { validUntil: "2026-10-31" });
  assert.equal(E.remembered.at(-1).valid_until, "2026-10-31");
  await G.remember(C.getBot("bills"), "No expiry here");
  assert.equal("valid_until" in E.remembered.at(-1), false);
});

test("hiring: the connections picked go once with the first link, read-only, and the scope comes from the form", async () => {
  const conns = await req("GET", "/api/engram/connections");
  assert.deepEqual(conns.body.connections.map((c) => [c.id, c.read]), [["google", 6]]);
  const hired = await req("POST", "/api/hire", { name: "Ledger", job: "Tracks money", engram_scope: "finance", engram_connections: ["google", "BAD id", "../x"] });
  assert.equal(hired.body.engram_scope, "finance");
  for (let i = 0; i < 20 && !E.members.some((m) => m.pitcrew_id === hired.body.id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(E.members.at(-1), { pitcrew_id: hired.body.id, name: "Ledger", hue: hired.body.hue, area: null, scope: "finance", connections: ["google"] });
  assert.equal(one("SELECT 1 FROM settings WHERE key=?", `engram_hire:${hired.body.id}`), undefined, "dropped once sent");
  await req("POST", `/api/engram/members/${hired.body.id}/rotate`);
  assert.equal(E.members.at(-1).connections, undefined, "a rotate never re-sends them");
});

test("journal: an idle session becomes one entry with its thread and new Library files; never twice", async () => {
  const th = "th_ep", t = now() - 20 * 60000;
  run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", th, "bills", "Pay the October bills", t, t);
  run("INSERT INTO turns(id,thread_id,bot_id,status,trigger,provider,model,started_at,ended_at,cost_usd,changes) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    "tu_ep1", th, "bills", "completed", "driver", "openrouter", "m", t - 60000, t, 0.031, JSON.stringify([{ path: "out/receipt-nov.pdf", status: "added" }, { path: "scratch.txt", status: "modified" }]));
  run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", th, "tu_ep1", "user", JSON.stringify({ text: "Pay electricity" }), t - 60000);
  run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", th, "tu_ep1", "tool", JSON.stringify({ type: "mcpToolCall", server: "browser" }), t - 50000);
  run("INSERT INTO events(thread_id,turn_id,kind,data,ts) VALUES(?,?,?,?,?)", th, "tu_ep1", "agent", JSON.stringify({ text: "Paid ₹1,240. Receipt saved." }), t - 1000);
  writeFileSync(`${root}/bots/bills/work/out/receipt-nov.pdf`, "%PDF-1.4 november");
  const fresh = "th_busy";
  run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", fresh, "bills", "Still going", now(), now());
  run("INSERT INTO turns(id,thread_id,bot_id,status,trigger,provider,model,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?)", "tu_busy", fresh, "bills", "completed", "driver", "openrouter", "m", now() - 1000, now());
  const arts = E.artImports.length;
  await G.tick();
  assert.equal(E.episodes.length, 1, "only the session idle for 15 minutes");
  const ep = E.episodes[0];
  assert.equal(ep.pitcrew_id, "bills"); assert.equal(ep.at, t);
  assert.match(ep.text, /^Bills · Pay the October bills\nAsked: Pay electricity\nRan: 1 run · browser 1 · 2 files changed · \$0\.03\nEnded with: Paid ₹1,240\. Receipt saved\.$/);
  assert.equal(E.artImports.length, arts + 1);
  assert.equal(E.artImports.at(-1).title, "receipt-nov.pdf");
  assert.deepEqual(ep.outputs, [{ kind: "thread", ref: `pitcrew:thread:${th}`, label: "Pay the October bills" }, { kind: "artifact", ref: `ar_${E.artImports.length}`, label: "receipt-nov.pdf" }]);
  await G.tick();
  assert.equal(E.episodes.length, 1, "never twice");
});

test("unlink: tokens and Engram MCP go; open proposals close; connectors come back; polling stops", async () => {
  E.proposals = [proposal("p9")];
  await G.mirrorInbox();
  const r = await req("DELETE", "/api/engram");
  assert.equal(r.body.linked, false);
  assert.equal(A.getSecret("engram_link"), null);
  assert.equal(all("SELECT 1 FROM secrets WHERE name LIKE 'engram_member:%'").length, 0);
  assert.deepEqual({ ...one("SELECT status, note FROM pitstops WHERE id='eg_p9'") }, { status: "expired", note: "Engram unlinked" });
  assert.match(brainConfig(C.getBot("bills")), /mcp_servers\.gh/);
  const n = E.calls.length;
  await G.tick();
  assert.equal(E.calls.length, n);
  assert.equal(state().engram.linked, false);
});
