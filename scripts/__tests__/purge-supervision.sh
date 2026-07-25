#!/bin/bash
# cortex#2338 — unit tests for scripts/lib/purge-supervision.sh: the
# `scripts.purge` supervisor sweep (systemd unit-glob disable, launchd
# LaunchAgents filename-glob bootout+remove), and the platform no-ops.
#
# Tests run entirely in a scratch $HOME; no live ~/Library/LaunchAgents,
# ~/.config/systemd/user, systemctl, or launchctl is touched — all mocked via
# PATH override / an injected LAUNCH_DIR arg, same pattern as
# scripts/__tests__/systemd-remove.sh. `uname` is ALSO mocked so both the
# Linux and Darwin paths are exercised regardless of the host actually
# running this suite.
#
# The critical property under test (cortex#2338's whole reason for existing):
# BOTH functions must clean up WITHOUT reading a cortex config dir — neither
# function is ever passed one, and purge_launchd_instances is proven to find
# plists via a LaunchAgents dir that has no cortex config dir anywhere near
# it.
#
# Run:
#   bash scripts/__tests__/purge-supervision.sh
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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "${path}" ]; then pass "${label}"; else fail "${label}: not found: ${path}"; fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -e "${path}" ]; then pass "${label}"; else fail "${label}: still present: ${path}"; fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TMPHOME="$(mktemp -d)"
trap 'rm -rf "${TMPHOME}"' EXIT
export HOME="${TMPHOME}"

MOCK_BIN="${TMPHOME}/mock-bin"
mkdir -p "${MOCK_BIN}"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF
chmod +x "${MOCK_BIN}/uname"

export SYSTEMCTL_LOG="${TMPHOME}/systemctl.log"
# FAIL_DISABLE=1 → the glob disable call itself exits 1 (simulates "no
# matching units" — systemctl's own behavior when a glob matches nothing).
cat > "${MOCK_BIN}/systemctl" <<'EOF'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"
if [ "$1" = "--user" ] && [ "$2" = "disable" ] && [ "$3" = "--now" ]; then
  [ "${FAIL_DISABLE:-0}" = "1" ] && exit 1
  exit 0
fi
exit 0
EOF
chmod +x "${MOCK_BIN}/systemctl"

export LAUNCHCTL_LOG="${TMPHOME}/launchctl.log"
cat > "${MOCK_BIN}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${LAUNCHCTL_LOG:-/dev/null}"
exit 0
EOF
chmod +x "${MOCK_BIN}/launchctl"

export PATH="${MOCK_BIN}:${PATH}"

# Source AFTER HOME/PATH are set — same convention as systemd-remove.sh's
# suite. Deliberately: source only purge-supervision.sh (which itself sources
# systemd-render.sh) — never a cortex config dir fixture anywhere in this
# suite, proving neither function needs one.
# shellcheck source=scripts/lib/purge-supervision.sh
source "${SCRIPT_DIR}/lib/purge-supervision.sh"

export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"
mkdir -p "${SYSTEMD_HOST_MARKER}"

LAUNCH_DIR="${TMPHOME}/LaunchAgents"

reset_launch_dir() {
  rm -rf "${LAUNCH_DIR}"
  mkdir -p "${LAUNCH_DIR}"
}

# ─── Section 1: purge_systemd_instances ────────────────────────────
printf '\n=== purge_systemd_instances ===\n'

: > "${SYSTEMCTL_LOG}"
purge_systemd_instances
assert_eq "exactly one glob disable call" "1" \
  "$(grep -c '^systemctl --user disable --now' "${SYSTEMCTL_LOG}")"
assert_eq "the call globs cortex@* and nats@* together" "1" \
  "$(grep -Fc "systemctl --user disable --now cortex@* nats@*" "${SYSTEMCTL_LOG}")"

