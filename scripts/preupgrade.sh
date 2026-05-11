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

  # Belt: kill any lingering legacy grove-bot processes anchored to the
  # legacy ~/bin/grove-bot path. The launchctl unload further down is the
  # braces; this catches a grove-bot that was started outside launchd or
  # whose plist was hand-removed.
  GROVE_BOT_PIDS=$(pgrep -f "${HOME}/bin/grove-bot" 2>/dev/null || true)
  if [ -n "${GROVE_BOT_PIDS}" ]; then
    echo "  Killing legacy grove-bot processes: ${GROVE_BOT_PIDS}"
    kill ${GROVE_BOT_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${GROVE_BOT_PIDS} 2>/dev/null || true
    echo "  ✓ Legacy grove-bot processes terminated"
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

  # MIG-7.8 — legacy launchd plist cutover. The `com.grove.bot` and
  # `com.grove.relay` plists may linger at ~/Library/LaunchAgents/ if
  # grove's own uninstall lifecycle didn't run (operator removed the repo
  # manually, or `arc uninstall Grove` was skipped). Unload + remove them
  # so the new `ai.meta-factory.cortex.*` plists own launchd cleanly.
  # Idempotent: short-circuits when the legacy plist is absent.
  for legacy_label in com.grove.bot com.grove.relay; do
    legacy_plist="${LAUNCH_DIR}/${legacy_label}.plist"
    if [ ! -e "${legacy_plist}" ]; then
      continue
    fi
    # Anchor to label name to avoid partial matches (e.g. `com.grove.bot`
    # vs a hypothetical `com.grove.bot.dev`). launchctl list column 3 is
    # the registered label.
    if launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "${legacy_label}"; then
      launchctl unload "${legacy_plist}" 2>/dev/null || true
      echo "  ✓ Legacy ${legacy_label} daemon stopped"
    fi
    rm -f "${legacy_plist}"
    echo "  ✓ Removed legacy ${legacy_plist}"
  done

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
