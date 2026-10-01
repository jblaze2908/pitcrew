// Browser-use safety boundaries, adversarial and synthetic only: site policy, look-alikes, private ranges, checkout guard,
// confirmation alerts, host-scoped standing approvals, shadow jev. No Docker, no network (fetch is stubbed where jev runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { domainToASCII } from "node:url";

const root = mkdtempSync(`${tmpdir()}/pitcrew-sites-`);
mkdirSync(`${root}/data`);
writeFileSync(`${root}/chrome-policy.json`, JSON.stringify({ URLBlocklist: ["file://*"], SSLErrorOverrideAllowed: false }));
Object.assign(process.env, { PITCREW_ROOT: root, PITCREW_DATA: `${root}/data`, PITCREW_CHROME_POLICY: `${root}/chrome-policy.json` });
const S = await import("../app/dist/src/sites.js");
const D = await import("../app/dist/src/domains.js");
const J = await import("../app/dist/src/jev.js");
const R = await import("../app/dist/src/runtime/index.js");
const { run, one, all, json } = await import("../app/dist/src/db.js");

const b = { id: "b_site", name: "Scout", policy: J.DEFAULT_POLICY };
run("INSERT INTO bots(id,name,created_at) VALUES('b_site','Scout',0)");
const thread = (id) => run("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,?,0,0)", id, b.id, id);
const browser = (tool, args) => ({ kind: "mcp", server: "browser", tool, arguments: args });
const at = (url, element, tool = "browser_click") => browser(tool, { target: "e1", page_url: url, grounded_elements: [{ ref: "e1", element }] });
const fill = (url, name) => browser("browser_fill_form", { fields: [{ name, target: "e1", value: "x" }], page_url: url, grounded_elements: [{ ref: "e1", element: `textbox "${name}"` }] });
const pending = () => one("SELECT * FROM pitstops WHERE status='pending' ORDER BY rowid DESC LIMIT 1");
const flush = () => new Promise((r) => setImmediate(r));
const fakeMcp = () => { const m = { calls: [], request: async (_, p) => { m.calls.push(p); return {}; } }; return m; };

test("checkout pages get no rule allow: Next on /checkout/payment, Close beside a CVV field", () => {
  const next = at("https://shop.example/checkout/payment", 'button "Next"');
  assert.equal(J.ruleVerdict(next), null);
  assert.equal(J.ruleVerdict(at("https://shop.example/products", 'button "Next"')).decision, "allow");
  const g = R.ground({ url: "https://shop.example/step/2", lines: ['- textbox "CVV" [ref=e2]', '- button "Close" [ref=e3]'] }, "browser_click", { target: "e3" });
  assert.match(g.grounded.page_checkout, /CVV/);
  assert.equal(J.ruleVerdict(browser("browser_click", g.grounded)), null);
  // A declared plain link click there goes to jev too; a declared pay still asks; observing stays a rule allow.
  assert.equal(J.ruleVerdict({ ...at("https://pay.example/checkout", 'link "Help"'), effect: "browse" }), null);
  assert.equal(J.ruleVerdict({ ...next, effect: "pay" }).decision, "ask");
  assert.equal(J.ruleVerdict(browser("browser_snapshot", { page_url: "https://shop.example/checkout" })).decision, "allow");
  for (const url of ["https://checkout.stripe.com/c/pay/x", "https://api.razorpay.com/v1/x"]) assert.equal(J.ruleVerdict(at(url, 'button "Close"')), null, url);
  assert.equal(S.checkoutWhy({ url: "https://example.com/", title: "Your cart" }), '"cart" in the page title');
});

test("look-alikes and punycode homographs become a warned domain pit stop, never an allow", async () => {
  for (const [url, brand] of [["https://paypa1.com/login", "PayPal"], [`https://${domainToASCII("аpple.com")}/`, "Apple"], [`https://${domainToASCII("аррӏе.com")}/`, "Apple"], ["https://paypal.com.evil.example/", "PayPal"]]) {
    const v = D.siteVerdict(b, "t_look", url, { navigating: true });
    assert.equal(v.action, "ask", url); assert.ok(v.warn, url); assert.match(v.title, new RegExp(`looks like ${brand}`), url);
  }
  assert.equal(S.lookalike("www.paypal.com"), null); assert.equal(S.homograph("example.com"), null);
  thread("t_look");
  const step = R.siteStep(b, "t_look", browser("browser_navigate", { url: "https://paypa1.com/login" }));
  await flush();
  const ps = pending();
  assert.deepEqual([ps.kind, ps.effect, ps.thread_id], ["site", "ask", "t_look"]); assert.match(ps.title, /looks like PayPal/);
  await R.decide(ps.id, "deny");
  assert.equal(await step, null);
  assert.equal(D.siteFor(b.id, "paypa1.com").mode, "unknown"); // a plain denial stores nothing
});