# `set -e` caller survival even when the glob call fails (e.g. "no matching
# units" — systemctl exits non-zero on an empty glob match).
export FAIL_DISABLE=1
: > "${SYSTEMCTL_LOG}"
SETE_OUT="$(mktemp)"
set +e
bash -c "set -e; source '${SCRIPT_DIR}/lib/purge-supervision.sh'; purge_systemd_instances; echo SCRIPT_COMPLETED" > "${SETE_OUT}" 2>&1
SETE_RC=$?
set -e
assert_eq "a 'set -e' caller completes despite the glob disable failing" "0" "${SETE_RC}"
assert_true "the caller ran past the guarded call" grep -qF "SCRIPT_COMPLETED" "${SETE_OUT}"
rm -f "${SETE_OUT}"
unset FAIL_DISABLE

# Darwin → no-op, zero systemctl calls.
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Darwin"
EOF
: > "${SYSTEMCTL_LOG}"
purge_systemd_instances
assert_eq "Darwin → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF

# systemd-less Linux host → no-op.
export SYSTEMD_HOST_MARKER="${TMPHOME}/no-such-run-systemd-system"
rm -rf "${HOME}/.config/systemd/user"
: > "${SYSTEMCTL_LOG}"
purge_systemd_instances
assert_eq "systemd-less Linux → zero systemctl calls" "0" "$(wc -l < "${SYSTEMCTL_LOG}" | tr -d ' ')"
export SYSTEMD_HOST_MARKER="${TMPHOME}/fake-run-systemd-system"
mkdir -p "${SYSTEMD_HOST_MARKER}"

# ─── Section 2: purge_launchd_instances ────────────────────────────
printf '\n=== purge_launchd_instances ===\n'

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Darwin"
EOF

reset_launch_dir
: > "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"
: > "${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"
: > "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
: > "${LAUNCH_DIR}/ai.meta-factory.nats.work.plist"
: > "${LAUNCH_DIR}/ai.meta-factory.nats.halden.plist"
: > "${LAUNCH_DIR}/some.unrelated.app.plist"
: > "${LAUNCHCTL_LOG}"
purge_launchd_instances "${LAUNCH_DIR}"
assert_file_missing "cortex work plist removed" "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"
assert_file_missing "cortex halden plist removed" "${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"
assert_file_missing "relay plist removed (matches the cortex.* glob)" "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
assert_file_missing "nats work plist removed" "${LAUNCH_DIR}/ai.meta-factory.nats.work.plist"
assert_file_missing "nats halden plist removed" "${LAUNCH_DIR}/ai.meta-factory.nats.halden.plist"
assert_file_exists "an unrelated plist is left untouched" "${LAUNCH_DIR}/some.unrelated.app.plist"
assert_eq "five bootout calls (one per cortex/nats plist)" "5" \
  "$(grep -c '^launchctl bootout' "${LAUNCHCTL_LOG}")"
assert_true "bootout is never called for the unrelated plist" \
  bash -c "! grep -qF 'some.unrelated.app.plist' '${LAUNCHCTL_LOG}'"

# No matching plists → clean no-op, zero launchctl calls.
reset_launch_dir
: > "${LAUNCH_DIR}/some.unrelated.app.plist"
: > "${LAUNCHCTL_LOG}"
purge_launchd_instances "${LAUNCH_DIR}"
assert_eq "no matching plists → zero launchctl calls" "0" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"
assert_file_exists "the unrelated plist still untouched" "${LAUNCH_DIR}/some.unrelated.app.plist"

# Missing LaunchAgents dir entirely → clean no-op, never mkdir's it.
NO_SUCH_DIR="${TMPHOME}/does-not-exist-LaunchAgents"
: > "${LAUNCHCTL_LOG}"
purge_launchd_instances "${NO_SUCH_DIR}"
assert_eq "missing LaunchAgents dir → zero launchctl calls" "0" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"
assert_file_missing "missing LaunchAgents dir is never created" "${NO_SUCH_DIR}"

