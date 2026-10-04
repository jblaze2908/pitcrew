// Images: generate_image (any OpenRouter image model, with edits from workspace images) and the store both it and
// Codex's own image_gen write to: /bot/work/out/images, so every image lands in the Library and can be edited again.
import { mkdirSync, chownSync, writeFileSync, existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { extname, posix } from "node:path";
import { getSecret } from "./auth.js";
import { botDir } from "./computer.js";

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

/** A workspace image as a data URL, confined to the member's /bot/work. */
function inputImage(botId: string, p: string) {
  const rel = posix.relative("/bot/work", posix.resolve("/bot/work", p));
  if (rel.startsWith("..")) throw new Error(`${p} is outside /bot/work`);
  const type = IN_TYPES[extname(rel).toLowerCase()];
  if (!type) throw new Error(`${p} isn't an image (png, jpg, webp or gif)`);
  let full: string;
  try { const base = realpathSync(`${botDir(botId)}/work`); full = realpathSync(`${base}/${rel}`); if (!full.startsWith(base + "/")) throw 0; }
  catch { throw new Error(`No image at ${p}`); }
  if (statSync(full).size > IN_MAX) throw new Error(`${p} is over 20 MB`);
  return { type: "image_url", image_url: { url: `data:${type};base64,${readFileSync(full).toString("base64")}` } };
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

export interface Generated { paths: string[]; model: string; cost: number | null }
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
  const refs = paths.map((p) => inputImage(botId, p));
  const body = { model: id, prompt: prompt.slice(0, 32000), ...Object.fromEntries(PARAMS.filter((k) => a[k] != null).map((k) => [k, k === "n" ? Number(a[k]) : String(a[k])])),
    ...(refs.length ? { input_references: refs } : {}) };
  const r = await fetch(`${API}/images`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const out: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenRouter said ${r.status}: ${String(out.error?.message || "the request failed").slice(0, 300)}`);
  const imgs = (out.data || []).filter((d: any) => typeof d.b64_json === "string");
  if (!imgs.length) throw new Error("OpenRouter returned no image (the prompt may have been refused).");
  const saved = imgs.map((d: any) => saveImage(botId, Buffer.from(d.b64_json, "base64"), OUT_EXT[d.media_type] || "png", String(a.name || prompt)));
  return { paths: saved, model: id, cost: typeof out.usage?.cost === "number" ? out.usage.cost : null };
}
