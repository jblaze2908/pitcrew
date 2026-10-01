# Pitcrew v1 — build plan and status

Goal (Jai, 2026-10-01): complete v1 and deploy it on the host at `https://pitcrew.example.com`.

## Shape

| Part | What | Where |
|---|---|---|
| Control plane | Node 22, zero npm deps (`node:sqlite`, `node:http`, `node:crypto`). Auth, crew, threads, pit stops, jev, telemetry, generative UI, scheduler, live-view bridge. Runs as a container with the Docker socket. | `app/` |
| Computer | One per crew member, started on demand, stopped when idle (`--rm`, nothing persistent runs). Xvfb + openbox + Chromium (CDP on localhost) + x11vnc on a unix socket + Codex app-server + Playwright MCP (driving the visible Chromium) + pixel computer MCP. | `computer/` |
| Web | Static SPA in the Pitcrew design system (theme + `pc-*` components exported from Draft). | `app/web/` |
| Deploy | `deploy/deploy.sh`: rsync to the host, build both images, run the control plane on `172.17.0.1:8330`, Traefik file-provider router for the host. | `deploy/` |

Host layout on the host: `/srv/pitcrew/data` (db, master key, setup token; root 0700), `/srv/pitcrew/bots/<id>/{work,profile,codex,run}` (uid 1500; the only thing a computer mounts), `/srv/pitcrew/chatgpt` (shared ChatGPT auth, mounted only into computers whose provider is ChatGPT).

## Decisions taken to unblock v1 (defaults; revisit)

- Harness: Codex app-server 0.156.1 (the goal to ship v1 settles "confirm the harness").
- Browser base: Playwright MCP over CDP to the computer's visible Chromium (refs + live view share one browser and one profile). agent-browser spike stays open.
- Generative UI: Pitcrew catalogue, A2UI-shaped (`surface` → components tree, named actions), validated server-side, no silent fallback.
- Screen lease: one computer per crew member; parallel threads share it; the driver's take-over holds the lease and gates every computer/browser action.
- ChatGPT auth broker-lite: one shared `auth.json`, symlinked into each computer; a refreshed copy written by a computer is copied back when it stops.
- Isolation: Docker hardening as measured in the POC (cap-drop ALL, no-new-privileges, read-only root, pids/mem/cpu caps, own network per bot). gVisor not installed yet.

## v1 scope in this build

Built: single-user auth (setup token → password), providers (OpenRouter key, AI Gateway key, Sign in with ChatGPT by device code), Crew Chief built in, HIRE pit stop for every new crew member (Chief proposals and manual), personality, per-member provider/model/cap/policy/MCP connectors, threads (queue vs steer, interrupt, compact, fresh thread, attachments), live view + take control, pit stops via jev (once / this thread / always rule / deny, expiry, batch, standing rules with revoke), kill switch, telemetry (runs, cost estimate from list price, weekly cap enforced, minutes asked), audit log + export, memory entries (remember / forget), schedules, Library (files + downloads), generative UI surfaces (charts, tables, forms).

Not in this build (next): email/calendar integrations (need OAuth apps; any hosted MCP connector works meanwhile), incidents grouping, egress allowlist, recipes, phone PWA push.

## v1.1 — brain / computer split (2026-10-01)

Jai's direction: not every task needs a computer. Anything that needs a runtime (bash, code, browser) takes the computer; everything else must not boot one.

| Part | What runs | When |
|---|---|---|
| **Brain** (`pitcrew-brain`, always up) | One Codex app-server per active crew member (own uid, own 0700 home in `/srv/pitcrew/brains/<id>`), the LLM proxy, the exec gateway. Holds the model keys and the ChatGPT token. No Docker socket, no workspace mount, own network. | Codex processes start on a turn, exit after 20 idle minutes |
| **Computer**, stage 1 | Codex `exec-server` only. The brain's native shell and `apply_patch` execute here through Codex *environments* (`environment/add` + per-turn `environments`). | First command, or a write the gateway can't serve from disk |
| **Computer**, stage 2 | Xvfb, Chromium (CDP on loopback), pointer extension, x11vnc socket. Browser (Playwright over CDP) and pixel tools are Pitcrew tools handled by the control plane, gated with grounded elements. | First browser or pixel tool, or "watch live" |

