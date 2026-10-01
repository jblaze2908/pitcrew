// Pitcrew web app: one page, hash routes, live over SSE. Built only from design-system classes and pc-* components.
import { h, renderSurface } from "./surface.js";
import { renderDiff } from "./diff.js";

const $ = (s, el = document) => el.querySelector(s);
const root = $("#root");
let S = null;               // /api/state
let current = { name: null, args: [] };
let rerenderTimer = null;

// ---------- api ----------
async function api(method, path, body, { raw = false, quiet = false } = {}) {
  const opts = { method, headers: { "X-Pitcrew": "1" } };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) { boot(); throw new Error("Sign in"); }
  if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); if (!quiet) toast(e.message, true); throw e; }
  return data;
}
function toast(text, bad = false) {
  const t = h("div", { class: `toast ${bad ? "bad" : ""}` }, text);
  document.body.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

// ---------- formatting ----------
const usd = (n) => `$${(n || 0).toFixed(n > 0 && n < 0.1 ? 3 : 2)}`;
const ago = (t) => { if (!t) return ""; const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const clock = () => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date()).replace(",", "");
const when = (t) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(t));
const bot = (id) => S?.bots.find((b) => b.id === id);
const face = (b, size = "sm", mood) => h("pc-bot", { size, hue: b?.hue || "c1", shape: b?.shape || "square", mood: mood || b?.mood || "idle" });
const MOOD_LABEL = { needs: ["PIT STOP", "sig"], working: [null], failed: ["FAIL", "bad"], sleep: ["GARAGE", ""], done: ["DONE", ""], idle: ["READY", ""] };
const stepOk = (e) => e.data.status === "completed" && (e.data.exitCode == null || e.data.exitCode === 0);
// Older events carry the model-facing snapshot attributes; show role and name only.
const tidyTitle = (s) => String(s || "").replace(/\s*\[[a-z-]+(=[^\]]*)?\]/g, "").replace(/:(?=\s|$)/g, "");
const effectChip = (e) => h("pc-effect", { kind: e }, e === "hire" ? "HIRE" : String(e || "ask").replace("_", " "));

// Minimal, safe markdown: escape first, then a few inline and block forms.
function md(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    // Links into this app (a thread the crew found) open in place; anything else opens a new tab.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, (m, t, u) => u.startsWith(`${location.origin}/`) ? `<a href="${u.slice(location.origin.length)}">${t}</a>` : `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  const out = [];
  const parts = String(text || "").split(/```[\w-]*\n?/);
  parts.forEach((p, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>`); return; }
    let list = null;
    for (const line of p.split("\n")) {
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line);
      if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      if (/^#{1,4}\s/.test(line)) out.push(`<h3>${inline(line.replace(/^#+\s/, ""))}</h3>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
  });
  const d = h("div", { class: "md" }); d.innerHTML = out.join(""); return d;
}

// ---------- boot / auth ----------
async function boot() {
  const s = await fetch("/api/session").then((r) => r.json());
  if (!s.authed) return s.setup ? loginScreen() : setupScreen();
  S = await api("GET", "/api/state");
  connectStream();
  window.addEventListener("hashchange", route);
  route();
  setInterval(() => { const c = $(".pc-bar .clock"); if (c) c.textContent = clock(); }, 20000);
}
function authCard(title, sub, fields, label, submit) {
  const err = h("p", { class: "small badc" });
  const form = h("form", { class: "pc-card" }, h("pc-logo", { size: "md", wordmark: "" }), h("h1", { class: "pc-h2" }, title), h("p", { class: "muted small" }, sub), fields, err, h("button", { class: "pc-pill", type: "submit" }, label));
  form.addEventListener("submit", async (e) => { e.preventDefault(); err.textContent = ""; try { await submit(); location.hash = "#/"; location.reload(); } catch (x) { err.textContent = x.message; } });
  root.replaceChildren(h("div", { class: "auth" }, form));
}
function setupScreen() {
  const token = h("input", { autocomplete: "off", placeholder: "Setup token" }), name = h("input", { placeholder: "What should the crew call you?" }), pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "Password (12+ characters)" });
  authCard("Set up your pit wall", "Paste the setup token from /srv/pitcrew/data/setup-token on the server, then choose a password.", [token, name, pw], "Set password",
    () => api("POST", "/api/setup", { token: token.value.trim(), password: pw.value, driverName: name.value.trim() }, { quiet: true }));
}
function loginScreen() {
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "Password", autofocus: true });
  authCard("Pitcrew", "Sign in to the pit wall.", [pw], "Sign in", () => api("POST", "/api/login", { password: pw.value }, { quiet: true }));
}

// ---------- live stream ----------
let es;
function connectStream() {
  es?.close();
  es = new EventSource("/api/stream");
  const refresh = () => { clearTimeout(rerenderTimer); rerenderTimer = setTimeout(async () => { S = await api("GET", "/api/state", undefined, { quiet: true }).catch(() => S); renderChrome(); if (current.name !== "thread" && current.name !== "live" && current.name !== "hire" && current.name !== "settings" && !$(".threadq")?.value) renderView(); }, 250); };
  for (const t of ["thread", "turn", "pitstop", "computer", "paused", "lease"]) es.addEventListener(t, (e) => { refresh(); threadHook(t, JSON.parse(e.data)); });
  es.addEventListener("event", (e) => threadHook("event", JSON.parse(e.data)));
  es.addEventListener("delta", (e) => threadHook("delta", JSON.parse(e.data)));
  es.addEventListener("activity", (e) => threadHook("activity", JSON.parse(e.data)));
  es.addEventListener("context", (e) => threadHook("context", JSON.parse(e.data)));
  es.onerror = () => { setTimeout(() => { if (es.readyState === 2) connectStream(); }, 3000); };
}
let threadHook = () => {};

