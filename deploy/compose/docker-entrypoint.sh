#!/usr/bin/env bash
#
# cortex-entrypoint — the cortex container's PID 1 (cortex#2095, L4a).
#
# Two phases, both driven by the DD-L5 `CTX_*` env contract that `env_file: .env`
# injects:
#
#   1. Provision — `cortex quickstart` (L3, cortex#2094). Idempotent: on a fresh
#      config volume it scaffolds + patches the stack; on a restart (config
#      volume persisted) every step is a verified no-op. `--skip-services`
#      because containers supervise via compose `restart:`, NOT systemd (DD-L4).
#
#   2. Run — `exec cortex start` becomes the container's long-running main
#      process, so compose's `restart: unless-stopped` supervises the daemon and
#      SIGTERM on `docker compose stop` reaches it directly.
#
# The healthy-boot gate (quickstart step 8) is SKIPPED here (`--skip-gate`,
# cortex#2275): it greps the cortex daemon's own log for healthy-boot lines, but
# the daemon only starts in phase 2 (AFTER quickstart returns) — in the
# split-container model the gate is structurally a post-start check. Step 8 is
# reported as an explicit skip ("deferred to supervisor healthcheck"), so a
# successful provisioning run is GREEN — no expected-error output. Post-start
# health is owned by the supervisor: the compose cortex-service healthcheck
# (the daemon's own bus connection on the nats monitor's /connz, on localhost
# via the shared network namespace) + `restart: unless-stopped`. With the gate
# skipped, ANY nonzero quickstart exit is a real provisioning error and aborts
# the boot.
#
# Secret hygiene: this script never echoes CTX_DISCORD_TOKEN or
# CLAUDE_CODE_OAUTH_TOKEN. quickstart itself only ever prints "set"/"missing" for
# those two keys (src/cli/cortex/commands/quickstart-lib.ts). Its provisioning
# output is surfaced verbatim below precisely because it is secret-safe by
# construction.

set -euo pipefail

: "${CTX_SLUG:?CTX_SLUG is required — see .env.example}"

# Container-only OAuth-token guard (cortex#2139). `cortex quickstart` treats
# CLAUDE_CODE_OAUTH_TOKEN as OPTIONAL — correct for a native host, where a
# principal can run `claude login` interactively. A container has NO interactive
# login, so it ALWAYS needs the token; without it the daemon boots, shows
# "running", and only fails on the first dispatch (the #2068 re-auth message).
# Hard-fail at boot instead — cleaner container UX. This guard is entrypoint-only
# and does NOT touch quickstart's native-host optionality.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "cortex-entrypoint: CLAUDE_CODE_OAUTH_TOKEN is empty or unset — aborting boot." >&2
  echo "cortex-entrypoint: a container has no interactive 'claude login', so it always needs this token." >&2
  echo "cortex-entrypoint: set CLAUDE_CODE_OAUTH_TOKEN in your .env (see .env.example) and recreate the container." >&2
  exit 1
fi

CONFIG_DIR="${CORTEX_CONFIG_DIR:-${HOME}/.config/metafactory/cortex}"
POINTER="${CONFIG_DIR}/${CTX_SLUG}/${CTX_SLUG}.yaml"

echo "cortex-entrypoint: provisioning stack '${CTX_SLUG}' (idempotent)…"

# Run provisioning. Human step-table output (no --json): nothing here parses
# the result anymore — the exit code is the whole contract — and the ✓/✗ table
# reads better in `docker compose logs`. `--skip-gate` (cortex#2275): step 8 is
# reported as deferred and quickstart exits 0 when steps 1–7 pass, so there is
# no expected-failure case left — ANY nonzero exit is a real provisioning error
# → abort (compose will restart us).
set +e
cortex quickstart --skip-services --skip-gate
qs_rc=$?
set -e

if [ "${qs_rc}" -ne 0 ]; then
  echo "cortex-entrypoint: quickstart provisioning failed (exit ${qs_rc}) — aborting boot." >&2
  exit "${qs_rc}"
fi

if [ ! -f "${POINTER}" ]; then
  echo "cortex-entrypoint: expected stack pointer not found at ${POINTER} after provisioning — aborting." >&2
  exit 1
fi

echo "cortex-entrypoint: starting daemon (cortex start --config ${POINTER})…"
exec cortex start --config "${POINTER}"
