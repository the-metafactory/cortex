#!/bin/bash
# grove-bot deprecation shim — manual operator step, NOT installed by arc.
#
# Why this file exists:
#   At MIG-7.7 the `arc upgrade Cortex` flow does NOT touch ~/bin/grove-bot
#   (that symlink is owned by the legacy `Grove` manifest). Operators
#   upgrading from grove run `arc uninstall Grove` first, which removes the
#   symlink entirely. Any external automation that still spells the binary
#   "grove-bot" then breaks.
#
#   This script gives operators a one-line shim to install in place of the
#   removed symlink — it prints a one-time deprecation warning and forwards
#   all arguments to the new `cortex` binary so existing workflows keep
#   working during cutover.
#
# Install:
#   cp scripts/grove-bot-shim.sh ~/bin/grove-bot
#   chmod +x ~/bin/grove-bot
#
# Verify:
#   ~/bin/grove-bot --version
#   # → "warning: grove-bot is a deprecation shim — use 'cortex' directly"
#   # → cortex version output follows
#
# Removal: deleted at MIG-8.4 (`rm ~/bin/grove-bot`).

echo "warning: grove-bot is a deprecation shim — use 'cortex' directly. See cortex#9 MIG-7." >&2
exec "${HOME}/bin/cortex" "$@"
