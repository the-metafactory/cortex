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
# The healthy-boot gate (quickstart step 8) is EXPECTED to fail here: it greps
# the cortex daemon's own log for healthy-boot lines, but the daemon only starts
# in phase 2 (AFTER quickstart returns). In the split-container model the gate is
# structurally a post-start check, so a LONE step-8 failure is tolerated; a
# failure at any EARLIER step (preflight, env validation, scaffold, patch) is a
# real provisioning error and aborts the boot. The compose healthcheck + restart
# policy is the container's actual supervision contract.
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

# Run provisioning. `--json` so we can reason about WHICH step failed without
# scraping human text. Capture instead of letting `set -e` abort on the expected
# gate failure.
set +e
qs_out="$(cortex quickstart --skip-services --json 2>&1)"
qs_rc=$?
set -e

printf '%s\n' "${qs_out}"

if [ "${qs_rc}" -ne 0 ]; then
  # quickstart stops at the FIRST failing step, so if the failing step is the
  # healthy-boot gate then steps 1–7 all passed. Any other failing step means
  # provisioning genuinely failed → abort (compose will restart us).
  if printf '%s' "${qs_out}" | grep -q '8. Healthy-boot gate'; then
    echo "cortex-entrypoint: provisioning complete; healthy-boot gate deferred to the daemon + compose healthcheck (expected in a container)." >&2
  else
    echo "cortex-entrypoint: quickstart failed before the healthy-boot gate — aborting boot." >&2
    exit "${qs_rc}"
  fi
fi

if [ ! -f "${POINTER}" ]; then
  echo "cortex-entrypoint: expected stack pointer not found at ${POINTER} after provisioning — aborting." >&2
  exit 1
fi

echo "cortex-entrypoint: starting daemon (cortex start --config ${POINTER})…"
exec cortex start --config "${POINTER}"
