#!/bin/bash
# cortex#2093 (L1 rollback, closing the gap cortex#2071 left open) — unit
# tests for scripts/lib/systemd-remove.sh: marker-guarded file deletion
# (unmarked files survive byte-identical), instance disable ordering
# (disabled/stopped BEFORE any file is deleted), the Darwin/systemd-less
# no-ops, daemon-reload-only-on-change, and `set -e` survival of a failing
# systemctl call.
#
# Tests run entirely in a scratch $HOME; no live ~/.config/systemd/user or
# systemctl/loginctl is touched — both are mocked via PATH override, same
# pattern as scripts/__tests__/systemd-render.sh. `uname` is ALSO mocked so
# the Linux-only remove path is exercised regardless of the host actually
# running this suite.
#
# Run:
#   bash scripts/__tests__/systemd-remove.sh
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

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -e "${path}" ]; then pass "${label}"; else fail "${label}: still present: ${path}"; fi
}

assert_grep_file() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "${needle}" "${file}"; then pass "${label}"; else fail "${label}"; fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TMPHOME="$(mktemp -d)"
trap 'rm -rf "${TMPHOME}"' EXIT
export HOME="${TMPHOME}"

# Source AFTER HOME is set — same convention as systemd-render.sh's suite.
# shellcheck source=scripts/lib/systemd-remove.sh
source "${SCRIPT_DIR}/lib/systemd-remove.sh"

MARKER="# rendered-by: cortex systemd-render v1"

# Mock bin dir: uname (force "Linux"), systemctl (trace log + controllable
# disable/daemon-reload failure injection). `timeout` itself is NOT mocked —
# same rationale as systemd-render.sh's suite.
MOCK_BIN="${TMPHOME}/mock-bin"
mkdir -p "${MOCK_BIN}"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF
chmod +x "${MOCK_BIN}/uname"

export SYSTEMCTL_LOG="${TMPHOME}/systemctl.log"
# FAIL_DISABLE_UNITS="unit1 unit2" → `disable --now <unit>` exits 1 iff <unit> is listed
# (simulates "not loaded"/"not found" — the tolerate-and-log-per-unit case).
# FAIL_DAEMON_RELOAD=1 → `daemon-reload` exits 1 (simulates a wedged/unavailable bus).
cat > "${MOCK_BIN}/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"
if [ "$1" = "--user" ] && [ "$2" = "disable" ] && [ "$3" = "--now" ]; then
  unit="$4"
  for u in ${FAIL_DISABLE_UNITS:-}; do
    [ "$u" = "$unit" ] && exit 1
  done
  exit 0
fi
if [ "$1" = "--user" ] && [ "$2" = "daemon-reload" ]; then
  [ "${FAIL_DAEMON_RELOAD:-0}" = "1" ] && exit 1
  exit 0
fi
exit 0
EOF
chmod +x "${MOCK_BIN}/systemctl"

export PATH="${MOCK_BIN}:${PATH}"

reset_unit_dir() {
  UNIT_DIR="${TMPHOME}/unit-dir"
  rm -rf "${UNIT_DIR}"
  mkdir -p "${UNIT_DIR}"
}

render_marked_units() {
  { printf '%s\n' "${MARKER}"; printf '[Unit]\nDescription=nats template\n'; } > "${UNIT_DIR}/nats@.service"
  { printf '%s\n' "${MARKER}"; printf '[Unit]\nDescription=cortex template\n'; } > "${UNIT_DIR}/cortex@.service"
}

# Config-dir fixture with two discoverable stacks (same shape systemd-
# render.sh's suite uses — dir-layout marker <slug>/system/system.yaml).
CONFIG_DIR="${TMPHOME}/config"
mkdir -p "${CONFIG_DIR}/work/system" "${CONFIG_DIR}/halden/system"
: > "${CONFIG_DIR}/work/work.yaml"
: > "${CONFIG_DIR}/work/system/system.yaml"
: > "${CONFIG_DIR}/halden/halden.yaml"
: > "${CONFIG_DIR}/halden/system/system.yaml"

EMPTY_CONFIG_DIR="${TMPHOME}/empty-config"
mkdir -p "${EMPTY_CONFIG_DIR}"

export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"
mkdir -p "${SYSTEMD_HOST_MARKER}"

# ─── Section 1: disable_cortex_systemd_instances ──────────────────
printf '\n=== disable_cortex_systemd_instances ===\n'

: > "${SYSTEMCTL_LOG}"
DISABLE_OUT="$(disable_cortex_systemd_instances "${CONFIG_DIR}")"
assert_eq "both stacks' cortex@ instances disabled" "2" \
  "$(grep -c '^systemctl --user disable --now cortex@' "${SYSTEMCTL_LOG}")"
