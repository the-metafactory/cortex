#!/bin/bash
# Cortex systemd user-unit renderer — Linux twin of plist-render.sh.
#
# cortex#2071 (L1 of the Linux host support epic, arc design/linux-host-support.md
# / arc#309): auto-renders the two systemd TEMPLATE units (nats@.service,
# cortex@.service) checked in at src/services/ into ~/.config/systemd/user/, so
# `arc upgrade cortex` gives Linux the same "no hand-written service files"
# experience Darwin gets from plist-render.sh. Content is community-validated
# on Debian 13 (README-AGENTS.md Appendix A is the byte-consistent doc twin).
#
# Unlike plist-render.sh, there is NO per-stack render: these are systemd
# TEMPLATE units — the `%i` instance specifier IS the stack slug, resolved by
# systemd itself at unit-start time (DD-L1, #2071 executor addendum) — so ONE
# copy of each file serves every stack on the host. "Render" here means: copy
# the checked-in unit + stamp the marker header + idempotent diff-check +
# daemon-reload only when something actually changed. No __TOKEN__
# substitution is needed today — ExecStart execs %h/.local/bin/cortex
# directly, so there is no bun-path or cortex-dir templating the way the
# plist's __BUN_PATH__/__CORTEX_DIR__ needs.
#
# Usage (in the calling script):
#   source "${SCRIPT_DIR}/lib/systemd-render.sh"
#   render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}"
#
# Functions never write outside ${UNIT_DIR} (the linger/symlink checks are
# read-only).

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# plist-render.sh provides discover_stack_slugs — stack enumeration is shared,
# host-independent logic, no reason to fork it for the systemd side. Sourcing
# here (rather than relying on the caller to have sourced it already) lets
# this file be sourced standalone (tests do exactly that).
# shellcheck source=scripts/lib/plist-render.sh
source "${LIB_DIR}/plist-render.sh"

# Marker contract (coordinates with the rollback issue cortex#2093): every
# unit this renderer installs carries this header as its FIRST line. Removal
# (#2093) only deletes marker-bearing files, so a hand-authored unit at the
# same path (e.g. a principal who followed Appendix A by hand before
# upgrading) is never silently touched by either render or rollback.
SYSTEMD_UNIT_MARKER="# rendered-by: cortex systemd-render v1"

# True if this host plausibly runs systemd. Two independent signals so the
# check doesn't depend on ${UNIT_DIR} already existing:
#   - /run/systemd/system — the standard "systemd is PID 1" marker, present
#     from first boot on any systemd host, well before we ever touch
#     ~/.config/systemd/user. Overridable via SYSTEMD_HOST_MARKER for tests
#     (the real /run/systemd/system can't be faked-absent from a test).
#   - ~/.config/systemd/user existing — fallback for a container/chroot where
#     the marker file is absent but a systemd user session was configured
#     anyway (e.g. a hand-followed Appendix A before this renderer existed).
# Neither present → treat the host as systemd-less and skip silently (no
# warning): a WSL1 box, a minimal container, or a non-systemd distro is not a
# cortex misconfiguration.
systemd_host_detected() {
  [ -d "${SYSTEMD_HOST_MARKER:-/run/systemd/system}" ] && return 0
  [ -d "${HOME}/.config/systemd/user" ] && return 0  # xdg-audit:allow(resolver-internal host detection — the canonical systemd user-unit dir is the fallback existence signal, not a legacy path; cortex#2071)
  return 1
}

