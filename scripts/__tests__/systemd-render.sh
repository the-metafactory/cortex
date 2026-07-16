#!/bin/bash
# cortex#2071 (L1, Linux host support) — unit tests for scripts/lib/systemd-render.sh:
# marker-header idempotency, hand-authored-unit protection, daemon-reload-only-
# on-change, the Darwin/systemd-less no-ops, the bin-symlink + linger warnings,
# the restart-only-if-active loop, and (PR#2103 review round 2) the guarded-
# systemctl / set -e survival behavior plus the timeout wrapper.
#
# Tests run entirely in a scratch $HOME; no live ~/.config/systemd/user or
# systemctl/loginctl is touched — both are mocked via PATH override, same
# pattern as plist-render-bin-cutover.sh's launchctl mock. `uname` is ALSO
# mocked so the Linux-only render path is exercised regardless of the host
# actually running this suite (macOS dev box or Linux CI runner alike);
# systemd_host_detected's /run/systemd/system check is redirected via
# SYSTEMD_HOST_MARKER so "systemd-less host" is testable without touching the
# real /run.
#
# Run:
#   bash scripts/__tests__/systemd-render.sh
#
# Exit code: 0 = all pass, non-zero = failure count.

set -euo pipefail

# ─── Test harness ─────────────────────────────────────────────────
PASS=0
FAIL=0

pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    pass "${label}"
  else
    fail "${label}: expected «${expected}» got «${actual}»"
  fi
}

assert_true() {
  local label="$1"; shift
  if "$@"; then pass "${label}"; else fail "${label}"; fi
}

assert_false() {
  local label="$1"; shift
  if "$@"; then fail "${label}"; else pass "${label}"; fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "${path}" ]; then pass "${label}"; else fail "${label}: not found: ${path}"; fi
}

assert_grep_file() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "${needle}" "${file}"; then pass "${label}"; else fail "${label}"; fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TMPHOME="$(mktemp -d)"
trap 'rm -rf "${TMPHOME}"' EXIT
export HOME="${TMPHOME}"

# Source AFTER HOME is set (functions read ${HOME} at call time, so ordering
# doesn't strictly matter, but keep it explicit — same convention as the
# plist-render bin-cutover suite).
# shellcheck source=scripts/lib/systemd-render.sh
source "${SCRIPT_DIR}/lib/systemd-render.sh"

# Mock bin dir: uname (force "Linux" so the render path runs on any host this
# suite executes on), systemctl (trace log + controllable is-active/
# daemon-reload/restart failure injection), and loginctl (controllable
# Linger value). `timeout` itself is NOT mocked — the real coreutils
# `timeout` (present on both macOS-via-homebrew dev boxes and every Ubuntu CI
# runner) transparently wraps the mocked systemctl/loginctl below, so
# run_with_timeout's normal path is exercised for real; only its "timeout not
# installed" degrade path needs a PATH trick (see the run_with_timeout
# section).
MOCK_BIN="${TMPHOME}/mock-bin"
mkdir -p "${MOCK_BIN}"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF
chmod +x "${MOCK_BIN}/uname"

export SYSTEMCTL_LOG="${TMPHOME}/systemctl.log"
# ACTIVE_UNITS_FILE: newline-separated unit names `systemctl --user is-active
# --quiet <unit>` should report active (exit 0) for; anything else exits 1.
export ACTIVE_UNITS_FILE="${TMPHOME}/active-units"
: > "${ACTIVE_UNITS_FILE}"
# FAIL_DAEMON_RELOAD=1 → `daemon-reload` exits 1 (simulates a wedged/unavailable bus).
# FAIL_RESTART_UNITS="unit1 unit2" → `restart <unit>` exits 1 iff <unit> is listed.
cat > "${MOCK_BIN}/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"
if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then
  unit="$4"
  grep -qxF "${unit}" "${ACTIVE_UNITS_FILE:-/dev/null}" && exit 0
  exit 1
