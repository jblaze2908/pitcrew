// Image versions in one thread, rebuilt from its events: which image came from which, and which the driver kept.
import type { ThreadEvent } from "../../../shared/types";
import { fileUrl } from "./api";

export interface Img { id: string; path: string; parentId: string | null; botId: string; caption: string; at: number; model?: string; cost?: number | null }
export interface ImageIndex { byId: Map<string, Img>; all: Img[]; kept: Set<string>; latest: Img | null; edited: Set<string>;
  chain: (id: string) => Img[]; family: (id: string) => Img[] }

export function indexImages(events: ThreadEvent[]): ImageIndex {
  const byId = new Map<string, Img>(), kept = new Set<string>(), edited = new Set<string>(), all: Img[] = [];
  let latest: Img | null = null;
  for (const e of events) {
    if (e.kind === "image") (e.data.paths as string[] || []).forEach((path, i) => {
      // Images from before versions existed have no id; they show, but can't be kept or traced.
      const im: Img = { id: e.data.ids?.[i] || `p:${path}`, path, parentId: e.data.parentId ?? null, botId: e.data.botId, caption: e.data.caption || "", at: e.ts, model: e.data.model, cost: e.data.cost };
      byId.set(im.id, im); all.push(im); latest = im;
      if (im.parentId) edited.add(im.parentId);
    });
    else if (e.kind === "system" && e.data.kept) kept.add(e.data.kept);
  }
  // Root first; a parent outside the loaded events ends the chain there.
  const chain = (id: string) => { const out: Img[] = []; const seen = new Set<string>(); let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out; };
  // Every version sharing this image's root, oldest first (siblings from "More like this" included).
  const family = (id: string) => { const root = chain(id)[0]?.id; return root ? all.filter((im) => chain(im.id)[0]?.id === root) : []; };
  return { byId, all, kept, latest, edited, chain, family };
}

export const imgName = (p: string) => p.split("/").pop()!.replace(/\.\w+$/, "");
export const imgFile = (im: Pick<Img, "botId" | "path">) => fileUrl(im.botId, im.path);
export const imgSrc = (im: Pick<Img, "botId" | "path">) => `${imgFile(im)}?inline=1`;
export const isImagePath = (p: string) => /\.(png|jpe?g|webp|gif)$/i.test(p);
/** An uploaded attachment's name without the random prefix the upload route adds. */
export const attachmentName = (p: string) => p.split("/").pop()!.replace(/^[a-z0-9]+-/, "");
export const imgMeta = (im: Img) => [im.model, im.cost != null ? `$${Number(im.cost).toFixed(3)}` : null].filter(Boolean).join(" · ");