// ---------- shell ----------
let here = "", backTo = null; // where the live view's Back returns to
function route() {
  const prev = here; here = location.hash;
  const [name, ...args] = (location.hash.replace(/^#\/?/, "") || "wall").split("/");
  current = { name: name || "wall", args };
  if (current.name === "live" && prev && !prev.startsWith("#/live")) backTo = prev;
  threadHook = () => {};
  renderChrome(); renderView();
}
function renderChrome() {
  if (!S) return;
  const pending = S.pitstops.length;
  let app = $(".app");
  if (!app) { app = h("div", { class: "app" }, h("div", { class: "pc-bar" }), h("div", { class: "shell" }, h("aside", { class: "side" }), h("main", { id: "view" }))); root.replaceChildren(app); }
  const crumb = { wall: "Pit wall", crew: "Crew", t: "Thread", pitstops: "Pit stops", telemetry: "Telemetry", library: "Library", settings: "Settings", hire: "Hire", live: "Live computer" }[current.name] || "Pit wall";
  $(".pc-bar").replaceChildren(
    h("div", { class: "l" }, h("span", { class: "hi" }, "PITCREW"), h("span", { class: "dim" }, "/"), h("span", {}, crumb), S.paused && h("span", { class: "stop" }, "CREW STOPPED")),
    h("div", { class: "r" }, h("span", { class: "opt" }, h("i", { class: `up ${S.computersUp ? "" : "off"}` }), `${S.computersUp} computer${S.computersUp === 1 ? "" : "s"} up`),
      h("span", {}, `wk ${usd(S.week.usd)} / ${usd(S.weekCap)} cap`), h("span", { class: "hi clock opt" }, clock())));
  const nav = (id, label, href, count, hot) => h("a", { class: `pc-nav ${current.name === id || (id === "crew" && current.name === "t") ? "on" : ""}`, href }, label, count != null && h("em", { class: hot ? "hot" : "" }, count));
  $(".side").replaceChildren(
    h("a", { href: "#/", class: "logo" }, h("pc-logo", { size: "sm", wordmark: "" })),
    h("nav", {}, nav("wall", "Pit wall", "#/", pending || null, pending > 0), nav("pitstops", "Pit stops", "#/pitstops"), nav("telemetry", "Telemetry", "#/telemetry"), nav("library", "Library", "#/library"), nav("settings", "Settings", "#/settings")),
    h("p", { class: "pc-lab" }, "Crew"),
    h("div", { class: "crewlist" }, S.bots.map((b) => {
      const [label, cls] = MOOD_LABEL[b.mood] || [""];
      const on = (current.name === "crew" && current.args[0] === b.id) || (current.name === "t" && S.bots.find((x) => x.threads.some((t) => t.id === current.args[0]))?.id === b.id);
      return h("a", { class: `pc-tile ${on ? "on" : ""}`, style: `--hue:var(--${b.hue})`, href: `#/crew/${b.id}` }, face(b), h("b", {}, b.name), b.mood === "working" ? h("pc-loader", {}) : h("small", { class: cls }, label));
    })),
    h("div", { class: "foot" }, h("a", { class: "pc-pill o s", href: "#/hire" }, "+ New crew member")));
}
function renderView() {
  const main = $("#view");
  if (!main) return;
  const v = { wall: wallView, crew: crewView, t: threadView, pitstops: pitstopsView, telemetry: telemetryView, library: libraryView, settings: settingsView, hire: hireView, live: liveView }[current.name] || wallView;
  Promise.resolve(v(...current.args)).then((el) => { if (el) main.replaceChildren(el); }).catch((e) => main.replaceChildren(h("div", { class: "page" }, h("p", { class: "badc" }, e.message))));
}

// ---------- pit stop card ----------
function pitCard(p, { onDone } = {}) {
  const b = bot(p.bot_id), d = p.detail || {}, j = p.jev || {};
  const done = p.status !== "pending";
  const note = h("input", { placeholder: "Note for the crew (optional)", class: "small" });
  const decide = async (decision, scope) => { await api("POST", `/api/pitstops/${p.id}/decide`, { decision, scope, note: note.value }); toast(decision === "approve" ? "Approved" : "Denied"); onDone?.(); };
  const body = p.kind === "command" ? h("pre", {}, String(d.command || "").replace(/^\/bin\/(ba)?sh -l?c /, ""))
    : p.kind === "mcp" ? h("pre", {}, `${d.server || ""}.${d.tool || ""}\n${JSON.stringify(d.args || d.message || {}, null, 1).slice(0, 1200)}`)
    : p.kind === "file" ? h("pre", {}, (d.paths || []).join("\n"))
    : p.kind === "hire" ? hireSummary(d.spec || {}) : null;
  const noAlways = ["pay", "delete", "share"].includes(p.effect) || p.kind === "hire";
  return h("div", { class: `pit ${done ? "done" : ""}` },
    h("div", { class: "spread" }, h("div", { class: "row" }, face(b, "sm", done ? "idle" : "needs"), h("b", {}, b?.name || p.bot_id), effectChip(p.effect)),
      h("span", { class: "pc-m small faint" }, done ? `${p.status} ${ago(p.decided_at)}` : `expires ${when(p.expires_at)}`)),
    h("p", { class: "t" }, p.title), body,
    j.reason && h("p", { class: "why" }, `jev · ${j.by || ""} · ${j.reason}${j.ms ? ` · ${j.ms} ms` : ""}`),
    !done && p.learn && h("p", { class: "small faint" }, p.learn.need - p.learn.streak <= 1 ? `Approve this and ${b?.name || "the crew"} stops asking for “${p.learn.label}”.` : `Approve “${p.learn.label}” ${p.learn.need - p.learn.streak} times in a row and ${b?.name || "the crew"} stops asking.`),
    !done && p.kind === "hire" && h("div", { class: "acts" }, h("a", { class: "pc-pill sig s", href: `#/hire/${p.id}` }, "Review & hire"), h("button", { class: "pc-pill o s", onclick: () => decide("deny") }, "Decline")),
    !done && p.kind === "lease" && h("div", { class: "acts" }, h("button", { class: "pc-pill sig s", onclick: () => decide("approve", "once") }, "Hand it back"), h("button", { class: "pc-pill o s", onclick: () => decide("deny") }, "Keep control"),
      h("a", { class: "small faint", href: `#/live/${p.bot_id}`, style: "margin-left:auto" }, "Open live view")),
    !done && !["hire", "lease"].includes(p.kind) && [note, h("div", { class: "acts" },
      h("button", { class: "pc-pill sig s", onclick: () => decide("approve", "once") }, "Approve once"),
      p.thread_id && h("button", { class: "pc-pill o s", onclick: () => decide("approve", "thread") }, "For this thread"),
      !noAlways && h("button", { class: "pc-pill o s", onclick: () => decide("approve", "always") }, "Always for this member"),
      h("button", { class: "pc-pill o s", onclick: () => decide("deny") }, "Deny"),
      p.thread_id && h("a", { class: "small faint", href: `#/t/${p.thread_id}`, style: "margin-left:auto" }, "Open thread"))],
    done && p.note && h("p", { class: "small faint" }, p.note));
}
function hireSummary(s) {
  const p = s.personality || {};
  return h("div", { class: "row", style: "gap:16px;align-items:flex-start" }, h("pc-bot", { size: "lg", hue: s.hue, shape: s.shape, mood: "idle" }),
    h("div", { class: "col", style: "gap:4px" }, h("b", { class: "pc-h3" }, s.name), h("p", { class: "muted small" }, s.job), s.reason && h("p", { class: "small" }, `Why: ${s.reason}`),
      h("p", { class: "pc-m small faint" }, `${s.provider} · ${s.model} · cap ${usd(s.weekly_cap_usd)}/wk${s.schedule?.spec ? ` · ${s.schedule.spec}` : ""}`), p.role && h("p", { class: "small faint" }, `Voice: ${p.role}`)));
}

// ---------- views ----------
function wallView() {
  const hour = +new Intl.DateTimeFormat("en-GB", { hour: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());
  const greet = hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  const n = S.pitstops.length;
  const connected = Object.values(S.providers).some((p) => p.connected);
  return h("div", { class: "page" },
    h("div", { class: "spread" }, h("h1", { class: "pc-hello" }, `${greet}, ${S.driverName}. `, n ? h("em", {}, `${n} pit stop${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} you.`) : "All quiet."),
      h("a", { class: "pc-pill", href: `#/t/${S.bots[0]?.threads[0]?.id || ""}` }, "Ask the Crew Chief")),
    !connected && h("div", { class: "pc-card row" }, h("pc-bot", { size: "md", hue: "c1", mood: "sleep" }), h("div", { class: "col", style: "flex:1;gap:2px" }, h("b", { class: "pc-h3" }, "Connect a model provider to start"), h("p", { class: "muted small" }, "Add an OpenRouter or AI Gateway key, or sign in with ChatGPT. The crew runs on whichever you pick.")), h("a", { class: "pc-pill s", href: "#/settings" }, "Providers")),
    S.paused && h("div", { class: "pc-card row" }, h("b", { class: "sig", style: "flex:1" }, "The crew is stopped. Nothing runs until you resume."), h("button", { class: "pc-pill s", onclick: async () => { S = await api("POST", "/api/resume"); renderChrome(); renderView(); } }, "Resume the crew")),
    n > 0 && h("section", { class: "col" }, h("div", { class: "spread" }, h("p", { class: "pc-lab" }, "Box, box: waiting on you"), n > 1 && h("a", { class: "small faint", href: "#/pitstops" }, "Batch decide")), h("div", { class: "grid2" }, S.pitstops.slice(0, 6).map((p) => pitCard(p)))),
    h("div", { class: "grid3" },
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Today"), h("span", { class: "big num" }, usd(S.today.usd)), h("p", { class: "small muted" }, `${S.today.runs} run${S.today.runs === 1 ? "" : "s"} · billed cost where the provider reports it`)),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "This week"), h("span", { class: "big num" }, usd(S.week.usd)), h("div", { class: "meter" }, h("b", { style: `width:${Math.min(100, (S.week.usd / (S.weekCap || 1)) * 100)}%` })), h("p", { class: "small muted" }, `of ${usd(S.weekCap)} across the crew's caps`)),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Computers"), h("span", { class: "big num" }, String(S.computersUp)), h("p", { class: "small muted" }, "up now. Idle computers go back to the garage after 10 minutes."))),
    h("section", { class: "col" }, h("p", { class: "pc-lab" }, "The crew"), h("div", { class: "grid3" }, S.bots.map(crewCard), h("a", { class: "pc-card crewcard", href: "#/hire", style: "justify-content:center;align-items:center;border-style:dashed" }, h("b", { class: "pc-h3" }, "+ New crew member"), h("p", { class: "small faint" }, "Every hire is reviewed by you.")))));
}
function crewCard(b) {
  const running = b.threads.find((t) => t.status === "running");
  const pct = Math.min(100, (b.spend / (b.weekly_cap_usd || 1)) * 100);
  const el = h("div", { class: "pc-card crewcard" },
    h("div", { class: "who" }, face(b, "md"), h("div", { class: "col", style: "gap:3px;min-width:0" }, h("b", {}, b.name), h("span", { class: "pc-m small faint" }, `${b.provider} · ${b.model}`))),
    h("p", { class: `now ${["working", "needs", "failed"].includes(b.mood) ? "flex" : ""}` }, b.mood === "working" ? [h("pc-loader", {}), running?.title || "On track"] : b.mood === "needs" ? h("span", { class: "sig" }, "Waiting on a pit stop") : b.mood === "failed" ? h("span", { class: "badc" }, "Last run failed") : b.job || ""),
    h("div", { class: "budget" }, h("pc-track", { pct: pct.toFixed(0), hue: b.hue, shape: b.shape, state: b.mood === "failed" ? "failed" : "working" }), h("div", { class: "spread" }, h("span", {}, `${usd(b.spend)} this week`), h("span", {}, `cap ${usd(b.weekly_cap_usd)}`))));
  el.addEventListener("click", () => (location.hash = `#/crew/${b.id}`));
  return el;
}

async function crewView(id, tab = "threads", ...rest) {
  const d = await api("GET", `/api/bots/${id}`);
  const b = d.bot;
  const tabs = h("div", { class: "tabs" }, ["threads", "files", "computer", "profile", "memory", "schedules", "rules"].map((t) => h("a", { href: `#/crew/${id}/${t}`, class: tab === t ? "on" : "" }, t[0].toUpperCase() + t.slice(1))));
  const newThread = async () => { const r = await api("POST", "/api/threads", { botId: id, title: "New thread" }); location.hash = `#/t/${r.id}`; };
  let body;
  // Threads carry no outcome of their own; only a live run (working, or waiting on a pit stop) earns a chip.
  if (tab === "threads") {
    const tbody = h("tbody");
    const rows = (list) => tbody.replaceChildren(...(list.length ? list.map((t) => {
      const live = t.status === "running" ? h("span", { class: "pc-chip blue" }, "working") : t.status === "needs" ? h("span", { class: "pc-chip hot" }, "pit stop") : null;
      const tr = h("tr", { style: "cursor:pointer" }, h("td", {}, h("div", { class: "row", style: "gap:8px" }, h("b", {}, t.title), t.pinned ? h("span", { class: "pc-chip" }, "pinned") : null, t.archived ? h("span", { class: "pc-chip" }, "archived") : null, live), t.snippet ? h("p", { class: "small faint snip" }, t.snippet) : null),
        h("td", { class: "num faint small" }, when(t.created_at)), h("td", { class: "num faint small", title: when(t.updated_at) }, ago(t.updated_at)));
      tr.addEventListener("click", () => (location.hash = `#/t/${t.id}`)); return tr;
    }) : [h("tr", {}, h("td", { colspan: 3, class: "faint small" }, "No threads match."))]));
    rows(b.threads);
    const q = h("input", { type: "search", class: "threadq", placeholder: "Find a thread by its title or anything said in it" });
    let qt; q.addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(async () => { const v = q.value.trim(); rows(v ? await api("GET", `/api/bots/${id}/threads?q=${encodeURIComponent(v)}`, undefined, { quiet: true }).catch(() => []) : b.threads); }, 200); });
    body = b.threads.length ? h("div", { class: "col" }, q, h("div", { class: "pc-card tight" }, h("table", { class: "tbl threads" },
      h("thead", {}, h("tr", {}, h("th", {}, "Thread"), h("th", { class: "num" }, "Created"), h("th", { class: "num" }, "Last active"))), tbody)))
      : h("div", { class: "pc-card tight" }, h("p", { class: "empty" }, "No threads yet."));
  }
  else if (tab === "files") {
    const projects = rest[0] === "projects";
    const seg = h("div", { class: "seg" }, h("a", { class: projects ? "" : "on", href: `#/crew/${id}/files` }, "Files"), h("a", { class: projects ? "on" : "", href: `#/crew/${id}/files/projects` }, "Projects"));
    body = h("div", { class: "col" }, seg, projects ? await projectsView(b, rest[1]) : await filesView(b, ...rest));
  }
  else if (tab === "computer") body = computerCard(b);
  else if (tab === "profile") body = await profileEditor(b);
  else if (tab === "memory") body = memoryEditor(b, d.memory);
  else if (tab === "schedules") body = schedulesEditor(b, d.schedules);
  else body = h("div", { class: "col" }, rulesList(d.rules, () => renderView()), learnedList(d.learned, () => renderView()));
  return h("div", { class: "page" },
    h("div", { class: "spread" }, h("div", { class: "row", style: "gap:16px" }, face(b, "lg"), h("div", { class: "col", style: "gap:4px" }, h("h1", { class: "pc-h2" }, b.name), h("p", { class: "muted" }, b.job), h("div", { class: "row" }, h("span", { class: "pc-chip" }, b.provider), h("span", { class: "pc-chip" }, b.model), h("span", { class: "pc-chip" }, `${usd(b.spend)} / ${usd(b.weekly_cap_usd)} wk`)))),
      h("button", { class: "pc-pill", onclick: newThread }, "+ New thread")),
    tabs, body);
}

