// jev: decides whether a tool call is safe to run or must become a pit stop.
// Order: declared effect class → deterministic rules → LLM judge (only for what's left). Fails closed to "ask".
// v1: the control plane passes the OpenRouter key (opts.apiKey); browser_evaluate runs page JS, so it is judged, never auto-allowed.

const ORDER = { allow: 0, ask: 1, block: 2 };
const stricter = (a, b) => (ORDER[a] >= ORDER[b] ? a : b);

// Per-crew-member policy by effect class. The judge may tighten these, never loosen them.
export const DEFAULT_POLICY = {
  read: "allow", draft: "allow", browse: "allow",
  write_workspace: "allow", signin: "ask", install: "ask",
  send: "ask", pay: "ask", delete: "ask", share: "ask", exec_untrusted: "ask",
};

const READ_ONLY = /^(ls|cat|head|tail|wc|find|grep|rg|stat|file|pwd|echo|date|du|df|sort|uniq|cut|tr|jq|diff|which|uname|true|printf|command -v|env\s*$|printenv\s*$)\b/;
const DANGER = [
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z|)sh\b/, "block", "exec_untrusted", "pipes network content into a shell"],
  [/\b(curl|wget)\b.*(\s-d\b|--data|\s-F\b|--form|--upload-file|-T\s|-X\s*(POST|PUT))/, "ask", "share", "uploads data to the network"],
  [/\b(scp|rsync|nc|ncat|sftp)\b/, "ask", "share", "copies data off the machine"],
  [/\brm\s+-[a-z]*r[a-z]*f?\b(?!.*\/poc\/work)/, "ask", "delete", "recursive delete outside the workspace"],
  [/\bgit\s+push\b/, "ask", "send", "pushes to a remote"],
  [/\b(sudo|su\s|chmod\s+777|chown\s)/, "block", "exec_untrusted", "privilege change"],
  [/(~|\$HOME|\/root|\/home\/\w+)\/\.(ssh|aws|gnupg|config\/gcloud)|\.env\b|id_rsa|credentials/, "block", "share", "touches secret material"],
  [/\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo)\s+(i|install|add)\b/, "ask", "install", "installs software"],
];

