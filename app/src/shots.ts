// Screenshots a crew member shares in chat. Kept outside the bot's mount, so nothing on its computer can rewrite them.
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, realpathSync, createReadStream } from "node:fs";
import { ROOT, botDir, PW_OUT } from "./computer.js";
import type { ServerResponse } from "node:http";

const DIR = (botId: string) => `${ROOT}/shots/${botId}`;
const KEEP_DAYS = Number(process.env.PITCREW_SHOT_DAYS || 30);
const KEEP_MAX = Number(process.env.PITCREW_SHOT_MAX || 500); // per crew member
export const SHOT_NAME = /^[\w-]+\.jpg$/;

// JPEG q80, at most 1600 px wide and 8000 px tall (a full-page shot keeps its top). Runs in the bot's own computer,
// which already has ImageMagick; one docker exec per share.
function compress(container: string, buf: Buffer) {
  return new Promise<Buffer | null>((res) => {
    const p = spawn("docker", ["exec", "-i", container, "convert", "-", "-resize", "1600x>", "-crop", "x8000+0+0", "+repage", "-strip", "-quality", "80", "jpeg:-"]);
    const out: Buffer[] = [];
    p.stdout.on("data", (c) => out.push(c));
    p.on("error", () => res(null));
    p.on("close", (code) => res(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
}

// Playwright returns the image inline, or only the path of the file it wrote under PW_OUT: absolute, or a markdown link
// relative to its cwd, /bot/work.
// A dynamic tool result: Codex content items (inputText / inputImage).
export type ToolResult = { success: boolean; contentItems: { type: string; text?: string; imageUrl?: string }[] };
export function imageFrom(result: Pick<ToolResult, "contentItems">, botId: string) {
  const item = (result.contentItems || []).find((x) => x.type === "inputImage");
  if (item) return Buffer.from(item.imageUrl!.split(",")[1] || "", "base64");
  const text = (result.contentItems || []).map((x) => x.text || "").join("\n");
  const rel = /\]\(([\w./-]+\.(?:png|jpe?g))\)/.exec(text)?.[1], path = rel ? posix.resolve("/bot/work", rel) : new RegExp(`${PW_OUT}/[\\w./-]+\\.(?:png|jpe?g)`).exec(text)?.[0];
  if (!path?.startsWith(`${PW_OUT}/`)) return null;
  try {
    const base = realpathSync(`${botDir(botId)}${PW_OUT.slice(4)}`), full = realpathSync(`${botDir(botId)}${path.slice(4)}`);
    return full.startsWith(base + "/") ? readFileSync(full) : null;
  } catch { return null; }
}

export async function saveShot(botId: string, container: string, buf: Buffer) {
  const jpg = (await compress(container, buf)) || (buf[0] === 0xff && buf[1] === 0xd8 ? buf : null);
  if (!jpg) return null;
  mkdirSync(DIR(botId), { recursive: true });
  const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  writeFileSync(`${DIR(botId)}/${file}`, jpg);
  prune(botId);
  return { file, bytes: jpg.length, original: buf.length };
}

function prune(botId: string) {
  let names: string[]; try { names = readdirSync(DIR(botId)).filter((n) => SHOT_NAME.test(n)); } catch { return; }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const files = names.map((n) => ({ n, t: statSync(`${DIR(botId)}/${n}`).mtimeMs })).sort((a, b) => b.t - a.t);
  files.forEach((f, i) => { if (i >= KEEP_MAX || f.t < cutoff) try { unlinkSync(`${DIR(botId)}/${f.n}`); } catch {} });
}

// Hourly: one readdir per crew member.
export function startShotSweeper() {
  setInterval(() => { let bots: string[] = []; try { bots = readdirSync(`${ROOT}/shots`); } catch {} bots.forEach(prune); }, 3600000).unref();
}

export function serveShot(res: ServerResponse, botId: string, file: string) {
  const full = `${DIR(botId)}/${file}`;
  let size: number; try { size = statSync(full).size; } catch { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400", "Content-Length": size });
  createReadStream(full).pipe(res);
}
