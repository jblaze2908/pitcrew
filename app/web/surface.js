// Renders a validated surface spec with Pitcrew components. Text goes in via textContent only; colours are hue tokens only.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const HUES = ["c1", "c2", "c3", "c5", "c6"];
const hueVar = (hue, i = 0) => `var(--${HUES.includes(hue) ? hue : HUES[i % HUES.length]})`;
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
export function fmt(v, f) {
  if (v == null || v === "") return "";
  if (f === "money" && typeof v === "number") return `₹${inr.format(v)}`;
  if (f === "percent" && typeof v === "number") return `${inr.format(v)}%`;
  if (f === "number" && typeof v === "number") return inr.format(v);
  return String(v);
}
const toneClass = (t) => ({ ok: "ok", up: "ok", bad: "bad", down: "bad", blue: "blue" })[t] || "";

function barChart(n) {
  const max = Math.max(1e-9, ...n.data.map((d) => Math.abs(d.value)));
  return h("div", { class: "col" }, n.title && h("p", { class: "pc-lab" }, n.title),
    h("div", { class: "sf-bars" }, n.data.map((d) => h("div", { class: "sf-bar", style: `--hue:${hueVar(n.hue)}` },
      h("span", { class: "muted" }, d.label), h("span", { class: "track" }, h("b", { style: `width:${Math.max(1, (Math.abs(d.value) / max) * 100)}%` })),
      h("span", { class: "n" }, fmt(d.value, n.format || "number") + (n.unit && !(n.format === "money" && /₹|inr|rupee|rs/i.test(n.unit)) ? ` ${n.unit}` : ""))))));
}

function lineChart(n) {
  const W = 640, H = 200, P = 28;
  const xs = [...new Set(n.series.flatMap((s) => s.points.map((p) => p.x)))];
  const ys = n.series.flatMap((s) => s.points.map((p) => p.y));
  const lo = Math.min(0, ...ys), hi = Math.max(1e-9, ...ys);
  const X = (x) => P + (xs.indexOf(x) / Math.max(1, xs.length - 1)) * (W - P * 2);
  const Y = (y) => H - P - ((y - lo) / (hi - lo || 1)) * (H - P * 2);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", "100%");
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
  add("line", { x1: P, x2: W - P, y1: H - P, y2: H - P, stroke: "var(--line-2)" });
  add("text", { x: 2, y: Y(hi) + 4 }, fmt(hi, n.format || "number"));
  add("text", { x: 2, y: H - P + 4 }, fmt(lo, n.format || "number"));
  [xs[0], xs[xs.length - 1]].forEach((x, i) => x != null && add("text", { x: i ? W - P - 30 : P, y: H - 8 }, x));
  n.series.forEach((s, i) => {
    const d = s.points.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
    add("path", { d, fill: "none", stroke: hueVar(s.hue, i), "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" });
  });
  return h("div", { class: "col" }, n.title && h("p", { class: "pc-lab" }, n.title), svg,
    n.series.length > 1 && h("div", { class: "sf-legend" }, n.series.map((s, i) => h("span", { style: `--hue:${hueVar(s.hue, i)}` }, h("i"), s.name))));
}

function donut(n) {
  const total = n.data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
  let acc = 0;
  const stops = n.data.map((d, i) => { const a = acc; acc += (Math.max(0, d.value) / total) * 100; return `${hueVar(null, i)} ${a}% ${acc}%`; }).join(",");
  return h("div", { class: "row", style: "gap:20px;align-items:center" },
    h("div", { style: `width:132px;height:132px;border-radius:50%;background:conic-gradient(${stops});-webkit-mask:radial-gradient(circle,transparent 42%,#000 43%);mask:radial-gradient(circle,transparent 42%,#000 43%)` }),
    h("div", { class: "col", style: "gap:6px" }, n.title && h("p", { class: "pc-lab" }, n.title),
      n.data.map((d, i) => h("div", { class: "sf-legend", style: `--hue:${hueVar(null, i)}` }, h("span", {}, h("i"), `${d.label} · ${fmt(d.value, n.format || "number")}`)))));
}