fi
if [ "$1" = "--user" ] && [ "$2" = "daemon-reload" ]; then
  [ "${FAIL_DAEMON_RELOAD:-0}" = "1" ] && exit 1
  exit 0
fi
if [ "$1" = "--user" ] && [ "$2" = "restart" ]; then
  unit="$3"
  for u in ${FAIL_RESTART_UNITS:-}; do
    [ "$u" = "$unit" ] && exit 1
  done
  exit 0
fi
exit 0
EOF
chmod +x "${MOCK_BIN}/systemctl"

export LINGER_VALUE="yes"
cat > "${MOCK_BIN}/loginctl" <<'EOF'
#!/bin/sh
printf '%s' "${LINGER_VALUE:-yes}"
EOF
chmod +x "${MOCK_BIN}/loginctl"

export PATH="${MOCK_BIN}:${PATH}"

# A minimal but complete cortex_dir carrying the two real checked-in unit
# templates, so render_systemd_unit exercises the actual shipped content.
CORTEX_DIR="${REPO_ROOT}"

reset_unit_dir() {
  UNIT_DIR="${TMPHOME}/unit-dir"
  rm -rf "${UNIT_DIR}"
}

# ─── Section 1: systemd_host_detected ─────────────────────────────
printf '\n=== systemd_host_detected ===\n'

# Neither /run marker nor ~/.config/systemd/user present → not detected.
export SYSTEMD_HOST_MARKER="${TMPHOME}/no-such-run-systemd-system"
rm -rf "${HOME}/.config/systemd/user"
assert_false "neither signal present → not detected" systemd_host_detected

# /run marker present (faked via override) → detected.
mkdir -p "${TMPHOME}/fake-run-systemd-system"
export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"
assert_true "run-systemd marker present → detected" systemd_host_detected

# Fallback: marker absent, but ~/.config/systemd/user already exists.
export SYSTEMD_HOST_MARKER="${TMPHOME}/no-such-run-systemd-system"
mkdir -p "${HOME}/.config/systemd/user"
assert_true "~/.config/systemd/user present → detected (fallback)" systemd_host_detected
rm -rf "${HOME}/.config/systemd/user"

# Restore a present marker for the rest of the suite.
export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"

# ─── Section 2: render_systemd_unit — marker + idempotency ────────
printf '\n=== render_systemd_unit ===\n'

reset_unit_dir
mkdir -p "${UNIT_DIR}"
SYSTEMD_RENDER_CHANGE_COUNT=0

render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service"
assert_file_exists "cortex@.service written" "${UNIT_DIR}/cortex@.service"
assert_eq "first render → change count 1" "1" "${SYSTEMD_RENDER_CHANGE_COUNT}"
assert_eq "marker is line 1" "# rendered-by: cortex systemd-render v1" \
  "$(sed -n '1p' "${UNIT_DIR}/cortex@.service")"
assert_grep_file "WorkingDirectory carries the '-' prefix (PR#2103 BLOCKER 1 fix — missing dir is non-fatal)" \
  "${UNIT_DIR}/cortex@.service" 'WorkingDirectory=-%h/.local/share/metafactory/cortex/%i/workspace'
assert_grep_file "matching ExecStartPre workspace mkdir line present (belt-and-braces; works now that '-' lets it run)" \
  "${UNIT_DIR}/cortex@.service" 'ExecStartPre=/usr/bin/mkdir -p %h/.local/share/metafactory/cortex/%i/workspace'

# Re-render with IDENTICAL content → no-op, change count NOT bumped again.
render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service"
assert_eq "unchanged re-render → change count stays 1" "1" "${SYSTEMD_RENDER_CHANGE_COUNT}"