function computerCard(b) {
  const c = b.computer;
  return h("div", { class: "pc-card col" },
    h("div", { class: "spread" }, h("div", { class: "col", style: "gap:4px" }, h("div", { class: "row" }, h("b", { class: "pc-h3" }, `${b.name}'s computer`), h("span", { class: `pc-chip ${c.desktop ? "ok" : c.up ? "blue" : ""}` }, c.desktop ? "desktop live" : c.up ? "runtime up" : "off")),
      h("p", { class: "small muted" }, c.desktop ? `Up since ${when(c.startedAt)} with its desktop and browser.` : c.up ? `Up since ${when(c.startedAt)} for commands; the desktop starts on the first browser action.` : "In the garage. Chat needs no computer: it starts on the first command or browser action, or when you want to look.")),
      h("div", { class: "row" }, c.desktop ? h("a", { class: "pc-pill s", href: `#/live/${b.id}` }, "Live view") : h("button", { class: "pc-pill s", onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Starting…"; await api("POST", `/api/bots/${b.id}/computer/start`).catch(() => {}); location.hash = `#/live/${b.id}`; } }, "Start and watch"),
        c.up && h("button", { class: "pc-pill o s", onclick: async () => { await api("POST", `/api/bots/${b.id}/computer/stop`); toast("Computer stopped"); renderView(); } }, "Stop"))),
    h("p", { class: "small faint" }, "Logins you make in the live view stay in this crew member's browser only. Other crew members can't see them."));
}

async function profileEditor(b) {
  const p = b.personality || {};
  const f = { name: h("input", { value: b.name, disabled: b.kind === "chief" }), job: h("textarea", {}, b.job), role: h("input", { value: p.role || "", placeholder: "e.g. Calm race engineer. Facts first." }),
    quirks: h("input", { value: (p.quirks || []).join("; "), placeholder: "Up to 3, separated by ;" }), signoff: h("input", { value: p.signoff || "" }), callMe: h("input", { value: p.callMe || "" }),
    cap: h("input", { type: "number", min: 0, step: "0.5", value: b.weekly_cap_usd }), plain: h("input", { type: "checkbox", checked: !!p.plain }) };
  const dials = {}; for (const k of ["warmth", "talk", "humour"]) dials[k] = h("input", { type: "range", min: 1, max: 5, value: p[k] || 3 });
  const pm = await providerModelPicker(b.provider, b.model);
  const policy = {}; for (const [k, v] of Object.entries(b.policy)) policy[k] = h("select", { disabled: ["delete", "share", "pay"].includes(k) }, ["allow", "ask"].map((o) => h("option", { value: o, selected: o === v }, o)));
  const save = async () => {
    await api("PATCH", `/api/bots/${b.id}`, { name: f.name.value, job: f.job.value, weekly_cap_usd: +f.cap.value, provider: pm.provider(), model: pm.model(),
      personality: { role: f.role.value, quirks: f.quirks.value.split(";").map((s) => s.trim()).filter(Boolean), signoff: f.signoff.value, callMe: f.callMe.value, plain: f.plain.checked, warmth: +dials.warmth.value, talk: +dials.talk.value, humour: +dials.humour.value },
      policy: Object.fromEntries(Object.entries(policy).map(([k, s]) => [k, s.value])) });
    toast("Saved. New threads use it; running computers pick it up at next start."); S = await api("GET", "/api/state"); renderChrome();
  };
  return h("div", { class: "grid2" },
    h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Who"), lab("Name", f.name), lab("Job", f.job), lab("Weekly cap (USD)", f.cap, "The runtime refuses new runs once this week's estimate reaches the cap."), pm.el,
      b.kind !== "chief" && h("button", { class: "pc-pill o s", onclick: async (e) => { if (!confirmInline(e.target, "Retire?")) return; await api("POST", `/api/bots/${b.id}/archive`); location.hash = "#/"; } }, "Retire crew member")),
    h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Personality (voice only)"), lab("Role line", f.role),
      ...Object.entries(dials).map(([k, el]) => h("div", { class: "dial" }, h("span", { class: "muted" }, k[0].toUpperCase() + k.slice(1)), el, h("span", { class: "pc-m faint" }, el.value))),
      lab("Quirks", f.quirks), lab("Sign-off", f.signoff), lab("Calls you", f.callMe), h("label", { class: "row small" }, f.plain, "Plain voice"),
      h("p", { class: "small faint" }, "Personality never changes permissions, caps or jev. Pit stops and money always use a plain voice.")),
    h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Permissions by effect"), h("table", { class: "tbl" }, h("tbody", {}, Object.entries(policy).map(([k, s]) => h("tr", {}, h("td", {}, h("pc-effect", { kind: k }, k.replace("_", " "))), h("td", {}, s))))),
      h("p", { class: "small faint" }, "Pay, delete and share always ask.")),
    h("div", { class: "row" }, h("button", { class: "pc-pill", onclick: save }, "Save")));
}
function confirmInline(btn, text) { if (btn.dataset.armed) return true; btn.dataset.armed = "1"; btn.textContent = `${text} Click again`; setTimeout(() => { delete btn.dataset.armed; }, 4000); return false; }
const lab = (label, el, help) => h("div", { class: "field" }, h("label", {}, label), el, help && h("span", { class: "help" }, help));

async function providerModelPicker(provider, model) {
  const sel = h("select", {}, Object.entries(S.providers).map(([k, p]) => h("option", { value: k, selected: k === provider }, `${p.label}${p.connected ? "" : " (not connected)"}`)));
  const input = h("input", { value: model, list: "models-dl", placeholder: "model id" });
  const dl = h("datalist", { id: "models-dl" });
  const load = async () => { const list = await api("GET", `/api/models?provider=${sel.value}&q=${encodeURIComponent(input.value.split("/")[0] || "")}`, undefined, { quiet: true }).catch(() => []); dl.replaceChildren(...list.map((m) => h("option", { value: m.id }, m.price ? `${m.name} · $${(m.price.in * 1e6).toFixed(2)}/$${(m.price.out * 1e6).toFixed(2)} per M` : m.name))); };
  sel.addEventListener("change", () => { input.value = ""; load(); });
  input.addEventListener("focus", load, { once: true });
  return { el: h("div", { class: "grid2" }, lab("Provider", sel), lab("Model", h("div", {}, input, dl))), provider: () => sel.value, model: () => input.value.trim() };
}

