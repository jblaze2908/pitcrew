// Site safety, pure and in memory: registrable domains (a compact public-suffix subset), private/loopback address
// classes, lookalike and homograph checks, and checkout / order-confirmation page signals. No I/O: the gate calls these
// once per browser action (lookalikes only when a domain is new, so the O(brands × label²) scan stays rare).
import { domainToUnicode } from "node:url";

// Multi-part public suffixes seen in practice, plus hosting platforms whose subdomains have different owners (PSL private section).
const SUFFIX = new Set(("co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk co.in net.in org.in gov.in ac.in edu.in res.in gen.in firm.in ind.in nic.in " +
  "co.jp ne.jp or.jp ac.jp go.jp com.au net.au org.au edu.au gov.au id.au co.nz net.nz org.nz govt.nz ac.nz com.br net.br org.br gov.br com.cn net.cn org.cn gov.cn edu.cn " +
  "com.hk com.sg edu.sg gov.sg com.my com.tw co.kr or.kr go.kr co.za org.za gov.za com.mx gob.mx com.ar com.tr gov.tr co.id or.id go.id com.ph com.pk com.bd com.ng com.eg " +
  "com.sa com.vn co.th or.th ac.th co.il org.il ac.il com.ua com.pl co.ke com.np com.lk gov.lk " +
  "github.io gitlab.io vercel.app netlify.app pages.dev workers.dev herokuapp.com appspot.com web.app firebaseapp.com blogspot.com azurewebsites.net cloudfront.net " +
  "s3.amazonaws.com onrender.com fly.dev glitch.me repl.co replit.app ngrok.io ngrok.app ngrok-free.app trycloudflare.com wixsite.com webflow.io notion.site framer.app " +
  "myshopify.com wordpress.com substack.com").split(" "));

export const normHost = (h) => String(h || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
export const hostOf = (url) => { try { return normHost(new URL(url).hostname); } catch { return ""; } };

// Address class of a literal host, without DNS: "loopback" | "private" | "public", or null for a name.
// WHATWG URL parsing already turned decimal/hex/octal IPv4 forms into dotted quads.
const V4_PRIVATE = [[0, 8], [10 << 24, 8], [100 << 24 | 64 << 16, 10], [169 << 24 | 254 << 16, 16], [172 << 24 | 16 << 16, 12], [192 << 24, 24], [192 << 24 | 168 << 16, 16], [198 << 24 | 18 << 16, 15], [224 << 24, 4], [240 << 24, 4]];
function v4Kind(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m || m.slice(1).some((x) => +x > 255)) return null;
  const n = m.slice(1).reduce((a, x) => (a << 8) | +x, 0);
  if (+m[1] === 127) return "loopback";
  return V4_PRIVATE.some(([net, bits]) => ((n ^ net) >>> (32 - bits)) === 0) ? "private" : "public";
}
export function ipKind(host) {
  const h = normHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (!h.includes(":")) return v4Kind(h);
  if (h === "::1") return "loopback";
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
  if (mapped) return v4Kind(mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join("."));
  return h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^64:ff9b:/.test(h) || /^::ffff:/.test(h) ? "private" : "public";
}

// eTLD+1 from SUFFIX; IPs and single-label names are their own domain.
export function registrable(host) {
  const h = normHost(host);
  if (!h || ipKind(h) || !h.includes(".")) return h;
  const p = h.split(".");
  for (const n of [3, 2]) if (p.length > n && SUFFIX.has(p.slice(-n).join("."))) return p.slice(-n - 1).join(".");
  return p.slice(-2).join(".");
}
const labelOf = (domain) => domain.split(".")[0];
// The host and each parent down to its registrable domain, most specific first.
export function domainChain(host) {
  const h = normHost(host), d = registrable(h), out = [h];
  for (let x = h; x !== d && x.includes("."); ) { x = x.slice(x.indexOf(".") + 1); out.push(x); }
  return [...new Set(out)];
}