# Render ONE unit file: read $1 (checked-in template), prepend the marker
# header, and write it to $2 (dest) ONLY if the result differs from what's
# already there. On an actual write, bumps the caller-visible
# SYSTEMD_RENDER_CHANGE_COUNT counter (reset by the caller before the loop) so
# render_cortex_systemd_units can gate the single daemon-reload call on
# whether ANY unit changed — systemd's daemon-reload is a global unit-file
# rescan; firing it every upgrade even when nothing changed is needless churn
# (#2071 executor addendum: "idempotent render + daemon-reload only on
# change").
#
# Args: $1 src file  $2 dst path
render_systemd_unit() {
  local src="$1" dst="$2"
  local name
  name="$(basename "${dst}")"
  if [ ! -f "${src}" ]; then
    echo "  ⚠ Template missing: ${src}" >&2
    return 1
  fi
  # G-30-style atomic render (mirrors plist-render.sh's render_stack_plist): a
  # bare redirect onto a live unit path could leave a truncated file visible
  # to systemd if the render is interrupted mid-write.
  local tmp="${dst}.tmp"
  { printf '%s\n' "${SYSTEMD_UNIT_MARKER}"; cat "${src}"; } > "${tmp}"
  if [ -f "${dst}" ] && cmp -s "${tmp}" "${dst}"; then
    rm -f "${tmp}"
    echo "  ⊘ ${name} unchanged"
    return 0
  fi
  mv -f "${tmp}" "${dst}"
  echo "  ✓ ${name} rendered → ${dst}"
  SYSTEMD_RENDER_CHANGE_COUNT=$((${SYSTEMD_RENDER_CHANGE_COUNT:-0} + 1))
}

# bun-guard analogue (#2071 executor addendum). Unlike the plist path
# (resolve_bun_path — __BUN_PATH__ is sed-substituted into the plist), the
# systemd units exec %h/.local/bin/cortex directly and need no bun-path
# substitution at all. What CAN still be missing is the symlink itself (this
# renderer running ahead of, or independent of, a completed arc install) —
# warn loudly rather than let ExecStart silently fail-and-respawn-loop with no
# explanation visible in the unit file.
verify_cortex_bin_symlink() {
  local target="${HOME}/.local/bin/cortex"
  if [ ! -e "${target}" ]; then
    echo "  ⚠ ${target} not found — the rendered cortex@.service unit's ExecStart will fail. Run \`arc install cortex\` (or \`arc upgrade cortex\`) first." >&2
    return 1
  fi
  return 0
}

# Linger check (Appendix A §A.1). Without lingering, systemd tears down the
# user's session — and every --user unit with it — the moment their last
# login session ends (SSH logout, etc.). loginctl's `Linger` user property is
# `yes`/`no`; anything else (including loginctl erroring, e.g. no
# systemd-logind) is treated as "not confirmed enabled" and warned. NEVER sudo
# here (#2071 executor addendum) — only print the exact remediation command
# (same shape as Appendix A §A.1) for the operator to run themselves.
warn_systemd_linger() {
  local user linger
  user="$(id -un)"
  linger="$(loginctl show-user "${user}" --property=Linger --value 2>/dev/null || true)"
  if [ "${linger}" != "yes" ]; then
    echo "  ⚠ linger not enabled for ${user} — systemd will stop your cortex services on logout. Enable with: sudo loginctl enable-linger \"${user}\"" >&2
    return 1
  fi
  return 0
}

# Restart only ACTIVE cortex@<slug> instances after an upgrade — the systemd
# mirror of postupgrade.sh's plist reload_stack_unless_skipped loop. Unlike
# the Darwin side, preupgrade.sh's stop/kill block is Darwin-only (see
# preupgrade.sh's cortex#1909 note), so there is no RUNNING_STACKS_FILE to
# replay here; "was it running" is answered directly via `systemctl --user
# is-active`. A stack that isn't currently active is left alone — this must
# never START a stack that wasn't running (same "no stack left down; none
# started that wasn't running" symmetry goal as the plist path, just checked
# live instead of from recorded state).
#
# NOTE: CORTEX_UPGRADE_SKIP_RESTART parity (sparing a production stack from
# restart) is explicitly NOT implemented here — preupgrade.sh documents that
# gap as Linux/systemd territory for cortex#1909, not this issue.
#
# Args: $1 CONFIG_DIR — cortex config dir (stacks are discovered from here)
restart_running_systemd_stacks() {
  local config_dir="$1"
  local slug unit
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    unit="cortex@${slug}"
    if systemctl --user is-active --quiet "${unit}" 2>/dev/null; then
      systemctl --user restart "${unit}"
      echo "  ✓ ${unit} restarted"
    else
      echo "  ⊘ ${unit} not active — not restarted"
    fi
  done < <(discover_stack_slugs "${config_dir}")
}

