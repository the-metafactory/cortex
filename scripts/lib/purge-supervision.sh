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

# Report the shared-substrate dirs `arc purge cortex` DELIBERATELY leaves in
# place (cortex#2420). cortex writes into each of these, but NONE is
# cortex-exclusive, so a blanket delete on purge could take out a neighbor's
# state:
#
#   ~/.claude/events  — the raw Claude-Code event buffer. events-path.ts calls
#                       `~/.claude/events/raw` the "hook-substrate boundary"
#                       that stays put across every XDG wave; ANY Claude Code
#                       hook or package can write here, not just cortex.
#   ~/.claude/relay   — the cortex-relay dir. Holds relay-policy.yaml, which is
#                       CONFIG that STAYS (migrate-state-dir.ts moves only
#                       relay.pid out — "relay-policy.yaml is CONFIG and stays
#                       put"); ~/.claude is likewise shared hook territory.
#   ~/.config/nats    — NATS identity. arc's OWN nats provisioning
#                       (identity-provision.ts) writes signing seeds + creds
#                       here independent of cortex; only the seed carries a
#                       "cortex-" prefix, so a glob can't safely tell cortex's
#                       files from a neighbor's.
#
# These are documented as intentionally NOT-declared in arc-manifest.yaml's
# `owns:` block; this surfaces that same decision at purge time so the operator
# knows they remain and why — the arc#359 purge log would otherwise leave the
# leftover unexplained (the cortex#2420 field-test surprise).
#
# Args: $1 HOME_DIR — defaults to ${HOME} (overridable for tests).
report_intentionally_kept_shared_state() {
  local home_dir="${1:-${HOME}}"
  # path|reason pairs — the reason is shown so the operator can judge the risk
  # of removing it by hand.
  local kept=(
    "${home_dir}/.claude/events|raw Claude-Code event buffer — hook-substrate boundary, shared by any CC hook"  # xdg-audit:allow(the hook-substrate boundary this reports as INTENTIONALLY KEPT — naming it is the point, cortex#2420)
    "${home_dir}/.claude/relay|cortex-relay dir — holds relay-policy.yaml (config that stays) beside the pidfile"  # xdg-audit:allow(shared relay dir this reports as INTENTIONALLY KEPT — naming it is the point, cortex#2420)
    "${home_dir}/.config/nats|NATS identity — arc's own nats provisioning writes signing seeds/creds here too"
  )
  echo "  Intentionally KEPT (shared state, not cortex-exclusive — see arc-manifest.yaml owns: note, cortex#2420):"
  local entry path desc present=0
  for entry in "${kept[@]}"; do
    path="${entry%%|*}"
    desc="${entry#*|}"
    if [ -e "${path}" ]; then
      present=1
      echo "    • ${path} — ${desc}"
    fi
  done
  if [ "${present}" -eq 0 ]; then
    echo "    (none of the shared dirs are present on this host — nothing kept)"
  else
    echo "    Left in place on purpose. Remove by hand only if no other stack/hook/relay uses them."
  fi
}