// Popular sign-in and payment targets; a member's own approved and visited domains are compared too.
export const BRANDS = Object.fromEntries(`google.com Google|google.co.in Google|gmail.com Gmail|youtube.com YouTube|facebook.com Facebook|instagram.com Instagram|whatsapp.com WhatsApp
twitter.com Twitter|x.com X|linkedin.com LinkedIn|microsoft.com Microsoft|live.com Microsoft|outlook.com Outlook|office.com Microsoft|apple.com Apple|icloud.com iCloud
amazon.com Amazon|amazon.in Amazon|amazon.co.uk Amazon|paypal.com PayPal|netflix.com Netflix|github.com GitHub|gitlab.com GitLab|dropbox.com Dropbox|yahoo.com Yahoo
wikipedia.org Wikipedia|reddit.com Reddit|ebay.com eBay|flipkart.com Flipkart|paytm.com Paytm|phonepe.com PhonePe|razorpay.com Razorpay|stripe.com Stripe
hdfcbank.com HDFC Bank|icicibank.com ICICI Bank|onlinesbi.sbi SBI|sbi.co.in SBI|axisbank.com Axis Bank|kotak.com Kotak|chase.com Chase|bankofamerica.com Bank of America
wellsfargo.com Wells Fargo|americanexpress.com American Express|coinbase.com Coinbase|binance.com Binance|okta.com Okta|slack.com Slack|zoom.us Zoom|notion.so Notion
openai.com OpenAI|chatgpt.com ChatGPT|anthropic.com Anthropic|claude.ai Claude|cloudflare.com Cloudflare|adobe.com Adobe|spotify.com Spotify|airbnb.com Airbnb|booking.com Booking.com
uber.com Uber|swiggy.com Swiggy|zomato.com Zomato|myntra.com Myntra|irctc.co.in IRCTC|incometax.gov.in Income Tax India|discord.com Discord|telegram.org Telegram
docusign.com DocuSign|wise.com Wise|revolut.com Revolut|venmo.com Venmo|steamcommunity.com Steam|roblox.com Roblox|excalidraw.com Excalidraw`.split(/[|\n]/).map((x) => [x.slice(0, x.indexOf(" ")), x.slice(x.indexOf(" ") + 1)]));

// Cyrillic/Greek letters that render as Latin ones, then digit and letter-pair swaps (paypa1, rnicrosoft).
const CONFUSE = { а: "a", е: "e", ё: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ї: "i", ј: "j", ԁ: "d", ɡ: "g", һ: "h", ӏ: "l", ѕ: "s", ԛ: "q", ԝ: "w", к: "k", м: "m", н: "h", т: "t", в: "b", ԍ: "g",
  ν: "v", ο: "o", α: "a", ρ: "p", τ: "t", κ: "k", ι: "i", υ: "u", ɑ: "a", ı: "i", ℓ: "l", ɩ: "i", ǀ: "l" };
const DIGIT = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
export const skeleton = (label) => [...String(label).normalize("NFD").replace(/\p{M}/gu, "")].map((c) => CONFUSE[c] ?? DIGIT[c] ?? c).join("").replace(/rn/g, "m").replace(/vv/g, "w").replace(/-/g, "");
export function damerau(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Cherokee", "Arabic", "Hebrew", "Devanagari", "Thai", "Hangul"].map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")]);
// Punycode labels that mix scripts, or whose letters render like a Latin brand. Pure non-Latin names pass.
export function homograph(host) {
  const h = normHost(host), uni = domainToUnicode(h) || h;
  if (uni === h && !/[^\x00-\x7f]/.test(h)) return null;
  for (const label of uni.split(".")) {
    const scripts = SCRIPTS.filter(([, re]) => [...label].some((c) => re.test(c))).map(([s]) => s);
    if (scripts.length > 1) return { unicode: uni, why: `mixes ${scripts.join(" and ")} letters` };
  }
  const sk = skeleton(labelOf(registrable(uni)));
  const d = Object.keys(BRANDS).find((x) => skeleton(labelOf(x)) === sk);
  return d ? { unicode: uni, why: `renders like ${d}`, brand: BRANDS[d], domain: d } : null;
}
// "This looks like <brand>" for a domain that isn't the brand's (or a known domain's) own.
export function lookalike(host, known = []) {
  const h = normHost(host), d = registrable(h);
  if (!d || ipKind(h)) return null;
  const refs = new Map(Object.entries(BRANDS));
  for (const k of known) if (!refs.has(k)) refs.set(k, k);
  if (refs.has(d)) return null;
  const uni = domainToUnicode(d) || d, label = labelOf(d), sk = skeleton(labelOf(uni));
  const tokens = new Set(h.split(".").slice(0, -1).flatMap((x) => x.split("-")));
  for (const [ref, name] of refs) {
    const rl = labelOf(ref);
    if (rl.length < 4 || registrable(ref) === d) continue;
    if (sk === skeleton(rl) && label !== rl) return { brand: name, domain: ref, why: uni !== d ? "letters from another alphabet" : "swapped look-alike characters" };
    const dist = damerau(label, rl);
    if (dist > 0 && dist <= (rl.length >= 8 ? 2 : rl.length >= 5 ? 1 : 0)) return { brand: name, domain: ref, why: `${dist} letter${dist > 1 ? "s" : ""} off` };
    if (rl.length >= 5 && tokens.has(rl)) return { brand: name, domain: ref, why: `"${rl}" inside another domain` };
  }
  return null;
}

