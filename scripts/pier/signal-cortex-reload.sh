#!/usr/bin/env bash
# signal-cortex-reload.sh — pier postinstall (step 1 of 1)
#
# Signals the running cortex daemon to reload its agents.d/ directory so
# it picks up the newly-installed pier.yaml fragment WITHOUT a full restart.
#
# ORDER MATTERS (design-arc-agent-bots.md §8.1 + §6.2 installArtifact):
#   arc drops persona.md + agent.yaml FIRST (the `provides.files` step),
#   THEN runs this script.  The daemon must learn about pier from agents.d/
#   before any capability-claim or creds-issue step would run.
#
#   Pier skips the issue-nats-creds.sh step entirely: it is an in-process
#   agent and shares the stack's bus identity (§3.1, §7.1 worked example).
#
# Reload mechanism: prefer `cortex agents reload` (explicit CLI trigger);
# fall back to SIGHUP to the running daemon PID.

set -euo pipefail

RELOAD_TIMEOUT=10   # seconds to wait for the reload acknowledgement

# ── 1. Attempt `cortex agents reload` ─────────────────────────────────────
if command -v cortex &>/dev/null; then
  echo "pier postinstall: signalling cortex agents reload..."
  if timeout "$RELOAD_TIMEOUT" cortex agents reload 2>/dev/null; then
    echo "pier postinstall: reload acknowledged — pier fragment active"
    exit 0
  fi
  echo "pier postinstall: 'cortex agents reload' timed out or failed; trying SIGHUP..." >&2
fi

# ── 2. Fall back to SIGHUP ────────────────────────────────────────────────
# The pid file is written by cortex at startup.  Location convention:
#   ~/.local/share/cortex/<stack-slug>.pid   (per cortex pidfile convention)
# Try the most common default; principals with non-default configs may
# need to run `cortex agents reload` manually.
PID_FILE="${HOME}/.local/share/cortex/cortex.pid"

if [[ -f "$PID_FILE" ]]; then
  DAEMON_PID="$(cat "$PID_FILE")"
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "pier postinstall: sending SIGHUP to cortex daemon (pid ${DAEMON_PID})..."
    kill -HUP "$DAEMON_PID"
    echo "pier postinstall: SIGHUP sent — daemon will reload agents.d/ on next poll cycle"
    exit 0
  else
    echo "pier postinstall WARNING: pid file found but daemon not running (pid ${DAEMON_PID})" >&2
  fi
fi

# ── 3. No running daemon — fragment is on disk, reload on next start ───────
echo "pier postinstall WARNING: cortex daemon not detected." >&2
echo "  The pier.yaml fragment is installed at ~/.config/cortex/agents.d/pier.yaml" >&2
echo "  Pier will be active on the next cortex daemon start." >&2
echo "  Or run manually:  cortex agents reload" >&2
# Exit 0 — the file is on disk; a non-running daemon is not an install failure.
exit 0
