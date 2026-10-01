// Line diff (Myers, O((N+M)·D)). Runs in the browser per opened file; the unit tests use it too.

export type DiffOp = { t: " " | "+" | "-"; a?: number; b?: number; text: string };

const MAX_LINES = 20000, MAX_D = 3000;

/** The edit script turning lines `a` into lines `b`, or null when it's too large to compute here. */
export function diffLines(a: string[], b: string[]): DiffOp[] | null {
  const N = a.length, M = b.length;
  if (N + M > MAX_LINES) return null;
  const max = N + M, off = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
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

function backtrack(trace: Int32Array[], a: string[], b: string[], off: number, dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
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

/** Groups ops into hunks with `ctx` lines of context; long unchanged runs collapse. */
export function hunks(ops: DiffOp[], ctx = 3): DiffOp[][] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== " ") for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = true; });
  const out: DiffOp[][] = []; let cur: DiffOp[] | null = null;
  ops.forEach((o, i) => { if (keep[i]) (cur ||= []).push(o); else if (cur) { out.push(cur); cur = null; } });
  if (cur) out.push(cur);
  return out;
}