function memoryEditor(b, mem) {
  const input = h("input", { placeholder: "Add a fact this crew member should know" });
  const add = async () => { if (!input.value.trim()) return; await api("POST", `/api/bots/${b.id}/memory`, { text: input.value }); renderView(); };
  return h("div", { class: "col" }, h("div", { class: "row" }, h("div", { style: "flex:1" }, input), h("button", { class: "pc-pill s", onclick: add }, "Add")),
    h("div", { class: "pc-card tight" }, mem.length ? h("table", { class: "tbl" }, h("tbody", {}, mem.map((m) => h("tr", {}, h("td", {}, m.text), h("td", { class: "small faint" }, m.source === "driver" ? "you" : "learned in a thread"), h("td", { class: "num faint small" }, when(m.created_at)),
      h("td", { class: "num" }, h("button", { class: "small faint", onclick: async () => { await api("POST", `/api/memory/${m.id}/forget`); renderView(); } }, "Forget")))))) : h("p", { class: "empty" }, "Nothing remembered yet.")));
}
function schedulesEditor(b, list) {
  const spec = h("input", { placeholder: "daily 09:00 · weekly mon 08:30 · every 6 hours" }), prompt = h("input", { placeholder: "What to do" });
  const add = async () => { await api("POST", `/api/bots/${b.id}/schedules`, { spec: spec.value, prompt: prompt.value }); renderView(); };
  return h("div", { class: "col" }, h("div", { class: "grid2" }, spec, h("div", { class: "row" }, h("div", { style: "flex:1" }, prompt), h("button", { class: "pc-pill s", onclick: add }, "Add"))),
    h("div", { class: "pc-card tight" }, list.length ? h("table", { class: "tbl" }, h("tbody", {}, list.map((s) => h("tr", {}, h("td", { class: "pc-m" }, s.spec), h("td", {}, s.prompt), h("td", { class: "small faint" }, s.next_run ? `next ${when(s.next_run)}` : ""),
      h("td", { class: "num" }, h("button", { class: "small faint", onclick: async () => { await api("PATCH", `/api/schedules/${s.id}`, { enabled: !s.enabled }); renderView(); } }, s.enabled ? "Pause" : "Resume")))))) : h("p", { class: "empty" }, "No schedules.")));
}
function learnedList(items, after) {
  return h("div", { class: "pc-card tight scrollx" }, items.length ? h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Learned from your approvals"), h("th", {}, "Effect"), h("th", {}, "Crew"), h("th", { class: "num" }, "Approved"), h("th", {}, "State"), h("th"))),
    h("tbody", {}, items.map((l) => {
      const on = l.streak >= l.need;
      return h("tr", {}, h("td", {}, l.label), h("td", {}, h("pc-effect", { kind: l.effect }, l.effect.replace("_", " "))), h("td", {}, l.bot_name || l.bot_id),
        h("td", { class: "num pc-m small" }, `${l.approvals}${l.denials ? ` · ${l.denials} denied` : ""}`),
        h("td", {}, h("span", { class: `pc-chip ${on ? "ok" : ""}` }, on ? "no longer asks" : `${l.streak} of ${l.need}`)),
        h("td", { class: "num" }, on && h("button", { class: "small sig", onclick: async () => { await api("POST", `/api/learned/${l.id}/reset`); toast("It will ask again"); after(); } }, "Ask again")));
    })))
    : h("p", { class: "empty" }, "Nothing learned yet. Approve the same kind of action twice in a row and the crew stops asking, unless it signs in, installs, sends, pays, deletes or shares."));
}
function rulesList(rules, after) {
  return h("div", { class: "pc-card tight" }, rules.length ? h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Standing approval"), h("th", {}, "Effect"), h("th", {}, "Crew"), h("th", {}, "Since"), h("th"))), h("tbody", {}, rules.map((r) => h("tr", {}, h("td", { class: "pc-m" }, r.label), h("td", {}, h("pc-effect", { kind: r.effect }, r.effect)), h("td", {}, r.bot_name || r.bot_id), h("td", { class: "small faint" }, when(r.created_at)),
    h("td", { class: "num" }, h("button", { class: "small sig", onclick: async () => { await api("POST", `/api/rules/${r.id}/revoke`); toast("Revoked"); after(); } }, "Revoke")))))) : h("p", { class: "empty" }, "No standing approvals. Approve with \"Always\" or \"For this thread\" to create one."));
}

