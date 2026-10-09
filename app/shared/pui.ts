// Surfaces written inline in a crew reply: <Surface title="…">…</Surface> blocks between markdown. Parsed into the
// catalogue's JSON shape ({type, ...props, children}) by the server when a reply completes and by the web app while it
// streams, so a half-written reply yields its finished components and nothing else. Text only; nothing here evaluates.

const RAW = new Set(["Query"]);
const NUM: Record<string, string[]> = { Meter: ["value", "max"], Grid: ["columns"], Heading: ["level"], Number: ["value", "min", "max"], Money: ["value"], Slider: ["value", "min", "max", "step"] };
const BOOL = ["required", "multiline"];
const LAYOUT = new Set(["Section", "Stack", "Grid", "Card", "Form"]);
const BODY_TEXT = new Set(["Heading", "Text", "Quote", "Lab", "Receipt", "Badge"]);

interface El { tag: string; attrs: Record<string, string | true>; children: (El | string)[]; text?: string; closed: boolean }
export interface InlineSurface { id?: string; title?: string; source?: string; queries?: Record<string, string>; root: any }
export type Segment = { kind: "md"; text: string } | { kind: "surface"; surface: InlineSurface; complete: boolean };

// ---------- tags ----------
type Open = { name: string; attrs: Record<string, string | true>; end: number; self: boolean; bad?: string };
function readOpenTag(s: string, lt: number): Open | null {
  const m = /^<([A-Za-z]\w*)/.exec(s.slice(lt, lt + 40));
  if (!m) return null;
  const attrs: Record<string, string | true> = {};
  let i = lt + m[0].length;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return null;
    if (s.startsWith("/>", i)) return { name: m[1], attrs, end: i + 2, self: true };
    if (s[i] === ">") return { name: m[1], attrs, end: i + 1, self: false };
    const a = /^[A-Za-z_][\w:-]*/.exec(s.slice(i, i + 64));
    if (!a) return { name: m[1], attrs, end: i + 1, self: false, bad: `odd character in <${m[1]}>` };
    i += a[0].length;
    if (s[i] !== "=") { if (i >= s.length) return null; attrs[a[0]] = true; continue; }
    i++;
    const q = s[i];
    if (q === '"' || q === "'") { const j = s.indexOf(q, i + 1); if (j < 0) return null; attrs[a[0]] = s.slice(i + 1, j); i = j + 1; }
    else { const v = /^[^\s>]+?(?=\/>|>|\s)/.exec(s.slice(i)); if (!v) return null; attrs[a[0]] = v[0]; i += v[0].length; }
  }
}

/** Element tree of a tag source; stops quietly at a half-written tag. */
export function parseTags(src: string): { root: El; errors: string[] } {
  const root: El = { tag: "#root", attrs: {}, children: [], closed: true }, stack = [root], errors: string[] = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { top().children.push(src.slice(i)); break; }
    if (lt > i) top().children.push(src.slice(i, lt));
    if (src[lt + 1] === "/") {
      const m = /^<\/([A-Za-z]\w*)\s*>/.exec(src.slice(lt, lt + 60));
      if (!m) break;
      const k = stack.map((e) => e.tag).lastIndexOf(m[1]);
      if (k <= 0) errors.push(`stray </${m[1]}>`);
      else { if (k < stack.length - 1) errors.push(`<${top().tag}> isn't closed before </${m[1]}>`); stack.splice(k).forEach((e) => (e.closed = true)); }
      i = lt + m[0].length;
      continue;
    }
    if (!/[A-Za-z]/.test(src[lt + 1] || "")) { if (lt + 1 >= src.length) break; top().children.push("<"); i = lt + 1; continue; }
    const t = readOpenTag(src, lt);
    if (!t) break;
    if (t.bad) errors.push(t.bad);
    const el: El = { tag: t.name, attrs: t.attrs, children: [], closed: t.self };
    top().children.push(el);
    i = t.end;
    if (t.self) continue;
    if (RAW.has(t.name)) {
      const end = src.indexOf(`</${t.name}>`, i);
      el.text = src.slice(i, end < 0 ? src.length : end);
      if (end < 0) break;
      el.closed = true; i = end + t.name.length + 3; continue;
    }
    stack.push(el);
  }
  return { root, errors };
}