# A MARKED dst with a stale/drifted body (e.g. rendered by an older version of
# this renderer, or the checked-in template changed) → still OURS (marker
# present), gets overwritten normally: count bumps, marker stays line 1.
{ printf '%s\n' "# rendered-by: cortex systemd-render v1"; printf 'stale marked content\n'; } > "${UNIT_DIR}/cortex@.service"
render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service"
assert_eq "marked-but-stale dst → re-rendered, change count bumps to 2" "2" "${SYSTEMD_RENDER_CHANGE_COUNT}"
assert_eq "marked-but-stale dst → marker still line 1 after re-render" "# rendered-by: cortex systemd-render v1" \
  "$(sed -n '1p' "${UNIT_DIR}/cortex@.service")"

# ── Hand-authored-unit protection (PR#2103 review MAJOR finding) ──
# A dst that exists WITHOUT the marker (e.g. hand-copied per Appendix A
# before this renderer existed, or a from-source operator's customization)
# must be left COMPLETELY untouched: not overwritten, not deleted,
# byte-identical before and after, and the change counter must NOT move.
HAND_REF="$(mktemp)"
cat > "${HAND_REF}" <<'EOF'
[Unit]
Description=My own hand-authored cortex unit, please do not touch
EOF
cp "${HAND_REF}" "${UNIT_DIR}/cortex@.service"
HAND_BEFORE_COUNT="${SYSTEMD_RENDER_CHANGE_COUNT}"
HAND_WARN="$(mktemp)"
render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service" 2>"${HAND_WARN}"
assert_true "hand-authored dst is byte-identical after render (never touched)" \
  cmp -s "${HAND_REF}" "${UNIT_DIR}/cortex@.service"
assert_eq "hand-authored dst → change count NOT bumped" "${HAND_BEFORE_COUNT}" "${SYSTEMD_RENDER_CHANGE_COUNT}"
assert_grep_file "hand-authored dst → warns it was left untouched" "${HAND_WARN}" \
  "exists without the cortex systemd-render marker"
rm -f "${HAND_WARN}" "${HAND_REF}"

# Missing template source → warns, returns non-zero, nothing written.
reset_unit_dir
mkdir -p "${UNIT_DIR}"
assert_false "missing template source → non-zero" \
  render_systemd_unit "${CORTEX_DIR}/src/services/does-not-exist.service" "${UNIT_DIR}/does-not-exist.service"
assert_false "missing template source → nothing written" \
  test -e "${UNIT_DIR}/does-not-exist.service"

# ─── Section 3: ensure_stack_log_dirs ──────────────────────────────
printf '\n=== ensure_stack_log_dirs ===\n'

rm -rf "${HOME}/.local/state/nats" "${HOME}/.local/state/metafactory"
ensure_stack_log_dirs
assert_true "nats log dir created (nothing else creates this on Linux)" \
  test -d "${HOME}/.local/state/nats/logs"
# The cortex log dir is DELIBERATELY NOT this function's job — see its
# docstring. Regression case: an earlier version of this function created it
# unconditionally, which broke scripts/__tests__/postinstall-state-bootstrap.sh's
# invariant that an UPGRADE box gets ZERO writes to the canonical cortex state
# tree from postinstall until cortex#1903's gated migration runs (PR#2103
# review round 3, caught live in CI's plain Test job).
assert_false "cortex log dir NOT created here (owned by postinstall's §1b + the XDG wave-5 gate)" \
  test -d "${HOME}/.local/state/metafactory/cortex/logs"
# Idempotent — a second call on an already-existing dir is a clean no-op.
assert_true "re-running is a clean no-op" ensure_stack_log_dirs

# ─── Section 4: render_cortex_systemd_units — orchestration ───────
printf '\n=== render_cortex_systemd_units ===\n'

# Config-dir fixture with two discoverable stacks — used for the
# workspace-dir-creation assertions below and for the restart-loop tests.
CONFIG_DIR="${TMPHOME}/config"
mkdir -p "${CONFIG_DIR}/work/system" "${CONFIG_DIR}/halden/system"
: > "${CONFIG_DIR}/work/work.yaml"
: > "${CONFIG_DIR}/work/system/system.yaml"
: > "${CONFIG_DIR}/halden/halden.yaml"
: > "${CONFIG_DIR}/halden/system/system.yaml"

