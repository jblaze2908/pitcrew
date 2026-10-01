// Minimal, safe markdown to HTML: escape first, then a few inline and block forms.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const inline = (s: string) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  // Links into this app (a thread the crew found) open in place; anything else opens a new tab.
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, (_m, t: string, u: string) => u.startsWith(`${location.origin}/`)
    ? `<a href="${u.slice(location.origin.length)}">${t}</a>`
    : `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);

export function mdToHtml(text: string | null | undefined): string {
  const out: string[] = [];
  String(text || "").split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`); return; }
    let list: string[] | null = null;
    for (const line of part.split("\n")) {
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line);
      if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      if (/^#{1,4}\s/.test(line)) out.push(`<h3>${inline(line.replace(/^#+\s/, ""))}</h3>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
  });
  return out.join("");
}
