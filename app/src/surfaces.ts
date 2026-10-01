// Generative UI: the crew emits a declarative surface; Pitcrew renders it with its own components.
// The catalogue is the allowlist: unknown components or props, raw colours and oversized data are rejected, never degraded.

// A prop or field spec: what checkValue accepts for one value.
type Spec =
  | { t: "string"; max: number } | { t: "number" } | { t: "boolean" } | { t: "enum"; v: string[] } | { t: "int"; min: number; max: number }
  | { t: "name" } | { t: "url" } | { t: "row" } | { t: "array"; of: Spec; max: number } | { t: "object"; props: Record<string, Spec>; req: string[] };
interface Component { props: Record<string, Spec>; req?: string[]; children?: true | "fields"; field?: true }

const str = (max = 2000): Spec => ({ t: "string", max });
const num: Spec = { t: "number" };
const bool: Spec = { t: "boolean" };
const oneOf = (...v: string[]): Spec => ({ t: "enum", v });
const arr = (of: Spec, max: number): Spec => ({ t: "array", of, max });
const obj = (props: Record<string, Spec>, req: string[] = []): Spec => ({ t: "object", props, req });
const HUE = oneOf("c1", "c2", "c3", "c5", "c6");
const TONE = oneOf("default", "muted", "ok", "bad", "blue", "up", "down", "flat");
const FORMAT = oneOf("text", "number", "money", "date", "percent");
const OPTION = obj({ value: str(200), label: str(200) }, ["value", "label"]);
const field = (extra: Record<string, Spec> = {}): Component => ({ props: { name: { t: "name" }, label: str(200), required: bool, help: str(300), ...extra }, req: ["name", "label"], field: true });

export const CATALOGUE: Record<string, Component> = {
  Section: { props: { title: str(200) }, children: true },
  Stack: { props: { direction: oneOf("row", "column"), gap: oneOf("s", "m", "l") }, children: true },
  Grid: { props: { columns: { t: "int", min: 1, max: 4 } }, children: true },
  Card: { props: { title: str(200), hue: HUE }, children: true },
  Divider: { props: {} },
  Heading: { props: { text: str(200), level: { t: "int", min: 2, max: 3 } }, req: ["text"] },
  Text: { props: { text: str(), tone: TONE }, req: ["text"] },
  Quote: { props: { text: str() }, req: ["text"] },
  Lab: { props: { text: str(120) }, req: ["text"] },
  Receipt: { props: { text: str(400), source: { t: "url" } }, req: ["text"] },
  Stat: { props: { label: str(120), value: str(60), delta: str(60), tone: TONE, hue: HUE }, req: ["label", "value"] },
  Meter: { props: { label: str(120), value: num, max: num, unit: str(20), hue: HUE }, req: ["label", "value", "max"] },
  Badge: { props: { text: str(60), tone: TONE }, req: ["text"] },
  Table: { props: { columns: arr(obj({ key: { t: "name" }, label: str(120), format: FORMAT }, ["key", "label"]), 12), rows: arr({ t: "row" }, 200) }, req: ["columns", "rows"] },
  List: { props: { items: arr(obj({ title: str(200), detail: str(400), meta: str(80) }, ["title"]), 100) }, req: ["items"] },
  Timeline: { props: { items: arr(obj({ time: str(60), text: str(300), state: oneOf("done", "running", "needs", "failed") }, ["text"]), 100) }, req: ["items"] },
  BarChart: { props: { title: str(200), unit: str(20), format: FORMAT, hue: HUE, data: arr(obj({ label: str(80), value: num }, ["label", "value"]), 50) }, req: ["data"] },
  LineChart: { props: { title: str(200), unit: str(20), format: FORMAT, series: arr(obj({ name: str(80), hue: HUE, points: arr(obj({ x: str(40), y: num }, ["x", "y"]), 200) }, ["name", "points"]), 5) }, req: ["series"] },
  Donut: { props: { title: str(200), format: FORMAT, data: arr(obj({ label: str(80), value: num }, ["label", "value"]), 8) }, req: ["data"] },
  Sparkline: { props: { values: arr(num, 200), hue: HUE }, req: ["values"] },
  Compare: { props: { columns: arr(str(80), 5), rows: arr(obj({ label: str(120), values: arr(str(200), 5), winner: { t: "int", min: 0, max: 4 } }, ["label", "values"]), 40) }, req: ["columns", "rows"] },
  Form: { props: { action: { t: "name" }, submitLabel: str(40), title: str(200) }, req: ["action"], children: "fields" },
  TextField: field({ value: str(), placeholder: str(200), multiline: bool }),
  Number: field({ value: num, min: num, max: num }),
  Money: field({ value: num }),
  Date: field({ value: str(10) }),
  Select: { ...field({ value: str(200), options: arr(OPTION, 50) }), req: ["name", "label", "options"] },
  Radio: { ...field({ value: str(200), options: arr(OPTION, 12) }), req: ["name", "label", "options"] },
  Checkbox: field({ value: bool }),
  Toggle: field({ value: bool }),
  Choice: { props: { action: { t: "name" }, prompt: str(300), options: arr(obj({ id: { t: "name" }, label: str(200), detail: str(400) }, ["id", "label"]), 12) }, req: ["action", "options"] },
};

const MAX_NODES = 400, MAX_DEPTH = 8;

