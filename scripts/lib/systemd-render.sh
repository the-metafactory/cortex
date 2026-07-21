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
#   render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
#
# Functions never write outside ${UNIT_DIR}, ${HOME}/.local/share/metafactory/
# cortex/<slug>/workspace (per discovered stack), and ${HOME}/.local/state/nats/
# logs. Deliberately NOT ${HOME}/.local/state/metafactory/cortex — that tree's
# creation is postinstall.sh's §1b state bootstrap's authority alone (see
# ensure_stack_log_dirs' docstring); the linger/symlink checks are read-only.
#
# PR#2103 adversarial review (three rounds) found this file's first cut unsafe
# in four ways, all fixed here:
#   - the shipped units could not start on a fresh host at all (WorkingDirectory/
#     StandardOutput both fail-closed on a missing directory, BEFORE any exec
#     command including ExecStartPre runs — see render_cortex_systemd_units'
#     and ensure_stack_workspace_dirs' docstrings);
#   - a `systemctl --user` failure under the callers' `set -e` could abort the
#     whole install/upgrade, or silently truncate the stack-restart loop
#     (see run_with_timeout + the guarded call sites below);
#   - render_systemd_unit clobbered a hand-authored unit unconditionally —
#     Appendix A explicitly invites hand-copying these exact files, so a
#     marker-less dst is now left untouched (see render_systemd_unit);
#   - the first fix for the StandardOutput/EXIT_STDOUT half of the fresh-host
#     bug unconditionally created the CANONICAL cortex state tree, which broke
#     the XDG wave-5 gated-migration invariant that an upgrade box gets NO
#     canonical-tree writes from postinstall until cortex#1903's migration
#     runs (see ensure_stack_log_dirs' docstring — this class of bug is why
#     the existing test suite matters even for code that looks unrelated).

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# plist-render.sh provides discover_stack_slugs — stack enumeration is shared,
# host-independent logic, no reason to fork it for the systemd side. Sourcing
# here (rather than relying on the caller to have sourced it already) lets
# this file be sourced standalone (tests do exactly that).
# shellcheck source=scripts/lib/plist-render.sh
source "${LIB_DIR}/plist-render.sh"

# Marker contract (coordinates with the rollback issue cortex#2093): every
# unit THIS RENDERER WROTE carries this header as its first line.
# render_systemd_unit only ever overwrites a dst that already carries it (or
# doesn't exist yet); a marker-less dst — e.g. a principal who hand-copied
# Appendix A before this renderer existed — is left untouched, warned about,
# and never rendered over. Removal (#2093) uses the same rule to decide what
# it may delete.
SYSTEMD_UNIT_MARKER="# rendered-by: cortex systemd-render v1"

# Timeout wrapper around every systemctl/loginctl --user call in this file —
# a wedged --user D-Bus session must not hang `arc install`/`arc upgrade`
# indefinitely (PR#2103 review). Degrades to a bare call when `timeout`
# (coreutils) isn't installed, which is rare but not guaranteed on every
# minimal distro.
#
# Args: the command + its args, e.g. `run_with_timeout systemctl --user ...`
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 "$@"
  else
    "$@"
  fi
}

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
# header, and write it to $2 (dest) — UNLESS dst already exists WITHOUT the
# marker, in which case it is left completely untouched (see the
# hand-authored-unit note below). On an actual write, bumps the
# caller-visible SYSTEMD_RENDER_CHANGE_COUNT counter (reset by the caller
# before the loop) so render_cortex_systemd_units can gate the single
# daemon-reload call on whether ANY unit changed — systemd's daemon-reload is
# a global unit-file rescan; firing it every upgrade even when nothing
# changed is needless churn (#2071 executor addendum: "idempotent render +
# daemon-reload only on change").
#
# Hand-authored-unit protection (PR#2103 review MAJOR finding): README-AGENTS.md
# Appendix A explicitly invited operators to hand-copy these exact files
# before this renderer existed, and a from-source install may still have a
# customized unit at this path. A marker-less dst is therefore NOT
# necessarily stale output from an old version of this renderer — it may be
# someone's deliberate customization — so it is left alone, not overwritten.
# The marker is the ONLY ownership signal this function trusts: present →
# we rendered it, safe to keep in sync; absent → not ours, don't touch it.
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

  if [ -f "${dst}" ] && [ "$(sed -n '1p' "${dst}" 2>/dev/null)" != "${SYSTEMD_UNIT_MARKER}" ]; then
    echo "  ⊘ ${name} exists without the cortex systemd-render marker — leaving it untouched (hand-authored or externally managed; delete it or add the marker line yourself to let the renderer manage it)" >&2
    return 0
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
# systemd-logind, or timing out — see run_with_timeout) is treated as "not
# confirmed enabled" and warned. NEVER sudo here (#2071 executor addendum) —
# only print the exact remediation command (same shape as Appendix A §A.1)
# for the operator to run themselves.
warn_systemd_linger() {
  local user linger
  user="$(id -un)"
  linger="$(run_with_timeout loginctl show-user "${user}" --property=Linger --value 2>/dev/null || true)"
  if [ "${linger}" != "yes" ]; then
    echo "  ⚠ linger not enabled for ${user} — systemd will stop your cortex services on logout. Enable with: sudo loginctl enable-linger \"${user}\"" >&2
    return 1
  fi
  return 0
}

