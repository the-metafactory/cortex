#!/usr/bin/env bash
# check-cortex-version.sh — pier preinstall gate
#
# Verifies:
#   1. cortex >= 5.24.0 is installed (agents.d/ support + cortex network admit)
#   2. PIER_BOT_TOKEN is set (required for Discord presence at cortex load time)
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
  echo "  Install cortex first:  arc install Cortex" >&2
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
  echo "  Upgrade:  arc upgrade Cortex" >&2
  exit 1
fi

# ── 3. Check PIER_BOT_TOKEN is set ────────────────────────────────────────
if [[ -z "${PIER_BOT_TOKEN:-}" ]]; then
  echo "pier preinstall ERROR: PIER_BOT_TOKEN is not set." >&2
  echo "  Set it before installing:" >&2
  echo "    export PIER_BOT_TOKEN=<token>" >&2
  echo "  Obtain the token from the Discord developer portal for the Pier application." >&2
  exit 1
fi

echo "pier preinstall: cortex ${CORTEX_VERSION} OK; PIER_BOT_TOKEN set OK"
exit 0