// Read-only tools that still write or run something through a flag.
const WRITES_ANYWAY = /^find\b.*\s-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b|^sort\b.*\s(-[a-zA-Z]*o|--output|--compress-program)|^rg\b.*\s--pre\b|^date\b.*\s(-s|--set)\b|^file\b.*\s-[a-zA-Z]*C|^uniq(\s+-\S+)*\s+\S+\s+\S+/;
// Command substitution, heredocs and process substitution hide a second command from the split below.
const HIDDEN = /\$\(|`|<<|<\(|>\(/;
const WS_WRITE = /^(mkdir|cp|mv|touch)\s/;
// No $, quotes, ~ or braces: an expansion could step outside /bot/work after this check.
const inWorkspace = (p) => /^\/bot\/work\/[\w.\/*@%,+:=-]*$/.test(p) && !p.split("/").includes("..");
// Flags with values (--target-directory=/etc, -t/etc) could name a path outside the workspace, so only bare short flags pass.
const wsWrite = (p) => WS_WRITE.test(p) && p.split(/\s+/).slice(1).every((t) => /^-[a-zA-Z]+$/.test(t) || inWorkspace(t));

// Labels that look like credentials or payment data: typing into these is signin/pay, never a draft.
const SECRET_KINDS = [
  ["password", /\bpass(word|code|phrase)?\b|\bpwd\b/i], ["otp", /\botp\b|one[- ]?time|verification code|\b(2fa|mfa|totp)\b|\bauth(entication)? code/i],
  ["pin", /\bpin\b/i], ["cvv", /\bcvv|\bcvc|security code/i], ["card", /\bcard\b|card ?number|\bcredit\b|\bdebit\b|\bexpir/i],
  ["account", /\bssn\b|social security|\biban\b|routing|account (no|number)/i], ["token", /\btoken\b|secret|api[ _-]?key|private key|seed phrase|recovery (code|phrase)/i],
];
export const secretKind = (label) => SECRET_KINDS.find(([, re]) => re.test(label || ""))?.[0] ?? null;
const CARDISH = /\b(?:\d[ -]?){12,18}\d\b/g;
const KEYISH = /\b(?:sk|pk|rk)[-_][\w-]{16,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bxox[abposr]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{30,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bBearer\s+\S+|\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}\b/g;
const ASSIGNED = /\b(pass(?:word)?|pwd|token|secret|api[_-]?key|apikey|access[_-]?key)(\s*[=:]\s*)\S+/gi;
const looksSecret = (s) => { const t = String(s); CARDISH.lastIndex = KEYISH.lastIndex = ASSIGNED.lastIndex = 0; return CARDISH.test(t) || KEYISH.test(t) || ASSIGNED.test(t); };

// Clicks that change nothing but what's on screen. Names match whole (bar a shortcut hint), so "Open account" isn't "Open".
const SAFE_NAME = /^(open|close|show|hide|(show|see|view|load|read) (more|less|all|details|preview)|more|less|next|previous|prev|back|go back|cancel|reset|clear|expand( all)?|collapse( all)?|menu|dismiss|got it|accept( all)? cookies|reject all( cookies)?|zoom (in|out))$/i;
const UNSAFE_NAME = /\b(send|submit|pay|buy|order|purchase|checkout|confirm|delete|remove|share|publish|post|sign ?in|log ?in|sign ?up|subscribe|unsubscribe|transfer|book|reserve|apply|approve|agree)\b/i;
const STATE_ROLES = new Set(["radio", "checkbox", "combobox", "tab"]);
const NAV_KEY = /^(Escape|Tab|Shift\+Tab|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/;
const parseEl = (e) => { const m = /^([a-z]+)\b(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(e || ""); return { role: m?.[1] ?? null, name: (m?.[2] ?? "").replace(/\s+(ctrl|cmd|alt|shift|⌘|⌥|⇧)\s*\+?\s*\S+$/i, "").trim() }; };
const safeName = (n) => n && n.split(/\s*\/\s*/).every((p) => SAFE_NAME.test(p));

// Stage 1+2: returns a verdict or null when the rules can't decide. Rule allows go through the member's policy, so a
// stricter policy (draft: ask) still wins; anything unusual returns null and goes to jev, never straight to allow.
export function ruleVerdict(call, policy = DEFAULT_POLICY) {
  if (call.effect) {
    const d = policy[call.effect] ?? "ask";
    return { decision: d, effect: call.effect, reason: `declared ${call.effect} → policy ${d}`, by: "policy" };
  }
  const ok = (effect, reason) => ({ decision: policy[effect] ?? "ask", effect, reason, by: "rule" });
  if (call.kind === "shell") {
    const cmd = String(call.command).replace(/^\/bin\/(ba)?sh\s+-l?c\s+/, "").replace(/^['"]|['"]$/g, "").trim();
    for (const [re, decision, effect, why] of DANGER) if (re.test(cmd)) return { decision, effect, reason: why, by: "rule" };
    if (HIDDEN.test(cmd)) return null;
    const parts = cmd.split(/\s*(?:&&|\|\||;|\||&|\n)\s*/);
    const redirects = cmd.match(/>+\s*[^\s;&|]*/g) || [];
    if (!parts.every((p) => (READ_ONLY.test(p) && !WRITES_ANYWAY.test(p)) || wsWrite(p))) return null;
    if (!redirects.length && !parts.some(wsWrite)) return ok("read", "read-only commands");
    if (redirects.every((r) => inWorkspace(r.replace(/^>+\s*/, "")))) return ok("write_workspace", "writes only inside /bot/work");
    return null;
  }
  if (call.kind === "mcp" && call.server === "computer" && /^(screenshot|scroll)$/.test(call.tool))
    return { decision: "allow", effect: "browse", reason: "observes the screen", by: "rule" };
  if (call.kind === "mcp" && /^browser_(navigate|navigate_back|snapshot|take_screenshot|wait_for|console_messages|network_requests|network_request|find|tabs|hover|resize)$/.test(call.tool))
    return { decision: "allow", effect: "browse", reason: "observes the page", by: "rule" };
  if (call.kind === "mcp" && call.server === "browser") {
    const a = call.arguments || {}, els = (a.grounded_elements || []).map((e) => e.element);
    // Only elements found in the snapshot the agent read: an ungrounded ref could be any field or button.
    const grounded = els.length > 0 && els.every((e) => e && !/not in the last snapshot/.test(e));
    if (call.tool === "browser_press_key" && NAV_KEY.test(a.key || "")) return ok("browse", `navigation key ${a.key}`);
    // Fill and click allows wait for the checkout/payment guard; until it ships they stay behind this switch.
    if (!grounded || process.env.PITCREW_BROWSER_RULES !== "1") return null;
    if (/^browser_(fill_form|type|select_option)$/.test(call.tool)) {
      const fields = Array.isArray(a.fields) ? a.fields : [];
      // An unlabelled box could be a password field; only named fields are known to be safe to draft into.
      if (a.submit || els.some((e) => !parseEl(e).name)) return null;
      if (secretKind([...fields.map((f) => f.name), a.element, ...els].join(" "))) return null;
      if (looksSecret(JSON.stringify([fields.map((f) => f.value), a.text ?? "", a.values ?? ""]))) return null;
      return ok("draft", "fills fields as a draft, nothing submitted");
    }
    if (call.tool === "browser_click") {
      const parsed = els.map(parseEl);
      if (parsed.some((p) => UNSAFE_NAME.test(p.name))) return null;
      if (parsed.every((p) => STATE_ROLES.has(p.role))) return ok(parsed.every((p) => p.role === "tab") ? "browse" : "draft", `sets a ${parsed[0].role}`);
      if (parsed.every((p) => ["button", "link"].includes(p.role) && safeName(p.name))) return ok("browse", `safe button "${parsed[0].name}"`);
    }
  }
  return null;
}

// Strips secret values from a call before it is stored (audit, jev_labels). Field values go when their label looks
// secret; card numbers, API keys and key=value credentials go wherever they appear. Strings are capped to bound row size.
const scrub = (s) => String(s).replace(KEYISH, "[redacted:token]").replace(CARDISH, (m) => (m.replace(/\D/g, "").length >= 13 ? "[redacted:card]" : m))
  .replace(ASSIGNED, (_, k, sep) => `${k}${sep}[redacted:${secretKind(k) || "token"}]`).slice(0, 4000);
export function redact(call) {
  const byRef = new Map((call?.arguments?.grounded_elements || []).map((e) => [e.ref, e.element]));
  const walk = (v) => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const k = secretKind([v.name, v.element, byRef.get(v.target ?? v.ref)].filter((x) => typeof x === "string").join(" "));
    return Object.fromEntries(Object.entries(v).map(([key, x]) => {
      const kk = typeof x !== "object" && secretKind(key);
      if ((k && ["value", "text", "values"].includes(key)) || kk) return [key, `[redacted:${k || kk}]`];
      // Snapshot lines carry the field's current value after the name; keep only role and name.
      if (k && key === "element" && typeof x === "string") return [key, `${/^[a-z]+(\s+"(?:[^"\\]|\\.)*")?/.exec(x)?.[0] || "element"} [redacted:${k}]`];
      return [key, walk(x)];
    }));
  };
  return walk(call);
}

