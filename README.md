# Pitcrew

**You drive. The crew handles the rest.**

Pitcrew is a self-hosted crew of always-on agents for life admin: bills, renewals, replies, refunds, bookings, paperwork. Each crew member has its own computer (a hardened container with a desktop and Chromium), keeps its own logins, runs on schedules while you're away, and stops for you only at the moment of consequence: paying, sending, deleting, signing in.

It runs on one Linux server you own, uses any model through OpenRouter, Vercel AI Gateway or a ChatGPT plan, and keeps your accounts and data on your box.

## Why

Grok Bot, Meta Muse and OpenAI Dots shipped the same shape in 2026: a persistent agent with its own cloud computer. Pitcrew is that shape, self-hosted: no vendor lock on models, no monthly seat, and nothing leaves your server except the model calls.

## What it does

Every feature sits under one of three verbs, or it doesn't get a screen:

| Verb | What |
|---|---|
| **Hand it off** | Crew members with a job, model and permissions; threads; schedules (`daily 09:00`, `weekly mon 08:30`, chains, webhooks) |
| **Decide** | Pit stops: approve once, always within a limit, or deny; sign-ins and take-over of the live browser; spend caps per member |
| **See it done** | Activity log, receipts, cost per run and member, failures grouped and never silent |

Also: per-member memory and skills, generated UI panels, a code view of each workspace, email addresses for members (Cloudflare Email Routing), phone push via ntfy, and an optional link to [Engram](https://github.com/jblaze2908/engram) for memory shared across all your agents.

Product brief: [`docs/brief.md`](docs/brief.md). What v1 contains and the defaults it took: [`docs/v1-build.md`](docs/v1-build.md).

## How it fits together

| Path | What |
|---|---|
| `app/` | Control plane: Node 22, TypeScript on Hono, `node:sqlite`. Auth, crew, threads, pit stops (jev), telemetry, generative UI, scheduler, live-view bridge. Web app in `app/web/`. |
| `harness/` | The brain container: one Codex app-server per active member, the LLM proxy and the exec gateway. No Docker socket, no workspace mounts. |
| `computer/` | One computer per member: desktop, Chromium, Playwright MCP and a pixel computer MCP. Started on demand, stopped when idle. |
| `px0/` | The code view image. |
| `deploy/` | Pull-based deploy: a systemd timer runs `pull-update.sh` every 2 min (fetch main → build per-commit images → health check → roll back on failure). |
| `integrations/` | Cloudflare Email Worker for member addresses. |
| `poc/` | The harness, isolation and browser probes v1 was built on. |

## Requirements

- A Linux host with Docker and Docker Compose v2. The reference host is 2 vCPU / 8 GB running up to three computers: each idles at ~300 MiB, the brain is capped at 2 GB, and the computer image is ~3 GB.
- A reverse proxy with TLS (Traefik, Caddy, nginx) for your hostname, forwarding to `172.17.0.1:8330`. Pitcrew itself opens no public port.
- A model provider: an OpenRouter or Vercel AI Gateway key, or a ChatGPT plan (device-code sign-in).

## Self-host

```sh
git clone https://github.com/jblaze2908/pitcrew /opt/pitcrew
install -d -m 700 /etc/pitcrew
cp /opt/pitcrew/.env.example /etc/pitcrew/pitcrew.env && chmod 600 /etc/pitcrew/pitcrew.env
$EDITOR /etc/pitcrew/pitcrew.env          # PITCREW_HOST and PITCREW_TZ at least
cp /opt/pitcrew/deploy/pitcrew.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pitcrew.timer
systemctl start pitcrew.service           # the first build takes several minutes
```

The timer then keeps the host on the latest `main` of your clone, rolling back if a release fails its health check.

First run: open `https://<PITCREW_HOST>`, paste the setup token from `/srv/pitcrew/data/setup-token`, choose a password, then connect a provider in Settings.

## Develop

```sh
cd app && npm ci && npm run typecheck && npm run build
node --test tests/*.test.mjs              # from the repo root
```

## License

MIT. See [`LICENSE`](LICENSE).
