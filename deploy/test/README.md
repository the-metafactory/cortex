# Deploy test benches

## Scenario index

| Scenario | Kind | Entry point | Guards |
|----------|------|-------------|--------|
| Container bench | scripted, exit-coded | `deploy/test/container-compose.sh` (`bun run bench:container`) | compose stack boot, volume perms, quickstart honesty, healthcheck flip (#2284) |
| Debian install-rehearsal | scripted, exit-coded, multipass VM | `deploy/test/install-rehearsal-debian.sh` (`bun run bench:install:debian`) | fresh-machine `arc install cortex` path: deps → arc → install + capability display → depends_on cascade → symlinks → placeholder-env quickstart (#2287) |
| macOS install-rehearsal | manual runbook | [`deploy/test/install-rehearsal-macos.md`](install-rehearsal-macos.md) | same install path on macOS by a human operator, incl. the A1 gate-pass (#2282) and A2 recovery-restart (#2283) checks (#2287) |

All benches are **assert-only** (a failing assertion that exposes a product
bug gets FILED, not fixed here), **idempotent**, and **placeholder-only** in
everything committed (`fixtures/` — never put real tokens/snowflakes there;
tokens reach the scripts only via operator env).

# Install rehearsal (`bench:install:debian` + macOS runbook)

The cortex#2287 pair rehearses the fresh-machine registry install path before
the cohort is pointed at the published package (D2):

- **Debian (scripted)**: `deploy/test/install-rehearsal-debian.sh` launches a
  fresh Ubuntu LTS multipass VM (`cortex-rehearsal`), installs the quickstart
  prerequisites + arc (per arc's QUICKSTART), runs `arc install` (git mode by
  default; `--mode registry` for D2 reuse — see `--help`), and asserts the
  capability display, the depends_on cascade, symlink integrity, and the
  placeholder-env quickstart outcome (steps 1-6 ✓, expected fail at the
  token-requiring gate leg). Teardown purges the VM unless `--keep`. Tokens
  only via operator env (`ARC_REGISTRY_TOKEN`, registry mode only).
- **macOS (manual)**: [`install-rehearsal-macos.md`](install-rehearsal-macos.md)
  — the same path as a numbered, copy-pasteable runbook with expected output
  per step, the A1 gate-pass check (#2282) and A2 recovery-restart check
  (#2283), and a results table for operator sign-off.

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
