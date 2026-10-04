// Images: generate_image (any OpenRouter image model, with edits from workspace images) and the store both it and
// Codex's own image_gen write to: /bot/work/out/images, so every image lands in the Library and can be edited again.
import { execFile } from "node:child_process";
import { mkdirSync, chownSync, chmodSync, writeFileSync, existsSync, realpathSync, statSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { extname, posix } from "node:path";
import { getSecret } from "./auth.js";
import { botDir, ROOT, BRAIN } from "./computer.js";
import { one, run, now, uid } from "./db.js";

const API = "https://openrouter.ai/api/v1";
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image";
const IN_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const OUT_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
const IN_MAX = 20 << 20;
const PARAMS = ["aspect_ratio", "resolution", "quality", "background", "output_format", "n"] as const;

type Spec = { type: "enum"; values: (string | number)[] } | { type: "range"; min: number; max: number } | { type: "boolean" };
export interface ImageModel { id: string; name: string; params: Record<string, Spec> }
let catalog: { at: number; models: ImageModel[] } = { at: 0, models: [] };

/** OpenRouter's image models with the parameters each takes; one fetch per 6 h, the last good list if it fails. */
export async function imageModels(): Promise<ImageModel[]> {
  if (Date.now() - catalog.at < 6 * 3600 * 1000 && catalog.models.length) return catalog.models;
  try {
    const r = await fetch(`${API}/images/models`, { signal: AbortSignal.timeout(15000) });
    const body: any = await r.json();
    const models = (body.data || []).map((m: any) => ({ id: String(m.id), name: String(m.name || m.id), params: m.supported_parameters || {} }));
    if (models.length) catalog = { at: Date.now(), models };
  } catch {}
  return catalog.models;
}

// Paint for the wait (catch the paint): colours named in the brief, else the crew's hues. Pure string work, per call.
const COLOURS: [RegExp, string][] = [[/\b(red|crimson|scarlet)\b/, "#e5484d"], [/\b(maroon|burgundy|wine)\b/, "#8e2a3b"], [/\b(orange|saffron|marigold|amber)\b/, "#f2a93b"],
  [/\b(gold|golden|yellow|mustard)\b/, "#f2c94c"], [/\b(green|emerald|leaf|forest)\b/, "#2fcc80"], [/\b(mint|sage|olive)\b/, "#9ccf9a"], [/\b(teal|turquoise|cyan|aqua)\b/, "#16c2c2"],
  [/\b(blue|navy|cobalt|sky)\b/, "#4f7dff"], [/\b(indigo|purple|violet|lavender)\b/, "#9577ff"], [/\b(pink|magenta|rose|rangoli)\b/, "#ff6fab"],
  [/\b(brown|coffee|chocolate|wood)\b/, "#9a6b4f"], [/\b(cream|beige|ivory|white|snow)\b/, "#f4ecdc"], [/\b(black|night|dark|charcoal)\b/, "#2b2b33"], [/\b(grey|gray|silver|steel)\b/, "#a9a9b4"]];
export function paletteFor(prompt: string) {
  const p = prompt.toLowerCase(), found = COLOURS.filter(([re]) => re.test(p)).map(([, c]) => c);
  return [...new Set([...found, "#ff6fab", "#4f7dff", "#16c2c2", "#9577ff", "#2fcc80"])].slice(0, Math.max(4, Math.min(found.length, 6)));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "") || "image";

/** Writes one image to out/images under a name that doesn't clobber another; returns its path under /bot/work. */
export function saveImage(botId: string, buf: Buffer, ext: string, hint: string) {
  const work = `${botDir(botId)}/work`, dir = `${work}/out/images`, o = statSync(work); // owned like the workspace (the crew user)
  for (const d of [`${work}/out`, dir]) if (!existsSync(d)) { mkdirSync(d); chownSync(d, o.uid, o.gid); }
  const base = slug(hint);
  let name = `${base}.${ext}`;
  for (let i = 2; existsSync(`${dir}/${name}`); i++) name = `${base}-${i}.${ext}`;
  writeFileSync(`${dir}/${name}`, buf, { flag: "wx" });
  chownSync(`${dir}/${name}`, o.uid, o.gid);
  return `out/images/${name}`;
}

/** A path under /bot/work (absolute or relative) as its relative form, or null when it points outside. */
export const workRel = (p: string) => { const rel = posix.relative("/bot/work", posix.resolve("/bot/work", p)); return rel && !rel.startsWith("..") ? rel : null; };
/** A workspace image on the host, confined to the member's /bot/work. */
function imageFile(botId: string, p: string) {
  const rel = workRel(p);
  if (!rel) throw new Error(`${p} is outside /bot/work`);
  const type = IN_TYPES[extname(rel).toLowerCase()];
  if (!type) throw new Error(`${p} isn't an image (png, jpg, webp or gif)`);
  let full: string;
  try { const base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(`${base}/${rel}`); if (!full.startsWith(base + "/")) throw 0; }
  catch { throw new Error(`No image at ${p}`); }
  if (statSync(full).size > IN_MAX) throw new Error(`${p} is over 20 MB`);
  return { rel, full, type };
}
function inputImage(botId: string, p: string) {
  const f = imageFile(botId, p);
  return { type: "image_url", image_url: { url: `data:${f.type};base64,${readFileSync(f.full).toString("base64")}` } };
}

// ---------- versions: every saved image is a row; an edit names the version it came from ----------
export function recordImage(botId: string, threadId: string | null, path: string, o: { parentId?: string | null; model?: string | null; cost?: number | null } = {}) {
  const id = uid("im");
  run("INSERT INTO images(id,bot_id,thread_id,path,parent_id,model,cost,created_at) VALUES(?,?,?,?,?,?,?,?)", id, botId, threadId, path, o.parentId ?? null, o.model ?? null, o.cost ?? null, now());
  return id;
}
/** The newest row for a workspace path (a path can be overwritten by a later image of the same name only via paste-back, which keeps its row). */
export const imageAt = (botId: string, p: string | null | undefined) => { const rel = p ? workRel(p) : null; return rel ? one<{ id: string }>("SELECT id FROM images WHERE bot_id=? AND path=? ORDER BY created_at DESC LIMIT 1", botId, rel)?.id ?? null : null; };

// A message that edits an image says so with this marker (built by editMessage); a turn started by it records the parent.
const EDIT_MARK = /\[(?:Edit of|Editing image) (\/bot\/work\/[^\]\s]+)\]/;
export const editTarget = (text: string) => EDIT_MARK.exec(text)?.[1] ?? null;