// What a URL is, for the gate: scheme, host, registrable domain, https, address class; look-alike warnings only when
// known (the domains to compare against) is given, which the gate does only for a domain it is about to ask about.
export function siteOf(url, known = null) {
  let u; try { u = new URL(url); } catch { return null; }
  const host = normHost(u.hostname), scheme = u.protocol.replace(/:$/, "");
  const web = scheme === "http" || scheme === "https";
  return { url: String(url), scheme, host, domain: web ? registrable(host) : "", https: scheme === "https", ip: web ? ipKind(host) : null,
    lookalike: web && known ? lookalike(host, known) : null, homograph: web && known ? homograph(host) : null };
}

// ---------- page signals ----------
const CHECKOUT_WORDS = new Set(["checkout", "checkouts", "cart", "carts", "basket", "payment", "payments", "pay", "billing", "order", "orders", "subscribe", "subscription", "confirm", "confirmation", "place-order", "placeorder"]);
const PAY_HOSTS = new Set(["stripe.com", "razorpay.com", "paypal.com", "paytm.com", "paytm.in", "phonepe.com", "adyen.com", "braintreegateway.com", "braintree-api.com", "checkout.com",
  "cashfree.com", "juspay.in", "billdesk.com", "ccavenue.com", "payu.in", "payu.com", "instamojo.com", "squareup.com", "square.com", "klarna.com", "afterpay.com", "2checkout.com",
  "authorize.net", "worldpay.com", "mollie.com", "paddle.com", "chargebee.com", "recurly.com", "paystack.com", "flutterwave.com", "pay.google.com", "pay.amazon.com", "payments.amazon.in"]);
const CARD_FIELD = /\b(card ?number|credit card|debit card|cvv2?|cvc|csc|security code|expiry|expiration|exp\.? date|mm ?\/ ?yy|upi( id)?|vpa|name on card|cardholder)\b/i;
const FIELD_ROLE = /^\s*-\s*(textbox|combobox|spinbutton|iframe)\b/;
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9-]+/).flatMap((w) => [w, ...w.split("-")]);
export const payHost = (host) => { const h = normHost(host); return PAY_HOSTS.has(h) || PAY_HOSTS.has(registrable(h)); };
// Why a page looks like checkout or payment, or null. Path and title words, card/CVV/UPI fields, payment providers.
export function checkoutWhy({ url = null, title = null, lines = null } = {}) {
  let u = null; try { u = url ? new URL(url) : null; } catch {}
  if (u && payHost(u.hostname)) return `payment provider ${registrable(normHost(u.hostname))}`;
  const pw = u && words(decodeURIComponent(u.pathname)).find((w) => CHECKOUT_WORDS.has(w));
  if (pw) return `"${pw}" in the address`;
  const tw = words(title).find((w) => CHECKOUT_WORDS.has(w));
  if (tw) return `"${tw}" in the page title`;
  const field = (lines || []).find((l) => FIELD_ROLE.test(l) && CARD_FIELD.test(l));
  return field ? `payment field ${CARD_FIELD.exec(field)[0]}` : null;
}
const CONFIRMED = /\b(order (has been |was )?(placed|confirmed|received|successful)|payment (was |has been )?(successful|received|completed?|confirmed)|thank(s| you) for (your )?(order|purchase|payment)|order (number|no\.?|id|#)\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{3,}|(your )?receipt (number|no\.?|#)|transaction (id|successful|completed?)|booking (is )?confirmed|you('ve| have) been charged|purchase (complete|successful))/i;
// The phrase that makes a page read like an order or payment confirmation, or null. O(text); text is capped by the caller.
export const confirmationOf = (text) => CONFIRMED.exec(String(text || ""))?.[0] ?? null;
