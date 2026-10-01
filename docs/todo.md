# Todo

Small things to pick up later. Bigger work lives in `features.md`; what shipped is in `v1-build.md`.

- [ ] Anti-slop skill for the crew: every member's prose (replies, drafts, emails it writes for me) runs through an
      anti-AI-slop pass so it reads like a person wrote it. Candidates: the `no-ai-slop` / `sound-human` skills.
- [ ] Bugs found in the TypeScript port (kept as-is to stay behaviour-identical):
  - `GET /api/turns/:id/diff` on a turn with no recorded changes returns 500, not 404.
  - Memory/schedule POSTs don't check the member exists; edits to unknown memory/thread/schedule ids and decisions on
    unknown pit stops return `{ok:true}`.
  - `POST /api/pitstops/batch` treats a string `ids` as a list of characters.
  - A missing `docker` binary crashes the process (unhandled spawn error).
  - Long `PITCREW_ROOT` paths on macOS break `boot.sock` (socket path limit).
  - Every start restarts `pitcrew-brain` and removes `pitcrew=*` containers — careful running locally against real Docker.
- [ ] Rename the `brain/` container (the Codex harness) to avoid clashing with the Engram project (formerly Brain), e.g. `harness/`.
- [ ] Comments in `brain/Dockerfile` and `px0/Dockerfile` still say `computer.mjs` / `code.mjs`.
- [ ] Plan card: the Chief-run count lags one wake (computed before the wake's turn starts).
- [ ] Plans: walkthroughs 2 (dispute: pit stop, days of waiting, chase) and 3 (private-member consent) not yet tested;
      `waiting-until` timers and per-plan private consent aren't built. See Obsidian "Research - orchestration".
- [ ] MCP connectors move to the Engram gateway (see Obsidian "Engram - Spec" §13) instead of per-member tokens.
