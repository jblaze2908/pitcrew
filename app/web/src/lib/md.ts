// Minimal, safe markdown to HTML: escape first, then a few inline and block forms.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// botId: links to the member's own files ("/bot/work/out/x.csv", "out/x.csv") open in its workspace; without it they stay text.
const inline = (s: string, botId?: string) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  // Links into this app (a thread the crew found) open in place; anything else opens a new tab.
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, (_m, t: string, u: string) => u.startsWith(`${location.origin}/`)
    ? `<a href="${u.slice(location.origin.length)}">${t}</a>`
    : `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
  .replace(/\[([^\]]+)\]\((?:\/bot\/work\/)?([\w.][\w./-]*)\)/g, (_m, t: string, p: string) => p.includes("..") || !botId ? t
    : `<a href="#/crew/${encodeURIComponent(botId)}/files/workspace/${encodeURIComponent(p)}">${t}</a>`);

// GFM table: a row with pipes, then a separator row whose colons set alignment.
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const NUM = /^[-+]?[₹$€£]?\s?[\d.,]+\s?(%|[kKmMbB]|x)?$/;

/** Cells of one row: outer pipes dropped, `\|` and pipes inside code kept. Split before inline() so its markup can't be cut. */
function cells(line: string): string[] {
  const out: string[] = []; let cur = "", code = false;
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function table(head: string, sep: string, body: string[], botId?: string): string {
  const h = cells(head), rows = body.map(cells);
  const align = cells(sep).map((c, i) => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : c.startsWith(":") ? "left"
    // Unmarked columns that hold only numbers read better right-aligned; models rarely write the colon.
    : rows.some((r) => r[i]) && rows.every((r) => !r[i] || NUM.test(r[i].replace(/\*\*/g, ""))) ? "right" : "");
  const td = (tag: string, row: string[]) => h.map((_, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inline(row[i] || "", botId)}</${tag}>`).join("");
  return `<div class="tw"><table><thead><tr>${td("th", h)}</tr></thead><tbody>${rows.map((r) => `<tr>${td("td", r)}</tr>`).join("")}</tbody></table></div>`;
}

export function mdToHtml(text: string | null | undefined, botId?: string): string {
  const out: string[] = [];
  String(text || "").split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`); return; }
    let list: { tag: "ul" | "ol"; items: string[] } | null = null;
    const endList = () => { if (list) out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`); list = null; };
    const lines = part.split("\n");
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (line.includes("|") && SEP.test(lines[j + 1] || "") && lines[j + 1].includes("-")) {
        endList();
        const sep = lines[j + 1], body: string[] = [];
        for (j += 2; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) body.push(lines[j]);
        out.push(table(line, sep, body, botId));
        j--;
        continue;
      }
      const li = /^\s*([-*]|\d+\.)\s+(.*)/.exec(line);
      if (li) {
        const tag = /\d/.test(li[1]) ? "ol" : "ul";
        if (list && list.tag !== tag) endList();
        (list ||= { tag, items: [] }).items.push(`<li>${inline(li[2], botId)}</li>`);
        continue;
      }
      endList();
      if (/^#{1,4}\s/.test(line)) out.push(`<h3>${inline(line.replace(/^#+\s/, ""), botId)}</h3>`);
      else if (line.trim()) out.push(`<p>${inline(line, botId)}</p>`);
    }
    endList();
  });
  return out.join("");
}
