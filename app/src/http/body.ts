// Request bodies: read under a size cap, parsed as JSON, then shaped by a zod schema. The schema helpers coerce
// rather than reject, so a sloppy field gets the same default or clamp it always did, never a validation error.
import { z } from "zod";
import type { Context } from "hono";
import { httpErr } from "../auth.js";

export async function readBody(c: Context, limit = 1 << 20) {
  const chunks: Uint8Array[] = []; let n = 0;
  if (c.req.raw.body) for await (const ch of c.req.raw.body) { n += ch.length; if (n > limit) throw httpErr(413, "Too large"); chunks.push(ch); }
  return Buffer.concat(chunks);
}
// An empty body reads as {}; so does JSON that isn't an object.
export async function readJson(c: Context): Promise<Record<string, any>> {
  const b = await readBody(c);
  let v: unknown;
  try { v = b.length ? JSON.parse(b.toString()) : {}; } catch { throw httpErr(400, "Bad JSON"); }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}
export const jsonBody = async <S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> => schema.parse(await readJson(c));

// A field shaped by fn, which also sees undefined when the field wasn't sent.
export const field = <T>(fn: (v: any) => T) => z.unknown().optional().transform(fn);
// The field as sent.
export const raw = z.unknown().optional();
// String(v || fallback), cut to max.
export const text = (max = Infinity, fallback = "") => field((v) => String(v || fallback).slice(0, max));
export const trimmed = (max: number) => field((v) => String(v || "").trim().slice(0, max));
export const flag = field((v) => !!v);
// v when it's one of the list, else the fallback.
export const pick = <T extends string, F>(list: readonly T[], fallback: F) => field((v): T | F => (list.includes(v) ? v : fallback));
// fn(v) when the field was sent at all, else undefined.
export const given = <T>(fn: (v: any) => T) => field((v) => (v === undefined ? undefined : fn(v)));
// fn(v) when the field is truthy, else undefined.
export const truthy = <T>(fn: (v: any) => T) => field((v) => (v ? fn(v) : undefined));