# Ensure the per-stack workspace dir exists for every discovered stack
# (cortex#2097's `WorkingDirectory=%h/.local/share/metafactory/cortex/%i/workspace`
# on cortex@.service).
#
# This is NOT optional belt-and-braces — it's load-bearing. Verified
# empirically (systemd 257, Debian trixie): `WorkingDirectory=` is entered
# BEFORE *any* exec command of the unit runs, including ExecStartPre — a
# missing WorkingDirectory fails the unit outright (systemd exit reason
# EXIT_CHDIR/200) before ExecStartPre's own `mkdir -p` of that same path ever
# gets to execute. The unit file cannot self-heal this; the directory must
# already exist by the time `systemctl --user enable/start` runs.
#
# Until cortex#2097 ships (stack scaffolding creates this dir itself), NOTHING
# else in the codebase creates it — so this is the one prerequisite render
# time can and must cover, mirroring how README-AGENTS.md Appendix A §A.1
# hand-creates nats-server's log dir as a one-time host-prep step for the
# same reason (see the ExecStartPre note on render_cortex_systemd_units below
# for why the *log* dirs don't need this treatment).
#
# Args: $1 CONFIG_DIR — cortex config dir (stacks are discovered from here)
ensure_stack_workspace_dirs() {
  local config_dir="$1"
  local slug
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    mkdir -p "${HOME}/.local/share/metafactory/cortex/${slug}/workspace"
  done < <(discover_stack_slugs "${config_dir}")
}

# Render nats@.service + cortex@.service into UNIT_DIR from the templates
# checked in under CORTEX_DIR/src/services/, ensure every discovered stack's
# workspace dir exists (see ensure_stack_workspace_dirs), then run the
# bun-guard-analogue symlink check and the linger check.
# `systemctl --user daemon-reload` runs at most once, and only when at least
# one unit's content actually changed.
#
# NOTE on the units' `ExecStartPre=/usr/bin/mkdir -p .../logs` lines: those
# are NOT dead code the way an un-pre-created WorkingDirectory is, but they
# are also not a substitute for pre-creating the parent on a truly fresh
# host — `StandardOutput=append:<path under that dir>` is set up before
# ExecStartPre runs too, so on a from-nothing host the very first start
# needs the log dir to already exist (README-AGENTS.md Appendix A §A.1 hand-
# creates nats-server's; postinstall.sh's state bootstrap creates cortex's,
# host-independent). The ExecStartPre line's job is the idempotent
# re-creation case (dir survives; a later restart is a no-op mkdir), which is
# genuinely useful — it's only the *cold-start* case that needs an external
# actor, which is why workspace (with no OTHER creator yet, pre-cortex#2097)
# gets handled here explicitly and logs (which already have one) don't.
#
# No-ops (silently, exit 0) on Darwin and on a systemd-less host — see
# systemd_host_detected().
#
# Args: $1 CORTEX_DIR — repo root (unit templates live under src/services/)
#       $2 UNIT_DIR   — target dir, typically ${HOME}/.config/systemd/user
#       $3 CONFIG_DIR — cortex config dir, for ensure_stack_workspace_dirs
render_cortex_systemd_units() {
  local cortex_dir="$1"
  local unit_dir="$2"
  local config_dir="$3"

  if [ "$(uname)" = "Darwin" ]; then
    return 0
  fi
  if ! systemd_host_detected; then
    return 0
  fi

  mkdir -p "${unit_dir}"

  SYSTEMD_RENDER_CHANGE_COUNT=0
  local unit
  for unit in nats@.service cortex@.service; do
    render_systemd_unit "${cortex_dir}/src/services/${unit}" "${unit_dir}/${unit}" || true
  done

  if [ "${SYSTEMD_RENDER_CHANGE_COUNT}" -gt 0 ]; then
    systemctl --user daemon-reload
    echo "  ✓ systemd user daemon reloaded (${SYSTEMD_RENDER_CHANGE_COUNT} unit(s) changed)"
  fi

  ensure_stack_workspace_dirs "${config_dir}"
  verify_cortex_bin_symlink || true
  warn_systemd_linger || true
}
