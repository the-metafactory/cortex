#!/bin/bash
set -e

# Cortex preremove — tear down rendered systemd units before `arc remove
# cortex` deletes symlinks/repo (cortex#2093, the L1 rollback half of
# cortex#2071).
#
# Fires via arc's `scripts.preremove` hook (arc/src/commands/remove.ts step
# 1, arc#138): the FIRST thing arc does on `arc remove`, before any symlink
# or repo teardown — so this script's own lib files are still on disk when
# it runs — and non-aborting on failure (a wedged --user D-Bus session must
# not block the rest of the uninstall).
#
# No-ops cleanly on Darwin and on a systemd-less host (see
# systemd_host_detected in scripts/lib/systemd-render.sh) — same guards as
# the renderer this undoes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# plist-render.sh provides resolve_config_dir. Sourced explicitly (though
# systemd-remove.sh also pulls it in transitively via systemd-render.sh) to
# match postinstall.sh's convention of naming every lib this script depends
# on directly.
# shellcheck source=scripts/lib/plist-render.sh
source "${SCRIPT_DIR}/lib/plist-render.sh"
# shellcheck source=scripts/lib/systemd-remove.sh
source "${SCRIPT_DIR}/lib/systemd-remove.sh"

# XDG wave-4 (cortex#1869): resolve the active config dir the SAME way
# postinstall/postupgrade do, so stack discovery here sees the same stacks
# the renderer saw.
CONFIG_DIR="$(resolve_config_dir)"
UNIT_DIR="${HOME}/.config/systemd/user"  # xdg-audit:allow(L1 rollback target dir (cortex#2093) — mirrors postinstall.sh/postupgrade.sh's UNIT_DIR entry, the canonical systemd user-unit search path; remove_cortex_systemd_units is the programmatic resolver this pattern otherwise asks for)

echo "Running Cortex preremove..."
remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
echo "✓ Cortex preremove complete"