# Darwin (real uname on this suite is overridden to Linux via the mock; drive
# the Darwin guard directly by shadowing uname with a Darwin-reporting mock
# for this one case).
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Darwin"
EOF
reset_unit_dir
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_false "Darwin → no-op, unit dir not even created" test -d "${UNIT_DIR}"
assert_eq "Darwin → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"

# Restore the Linux-reporting uname mock for the rest of the suite.
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF

# systemd-less Linux host → no-op, unit dir not created.
export SYSTEMD_HOST_MARKER="${TMPHOME}/no-such-run-systemd-system"
rm -rf "${HOME}/.config/systemd/user"
reset_unit_dir
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_false "systemd-less Linux → no-op, unit dir not created" test -d "${UNIT_DIR}"
assert_eq "systemd-less Linux → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"
export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"

# Real systemd Linux host, fresh unit dir → both units rendered, exactly one
# daemon-reload call (not one per unit), the nats log dir exists, AND both
# discovered stacks' workspace dirs exist (defense-in-depth pre-creation — the
# units also self-heal this via the "-" WorkingDirectory prefix, but a
# proactive render-time create means an arc-managed upgrade never needs to
# fall back to that path at all).
reset_unit_dir
rm -rf "${HOME}/.local/share/metafactory/cortex" "${HOME}/.local/state/nats" "${HOME}/.local/state/metafactory"
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_file_exists "nats@.service rendered" "${UNIT_DIR}/nats@.service"
assert_file_exists "cortex@.service rendered" "${UNIT_DIR}/cortex@.service"
assert_eq "fresh render (2 units changed) → exactly 1 daemon-reload call" "1" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}")"
assert_true "render creates the nats log dir" test -d "${HOME}/.local/state/nats/logs"
# Regression guard (PR#2103 review round 3): render_cortex_systemd_units must
# NEVER create the canonical cortex state tree — that's postinstall.sh's §1b
# / the XDG wave-5 gated migration's authority alone, on EVERY host shape,
# fresh or upgrade (see ensure_stack_log_dirs' docstring).
assert_false "render does NOT create the cortex canonical state tree" \
  test -d "${HOME}/.local/state/metafactory/cortex"
assert_true "render also creates 'work' stack's workspace dir" \
  test -d "${HOME}/.local/share/metafactory/cortex/work/workspace"
assert_true "render also creates 'halden' stack's workspace dir" \
  test -d "${HOME}/.local/share/metafactory/cortex/halden/workspace"

# Re-render with nothing changed → zero daemon-reload calls (workspace/log-dir
# creation is idempotent — mkdir -p on an existing dir is a no-op).
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_eq "no-op re-render → zero daemon-reload calls" "0" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}" || true)"

# ── BLOCKER 2: a failing daemon-reload must not abort the caller ──
reset_unit_dir
: > "${SYSTEMCTL_LOG}"
export FAIL_DAEMON_RELOAD=1
RELOAD_ERR="$(mktemp)"
set +e
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}" 2>"${RELOAD_ERR}"
RELOAD_RC=$?
set -e
assert_eq "render_cortex_systemd_units returns 0 even when daemon-reload fails" "0" "${RELOAD_RC}"
assert_grep_file "failing daemon-reload is warned, not silently swallowed" "${RELOAD_ERR}" \
  "daemon-reload failed"
assert_file_exists "units were still rendered despite the reload failure" "${UNIT_DIR}/cortex@.service"
rm -f "${RELOAD_ERR}"
unset FAIL_DAEMON_RELOAD

