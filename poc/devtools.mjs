// Can a bot debug a local frontend? Serves a buggy page on localhost, then captures console, errors, network, HAR and trace.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { statSync, mkdirSync } from "node:fs";

const pw = createRequire(`${execSync("npm root -g").toString().trim()}/@playwright/mcp/`)("playwright");
const OUT = "/poc/logs/devtools"; mkdirSync(OUT, { recursive: true });

// A stand-in for `npm run dev`: one page with a console error, an uncaught exception, a 404 and a 500.
const html = `<!doctype html><title>My app</title><h1>Checkout</h1><script>
console.log("app boot"); console.warn("deprecated prop 'size'");
fetch("/api/cart").then(r => r.json()).then(c => console.log("cart", c.items));
fetch("/api/price").then(r => { if (!r.ok) console.error("price failed", r.status); });
setTimeout(() => { const u = undefined; u.total; }, 50);
</script>`;
const srv = createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  else if (req.url === "/api/price") { res.writeHead(500); res.end("boom"); }
  else { res.writeHead(404); res.end("not found"); }
}).listen(5173);

const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ recordHar: { path: `${OUT}/session.har` } });
await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
const page = await ctx.newPage();
const consoleMsgs = [], errors = [], network = [];
page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => network.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
page.on("requestfailed", (r) => network.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));
await page.goto("http://localhost:5173/");
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/page.png` });
await ctx.tracing.stop({ path: `${OUT}/trace.zip` });
await ctx.close(); await browser.close(); srv.close();

const size = (f) => `${Math.round(statSync(`${OUT}/${f}`).size / 1024)} KiB`;
console.log("CONSOLE ", JSON.stringify(consoleMsgs));
console.log("ERRORS  ", JSON.stringify(errors));
console.log("NETWORK ", JSON.stringify(network));
console.log("ARTIFACTS", JSON.stringify({ har: size("session.har"), trace: size("trace.zip"), screenshot: size("page.png") }));
const pass = consoleMsgs.some((m) => /price failed 500/.test(m)) && errors.some((e) => /total/.test(e)) && network.some((n) => /^404 GET \/api\/cart/.test(n)) && network.some((n) => /^500 GET \/api\/price/.test(n));
console.log(pass ? "PASS  console, uncaught errors, network status codes, HAR and trace all captured" : "FAIL");
