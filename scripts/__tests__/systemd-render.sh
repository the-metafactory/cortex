#!/bin/bash
# cortex#2071 (L1, Linux host support) — unit tests for scripts/lib/systemd-render.sh:
# marker-header idempotency, daemon-reload-only-on-change, the Darwin/
# systemd-less no-ops, the bin-symlink + linger warnings, and the
# restart-only-if-active loop.
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
# suite executes on), systemctl (trace log + controllable is-active), and
# loginctl (controllable Linger value).
MOCK_BIN="${TMPHOME}/mock-bin"
mkdir -p "${MOCK_BIN}"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF
chmod +x "${MOCK_BIN}/uname"

export SYSTEMCTL_LOG="${TMPHOME}/systemctl.log"
# ACTIVE_UNITS: newline-separated unit names `systemctl --user is-active
# --quiet <unit>` should report active (exit 0) for; anything else exits 1.
export ACTIVE_UNITS_FILE="${TMPHOME}/active-units"
: > "${ACTIVE_UNITS_FILE}"
cat > "${MOCK_BIN}/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"
# is-active --quiet <unit>: exit 0 iff <unit> is listed in ACTIVE_UNITS_FILE.
if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then
  unit="$4"
  grep -qxF "${unit}" "${ACTIVE_UNITS_FILE:-/dev/null}" && exit 0
  exit 1
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
assert_grep_file "WorkingDirectory line present (workspace addendum, cortex#2097)" \
  "${UNIT_DIR}/cortex@.service" 'WorkingDirectory=%h/.local/share/metafactory/cortex/%i/workspace'
# NO matching ExecStartPre mkdir line for the workspace dir: verified against a
# real systemd 257 user session that WorkingDirectory= is entered before ANY
# exec command (including ExecStartPre) runs, so that line could never have
# self-healed a missing workspace dir (EXIT_CHDIR before it could run) — it
# was removed in favor of ensure_stack_workspace_dirs (render-time, slug-aware,
# actually able to create the directory before systemd ever tries to chdir
# into it). The logs ExecStartPre line stays (belt-and-braces re-creation).
assert_false "dead workspace ExecStartPre line NOT present (removed, cortex#2071 PR fixup)" \
  bash -c "grep -qF 'ExecStartPre=/usr/bin/mkdir -p %h/.local/share/metafactory/cortex/%i/workspace' '${UNIT_DIR}/cortex@.service'"

# Re-render with IDENTICAL content → no-op, change count NOT bumped again.
render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service"
assert_eq "unchanged re-render → change count stays 1" "1" "${SYSTEMD_RENDER_CHANGE_COUNT}"

# A hand-edited (drifted) dst → next render overwrites and bumps the count.
printf 'stale hand-edit\n' > "${UNIT_DIR}/cortex@.service"
render_systemd_unit "${CORTEX_DIR}/src/services/cortex@.service" "${UNIT_DIR}/cortex@.service"
assert_eq "drifted dst → re-rendered, change count bumps to 2" "2" "${SYSTEMD_RENDER_CHANGE_COUNT}"
assert_eq "drifted dst → marker restored as line 1" "# rendered-by: cortex systemd-render v1" \
  "$(sed -n '1p' "${UNIT_DIR}/cortex@.service")"

# Missing template source → warns, returns non-zero, nothing written.
reset_unit_dir
mkdir -p "${UNIT_DIR}"
assert_false "missing template source → non-zero" \
  render_systemd_unit "${CORTEX_DIR}/src/services/does-not-exist.service" "${UNIT_DIR}/does-not-exist.service"
assert_false "missing template source → nothing written" \
  test -e "${UNIT_DIR}/does-not-exist.service"

# ─── Section 3: render_cortex_systemd_units — orchestration ───────
printf '\n=== render_cortex_systemd_units ===\n'

# Config-dir fixture with two discoverable stacks — used both for the
# workspace-dir-creation assertions below and for Section 6's restart tests.
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
# daemon-reload call (not one per unit), AND both discovered stacks' workspace
# dirs exist (cortex@.service's WorkingDirectory= must pre-exist before
# enable/start — see ensure_stack_workspace_dirs's docstring; verified against
# a real systemd 257 user session, not just asserted here).
reset_unit_dir
rm -rf "${HOME}/.local/share/metafactory/cortex"
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_file_exists "nats@.service rendered" "${UNIT_DIR}/nats@.service"
assert_file_exists "cortex@.service rendered" "${UNIT_DIR}/cortex@.service"
assert_eq "fresh render (2 units changed) → exactly 1 daemon-reload call" "1" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}")"
assert_true "render also creates 'work' stack's workspace dir" \
  test -d "${HOME}/.local/share/metafactory/cortex/work/workspace"
assert_true "render also creates 'halden' stack's workspace dir" \
  test -d "${HOME}/.local/share/metafactory/cortex/halden/workspace"

# Re-render with nothing changed → zero daemon-reload calls (workspace-dir
# creation is idempotent — mkdir -p on an existing dir is a no-op).
: > "${SYSTEMCTL_LOG}"
render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
assert_eq "no-op re-render → zero daemon-reload calls" "0" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}" || true)"

# ─── Section 3b: ensure_stack_workspace_dirs (standalone) ─────────
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

# ─── Section 4: verify_cortex_bin_symlink ─────────────────────────
printf '\n=== verify_cortex_bin_symlink ===\n'

rm -rf "${HOME}/.local/bin"
mkdir -p "${HOME}/.local/bin"
assert_false "missing ~/.local/bin/cortex → warns, non-zero" verify_cortex_bin_symlink

mkdir -p "${HOME}/.local/bin"
printf '#!/bin/sh\n' > "${HOME}/.local/bin/cortex"
assert_true "present ~/.local/bin/cortex → passes" verify_cortex_bin_symlink

# ─── Section 5: warn_systemd_linger ───────────────────────────────
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

# ─── Section 6: restart_running_systemd_stacks ────────────────────
printf '\n=== restart_running_systemd_stacks ===\n'

# Reuses the CONFIG_DIR fixture (work + halden stacks) set up before Section 3.

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

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
