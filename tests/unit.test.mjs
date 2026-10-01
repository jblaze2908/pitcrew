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