# ── BLOCKER 2, end to end: a `set -e` caller (mirrors postinstall.sh/
# postupgrade.sh's own shebang) must run PAST a failing daemon-reload, not
# abort mid-script. ──
reset_unit_dir
export FAIL_DAEMON_RELOAD=1
SETE_OUT="$(mktemp)"
set +e
bash -c "set -e; source '${SCRIPT_DIR}/lib/systemd-render.sh'; render_cortex_systemd_units '${CORTEX_DIR}' '${UNIT_DIR}' '${CONFIG_DIR}'; echo SCRIPT_COMPLETED" > "${SETE_OUT}" 2>&1
SETE_RC=$?
set -e
assert_eq "a 'set -e' caller completes (exit 0) despite the failing daemon-reload" "0" "${SETE_RC}"
assert_grep_file "the caller ran past the guarded daemon-reload call" "${SETE_OUT}" "SCRIPT_COMPLETED"
rm -f "${SETE_OUT}"
unset FAIL_DAEMON_RELOAD

# ─── Section 5: ensure_stack_workspace_dirs (standalone) ──────────
printf '\n=== ensure_stack_workspace_dirs ===\n'

rm -rf "${HOME}/.local/share/metafactory/cortex"
ensure_stack_workspace_dirs "${CONFIG_DIR}"
assert_true "'work' workspace dir created" \
  test -d "${HOME}/.local/share/metafactory/cortex/work/workspace"
assert_true "'halden' workspace dir created" \
  test -d "${HOME}/.local/share/metafactory/cortex/halden/workspace"

# A config dir with no discoverable stacks → no-op, no error.
EMPTY_CONFIG_DIR="${TMPHOME}/empty-config"
mkdir -p "${EMPTY_CONFIG_DIR}"
assert_true "no stacks → ensure_stack_workspace_dirs is a clean no-op" \
  ensure_stack_workspace_dirs "${EMPTY_CONFIG_DIR}"

# ─── Section 6: verify_cortex_bin_symlink ─────────────────────────
printf '\n=== verify_cortex_bin_symlink ===\n'

rm -rf "${HOME}/.local/bin"
mkdir -p "${HOME}/.local/bin"
assert_false "missing ~/.local/bin/cortex → warns, non-zero" verify_cortex_bin_symlink

mkdir -p "${HOME}/.local/bin"
printf '#!/bin/sh\n' > "${HOME}/.local/bin/cortex"
assert_true "present ~/.local/bin/cortex → passes" verify_cortex_bin_symlink

# ─── Section 7: warn_systemd_linger ───────────────────────────────
printf '\n=== warn_systemd_linger ===\n'

export LINGER_VALUE="yes"
assert_true "Linger=yes → passes, no warning" warn_systemd_linger

export LINGER_VALUE="no"
WARN_OUT="$(mktemp)"
set +e
warn_systemd_linger 2>"${WARN_OUT}"
WARN_RC=$?
set -e
assert_eq "Linger=no → non-zero" "1" "${WARN_RC}"
assert_grep_file "Linger=no → exact remediation command printed" "${WARN_OUT}" \
  'sudo loginctl enable-linger'
assert_false "warn_systemd_linger never invokes sudo itself" \
  bash -c "grep -q '^sudo ' '${WARN_OUT}'"
rm -f "${WARN_OUT}"
export LINGER_VALUE="yes"

# ─── Section 8: restart_running_systemd_stacks ────────────────────
printf '\n=== restart_running_systemd_stacks ===\n'

# Reuses the CONFIG_DIR fixture (work + halden stacks) from Section 4.

# Only 'work' is active.
: > "${ACTIVE_UNITS_FILE}"
printf 'cortex@work\n' >> "${ACTIVE_UNITS_FILE}"

: > "${SYSTEMCTL_LOG}"
restart_running_systemd_stacks "${CONFIG_DIR}" > /dev/null
assert_eq "only active 'work' is restarted" "1" \
  "$(grep -c '^systemctl --user restart cortex@work$' "${SYSTEMCTL_LOG}")"
