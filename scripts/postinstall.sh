#!/bin/bash
set -e

# Cortex postinstall — first-time install setup.
# Runs once when `arc install Cortex` succeeds for the first time on a host.
# Symlinks are created by arc via provides.files BEFORE this script runs.
#
# This script handles:
#   1. Runtime directory creation
#   2. Executable bits on bot/relay binaries
#   3. Relay policy template (conditional copy — never clobbers)
#   4. Launchd plist rendering from in-repo templates
#
# It does NOT clobber an existing ~/.config/cortex/cortex.yaml. Operators
# migrating from grove run `cortex migrate-config ~/.config/grove/bot.yaml`
# (MIG-7.2e / MIG-7.9) themselves; this script intentionally stays out of
# their way so a re-install can't blow away a working config.

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
PAI_DIR="${HOME}/.claude"
EVENTS_DIR="${PAI_DIR}/events"
CONFIG_DIR="${HOME}/.config/cortex"
BUN_PATH="$(which bun)"

echo "Running Cortex postinstall..."

# ─── 1. Runtime directories ──────────────────────────────────────
mkdir -p "${EVENTS_DIR}/raw" "${EVENTS_DIR}/published" \
         "${PAI_DIR}/logs" "${PAI_DIR}/relay" \
         "${CONFIG_DIR}/logs" "${CONFIG_DIR}/state" \
         "${HOME}/bin"
chmod 700 "${EVENTS_DIR}/raw"
chmod 755 "${EVENTS_DIR}/published"
echo "  ✓ Runtime directories created"

# ─── 2. Executable permissions ──────────────────────────────────
chmod +x "${CORTEX_DIR}/src/cortex.ts"
chmod +x "${CORTEX_DIR}/src/taps/cc-events/relay.ts"
echo "  ✓ Executables marked"

# ─── 3. Relay policy (conditional copy — never overwrites) ──────
if [ ! -f "${PAI_DIR}/relay/relay-policy.yaml" ]; then
  if [ -f "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" ]; then
    cp "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" \
       "${PAI_DIR}/relay/relay-policy.yaml"
    echo "  ✓ Default relay policy created"
  fi
else
  echo "  ⊘ Relay policy exists (not overwriting)"
fi

# ─── 4. Launchd plist rendering (macOS only) ─────────────────────
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  mkdir -p "${LAUNCH_DIR}"

  # Relay plist
  RELAY_PLIST_SRC="${CORTEX_DIR}/src/services/com.cortex.relay.plist"
  RELAY_PLIST_DST="${LAUNCH_DIR}/com.cortex.relay.plist"
  if [ -f "${RELAY_PLIST_SRC}" ]; then
    sed -e "s|__CORTEX_DIR__|${CORTEX_DIR}|g" \
        -e "s|__BUN_PATH__|${BUN_PATH}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${RELAY_PLIST_SRC}" > "${RELAY_PLIST_DST}"
    echo "  ✓ Relay launchd plist installed"
  fi

  # Bot plist — extract agent name from cortex.yaml if present so the
  # launchd label and CORTEX_CHANNEL env var match the deployed agent.
  BOT_PLIST_SRC="${CORTEX_DIR}/src/services/com.cortex.bot.plist"
  BOT_PLIST_DST="${LAUNCH_DIR}/com.cortex.bot.plist"
  AGENT_NAME="cortex"
  if [ -f "${CONFIG_DIR}/cortex.yaml" ]; then
    # cortex.yaml puts the first agent id under `agents:`; grep the first
    # `id:` line under that block. Falls back to "cortex" if parse fails.
    AGENT_NAME=$(awk '/^agents:/{found=1; next} found && /^[ \-]*id:/{sub(/.*id:[ ]*/, ""); gsub(/["'\'']/, ""); gsub(/#.*/, ""); print; exit}' "${CONFIG_DIR}/cortex.yaml" | xargs || true)
    AGENT_NAME="${AGENT_NAME:-cortex}"
  fi
  if [ -f "${BOT_PLIST_SRC}" ]; then
    sed -e "s|__CORTEX_DIR__|${CORTEX_DIR}|g" \
        -e "s|__BUN_PATH__|${BUN_PATH}|g" \
        -e "s|__HOME__|${HOME}|g" \
        -e "s|__AGENT_NAME__|${AGENT_NAME}|g" \
        "${BOT_PLIST_SRC}" > "${BOT_PLIST_DST}"
    echo "  ✓ Bot launchd plist installed (agent=${AGENT_NAME})"
  fi
fi

echo ""
echo "✓ Cortex postinstall complete"
echo ""
echo "  Next steps:"
echo "    1. Migrate your bot config (if upgrading from grove):"
echo "       bun ${CORTEX_DIR}/src/cli/cortex/commands/migrate-config.ts \\"
echo "           ~/.config/grove/bot.yaml \\"
echo "           --out ${CONFIG_DIR}/cortex.yaml"
echo "    2. Validate the new config:"
echo "       cortex start --config ${CONFIG_DIR}/cortex.yaml --dry-run"
echo "    3. Register the cortex hooks in ~/.claude/settings.json"
echo "       (see ${CORTEX_DIR}/src/settings/cortex-hooks.json)"
echo "    4. Set CORTEX_CHANNEL=<name> in Claude Code sessions to enable events"
echo "    5. Load services (macOS):"
echo "       launchctl load ~/Library/LaunchAgents/com.cortex.relay.plist"
echo "       launchctl load ~/Library/LaunchAgents/com.cortex.bot.plist"
echo "    6. (Optional) Install grove-bot deprecation shim — see"
echo "       ${CORTEX_DIR}/scripts/grove-bot-shim.sh"