# Ensure the nats-server log dir both units' (well, nats@.service's own)
# `StandardOutput=`/`StandardError=append:` lines write into actually
# exists, at RENDER time — not via the unit's own `ExecStartPre=mkdir -p`
# line, which CANNOT do this job on a cold start.
#
# Verified empirically (systemd 257, Debian trixie AND independently on
# Ubuntu 22.04 / systemd 249): `StandardOutput=append:<path>` is opened
# BEFORE any exec command of the unit runs, including ExecStartPre — a
# missing log dir fails the unit outright (systemd exit reason
# EXIT_STDOUT/209) before ExecStartPre's own `mkdir -p` of that same
# directory ever gets to execute. The ExecStartPre line stays in the unit
# file as belt-and-braces (a harmless no-op once the dir already exists, and
# it DOES help if a warm dir gets deleted between a stop and the next start —
# just never on the very first cold start), but the actual cold-start
# guarantee has to come from here: nothing else in the codebase creates
# `~/.local/state/nats/logs` (nats-server is an external dependency;
# README-AGENTS.md Appendix A §A.1 hand-creates it for the manual path, this
# is the arc-managed equivalent).
#
# `~/.local/state/metafactory/cortex/logs` is DELIBERATELY NOT created here,
# even though cortex@.service needs the identical guarantee. That directory
# is part of the CANONICAL CORTEX STATE TREE. On a FRESH install it is created
# by postinstall.sh's §1b state bootstrap (migrate-state-dir-exec.ts); on an
# UPGRADE box §1b is deliberately inert (the XDG wave-5 gated migration,
# cortex#1903) and the guarantee comes from postupgrade.sh's Darwin-side
# `mkdir -p` (cortex#2282) or, on Linux, from the tree the gated migration
# itself materializes. The §1b upgrade-inertness is verified via
# scripts/__tests__/postinstall-state-bootstrap.sh's own invariant: on an
# UPGRADE box (legacy grove state present, not yet migrated) postinstall must
# write NOTHING state-related, no canonical tree at all, until the gated
# migration explicitly runs. This function creating even just the logs/
# subdirectory unconditionally would violate that invariant (confirmed: it
# broke that exact test in PR#2103 review round 3 before this comment was
# written) — a genuinely fresh box gets the tree from §1b already; an
# upgrade-in-progress box is intentionally left alone by both. The residual
# gap (a NOT-YET-migrated upgrade box trying to `enable` a NEW stack before
# cortex#1903's migration completes) belongs to that migration, not this
# renderer duplicating its authority.
ensure_stack_log_dirs() {
  mkdir -p "${HOME}/.local/state/nats/logs"
}

