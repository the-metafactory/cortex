#!/usr/bin/env bash
# check-cortex-version.sh — pier preinstall gate
#
# Verifies:
#   1. cortex >= 5.24.0 is installed (agents.d/ support + cortex network admit)
#   2. PIER_BOT_TOKEN is set (required — the Discord surface secret)
#   3. PIER_GUILD_ID / PIER_AGENT_CHANNEL_ID / PIER_LOG_CHANNEL_ID are set
#      (WARN-only — an unset id fails SOFT at cortex load: only Pier's Discord
#      surface is disabled, the stack still boots; compass#84 / L2)
#
# NOTE: cortex resolves the PIER_* placeholders at config-LOAD, from the cortex
# DAEMON's environment (the launchd plist EnvironmentVariables, or
# ~/.config/cortex/.env) — NOT this install shell. This gate can only read the
# install shell, so a green check is necessary but not sufficient: the same vars
# must be present where the daemon runs. (Full launchd-plist introspection is a
# follow-up.)
#
# arc install pier runs this BEFORE dropping any files. If this fails,
# the install aborts cleanly with no files written.
#
# Reference: design-arc-agent-bots.md §6.2 CortexHostAdapter.detect()

set -euo pipefail

REQUIRED_MAJOR=5
REQUIRED_MINOR=24

# ── 1. Check cortex is on PATH ─────────────────────────────────────────────
if ! command -v cortex &>/dev/null; then
  echo "pier preinstall ERROR: 'cortex' binary not found on PATH." >&2
  echo "  Install cortex first:  arc install cortex" >&2
  exit 1
fi

# ── 2. Check cortex version ────────────────────────────────────────────────
CORTEX_VERSION="$(cortex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [[ -z "$CORTEX_VERSION" ]]; then
  echo "pier preinstall ERROR: could not determine cortex version." >&2
  exit 1
fi

MAJOR="$(echo "$CORTEX_VERSION" | cut -d. -f1)"
MINOR="$(echo "$CORTEX_VERSION" | cut -d. -f2)"

if (( MAJOR < REQUIRED_MAJOR || (MAJOR == REQUIRED_MAJOR && MINOR < REQUIRED_MINOR) )); then
  echo "pier preinstall ERROR: cortex ${CORTEX_VERSION} found; >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}.0 required." >&2
  echo "  Upgrade:  arc upgrade cortex" >&2
  exit 1
fi

# ── 3. Check PIER_BOT_TOKEN is set (hard requirement — the surface secret) ──
if [[ -z "${PIER_BOT_TOKEN:-}" ]]; then
  echo "pier preinstall ERROR: PIER_BOT_TOKEN is not set." >&2
  echo "  Set it before installing:" >&2
  echo "    export PIER_BOT_TOKEN=<token>" >&2
  echo "  Obtain the token from the Discord developer portal for the Pier application." >&2
  exit 1
fi

# ── 4. Warn on any unset surface ID env var (compass#84 / L2 — fail SOFT) ───
# A missing guild/channel id does NOT abort the install: at cortex load an unset
# id disables ONLY Pier's Discord surface (the stack still boots). Warn clearly
# so the operator sets them in the DAEMON's environment before going live.
ID_VARS_UNSET=()
for var in PIER_GUILD_ID PIER_AGENT_CHANNEL_ID PIER_LOG_CHANNEL_ID; do
  if [[ -z "${!var:-}" ]]; then
    ID_VARS_UNSET+=("$var")
  fi
done

if (( ${#ID_VARS_UNSET[@]} > 0 )); then
  echo "pier preinstall WARN: unset Pier surface id env var(s): ${ID_VARS_UNSET[*]}" >&2
  echo "  Pier's Discord surface will be DISABLED at cortex load until these are set" >&2
  echo "  in the cortex DAEMON's environment (launchd plist EnvironmentVariables or" >&2
  echo "  ~/.config/cortex/.env — not just this install shell), e.g.:" >&2
  for var in "${ID_VARS_UNSET[@]}"; do
    echo "    export ${var}=<snowflake>" >&2
  done
  echo "  The install continues (the missing id fails SOFT, never a crash)." >&2
  echo "pier preinstall: cortex ${CORTEX_VERSION} OK; PIER_BOT_TOKEN set OK; surface ids INCOMPLETE (see WARN)"
  exit 0
fi

echo "pier preinstall: cortex ${CORTEX_VERSION} OK; PIER_BOT_TOKEN + all PIER_* surface ids set OK"
exit 0