// ---------- files ----------
// Workspace browser and per-run diffs. Reads the host's copy of the workspace, so it works with the computer off.
let diffSplit = false;
async function filesView(b, turnId, encPath) {
  const path = encPath ? decodeURIComponent(encPath) : "";
  const [runs] = await Promise.all([api("GET", `/api/bots/${b.id}/changes`)]);
  const viewer = h("div", { class: "pc-card tight viewer" });
  const go = (t, p) => (location.hash = `#/crew/${b.id}/files/${t || "-"}${p != null ? `/${encodeURIComponent(p)}` : ""}`);
  const runList = h("div", { class: "col", style: "gap:2px" }, runs.length ? runs.map((r) => {
    const open = r.id === turnId;
    return h("div", { class: `run ${open ? "on" : ""}` },
      h("button", { class: "runhead", onclick: () => go(r.id) }, h("span", { class: "small" }, r.thread_title), h("span", { class: "pc-m small faint" }, `${r.changes.length} · ${when(r.started_at)}`)),
      open && h("div", { class: "col", style: "gap:0" }, r.changes.map((c) => h("button", { class: `cfile ${c.path === path ? "on" : ""}`, onclick: () => go(r.id, c.path) },
        h("span", { class: `pc-chip ${c.status === "added" ? "ok" : c.status === "deleted" ? "bad" : "blue"}` }, c.status[0].toUpperCase()), h("span", { class: "pc-m small" }, c.path)))));
  }) : h("p", { class: "small faint" }, "No changes recorded yet. Every run's file changes land here, whether made by a patch, a command or a script."));
  const tree = h("div", { class: "tree" });
  const loadDir = async (rel, into, depth) => {
    const d = await api("GET", `/api/bots/${b.id}/fs?path=${encodeURIComponent(rel)}`, undefined, { quiet: true }).catch(() => null);
    if (!d || d.type !== "dir") return;
    into.replaceChildren(...d.entries.map((e) => {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (!e.dir) return h("button", { class: `tf ${turnId === undefined || turnId === "-" ? (p === path ? "on" : "") : ""}`, style: `padding-left:${8 + depth * 14}px`, onclick: () => go("-", p) }, e.name);
      const kids = h("div", { class: "hidden" });
      const btn = h("button", { class: "tf dir", style: `padding-left:${8 + depth * 14}px`, onclick: async () => { const opening = kids.classList.contains("hidden"); kids.classList.toggle("hidden"); btn.classList.toggle("open", opening); if (opening && !kids.childNodes.length) await loadDir(p, kids, depth + 1); } }, e.name);
      return h("div", {}, btn, kids);
    }));
  };
  loadDir("", tree, 0);

  const head = (title, ...acts) => h("div", { class: "vhead" }, h("span", { class: "pc-m small" }, title), h("span", { style: "flex:1" }), ...acts);
  if (turnId && turnId !== "-" && path) {
    const d = await api("GET", `/api/turns/${turnId}/diff?path=${encodeURIComponent(path)}`).catch(() => null);
    const seg = h("div", { class: "seg" }, ["unified", "split"].map((m) => h("button", { class: (m === "split") === diffSplit ? "on" : "", onclick: () => { diffSplit = m === "split"; renderView(); } }, m)));
    viewer.replaceChildren(head(`${path} · ${d?.status || ""}`, seg, d?.status !== "deleted" ? h("a", { class: "pc-pill o s", href: `/files/${b.id}/${path.split("/").map(encodeURIComponent).join("/")}` }, "Download") : null),
      !d ? h("p", { class: "empty" }, "Couldn't load this change.") : !d.text ? h("p", { class: "empty" }, `Binary file ${d.status}. ${d.size} bytes.`) : renderDiff(d.beforeText, d.afterText, { split: diffSplit }));
  } else if (path) {
    const f = await api("GET", `/api/bots/${b.id}/fs?path=${encodeURIComponent(path)}`).catch(() => null);
    const url = `/files/${b.id}/${path.split("/").map(encodeURIComponent).join("/")}`;
    viewer.replaceChildren(head(path, h("span", { class: "pc-m small faint" }, f ? `${f.size} bytes · ${when(f.mtime)}` : ""), h("a", { class: "pc-pill o s", href: url }, "Download")),
      !f ? h("p", { class: "empty" }, "Not found.") : f.image ? h("div", { style: "padding:16px" }, h("img", { src: `${url}?inline=1`, style: "max-width:100%;border-radius:10px" })) : f.text != null ? h("div", { class: "code" }, f.text.split("\n").map((l, i) => h("div", { class: "dl" }, h("span", { class: "ln" }, String(i + 1)), h("code", {}, l)))) : h("p", { class: "empty" }, "Binary or large file. Download it to open."));
  } else viewer.replaceChildren(h("p", { class: "empty" }, turnId && turnId !== "-" ? "Pick a file from this run to see its diff." : "Pick a file to view it, or a run to review what changed."));

  return h("div", { class: "files" }, h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Changes by run"), runList, h("p", { class: "pc-lab", style: "margin-top:12px" }, "Workspace /bot/work"), tree), viewer);
}

// ---------- thread ----------
async function threadView(id) {
  if (!id) { location.hash = "#/"; return null; }
  const d = await api("GET", `/api/threads/${id}`);
  const b = { ...d.bot, ...(bot(d.bot.id) || {}) };
  const pits = new Map(d.pitstops.map((p) => [p.id, p]));
  const surfaces = new Map(d.surfaces.map((s) => [s.id, s]));
  const stream = h("div", { class: "stream" });
  const nearBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
  const scroll = (force) => { if (force || nearBottom()) requestAnimationFrame(() => (stream.scrollTop = stream.scrollHeight)); };
  const liveLine = h("div", { class: "live hidden" }, h("pc-loader", {}), h("span", {}, "On track"));
  let streaming = null;

  const renderEvent = (e) => {
    switch (e.kind) {
      case "user": return h("div", { class: "msg me" }, e.data.via === "schedule" ? h("span", { class: "pc-lab" }, "scheduled · ") : null, e.data.display || e.data.text, e.data.attachments?.length ? h("div", { class: "sent-atts" }, e.data.attachments.map((p) => /\.(png|jpe?g|webp|gif)$/i.test(p)
        ? h("a", { href: `/files/${b.id}/${p}?inline=1`, target: "_blank", rel: "noopener" }, h("img", { src: `/files/${b.id}/${p}?inline=1`, alt: p.split("/").pop(), loading: "lazy" }))
        : h("a", { class: "pc-chip", href: `/files/${b.id}/${p}` }, p.split("/").pop().replace(/^[a-z0-9]+-/, "")))) : null);
      case "agent": return h("div", { class: "msg bot" }, face(b, "sm", "idle"), md(e.data.text));
      case "tool": return h("details", { class: "tool" }, h("summary", {}, h("span", { class: `st ${stepOk(e) ? "ok" : e.data.status === "inProgress" ? "" : "bad"}` }), tidyTitle(e.data.title)), (e.data.output || e.data.error) && h("pre", {}, e.data.error || e.data.output));
      case "system": return h("p", { class: `sys ${e.data.tone === "bad" ? "bad" : ""}` }, e.data.text);
      case "error": return h("p", { class: "err" }, e.data.text);
      case "changes": return h("div", { class: "changes" }, h("div", { class: "spread" }, h("b", { class: "small" }, `Changed ${e.data.count} file${e.data.count === 1 ? "" : "s"}`), h("a", { class: "small faint", href: `#/crew/${e.data.botId}/files/${e.data.turnId}` }, "Review changes")),
        e.data.files.map((f) => h("a", { class: "cf", href: `#/crew/${e.data.botId}/files/${e.data.turnId}/${encodeURIComponent(f.path)}` }, h("span", { class: `pc-chip ${f.status === "added" ? "ok" : f.status === "deleted" ? "bad" : "blue"}` }, f.status[0].toUpperCase()), h("span", { class: "pc-m small" }, f.path), f.lines ? h("span", { class: `pc-m small ${f.lines > 0 ? "okc" : "badc"}` }, `${f.lines > 0 ? "+" : ""}${f.lines} lines`) : null)));
      case "pitstop": { const p = pits.get(e.data.id); return p ? h("div", { style: "margin-left:40px;max-width:760px" }, pitCard(p, { onDone: () => renderView() })) : null; }
      case "surface": {
        const s = surfaces.get(e.data.id);
        if (!s) return null;
        const saveBtn = h("button", { class: "small faint", onclick: async () => { s.saved = s.saved ? 0 : 1; await api("POST", `/api/surfaces/${s.id}/save`, { saved: !!s.saved }); saveBtn.textContent = s.saved ? "Saved to Library" : "Keep in Library"; } }, s.saved ? "Saved to Library" : "Keep in Library");
        return renderSurface(s, { extra: saveBtn, onAction: async (action, values, el) => { await api("POST", `/api/surfaces/${s.id}/action`, { action, values }); el.querySelectorAll("button,input,select,textarea").forEach((x) => (x.disabled = true)); toast("Sent to the crew"); } });
      }
    }
    return null;
  };
  // A run's tool calls fold into one "N steps" row per stretch between messages: open while the run goes, folded after.
  let group = null;
  const place = (e, el, before = null) => {
    const add = (x) => (before ? before.before(x) : stream.append(x));
    if (e.kind !== "tool") { group = null; add(el); return; }
    const turn = e.turn_id ?? e.turnId ?? null;
    const adjacent = group && group.el.parentNode === stream && (before ? group.el.nextElementSibling === before : stream.lastElementChild === group.el);
    if (!adjacent || group.turn !== turn) {
      const body = h("div", { class: "steps-body" }), label = h("span", {}), last = h("span", { class: "last" });
      group = { el: h("details", { class: "steps" }, h("summary", {}, label, last), body), body, label, last, turn, n: 0, bad: 0 };
      group.el.open = !!before; // set as a property: h() reads any "on…" attribute as an event handler
      add(group.el);
    }
    group.body.append(el); group.n++; if (!stepOk(e) && e.data.status !== "inProgress") group.bad++;
    group.label.textContent = `${group.n} step${group.n === 1 ? "" : "s"}${group.bad ? ` · ${group.bad} failed` : ""}`;
    group.last.textContent = tidyTitle(e.data.title);
  };
  for (const e of d.events) { const el = renderEvent(e); if (el) place(e, el); }
  if (d.thread.running && group) group.el.open = true;
  stream.append(liveLine);

  const running = () => d.thread.running;
  const text = h("textarea", { placeholder: `Message ${b.name}…`, rows: 1 });
  let mode = "steer";
  const modeSeg = h("div", { class: "seg hidden" }, ["steer", "queue"].map((m) => h("button", { class: m === mode ? "on" : "", onclick: (ev) => { mode = m; modeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === ev.target)); } }, m === "steer" ? "Steer now" : "Queue after")));
  const attachments = [];   // { path, name, url? } — url is a local preview for images
  const attList = h("div", { class: "atts hidden" });
  const isImg = (n) => /\.(png|jpe?g|webp|gif)$/i.test(n);
  const paintAtts = () => {
    attList.classList.toggle("hidden", !attachments.length);
    attList.replaceChildren(...attachments.map((a, i) => h("div", { class: `att ${a.url ? "img" : ""}`, title: a.name },
      a.url ? h("img", { src: a.url, alt: a.name }) : h("span", { class: "pc-m small" }, a.name),
      h("button", { class: "x", title: "Remove", onclick: () => { if (a.url) URL.revokeObjectURL(a.url); attachments.splice(i, 1); paintAtts(); } }, "×"))));
  };
  const file = h("input", { type: "file", class: "hidden", multiple: true });
  const upload = async (files) => {
    for (const f of files) {
      const r = await api("POST", `/api/threads/${id}/upload?name=${encodeURIComponent(f.name)}`, f, { raw: true });
      attachments.push({ path: r.path, name: f.name, url: isImg(f.name) ? URL.createObjectURL(f) : null }); paintAtts();
    }
  };
  file.addEventListener("change", async () => { await upload([...file.files]); file.value = ""; });
  const sendBtn = h("button", { class: "pc-pill s" }, "Send");
  const stopBtn = h("button", { class: "pc-pill o s hidden" }, "Stop");
  const grow = () => { text.style.height = "auto"; text.style.height = `${Math.min(220, text.scrollHeight)}px`; };
  text.addEventListener("input", grow);
  text.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); upload(fs); } });
  const send = async () => {
    if (!text.value.trim() && !attachments.length) return;
    sendBtn.disabled = true;
    try {
      await api("POST", `/api/threads/${id}/messages`, { text: text.value, attachments: attachments.map((a) => a.path), mode: running() ? mode : "auto" });
      text.value = ""; grow(); attachments.splice(0).forEach((a) => a.url && URL.revokeObjectURL(a.url)); paintAtts();
    } finally { sendBtn.disabled = false; text.focus(); }
  };
  sendBtn.addEventListener("click", send);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  stopBtn.addEventListener("click", () => api("POST", `/api/threads/${id}/interrupt`));
  const setRunning = (r) => { d.thread.running = r; liveLine.classList.toggle("hidden", !r); modeSeg.classList.toggle("hidden", !r); stopBtn.classList.toggle("hidden", !r); };
  setRunning(d.thread.running);

  const ctxFill = h("b", { style: "width:0%" }), ctxMeter = h("div", { class: "meter" }, ctxFill), ctxLabel = h("span", { class: "pc-m small faint" });
  const setCtx = (tokens, win) => { if (!tokens || !win) { ctxLabel.textContent = "no runs yet"; return; } const pct = Math.min(100, (tokens / win) * 100); ctxFill.style.width = `${pct}%`; ctxMeter.classList.toggle("hot", pct > 70); ctxLabel.textContent = `${Math.round(tokens / 1000)}k / ${Math.round(win / 1000)}k tokens`; };
  setCtx(d.thread.ctx_tokens, d.thread.ctx_window);
  const title = h("h1", { class: "pc-h2", title: "Click to rename" }, d.thread.title);
  title.addEventListener("click", () => { const i = h("input", { value: d.thread.title }); title.replaceWith(i); i.focus(); const done = async () => { await api("PATCH", `/api/threads/${id}`, { title: i.value || d.thread.title }); d.thread.title = i.value || d.thread.title; title.textContent = d.thread.title; i.replaceWith(title); }; i.addEventListener("blur", done); i.addEventListener("keydown", (e) => e.key === "Enter" && i.blur()); });

  // Hand back works from chat too, so a held lease never strands the crew behind a screen you can't reach.
  const leaseBack = h("button", { class: `pc-pill sig s${b.computer?.lease ? "" : " hidden"}`, onclick: async () => { await api("POST", `/api/bots/${b.id}/computer/handback`); leaseBack.classList.add("hidden"); } }, "Hand back control");
  const panel = h("aside", { class: "panel" },
    h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Crew member"), h("a", { class: "row", href: `#/crew/${b.id}` }, face(b, "md"), h("div", {}, h("b", { class: "pc-h3" }, b.name), h("p", { class: "pc-m small faint" }, `${b.provider} · ${b.model}`)))),
    h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Context"), ctxMeter, ctxLabel, h("div", { class: "row" }, h("button", { class: "pc-pill o s", onclick: async () => { await api("POST", `/api/threads/${id}/compact`); } }, "Compact"), h("button", { class: "pc-pill o s", onclick: async () => { const r = await api("POST", `/api/threads/${id}/fresh`); location.hash = `#/t/${r.id}`; } }, "Fresh thread from here"))),
    h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Computer"), leaseBack, b.computer?.desktop ? h("div", { class: "col", style: "gap:8px" }, h("a", { class: "mini", href: `#/live/${b.id}` }, h("span", { class: "pc-pill s" }, "Watch live")), h("button", { class: "small", style: "text-align:left;padding:0", onclick: () => openDock(b) }, "Watch in a corner while you chat")) : h("div", { class: "mini" }, h("span", { class: "small faint" }, b.computer?.up ? "Runtime up · no desktop yet" : "In the garage")), h("p", { class: "small faint" }, "Chat needs no computer. It starts on the first command or browser action and stops after 10 idle minutes."), h("a", { class: "small", href: `#/crew/${b.id}/files` }, "Browse files and changes")),
    h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Other threads"), ...(bot(b.id)?.threads || []).filter((t) => t.id !== id).slice(0, 8).map((t) => h("a", { class: "small muted", href: `#/t/${t.id}` }, t.title))),
    h("button", { class: "small faint", style: "text-align:left;padding:0", onclick: async (e) => { if (!confirmInline(e.target, "Archive?")) return; await api("PATCH", `/api/threads/${id}`, { archived: true }); location.hash = `#/crew/${b.id}`; } }, "Archive thread"));

  const page = h("div", { class: "threadpage" },
    h("section", { class: "convo" }, h("header", {}, face(b, "sm"), title, h("span", { class: "pc-chip" }, b.name)), stream,
      h("div", { class: "composer" }, h("div", { class: "box" }, attList, text,
        h("div", { class: "bar" }, h("button", { class: "attach", title: "Attach files or paste an image", onclick: () => file.click() }, "+ Attach"), file, h("span", { class: "small faint hint" }, "Enter to send · Shift+Enter for a new line"), h("span", { style: "flex:1" }), modeSeg, stopBtn, sendBtn)))),
    panel);

  threadHook = async (type, x) => {
    if (x.threadId !== id && !(type === "pitstop" && x.botId === b.id) && type !== "lease") return;
    if (type === "lease" && x.botId === b.id) leaseBack.classList.toggle("hidden", !x.held);
    if (type === "delta") {
      if (!streaming || streaming.itemId !== x.itemId) { streaming = { itemId: x.itemId, text: "", el: h("div", { class: "msg bot" }, face(b, "sm", "working"), h("div", { class: "md" })) }; liveLine.before(streaming.el); }
      streaming.text += x.text; streaming.el.lastChild.textContent = streaming.text; scroll();
    } else if (type === "event") {
      if (x.kind === "agent" && streaming) { streaming.el.remove(); streaming = null; }
      if (x.kind === "pitstop") { const all = await api("GET", "/api/pitstops?status=pending", undefined, { quiet: true }).catch(() => []); for (const p of all) pits.set(p.id, p); }
      if (x.kind === "surface") { const fresh = await api("GET", `/api/threads/${id}`, undefined, { quiet: true }).catch(() => null); for (const s of fresh?.surfaces || []) surfaces.set(s.id, s); }
      const el = renderEvent(x); if (el) { place(x, el, liveLine); scroll(x.kind === "user"); }
    } else if (type === "activity") { liveLine.lastChild.textContent = x.text; }
    else if (type === "context") setCtx(x.tokens, x.window);
    else if (type === "thread") { setRunning(x.status === "running" || x.status === "needs"); if (x.title && title.isConnected) { d.thread.title = x.title; title.textContent = x.title; } }
    else if (type === "turn") { setRunning(false); if (streaming) { streaming.el.remove(); streaming = null; } stream.querySelectorAll("details.steps[open]").forEach((x) => (x.open = false)); }
    else if (type === "pitstop" && x.status !== "pending") { const all = await api("GET", `/api/threads/${id}`, undefined, { quiet: true }).catch(() => null); if (all) { for (const p of all.pitstops) pits.set(p.id, p); stream.querySelectorAll(".pit").forEach(() => {}); } }
  };
  setTimeout(() => scroll(true), 30);
  return page;
}