test("private, link-local, metadata and host-gateway addresses are refused; loopback and about:blank are not", async () => {
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://172.17.0.1:8330/api/state", "http://2852039166/", "http://[::ffff:a9fe:a9fe]/", "http://10.0.0.5/", "http://192.168.1.1/", "http://100.64.0.1/", "http://[fd00:ec2::254]/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"])
    assert.equal(D.siteVerdict(b, "t_priv", u, { navigating: true }).action, "refuse", u);
  for (const u of ["http://127.0.0.1:7780/out/report.html", "http://localhost:7780/", "about:blank"]) assert.equal(D.siteVerdict(b, "t_priv", u, { navigating: true }).action, "go", u);
  thread("t_priv");
  assert.equal(await R.siteStep(b, "t_priv", browser("browser_navigate", { url: "http://172.17.0.1:8330/" })), null);
  assert.ok(all("SELECT data FROM events WHERE thread_id='t_priv'").some((e) => /private network address/.test(json(e.data).text)));
});

test("plain http is flagged where the agent types; sensitive pit stops name the registrable domain", () => {
  D.setSite(b.id, "example.org", "allowed");
  const v = D.siteVerdict(b, "t_http", "http://example.org/login", { typing: true });
  assert.equal(v.policy.draft, "ask"); assert.equal(D.siteTag(v.site), "on example.org, NOT https");
  assert.equal(J.ruleVerdict(fill("http://example.org/login", "Email"), v.policy).decision, "ask");
  assert.equal(J.ruleVerdict(fill("https://example.org/login", "Email"), D.siteVerdict(b, "t_http", "https://example.org/login", { typing: true }).policy).decision, "allow");
  assert.match(D.siteVerdict(b, "t_http", "http://login.unknown-bank.example/", { navigating: true }).title, /NOT https, first visit/);
  assert.equal(D.siteTag(S.siteOf("https://accounts.example.co.uk/")), "on example.co.uk (accounts.example.co.uk), https");
});

test("an order-confirmation page raises one bad-tone alert and an audit entry", async () => {
  thread("t_conf");
  const args = { tool: "browser_click", text: "### Page\n- Page URL: https://shop.example/thanks\n- Page Title: Order confirmed", snap: '- heading "Thank you for your order!"\n- text: "Order number: AB12345"', url: "https://shop.example/thanks", before: "https://shop.example/checkout" };
  await R.afterAction(b, "t_conf", "cx_conf", fakeMcp(), args);
  await R.afterAction(b, "t_conf", "cx_conf", fakeMcp(), { ...args, before: args.url });
  const alerts = all("SELECT data FROM events WHERE thread_id='t_conf' AND kind='system'").map((e) => json(e.data)).filter((d) => /confirmation/.test(d.text));
  assert.equal(alerts.length, 1); assert.equal(alerts[0].tone, "bad");
  assert.ok(all("SELECT data FROM audit WHERE action='page.confirmation'").some((r) => json(r.data).host === "shop.example"));
  assert.equal(S.confirmationOf("Your orders: view receipts"), null);
});

test("a standing approval granted on a.example never covers b.example", () => {
  const signin = (host, element = 'textbox "Password"') => browser("browser_fill_form", { fields: [{ name: "Password", target: "e1", value: "x" }], page_url: `https://${host}/login`, grounded_elements: [{ ref: "e1", element }] });
  const rule = (match) => run("INSERT INTO rules(id,bot_id,thread_id,effect,match,label,created_at) VALUES(?,?,NULL,'signin',?,?,0)", `ru_${Math.random()}`, b.id, match, match);
  rule(R.pattern(signin("a.example")));
  assert.ok(R.standingRule(b.id, null, signin("a.example"), "signin"));
  assert.equal(R.standingRule(b.id, null, signin("b.example"), "signin"), undefined);
  // One stored by signature (an ungrounded approval) covers no browser action at all.
  rule("mcp:browser/browser_fill_form");
  assert.equal(R.standingRule(b.id, null, signin("b.example", "(not in the last snapshot)"), "signin"), undefined);
});