- **Exec gateway is protocol-aware.** Codex reads context through the environment at every turn (AGENTS.md, `.git` probes, skills: ~30 `fs/*` reads, no processes, measured with a WebSocket sniffer). The control plane answers those reads, plus `fs/writeFile`, straight from `/srv/pitcrew/bots/<id>` on the host's disk (no `..`, no symlinks, nothing outside the bot's dir). Only `process/*` or an unsafe path boots the computer; then the gateway replays `initialize` to the real exec-server and becomes a byte pipe.
- **Prompt caching:** the brain's LLM proxy adds top-level `cache_control` for Anthropic models on OpenRouter and logs OpenRouter's billed `usage.cost` per turn (`/srv/pitcrew/brains/_usage/<id>.jsonl`), so telemetry shows billed cost, not list-price estimates.
- **Codex features off per brain:** ChatGPT apps/plugins (they pulled Gmail/Drive/Canva tools into every request: ~124k input tokens per request, and authority nobody granted), Codex's own browser/computer use, image generation, multi-agent, realtime.
- **No page JavaScript:** `browser_evaluate` and `browser_run_code_unsafe` are not offered.
- **Pointer:** a content-script extension draws the crew member's creature cursor (hue + name tag) from real input events, with click ripples and a typing indicator; it persists across page loads.
- **Files view:** workspace snapshots at turn start and end (re-hash only changed files; contents deduped in root-only `/srv/pitcrew/data/shadow/<id>`), per-run changes however they were made, Myers line diff in the browser (unified / split), file browser that works with the computer off.
- Live view scales to fit; Chrome's "Restore pages?" bubble and the Chrome for Testing infobar are suppressed.

Measured on the live instance (`deploy/e2e.mjs --only=browser --probe`, temporary OpenRouter Claude Sonnet 5.5 crew member), 10/10:

| Check | Result |
|---|---|
| Chat-only turn | no computer started, 6 s |
| Shell turn | computer up, desktop not; 21 s including cold boot |
| Shell write shows in Files with a diff | yes |
| Browser chore (navigate, fill, submit, read) | desktop booted on first browser tool; pit stop on `click button "Submit order" on httpbin.org` [send]; no page JS |
| Cost of that chore | **$0.0315–0.0366 billed** (v1: $0.27 list-price estimate); ~22k input tokens per request with ~97% read from cache |

Known: Codex's `aggregatedOutput` on remote commands can miss the first lines (the model's own copy is complete; UI cosmetic). `fill_form` sometimes escalates to a pit stop on jev's "leaves machine" signal (over-ask, not unsafe).

## Status — deployed 2026-10-01

Live at https://pitcrew.example.com (Traefik file-provider router → `172.17.0.1:8330`, Let's Encrypt cert issued on first request). First-run setup (setup token → password) is left for Jai.

Measured on the live instance (`deploy/e2e.mjs`, Crew Chief on OpenRouter `anthropic/claude-sonnet-5.5`):

| Check | Result |
|---|---|
| OpenRouter key saved (encrypted) and tested | pass |
| Browser chore on the Chief's own computer (httpbin form: navigate, fill, submit, read back) | pass, 5 tool calls in 18–27 s including computer boot |
| Submit click became a pit stop | **fail on first run** (jev saw only `{"target":"e44"}` and classed it browse) → fixed by grounding refs against the agent's last snapshot → pass: `click button "Submit order" on httpbin.org` [send] |
| Run recorded with tokens and cost | pass: 132k input / 366 output tokens, $0.27 at list price for that chore |
| Generative UI surface (Compare + BarChart + Form) rendered and validated | pass |
| Form submission round-trips to the crew | pass |
| `remember` stores memory | pass |
| Crew Chief `propose_crew_member` → HIRE pit stop → approve creates the member | pass |
| Live view: WebSocket → x11vnc unix socket handshake | pass (`RFB 003.008`) |
| Sign in with ChatGPT: device code from auth.openai.com | pass (flow cancelled before completion; Jai completes it) |
| Kill switch refuses new runs; resume clears it | pass |
| Unauthenticated API refused; cross-site POST refused; file path traversal → 404 | pass |
| Surface validator vs 10 seeded bad specs | 10/10 rejected |

Known gaps and costs (measured, not fixed yet):
- **No prompt-cache hits** on the Codex → OpenRouter → Anthropic path: `cached_tokens` was 0 on all 6 runs, so each tool step re-bills ~26k input tokens. Try a model with implicit caching for routine crew members, or add cache breakpoints via a proxy.
- Cost is an estimate from OpenRouter list prices; the Telemetry page shows OpenRouter's own figure for the key as a cross-check.
- AI Gateway key path is built but not proven end to end (Vercel billing, as before).
- Email/calendar integrations, incidents, egress allowlist, recipes, phone push: next.

Checklist:
- [x] computer image builds and boots on the host (CDP up, VNC socket up, hardened flags)
- [x] control plane runs; setup/login
- [x] providers: OpenRouter key test; ChatGPT device login (code shown)
- [x] Crew Chief turn end to end (browser + pit stop)
- [x] HIRE flow
- [x] generative UI surface render + form round trip
- [x] deployed at pitcrew.example.com with TLS
