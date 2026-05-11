#!/bin/bash
set -e

# Cortex preupgrade — stop daemons before symlinks change.
# Mirrors grove-v2's preupgrade.sh under cortex names.

echo "Stopping Cortex services for upgrade (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"

  # Kill running cortex bot processes before upgrading symlinks.
  # Holly cortex#52 round 1 nit-3: previous `pgrep -f "cortex start"` matched
  # any commandline containing that substring (`grep cortex start`, vim
  # buffers, other users' editors on shared hosts). Constrain to the
  # `~/bin/cortex` symlink path so only the actual daemon is matched.
  CORTEX_PIDS=$(pgrep -f "${HOME}/bin/cortex start" 2>/dev/null || true)
  if [ -n "${CORTEX_PIDS}" ]; then
    echo "  Killing existing cortex processes: ${CORTEX_PIDS}"
    kill ${CORTEX_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${CORTEX_PIDS} 2>/dev/null || true
    echo "  ✓ Old cortex bot processes terminated"
  fi

  # Kill running cortex-relay processes — anchor to ~/bin path for the same
  # specificity reason. Also catches the legacy grove-relay binary path
  # (`~/bin/grove-relay`) during the cutover window.
  RELAY_PIDS=$(pgrep -f "${HOME}/bin/(cortex-relay|grove-relay)" 2>/dev/null || true)
  if [ -n "${RELAY_PIDS}" ]; then
    echo "  Killing existing relay processes: ${RELAY_PIDS}"
    kill ${RELAY_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${RELAY_PIDS} 2>/dev/null || true
    echo "  ✓ Old relay processes terminated"
  fi

  # Clean up legacy grove-bot symlink if it's still owned by a stale install
  # (operator pre-flight should have run `arc uninstall Grove` already; this
  # is a belt-and-braces clean-up so the deprecation shim install step has a
  # clean slate to work with).
  if [ -L "${HOME}/bin/grove-bot" ]; then
    LEGACY_TARGET=$(readlink "${HOME}/bin/grove-bot" || true)
    if [ -n "${LEGACY_TARGET}" ] && [[ "${LEGACY_TARGET}" != *"cortex"* ]]; then
      rm -f "${HOME}/bin/grove-bot"
      echo "  ✓ Removed stale legacy ~/bin/grove-bot symlink (→ ${LEGACY_TARGET})"
    fi
  fi

  if launchctl list 2>/dev/null | grep -q "ai.meta-factory.cortex.bot"; then
    launchctl unload "${LAUNCH_DIR}/ai.meta-factory.cortex.bot.plist" 2>/dev/null || true
    echo "  ✓ Bot daemon stopped"
  fi

  if launchctl list 2>/dev/null | grep -q "ai.meta-factory.cortex.relay"; then
    launchctl unload "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist" 2>/dev/null || true
    echo "  ✓ Relay daemon stopped"
  fi
fi

echo "  ✓ Services stopped — safe to upgrade"