// ---------- tags → catalogue ----------
const bodyText = (el: El) => el.children.filter((c): c is string => typeof c === "string").join("").trim();
const kids = (el: El, tag: string) => el.children.filter((c): c is El => typeof c === "object" && c.tag === tag);
const list = (v: unknown) => String(v).split("|").map((x) => x.trim()).filter((x) => x !== "");
const numOf = (v: unknown) => (typeof v === "number" ? v : Number(String(v).replace(/[₹,%\s]/g, "")));
const options = (v: unknown) => list(v).map((o) => { const k = o.indexOf(":"); return k < 0 ? { value: o, label: o } : { value: o.slice(0, k).trim(), label: o.slice(k + 1).trim() }; });
// "Label: 12" lines; the last colon splits, so labels may hold colons.
const pairs = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => { const k = l.lastIndexOf(":"); return k < 0 ? [] : [{ label: l.slice(0, k).trim(), value: numOf(l.slice(k + 1)) }]; });

function props(type: string, attrs: El["attrs"]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if ((NUM[type] || []).includes(k) || k === "winner") out[k] = numOf(v);
    else if (BOOL.includes(k) || ((type === "Checkbox" || type === "Toggle" || type === "Switch") && k === "value")) out[k] = v === true || v === "true";
    else out[k] = v === true ? true : String(v);
  }
  return out;
}

function convert(el: El | string, warn: (w: string) => void): any {
  if (typeof el === "string") { const t = el.trim(); if (!t) return null; warn(`loose text "${t.slice(0, 40)}": wrap it in <Text>`); return { type: "Text", text: t }; }
  const t = el.tag, n: any = { type: t, ...props(t, el.attrs) };
  if (LAYOUT.has(t)) {
    if (t === "Form" && n.submit !== undefined) { n.submitLabel = n.submit; delete n.submit; }
    n.children = el.children.map((c) => convert(c, warn)).filter(Boolean);
  } else if (BODY_TEXT.has(t)) { if (n.text === undefined) n.text = bodyText(el); }
  else if (t === "BarChart" || t === "Donut") { if (n.data === undefined && !n.bind) n.data = pairs(bodyText(el)); }
  else if (t === "LineChart") { if (!n.bind) n.series = kids(el, "Series").map((s) => ({ name: String(s.attrs.name ?? ""), ...(s.attrs.hue ? { hue: s.attrs.hue } : {}), points: pairs(bodyText(s)).map((p) => ({ x: p.label, y: p.value })) })); }
  else if (t === "Sparkline") { if (typeof n.values === "string") n.values = n.values.split(/[|,]/).map(numOf); }
  else if (t === "Table") {
    if (typeof n.columns === "string") n.columns = list(n.columns).map((c) => { const [key, label, format] = c.split(":").map((x) => x.trim()); return { key, label: label || key, ...(format ? { format } : {}) }; });
    if (!n.bind && Array.isArray(n.columns)) n.rows = bodyText(el).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => Object.fromEntries(l.split("|").flatMap((v, i) => {
      const c = n.columns[i]; return c ? [[c.key, ["number", "money", "percent"].includes(c.format) ? numOf(v) : v.trim()]] : [];
    })));
  } else if (t === "Compare") {
    if (typeof n.columns === "string") n.columns = list(n.columns);
    n.rows = kids(el, "Row").map((r) => ({ label: String(r.attrs.label ?? ""), values: bodyText(r).split("|").map((v) => v.trim()), ...(r.attrs.winner !== undefined ? { winner: numOf(r.attrs.winner) } : {}) }));
  } else if (t === "List") { if (!n.bind) n.items = kids(el, "Item").map((x) => ({ title: String(x.attrs.title ?? bodyText(x)), ...(x.attrs.meta ? { meta: String(x.attrs.meta) } : {}), ...(x.attrs.title && bodyText(x) ? { detail: bodyText(x) } : {}) })); }
  else if (t === "Timeline") { if (!n.bind) n.items = kids(el, "Event").map((x) => ({ text: bodyText(x), ...(x.attrs.time ? { time: String(x.attrs.time) } : {}), ...(x.attrs.state ? { state: String(x.attrs.state) } : {}) })); }
  else if (t === "Choice") n.options = kids(el, "Option").map((o) => ({ id: String(o.attrs.id ?? ""), label: String(o.attrs.label ?? bodyText(o)), ...(o.attrs.label && bodyText(o) ? { detail: bodyText(o) } : {}) }));
  else if (["Select", "Radio", "Picker", "Tabs"].includes(t) && typeof el.attrs.options === "string") n.options = options(el.attrs.options);
  return n;
}