test("unknown domain asks; allow once stays in its thread; block refuses and undoes a redirect landing", async () => {
  thread("t_once"); thread("t_other");
  const step = R.siteStep(b, "t_once", browser("browser_navigate", { url: "https://news.example/a" }));
  await flush();
  const ps = pending();
  assert.match(ps.title, /Scout wants to open news\.example \(https, first visit\)/);
  await R.decide(ps.id, "approve", { scope: "thread" });
  assert.equal((await step).action, "go");
  assert.equal(D.siteFor(b.id, "news.example", "t_once").mode, "allowed");
  assert.equal(D.siteFor(b.id, "news.example", "t_other").mode, "unknown");
  assert.equal(one("SELECT COUNT(*) n FROM sites WHERE domain='news.example'").n, 0);

  const step2 = R.siteStep(b, "t_other", browser("browser_navigate", { url: "https://bad.example/" }));
  await flush();
  await R.decide(pending().id, "deny", { scope: "block" });
  assert.equal(await step2, null);
  assert.equal(D.siteFor(b.id, "www.bad.example").mode, "blocked");
  assert.equal(await R.siteStep(b, "t_other", browser("browser_navigate", { url: "https://bad.example/again" })), null);
  // A click elsewhere that redirected onto it: the browser goes back; a popup tab onto it is closed.
  const m = fakeMcp();
  const note = await R.afterAction(b, "t_other", "cx_other", m, { tool: "browser_click", text: "- Page URL: https://bad.example/landing", url: "https://bad.example/landing", before: "https://news.example/a" });
  assert.equal(m.calls[0].name, "browser_navigate_back"); assert.match(note, /^Blocked: /);
  const m2 = fakeMcp();
  await R.afterAction(b, "t_other", "cx_other", m2, { tool: "browser_click", text: "### Open tabs\n- 0: [A](https://news.example/a)\n- 1: (current) [B](https://bad.example/)", url: "https://bad.example/", before: "https://news.example/a", tabsBefore: 1 });
  assert.deepEqual(m2.calls[0], { name: "browser_tabs", arguments: { action: "close" } });
});

test("fully allowed site: send allowed, pay still asks; a send:ask override beats the member and jev", async () => {
  const full = D.siteVerdict(b, "t_x", "https://excalidraw.com/", {}); // seeded preset
  assert.equal(full.full, true);
  assert.equal(J.ruleVerdict({ ...at("https://excalidraw.com/", 'button "Share"'), effect: "send" }, full.policy).decision, "allow");
  assert.equal(J.ruleVerdict({ ...at("https://excalidraw.com/", 'button "Pay"'), effect: "pay" }, full.policy).decision, "ask");
  assert.equal(D.effectivePolicy(J.DEFAULT_POLICY, { mode: "allowed", entry: { overrides: { pay: "allow" } } }).pay, "ask");
  const loose = { ...b, policy: { ...J.DEFAULT_POLICY, send: "allow" } };
  D.setSite(b.id, "twitter.com", "allowed", { send: "ask" });
  const tw = D.siteVerdict(loose, "t_x", "https://twitter.com/home", {});
  assert.equal(tw.policy.send, "ask");
  const post = R.ground({ url: "https://twitter.com/home", lines: ['- button "Post" [ref=e5]'] }, "browser_click", { target: "e5" });
  assert.equal(J.ruleVerdict({ ...browser("browser_click", post.grounded), effect: post.effect }, tw.policy).decision, "ask");
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ model: "jev-test", answers: { effect: { choice: "send", confidence: 0.99, probabilities: { send: 0.99 } }, outside: { noul: 0.1 } } }) });
  try { assert.equal((await J.jev(browser("browser_click", post.grounded), { policy: tw.policy, apiKey: "test" })).decision, "ask"); } finally { globalThis.fetch = real; }
});

