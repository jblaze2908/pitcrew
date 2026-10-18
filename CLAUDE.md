# Pitcrew: notes for coding agents

Pitcrew is an open-source, self-hosted crew of always-on agents for life admin. Each crew member has its own computer
(a hardened container with Chromium) and stops for the driver at consequential actions. README.md has the product;
`docs/v1-build.md` has the architecture and the decisions behind it.

## Commands

```sh
cd app && npm ci                                  # once
cd app && npm run typecheck && npm run build      # ~5 s; tests import the build, so build before testing
node --test tests/*.test.mjs                      # from the repo root; ~3 s, no Docker or network
node --test --test-name-pattern "vault" tests/unit.test.mjs   # one test or group
```

CI (`.github/workflows/ci.yml`) also runs `node --check` on the plain JS in `harness/`, `computer/`, `deploy/` and
`bash -n` on the shell scripts. It also fails if `app/package-lock.json` resolves to anything but registry.npmjs.org.

Don't start the server against your real Docker to try a change: every start restarts `pitcrew-brain` and removes
`pitcrew=*` containers. Tests cover the control plane without Docker.

## Map

| Path | What |
|---|---|
| `app/src/api/*.ts` | HTTP routes (Hono), one file per area, bodies parsed with zod. `api/views.ts` builds `/api/state`. |
| `app/src/runtime/` | Turns, pit stops, schedules, delegation, mail, rewind… `runtime/index.ts` is its public surface. |
| `app/src/crew.ts` | Members and their instructions (`harnessCore`, `engramBlock`). |
| `app/src/crewTools.ts`, `runtime/tools.ts` | Tool schemas a member is offered; their handlers. |
| `app/src/manual.ts` | `harness_help` topics: the detail members read on demand. |
| `app/src/jev.ts` | The safety gate: decides whether a tool call runs or becomes a pit stop. |
| `app/src/db.ts` | SQLite schema, migrations (an `ALTER TABLE` list, append-only), settings helpers. |
| `app/shared/` | Code and types shared by server and web (`types.ts` holds `State`, `Bot`, …). |
| `app/web/src/` | React SPA: `views/` pages, `components/`, `lib/` (api, store, `format.ts` for every number, date and money). |
| `harness/`, `computer/`, `px0/` | Container images: the brain, each member's computer, the code view. |
| `deploy/`, `integrations/`, `poc/` | Pull-based deploy, the Cloudflare email worker, the early probes. |
| `tests/*.test.mjs` | `node:test` against `app/dist`; each file makes its own temp `PITCREW_ROOT`. |

Words the code uses: **driver** (the person who owns the install), **member** / **bot** (a crew agent; `bots` table),
**Crew Chief** (the built-in manager member), **pit stop** (an approval waiting for the driver), **jev** (the gate),
**brain** (Codex app-server in `harness/`), **computer** (a member's container), **surface** (generated UI in a reply),
**ledger** (a member's SQLite file that surfaces query).

## Open source: nothing personal, nothing hardcoded for one user

- No real names, emails, account or order numbers, addresses, providers or amounts anywhere: code, prompts, tests,
  docs or commit messages. Use `example.com` / `*.example` domains, "Sam" for a person and made-up companies.
- Anything that differs between users is a setting, not a constant. Driver-facing choices go in Settings (stored with
  `getSetting`/`setSetting`, accepted by `PATCH /api/settings` in `api/system.ts`, sent in `State`, edited under
  `web/src/views/settings/`). Env vars (`.env.example`) only cover host-level config or first-run defaults.
- Money, numbers and dates go through `web/src/lib/format.ts` (`money`, `num`, …): no currency symbols or locale tags
  in components. The currency comes from Settings → General; model spend is always USD (`usd`).
- Prompt examples in `crew.ts`, `crewTools.ts`, `manual.ts` and `titles.ts` stay generic and region-neutral.

## Rules

- **Crew changelog:** when a change alters what crew members can do or should do (a new tool, a changed rule, a new
  way of working), append one line to `app/src/changelog.ts` in the same commit. Write it for the agent, not the
  maintainer ("browser_replay_request re-sends a captured request…"). Append only; never edit or reorder (members
  count what they've seen). Internal changes get no line.
- **Instructions budget:** `harnessCore()` in `app/src/crew.ts` rides in every thread and stays under 3,000 chars.
  Detail belongs in `app/src/manual.ts` (`harness_help` topics), not in the core or in tool descriptions. Measure
  before and after when you touch either (after a build):
  `PITCREW_DATA=$(mktemp -d) node -e 'import("./app/dist/src/crew.js").then((c) => console.log(c.harnessCore("Sam").length))'`
- **Deploys are pull-based:** pushing to `main` deploys to the production host within ~2 minutes
  (`deploy/pull-update.sh`). Only push when asked, and only with typecheck, build and tests green.
- Schema changes: add a `CREATE TABLE IF NOT EXISTS` or append to the `ALTER TABLE` list in `db.ts`; never rewrite
  either, since existing installs replay them.
- Members' text is untrusted input to the control plane, and so is page, email and webhook content to members. Keep
  new paths that way: validate with zod at the API, and label outside content as data in prompts (see `mail.ts`).

## Style

Match the code around you. Modules open with a comment saying what they do and why; comments explain decisions and
cite measurements, not what the next line does. Lines run long (up to ~200 chars) and helpers stay small and local.
Tests read as sentences ("a refused code leaves the saved one") and assert on behaviour the driver or a member sees.
