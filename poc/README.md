# Harness POC

Throwaway probes that decide the harness. They run on the host in one resource-capped container (`pitcrew-poc:0.1`), mounting only this folder. Keys are piped in from root-only files and never printed.

```sh
./run.sh p1 anthropic/claude-sonnet-5.5 openrouter   # any model: shell tool, streaming, resume after restart
./run.sh p2 anthropic/claude-sonnet-5.5 openrouter   # computer: real form in headless Chromium via Playwright MCP
./run.sh p3 anthropic/claude-sonnet-5.5 openrouter   # pit stops: command approval + Pitcrew-owned pay_bill tool
./run.sh p4 anthropic/claude-sonnet-5.5 openrouter   # jev decides live approval requests
./run.sh jev-eval                                    # jev against 30 labelled tool calls
LIVE_PORT=6092 ./run-bot.sh bills node /poc/probe.mjs p5 gpt-6-astra openai   # pixel-only computer use on the bot's own desktop
./iso.sh                                             # one computer per bot: two bots side by side
```

The bot computer (`Dockerfile.bot`, `bot-desktop.sh`) is Xvfb 1280×800 + openbox + Chromium + x11vnc/noVNC live view. It runs in a hardened container: uid 1500, `--cap-drop ALL`, no-new-privileges, read-only root, per-bot volume and network. `computer-mcp.mjs` is a zero-dependency MCP server with screenshot/click/type/key/scroll; every action returns a screenshot.

- `probe.mjs`: a minimal `codex app-server` JSON-RPC client.
- `jev.mjs`: the approval decider. Declared effect → rules → a System One decision model via OpenRouter `/api/v1/systemone` (default `~typesafe/jev-latest`; override with `JEV_MODEL`). It fails closed to a pit stop.

## Results, 2026-09-30 (Codex 0.156.1)

| Probe | OpenRouter (Claude Sonnet 5.5; p1 also DeepSeek V4.1 Flash) | ChatGPT subscription (gpt-6-astra, device login) |
|---|---|---|
| p1 any model | 6/6 (both models) | 6/6 |
| p2 computer | 3/3 | 3/3 |
| p3 pit stops | 5/5 | 5/5 |
| p4 jev live | 5/5 | 5/5 |
| p5 pixel computer use (only screenshot/click/type/key/scroll; shell declined) | — | 6/6: 13 actions in 49–62 s; jev gated all 13, and the Submit click became a pit stop |

### jev: decision models on the same 30 cases (12 reach the model)

| Model | Exact | Unsafe-allow | Over-ask | Avg ms | Reported cost (12 calls) |
|---|---|---|---|---|---|
| **~typesafe/jev-latest** (→ jev-1.13) | **30** | **0** | 0 | **327** | $0.000470 |
| typesafe/jev-1.13 | 30 | 0 | 0 | 486 | $0.000482 |
| upstage/solar-decide | 28 | 0 | 2 (fail-closed timeouts) | 2,447 | $0.000537 |
| jaredpalmer/kev-4b | 25 | 0 | 5 (low confidence) | 969 | $0.000242 |
| respan/span-01 (noul-only) | 24 | **3** | 3 | 2,051 | $0.000036 |
| respan/span-01-lite (noul-only) | 26 | **3** | 1 | 1,430 | $0.000000 |
| deepseek-v4.1-flash (general LLM judge) | 30 | 0 | 0 | 2,292 | n/a |

These are single runs, so latency varies run to run. The Respan models let a Pay/Order/Send click through: never use them as the gate. OpenAI's Decisions API (GPT-6 Luna, ~150 ms claimed) is in limited preview; add it as another `JEV_MODEL` backend when it opens.

### One computer per bot (`iso.sh`, two bots booted together)

10/10 checks pass:
- separate disks and browser profiles
- per-bot egress (own network vs none)
- bots can't reach each other
- non-root, no capabilities, read-only root
- memory cap enforced
- killing one leaves the other running, and the killed bot's profile survives

Measured: boot to desktop-ready ~1.7–1.8 s; idle ~273–321 MiB RAM each.

the host has no `/dev/kvm` (it is a KVM guest without nested virt), so microVMs (Firecracker/Kata) are out. gVisor is the upgrade path for kernel-level isolation.

## Findings

- The slim image needs `ca-certificates`, or Codex can't reach any API.
- Codex's bubblewrap sandbox can't create user namespaces in Docker. The container is the sandbox: run Codex with `danger-full-access` inside a per-crew container.
- Codex gives MCP servers a filtered environment, so pass `PLAYWRIGHT_BROWSERS_PATH` explicitly.
- Given shell access, the agent fixed a missing browser by installing one. Effects must be gated by the runtime (jev + dynamic tools), not by the prompt.
- Codex has native `turn/steer`, `turn/interrupt`, `thread/resume` and `thread/compact/start`, and client-supplied `dynamicTools`. Pitcrew can own pay/send/delete as its own tools.
- Codex asks before every MCP tool call via `mcpServer/elicitation/request` (`codex_approval_kind: mcp_tool_call`, with tool params), so jev gates pixel actions too.
- A pixel click is just (x, y), and Jev is text-only. Click/type/key must declare their target ("Submit order button"). jev still over-asks on some harmless clicks (2 of 10 in the last run), so give it page URL/title/visible text in the real build.
- Chrome's sandbox and crash reporter need writable HOME and user namespaces. In the container: `--no-sandbox --disable-crash-reporter`, tmpfs home owned by the bot user, pre-created X socket dir.
- The jev eval cases were written by us and aren't adversarial: a smoke test, not a security claim.
