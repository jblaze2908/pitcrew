// Measures each browser engine on the same pages: peak RSS of its whole process tree, load time, and ability.
import { createRequire } from "node:module";
import { execSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const root = execSync("npm root -g").toString().trim();
const pw = createRequire(`${root}/@playwright/mcp/`)("playwright");
const PAGES = ["https://httpbin.org/forms/post", "https://en.wikipedia.org/wiki/Bengaluru", "https://news.ycombinator.com", "https://github.com/microsoft/playwright"];

// Sum RSS (KiB) of pid and all descendants, read straight from /proc.
function treeRssKiB(pid) {
  const kids = {};
  for (const d of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { const ppid = readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ")[1]; (kids[ppid] ||= []).push(d); } catch {}
  }
  let total = 0; const stack = [String(pid)];
  while (stack.length) {
    const p = stack.pop();
    try { total += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1] || 0); } catch {}
    stack.push(...(kids[p] || []));
  }
  return total;
}

const cg = (f) => { try { return Number(readFileSync(`/sys/fs/cgroup/${f}`, "utf8").trim().split(/\s/)[0]); } catch { return NaN; } };
async function run(name, open) {
  const base = cg("memory.current");
  const t0 = Date.now();
  const { browser, pid, close } = await open();
  const bootMs = Date.now() - t0;
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let peak = treeRssKiB(pid); const loads = [];
  const sampler = setInterval(() => { peak = Math.max(peak, treeRssKiB(pid)); }, 100);
  for (const url of PAGES) {
    const s = Date.now();
    try { await page.goto(url, { waitUntil: name === "lightpanda" ? "domcontentloaded" : "load", timeout: 30000 }); loads.push(`${Date.now() - s}ms`); }
    catch (e) { loads.push(`ERR ${e.message.split("\n")[0].slice(0, 40)}`); }
  }
  let form = "fail";
  try {
    await page.goto(PAGES[0], { waitUntil: name === "lightpanda" ? "domcontentloaded" : "load", timeout: 30000 });
    await page.fill("input[name=custname]", "Pitcrew Probe");
    await page.check("input[value=medium]"); await page.check("input[value=onion]");
    await Promise.all([page.waitForURL(/\/post$/, { timeout: 20000 }), page.click("button")]);
    form = /Pitcrew Probe/.test(await page.content()) ? "ok" : "no-echo";
  } catch (e) { form = `fail: ${e.message.split("\n")[0].slice(0, 50)}`; }
  let shot = "no";
  try { const b = await page.screenshot({ timeout: 10000 }); shot = b.length > 1000 ? "yes" : "empty"; } catch (e) { shot = `no (${e.message.split("\n")[0].slice(0, 30)})`; }
  clearInterval(sampler);
  const settled = treeRssKiB(pid);
  await close();
  const cgPeak = cg("memory.peak");
  console.log(JSON.stringify({ engine: name, boot_ms: bootMs, cgroup_peak_over_base_mib: Math.round((cgPeak - base) / 1048576), rss_tree_peak_mib: Math.round(peak / 1024), rss_tree_settled_mib: Math.round(settled / 1024), loads, form, screenshot: shot }));
}

const launch = (type) => async () => {
  const browser = await pw[type].launch({ headless: true, args: type === "chromium" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [] });
  const pid = browser.process?.()?.pid ?? (await browser.newBrowserCDPSession?.().catch(() => null), null);
  return { browser, pid, close: () => browser.close() };
};
// Firefox/WebKit via launchServer so the browser pid is known.
const launchServer = (type) => async () => {
  const server = await pw[type].launchServer({ headless: true });
  const browser = await pw[type].connect(server.wsEndpoint());
  return { browser, pid: server.process().pid, close: async () => { await browser.close(); await server.close(); } };
};
const lightpanda = async () => {
  const proc = spawn("lightpanda", ["serve", "--host", "127.0.0.1", "--port", "9222"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:9222/json/version"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9222");
  return { browser, pid: proc.pid, close: async () => { await browser.close().catch(() => {}); proc.kill(); } };
};

const only = process.argv[2];
const engines = { chromium: launchServer("chromium"), firefox: launchServer("firefox"), webkit: launchServer("webkit"), lightpanda };
for (const [name, open] of Object.entries(engines)) {
  if (only && only !== name) continue;
  try { await run(name, open); } catch (e) { console.log(JSON.stringify({ engine: name, error: e.message.split("\n")[0].slice(0, 120) })); }
}