assert_eq "inactive 'halden' is NOT restarted" "0" \
  "$(grep -c '^systemctl --user restart cortex@halden$' "${SYSTEMCTL_LOG}" || true)"
assert_eq "inactive 'halden' IS checked (is-active called)" "1" \
  "$(grep -c '^systemctl --user is-active --quiet cortex@halden$' "${SYSTEMCTL_LOG}")"

# Nothing active → nothing restarted, no stack silently started.
: > "${ACTIVE_UNITS_FILE}"
: > "${SYSTEMCTL_LOG}"
restart_running_systemd_stacks "${CONFIG_DIR}" > /dev/null
assert_eq "nothing active → zero restart calls" "0" \
  "$(grep -c '^systemctl --user restart ' "${SYSTEMCTL_LOG}" || true)"

# ── BLOCKER 2: one failed restart must not abort the loop or hide the
# remaining stacks — it's collected and reported, everything else proceeds. ──
: > "${ACTIVE_UNITS_FILE}"
printf 'cortex@work\ncortex@halden\n' >> "${ACTIVE_UNITS_FILE}"
export FAIL_RESTART_UNITS="cortex@work"
: > "${SYSTEMCTL_LOG}"
RESTART_OUT="$(mktemp)"
set +e
restart_running_systemd_stacks "${CONFIG_DIR}" > "${RESTART_OUT}" 2>&1
RESTART_RC=$?
set -e
assert_eq "restart_running_systemd_stacks returns 0 even with a failed restart" "0" "${RESTART_RC}"
assert_grep_file "the failed unit is reported per-unit" "${RESTART_OUT}" "cortex@work restart FAILED"
assert_grep_file "the failed unit is named in the end-of-run summary" "${RESTART_OUT}" \
  "failed to restart: cortex@work"
assert_eq "the OTHER active stack (halden) still restarts despite work's failure" "1" \
  "$(grep -c '^systemctl --user restart cortex@halden$' "${SYSTEMCTL_LOG}")"
rm -f "${RESTART_OUT}"
unset FAIL_RESTART_UNITS

# ── BLOCKER 2, end to end: a `set -e` caller must run PAST a failed restart. ──
: > "${ACTIVE_UNITS_FILE}"
printf 'cortex@work\n' >> "${ACTIVE_UNITS_FILE}"
export FAIL_RESTART_UNITS="cortex@work"
SETE_RESTART_OUT="$(mktemp)"
set +e
bash -c "set -e; source '${SCRIPT_DIR}/lib/systemd-render.sh'; restart_running_systemd_stacks '${CONFIG_DIR}'; echo SCRIPT_COMPLETED" > "${SETE_RESTART_OUT}" 2>&1
SETE_RESTART_RC=$?
set -e
assert_eq "a 'set -e' caller completes (exit 0) despite the failed restart" "0" "${SETE_RESTART_RC}"
assert_grep_file "the caller ran past the guarded restart call" "${SETE_RESTART_OUT}" "SCRIPT_COMPLETED"
rm -f "${SETE_RESTART_OUT}"
unset FAIL_RESTART_UNITS
: > "${ACTIVE_UNITS_FILE}"

# ─── Section 9: run_with_timeout ───────────────────────────────────
printf '\n=== run_with_timeout ===\n'

# Normal path: the real `timeout` (present on this dev box / any Ubuntu CI
# runner via coreutils) transparently wraps the call.
assert_eq "wraps a successful command through the real timeout binary" "hello" \
  "$(run_with_timeout echo hello)"

# Degrade path: PATH with no `timeout` on it at all → falls back to a bare
# call. `echo` is a shell builtin so it needs no PATH resolution, isolating
# this case to exactly the `command -v timeout` branch under test.
assert_eq "degrades to a bare call when timeout is absent from PATH" "hi" \
  "$(PATH="${MOCK_BIN}" run_with_timeout echo hi)"

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
