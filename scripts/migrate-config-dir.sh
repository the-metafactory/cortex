#!/bin/bash
set -euo pipefail

# XDG wave-4 (cortex#1869) — config-dir move driver (RESTART operation).
#
# The cortex config directory moves from the two pre-move trees
# (`~/.config/cortex`, `~/.config/grove`) into the canonical
# `~/.config/metafactory/cortex`. A config path is stamped as an ABSOLUTE
# `--config` argv into every installed launchd plist and nothing re-renders an
# installed plist on its own, so a bare tree-move would leave daemons booting the
# OLD path while CLIs read the moved copy (silent split-brain — traps
# T7′/T13/T17, epic #1867 §P3a). This driver therefore carries the move as a
# RESTART op:
#
#   1. COPY the config tree → canonical, via the tested TS migrator
#      (merge policy: cortex-wins-on-dup, carry grove-only; atomic write; journal;
#      rollback). The legacy SOURCE is KEPT — a crash leaves it fully intact and
#      the resolver's legacy fallback keeps every path readable.
#   2. RE-RENDER every installed plist's `--config` argv at the NEW canonical dir
#      (render_cortex_plists), so launchd execs `--config <canonical>/...`.
#   3. BOOTOUT/BOOTSTRAP the daemons so the running processes pick up the new
#      argv. Stacks named in CORTEX_UPGRADE_SKIP_RESTART (the production `work`
#      stack) are SPARED the restart — their plist is re-rendered but they keep
#      serving on their live process and migrate on their next natural
#      bootout+bootstrap (reboot / logout / manual reload).
#
# ISOLATION: every path derives from `$HOME` (or `$CORTEX_CONFIG_DIR`). Point
# `$HOME` at a scratch dir and mock `launchctl` via PATH and this touches no real
# home and no live daemon — see scripts/__tests__/migrate-config-dir.sh. `BUN_BIN`
# overrides the bun binary for tests; `PLAN_ONLY=1` runs the copy step as a
# no-op dry-run (plan printed, nothing written, no restart).

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=scripts/lib/plist-render.sh
source "${SCRIPT_DIR}/lib/plist-render.sh"

CANONICAL_DIR="$(canonical_config_dir)"

echo "Migrating cortex config dir → ${CANONICAL_DIR} ..."

# ── 1. Copy the config tree (merge policy + atomic write + journal) ──────────
if [ "${PLAN_ONLY:-0}" = "1" ]; then
  "${BUN_BIN:-bun}" "${SCRIPT_DIR}/migrate-config-dir-exec.ts" --plan-only
  echo "  ▸ PLAN_ONLY — no files copied, no daemons restarted"
  exit 0
fi
"${BUN_BIN:-bun}" "${SCRIPT_DIR}/migrate-config-dir-exec.ts"

# ── 2 + 3. Re-render plists at the new dir + bootout/bootstrap (macOS only) ──
# The stop/restart primitives are launchd-only; Linux/systemd parity rides with
# cortex#1909 (same boundary as preupgrade.sh's kill block).
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"

  # Re-stamp every plist's `--config` argv at the canonical dir. Discovery reads
  # the canonical tree (the copy just populated it), so every stack that exists
  # canonical-side gets a plist pointing at its moved config.
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CANONICAL_DIR}"

  # Relay always reloads (never skip-checked) so it boots the moved policy path.
  reload_plist "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
  echo "  ✓ Relay reloaded on moved config dir"

  # Each discovered stack: bootout/bootstrap unless skip-listed (production
  # `work` is spared — its plist is re-rendered but it keeps its live process).
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    reload_stack_unless_skipped "${LAUNCH_DIR}" "${slug}"
  done < <(discover_stack_slugs "${CANONICAL_DIR}")
fi

echo "  ✓ Config-dir move complete — daemons boot on ${CANONICAL_DIR}; legacy tree kept for rollback"