function sparkline(n) {
  const v = n.values, lo = Math.min(...v), hi = Math.max(...v), W = 160, H = 36;
  const d = v.map((y, i) => `${i ? "L" : "M"}${((i / Math.max(1, v.length - 1)) * W).toFixed(1)},${(H - 3 - ((y - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join(" ");
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
  p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", hueVar(n.hue)); p.setAttribute("stroke-width", "2");
  svg.append(p); return svg;
}

function field(n, values) {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  const set = (v) => { values[n.name] = v; };
  let input;
  switch (n.type) {
    case "TextField": input = n.multiline ? h("textarea", { id, placeholder: n.placeholder, required: n.required }, n.value || "") : h("input", { id, value: n.value ?? "", placeholder: n.placeholder, required: n.required }); set(n.value ?? ""); input.addEventListener("input", () => set(input.value)); break;
    case "Number": case "Money": input = h("input", { id, type: "number", step: "any", value: n.value ?? "", min: n.min, max: n.max, required: n.required, placeholder: n.type === "Money" ? "₹" : "" }); set(n.value ?? null); input.addEventListener("input", () => set(input.value === "" ? null : Number(input.value))); break;
    case "Date": input = h("input", { id, type: "date", value: n.value || "", required: n.required }); set(n.value || ""); input.addEventListener("input", () => set(input.value)); break;
    case "Select": input = h("select", { id, required: n.required }, n.options.map((o) => h("option", { value: o.value, selected: o.value === n.value }, o.label))); set(n.value ?? n.options[0]?.value); input.addEventListener("change", () => set(input.value)); break;
    case "Radio": set(n.value ?? null); return h("div", { class: "field" }, h("label", {}, n.label), h("div", { class: "row" }, n.options.map((o) => h("label", { class: "row", style: "gap:6px" }, h("input", { type: "radio", name: id, value: o.value, checked: o.value === n.value, onchange: () => set(o.value) }), o.label))));
    case "Checkbox": case "Toggle": set(!!n.value); return h("label", { class: "row", style: "gap:8px" }, h("input", { type: "checkbox", checked: !!n.value, onchange: (e) => set(e.target.checked) }), n.label);
  }
  return h("div", { class: "field" }, h("label", { for: id }, n.label), input, n.help && h("span", { class: "help" }, n.help));
}

function node(n, ctx) {
  const kids = () => (n.children || []).map((c) => node(c, ctx));
  switch (n.type) {
    case "Section": return h("section", { class: "col" }, n.title && h("h4", { class: "pc-h3" }, n.title), kids());
    case "Stack": return h("div", { class: `sf-stack ${n.direction === "row" ? "row" : ""}`, style: `gap:${{ s: 8, m: 12, l: 20 }[n.gap] || 12}px` }, kids());
    case "Grid": return h("div", { class: "sf-grid", style: `grid-template-columns:repeat(${n.columns || 2},minmax(0,1fr))` }, kids());
    case "Card": return h("div", { class: `sf-card ${n.hue ? "hue" : ""}`, style: n.hue ? `--hue:${hueVar(n.hue)}` : null }, n.title && h("b", { class: "pc-h3" }, n.title), kids());
    case "Divider": return h("div", { class: "divider" });
    case "Heading": return h(n.level === 3 ? "h4" : "h3", { class: n.level === 3 ? "pc-h3" : "pc-h2" }, n.text);
    case "Text": return h("p", { class: n.tone === "muted" ? "muted" : toneClass(n.tone) === "ok" ? "okc" : toneClass(n.tone) === "bad" ? "badc" : "" }, n.text);
    case "Quote": return h("p", { class: "pc-quote" }, n.text);
    case "Lab": return h("p", { class: "pc-lab" }, n.text);
    case "Receipt": return h("p", { class: "small muted" }, "[ok] ", n.text, n.source && " · ", n.source && h("a", { href: n.source, target: "_blank", rel: "noopener noreferrer", class: "md" }, new URL(n.source).hostname));
    case "Stat": return h("div", { class: "sf-stat col", style: "gap:4px" }, h("p", { class: "pc-lab" }, n.label), h("span", { class: "v num" }, n.value), n.delta && h("span", { class: `d ${n.tone === "down" || n.tone === "bad" ? "down" : n.tone === "up" || n.tone === "ok" ? "up" : "faint"}` }, n.delta));
    case "Meter": return h("div", { class: "col", style: "gap:6px" }, h("div", { class: "spread small" }, h("span", {}, n.label), h("span", { class: "num faint" }, `${fmt(n.value, "number")} / ${fmt(n.max, "number")}${n.unit ? " " + n.unit : ""}`)), h("div", { class: "meter" }, h("b", { style: `width:${Math.min(100, (n.value / (n.max || 1)) * 100)}%;background:${hueVar(n.hue)}` })));
    case "Badge": return h("span", { class: `pc-chip ${toneClass(n.tone)}` }, n.text);
    case "Table": return h("div", { class: "scrollx" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, n.columns.map((c) => h("th", { class: ["number", "money", "percent"].includes(c.format) ? "num" : "" }, c.label)))),
      h("tbody", {}, n.rows.map((r) => h("tr", {}, n.columns.map((c) => h("td", { class: ["number", "money", "percent"].includes(c.format) ? "num" : "" }, fmt(r[c.key], c.format))))))));
    case "List": return h("div", { class: "col", style: "gap:0" }, n.items.map((it, i) => h("div", { class: "spread", style: `padding:10px 0;${i ? "border-top:1px solid var(--line)" : ""}` }, h("div", {}, h("b", {}, it.title), it.detail && h("p", { class: "small muted" }, it.detail)), it.meta && h("span", { class: "pc-m small faint" }, it.meta))));
    case "Timeline": return h("div", { class: "col", style: "gap:8px" }, n.items.map((it) => h("div", { class: "row", style: "gap:10px;align-items:flex-start" }, h("span", { class: "pc-m small faint", style: "min-width:64px" }, it.time || ""), h("span", { class: `pc-chip ${it.state === "done" ? "ok" : it.state === "failed" ? "bad" : it.state === "needs" ? "hot" : ""}` }, it.state || "·"), h("span", {}, it.text))));
    case "BarChart": return barChart(n);
    case "LineChart": return lineChart(n);
    case "Donut": return donut(n);
    case "Sparkline": return sparkline(n);
    case "Compare": return h("div", { class: "scrollx" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th"), n.columns.map((c) => h("th", {}, c)))),
      h("tbody", {}, n.rows.map((r) => h("tr", {}, h("td", { class: "muted" }, r.label), r.values.map((v, i) => h("td", { class: r.winner === i ? "sf-win" : "" }, v)))))));
    case "Form": {
      const values = {};
      const form = h("form", { class: "sf-form" }, n.title && h("b", { class: "pc-h3" }, n.title), (n.children || []).map((c) => (c.type && ["TextField", "Number", "Money", "Date", "Select", "Radio", "Checkbox", "Toggle"].includes(c.type) ? field(c, values) : node(c, ctx))),
        h("div", { class: "row" }, h("button", { class: "pc-pill s", type: "submit" }, n.submitLabel || "Send")));
      form.addEventListener("submit", (e) => { e.preventDefault(); ctx.onAction(n.action, values, form); });
      return form;
    }
    case "Choice": return h("div", { class: "sf-choice" }, n.prompt && h("p", { class: "muted" }, n.prompt), n.options.map((o) => h("button", { type: "button", onclick: (e) => ctx.onAction(n.action, { choice: o.id, label: o.label }, e.currentTarget.parentNode) }, h("b", {}, o.label), o.detail && h("p", { class: "small muted" }, o.detail))));
    default: return h("p", { class: "badc small" }, `Unknown component ${n.type}`);
  }
}

export function renderSurface(s, ctx) {
  return h("div", { class: "surface" }, h("div", { class: "head" }, h("span", { class: "pc-lab" }, "Surface"), h("b", { class: "pc-h3" }, s.spec.title), ctx.extra || null), node(s.spec.root, ctx));
}