assert_eq "both stacks' nats@ instances disabled" "2" \
  "$(grep -c '^systemctl --user disable --now nats@' "${SYSTEMCTL_LOG}")"
assert_eq "cortex@work is disabled" "1" \
  "$(grep -c '^systemctl --user disable --now cortex@work$' "${SYSTEMCTL_LOG}")"
assert_eq "cortex@halden is disabled" "1" \
  "$(grep -c '^systemctl --user disable --now cortex@halden$' "${SYSTEMCTL_LOG}")"
if printf '%s' "${DISABLE_OUT}" | grep -qF "cortex@work disabled"; then
  pass "disable success is logged"
else
  fail "disable success is logged"
fi

# Tolerate not-loaded/not-found: one unit fails, the others still proceed and
# are logged individually — never a single all-or-nothing failure.
export FAIL_DISABLE_UNITS="cortex@halden"
: > "${SYSTEMCTL_LOG}"
set +e
DISABLE_OUT2="$(disable_cortex_systemd_instances "${CONFIG_DIR}")"
DISABLE_RC=$?
set -e
assert_eq "a not-loaded unit does not abort the loop" "0" "${DISABLE_RC}"
assert_grep_file "the not-loaded unit is logged per-unit, not silently swallowed" \
  <(printf '%s' "${DISABLE_OUT2}") "cortex@halden not loaded/not found"
assert_eq "nats@halden is still attempted despite cortex@halden failing" "1" \
  "$(grep -c '^systemctl --user disable --now nats@halden$' "${SYSTEMCTL_LOG}")"
assert_eq "the OTHER stack (work) is still disabled" "1" \
  "$(grep -c '^systemctl --user disable --now cortex@work$' "${SYSTEMCTL_LOG}")"
unset FAIL_DISABLE_UNITS

# `set -e` caller survival (mirrors preremove.sh's own shebang).
export FAIL_DISABLE_UNITS="cortex@work nats@work cortex@halden nats@halden"
SETE_OUT="$(mktemp)"
set +e
bash -c "set -e; source '${SCRIPT_DIR}/lib/systemd-remove.sh'; disable_cortex_systemd_instances '${CONFIG_DIR}'; echo SCRIPT_COMPLETED" > "${SETE_OUT}" 2>&1
SETE_RC=$?
set -e
assert_eq "a 'set -e' caller completes despite every disable failing" "0" "${SETE_RC}"
assert_grep_file "the caller ran past every guarded disable call" "${SETE_OUT}" "SCRIPT_COMPLETED"
rm -f "${SETE_OUT}"
unset FAIL_DISABLE_UNITS

# No discoverable stacks → clean no-op.
: > "${SYSTEMCTL_LOG}"
assert_true "no stacks → clean no-op" disable_cortex_systemd_instances "${EMPTY_CONFIG_DIR}"
assert_eq "no stacks → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"

# ─── Section 2: remove_cortex_systemd_unit_files — marker guard ───
printf '\n=== remove_cortex_systemd_unit_files ===\n'

reset_unit_dir
render_marked_units
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_unit_files "${UNIT_DIR}"
assert_file_missing "marked nats@.service removed" "${UNIT_DIR}/nats@.service"
assert_file_missing "marked cortex@.service removed" "${UNIT_DIR}/cortex@.service"
assert_eq "two files removed → exactly 1 daemon-reload call" "1" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}")"

# Nothing to remove → zero daemon-reload calls.
reset_unit_dir
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_unit_files "${UNIT_DIR}"
assert_eq "no files present → zero daemon-reload calls" "0" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}" || true)"

# Hand-authored-unit protection (mirrors systemd-render.sh's own regression
# guard): a dst WITHOUT the marker must survive byte-identical, and must NOT
# count toward the reload-gating change counter.
reset_unit_dir
HAND_REF="$(mktemp)"
cat > "${HAND_REF}" <<'EOF'
[Unit]
Description=My own hand-authored cortex unit, please do not touch
EOF
cp "${HAND_REF}" "${UNIT_DIR}/cortex@.service"
: > "${SYSTEMCTL_LOG}"
HAND_WARN="$(mktemp)"
remove_cortex_systemd_unit_files "${UNIT_DIR}" 2>"${HAND_WARN}"
assert_true "hand-authored dst is byte-identical after remove (never touched)" \
  cmp -s "${HAND_REF}" "${UNIT_DIR}/cortex@.service"
assert_grep_file "hand-authored dst → warns it was left untouched" "${HAND_WARN}" \
  "exists without the cortex systemd-render marker"