const JUDGE_PROMPT = `You classify ONE tool call an autonomous agent wants to make on its owner's behalf.
Return ONLY JSON: {"effect":"read|draft|browse|write_workspace|signin|install|send|pay|delete|share|exec_untrusted","reason":"<12 words"}.
Effect meanings: read=observe only; draft=create content not yet sent; browse=navigate/read web pages; write_workspace=modify files only inside /bot/work;
signin=log in/enter credentials/OTP; install=add software; send=message/email/post/submit a form that reaches a person or service; pay=move money or confirm a purchase;
delete=remove data outside the workspace; share=send private data to a new destination; exec_untrusted=run downloaded or opaque code.
Classify by consequence in the real world, not by the tool name. A click on a button like "Pay", "Place order", "Send", "Submit", "Confirm" is pay/send.`;

// Stage 3 (fallback): general LLM judge. Only asked what the rules couldn't decide; any failure → ask.
export async function judgeVerdict(call, { apiKey, model = "deepseek/deepseek-v4.1-flash", policy = DEFAULT_POLICY, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: JUDGE_PROMPT }, { role: "user", content: JSON.stringify(call) }] }),
    });
    const body = await res.json();
    const out = JSON.parse(body.choices?.[0]?.message?.content ?? "{}");
    if (!(out.effect in policy)) throw new Error(`bad effect ${out.effect}`);
    return { decision: policy[out.effect], effect: out.effect, reason: out.reason, by: `judge:${model}`, ms: Date.now() - started, usage: body.usage };
  } catch (e) {
    return { decision: "ask", effect: "unknown", reason: `judge failed closed: ${e.message.slice(0, 60)}`, by: "fail-closed", ms: Date.now() - started };
  } finally { clearTimeout(t); }
}


