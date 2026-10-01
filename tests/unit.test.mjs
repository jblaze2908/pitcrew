// Unit tests that need no Docker or network: surface validation, diffs, schedules, workspace path safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/pitcrew-test-`);
mkdirSync(`${root}/data`); process.env.PITCREW_ROOT = root; process.env.PITCREW_DATA = `${root}/data`;
const { validateSurface } = await import("../app/src/surfaces.mjs");
const { diffLines } = await import("../app/web/diff.js");
const { nextRun } = await import("../app/src/runtime.mjs");
const { execFs } = await import("../app/src/execfs.mjs");

test("surface validator rejects off-catalogue and unsafe specs", () => {
  const bad = [
    { title: "x", root: { type: "Iframe" } },
    { title: "x", root: { type: "Text", text: "hi", color: "#ff0000" } },
    { title: "x", root: { type: "Card", hue: "c4", children: [] } },
    { title: "x", root: { type: "TextField", name: "a", label: "A" } },
    { title: "x", root: { type: "Table", columns: [{ key: "a", label: "A" }], rows: Array(201).fill({ a: 1 }) } },
    { title: "", root: { type: "Divider" } },
    { title: "x", root: { type: "Receipt", text: "paid", source: "javascript:alert(1)" } },
    { title: "x", root: { type: "Form", action: "go now", children: [] } },
  ];
  for (const s of bad) assert.equal(validateSurface(s).ok, false, JSON.stringify(s));
  assert.equal(validateSurface({ title: "Bills", root: { type: "Stack", children: [{ type: "Stat", label: "Due", value: "₹2,318" }, { type: "Form", action: "pay", children: [{ type: "Money", name: "amt", label: "Amount" }] }] } }).ok, true);
});

test("line diff finds the minimal edit", () => {
  const ops = diffLines("a\nb\nc".split("\n"), "a\nB\nc\nd".split("\n"));
  assert.deepEqual(ops.map((o) => o.t + o.text), [" a", "-b", "+B", " c", "+d"]);
});

test("schedules compute in Asia/Kolkata", () => {
  const IST = 330 * 60000, from = Date.UTC(2026, 9, 1, 3, 0) - IST; // Thu 1 Oct 03:00 IST
  const at = (s) => new Date(nextRun(s, from) + IST).toISOString().slice(0, 16);
  assert.equal(at("daily 09:00"), "2026-10-01T09:00");
  assert.equal(at("daily 02:00"), "2026-10-02T02:00");
  assert.equal(at("weekly mon 08:30"), "2026-10-05T08:30");
  assert.throws(() => nextRun("every 5 minutes", from));
});

test("exec gateway fs never leaves the bot's own folder", () => {
  const base = `${root}/bots/b1/work`;
  mkdirSync(base, { recursive: true });
  writeFileSync(`${base}/AGENTS.md`, "hi");
  writeFileSync(`${root}/secret.txt`, "nope");
  symlinkSync(`${root}/secret.txt`, `${base}/link.txt`);
  assert.equal(Buffer.from(execFs("b1", "fs/readFile", { path: "file:///bot/work/AGENTS.md" }).result.dataBase64, "base64").toString(), "hi");
  assert.deepEqual(execFs("b1", "fs/getMetadata", { path: "file:///bot/work/missing" }).error.code, -32004);
  assert.equal(execFs("b1", "fs/readFile", { path: "file:///bot/work/link.txt" }).fallback, true);
  assert.equal(execFs("b1", "fs/readFile", { path: "file:///bot/work/../../secret.txt" }).fallback, true);
  assert.equal(execFs("b1", "fs/readFile", { path: "file:///etc/passwd" }).fallback, true);
  assert.equal(execFs("b1", "fs/getMetadata", { path: "file:///.git" }).error.code, -32004);
});

const R = await import("../app/src/runtime.mjs");
const { run, one } = await import("../app/src/db.mjs");

