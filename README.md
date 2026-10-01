# Pitcrew

**You drive. The crew handles the rest.**

Pitcrew is a self-hosted crew of always-on agents for life admin: bills, renewals, replies, refunds, bookings, paperwork. The crew runs on my own server, uses any model, costs what it costs, and asks me only at the moment of consequence.

It is the v3 rebuild of [Nullframe](https://github.com/jblaze2908/nullframe). Nullframe v0.2 keeps running in production until Pitcrew replaces it.

## Why

Grok Bot, Meta Muse and OpenAI Dots all shipped the same shape in 2026: a persistent agent with its own cloud computer. Pitcrew is my own version. It is not locked to one vendor's models, it does not cost $120–300 a month, and my accounts and data stay on my box.

## The shape

Every feature sits under one of three verbs, or it doesn't get a screen:

| Verb | What |
|---|---|
| **Hand it off** | crew (bots), threads, schedules |
| **Decide** | pit stops: approvals, sign-ins, take-over; spend caps |
| **See it done** | telemetry: activity log, receipts, cost |

See [`docs/brief.md`](docs/brief.md) for the product brief.

## Status

**v1 is live** at https://pitcrew.example.com (on the host). See [`docs/v1-build.md`](docs/v1-build.md) for what's in it, the defaults taken, and what's next.

| Path | What |
|---|---|
| `app/` | Control plane: Node 22, TypeScript on Hono (zod-shaped request bodies, `node:sqlite`), compiled by tsc to `app/dist`. Auth, crew, threads, jev pit stops, telemetry, generative UI, scheduler, live-view bridge. Web app in `app/web/` (Pitcrew design system from Draft). |
| `computer/` | One computer per crew member: desktop, Chromium, Codex app-server, Playwright MCP and pixel computer MCP. Started on demand, stopped when idle. |
| `deploy/` | Pull-based deploy: `pitcrew.timer` on the host runs `pull-update.sh` every 2 min (fetch main → build per-commit images → health check → roll back on failure). `deploy.sh` triggers it now. Also `compose.yml`, `e2e.mjs`, `shots.mjs`. |
| `.github/workflows/ci.yml` | Syntax checks and unit tests (`tests/`) on every PR and push to main. Merging to main deploys within ~2 minutes. |
| `poc/` | The harness, jev, isolation and browser POCs that v1 is built on. |

First run: open the site, paste the setup token from `/srv/pitcrew/data/setup-token` on the host, choose a password, then connect a provider in Settings.
