// Images: generate_image against a stubbed OpenRouter, Codex image_gen items, and where both land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/pitcrew-img-`);
mkdirSync(`${root}/data`); Object.assign(process.env, { PITCREW_ROOT: root, PITCREW_DATA: `${root}/data` });
const A = await import("../app/dist/src/auth.js");
const I = await import("../app/dist/src/images.js");
const C = await import("../app/dist/src/crew.js");
const CT = await import("../app/dist/src/crewTools.js");
const { dynamicTool } = await import("../app/dist/src/runtime/tools.js");
const { onNotify } = await import("../app/dist/src/runtime/notify.js");
const { active, byCodex } = await import("../app/dist/src/runtime/state.js");
const { run, all, one, now } = await import("../app/dist/src/db.js");
const { paintings } = await import("../app/dist/src/runtime/painting.js");
let during = null;

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const MODELS = { data: [
  { id: "google/gemini-3.1-flash-image", name: "Nano Banana 2", supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] }, resolution: { type: "enum", values: ["1K", "2K"] }, n: { type: "range", min: 1, max: 1 }, input_references: { type: "range", min: 0, max: 14 } } },
  { id: "openai/gpt-image-2", name: "GPT Image 2", supported_parameters: { quality: { type: "enum", values: ["auto", "low", "high"] }, n: { type: "range", min: 1, max: 10 }, input_references: { type: "range", min: 0, max: 16 } } },
  { id: "recraft/recraft-v3", name: "Recraft", supported_parameters: { n: { type: "range", min: 1, max: 6 } } },
] };
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith("/images/models")) return new Response(JSON.stringify(MODELS));
  const body = JSON.parse(init.body); sent.push({ url: String(url), auth: init.headers.Authorization, body }); during = paintings("th_img");
  if (body.prompt === "refuse") return new Response(JSON.stringify({ error: { message: "content policy" } }), { status: 400 });
  return new Response(JSON.stringify({ data: Array.from({ length: body.n || 1 }, () => ({ b64_json: PNG.toString("base64"), media_type: "image/png" })), usage: { cost: 0.04 } }));
};

const bot = C.createBot(C.normaliseSpec({ name: "Artist", job: "Makes pictures" }));
const work = `${root}/bots/${bot.id}/work`;
mkdirSync(`${work}/uploads`, { recursive: true });
writeFileSync(`${work}/uploads/cat.png`, PNG);
writeFileSync(`${root}/outside.png`, PNG);

test("generate_image needs an OpenRouter key and only gets the tool with one", async () => {
  await assert.rejects(I.generateImage(bot.id, { prompt: "a cat" }), /OpenRouter key/);
  const names = (o) => CT.dynamicTools(bot, undefined, o).map((t) => t.name);
  assert.ok(names({ images: true }).includes("generate_image"));
  assert.ok(!names({}).includes("generate_image"));
  A.putSecret("openrouter", "sk-or-test");
});

test("options are checked against the model's own parameters before anything is sent", async () => {
  const n = sent.length;
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", model: "nope/model" }), /No image model nope\/model/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", aspect_ratio: "4:3" }), /aspect_ratio must be one of 1:1, 16:9/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", quality: "high" }), /doesn't take quality/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", model: "openai/gpt-image-2", n: 6 }), /n is at most 4/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", model: "recraft/recraft-v3", images: ["uploads/cat.png"] }), /can't take input images/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", images: ["/bot/work/../../outside.png"] }), /outside \/bot\/work/);
  await assert.rejects(I.generateImage(bot.id, { prompt: "x", images: ["uploads/missing.png"] }), /No image at/);
  assert.equal(sent.length, n, "nothing reached OpenRouter");
});