test("untitled threads are named from their first message", () => {
  assert.equal(R.titleFrom("can you access the computer?"), "Can you access the computer?");
  assert.equal(R.titleFrom("Pay my BESCOM bill. It's due Friday and the login is in my notes."), "Pay my BESCOM bill.");
  const long = R.titleFrom("please go through every invoice in the downloads folder and reconcile them against the bank statement export");
  assert.ok(long.length <= 60 && long.endsWith("…") && !/\s…$/.test(long), long);
  assert.equal(R.titleFrom("", ["uploads/k3j2-statement.pdf"]), "Shared statement.pdf");
  assert.equal(R.titleFrom("```\ncode only\n```"), R.UNTITLED);
});

test("plain link clicks are navigation; consequential links are not", () => {
  const snap = { url: "https://example.com/", lines: ['- link "Learn more" [ref=e13] [cursor=pointer]:', '- link "Unsubscribe" [ref=e14]', '- button "Next" [ref=e15]'] };
  assert.equal(R.ground(snap, "browser_click", { target: "e13" }).effect, "browse");
  assert.equal(R.ground(snap, "browser_click", { target: "e14" }).effect, "send");
  assert.equal(R.ground(snap, "browser_click", { target: "e15" }).effect, null);
  assert.equal(R.ground(snap, "browser_click", { target: "e99" }).effect, null);
});

test("decisions generalise to site + element role, never to ungrounded or pixel actions", () => {
  const g = R.ground({ url: "https://example.com/a", lines: ['- button "Next" [ref=e15]'] }, "browser_click", { target: "e15" }).grounded;
  assert.equal(R.pattern({ kind: "mcp", server: "browser", tool: "browser_click", arguments: g }), "browser:click:example.com:button");
  assert.equal(R.describePattern("browser:click:example.com:button"), "click button on example.com");
  assert.equal(R.pattern({ kind: "mcp", server: "browser", tool: "browser_click", arguments: { page_url: "https://example.com/", grounded_elements: [{ ref: "e1", element: "(not in the last snapshot)" }] } }), null);
  assert.equal(R.pattern({ kind: "mcp", server: "computer", tool: "click", arguments: { x: 1, y: 2 } }), null);
});

test("tab focus reads Playwright's tab list", () => {
  assert.deepEqual(R.readTabs("### Result\n- 0: [Example](https://example.com/)\n- 1: (current) [IANA](https://www.iana.org/)"), { count: 2, current: 1 });
  assert.deepEqual(R.readTabs("### Page\n- Page URL: https://example.com/"), { count: 1, current: 0 });
  assert.equal(R.readTabs("### Result\nclicked"), null);
});

test("two approvals in a row teach a pattern; a denial resets it; consequential effects never learn", async () => {
  run("INSERT INTO bots(id,name,created_at) VALUES('b_learn','Learner',0)");
  const last = () => one("SELECT * FROM pitstops WHERE bot_id='b_learn' AND status='pending' ORDER BY rowid DESC LIMIT 1");
  const open = (effect, by = "jev:typesafe/jev") => {
    R.pitStop({ botId: "b_learn", threadId: null, kind: "mcp", effect, title: "click", detail: { pattern: "browser:click:example.com:button" }, jev: { by } });
    return R.learnProgress(last());
  };
  const decide = (d) => R.decide(last().id, d);
  assert.deepEqual(open("browse"), { label: "click button on example.com", streak: 0, need: R.LEARN_AFTER });
  await decide("approve");
  assert.equal(open("browse").streak, 1); await decide("deny");
  assert.equal(open("browse").streak, 0); await decide("approve");
  assert.equal(open("browse").streak, 1); await decide("approve");
  assert.equal(open("browse").streak, 2); await decide("deny");
  assert.equal(open("send"), null); await decide("approve");
  assert.equal(open("browse", "fail-closed"), null); await decide("deny");
});
