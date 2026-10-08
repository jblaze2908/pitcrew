# Pitcrew — product brief

Single user, self-hosted.

## Purpose

Life admin, handled; I only decide. The General bot catches odd jobs, but the product is judged by the recurring chores it takes off my plate.

**Measure:**
- Things handled per week.
- Minutes it asked of me.
- Deadlines missed (target 0).
- Money spent.

## What it must do

| # | Capability | Bar |
|---|---|---|
| 1 | **Crew member (bot)** | Name, job, model and permissions in one step. The model and provider are per bot and can be changed. |
| 2 | **Threads per bot** | A specialist bot lives in one pinned thread; a general bot opens a thread per task. Each thread keeps its own context. A message sent mid-task steers or queues, and never restarts the task. Long threads compact, with a context meter. |
| 3 | **Works while I'm away** | Jobs, schedules and watchers keep running with the laptop closed. |
| 4 | **Its own computer** | An isolated browser (plus a desktop on demand) per bot. I can watch live, take control and hand back. |
| 5 | **Stays signed in** | Logins persist per bot. Passwords, 2FA and CAPTCHAs are always mine. |
| 6 | **Pit stops** | Send, publish, pay, delete, share and sign-in pause for: approve once · always (within a limit) · deny. |
| 7 | **Telemetry** | Every run shows what it did, what changed, the evidence, the cost and the model. Failures are grouped into incidents and never silent. |
| 8 | **Reach me anywhere** | Phone, plus a notification when a pit stop opens or a run finishes. |

## Requirements from user feedback on Grok Bot, Dots, Muse and OpenClaw

- **Cost:** live per run, thread and bot. A per-bot cap enforced on the runtime path. Prefer subscription logins. Watchers must not resend the full context.
- **Isolation:** one computer per bot, so one stuck bot never stops the others. Recovery never deletes history. Deleting a bot deletes its files, logins and memory.
- **Outcomes:** a run's outcome comes from a check (receipt, state read, diff), never from the agent's own summary. States: *produced* / *checked* / *accepted*.
- **Approvals:** keyed on the effect class and decided by the runtime, never by the agent's own "routine" judgement. Full audit log. Batch approvals.
- **Memory:** per-bot memory that can be read, edited and deleted.
- **Security:** no public skill marketplace, no public port.

## Harness: open

Pitcrew owns a runtime seam: bots, threads/runs + event stream, stop/steer, approvals, schedules, the computer session, cost. The harness plugs in behind it. The lead candidate is the **Codex app-server**: it embeds headless on Linux and supports custom providers. Three probes decide it:

1. One thread end to end on a non-OpenAI model via OpenRouter, with tools and resume still working.
2. Driving the per-bot desktop through an MCP computer tool well enough to finish one real browser chore.
3. An approval request round-trips harness → Pitcrew UI → back, and a denial actually stops the action.

All three pass: Codex it is, and Pitcrew owns scheduling and notifications. Any fail: Hermes keeps that capability behind the same seam.

## Voice and vocabulary

| Word | Means |
|---|---|
| driver | me |
| crew | the bots (each has a creature face) |
| pit stop | a moment that needs my decision |
| on track | running |
| in the garage | idle or asleep |
| telemetry | activity, cost, receipts |

The racing language lives in ambient copy only. Approval cards, amounts, checks and receipts stay plain.

## Design

Draft design system **Pitcrew v1**:
- Dark by default, with a light theme.
- Fonts: Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono.
- One signal colour, and it means *pit stop*.
- Crew creatures whose mood is their real state.
- The loader on running work; creatures riding their progress tracks; a telemetry card with spend, streak and a weekly cap bar.

## Not building

- Multi-user, sharing or a marketplace.
- A second cost ledger or a cron parser that duplicates the harness.
- The second brain (brain). It is a separate project and gets integrated later.