function checkValue(spec: Spec, v: any, path: string, errs: string[]): void {
  const bad = (m: string) => { errs.push(`${path}: ${m}`); };
  switch (spec.t) {
    case "string": if (typeof v !== "string") return bad("must be a string"); if (v.length > spec.max) bad(`longer than ${spec.max} chars`);
      if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(v) && /colou?r|background|style/i.test(path)) bad("raw colours are not allowed; use a hue token"); return;
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) bad("must be a number"); return;
    case "int": if (!Number.isInteger(v) || v < spec.min || v > spec.max) bad(`must be an integer ${spec.min}–${spec.max}`); return;
    case "boolean": if (typeof v !== "boolean") bad("must be true or false"); return;
    case "enum": if (!spec.v.includes(v)) bad(`must be one of ${spec.v.join(", ")}`); return;
    case "name": if (typeof v !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v)) bad("must be an identifier (letters, digits, _ or -)"); return;
    case "url": if (typeof v !== "string" || !/^https?:\/\/[^\s"'<>]{1,500}$/.test(v)) bad("must be an http(s) URL"); return;
    case "row": if (!v || typeof v !== "object" || Array.isArray(v)) return bad("must be an object");
      for (const [k, x] of Object.entries(v)) if (!["string", "number", "boolean"].includes(typeof x) && x !== null) bad(`.${k} must be a string, number or boolean`); else if (typeof x === "string" && x.length > 500) bad(`.${k} too long`); return;
    case "array": if (!Array.isArray(v)) return bad("must be an array"); if (v.length > spec.max) bad(`at most ${spec.max} items`);
      v.slice(0, spec.max).forEach((x, i) => checkValue(spec.of, x, `${path}[${i}]`, errs)); return;
    case "object": if (!v || typeof v !== "object" || Array.isArray(v)) return bad("must be an object");
      for (const k of Object.keys(v)) if (!spec.props[k]) bad(`unknown field "${k}"`);
      for (const r of spec.req) if (v[r] === undefined) bad(`missing "${r}"`);
      for (const [k, s] of Object.entries(spec.props)) if (v[k] !== undefined) checkValue(s, v[k], `${path}.${k}`, errs); return;
  }
}

export function validateSurface(surface: any): { ok: boolean; errors: string[]; actions?: string[] } {
  const errs: string[] = [];
  let nodes = 0;
  const actions = new Set<string>();
  const walk = (n: any, path: string, depth: number, inForm: boolean): unknown => {
    if (++nodes > MAX_NODES) { if (nodes === MAX_NODES + 1) errs.push(`surface has more than ${MAX_NODES} components`); return; }
    if (depth > MAX_DEPTH) return errs.push(`${path}: nested deeper than ${MAX_DEPTH}`);
    if (!n || typeof n !== "object" || Array.isArray(n)) return errs.push(`${path}: must be a component object`);
    const def = CATALOGUE[n.type];
    if (!def) return errs.push(`${path}: unknown component "${n.type}". Allowed: ${Object.keys(CATALOGUE).join(", ")}`);
    if (def.field && !inForm) errs.push(`${path}: ${n.type} must be inside a Form`);
    for (const k of Object.keys(n)) if (k !== "type" && k !== "children" && !def.props[k]) errs.push(`${path}.${k}: unknown prop for ${n.type}`);
    for (const r of def.req || []) if (n[r] === undefined) errs.push(`${path}: ${n.type} needs "${r}"`);
    for (const [k, s] of Object.entries(def.props)) if (n[k] !== undefined) checkValue(s, n[k], `${path}.${k}`, errs);
    if (n.action) actions.add(n.action);
    if (n.children !== undefined) {
      if (!def.children) return errs.push(`${path}: ${n.type} takes no children`);
      if (!Array.isArray(n.children)) return errs.push(`${path}.children must be an array`);
      n.children.forEach((c: unknown, i: number) => walk(c, `${path}.children[${i}]`, depth + 1, inForm || def.children === "fields"));
    }
  };
  if (!surface || typeof surface !== "object") return { ok: false, errors: ["surface must be an object with title and root"] };
  if (typeof surface.title !== "string" || !surface.title.trim() || surface.title.length > 200) errs.push("title: required, up to 200 chars");
  for (const k of Object.keys(surface)) if (!["title", "root"].includes(k)) errs.push(`unknown field "${k}"`);
  walk(surface.root, "root", 0, false);
  return { ok: errs.length === 0, errors: errs.slice(0, 25), actions: [...actions] };
}

// Stable text for the tool description, so the catalogue stays in cached instructions, not in per-turn state.
export function catalogueDoc() {
  const fmt = (s: Spec): string => s.t === "enum" ? s.v.join("|") : s.t === "array" ? `[${fmt(s.of)}]` : s.t === "object" ? `{${Object.entries(s.props).map(([k, v]) => `${k}${s.req.includes(k) ? "" : "?"}:${fmt(v)}`).join(",")}}` : s.t;
  return Object.entries(CATALOGUE).map(([name, d]) => `${name}(${Object.entries(d.props).map(([k, v]) => `${k}${(d.req || []).includes(k) ? "" : "?"}:${fmt(v)}`).join(", ")})${d.children ? " [children]" : ""}${d.field ? " [inside Form]" : ""}`).join("\n");
}