test("an edit sends the workspace image and saves results to out/images without clobbering", async () => {
  const r = await I.generateImage(bot.id, { prompt: "Make the cat wear a tiny hat", images: ["/bot/work/uploads/cat.png"], aspect_ratio: "1:1" });
  const req = sent.at(-1);
  assert.equal(req.auth, "Bearer sk-or-test");
  assert.equal(req.body.model, I.DEFAULT_IMAGE_MODEL);
  assert.equal(req.body.aspect_ratio, "1:1");
  assert.match(req.body.input_references[0].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(r.paths, ["out/images/make-the-cat-wear-a-tiny.png"]);
  assert.equal(r.cost, 0.04);
  assert.deepEqual(readFileSync(`${work}/${r.paths[0]}`), PNG);
  const again = await I.generateImage(bot.id, { prompt: "Make the cat wear a tiny hat", model: "openai/gpt-image-2", n: 2 });
  assert.deepEqual(again.paths, ["out/images/make-the-cat-wear-a-tiny-2.png", "out/images/make-the-cat-wear-a-tiny-3.png"]);
  await assert.rejects(I.generateImage(bot.id, { prompt: "refuse" }), /OpenRouter said 400: content policy/);
});

test("the tool posts the images to the thread and bills the turn", async () => {
  const th = "th_img";
  run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", th, bot.id, "Pics", now(), now());
  active.set(th, { turnId: "tu_img" });
  const r = await dynamicTool({ bot: { id: bot.id }, mems: new Map() }, th, { tool: "generate_image", arguments: { prompt: "A lighthouse at dusk", name: "lighthouse" }, threadId: th });
  assert.equal(r.success, true);
  assert.match(r.contentItems[0].text, /\/bot\/work\/out\/images\/lighthouse\.png/);
  const ev = JSON.parse(one("SELECT data FROM events WHERE thread_id=? AND kind='image'", th).data);
  assert.deepEqual(ev.paths, ["out/images/lighthouse.png"]);
  assert.equal(ev.cost, 0.04);
  assert.equal(active.get(th).extraUsd, 0.04);
  assert.equal(during.length, 1, "the thread shows a wait while the image is made");
  assert.deepEqual(during[0].palette.slice(0, 1), ["#ff6fab"], "a brief with no colour words paints in crew hues");
  assert.equal(ev.paintingId, during[0].id, "the image that lands names the wait it ends");
  assert.equal(paintings(th).length, 0, "the wait ends when the image lands");
  run("UPDATE bots SET weekly_cap_usd=0 WHERE id=?", bot.id);
  const capped = await dynamicTool({ bot: { id: bot.id }, mems: new Map() }, th, { tool: "generate_image", arguments: { prompt: "another" }, threadId: th });
  assert.equal(capped.success, false);
  assert.match(capped.contentItems[0].text, /spending cap/);
});

test("the wait paints in the brief's colours", () => {
  assert.deepEqual(I.paletteFor("Marigold lamps on a navy night, rangoli in pink").slice(0, 4), ["#f2a93b", "#4f7dff", "#ff6fab", "#2b2b33"]);
});

test("Codex image_gen results are saved to out/images and shown; a used-up plan limit says so", () => {
  const th = "th_codex_img";
  run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", th, bot.id, "Plan pics", now(), now());
  byCodex.set("cx_img", th); active.set(th, { turnId: "tu_cx" });
  const br = { bot: { id: bot.id } };
  onNotify(br, "item/completed", { threadId: "cx_img", item: { type: "imageGeneration", id: "ig_1", status: "completed", revisedPrompt: "A red bicycle", result: PNG.toString("base64"), failure: null } });
  onNotify(br, "item/completed", { threadId: "cx_img", item: { type: "imageGeneration", id: "ig_2", status: "failed", revisedPrompt: null, result: "", failure: { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: null } } });
  const evs = all("SELECT kind, data FROM events WHERE thread_id=? ORDER BY id", th).map((e) => ({ kind: e.kind, ...JSON.parse(e.data) }));
  assert.equal(evs[0].kind, "image");
  assert.deepEqual(evs[0].paths, ["out/images/a-red-bicycle.png"]);
  assert.ok(existsSync(`${work}/out/images/a-red-bicycle.png`));
  assert.equal(evs[1].status, "failed");
  assert.match(evs[1].error, /image limit is used up/);
});

test("an edit message names the image, the marks and how to call the tool; paths stay in the workspace", () => {
  writeFileSync(`${work}/uploads/m-mask.png`, PNG); writeFileSync(`${work}/uploads/m-marked.png`, PNG);
  const brushed = I.editMessage(bot.id, "Make the date gold", { image: "out/images/lighthouse.png", mask: "uploads/m-mask.png", marked: "uploads/m-marked.png", pins: [{ x: 0.5, y: 0.05, note: "Add Lakeview Towers" }], model: "plan" });
  assert.match(brushed.text, /\[Edit of \/bot\/work\/out\/images\/lighthouse\.png\]/);
  assert.match(brushed.text, /Pin 1 \(top centre\): Add Lakeview Towers/);
  assert.match(brushed.text, /generate_image with images \[\/bot\/work\/out\/images\/lighthouse\.png, \/bot\/work\/uploads\/m-marked\.png\], mask \/bot\/work\/uploads\/m-mask\.png, model google\/gemini-3\.1-flash-image/, "a mask can't go to the plan's image_gen");
  assert.deepEqual(brushed.attachments, ["uploads/m-marked.png"], "the member sees the marked copy");
  const plan = I.editMessage(bot.id, "Warmer lamps", { image: "out/images/lighthouse.png", model: "plan", pins: [] });
  assert.match(plan.text, /image_gen with referenced_image_paths \[\/bot\/work\/out\/images\/lighthouse\.png\]/);
  const chat = I.editMessage(bot.id, "Bigger date", { image: "/bot/work/out/images/lighthouse.png" });
  assert.equal(chat.text, "Bigger date\n\n[Editing image /bot/work/out/images/lighthouse.png]");
  assert.equal(I.editTarget(chat.text), "/bot/work/out/images/lighthouse.png");
  assert.throws(() => I.editMessage(bot.id, "x", { image: "../../outside.png" }), /outside \/bot\/work/);
});

test("versions: an edit's image names its parent, whichever tool made it", async () => {
  const th = "th_img";
  run("UPDATE bots SET weekly_cap_usd=10 WHERE id=?", bot.id);
  active.set(th, { turnId: "tu_v" });
  await dynamicTool({ bot: { id: bot.id }, mems: new Map() }, th, { tool: "generate_image", arguments: { prompt: "Gold date", images: ["/bot/work/out/images/lighthouse.png"], name: "lighthouse-v2" }, threadId: th });
  const v2 = JSON.parse(one("SELECT data FROM events WHERE thread_id=? AND kind='image' ORDER BY id DESC LIMIT 1", th).data);
  const v1 = one("SELECT id FROM images WHERE path='out/images/lighthouse.png'").id;
  assert.equal(v2.parentId, v1);
  assert.equal(one("SELECT parent_id p FROM images WHERE id=?", v2.ids[0]).p, v1);
  // Codex's image_gen has no arguments to read: the turn's "[Editing image …]" target is the parent.
  byCodex.set("cx_v", th); active.set(th, { turnId: "tu_v3", editOf: "/bot/work/out/images/lighthouse-v2.png" });
  onNotify({ bot: { id: bot.id } }, "item/completed", { threadId: "cx_v", item: { type: "imageGeneration", id: "ig_v3", status: "completed", revisedPrompt: "Lighthouse v3", result: PNG.toString("base64"), failure: null } });
  const v3 = JSON.parse(one("SELECT data FROM events WHERE thread_id=? AND kind='image' ORDER BY id DESC LIMIT 1", th).data);
  assert.equal(v3.parentId, v2.ids[0]);
});

test("a masked edit that can't be pasted back keeps the model's whole image and says so", async () => {
  const th = "th_img"; active.set(th, { turnId: "tu_m" });
  const r = await dynamicTool({ bot: { id: bot.id }, mems: new Map() }, th, { tool: "generate_image", arguments: { prompt: "Gold date", images: ["out/images/lighthouse.png", "uploads/m-marked.png"], mask: "uploads/m-mask.png", name: "masked" }, threadId: th });
  assert.equal(r.success, true);
  assert.match(r.contentItems[0].text, /could not be kept as it was/);
  const ev = JSON.parse(one("SELECT data FROM events WHERE thread_id=? AND kind='image' ORDER BY id DESC LIMIT 1", th).data);
  assert.equal(ev.pasted.ok, false);
  const bad = await dynamicTool({ bot: { id: bot.id }, mems: new Map() }, th, { tool: "generate_image", arguments: { prompt: "x", mask: "uploads/m-mask.png" }, threadId: th });
  assert.match(bad.contentItems[0].text, /mask needs the image/);
});

test("the thread reads an edit message back: the version, the marks, the pins and the model", async () => {
  const { editOf } = await import("../app/dist/shared/edits.js");
  const brushed = I.editMessage(bot.id, "Make the date gold", { image: "out/images/lighthouse.png", mask: "uploads/m-mask.png", marked: "uploads/m-marked.png", pins: [{ x: 0.5, y: 0.05, note: "Add Lakeview Towers" }, { x: 0.2, y: 0.8, note: "" }] });
  assert.deepEqual(editOf(brushed.text), { image: "out/images/lighthouse.png", typed: "Make the date gold", marked: "uploads/m-marked.png", brushed: true, pins: ["Add Lakeview Towers", ""], model: "Nano Banana 2" });
  const plan = editOf(I.editMessage(bot.id, "", { image: "out/images/lighthouse.png", model: "plan", pins: [] }).text);
  assert.equal(plan.typed, ""); assert.equal(plan.model, "ChatGPT plan"); assert.equal(plan.brushed, false);
  assert.deepEqual(editOf(I.editMessage(bot.id, "Bigger date", { image: "/bot/work/out/images/lighthouse.png" }).text), { image: "out/images/lighthouse.png", typed: "Bigger date", marked: null, brushed: false, pins: [], model: null });
  assert.equal(editOf("Just a message"), null);
});

test("saving an image never goes through a linked out/ folder", async () => {
  const { symlinkSync, readdirSync } = await import("node:fs");
  mkdirSync(`${root}/bots/b_imglink/work`, { recursive: true }); mkdirSync(`${root}/img_outside`);
  symlinkSync(`${root}/img_outside`, `${root}/bots/b_imglink/work/out`);
  assert.throws(() => I.saveImage("b_imglink", PNG, "png", "sneaky"), /isn.t a folder/);
  assert.deepEqual(readdirSync(`${root}/img_outside`), []);
});
