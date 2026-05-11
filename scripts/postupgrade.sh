#!/bin/bash
set -e

# Cortex postupgrade — runs after every `arc upgrade Cortex` once symlinks
# have been refreshed. Re-templates plists with the new install path, then
# restarts daemons. Mirrors grove-v2's postupgrade.sh under cortex names.
#
# arc itself handles `provides.files` symlink updates BEFORE this script
# runs, so the `ln -sf` calls below are belt-and-braces for any target arc
# doesn't yet manage (statusline.d, lib subdirs).

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
PAI_DIR="${HOME}/.claude"
CONFIG_DIR="${HOME}/.config/cortex"
BUN_PATH="$(which bun)"

mkdir -p "${HOME}/bin" "${PAI_DIR}/hooks/lib" "${PAI_DIR}/relay" \
         "${PAI_DIR}/skills" "${CONFIG_DIR}/logs"

echo "Upgrading Cortex (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# ─── 1. Belt-and-braces symlink refresh ───────────────────────────
# arc's provides.files already handled the primary symlinks; these are the
# nested-target ones (hook lib + relay dir) where arc's behaviour around
# directory targets has varied historically.
echo "  Refreshing nested-target symlinks..."
ln -sf "${CORTEX_DIR}/src/taps/cc-events/hooks/lib" "${PAI_DIR}/hooks/lib/cortex-events"
ln -sf "${CORTEX_DIR}/src/taps/cc-events"          "${PAI_DIR}/relay/cortex"
ln -sf "${CORTEX_DIR}/src/cli/discord/skill"       "${PAI_DIR}/skills/Discord"
echo "  ✓ Nested symlinks refreshed"

# ─── 2. Re-template launchd plists with current paths ─────────────
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  mkdir -p "${LAUNCH_DIR}"

  # Relay plist
  RELAY_PLIST_SRC="${CORTEX_DIR}/src/services/ai.the-metafactory.cortex.relay.plist"
  if [ -f "${RELAY_PLIST_SRC}" ]; then
    sed -e "s|__CORTEX_DIR__|${CORTEX_DIR}|g" \
        -e "s|__BUN_PATH__|${BUN_PATH}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${RELAY_PLIST_SRC}" > "${LAUNCH_DIR}/ai.the-metafactory.cortex.relay.plist"
    echo "  ✓ Relay plist re-templated"
  fi

  # Bot plist — extract agent name from cortex.yaml (first agents[].id)
  BOT_PLIST_SRC="${CORTEX_DIR}/src/services/ai.the-metafactory.cortex.bot.plist"
  AGENT_NAME="cortex"
  if [ -f "${CONFIG_DIR}/cortex.yaml" ]; then
    AGENT_NAME=$(awk '/^agents:/{found=1; next} found && /^[ \-]*id:/{sub(/.*id:[ ]*/, ""); gsub(/["'\'']/, ""); gsub(/#.*/, ""); print; exit}' "${CONFIG_DIR}/cortex.yaml" | xargs || true)
    AGENT_NAME="${AGENT_NAME:-cortex}"
  fi
  if [ -f "${BOT_PLIST_SRC}" ]; then
    sed -e "s|__CORTEX_DIR__|${CORTEX_DIR}|g" \
        -e "s|__BUN_PATH__|${BUN_PATH}|g" \
        -e "s|__HOME__|${HOME}|g" \
        -e "s|__AGENT_NAME__|${AGENT_NAME}|g" \
        "${BOT_PLIST_SRC}" > "${LAUNCH_DIR}/ai.the-metafactory.cortex.bot.plist"
    echo "  ✓ Bot plist re-templated (agent=${AGENT_NAME})"
  fi

  # ─── 3. Restart daemons ─────────────────────────────────────────
  # `|| true` keeps a partial upgrade non-fatal — if a daemon was already
  # unloaded by preupgrade.sh, load just re-loads cleanly.
  launchctl load "${LAUNCH_DIR}/ai.the-metafactory.cortex.relay.plist" 2>/dev/null || true
  echo "  ✓ Relay daemon started"

  launchctl load "${LAUNCH_DIR}/ai.the-metafactory.cortex.bot.plist" 2>/dev/null || true
  echo "  ✓ Bot daemon started"
fi

echo "  ✓ Cortex upgrade complete"