// ---------- pit stops ----------
async function pitstopsView() {
  const [pending, history, rules, learned] = await Promise.all([api("GET", "/api/pitstops?status=pending"), api("GET", "/api/pitstops"), api("GET", "/api/rules"), api("GET", "/api/learned")]);
  const picks = new Set();
  const batch = async (decision) => { if (!picks.size) return toast("Pick some pit stops first"); await api("POST", "/api/pitstops/batch", { ids: [...picks], decision }); toast(`${decision === "approve" ? "Approved" : "Denied"} ${picks.size}`); renderView(); };
  return h("div", { class: "page" },
    h("div", { class: "spread" }, h("h1", { class: "pc-h2" }, "Pit stops"), pending.length > 1 && h("div", { class: "row" }, h("button", { class: "pc-pill sig s", onclick: () => batch("approve") }, "Approve selected"), h("button", { class: "pc-pill o s", onclick: () => batch("deny") }, "Deny selected"))),
    pending.length ? h("div", { class: "col" }, pending.map((p) => h("div", { class: "row", style: "align-items:flex-start;flex-wrap:nowrap" }, p.kind !== "hire" ? h("input", { type: "checkbox", style: "margin-top:22px", onchange: (e) => (e.target.checked ? picks.add(p.id) : picks.delete(p.id)) }) : h("span", { style: "width:13px" }), h("div", { style: "flex:1" }, pitCard(p, { onDone: () => renderView() })))))
      : h("div", { class: "pc-card empty" }, h("pc-bot", { size: "lg", hue: "c3", mood: "done" }), h("p", { style: "margin-top:12px" }, "Nothing waiting. Ignored pit stops expire after 30 minutes and nothing happens.")),
    h("p", { class: "pc-lab" }, "Standing approvals"), rulesList(rules, () => renderView()),
    h("p", { class: "pc-lab" }, "Learned"), learnedList(learned, () => renderView()),
    h("p", { class: "pc-lab" }, "History"),
    h("div", { class: "pc-card tight scrollx" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Crew"), h("th", {}, "Effect"), h("th", {}, "What"), h("th", {}, "Outcome"), h("th", {}, "Decided by"))),
      h("tbody", {}, history.filter((p) => p.status !== "pending").slice(0, 80).map((p) => h("tr", {}, h("td", { class: "small faint" }, when(p.created_at)), h("td", {}, bot(p.bot_id)?.name || p.bot_id), h("td", {}, effectChip(p.effect)), h("td", {}, p.title),
        h("td", {}, h("span", { class: `pc-chip ${p.status === "approved" ? "ok" : p.status === "denied" ? "bad" : ""}` }, p.status)), h("td", { class: "small faint" }, p.status === "expired" ? "timeout" : p.scope || "once")))))));
}

// ---------- telemetry ----------
async function telemetryView() {
  const t = await api("GET", "/api/telemetry");
  const waitMin = Math.round((t.pitstops?.wait_ms || 0) / 60000);
  return h("div", { class: "page" },
    h("div", { class: "spread" }, h("h1", { class: "pc-h2" }, "Telemetry"), h("div", { class: "row" }, h("a", { class: "pc-pill o s", href: "/api/export", download: "" }, "Export everything (JSON)"))),
    h("div", { class: "grid3" },
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Handled this week"), h("span", { class: "big num" }, String(t.handled)), h("p", { class: "small muted" }, "runs completed")),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Asked of you"), h("span", { class: "big num" }, String(t.pitstops?.total || 0)), h("p", { class: "small muted" }, `pit stops · ${t.pitstops?.approved || 0} approved · ${t.pitstops?.denied || 0} denied · ${t.pitstops?.expired || 0} expired · crew waited ${waitMin} min on you`)),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "OpenRouter says"), t.openrouter ? [h("span", { class: "big num" }, usd(t.openrouter.usage_daily ?? t.openrouter.usage ?? 0)), h("p", { class: "small muted" }, `${t.openrouter.usage_daily != null ? "today" : "total"} on this key, as reported by OpenRouter · weekly ${usd(t.openrouter.usage_weekly ?? 0)}`)] : h("p", { class: "small muted" }, "No OpenRouter key connected."))),
    h("p", { class: "pc-lab" }, "Spend by crew member (this week; billed by the provider, list-price estimate otherwise)"),
    h("div", { class: "pc-card col" }, t.bots.map((b) => h("div", { class: "col", style: "gap:4px" }, h("div", { class: "spread" }, h("div", { class: "row" }, h("pc-bot", { size: "xs", hue: b.hue, shape: b.shape }), h("b", {}, b.name), h("span", { class: "small faint" }, `${b.runs} runs${b.failed ? ` · ${b.failed} failed` : ""}`)), h("span", { class: "pc-m small" }, `${usd(b.spend)} / ${usd(b.cap)}`)),
      h("pc-track", { pct: Math.min(100, (b.spend / (b.cap || 1)) * 100).toFixed(0), hue: b.hue, shape: b.shape, state: "working" })))),
    t.byModel.length > 0 && [h("p", { class: "pc-lab" }, "By model"), h("div", { class: "pc-card tight scrollx" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Provider"), h("th", {}, "Model"), h("th", { class: "num" }, "Runs"), h("th", { class: "num" }, "Input"), h("th", { class: "num" }, "Output"), h("th", { class: "num" }, "Cost"))),
      h("tbody", {}, t.byModel.map((m) => h("tr", {}, h("td", {}, m.provider), h("td", { class: "pc-m" }, m.model), h("td", { class: "num" }, m.runs), h("td", { class: "num" }, (m.input || 0).toLocaleString("en-IN")), h("td", { class: "num" }, (m.output || 0).toLocaleString("en-IN")), h("td", { class: "num" }, m.provider === "openai" ? "plan" : usd(m.usd))))))),],
    h("p", { class: "pc-lab" }, "Runs"),
    h("div", { class: "pc-card tight scrollx" }, t.runs.length ? h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "Started"), h("th", {}, "Crew"), h("th", {}, "Thread"), h("th", {}, "Trigger"), h("th", {}, "Outcome"), h("th", { class: "num" }, "Tokens in/out"), h("th", { class: "num" }, "Cost"))),
      h("tbody", {}, t.runs.map((r) => { const tr = h("tr", { style: "cursor:pointer" }, h("td", { class: "small faint" }, when(r.started_at)), h("td", {}, r.bot_name), h("td", {}, r.thread_title), h("td", { class: "small" }, r.trigger), h("td", {}, h("span", { class: `pc-chip ${r.status === "completed" ? "ok" : r.status === "failed" ? "bad" : ""}` }, r.status), r.error && h("p", { class: "small badc" }, r.error.slice(0, 120))),
        h("td", { class: "num pc-m small" }, `${(r.input_tokens || 0).toLocaleString("en-IN")} / ${(r.output_tokens || 0).toLocaleString("en-IN")}`), h("td", { class: "num pc-m", title: r.cost_basis === "billed" ? "Billed by the provider" : r.cost_basis === "list" ? "Estimate from list price" : "" }, r.cost_basis === "plan" ? "plan" : r.cost_basis === "unknown" ? "?" : `${usd(r.cost_usd)}${r.cost_basis === "list" ? " est." : ""}`)); tr.addEventListener("click", () => (location.hash = `#/t/${r.thread_id}`)); return tr; }))) : h("p", { class: "empty" }, "No runs yet.")));
}

