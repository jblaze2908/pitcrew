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
  const names = (o) => C.dynamicTools(bot, undefined, o).map((t) => t.name);
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