function toSurface(el: El, warn: (w: string) => void): InlineSurface {
  const s: InlineSurface = { root: { type: "Stack", children: [] } };
  if (el.attrs.id) s.id = String(el.attrs.id);
  if (el.attrs.title !== undefined) s.title = String(el.attrs.title);
  if (el.attrs.source) s.source = String(el.attrs.source);
  const queries: Record<string, string> = {};
  for (const c of el.children) {
    if (typeof c === "object" && c.tag === "Query") { if (c.closed) queries[String(c.attrs.name)] = (c.text || "").trim(); continue; }
    if (typeof c === "object" && !c.closed) continue; // still streaming: drawn once it closes
    const n = convert(c, warn);
    if (n) s.root.children.push(n);
  }
  if (Object.keys(queries).length) s.queries = queries;
  return s;
}

/** A reply, whole or half-streamed, as markdown and surface segments. */
export function splitReply(text: string): { segments: Segment[]; errors: string[]; warnings: string[] } {
  const segments: Segment[] = [], errors: string[] = [], warnings: string[] = [];
  const open = /(^|\n)[ \t]*<Surface[\s>/]/g;
  let i = 0, m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    const start = m.index + m[1].length;
    let prose = text.slice(i, start);
    // A model sometimes fences the tags as code; the fence goes, the surface stays.
    if (/```[\w-]*\s*$/.test(prose)) { prose = prose.replace(/```[\w-]*\s*$/, ""); warnings.push("surface wrapped in a code fence"); }
    if (prose.trim()) segments.push({ kind: "md", text: prose });
    const close = text.indexOf("</Surface>", start);
    const end = close < 0 ? text.length : close + "</Surface>".length;
    const { root, errors: e } = parseTags(text.slice(start, end));
    errors.push(...e);
    const el = root.children.find((c): c is El => typeof c === "object" && c.tag === "Surface");
    if (el) segments.push({ kind: "surface", surface: toSurface(el, (w) => warnings.push(w)), complete: close >= 0 });
    i = end;
    const after = close >= 0 && /^\s*```[ \t]*(\n|$)/.exec(text.slice(i));
    if (after) i += after[0].length;
    open.lastIndex = i;
    if (close < 0) break;
  }
  if (i < text.length && text.slice(i).trim()) segments.push({ kind: "md", text: text.slice(i) });
  return { segments, errors, warnings };
}

// ---------- controls ----------
export const CONTROLS = ["Picker", "Tabs", "Slider", "Switch"];
const walk = (n: any, f: (n: any) => void) => { if (!n || typeof n !== "object") return; f(n); (n.children || []).forEach((c: any) => walk(c, f)); };
/** Each control's starting value, by name: its value, else the first option, the minimum, or off. */
export function controlDefaults(root: any): Record<string, string | number | boolean> {
  const s: Record<string, string | number | boolean> = {};
  walk(root, (n) => {
    if (!CONTROLS.includes(n.type) || !n.name || n.name in s) return;
    s[n.name] = n.type === "Slider" ? Number(n.value ?? n.min ?? 0) : n.type === "Switch" ? n.value === true : String(n.value ?? n.options?.[0]?.value ?? "");
  });
  return s;
}
/** Whether a when ("view=items", "view!=items", "a=1 and b=2", or a bare switch name) holds; unknown names never do. */
export function whenHolds(w: unknown, state: Record<string, unknown>): boolean {
  return String(w).split(/\s+and\s+|\s*&&\s*/).every((c) => {
    const m = /^\s*(\w+)\s*(!?=)=?\s*"?([^"]*?)"?\s*$/.exec(c);
    if (!m) { const k = c.trim(); return k in state && state[k] !== false && state[k] !== ""; }
    if (!(m[1] in state)) return false;
    return (String(state[m[1]]) === m[3]) === (m[2] === "=");
  });
}
