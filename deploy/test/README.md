# Container bench (`bench:container`)

`deploy/test/container-compose.sh` — the container-compose regression bench
(cortex#2284). It scripts the manual OrbStack release ritual as a one-command,
**exit-coded** gate: run it before every release; exit 0 means the container
path still holds every guarantee the cycle's container fixes established.

```
bun run bench:container                       # full scenario, exit-coded
CORTEX_REF=my-branch bun run bench:container  # bench an image built from a branch
deploy/test/container-compose.sh --keep       # leave the stack up for debugging
```

## What it guards

Boots the real two-service compose stack (project `cortex-bench`, so its
containers/volumes/network never collide with a real stack) from a
**placeholder-only** fixture (`fixtures/.env.bench` — dummy tokens, numeric
placeholder snowflakes; never put real values there), then asserts, fail-fast:

| # | Group | Guards |
|---|-------|--------|
| 1 | `no-eacces` | No `EACCES` in cortex logs — volume-perms fix (#2269) |
| 2 | `volume-ownership` | The three named volumes' `_data` owned by uid 1000 (#2269) |
| 3 | `quickstart-steps` | Steps 1–7 `✓`, step 8 `deferred to supervisor healthcheck`, no `"status": "error"` — honest gate (#2275) |
| 4 | `boot-lines` | `cortex quickstart: complete ✓` + `cortex: starting` — provisioning green, daemon takes PID 1 |
| 5 | `healthcheck-flip` | Daemon bus link up (`connected to nats`), compose health flips `healthy`; `stop nats` flips it `unhealthy` ≤ 90s — `/connz` guard (#2275) |

Exit contract: **0** = all pass; **nonzero** = the first failing assertion is
named on stderr. A summary table always prints. The bench is idempotent — it
starts with `down -v --remove-orphans` and (unless `--keep`) ends with
`down -v`, so two consecutive runs both pass.

## `CORTEX_REF` override

The image clones cortex at the `CORTEX_REF` build-arg (default: the release
tag pinned in `Dockerfile.cortex`). Exporting `CORTEX_REF` overrides it via
compose's `${CORTEX_REF:-…}` interpolation, so the bench can gate an unreleased
branch or tag: `CORTEX_REF=fix/my-branch bun run bench:container`.

## How it runs (staging)

`docker-compose.yaml` declares `env_file: .env`, resolved relative to the
compose file's directory. The bench never reads a developer's real
`deploy/compose/.env` (secrets) and never writes into `deploy/compose/`
(assert-only), so it stages byte-copies of the compose inputs plus the fixture
**as** `.env` into `deploy/test/.work/` (git-ignored, recreated each run) and
points compose there.

Requirements: a Linux-semantics docker host (OrbStack, or Docker on Linux)
with compose v2+; network for the first image build.

## Scope

One standalone scenario. Multi-scenario harness, VM/multipass, and federation
benches are the full test-bench spec (#2273). CI wiring follows once a Linux
docker runner lane exists. The bench is assert-only: if an assertion exposes a
product bug, file it — never fix compose/Dockerfile from here.