// ---------- paste-back: keep everything outside the brushed mask as it was ----------
// ImageMagick runs in the brain container (up during every turn; the app image has none). Two docker execs per edit.
const im = (args: string[]) => new Promise<{ ok: boolean; out: string }>((res) =>
  execFile("docker", ["exec", BRAIN, ...args], { timeout: 60000, maxBuffer: 1 << 20 }, (e, out) => res({ ok: !e, out: String(out || "") })));
export async function pasteBack(botId: string, base: string, edited: string, mask: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const job = uid("pb"), dir = `${ROOT}/brains/_paste/${job}`, inC = `/brains/_paste/${job}`, ext = extname(edited).slice(1).toLowerCase() || "png";
  const b = imageFile(botId, base), e = imageFile(botId, edited), m = imageFile(botId, mask);
  mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o777);
  try {
    for (const [from, name] of [[b.full, "base"], [e.full, "new"], [m.full, "mask"]]) { copyFileSync(from, `${dir}/${name}`); chmodSync(`${dir}/${name}`, 0o644); }
    const id = await im(["identify", "-format", "%w %h\\n", `${inC}/base[0]`, `${inC}/new[0]`]);
    const [bw, bh, nw, nh] = id.out.trim().split(/\s+/).map(Number);
    if (!id.ok || !bw || !nw) return { ok: false, why: "couldn't read the images" };
    if (Math.abs(bw / bh - nw / nh) > 0.03 * (bw / bh)) return { ok: false, why: "the model changed the image's shape" };
    const r = await im(["convert", `${inC}/base[0]`, "(", `${inC}/new[0]`, "-resize", `${bw}x${bh}!`, ")", "(", `${inC}/mask[0]`, "-colorspace", "gray", "-resize", `${bw}x${bh}!`, "-blur", "0x6", ")", "-composite", `${inC}/out.${ext}`]);
    if (!r.ok || !existsSync(`${dir}/out.${ext}`)) return { ok: false, why: "ImageMagick failed" };
    const o = statSync(e.full);
    writeFileSync(e.full, readFileSync(`${dir}/out.${ext}`)); chownSync(e.full, o.uid, o.gid);
    return { ok: true };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- edit requests from the driver (the thread's edit panel and its "Editing" chip) ----------
export interface EditRequest { image: string; mask?: string | null; marked?: string | null; pins?: { x: number; y: number; note: string }[]; model?: string | null }
const where = (x: number, y: number) => `${y < 0.34 ? "top" : y > 0.66 ? "bottom" : "middle"} ${x < 0.34 ? "left" : x > 0.66 ? "right" : "centre"}`.replace("middle centre", "centre");
/** Text the member gets for an edit, and the attachments that go with it. Paths are checked against the workspace. */
export function editMessage(botId: string, typed: string, r: EditRequest) {
  const img = imageFile(botId, r.image).rel, abs = (rel: string) => `/bot/work/${rel}`;
  const mask = r.mask ? imageFile(botId, r.mask).rel : null, marked = r.marked ? imageFile(botId, r.marked).rel : null;
  const pins = (r.pins || []).slice(0, 9).map((p, i) => `Pin ${i + 1} (${where(+p.x || 0, +p.y || 0)}): ${String(p.note || "").trim().slice(0, 200) || "see the marked copy"}`);
  if (!mask && !marked && !pins.length && !r.model) return { text: `${typed}\n\n[Editing image ${abs(img)}]`, attachments: [] as string[] };
  const model = r.model && /^[\w.-]+\/[\w.:-]+$/.test(r.model) ? r.model : r.model === "plan" ? "plan" : DEFAULT_IMAGE_MODEL;
  const refs = [abs(img), ...(marked ? [abs(marked)] : [])];
  const how = mask ? `generate_image with images [${refs.join(", ")}], mask ${abs(mask)}, model ${model === "plan" ? DEFAULT_IMAGE_MODEL : model}. Pitcrew keeps everything outside the mask exactly as it was.`
    : model === "plan" ? `image_gen with referenced_image_paths [${refs.join(", ")}] (the ChatGPT plan).` : `generate_image with images [${refs.join(", ")}], model ${model}.`;
  const lines = [typed.trim(), "", `[Edit of ${abs(img)}]`, ...(marked ? [`Marked copy: ${abs(marked)} (pink = change only there${pins.length ? "; numbered pins" : ""})`] : []), ...pins,
    `How: ${how} Keep everything you weren't asked to change.`];
  return { text: lines.join("\n"), attachments: marked && marked.startsWith("uploads/") ? [marked] : [] };
}

function check(m: ImageModel, a: Record<string, any>, inputs: number) {
  const errs: string[] = [];
  for (const k of PARAMS) {
    if (a[k] == null) continue;
    const s = m.params[k];
    if (!s) errs.push(`${m.id} doesn't take ${k}`);
    else if (s.type === "enum" && !s.values.map(String).includes(String(a[k]))) errs.push(`${k} must be one of ${s.values.join(", ")}`);
    else if (s.type === "range" && !(Number(a[k]) >= s.min && Number(a[k]) <= s.max)) errs.push(`${k} must be ${s.min}–${s.max}`);
  }
  if (a.n != null && Number(a.n) > 4) errs.push("n is at most 4 per call");
  const refs = m.params.input_references, max = refs?.type === "range" ? refs.max : 0;
  if (inputs > max) errs.push(max ? `${m.id} takes at most ${max} input images` : `${m.id} can't take input images; pick a model that edits`);
  return errs;
}

export interface Generated { paths: string[]; model: string; cost: number | null; pasted?: { ok: boolean; why?: string } }
/** One POST to OpenRouter (all-or-nothing billing); images saved to out/images. Throws with a message the agent can act on. */
export async function generateImage(botId: string, a: Record<string, any>): Promise<Generated> {
  const key = getSecret("openrouter");
  if (!key) throw new Error("generate_image needs an OpenRouter key; none is set in Settings.");
  const prompt = String(a.prompt || "").trim();
  if (!prompt) throw new Error("Give a prompt");
  const models = await imageModels(), id = String(a.model || DEFAULT_IMAGE_MODEL);
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(models.length ? `No image model ${id}. Some that exist: ${models.slice(0, 12).map((x) => x.id).join(", ")}` : "Couldn't load OpenRouter's image models; try again shortly.");
  const paths: string[] = Array.isArray(a.images) ? a.images.map(String) : [];
  const errs = check(m, a, paths.length);
  if (errs.length) throw new Error(`Not sent: ${errs.join("; ")}.`);
  const mask = a.mask ? String(a.mask) : null;
  if (mask && !paths.length) throw new Error("A mask needs the image it applies to as the first of images.");
  if (mask) imageFile(botId, mask);
  const refs = paths.map((p) => inputImage(botId, p));
  const body = { model: id, prompt: prompt.slice(0, 32000), ...Object.fromEntries(PARAMS.filter((k) => a[k] != null).map((k) => [k, k === "n" ? Number(a[k]) : String(a[k])])),
    ...(refs.length ? { input_references: refs } : {}) };
  const r = await fetch(`${API}/images`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const out: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenRouter said ${r.status}: ${String(out.error?.message || "the request failed").slice(0, 300)}`);
  const imgs = (out.data || []).filter((d: any) => typeof d.b64_json === "string");
  if (!imgs.length) throw new Error("OpenRouter returned no image (the prompt may have been refused).");
  const saved = imgs.map((d: any) => saveImage(botId, Buffer.from(d.b64_json, "base64"), OUT_EXT[d.media_type] || "png", String(a.name || prompt)));
  const cost = typeof out.usage?.cost === "number" ? out.usage.cost : null;
  if (!mask) return { paths: saved, model: id, cost };
  const results = await Promise.all(saved.map((p: string) => pasteBack(botId, paths[0], p, mask).catch((e) => ({ ok: false as const, why: String(e.message) }))));
  const bad = results.find((r) => !r.ok) as { why: string } | undefined;
  return { paths: saved, model: id, cost, pasted: bad ? { ok: false, why: bad.why } : { ok: true } };
}
