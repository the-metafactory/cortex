#!/bin/bash
set -e

# Cortex postupgrade — currently scoped to MIG-6 deliverables only.
# At MIG-7 (top-level wiring + arc cutover), this script grows to handle
# the bot binary, hooks, relay, statusline, and launchd plists — i.e.
# everything grove-v2's scripts/postupgrade.sh currently owns. Until
# MIG-7 lands, grove-v2's install continues to own those surfaces; this
# script only installs the operator CLIs and the Discord skill.
CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
PAI_DIR="${HOME}/.claude"
mkdir -p "${HOME}/bin"

echo "Upgrading Cortex CLIs (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# ─── 1. Operator CLIs ──────────────────────────────────────────
echo "  Updating ~/bin symlinks to ${CORTEX_DIR}..."
ln -sf "${CORTEX_DIR}/src/cli/discord/discord.ts" "${HOME}/bin/discord"
ln -sf "${CORTEX_DIR}/src/cli/cldyo-live" "${HOME}/bin/cldyo-live"
echo "  ✓ ~/bin/discord and ~/bin/cldyo-live linked"

# ─── 2. Discord skill ──────────────────────────────────────────
mkdir -p "${PAI_DIR}/skills"
ln -sf "${CORTEX_DIR}/src/cli/discord/skill" "${PAI_DIR}/skills/Discord"
echo "  ✓ ~/.claude/skills/Discord linked"

echo "  ✓ Cortex CLIs installed"
