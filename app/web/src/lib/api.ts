// Every API call goes through here: the X-Pitcrew header (the server's CSRF check), JSON, error toasts, and 401 → sign in.
import { toast } from "./toast";

let onSignedOut: () => void = () => {};
export const whenSignedOut = (fn: () => void) => { onSignedOut = fn; };

interface Opts { raw?: boolean; quiet?: boolean }

async function call<T>(method: string, path: string, body?: unknown, { raw = false, quiet = false }: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Pitcrew": "1" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    if (raw) init.body = body as BodyInit;
    else { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) { onSignedOut(); throw new Error("Sign in"); }
  if (!res.ok) {
    const e = new Error((data as { error?: string }).error || `Error ${res.status}`);
    if (!quiet) toast(e.message, true);
    throw e;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, o?: Opts) => call<T>("GET", path, undefined, o),
  post: <T = { ok: boolean }>(path: string, body?: unknown, o?: Opts) => call<T>("POST", path, body, o),
  put: <T = { ok: boolean }>(path: string, body?: unknown, o?: Opts) => call<T>("PUT", path, body, o),
  patch: <T = { ok: boolean }>(path: string, body?: unknown, o?: Opts) => call<T>("PATCH", path, body, o),
  del: <T = { ok: boolean }>(path: string, o?: Opts) => call<T>("DELETE", path, undefined, o),
};

/** Workspace file URL; each path segment is encoded so names with spaces or # survive. */
export const fileUrl = (botId: string, path: string) => `/files/${botId}/${path.split("/").map(encodeURIComponent).join("/")}`;
