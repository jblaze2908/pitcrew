// What a browser action's result tells the agent about the page: the snapshot (full, diffed or left out), one line on
// what the action did, the tab list, and browser_read's markdown. Pure text work over Playwright MCP's output.
import { posix } from "node:path";
import { PW_OUT } from "../computer.js";
import type { Seen } from "./state.js";

// Playwright MCP writes the snapshot it takes after each action to a file (PW_OUT, see computer.ts) and returns only a
// link; an explicit browser_snapshot comes inline.
export const SNAP_LINK = /^### Snapshot\n- \[Snapshot\]\(([^)\s]+\.yml)\)$/m, SNAP_INLINE = /^### Snapshot\n```yaml\n([\s\S]*?)\n```$/m;
export const linkPath = (link: string | null | undefined) => { const abs = link && posix.resolve("/bot/work", link); return abs?.startsWith(`${PW_OUT}/`) ? abs : null; };

// What a browser action's result carries instead of Playwright's file link. One function, one mode: the call's own
// `snapshot` argument, else PITCREW_SNAPSHOT_MODE.
//   link: Playwright's own result (the agent spends a step on browser_snapshot). none: no snapshot.
//   full: the new snapshot, capped at SNAP_MAX.
//   diff (default): what changed since the snapshot this thread last saw. Full on a new page, a first view, a small
//         page (< SNAP_SMALL), or a diff over half the page (refs renumbered, page re-rendered).
// An explicit browser_snapshot is always full, capped at SNAP_MAX_EXPLICIT. Runs once per browser action: O(lines).
export const SNAP_MAX = 8000, SNAP_MAX_EXPLICIT = 12000, SNAP_SMALL = 2000, SNAP_MODES = ["diff", "full", "none"];
const SNAP_MODE = process.env.PITCREW_SNAPSHOT_MODE || "diff";
export function shapeSnapshot(text: string, snap: string | null, { prev = null, url = null, mode = SNAP_MODE }: { prev?: Pick<Seen, "url" | "text"> | null; url?: string | null; mode?: string } = {}) {
  const m = SNAP_LINK.exec(text) || SNAP_INLINE.exec(text);
  const link = m?.[0].includes("](") ? m[1] : null, file = linkPath(link);
  if (!m || snap == null || (link && mode === "link")) return text;
  let section: string | null = null;
  if (link && mode === "none") section = `### Snapshot\nNot included (snapshot: "none")${file ? `; it's in ${file}` : ""}.`;
  else if (link && mode === "diff" && prev?.text != null && prev.url === url && snap.length >= SNAP_SMALL) {
    const d = snapshotDiff(prev.text.split("\n"), snap.split("\n"));
    if (d == null) section = "### Snapshot\nNo change since your last snapshot of this page; its refs still hold.";
    else if (d.length <= snap.length / 2) section = `### Snapshot changes\nSince your last snapshot of this page (+ new, - gone; collapsed lines and their refs are as before):\n${fence(d, "", file, SNAP_MAX)}`;
  }
  return text.replace(m[0], () => section ?? `### Snapshot\n${fence(snap, "yaml", file, link ? SNAP_MAX : SNAP_MAX_EXPLICIT)}`);
}
function fence(s: string, lang: string, file: string | null, max: number) {
  if (s.length <= max) return `\`\`\`${lang}\n${s}\n\`\`\``;
  const cut = s.slice(0, s.lastIndexOf("\n", max) + 1 || max).trimEnd(), kb = (x: string) => (x.length / 1024).toFixed(0);
  return `\`\`\`${lang}\n${cut}\n\`\`\`\nTruncated: showing ${kb(cut)} of ${kb(s)} KB${file ? ` (full snapshot: ${file})` : ""}. Find the rest with browser_find, or browser_snapshot with target (a ref) or depth.`;
}
// Ordered line diff for snapshots, O(lines): a line also in the old snapshot (counted) is unchanged; gone lines print
// where they stood. Unchanged runs collapse to a count, keeping each change's parent line for context. null: no change.
export function snapshotDiff(before: string[], after: string[]) {
  const pos = new Map<string, number[]>(), used = new Set<number>(), ind = (l: string) => /^\s*/.exec(l)![0].length;
  before.forEach((l, j) => (pos.get(l) || pos.set(l, []).get(l)!).push(j));
  const match = after.map((l) => { const j = pos.get(l)?.shift(); if (j != null) used.add(j); return j ?? -1; });
  const gone = before.map((_, j) => j).filter((j) => !used.has(j) && before[j].trim());
  const next = new Array<number>(after.length + 1).fill(before.length); // old position of the next unchanged line, so "-" precedes its "+"
  for (let i = after.length - 1; i >= 0; i--) next[i] = match[i] >= 0 ? match[i] : next[i + 1];
  const ops: { t: " " | "+" | "-"; s: string }[] = []; let g = 0;
  after.forEach((l, i) => {
    while (g < gone.length && gone[g] < next[i]) ops.push({ t: "-", s: before[gone[g++]] });
    ops.push({ t: match[i] >= 0 || !l.trim() ? " " : "+", s: l });
  });
  while (g < gone.length) ops.push({ t: "-", s: before[gone[g++]] });
  if (!ops.some((o) => o.t !== " ")) return null;
  const keep = new Set<number>(), stack: number[] = []; // unchanged lines on the path from the root, for each change's parent
  ops.forEach((o, k) => {
    const d = ind(o.s);
    if (o.t === " ") { while (stack.length && ind(ops[stack[stack.length - 1]].s) >= d) stack.pop(); stack.push(k); return; }
    for (let p = stack.length - 1; p >= 0; p--) if (ind(ops[stack[p]].s) < d) { keep.add(stack[p]); break; }
  });
  const out: string[] = []; let run = 0;
  const flush = () => { if (run) out.push(`  … ${run} unchanged line${run === 1 ? "" : "s"}`); run = 0; };
  ops.forEach((o, k) => { if (o.t === " " && !keep.has(k)) { run++; return; } flush(); out.push(`${o.t} ${o.s}`); });
  flush();
  return out.join("\n");
}
// One line saying what an action did, so the agent can check it without reading the page: from the result's own Page,
// Open tabs, Modal state and Events sections, plus the URL the agent last saw and the tab count before the call.
export function verifyLine(tool: string, text: string, { before = null, tabsBefore = null }: { before?: string | null; tabsBefore?: number | null } = {}) {
  const url = /^- Page URL: (.*)$/m.exec(text)?.[1], title = /^- Page Title: (.*)$/m.exec(text)?.[1];
  const parts = [`${tool.replace(/^browser_/, "")} ${/^### Error$/m.test(text) ? "failed" : "done"}`];
  if (url) parts.push(before && before !== url ? `navigated ${before} → ${url}` : `${before ? "same page" : "on"} ${url}`);
  if (title) parts.push(`title "${title}"`);
  const tabs = readTabs(text)?.count;
  if (tabs && tabsBefore && tabs !== tabsBefore) parts.push(`${tabs > tabsBefore ? "new tab opened" : "tab closed"} (${tabs} open)`);
  const modal = /^### Modal state\n- (.*)$/m.exec(text)?.[1];
  if (modal) parts.push(`modal: ${modal}`);
  for (const d of text.matchAll(/^- (Download(?:ing|ed) file .*)$/gm)) parts.push(d[1]);
  const http = /^- HTTP status: (.*)$/m.exec(text)?.[1], errors = +(/^- Console: (\d+) errors/m.exec(text)?.[1] || 0);
  if (http) parts.push(`HTTP ${http}`);
  if (errors) parts.push(`console: ${errors} error${errors === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
export function readTabs(text: string) {
  const tabs = new Map<number, boolean>();
  for (const m of String(text).matchAll(/^- (\d+):( \(current\))? \[/gm)) tabs.set(+m[1], tabs.get(+m[1]) || !!m[2]);
  if (!tabs.size) return /^### Page$/m.test(text) ? { count: 1, current: 0 } : null;
  const current = [...tabs].find(([, cur]) => cur)?.[0];
  return { count: Math.max(...tabs.keys()) + 1, current: current ?? 0 };
}
export const pageHead = (text: string) => { const t = /^- Page Title: (.*)$/m.exec(text)?.[1], u = /^- Page URL: (.*)$/m.exec(text)?.[1]; return `Page: ${[t, u && `(${u})`].filter(Boolean).join(" ") || "unknown"}`; };

// browser_read: the page's accessibility snapshot as compact markdown. Fixed code over Playwright's own snapshot, so
// no page JS runs; the main landmark is preferred when it has real content. One pass over the snapshot's lines.
export const READ_MAX = 12000;
const unq = (s: string) => { if (!/^".*"$/.test(s)) return s; try { return JSON.parse(s); } catch { return s.slice(1, -1); } };
export function snapshotToText(yaml: string | null | undefined) {
  let lines = String(yaml || "").split("\n");
  const ind = (l: string) => /^\s*/.exec(l)![0].length, end = (i: number) => { let j = i + 1; while (j < lines.length && ind(lines[j]) > ind(lines[i])) j++; return j; };
  const mi = lines.findIndex((l) => /^\s*- main\b/.test(l));
  if (mi >= 0 && lines.slice(mi, end(mi)).join("\n").length > 400) lines = lines.slice(mi + 1, end(mi));
  const out: string[] = []; let bullet = false, named = "";
  const push = (s: unknown) => { let t = String(s).trim(); if (!t || t === named) return; named = ""; if (bullet) { t = `- ${t}`; bullet = false; } if (out[out.length - 1] !== t) out.push(t); };
  // A form control swallows its visible label text, whether that text comes just before or just after it.
  const control = (s: string, nm: string) => { if (nm && out[out.length - 1] === nm) out.pop(); push(s); named = nm; };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- (.*)$/.exec(lines[i]); if (!m) continue;
    const p = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?\s?(.*)$/.exec(m[1]);
    if (!p) { if (!m[1].startsWith("/")) push(unq(m[1])); continue; }
    const [, role, raw, attrs, rest] = p, name = raw ? unq(`"${raw}"`) : "", txt = unq(rest.trim()), label = name || txt;
    const skip = () => { i = end(i) - 1; };
    if (role === "heading") { out.push(""); push(`${"#".repeat(Math.min(6, +(/\[level=(\d)\]/.exec(attrs)?.[1] || 2)))} ${label}`); }
    else if (role === "link") { const u = lines.slice(i + 1, end(i)).map((l) => /^\s*- \/url: (.*)$/.exec(l)?.[1]).find(Boolean); if (label) push(u ? `[${label}](${unq(u)})` : label); skip(); }
    else if (role === "listitem") { if (label) push(`- ${label}`); else bullet = true; }
    else if (role === "row") { const cells = lines.slice(i + 1, end(i)).filter((l) => ind(l) === ind(lines[i]) + 2).map((l) => /^\s*- (?:cell|gridcell|columnheader|rowheader)(?: "((?:[^"\\]|\\.)*)")?[^:]*:?\s?(.*)$/.exec(l)).filter(Boolean).map((c) => (c![1] ? unq(`"${c![1]}"`) : unq(c![2].trim())).replace(/\|/g, "\\|")); push(cells.length ? `| ${cells.join(" | ")} |` : label); skip(); }
    else if (role === "button") { if (label) push(`[button: ${label}]`); skip(); }
    else if (/^(textbox|searchbox|spinbutton)$/.test(role)) control(`[${role}${name ? ` ${name}` : ""}${txt ? `: ${txt}` : ""}]`, name);
    else if (/^(checkbox|radio|switch)$/.test(role)) control(`[${/\[checked\]/.test(attrs) ? "x" : " "}] ${label}`, name);
    else if (/^(combobox|listbox)$/.test(role)) { const v = txt || lines.slice(i + 1, end(i)).map((l) => /^\s*- option "((?:[^"\\]|\\.)*)".*\[selected\]/.exec(l)?.[1]).find(Boolean); control(`[select${name ? ` ${name}` : ""}${v ? `: ${unq(`"${v}"`)}` : ""}]`, name); skip(); }
    else if (role === "img") { if (name) push(`![${name}]`); skip(); }
    else if (role === "separator") push("---");
    else if (/^(dialog|alertdialog|alert)$/.test(role)) push(`[${role}${label ? `: ${label}` : ""}]`);
    else if (!/^(banner|navigation|contentinfo|complementary|region|main|form|group|list|table|rowgroup|document|article|menu|menubar|tablist|toolbar|tree|grid)$/.test(role) || txt) push(label);
  }
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length <= READ_MAX) return s;
  return `${s.slice(0, s.lastIndexOf("\n", READ_MAX))}\n\nTruncated at ${(READ_MAX / 1024).toFixed(0)} of ${(s.length / 1024).toFixed(0)} KB. Pass target (a ref from browser_snapshot) to read one part.`;
}