// ---------- library ----------
async function libraryView() {
  const [files, surfaces] = await Promise.all([api("GET", "/api/library"), api("GET", "/api/surfaces")]);
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  return h("div", { class: "page" }, h("h1", { class: "pc-h2" }, "Library"),
    surfaces.length > 0 && [h("p", { class: "pc-lab" }, "Kept surfaces"), h("div", { class: "col" }, surfaces.map((s) => renderSurface(s, { extra: h("a", { class: "small faint", href: `#/t/${s.thread_id}` }, s.bot_name), onAction: async (action, values) => { await api("POST", `/api/surfaces/${s.id}/action`, { action, values }); toast("Sent to the crew"); } })))],
    h("p", { class: "pc-lab" }, "Files from the crew's computers"),
    files.map((b) => h("div", { class: "pc-card tight" }, h("div", { class: "row", style: "padding:14px 16px" }, h("pc-bot", { size: "xs", hue: b.hue, shape: b.shape }), h("b", {}, b.name), h("span", { class: "small faint" }, `${b.files.length} file${b.files.length === 1 ? "" : "s"}`)),
      b.files.length ? h("table", { class: "tbl" }, h("tbody", {}, b.files.slice(0, 100).map((f) => h("tr", {}, h("td", { class: "pc-m small" }, f.path), h("td", { class: "num small faint" }, kb(f.size)), h("td", { class: "num small faint" }, when(f.mtime)), h("td", { class: "num" }, h("a", { class: "small", href: `/files/${b.id}/${f.path.split("/").map(encodeURIComponent).join("/")}` }, "Download")))))) : null)));
}

// ---------- hire ----------
async function hireView(psId) {
  let spec = {}, ps = null;
  if (psId) { ps = (await api("GET", "/api/pitstops?status=pending")).find((p) => p.id === psId); if (!ps) return h("div", { class: "page" }, h("p", { class: "muted" }, "That proposal was already decided."), h("a", { class: "pc-pill s", href: "#/pitstops" }, "Pit stops")); spec = ps.detail.spec || {}; }
  const p = spec.personality || {};
  let hue = spec.hue || ["c2", "c3", "c5", "c6"][Math.floor(Math.random() * 4)], shape = spec.shape || "round";
  const preview = h("pc-bot", { size: "xl", hue, shape, mood: "idle" });
  const f = { name: h("input", { value: spec.name || "", placeholder: "e.g. Bills" }), job: h("textarea", { placeholder: "What this crew member does, in a sentence or two" }, spec.job || ""), role: h("input", { value: p.role || "", placeholder: "Role line, e.g. Unflappable accountant" }),
    quirks: h("input", { value: (p.quirks || []).join("; "), placeholder: "Up to 3 quirks, separated by ;" }), signoff: h("input", { value: p.signoff || "" }), callMe: h("input", { value: p.callMe || "" }),
    cap: h("input", { type: "number", min: 0, step: "0.5", value: spec.weekly_cap_usd ?? 5 }), sSpec: h("input", { value: spec.schedule?.spec || "", placeholder: "Optional: daily 09:00" }), sPrompt: h("input", { value: spec.schedule?.prompt || "", placeholder: "What to do on schedule" }) };
  const dials = {}; for (const k of ["warmth", "talk", "humour"]) { dials[k] = h("input", { type: "range", min: 1, max: 5, value: p[k] || 3 }); }
  const pm = await providerModelPicker(spec.provider || S.defaultProvider, spec.model || "");
  const swatches = h("div", { class: "swatches" }, ["c1", "c2", "c3", "c5", "c6"].map((c) => h("button", { class: `swatch ${c === hue ? "on" : ""}`, style: `--hue:var(--${c})`, title: c, onclick: (e) => { hue = c; preview.setAttribute("hue", c); swatches.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === e.currentTarget)); } })));
  const shapes = h("div", { class: "shapes" }, ["square", "round", "blob"].map((s) => h("button", { class: s === shape ? "on" : "", onclick: (e) => { shape = s; preview.setAttribute("shape", s); shapes.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === e.currentTarget)); } }, h("pc-bot", { size: "sm", hue: "c1", shape: s }))));
  const collect = () => ({ name: f.name.value, job: f.job.value, hue, shape, provider: pm.provider(), model: pm.model(), weekly_cap_usd: +f.cap.value,
    personality: { role: f.role.value, warmth: +dials.warmth.value, talk: +dials.talk.value, humour: +dials.humour.value, quirks: f.quirks.value.split(";").map((s) => s.trim()).filter(Boolean), signoff: f.signoff.value, callMe: f.callMe.value },
    schedule: f.sSpec.value.trim() ? { spec: f.sSpec.value.trim(), prompt: f.sPrompt.value.trim() } : null, reason: spec.reason || "" });
  const review = h("div", { class: "pc-card col hidden" });
  const toReview = () => {
    const s = collect();
    if (!s.name.trim() || !s.job.trim()) return toast("Give them a name and a job", true);
    review.replaceChildren(h("p", { class: "pc-lab" }, "Review & hire"), hireSummary(s),
      h("p", { class: "small muted" }, "Starts with read, draft and browse allowed. Sign-in, install, send and pay ask first. Delete and share always ask. It gets its own computer, browser profile and network."),
      h("div", { class: "row" }, h("button", { class: "pc-pill sig", onclick: async () => {
        if (ps) { await api("POST", `/api/pitstops/${ps.id}/decide`, { decision: "approve", spec: s }); }
        else await api("POST", "/api/hire", s);
        toast(`${s.name} is on the crew`); S = await api("GET", "/api/state"); renderChrome(); location.hash = "#/";
      } }, `Hire ${s.name}`), h("button", { class: "pc-pill o", onclick: () => review.classList.add("hidden") }, "Back to edit"),
      ps && h("button", { class: "pc-pill o", onclick: async () => { await api("POST", `/api/pitstops/${ps.id}/decide`, { decision: "deny" }); location.hash = "#/"; } }, "Decline proposal")));
    review.classList.remove("hidden"); review.scrollIntoView({ behavior: "smooth" });
  };
  return h("div", { class: "page" },
    h("div", { class: "col", style: "gap:6px" }, h("h1", { class: "pc-h2" }, ps ? "The Crew Chief proposes a crew member" : "New crew member"), ps && spec.reason && h("p", { class: "pc-quote" }, spec.reason)),
    h("div", { class: "grid2" },
      h("div", { class: "pc-card col" }, h("div", { class: "row", style: "gap:18px" }, preview, h("div", { class: "col" }, h("p", { class: "pc-lab" }, "Face"), swatches, shapes)), lab("Name", f.name), lab("Job", f.job), pm.el, lab("Weekly cap (USD)", f.cap), h("div", { class: "grid2" }, lab("Schedule", f.sSpec), lab("Scheduled task", f.sPrompt))),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Personality (voice only)"), lab("Role line", f.role),
        ...Object.entries(dials).map(([k, el]) => { const v = h("span", { class: "pc-m faint" }, el.value); el.addEventListener("input", () => { v.textContent = el.value; }); return h("div", { class: "dial" }, h("span", { class: "muted" }, k[0].toUpperCase() + k.slice(1)), el, v); }),
        lab("Quirks", f.quirks), lab("Sign-off", f.signoff), lab("Calls you", f.callMe, `Default: ${S.driverName}`))),
    h("div", { class: "row" }, h("button", { class: "pc-pill", onclick: toReview }, "Review")), review);
}