assert_eq "hand-authored-only dst → zero daemon-reload calls (nothing this fn owns changed)" "0" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}" || true)"
rm -f "${HAND_WARN}" "${HAND_REF}"

# Mixed: one marked (removed), one hand-authored (untouched) — still exactly
# one reload, gated on the marked file actually changing.
reset_unit_dir
render_marked_units
cat > "${UNIT_DIR}/cortex@.service" <<'EOF'
[Unit]
Description=hand-authored, no marker
EOF
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_unit_files "${UNIT_DIR}"
assert_file_missing "marked nats@.service removed" "${UNIT_DIR}/nats@.service"
assert_file_exists "unmarked cortex@.service survives" "${UNIT_DIR}/cortex@.service"
assert_eq "mixed marked/unmarked → exactly 1 daemon-reload call (for the one real change)" "1" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}")"

# A failing daemon-reload must not abort the caller (mirrors systemd-render's
# BLOCKER 2 guard on the render side).
reset_unit_dir
render_marked_units
export FAIL_DAEMON_RELOAD=1
RELOAD_ERR="$(mktemp)"
set +e
remove_cortex_systemd_unit_files "${UNIT_DIR}" 2>"${RELOAD_ERR}"
RELOAD_RC=$?
set -e
assert_eq "remove_cortex_systemd_unit_files returns 0 even when daemon-reload fails" "0" "${RELOAD_RC}"
assert_grep_file "failing daemon-reload is warned, not silently swallowed" "${RELOAD_ERR}" \
  "daemon-reload failed"
assert_file_missing "units were still removed despite the reload failure" "${UNIT_DIR}/cortex@.service"
rm -f "${RELOAD_ERR}"
unset FAIL_DAEMON_RELOAD

# ─── Section 3: remove_cortex_systemd_units — orchestration + ordering ─
printf '\n=== remove_cortex_systemd_units (orchestration) ===\n'

# Darwin → no-op, nothing touched, zero systemctl calls.
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Darwin"
EOF
reset_unit_dir
render_marked_units
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
assert_file_exists "Darwin → nats@.service left untouched" "${UNIT_DIR}/nats@.service"
assert_file_exists "Darwin → cortex@.service left untouched" "${UNIT_DIR}/cortex@.service"
assert_eq "Darwin → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF

# systemd-less Linux host → no-op.
export SYSTEMD_HOST_MARKER="${TMPHOME}/no-such-run-systemd-system"
rm -rf "${HOME}/.config/systemd/user"
reset_unit_dir
render_marked_units
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
assert_file_exists "systemd-less Linux → nats@.service left untouched" "${UNIT_DIR}/nats@.service"
assert_eq "systemd-less Linux → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"
export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"
mkdir -p "${SYSTEMD_HOST_MARKER}"

# Real systemd Linux host, marked units + live-looking stacks → instances
# disabled BEFORE any file is deleted (ordering is the acceptance criterion),
# both files removed, exactly one reload.
reset_unit_dir
render_marked_units
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
assert_file_missing "cortex@.service removed" "${UNIT_DIR}/cortex@.service"
assert_file_missing "nats@.service removed" "${UNIT_DIR}/nats@.service"
assert_eq "exactly one daemon-reload" "1" \
  "$(grep -c '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}")"
# Ordering: every disable line must appear BEFORE the daemon-reload line —
# i.e. instances are stopped before the template files (and the reload that
# follows their removal) happen.
LAST_DISABLE_LINE=$(grep -n '^systemctl --user disable --now' "${SYSTEMCTL_LOG}" | tail -1 | cut -d: -f1)
RELOAD_LINE=$(grep -n '^systemctl --user daemon-reload$' "${SYSTEMCTL_LOG}" | head -1 | cut -d: -f1)
if [ "${LAST_DISABLE_LINE}" -lt "${RELOAD_LINE}" ]; then
  pass "every instance is disabled before the daemon-reload that follows file removal"
else
  fail "instance disable did not precede file removal/reload"
fi

# Full user-authored-survives-byte-identical acceptance check.
reset_unit_dir
HAND_REF2="$(mktemp)"
cat > "${HAND_REF2}" <<'EOF'
[Unit]
Description=principal's hand-authored cortex@.service, predates the renderer
EOF
cp "${HAND_REF2}" "${UNIT_DIR}/cortex@.service"
: > "${SYSTEMCTL_LOG}"
remove_cortex_systemd_units "${UNIT_DIR}" "${CONFIG_DIR}"
assert_true "hand-authored unit survives full remove_cortex_systemd_units, byte-identical" \
  cmp -s "${HAND_REF2}" "${UNIT_DIR}/cortex@.service"
rm -f "${HAND_REF2}"

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
