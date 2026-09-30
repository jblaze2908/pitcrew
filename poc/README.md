# Harness POC

Throwaway probes that decide the harness. They run on the host in one resource-capped container (`pitcrew-poc:0.1`), mounting only this folder. Keys are piped in from root-only files and never printed.

```sh
./run.sh p1 anthropic/claude-sonnet-5.5 openrouter   # any model: shell tool, streaming, resume after restart
./run.sh p2 anthropic/claude-sonnet-5.5 openrouter   # computer: real form in headless Chromium via Playwright MCP
./run.sh p3 anthropic/claude-sonnet-5.5 openrouter   # pit stops: command approval + Pitcrew-owned pay_bill tool
./run.sh p4 anthropic/claude-sonnet-5.5 openrouter   # jev decides live approval requests
./run.sh jev-eval                                    # jev against 30 labelled tool calls
```

- `probe.mjs`: a minimal `codex app-server` JSON-RPC client.
- `jev.mjs`: the approval decider. Declared effect → rules → TypeSafe Jev (`typesafe/jev-1.13` via OpenRouter `/api/v1/systemone`). It fails closed to a pit stop.

## Results, 2026-09-30 (Codex 0.156.1)

| Probe | Model | Result |
|---|---|---|
| p1 any model | claude-sonnet-5.5, deepseek-v4.1-flash | 6/6 each |
| p2 computer | claude-sonnet-5.5 | 3/3 |
| p3 pit stops | claude-sonnet-5.5 | 5/5 |
| p4 jev live | claude-sonnet-5.5 | 5/5 |
| jev-eval | Jev 1.13 | 30/30 exact, 0 unsafe-allow, 0 over-ask, avg 486 ms, $0.000482 for 12 judged calls |
| jev-eval | deepseek-v4.1-flash judge | 30/30, avg 2,292 ms |

## Findings

- The slim image needs `ca-certificates`, or Codex can't reach any API.
- Codex's bubblewrap sandbox can't create user namespaces in Docker. The container is the sandbox: run Codex with `danger-full-access` inside a per-crew container.
- Codex gives MCP servers a filtered environment, so pass `PLAYWRIGHT_BROWSERS_PATH` explicitly.
- Given shell access, the agent fixed a missing browser by installing one. Effects must be gated by the runtime (jev + dynamic tools), not by the prompt.
- Codex has native `turn/steer`, `turn/interrupt`, `thread/resume` and `thread/compact/start`, and client-supplied `dynamicTools`. Pitcrew can own pay/send/delete as its own tools.
- The jev eval cases were written by us and aren't adversarial: a smoke test, not a security claim.
