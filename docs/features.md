# Pitcrew — features

The full catalogue: what Pitcrew should do to stand next to Dots, Grok Bot and Muse, and why I'd pick it over them. Evidence behind the competitor claims is in *Research - always-on agents (Dots, Grok Bot, Muse)* and *Research - user feedback on always-on agents*. That evidence is press and third-party reports, not first-hand use. Product definition: *Product v3 - Pitcrew*.

## Why mine, not theirs

They win on breadth: thousands of connectors, polished native apps, frontier models tuned for computer use, and zero maintenance. Pitcrew can't out-breadth them. It wins where a product serving millions of users structurally can't follow: it is built for one driver, on hardware and accounts I own.

1. **Any model, my subscriptions, my routing.** A cheap model for sweeps, a strong one for judgement, a local one for private material. Grok Bot doesn't let users choose a model; Dots is GPT-only.
2. **Receipts, not claims.** Every outcome is checked against the world: a bank ref, a file, a sent-mail id. The industry's worst failure is agents misreporting what they did (GPT-6.1 Astra was scrapped for it; Hermes users say "it always thinks it did a good job").
3. **Pit stops done properly.** The runtime classifies effects; the agent never does. Approvals are exact and versioned, with dry-run and an undo window. Their failure mode is under-asking: a send classified "routine" that never surfaced.
4. **Learn once, run cheap.** When a chore works, it gets frozen into a deterministic recipe; the agent only handles exceptions. Cost burn is the #1 complaint across every competitor.
5. **Isolation by default.** One computer, one profile, one set of logins per crew member. Grok Bot runs every bot on one shared PC, and a stuck PC killed all of them at once.
6. **My data stays mine.** Nothing leaves the box except through flows I approved. No ads, no training on my data, no human contractors on my calls (Meta did exactly that with Muse, then rolled it back).
7. **Memory I can see and fix.** Every fact has a source and can be edited or forgotten. Dots: "you cannot view, delete, or edit individual memories"; disconnecting an app doesn't make it forget.
8. **Crew as code.** Crew members, rules and recipes are versioned files, tools are my own code, and the crew is reachable from Claude Code and the terminal. There is no marketplace to get malware from (341 malicious skills out of 2,857 audited on OpenClaw's ClawHub).
9. **Plugged into my life.** Obsidian vault, Tijori ledger, brain later, and the Indian services I actually use via their real sites, not whatever connector catalogue a US company prioritised.
10. **Built for one.** No roles, no upsell, no "enterprise pilot". Every screen serves the driver.

## Signature features

These define Pitcrew. Each one has to be better than the competitors, not just present.

| # | Feature | What it is | Beats |
|---|---|---|---|
| S1 | **Exact pit stops** | Runtime-classified effect → an approval that names the exact payee, amount or recipient and body. Versioned: approving v1 never approves v2. Options: once · this task · this site · always-within-limit · deny. Dry-run preview; a 30s undo window on sends. | Grok (no dry run, approvals can't undo), Muse (routed around guardrails) |
| S2 | **Receipts** | Each run ends *produced*, *checked* (with evidence: screenshot, PDF, bank ref, message id) or *accepted*. Failures are grouped into incidents. Full replay of every step. | Dots/Astra deception, Muse's false claims, Grok's missing audit view |
| S3 | **Recipes** | "Show me once" or let the agent figure it out; Pitcrew then compiles the working path into a deterministic script with checkpoints. Runs are cheap and reliable. The agent wakes only on exceptions (page changed, OTP, anomaly), then proposes a recipe fix. | Everyone's token burn; Grok's "demonstrate once" without the cost win |
| S4 | **Model router** | Per crew member: primary model, fallback chain, cost ceiling per run, "private → local model only". Shows estimated cost before a run starts. | Grok (no choice), Dots (one vendor) |
| S5 | **Egress firewall** | Per crew member: an allowlist of domains and destinations it may send data to. A new destination is a pit stop. It is enforced at the network layer, not by the prompt. | Muse's Sentinel, but under my control and inspectable |

## The full catalogue

Tiers:
- **v1** — daily driver: what it needs before I'd stop wanting Grok Bot.
- **v1.5** — better than them.
- **v2** — only mine can.

### 1. Crew (hand it off)

| Feature | Tier |
|---|---|
| Crew members with name, job, face (hue + shape), kind (specialist / general) | v1 |
| Role templates: Bills, Inbox, Travel, Shopping, Paperwork, Health, Home, Watcher | v1.5 |
| Per-member model, cap, computer, memory, permissions | v1 |
| Triggers: schedule, email arrives, webhook, file dropped, page changes, price crosses, calendar event | v1 (schedule, email) → v1.5 (rest) |
| Watchers: "tell me when X changes", with a definition of meaningful change so it doesn't ping on noise | v1.5 |
| Crew chief: one lead that splits a goal across specialists and hands work between them | v2 |
| Crew as code: members, rules and recipes as versioned YAML in a repo; the UI edits the same files | v1.5 |

### 2. Threads and work

| Feature | Tier |
|---|---|
| Threads per member; the specialist gets a pinned thread | v1 |
| Brief attached when the work is consequential (outcome, done-when, limits), versioned | v1 |
| Queue vs steer mid-run; never restart | v1 |
| Context meter, compaction, "fresh thread from here" | v1 |
| Attachments in (files, photos, voice notes) | v1 |
| Handoff between crew members (Inbox → Bills: "this is a bill") | v1.5 |
| Deadlines and follow-ups ("chase the refund every 3 days until it lands") | v1.5 |
| Email-to-crew: forward any email to `bills@…` and it becomes a thread | v1.5 |

### 3. Computer

| Feature | Tier |
|---|---|
| Isolated browser per member; desktop on demand | v1 |
| Live view; take control / hand back with a real input lease | v1 |
| Session keeper: keeps logins warm, warns before a session expires ("airtel.in expires tomorrow") | v1.5 |
| Credential vault: autofill at take-over without the model ever seeing the secret | v1.5 |
| OTP relay: a phone companion forwards a specific OTP after I tap Allow (never blanket SMS access) | v2 |
| Downloads land in Library with provenance | v1 |
| Record and replay a demo ("show me once") → recipe | v1.5 |
| Computer-use via the harness's tool; per-site hints the crew learns | v1 → v1.5 |

### 4. Pit stops (decide)

| Feature | Tier |
|---|---|
| Effect classes decided by the runtime: read, draft, sign-in, send, pay, delete, share, install | v1 |
| Exact, versioned approval cards; stale when the brief changes | v1 |
| Once · this task · this site · always-within-limit · deny | v1 |
| Standing rules with revoke ("BESCOM ≤ ₹5,000") | v1 |
| Batch approve across the crew | v1 |
| Expiry with a stated default ("nothing paid if ignored") | v1 |
| Dry-run: rehearse the whole run with side effects stubbed, then see what would happen | v1.5 |
| Undo window: sends are held 30s, cancellable | v1.5 |
| Modes: normal / travelling / focus (quiet hours, tighter limits, digest-only) | v1.5 |
| Dual control: money above a threshold needs a phone confirm too | v2 |
| Anomaly checks: new payee, amount 2× usual, first-time domain → escalates automatically | v2 |
| Kill switch: stop every crew member now; shows what was mid-flight | v1 |

### 5. Telemetry (see it done)

| Feature | Tier |
|---|---|
| Run log with outcome state and evidence | v1 |
| Incidents: repeated failure = one incident with history and options | v1 |
| Replay: step through a run's actions and screenshots | v1.5 |
| Cost per run, thread, member, model; weekly cap enforced in the runtime | v1 |
| Pre-run cost estimate; cost forecast for the week | v1.5 |
| Minutes of mine it asked for; things handled | v1 |
| Weekly crew report (Sunday): handled, asked, spent, incidents, suggestions to turn into recipes | v1.5 |
| Immutable audit log; export everything | v1 |
| Crew checks: regression tests on recurring jobs, re-run after a model or recipe change | v2 |

### 6. Memory

| Feature | Tier |
|---|---|
| Per-member memory as entries with source, edit, forget | v1 |
| "Learned this run" diff after each run: accept or reject new facts | built 2026-10-03 (card with Undo; held facts are pit stops) |
| Household facts (addresses, account last-4s, family) shared with explicit per-member grants | built 2026-10-03 (Engram `household` scope) |
| Forget-by-source actually forgets (disconnect Gmail → its facts go) | built 2026-10-03 (Engram forget by connection) |
| Engram as the shared memory layer | built 2026-10-02 (v1-build.md) |

### 7. Integrations

| Feature | Tier |
|---|---|
| Email: multiple Gmail/IMAP accounts | v1 |
| Calendar | v1 |
| Browser-first for anything without an API (netbanking, utilities, Blinkit, Airtel) | v1 |
| MCP connectors; custom tools in my own code | v1 |
| Obsidian vault: read and write notes under grants | v1.5 |
| Tijori ledger: Bills reconciles payments against it | v1.5 |
| WhatsApp / Telegram messages as a channel to people (always a pit stop) | v2 |

### 8. Surfaces

| Feature | Tier |
|---|---|
| Desktop web app (the 10 screens) | v1 |
| Phone PWA with push; lock-screen approve | v1 |
| Telegram bot: pit stops, status, quick hand-offs | v1 |
| CLI `pitcrew` (`pitcrew hand bills "pay airtel"`, `pitcrew stops`, `pitcrew tail general`) | v1.5 |
| MCP server: Claude Code or Codex can hand a task to the crew and get the receipt back | v1.5 |
| Voice notes in; spoken daily brief out | v2 |

### 9. Runtime and platform

| Feature | Tier |
|---|---|
| Harness seam (Codex app-server first; Hermes / Claude Agent SDK behind the same interface) | v1 |
| Per-member sandbox; egress allowlist | v1 (sandbox) → v1.5 (egress) |
| Secret vault; secrets never in model context | v1 |
| Backups, restore drill, zero-downtime updates | v1 |
| Watchdog: a stuck computer is restarted without losing history | v1 |
| Local models (Ollama) for private-only work | v2 |

### 10. Delight (calibrated)

Creatures whose mood is their real state; the loader on running work; creatures riding progress tracks; the Telemetry card with streak; a burst only on *accepted*; the greeting; "Box, box" notifications. No shelf, speech bubbles or props; no jokes near money. **v1.**

## Where they still win, and what I do about it

| They have | My answer |
|---|---|
| 4,000+ connectors (Dots) | Browser-first plus MCP. I need ~10 services, not 4,000. |
| Polished native apps | PWA + Telegram + lock-screen actions cover the phone. |
| Frontier models tuned for computer use | Route to the best one per task; recipes remove most of the need. |
| Phone calls on my behalf (Muse) | Not in scope; revisit in v2 if a real chore needs it. |
| Zero maintenance | Watchdog, backups, recipe self-repair proposals; I accept owning it. |

## First moves

1. Name the 3 real chores. They pick the first specialist crew and test S3 (recipes) on real sites.
2. Run the three harness probes (non-OpenAI model via OpenRouter; computer tool on the per-bot desktop; approval round-trip).
3. v1 = sections 1–10 at the v1 tier, built behind the harness seam.