// Stage 3 (default): TypeSafe Jev, a System One model returning calibrated typed choices in one pass.
// The raw answers ride along on the verdict so jev_labels can train a local classifier on them later.
const EFFECT_CRITERIA = {
  read: { what: "only looks at local files or data", examples: ["ls", "cat notes.txt", "grep"], not_for: "anything that writes or sends" },
  draft: { what: "prepares content without sending it", examples: ["fill a form field", "write a draft reply"], not_for: "pressing send or submit" },
  browse: { what: "navigates or reads web pages", examples: ["open a URL", "click a Next link", "accept cookies"], not_for: "buttons that pay, order, send or submit" },
  write_workspace: { what: "creates or edits files inside /bot/work only", examples: ["mkdir /bot/work/bills", "echo x > /bot/work/out.txt"], not_for: "paths outside /bot/work" },
  signin: { what: "logs in or enters a password, OTP or credential", examples: ["type into Password box", "enter one-time code"] },
  install: { what: "installs or downloads software", examples: ["npm install", "apt install"] },
  send: { what: "reaches a person or service: send, post, submit, push, message", examples: ["click Send", "git push", "run a script that emails someone"] },
  pay: { what: "moves money or confirms a purchase", examples: ["click Pay now", "click Place order", "transfer funds"] },
  delete: { what: "removes data outside the workspace", examples: ["rm -rf /var/log/app", "delete account"] },
  share: { what: "sends private data to a new destination", examples: ["curl -F file=@statement.csv", "scp report.pdf"] },
  exec_untrusted: { what: "runs downloaded or opaque code, or changes privileges", examples: ["curl | bash", "sudo"] },
};
const CONSEQUENTIAL = ["signin", "install", "send", "pay", "delete", "share", "exec_untrusted"];

// Some decision models (Respan) accept only noul questions; they get a yes/no-only question set.
const NOUL_ONLY = /^respan\//;

export async function jevSystemOne(call, { apiKey, policy = DEFAULT_POLICY, timeoutMs = 5000, model = process.env.JEV_MODEL || "~typesafe/jev-latest" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    // Served by TypeSafe through OpenRouter's System One route, so the existing OpenRouter key works.
    const res = await fetch("https://openrouter.ai/api/v1/systemone", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: JSON.stringify({ tool_call: call, workspace: "/bot/work" }), questions: NOUL_ONLY.test(model) ? {
        consequential: { type: "noul", instructions: "Does this tool call send a message, submit or post something, move money, log in, enter a password or code, install software, delete data outside /bot/work, upload private data, or run untrusted code?" },
        outside: { type: "noul", instructions: "Would running this send data or messages off this machine, or change money, accounts or other people?" },
      } : {
        effect: { type: "choice", instructions: "What is the real-world effect of running this tool call?", criteria: EFFECT_CRITERIA },
        outside: { type: "noul", instructions: "Would running this send data or messages off this machine, or change money, accounts or other people?" },
      } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 80)}`);
    const body = await res.json();
    if (NOUL_ONLY.test(model)) {
      const c = body.answers.consequential.noul, o = body.answers.outside.noul;
      const decision = c >= 0.3 || o >= 0.5 ? "ask" : "allow";
      return { decision, effect: decision === "allow" ? "read" : "unknown", reason: `consequential ${c.toFixed(2)} · leaves machine ${o.toFixed(2)}`, by: `jev:${body.model}`, ms: Date.now() - started, usage: body.usage, answers: body.answers };
    }
    const eff = body.answers.effect, out = body.answers.outside.noul;
    const riskMass = CONSEQUENTIAL.reduce((a, k) => a + (eff.probabilities[k] || 0), 0);
    let decision = policy[eff.choice] ?? "ask", why = `effect=${eff.choice} p=${eff.confidence.toFixed(2)}`;
    // Uncertainty between safe classes is harmless; only probability on consequential classes escalates.
    if (eff.confidence < 0.75 && riskMass >= 0.05) { decision = stricter(decision, "ask"); why += " · low confidence"; }
    if (riskMass >= 0.15) { decision = stricter(decision, "ask"); why += ` · risk mass ${riskMass.toFixed(2)}`; }
    if (out >= 0.5) { decision = stricter(decision, "ask"); why += ` · leaves machine ${out.toFixed(2)}`; }
    return { decision, effect: eff.choice, reason: why, by: `jev:${body.model}`, ms: Date.now() - started, usage: body.usage, probabilities: eff.probabilities, answers: body.answers };
  } catch (e) {
    return { decision: "ask", effect: "unknown", reason: `jev failed closed: ${e.message.slice(0, 60)}`, by: "fail-closed", ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

export async function jev(call, opts = {}) {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const r = ruleVerdict(call, policy);
  if (r) return r;
  const useJev = (opts.backend || process.env.JEV_BACKEND || "jev") === "jev";
  const j = useJev ? await jevSystemOne(call, { ...opts, policy }) : await judgeVerdict(call, { ...opts, policy });
  // Consequential classes never drop below the policy's floor, whatever the judge said.
  return { ...j, decision: stricter(j.decision, policy[j.effect] ?? "ask") };
}
