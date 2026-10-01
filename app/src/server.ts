// Pitcrew control plane: HTTP API, static web app, SSE stream and the live-view bridge.
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import * as A from "./auth.js";
import * as R from "./runtime/index.js";
import { ensureChief } from "./crew.js";
import { send, warm } from "./delivery.js";
import { startCodeSweeper, reapCode } from "./code.js";
import { reapOrphans, startIdleSweeper, startBootSocket, toolManifest } from "./computer.js";
import type { HttpError } from "./auth.js";
import { api } from "./api/index.js";
import { serveRaw } from "./http/raw.js";
import { liveView } from "./http/liveview.js";
import { startEngram } from "./engram.js";

const PORT = Number(process.env.PORT || 8330);
// dist/src/server.js → dist/web, the Vite build.
const WEB = new URL("../web/", import.meta.url).pathname;
const NOVNC = process.env.NOVNC_DIR || "/usr/share/novnc";
const HOST = process.env.PITCREW_HOST || "pitcrew.example.com";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const toApi = getRequestListener(api.fetch);
const server = createServer((req, res) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  const url = new URL(req.url!, "http://x");
  try {
    if (serveRaw(req, res, url, WEB, NOVNC)) return;
  } catch (e) {
    const err = e as HttpError, status = err.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, err.stack);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the pit wall." : err.message });
    return;
  }
  toApi(req, res);
});
server.on("upgrade", liveView);

ensureChief();
A.ensureSetupToken();
R.bootRuntime();
await reapOrphans();
await reapCode();
startCodeSweeper();
startEngram();
startIdleSweeper(R.isBusy, R.isThinking);
startBootSocket(R.computerHooks);
toolManifest().then((m) => console.log(`tool manifest: ${m.browser.length} browser, ${m.computer.length} pixel`)).catch((e) => console.error("tool manifest failed:", e.message));
// Before a web build (local dev) there is nothing to warm, and static requests 404.
server.listen(PORT, () => { console.log(`pitcrew control plane on :${PORT} (${HOST})`); if (existsSync(WEB)) for (const f of readdirSync(WEB, { recursive: true }) as string[]) warm(join(WEB, f)); });
