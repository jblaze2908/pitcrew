# Todo

Small things to pick up later. Bigger work lives in `features.md`; what shipped is in `v1-build.md`.

- [ ] Anti-slop skill for the crew: every member's prose (replies, drafts, emails it writes for me) runs through an
      anti-AI-slop pass so it reads like a person wrote it. Candidates: the `no-ai-slop` / `sound-human` skills.
- [ ] Bugs found in the TypeScript port (kept as-is to stay behaviour-identical):
  - `GET /api/turns/:id/diff` on a turn with no recorded changes returns 500, not 404.
  - Schedule POSTs don't check the member exists (memory POSTs do now); edits to unknown memory/thread/schedule ids and decisions on
    unknown pit stops return `{ok:true}`.
  - `POST /api/pitstops/batch` treats a string `ids` as a list of characters.
  - A missing `docker` binary crashes the process (unhandled spawn error).
  - Long `PITCREW_ROOT` paths on macOS break `boot.sock` (socket path limit).
  - Every start restarts `pitcrew-brain` and removes `pitcrew=*` containers — careful running locally against real Docker.
- [ ] Plan card: the Chief-run count lags one wake (computed before the wake's turn starts).
- [ ] Plans: walkthroughs 2 (dispute: pit stop, days of waiting, chase) and 3 (private-member consent) not yet tested;
      `waiting-until` timers and per-plan private consent aren't built.
- [x] MCP connectors go through the optional Engram gateway instead of per-member tokens (v1-build.md, 2026-10-02).
      Measured then: 63 upstream calls from one member, 11 errors, all models guessing arguments a ledger MCP doesn't
      take; each retried with fixed arguments seconds later. Engram's trace now keeps the upstream error text.
