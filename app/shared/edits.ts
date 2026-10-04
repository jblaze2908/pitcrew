// Read back a message that edits an image, from the member text app/src/images.ts editMessage writes (tests/images.test.mjs pins the two together).
const MODEL_NAMES: Record<string, string> = { "google/gemini-3.1-flash-image": "Nano Banana 2", "openai/gpt-image-2.5-sunburst": "GPT Image 2.5", plan: "ChatGPT plan" };
export interface EditAsk { image: string; typed: string; marked: string | null; brushed: boolean; pins: string[]; model: string | null }
/** What a message that edits an image asked for, read back from the member text that images.ts editMessage writes. */
export function editOf(text: string): EditAsk | null {
  const m = /(?:^|\n\n)\[(?:Edit of|Editing image) \/bot\/work\/([^\]\s]+)\]/.exec(text || "");
  if (!m) return null;
  const how = /^How: (.*)$/m.exec(text)?.[1] || "";
  const id = how.startsWith("image_gen") ? "plan" : /, model ([\w.\/:-]+?)\. /.exec(how)?.[1] ?? null;
  return {
    image: m[1], typed: text.slice(0, m.index).trim(),
    marked: /^Marked copy: \/bot\/work\/(\S+)/m.exec(text)?.[1] ?? null,
    brushed: /, mask \/bot\/work\//.test(how),
    pins: [...text.matchAll(/^Pin \d+ \([^)]*\): (.*)$/gm)].map((x) => (x[1] === "see the marked copy" ? "" : x[1])),
    model: id && (MODEL_NAMES[id] || id.split("/").pop()!),
  };
}
