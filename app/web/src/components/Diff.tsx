// A file's change as unified or side-by-side hunks. The diff runs once per opened file (memoised on its texts).
import { useMemo } from "react";
import { diffLines, hunks, type DiffOp } from "../../../shared/diff";

const Ln = ({ n }: { n?: number }) => <span className="ln">{n == null ? "" : String(n + 1)}</span>;

/** Pairs a hunk's deletions with the additions that follow them, so a changed line sits beside its old self. */
function splitRows(hk: DiffOp[]): [DiffOp | null, DiffOp | null][] {
  const rows: [DiffOp | null, DiffOp | null][] = [];
  let i = 0;
  while (i < hk.length) {
    if (hk[i].t === " ") { rows.push([hk[i], hk[i]]); i++; continue; }
    const del: DiffOp[] = [], add: DiffOp[] = [];
    while (i < hk.length && hk[i].t === "-") del.push(hk[i++]);
    while (i < hk.length && hk[i].t === "+") add.push(hk[i++]);
    for (let j = 0; j < Math.max(del.length, add.length); j++) rows.push([del[j] || null, add[j] || null]);
  }
  return rows;
}

export function Diff({ before, after, split }: { before: string | null | undefined; after: string | null | undefined; split: boolean }) {
  const ops = useMemo(() => diffLines((before ?? "").split("\n"), (after ?? "").split("\n")), [before, after]);
  if (!ops) return <p className="empty">This change is too large to diff here. Download the file instead.</p>;
  const added = ops.filter((o) => o.t === "+").length, removed = ops.filter((o) => o.t === "-").length;
  const hs = hunks(ops);
  return (
    <div className="diff">
      <p className="pc-m small faint" style={{ padding: "8px 12px" }}>{`+${added} −${removed}`}</p>
      {!hs.length && <p className="empty">No line changes (metadata only).</p>}
      {hs.map((hk, k) => split
        ? <div key={k} className="hunk split">{splitRows(hk).map(([l, r], i) => (
            <div key={i} className="row2">
              <div className={`cell ${l ? (l.t === "-" ? "del" : "") : "pad"}`}><Ln n={l?.a} /><code>{l?.text ?? ""}</code></div>
              <div className={`cell ${r ? (r.t === "+" ? "add" : "") : "pad"}`}><Ln n={r?.b} /><code>{r?.text ?? ""}</code></div>
            </div>))}
          </div>
        : <div key={k} className="hunk">{hk.map((o, i) => (
            <div key={i} className={`dl ${o.t === "+" ? "add" : o.t === "-" ? "del" : ""}`}><Ln n={o.a} /><Ln n={o.b} /><span className="sg">{o.t}</span><code>{o.text}</code></div>))}
          </div>)}
    </div>
  );
}
