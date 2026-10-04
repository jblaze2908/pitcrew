// A member's skill library: /bot/work/skills/<name>/SKILL.md (frontmatter name + description) with its scripts/ and
// references/, one git repo for the lot. Pitcrew reads it from the host (no computer needed), indexes it into the
// instructions at thread start, and serves skill_view, which is how a load gets counted (a `cat` in the shell can't be).
// Per thread start: one directory read and a 4 KB head read per skill (30 max).
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { all, run, now } from "../db.js";
import { botDir } from "../computer.js";

const SKILLS_MAX = 30, VIEW_MAX = 20000, STALE_MS = 30 * 86400000;
export interface SkillInfo { name: string; description: string; size: number; uses: number; last_used: number | null; stale: boolean }
const root = (botId: string) => `${botDir(botId)}/work/skills`;

// name and description from a SKILL.md's frontmatter; the folder name and first heading when it has none.
export function frontmatter(text: string, folder: string) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || "";
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(fm)?.[1]?.trim();
  return { name: field("name") || folder, description: field("description") || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || "" };
}

export function listSkills(botId: string): SkillInfo[] {
  let dirs: string[] = [];
  try { dirs = readdirSync(root(botId), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).slice(0, SKILLS_MAX); } catch { return []; }
  const usage = new Map(all<{ name: string; uses: number; last_used: number }>("SELECT name, uses, last_used FROM skill_usage WHERE bot_id=?", botId).map((u) => [u.name, u]));
  const out: SkillInfo[] = [];
  for (const d of dirs) {
    const f = `${root(botId)}/${d}/SKILL.md`;
    let head = "", size = 0;
    try { size = statSync(f).size; head = readFileSync(f, "utf8").slice(0, 4096); } catch { continue; }
    const { description } = frontmatter(head, d), u = usage.get(d), seen = u?.last_used ?? null;
    out.push({ name: d, description, size, uses: u?.uses ?? 0, last_used: seen, stale: !!seen && now() - seen > STALE_MS });
  }
  return out;
}

// The index the instructions carry: one line per skill, description cut to 90 chars. Empty when there are none.
export const skillIndex = (skills: SkillInfo[]) => skills.map((s) => `- ${s.name}: ${s.description.slice(0, 90) || "(no description)"}`).join("\n");

// One skill's SKILL.md, or a file inside its folder (references/x.md, scripts/y.py), with its file list. Counts the use.
export function viewSkill(botId: string, name: string, file = "SKILL.md") {
  if (!/^[\w.-]{1,64}$/.test(name) || file.split("/").includes("..")) return null;
  try {
    const dir = realpathSync(`${root(botId)}/${name}`), f = realpathSync(`${dir}/${file}`);
    if (!f.startsWith(`${dir}/`)) return null;
    const text = readFileSync(f, "utf8");
    const files = readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.startsWith(".git") && p !== "SKILL.md").slice(0, 50);
    if (file === "SKILL.md") run("INSERT INTO skill_usage(bot_id,name,uses,last_used) VALUES(?,?,1,?) ON CONFLICT(bot_id,name) DO UPDATE SET uses=uses+1, last_used=excluded.last_used", botId, name, now());
    return { text: text.length > VIEW_MAX ? `${text.slice(0, VIEW_MAX)}\n…(cut at ${VIEW_MAX / 1000} KB)` : text, files };
  } catch { return null; }
}