# Linux → no-op regardless of LAUNCH_DIR contents (never touches launchctl).
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/bin/sh
echo "Linux"
EOF
reset_launch_dir
: > "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"
: > "${LAUNCHCTL_LOG}"
purge_launchd_instances "${LAUNCH_DIR}"
assert_eq "Linux → zero launchctl calls" "0" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"
assert_file_exists "Linux → plist left untouched" "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"

# ─── Section 3: report_intentionally_kept_shared_state (cortex#2420) ─
printf '\n=== report_intentionally_kept_shared_state ===\n'

REPORT_HOME="${TMPHOME}/report-home"

# All three shared dirs present → each is named as KEPT, with the "on purpose"
# footer and NO "none present" line.
rm -rf "${REPORT_HOME}"
mkdir -p "${REPORT_HOME}/.claude/events" "${REPORT_HOME}/.claude/relay" "${REPORT_HOME}/.config/nats"
REPORT_OUT="$(report_intentionally_kept_shared_state "${REPORT_HOME}")"
assert_true "names ~/.claude/events as kept" \
  grep -qF "${REPORT_HOME}/.claude/events" <<<"${REPORT_OUT}"
assert_true "names ~/.claude/relay as kept" \
  grep -qF "${REPORT_HOME}/.claude/relay" <<<"${REPORT_OUT}"
assert_true "names ~/.config/nats as kept" \
  grep -qF "${REPORT_HOME}/.config/nats" <<<"${REPORT_OUT}"
assert_true "prints the intentionally-KEPT header" \
  grep -qF "Intentionally KEPT" <<<"${REPORT_OUT}"
assert_true "prints the on-purpose footer when dirs are present" \
  grep -qF "Left in place on purpose" <<<"${REPORT_OUT}"
assert_true "no 'none present' line when dirs exist" \
  bash -c "! grep -qF 'none of the shared dirs' <<<\"\${1}\"" _ "${REPORT_OUT}"

# Only one of the three present → only that one is named; the absent two are
# silently skipped (report only reflects reality on this host).
rm -rf "${REPORT_HOME}"
mkdir -p "${REPORT_HOME}/.claude/events"
REPORT_OUT="$(report_intentionally_kept_shared_state "${REPORT_HOME}")"
assert_true "names the one present dir" \
  grep -qF "${REPORT_HOME}/.claude/events" <<<"${REPORT_OUT}"
assert_true "does NOT name an absent dir (relay)" \
  bash -c "! grep -qF '.claude/relay' <<<\"\${1}\"" _ "${REPORT_OUT}"

# None present → the "nothing kept" line, and NO bullet paths.
rm -rf "${REPORT_HOME}"
mkdir -p "${REPORT_HOME}"
REPORT_OUT="$(report_intentionally_kept_shared_state "${REPORT_HOME}")"
assert_true "prints the 'none present' line when no shared dir exists" \
  grep -qF "none of the shared dirs are present" <<<"${REPORT_OUT}"
assert_true "prints no bullet path when nothing is kept" \
  bash -c "! grep -qF '    • ' <<<\"\${1}\"" _ "${REPORT_OUT}"

# A `set -e` caller survives the report call (best-effort, never aborts purge).
REPORT_SETE_OUT="$(mktemp)"
set +e
bash -c "set -e; source '${SCRIPT_DIR}/lib/purge-supervision.sh'; report_intentionally_kept_shared_state '${REPORT_HOME}'; echo REPORT_COMPLETED" > "${REPORT_SETE_OUT}" 2>&1
REPORT_SETE_RC=$?
set -e
assert_eq "a 'set -e' caller completes past the report call" "0" "${REPORT_SETE_RC}"
assert_true "the caller ran past the report call" grep -qF "REPORT_COMPLETED" "${REPORT_SETE_OUT}"
rm -f "${REPORT_SETE_OUT}"

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