// ---------- settings ----------
async function settingsView() {
  const prov = await api("GET", "/api/providers");
  const keyCard = (id, hint) => {
    const p = prov[id];
    const input = h("input", { type: "password", autocomplete: "off", placeholder: p.connected ? "Replace key" : hint });
    const status = h("p", { class: `small ${p.test?.ok === false ? "badc" : "muted"}` }, p.connected ? `Connected · saved ${when(p.updatedAt)}${p.test ? ` · ${p.test.detail}` : ""}` : "Not connected");
    const save = async (e) => { e.target.disabled = true; try { const r = await api("PUT", `/api/providers/${id}/key`, { key: input.value }); input.value = ""; toast(r.detail, !r.ok); renderView(); } finally { e.target.disabled = false; } };
    return h("div", { class: "pc-card col" }, h("div", { class: "spread" }, h("b", { class: "pc-h3" }, p.label), h("span", { class: `pc-chip ${p.connected ? "ok" : ""}` }, p.connected ? "connected" : "off")), status, input,
      h("div", { class: "row" }, h("button", { class: "pc-pill s", onclick: save }, "Save and test"), p.connected && h("button", { class: "pc-pill o s", onclick: async () => { const r = await api("POST", `/api/providers/${id}/test`); toast(r.detail, !r.ok); renderView(); } }, "Test"), p.connected && h("button", { class: "small faint", onclick: async (e) => { if (!confirmInline(e.target, "Remove?")) return; await api("DELETE", `/api/providers/${id}/key`); renderView(); } }, "Remove")),
      h("p", { class: "small faint" }, "Keys are write-only: stored encrypted on the server and never shown again."));
  };
  const cg = prov.openai, login = cg.login || {};
  const chatgpt = h("div", { class: "pc-card col" }, h("div", { class: "spread" }, h("b", { class: "pc-h3" }, "Sign in with ChatGPT"), h("span", { class: `pc-chip ${cg.connected ? "ok" : ""}` }, cg.connected ? "connected" : "off")),
    h("p", { class: "small muted" }, "Use your ChatGPT plan for crew members set to the ChatGPT provider. Runs cost nothing extra; they count against the plan's limits."),
    login.status === "waiting" ? h("div", { class: "col" }, h("p", {}, "Open ", h("a", { class: "md", href: login.url, target: "_blank", rel: "noopener noreferrer" }, h("span", {}, login.url)), " and enter this code:"), h("p", { class: "big num" }, login.code), h("div", { class: "row" }, h("pc-loader", {}), h("span", { class: "small faint" }, "Waiting for you to finish…")), h("button", { class: "small faint", onclick: async () => { await api("POST", "/api/providers/openai/cancel"); renderView(); } }, "Cancel"))
      : login.status === "starting" ? h("div", { class: "row" }, h("pc-loader", {}), h("span", { class: "small" }, "Getting a device code…"))
      : h("div", { class: "row" }, h("button", { class: "pc-pill s", onclick: async () => { await api("POST", "/api/providers/openai/login"); pollLogin(); } }, cg.connected ? "Sign in again" : "Sign in with ChatGPT"), cg.connected && h("button", { class: "pc-pill o s", onclick: async (e) => { if (!confirmInline(e.target, "Sign out?")) return; await api("POST", "/api/providers/openai/signout"); renderView(); } }, "Sign out")),
    login.status === "failed" && h("p", { class: "small badc" }, `Sign-in didn't finish: ${login.error || "unknown error"}`));
  const pollLogin = () => { let n = 0; const t = setInterval(async () => { if (current.name !== "settings" || ++n > 400) return clearInterval(t); const pr = await api("GET", "/api/providers", undefined, { quiet: true }).catch(() => null); const st = pr?.openai?.login?.status; if (st !== "starting") renderView(); if (st !== "starting" && st !== "waiting") clearInterval(t); }, 2500); };
  if (login.status === "waiting" || login.status === "starting") setTimeout(pollLogin, 2500);

  const name = h("input", { value: S.driverName });
  const defProv = h("select", {}, Object.entries(prov).map(([k, p]) => h("option", { value: k, selected: k === S.defaultProvider }, p.label)));
  const plain = h("input", { type: "checkbox", checked: S.plainVoice });
  const theme = h("div", { class: "seg" }, ["dark", "light"].map((t) => h("button", { class: document.documentElement.dataset.theme === t ? "on" : "", onclick: (e) => { document.documentElement.dataset.theme = t; try { localStorage.setItem("pc-theme", t); } catch {} theme.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target)); } }, t)));
  const cur = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" }), nxt = h("input", { type: "password", placeholder: "New password (12+)", autocomplete: "new-password" });
  return h("div", { class: "page" }, h("h1", { class: "pc-h2" }, "Settings"),
    h("p", { class: "pc-lab" }, "Providers"), h("div", { class: "grid3" }, keyCard("openrouter", "sk-or-…"), keyCard("aigateway", "AI Gateway key"), chatgpt),
    h("p", { class: "small faint" }, "jev (the pit-stop decider) runs on TypeSafe Jev through your OpenRouter key. Without one, every consequential action becomes a pit stop."),
    h("p", { class: "pc-lab" }, "You and the crew"),
    h("div", { class: "grid2" }, h("div", { class: "pc-card col" }, lab("Your name", name), lab("Default provider for new crew members", defProv), h("label", { class: "row small" }, plain, "Plain voice for the whole crew"),
      h("button", { class: "pc-pill s", onclick: async () => { S = await api("PATCH", "/api/settings", { driverName: name.value, defaultProvider: defProv.value, plainVoice: plain.checked }); renderChrome(); toast("Saved"); } }, "Save")),
      h("div", { class: "pc-card col" }, h("p", { class: "pc-lab" }, "Appearance"), theme, h("p", { class: "pc-lab" }, "Password"), cur, nxt, h("div", { class: "row" }, h("button", { class: "pc-pill o s", onclick: async () => { await api("POST", "/api/password", { current: cur.value, next: nxt.value }); location.reload(); } }, "Change password"), h("button", { class: "pc-pill o s", onclick: async () => { await api("POST", "/api/logout"); location.reload(); } }, "Sign out")))),
    h("p", { class: "pc-lab" }, "Kill switch"),
    h("div", { class: "pc-card spread" }, h("div", { class: "col", style: "gap:4px;flex:1" }, h("b", { class: "pc-h3" }, S.paused ? "The crew is stopped" : "Stop every crew member now"), h("p", { class: "small muted" }, "Interrupts every run, denies every pending pit stop, stops every computer and pauses schedules until you resume.")),
      S.paused ? h("button", { class: "pc-pill", onclick: async () => { S = await api("POST", "/api/resume"); renderChrome(); renderView(); } }, "Resume the crew")
        : h("button", { class: "pc-pill sig", onclick: async (e) => { if (!confirmInline(e.target, "Stop everything?")) return; const r = await api("POST", "/api/kill"); toast(`Stopped. ${r.inFlight.length} run${r.inFlight.length === 1 ? " was" : "s were"} mid-flight.`); S = await api("GET", "/api/state"); renderChrome(); renderView(); } }, "Stop the crew")));
}

// ---------- live view ----------
let rfb = null;
async function liveView(id) {
  const d = await api("GET", `/api/bots/${id}`);
  const b = d.bot;
  const screen = h("div", { class: "vnc" });
  const leaseBtn = h("button", { class: "pc-pill sig s" });
  const note = h("input", { placeholder: "What changed? (sent to the crew when you hand back)", class: "small", style: "max-width:380px" });
  let held = b.computer.lease;
  const paint = () => { leaseBtn.textContent = held ? "Hand back" : "Take control"; note.classList.toggle("hidden", !held); if (rfb) rfb.viewOnly = !held; };
  leaseBtn.addEventListener("click", async () => {
    if (held) { await api("POST", `/api/bots/${id}/computer/handback`, { note: note.value }); note.value = ""; held = false; }
    else { await api("POST", `/api/bots/${id}/computer/take`); held = true; }
    paint();
  });
  const status = h("span", { class: "small faint" }, "Connecting…");
  const page = h("div", { class: "liveview" }, h("header", {}, face(b, "sm"), h("b", { class: "pc-h3" }, `${b.name}'s computer`), status, h("span", { style: "flex:1" }), note, leaseBtn,
    h("button", { class: "pc-pill o s", title: "Keep watching in a corner", onclick: () => { location.hash = backTo || `#/crew/${id}`; openDock(b); } }, "Minimize"),
    h("a", { class: "pc-pill o s", href: backTo || `#/crew/${id}` }, backTo?.startsWith("#/t/") ? "Back to chat" : "Back")), h("div", { class: "screen" }, screen));
  if (dock?.botId === id) closeDock();
  paint();
  (async () => {
    if (!b.computer.up) { status.textContent = "Starting the computer…"; await api("POST", `/api/bots/${id}/computer/start`).catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
    const { default: RFB } = await import("/novnc/core/rfb.js");
    rfb?.disconnect();
    rfb = new RFB(screen, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live/${id}/ws`);
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = !held; rfb.background = "transparent";
    rfb.addEventListener("connect", () => (status.textContent = held ? "Live · you have control" : "Live · watching"));
    rfb.addEventListener("disconnect", () => (status.textContent = "Disconnected"));
  })().catch((e) => (status.textContent = e.message));
  const prevHook = threadHook;
  threadHook = (type, x) => { if (type === "lease" && x.botId === id) { held = x.held; paint(); } prevHook(type, x); };
  window.addEventListener("hashchange", () => { rfb?.disconnect(); rfb = null; }, { once: true });
  return page;
}

// ---------- projects (read-only code view) ----------
// px0 runs per project in its own read-only container; the frame is sandboxed, so it never shares Pitcrew's origin.
async function projectsView(b, encPath) {
  const list = await api("GET", `/api/bots/${b.id}/projects`);
  if (!list.length) return h("div", { class: "pc-card" }, h("p", { class: "empty" }, `No code projects in ${b.name}'s workspace yet. A folder with .git, package.json, go.mod, pyproject.toml or similar shows up here.`));
  const path = encPath ? decodeURIComponent(encPath) : list[0].path;
  const sel = h("select", { class: "projsel" }, list.map((p) => h("option", { value: p.path, selected: p.path === path }, `${p.path}${p.git ? " · git" : ""}`)));
  sel.addEventListener("change", () => (location.hash = `#/crew/${b.id}/files/projects/${encodeURIComponent(sel.value)}`));
  const frame = h("iframe", { class: "codeview", sandbox: "allow-scripts allow-popups allow-downloads", referrerpolicy: "no-referrer", title: `${path}, read-only` });
  const status = h("span", { class: "small faint" }, "Starting the code view…");
  const newTab = h("a", { class: "small hidden", target: "_blank", rel: "noopener noreferrer" }, "Open in a new tab");
  api("POST", `/api/bots/${b.id}/projects/open`, { path }, { quiet: true })
    .then((r) => { frame.src = r.url; newTab.href = r.url; newTab.classList.remove("hidden"); status.textContent = ""; })
    .catch((e) => { status.textContent = e.message; status.className = "small badc"; });
  return h("div", { class: "col" }, h("div", { class: "row" }, sel, h("span", { class: "pc-chip ok" }, "read-only"), status, h("span", { style: "flex:1" }), newTab), frame);
}

// ---------- docked live view ----------
// A small view-only window onto one crew member's screen that stays put while you move around the app.
let dock = null;
const liveUrl = (id) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live/${id}/ws`;
async function openDock(b) {
  closeDock();
  const screen = h("div", { class: "vnc" }), status = h("span", { class: "small faint" }, "Connecting…");
  const el = h("div", { class: "dock" }, h("div", { class: "bar" }, face(b, "xs"), h("b", { class: "small" }, b.name), status, h("span", { style: "flex:1" }),
    h("a", { class: "small", href: `#/live/${b.id}` }, "Expand"), h("button", { class: "small faint", title: "Stop watching", onclick: closeDock }, "✕")), screen);
  document.body.append(el);
  const d = { botId: b.id, el, rfb: null }; dock = d;
  const { default: RFB } = await import("/novnc/core/rfb.js");
  if (dock !== d) return;
  d.rfb = new RFB(screen, liveUrl(b.id));
  d.rfb.scaleViewport = true; d.rfb.resizeSession = false; d.rfb.viewOnly = true; d.rfb.background = "transparent";
  d.rfb.addEventListener("connect", () => (status.textContent = "Live"));
  d.rfb.addEventListener("disconnect", () => (status.textContent = "Disconnected"));
}
function closeDock() { if (!dock) return; dock.rfb?.disconnect(); dock.el.remove(); dock = null; }

boot();
