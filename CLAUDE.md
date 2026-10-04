# Pitcrew: notes for coding agents

- **Crew changelog:** when a change alters what crew members can do or should do (a new tool, a changed rule, a new way of working), append one line to `app/src/changelog.ts` in the same commit. Write it for the agent, not the maintainer ("browser_replay_request re-sends a captured request…"). Append only; never edit or reorder (members count what they've seen). Internal changes get no line.
- **Instructions budget:** `harnessCore()` in `app/src/crew.ts` rides in every thread and stays under 3,000 chars. Detail belongs in `app/src/manual.ts` (`harness_help` topics), not in the core or in tool descriptions. Measure before/after when you touch either.
- Deploys are pull-based: pushing to `main` deploys to the host within ~2 minutes (`deploy/pull-update.sh`). Tests: `cd app && npm run typecheck && npm run build`, then `node --test tests/*.test.mjs` from the repo root.
