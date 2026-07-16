#!/bin/bash
# Cortex systemd user-unit removal — L1 rollback half of systemd-render.sh
# (cortex#2093, closing the gap cortex#2071 deliberately left open: rendering
# a unit is not enough, `arc remove cortex` must also tear it down cleanly).
#
# Without this, `arc remove cortex` on Linux would leave enabled instances
# (cortex@<slug>, nats@<slug>) pointing at a deleted install — restart-
# looping under `Restart=on-failure` every boot, and the two template unit
# files orphaned in ~/.config/systemd/user/ forever.
#
# Usage (in the calling script):
#   source "${SCRIPT_DIR}/lib/systemd-remove.sh"
#   remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
#
# Functions never write outside ${UNIT_DIR} — no repo files, no state trees.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# systemd-render.sh provides SYSTEMD_UNIT_MARKER, systemd_host_detected, and
# run_with_timeout (and transitively sources plist-render.sh for
# discover_stack_slugs) — the removal side reuses every one of these rather
# than forking its own copy, so the two halves of the marker contract can
# never drift apart. Sourcing here (rather than relying on the caller to have
# sourced it already) lets this file be sourced standalone (tests do exactly
# that).
# shellcheck source=scripts/lib/systemd-render.sh
source "${LIB_DIR}/systemd-render.sh"

# Disable + stop every discovered stack's cortex@<slug> and nats@<slug>
# instances, tolerating "not loaded" / "not found" (a stack that was
# scaffolded but never enabled, or a unit already stopped by hand) — this is
# best-effort cleanup, not a precondition the remove can fail on.
#
# Each unit gets its OWN `systemctl --user disable --now` call (rather than
# passing both units to one invocation) so a failure on one never masks the
# other, and each result is logged individually — the same per-unit
# granularity render_systemd_unit uses on the render side.
#
# `&& echo ok || echo not-loaded` per call is `set -e`-safe: per bash's
# documented exemption, a command that is not the LAST element of an AND-OR
# list does not trigger `set -e` on failure (mirrors the guarded calls
# throughout systemd-render.sh, e.g. render_cortex_systemd_units' daemon-
# reload guard).
#
# Args: $1 CONFIG_DIR — cortex config dir (stacks are discovered from here)
disable_cortex_systemd_instances() {
  local config_dir="$1"
  local slug unit
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    for unit in "cortex@${slug}" "nats@${slug}"; do
      if run_with_timeout systemctl --user disable --now "${unit}" >/dev/null 2>&1; then
        echo "  ✓ ${unit} disabled"
      else
        echo "  ⊘ ${unit} not loaded/not found — nothing to disable"
      fi
    done
  done < <(discover_stack_slugs "${config_dir}")
}

# Delete the two rendered TEMPLATE unit files from UNIT_DIR — IFF each one
# still carries the render side's marker header. A marker-less file (hand-
# authored, or externally managed — see render_systemd_unit's docstring in
# systemd-render.sh) is left completely untouched: never deleted, warned
# about instead. The marker is the ONLY ownership signal this function
# trusts, mirroring render_systemd_unit's own rule exactly — removal must
# never be more aggressive than render was conservative.
#
# Runs `systemctl --user daemon-reload` at most once, and only when at least
# one file was actually deleted — same "reload only on change" discipline as
# the render side. Guarded the same way (a failing reload warns, never
# aborts the caller).
#
# Args: $1 UNIT_DIR — typically ${HOME}/.config/systemd/user
remove_cortex_systemd_unit_files() {
  local unit_dir="$1"
  local unit dst removed=0
  for unit in nats@.service cortex@.service; do
    dst="${unit_dir}/${unit}"
    if [ ! -f "${dst}" ]; then
      echo "  ⊘ ${unit} not present — nothing to remove"
      continue
    fi
    if [ "$(sed -n '1p' "${dst}" 2>/dev/null)" != "${SYSTEMD_UNIT_MARKER}" ]; then
      echo "  ⊘ ${unit} exists without the cortex systemd-render marker — leaving it untouched (hand-authored or externally managed; delete it yourself if it should go)" >&2
      continue
    fi
    rm -f "${dst}"
    removed=$((removed + 1))
    echo "  ✓ ${unit} removed"
  done

  if [ "${removed}" -gt 0 ]; then
    if run_with_timeout systemctl --user daemon-reload; then
      echo "  ✓ systemd user daemon reloaded (${removed} unit file(s) removed)"
    else
      echo "  ⚠ systemctl --user daemon-reload failed (bus unavailable or timed out) — the daemon may still list the removed unit(s) until the next successful reload; re-run \`systemctl --user daemon-reload\` manually" >&2
    fi
  fi
}

# Full L1 rollback: disable every discovered instance, THEN delete the
# marker-guarded template files, then reload — in that order, so systemd
# never has a live unit pointing at a file that's already gone.
#
# Never aborts the caller: mirrors render_cortex_systemd_units' contract
# exactly (scripts/preremove.sh runs under `set -e`, same as postinstall.sh/
# postupgrade.sh, and an unguarded failure here must not abort `arc remove`).
#
# No-ops (silently, exit 0) on Darwin and on a systemd-less host — see
# systemd_host_detected() in systemd-render.sh. A host that never rendered
# these units (systemd_host_detected false, or UNIT_DIR never existed) has
# nothing to clean up either way.
#
# Args: $1 UNIT_DIR   — typically ${HOME}/.config/systemd/user
#       $2 CONFIG_DIR — cortex config dir, for stack discovery
remove_cortex_systemd_units() {
  local unit_dir="$1"
  local config_dir="$2"

  if [ "$(uname)" = "Darwin" ]; then
    return 0
  fi
  if ! systemd_host_detected; then
    return 0
  fi

  disable_cortex_systemd_instances "${config_dir}"
  remove_cortex_systemd_unit_files "${unit_dir}"
}
