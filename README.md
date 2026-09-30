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

Pre-code. Product brief and design system are done. The harness decision (Codex app-server vs Hermes, behind a seam Pitcrew owns) waits on three probes listed in the brief.
