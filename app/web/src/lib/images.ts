// Image versions in one thread, rebuilt from its events: which image came from which, and which the driver kept.
import type { ThreadEvent } from "../../../shared/types";

export interface Img { id: string; path: string; parentId: string | null; botId: string; caption: string; at: number }
export interface ImageIndex { byId: Map<string, Img>; kept: Set<string>; latest: Img | null; chain: (id: string) => Img[] }

export function indexImages(events: ThreadEvent[]): ImageIndex {
  const byId = new Map<string, Img>(), kept = new Set<string>();
  let latest: Img | null = null;
  for (const e of events) {
    if (e.kind === "image") (e.data.paths as string[] || []).forEach((path, i) => {
      // Images from before versions existed have no id; they show, but can't be kept or traced.
      const im = { id: e.data.ids?.[i] || `p:${path}`, path, parentId: e.data.parentId ?? null, botId: e.data.botId, caption: e.data.caption || "", at: e.ts };
      byId.set(im.id, im); latest = im;
    });
    else if (e.kind === "system" && e.data.kept) kept.add(e.data.kept);
  }
  // Root first; a parent outside the loaded events ends the chain there.
  const chain = (id: string) => { const out: Img[] = []; const seen = new Set<string>(); let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out; };
  return { byId, kept, latest, chain };
}

export const imgName = (p: string) => p.split("/").pop()!.replace(/\.\w+$/, "");
export const imgSrc = (im: Pick<Img, "botId" | "path">) => `/files/${im.botId}/${im.path}?inline=1`;