test("a crew-wide block beats a member allow; a subdomain entry beats its domain's; the browser gets the same list", () => {
  D.setSite("global", "facebook.com", "blocked"); D.setSite(b.id, "facebook.com", "allowed");
  assert.equal(D.siteFor(b.id, "m.facebook.com").mode, "blocked");
  D.setSite(b.id, "example.net", "blocked"); D.setSite(b.id, "docs.example.net", "allowed");
  assert.equal(D.siteFor(b.id, "docs.example.net").mode, "allowed"); assert.equal(D.siteFor(b.id, "www.example.net").mode, "blocked");
  const mount = D.policyMount(b.id);
  assert.deepEqual(mount, ["-v", `${root}/policy/${b.id}:${D.POLICY_DIR}:ro`]);
  const file = `${root}/policy/${b.id}/pitcrew.json`, p = JSON.parse(readFileSync(file, "utf8")), ino = statSync(file).ino;
  assert.ok(p.URLBlocklist.includes("file://*") && p.URLBlocklist.includes("facebook.com") && p.URLBlocklist.includes("example.net"), JSON.stringify(p));
  assert.deepEqual(p.URLAllowlist, ["docs.example.net"]);
  D.setSite(b.id, "later.example", "blocked");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).URLBlocklist.includes("later.example")); assert.equal(statSync(file).ino, ino); // rewritten in place for the bind mount
});

test("seeded read sites browse freely but fills and posts ask; a deleted preset stays deleted", async () => {
  assert.equal(D.listSites("global").find((r) => r.domain === "developer.mozilla.org")?.by, "preset");
  assert.equal(D.siteFor(b.id, "mozilla.org").mode, "unknown");
  for (const call of [browser("browser_navigate", { url: "https://medium.com/@x/post" }), browser("browser_snapshot", { page_url: "https://medium.com/@x/post" })]) assert.equal((await R.siteStep(b, "t_x", call)).action, "go");
  const scroll = await R.siteStep(b, "t_x", { kind: "mcp", server: "computer", tool: "scroll", arguments: { direction: "down", page_url: "https://medium.com/@x/post" } });
  const read = D.siteVerdict(b, "t_x", "https://medium.com/@x/post", { typing: true });
  assert.equal(scroll.action, "go"); assert.equal(read.policy.browse, "allow");
  assert.equal(J.ruleVerdict(fill("https://medium.com/new-story", "Title"), read.policy).decision, "ask");
  assert.equal(J.ruleVerdict({ ...at("https://medium.com/new-story", 'button "Publish"'), effect: "send" }, { ...read.policy }).decision, "ask");
  assert.equal(D.effectivePolicy({ ...J.DEFAULT_POLICY, signin: "allow", send: "allow" }, { mode: "read" }).send, "ask");
  D.removeSite("global", "medium.com");
  const again = await import("../app/dist/src/domains.js?restarted");
  assert.equal(again.seedPresets(), 0);
  assert.equal(again.siteFor(b.id, "medium.com").mode, "unknown");
});

test("shadow jev records agreement on rule allows, never blocks the call, and drops past its bound", async () => {
  const real = globalThis.fetch, gates = [];
  globalThis.fetch = () => new Promise((res) => gates.push(() => res({ ok: true, json: async () => ({ model: "jev-test", answers: { effect: { choice: "send", confidence: 0.9, probabilities: { send: 0.9 } }, outside: { noul: 0.8 } } }) })));
  try {
    const sh = { kind: "shell", command: "/bin/sh -lc 'ls /bot/work'" }, v = J.ruleVerdict(sh);
    const ids = Array.from({ length: 6 }, (_, i) => `jl_sh${i}`);
    ids.forEach((id) => R.logDecision(null, b.id, v, sh, { id }));
    const runs = ids.map((id) => R.shadowVerify(id, sh, v, J.DEFAULT_POLICY));
    assert.equal(runs.filter(Boolean).length, 4); // PITCREW_JEV_SHADOW_MAX default
    gates.forEach((g) => g()); await Promise.all(runs.filter(Boolean));
    const s0 = json(one("SELECT shadow FROM jev_labels WHERE id='jl_sh0'").shadow);
    assert.deepEqual([s0.effect, s0.decision, s0.agree, s0.sameEffect], ["send", "ask", false, false]);
    assert.equal(one("SELECT shadow FROM jev_labels WHERE id='jl_sh5'").shadow, null);
    assert.equal(R.shadowVerify("jl_x", sh, { ...v, by: "jev:x" }, J.DEFAULT_POLICY), null); // only rule allows are shadowed
  } finally { globalThis.fetch = real; }
});

test("registrable domains use the bundled suffix subset", () => {
  for (const [h, d] of [["a.b.example.co.uk", "example.co.uk"], ["shop.example.co.in", "example.co.in"], ["x.example.com.au", "example.com.au"], ["me.github.io", "me.github.io"], ["www.example.com", "example.com"], ["169.254.169.254", "169.254.169.254"]])
    assert.equal(S.registrable(h), d, h);
});
