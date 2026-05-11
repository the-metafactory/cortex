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
#   4. Launchd plist rendering (via scripts/lib/plist-render.sh)
#
# It does NOT clobber an existing ~/.config/cortex/cortex.yaml. Operators
# migrating from grove run `cortex migrate-config ~/.config/grove/bot.yaml`
# (MIG-7.2e / MIG-7.9) themselves; this script intentionally stays out of
# their way so a re-install can't blow away a working config.

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
EVENTS_DIR="${CLAUDE_DIR}/events"
CONFIG_DIR="${HOME}/.config/cortex"

echo "Running Cortex postinstall..."

# ─── 1. Runtime directories ──────────────────────────────────────
mkdir -p "${EVENTS_DIR}/raw" "${EVENTS_DIR}/published" \
         "${CLAUDE_DIR}/logs" "${CLAUDE_DIR}/relay" \
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
if [ ! -f "${CLAUDE_DIR}/relay/relay-policy.yaml" ]; then
  if [ -f "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" ]; then
    cp "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" \
       "${CLAUDE_DIR}/relay/relay-policy.yaml"
    echo "  ✓ Default relay policy created"
  fi
else
  echo "  ⊘ Relay policy exists (not overwriting)"
fi

# ─── 4. Launchd plist rendering (macOS only) ─────────────────────
# Holly cortex#52 round 1 major: the sed-templating block + awk agent-name
# extractor lived here AND in postupgrade.sh. Extracted to a shared lib.
source "${SCRIPT_DIR}/lib/plist-render.sh"
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"
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
echo "    3. Set GROVE_CHANNEL=<name> in Claude Code sessions to enable events"
echo "       (still GROVE_CHANNEL — env var rename to CORTEX_CHANNEL is deferred"
echo "       to a future MIG step alongside the code-side hook+relay update)"
echo "    4. Load services (macOS):"
echo "       launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.relay.plist"
echo "       launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.bot.plist"
echo "    5. (Optional) Install grove-bot deprecation shim — see"
echo "       ${CORTEX_DIR}/scripts/grove-bot-shim.sh"
echo ""
echo "  Note: Claude Code hooks are auto-registered into ~/.claude/settings.json"
echo "  by arc from this manifest's provides.hooks. The reference JSON at"
echo "  ${CORTEX_DIR}/src/settings/cortex-hooks.json is documentation only —"
echo "  do NOT manually copy it into settings.json (would double-fire hooks)."
