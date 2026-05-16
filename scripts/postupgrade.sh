#!/bin/bash
set -e

# Cortex postupgrade — runs after every `arc upgrade Cortex` once symlinks
# have been refreshed. Re-templates plists (via shared lib) and restarts
# daemons.
#
# arc itself handles `provides.files` symlink updates BEFORE this script
# runs, so the `ln -sf` calls below are belt-and-braces for any target arc
# doesn't yet manage (lib subdirs, relay directory).

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
CONFIG_DIR="${HOME}/.config/cortex"

mkdir -p "${HOME}/bin" "${CLAUDE_DIR}/hooks/lib" "${CLAUDE_DIR}/relay" \
         "${CLAUDE_DIR}/skills" "${CONFIG_DIR}/logs"

echo "Upgrading Cortex (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# ─── 1. Belt-and-braces symlink refresh ───────────────────────────
# arc's provides.files already handled the primary symlinks; these are the
# nested-target ones (hook lib + relay dir) where arc's behaviour around
# directory targets has varied historically.
echo "  Refreshing nested-target symlinks..."
ln -sf "${CORTEX_DIR}/src/taps/cc-events/hooks/lib" "${CLAUDE_DIR}/hooks/lib/cortex-events"
ln -sf "${CORTEX_DIR}/src/taps/cc-events"          "${CLAUDE_DIR}/relay/cortex"
ln -sf "${CORTEX_DIR}/src/cli/discord/skill"       "${CLAUDE_DIR}/skills/Discord"
echo "  ✓ Nested symlinks refreshed"

# ─── 2. Re-template launchd plists (shared with postinstall.sh) ──
source "${SCRIPT_DIR}/lib/plist-render.sh"
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"

  # ─── 3. Restart daemons ─────────────────────────────────────────
  # `|| true` keeps a partial upgrade non-fatal — if a daemon was already
  # unloaded by preupgrade.sh, load just re-loads cleanly.
  launchctl load "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist" 2>/dev/null || true
  echo "  ✓ Relay daemon started"

  launchctl load "${LAUNCH_DIR}/ai.meta-factory.cortex.meta-factory.plist" 2>/dev/null || true
  echo "  ✓ Meta-factory daemon started"

  # cortex#244: work stack is optional. Only load if `plist-render.sh`
  # actually rendered it (gated on cortex.work.yaml existence). Same
  # `|| true` non-fatal pattern as the others.
  if [ -f "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist" ]; then
    launchctl load "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist" 2>/dev/null || true
    echo "  ✓ Work daemon started"
  fi
fi

echo "  ✓ Cortex upgrade complete"
