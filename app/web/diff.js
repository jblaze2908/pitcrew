// Line diff (Myers, O((N+M)·D)) and a renderer with unified and split views. Runs in the browser per opened file.
import { h } from "./surface.js";

const MAX_LINES = 20000, MAX_D = 3000;

export function diffLines(a, b) {
  const N = a.length, M = b.length;
  if (N + M > MAX_LINES) return null;
  const max = N + M, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, off, d);
    }
  }
  return null;
}
function backtrack(trace, a, b, off, dEnd) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + prevK], py = px - prevK;
    while (x > px && y > py) { ops.push({ t: " ", a: x - 1, b: y - 1, text: a[x - 1] }); x--; y--; }
    if (x === px) ops.push({ t: "+", b: y - 1, text: b[y - 1] }); else ops.push({ t: "-", a: x - 1, text: a[x - 1] });
    x = px; y = py;
  }
  while (x > 0 && y > 0) { ops.push({ t: " ", a: x - 1, b: y - 1, text: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

// Groups ops into hunks with `ctx` lines of context; long unchanged runs collapse.
function hunks(ops, ctx = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== " ") for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = true; });
  const out = []; let cur = null;
  ops.forEach((o, i) => { if (keep[i]) { (cur ||= []).push(o); } else if (cur) { out.push(cur); cur = null; } });
  if (cur) out.push(cur);
  return out;
}

export function renderDiff(beforeText, afterText, { split = false } = {}) {
  const a = (beforeText ?? "").split("\n"), b = (afterText ?? "").split("\n");
  const ops = diffLines(a, b);
  if (!ops) return h("p", { class: "empty" }, "This change is too large to diff here. Download the file instead.");
  const added = ops.filter((o) => o.t === "+").length, removed = ops.filter((o) => o.t === "-").length;
  const hs = hunks(ops);
  const num = (n) => h("span", { class: "ln" }, n == null ? "" : String(n + 1));
  const body = split
    ? hs.map((hk) => {
        const rows = []; let i = 0;
        while (i < hk.length) {
          if (hk[i].t === " ") { rows.push([hk[i], hk[i]]); i++; continue; }
          const del = [], add = [];
          while (i < hk.length && hk[i].t === "-") del.push(hk[i++]);
          while (i < hk.length && hk[i].t === "+") add.push(hk[i++]);
          for (let j = 0; j < Math.max(del.length, add.length); j++) rows.push([del[j] || null, add[j] || null]);
        }
        return h("div", { class: "hunk split" }, rows.map(([l, r]) => h("div", { class: "row2" },
          h("div", { class: `cell ${l ? (l.t === "-" ? "del" : "") : "pad"}` }, num(l?.a), h("code", {}, l?.text ?? "")),
          h("div", { class: `cell ${r ? (r.t === "+" ? "add" : "") : "pad"}` }, num(r?.b), h("code", {}, r?.text ?? "")))));
      })
    : hs.map((hk) => h("div", { class: "hunk" }, hk.map((o) => h("div", { class: `dl ${o.t === "+" ? "add" : o.t === "-" ? "del" : ""}` }, num(o.a), num(o.b), h("span", { class: "sg" }, o.t), h("code", {}, o.text)))));
  return h("div", { class: "diff" }, h("p", { class: "pc-m small faint", style: "padding:8px 12px" }, `+${added} −${removed}`), ...(body.length ? body : [h("p", { class: "empty" }, "No line changes (metadata only).")]));
}
