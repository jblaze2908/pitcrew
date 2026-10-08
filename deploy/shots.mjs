// UI review screenshots of the live site, taken on the server with a temporary session (deleted after).
//   docker run --rm --network host -v /srv/pitcrew/data:/data -v /root/pitcrew-app/shots:/out --entrypoint node pitcrew-computer:1 /opt/shots.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";

const pw = createRequire(`${execSync("npm root -g").toString().trim()}/@playwright/mcp/`)("playwright");
const BASE = process.env.BASE || `https://${process.env.PITCREW_HOST}`;
const db = new DatabaseSync("/data/pitcrew.db");
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
db.prepare("INSERT INTO sessions(hash,created_at,expires_at) VALUES(?,?,?)").run(hash, Date.now(), Date.now() + 600e3);
const pages = (process.env.PAGES || "#/,#/pitstops,#/telemetry,#/settings,#/hire,#/library").split(",");
try {
  const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  for (const [w, hgt, tag] of [[1440, 900, "desk"], [390, 844, "phone"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: "pc_s", value: token, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    for (const p of pages) {
      if (tag === "phone" && !["#/", "#/pitstops"].includes(p) && !p.startsWith("#/t/")) continue;
      await page.goto(`${BASE}/${p}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(p.startsWith("#/live") ? 14000 : 900);
      const name = `${tag}-${p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "wall"}.png`;
      await page.screenshot({ path: `/out/${name}`, fullPage: false });
      console.log("shot", name);
    }
    if (errs.length) console.log("page errors:", [...new Set(errs)].slice(0, 8).join(" | "));
    await ctx.close();
  }
  await browser.close();
} finally {
  db.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
}
