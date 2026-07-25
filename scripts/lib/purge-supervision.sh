#!/bin/bash
# Cortex purge-time supervisor sweep (cortex#2338) — backs `arc purge cortex`'s
# `scripts.purge` hook (scripts/purge.sh).
#
# WHY THIS DOES NOT READ THE CORTEX CONFIG DIR (unlike preremove.sh's
# disable_cortex_systemd_instances, scripts/lib/systemd-remove.sh): arc's
# purge flow (arc#359, arc/src/commands/purge.ts) deletes the package's
# declared `owns.config`/`owns.state` trees BEFORE running `scripts.purge`.
# cortex's `owns.config` entry IS the canonical config dir
# (~/.config/metafactory/cortex) — the exact tree `discover_stack_slugs`
# (scripts/lib/plist-render.sh) reads to enumerate stacks. By the time this
# script runs, that tree is already gone, so config-dir-based discovery would
# silently find zero stacks and no-op the very cleanup it exists to do.
#
# Both functions below ask the SUPERVISOR directly instead of the config dir:
#   - purge_systemd_instances  — a `systemctl` unit-name GLOB (`cortex@*`,
#     `nats@*`), expanded by systemd itself against its own unit registry.
#   - purge_launchd_instances  — a FILENAME glob against the on-disk
#     LaunchAgents dir (never arc-tracked — plist-render.sh writes these
#     directly, not via `provides.files`, so nothing else ever removes them).
#
# Neither depends on the cortex config dir surviving, so both still work
# correctly after `owns.config` is deleted. This also makes them a genuine
# safety net independent of `scripts.preremove` (which already disables Linux
# instances EARLIER, while the config dir is still intact) — a unit
# re-enabled between preremove and purge, or one preremove's discovery
# missed, is still caught here.
#
# Usage (in the calling script):
#   source "${SCRIPT_DIR}/lib/purge-supervision.sh"
#   purge_systemd_instances
#   purge_launchd_instances
#
# Both are no-ops (return 0, no external calls) on the "wrong" platform, and
# every external call is best-effort — this runs during `arc purge`, AFTER
# `arc remove` already succeeded; nothing here may abort the purge.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# systemd-render.sh provides systemd_host_detected + run_with_timeout — reused
# rather than forked, so the two "is this a systemd host" checks (render side,
# purge side) can never drift apart.
# shellcheck source=scripts/lib/systemd-render.sh
source "${LIB_DIR}/systemd-render.sh"

# Disable + stop EVERY loaded cortex@*/nats@* instance, discovered by systemd
# itself via unit-name globbing — no config-dir read. Tolerates "no matching
# units" (a plain host, a systemd-less host, or one preremove already fully
# cleaned) as a clean no-op, never a failure.
purge_systemd_instances() {
  if [ "$(uname)" = "Darwin" ]; then
    return 0
  fi
  if ! systemd_host_detected; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  if run_with_timeout systemctl --user disable --now 'cortex@*' 'nats@*' >/dev/null 2>&1; then
    echo "  ✓ any loaded cortex@*/nats@* instances disabled"
  else
    echo "  ⊘ no matching cortex@*/nats@* instances (nothing loaded, or already clean)"
  fi
}

# Bootout + delete every rendered launchd plist under LaunchAgents whose
# filename matches cortex's naming convention, discovered by FILENAME GLOB —
# not the cortex config dir. `ai.meta-factory.cortex.*.plist` covers BOTH the
# per-slug daemon instances AND the single relay plist
# (`ai.meta-factory.cortex.relay.plist`); `ai.meta-factory.nats.*.plist`
# covers the per-slug nats-server instances (stack-lib.ts resolveStackArtifacts).
#
# Args: $1 LAUNCH_DIR — defaults to ${HOME}/Library/LaunchAgents (overridable
#       for tests).
purge_launchd_instances() {
  if [ "$(uname)" != "Darwin" ]; then
    return 0
  fi
  local launch_dir="${1:-${HOME}/Library/LaunchAgents}"
  [ -d "${launch_dir}" ] || return 0

  local domain plist found=0
  domain="gui/$(id -u)"
  for plist in "${launch_dir}"/ai.meta-factory.cortex.*.plist "${launch_dir}"/ai.meta-factory.nats.*.plist; do
    [ -f "${plist}" ] || continue
    found=1
    launchctl bootout "${domain}" "${plist}" >/dev/null 2>&1 || true
    rm -f "${plist}"
    echo "  ✓ $(basename "${plist}") unloaded + removed"
  done
  if [ "${found}" -eq 0 ]; then
    echo "  ⊘ no cortex/nats launchd plists found in ${launch_dir} — nothing to purge"
  fi
}
