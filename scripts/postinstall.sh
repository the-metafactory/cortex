#!/bin/bash
set -e

# Cortex postinstall — first-time install setup.
# Runs once when `arc install cortex` succeeds for the first time on a host.
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
echo "  ✓ Runtime directories created (~/.claude/events — hook event buffer; ~/.config/cortex/{logs,state} — daemon logs + state)"

# ─── 2. Executable permissions ──────────────────────────────────
# Idempotent: skip chmod when the file is already executable. Both entry
# points are tracked as mode 100755 in git (cortex#101), so on a normal
# `git clone`/`git pull` host this loop is a no-op and the pkg dir stays
# clean — which means the next `arc upgrade cortex` can `git pull` without
# "local changes would be overwritten" aborting the upgrade.
# Belt-and-braces: on hosts where the executable bit somehow doesn't survive
# (alternate filesystem, copy-not-clone, archived tarball install), the
# chmod still fires.
for f in "${CORTEX_DIR}/src/cortex.ts" "${CORTEX_DIR}/src/taps/cc-events/relay.ts"; do
  if [ ! -x "$f" ]; then
    chmod +x "$f"
  fi
done
echo "  ✓ Executables marked (src/cortex.ts, src/taps/cc-events/relay.ts — made executable for direct invocation)"

# ─── 3. Relay policy (conditional copy — never overwrites) ──────
if [ ! -f "${CLAUDE_DIR}/relay/relay-policy.yaml" ]; then
  if [ -f "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" ]; then
    cp "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" \
       "${CLAUDE_DIR}/relay/relay-policy.yaml"
    echo "  ✓ Default relay policy created (~/.claude/relay/relay-policy.yaml — controls which session events the relay forwards)"
  fi
else
  echo "  ⊘ Relay policy exists (~/.claude/relay/relay-policy.yaml — not overwriting)"
fi

# ─── 4. Launchd plist rendering (macOS only) ─────────────────────
# Holly cortex#52 round 1 major: the sed-templating block + awk agent-name
# extractor lived here AND in postupgrade.sh. Extracted to a shared lib.
source "${SCRIPT_DIR}/lib/plist-render.sh"
# Audit stack-identity drift (cortex#810) — warn (non-fatal, host-independent)
# when a stack's locator slug ≠ its stack.id slug. Before the Darwin guard so
# Linux/systemd installs see it too.
warn_stack_identity_drift "${CONFIG_DIR}"
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"
fi

echo ""
echo "✓ Cortex postinstall complete"
echo ""
echo "  What was installed into ~/.claude:"
echo "    • hooks/CortexSkillGuard.hook.ts — installed but NOT registered globally by"
echo "      design; used per-session by bot sessions carrying skill grants (cortex#710)"
echo "    • statusline-command.sh, cortex-status.sh — status line renderer + data source;"
echo "      wiring is optional/manual — add to ~/.claude/settings.json:"
echo "      \"statusLine\": {\"type\": \"command\", \"command\": \"~/.claude/statusline-command.sh\"}"
echo "    • relay/cortex/, relay/relay-policy.yaml — relay tap source + forwarding policy"
echo "    • Events buffer locally to ~/.claude/events; run the relay to forward them"
echo "      (optional)"
echo ""
echo "  Next steps:"
echo "    1. (Only if migrating from grove — fresh installs skip this step)"
echo "       Migrate your bot config:"
echo "       bun ${CORTEX_DIR}/src/cli/cortex/commands/migrate-config.ts \\"
echo "           ~/.config/grove/bot.yaml \\"
echo "           --out ${CONFIG_DIR}/cortex.yaml"
echo "    2. Validate the new config:"
echo "       cortex start --config ${CONFIG_DIR}/cortex.yaml --dry-run"
echo "    3. Set CORTEX_CHANNEL=<name> in Claude Code sessions to enable events"
echo "       (legacy GROVE_CHANNEL still honored)."
if [ "$(uname)" = "Darwin" ]; then
  echo "    4. Load services (macOS) — one plist per discovered stack config:"
  echo "       launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.relay.plist"
  echo "       # For each cortex*.yaml in ~/.config/cortex/ a stack plist is rendered:"
  echo "       #   cortex.yaml         → ai.meta-factory.cortex.meta-factory.plist"
  echo "       #   cortex.{slug}.yaml  → ai.meta-factory.cortex.{slug}.plist"
  echo "       launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.meta-factory.plist"
else
  echo "    4. Linux: service management is manual for now — see docs/"
fi
echo "    5. (Only if migrating from grove — fresh installs skip this step)"
echo "       Install grove-bot deprecation shim — see"
echo "       ${CORTEX_DIR}/scripts/grove-bot-shim.sh"
echo ""
echo "  Note: Claude Code hooks are auto-registered into ~/.claude/settings.json"
echo "  by arc from this manifest's provides.hooks. The reference JSON at"
echo "  ${CORTEX_DIR}/src/settings/cortex-hooks.json is documentation only —"
echo "  do NOT manually copy it into settings.json (would double-fire hooks)."