# Ensure the per-stack workspace dir exists for every discovered stack
# (cortex#2097's `WorkingDirectory=-%h/.local/share/metafactory/cortex/%i/workspace`
# on cortex@.service).
#
# Defense-in-depth, not the only guard: the unit's `WorkingDirectory=` now
# carries the `-` prefix (missing dir is non-fatal — ExecStartPre's own
# `mkdir -p` of the same path then creates it, and ExecStart's chdir
# succeeds; verified empirically against a real systemd user session with NO
# other actor pre-creating the dir). This function covers every ALREADY
# DISCOVERED stack proactively at render time (so an arc-managed upgrade
# never even needs the self-heal path); later-created stacks (before
# cortex#2097's stack-scaffold ships its own creation step) fall through to
# the unit's own self-heal on first enable.
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
# checked in under CORTEX_DIR/src/services/, ensure the nats log dir and every
# discovered stack's workspace dir exist (see ensure_stack_log_dirs /
# ensure_stack_workspace_dirs — the cortex log dir is deliberately NOT this
# function's job, see ensure_stack_log_dirs' docstring), then run the
# bun-guard-analogue symlink check and the linger check. `systemctl --user
# daemon-reload` runs at most once, and only when at least one unit's content
# actually changed.
#
# Never aborts the caller: `daemon-reload` is guarded (a transient bus
# failure prints a warning and continues — postinstall.sh/postupgrade.sh both
# run under `set -e`, and an unguarded systemctl call here would silently
# abort the whole install/upgrade on a flaky bus; PR#2103 review BLOCKER 2).
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
  ensure_stack_log_dirs

  SYSTEMD_RENDER_CHANGE_COUNT=0
  local unit
  for unit in nats@.service cortex@.service; do
    render_systemd_unit "${cortex_dir}/src/services/${unit}" "${unit_dir}/${unit}" || true
  done

  if [ "${SYSTEMD_RENDER_CHANGE_COUNT}" -gt 0 ]; then
    if run_with_timeout systemctl --user daemon-reload; then
      echo "  ✓ systemd user daemon reloaded (${SYSTEMD_RENDER_CHANGE_COUNT} unit(s) changed)"
    else
      echo "  ⚠ systemctl --user daemon-reload failed (bus unavailable or timed out) — rendered units may not be picked up until the next successful reload; re-run \`arc upgrade cortex\` or \`systemctl --user daemon-reload\` manually" >&2
    fi
  fi

  ensure_stack_workspace_dirs "${config_dir}"
  verify_cortex_bin_symlink || true
  warn_systemd_linger || true
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
# Never aborts the caller and never stops early on one bad stack (PR#2103
# review BLOCKER 2): an unguarded `systemctl --user restart` failing under
# the caller's `set -e` would abort postupgrade.sh mid-loop, silently
# skipping every stack after the one that failed. Each restart is guarded;
# failures are collected and reported in a single summary line at the end,
# and the function itself always returns 0.
#
# NOTE: CORTEX_UPGRADE_SKIP_RESTART parity (sparing a production stack from
# restart) is explicitly NOT implemented here — preupgrade.sh documents that
# gap as Linux/systemd territory for cortex#1909, not this issue.
#
# Args: $1 CONFIG_DIR — cortex config dir (stacks are discovered from here)
restart_running_systemd_stacks() {
  local config_dir="$1"
  local slug unit failed=""
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    unit="cortex@${slug}"
    if run_with_timeout systemctl --user is-active --quiet "${unit}" 2>/dev/null; then
      if run_with_timeout systemctl --user restart "${unit}"; then
        echo "  ✓ ${unit} restarted"
      else
        echo "  ✗ ${unit} restart FAILED (bus unavailable, timed out, or the restart itself failed) — check \`systemctl --user status ${unit}\`" >&2
        failed="${failed}${failed:+ }${unit}"
      fi
    else
      echo "  ⊘ ${unit} not active — not restarted"
    fi
  done < <(discover_stack_slugs "${config_dir}")

  if [ -n "${failed}" ]; then
    echo "  ⚠ restart_running_systemd_stacks: failed to restart: ${failed} — investigate manually, the rest of the upgrade completed" >&2
  fi
  return 0
}
