#!/bin/bash
# cortex#1866 (XDG wave 3) — unit tests for the bin-cutover T13 safety
# mechanisms in plist-render.sh: forward_link_legacy_bin (the ~/bin →
# ~/.local/bin forward-symlink bridge) and reload_plist (bootout+bootstrap).
#
# These are the exact mechanisms that keep an in-place upgrade from bricking a
# live fleet, so they get direct coverage. Tests run entirely in a scratch
# $HOME; no live ~/bin, ~/.local/bin, or launchctl is touched (launchctl is
# mocked via PATH override, same pattern as plist-render-stack-discovery.sh).
#
# Run:
#   bash scripts/__tests__/plist-render-bin-cutover.sh
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

assert_symlink_to() {
  local label="$1" link="$2" expected_target="$3"
  if [ -L "${link}" ] && [ "$(readlink "${link}")" = "${expected_target}" ]; then
    pass "${label}"
  else
    fail "${label}: ${link} is not a symlink → ${expected_target} (got «$(readlink "${link}" 2>/dev/null || echo NONE)»)"
  fi
}

assert_true() {
  local label="$1"; shift
  if "$@"; then pass "${label}"; else fail "${label}"; fi
}

# assert_grep_file LABEL FILE FIXED_STRING — pass iff FIXED_STRING (a literal,
# -F) occurs in FILE. Greps a file rather than re-parsing captured output
# through `bash -c`, so backticks in the captured text can never be
# command-substituted (the mandated refuse message contains backticks).
assert_grep_file() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "${needle}" "${file}"; then pass "${label}"; else fail "${label}"; fi
}

assert_false() {
  local label="$1"; shift
  if "$@"; then fail "${label}"; else pass "${label}"; fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Scratch $HOME — every ~/bin and ~/.local/bin reference in the functions
# resolves under here, so the real home is never touched.
TMPHOME="$(mktemp -d)"
trap 'rm -rf "${TMPHOME}"' EXIT
export HOME="${TMPHOME}"

# Source AFTER HOME is set (the functions read ${HOME} at call time, so this
# ordering does not actually matter, but keep it explicit).
source "${SCRIPT_DIR}/lib/plist-render.sh"

# Mock launchctl: emit a trace line per call so reload_plist ordering can be
# asserted. LAUNCHCTL_LOG is exported so the mock subprocess inherits it.
MOCK_BIN="${TMPHOME}/mock-bin"
mkdir -p "${MOCK_BIN}"
export LAUNCHCTL_LOG="${TMPHOME}/launchctl.log"
cat > "${MOCK_BIN}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${LAUNCHCTL_LOG:-/dev/null}"
EOF
chmod +x "${MOCK_BIN}/launchctl"
export PATH="${MOCK_BIN}:${PATH}"

# Reset ~/bin + ~/.local/bin to a clean slate between cases. Both dirs are
# created empty so a case can pre-seed a legacy ~/bin entry before calling the
# function (the function also mkdir -p's ~/bin itself; an empty ~/bin is not a
# "legacy entry").
reset_home_bins() {
  # ${HOME:?} guards against an empty HOME ever expanding rm -rf to /bin
  # (SC2115); HOME is the mktemp scratch dir set above, but belt-and-braces.
  rm -rf "${HOME:?}/bin" "${HOME:?}/.local/bin"
  mkdir -p "${HOME}/bin" "${HOME}/.local/bin"
}

# ─── Section 1: forward_link_legacy_bin ───────────────────────────
printf '\n=== forward_link_legacy_bin ===\n'

# Case A — target exists, no legacy link → forward-symlink created.
reset_home_bins
printf '#!/bin/sh\n' > "${HOME}/.local/bin/cortex"
forward_link_legacy_bin cortex
assert_symlink_to "A: fresh → forward-symlink to target" \
  "${HOME}/bin/cortex" "${HOME}/.local/bin/cortex"

# Case B — a stale symlink at the legacy path is repointed, no sidecar.
reset_home_bins
printf '#!/bin/sh\n' > "${HOME}/.local/bin/cortex"
ln -sfn "/some/old/target" "${HOME}/bin/cortex"
forward_link_legacy_bin cortex
assert_symlink_to "B: stale symlink repointed" \
  "${HOME}/bin/cortex" "${HOME}/.local/bin/cortex"
assert_false "B: no sidecar left for a replaced symlink" \
  test -e "${HOME}/bin/cortex.pre-arc"

# Case C — a real regular file at the legacy path is backed up to .pre-arc,
# its contents preserved, and the link created over the vacated path.
reset_home_bins
printf '#!/bin/sh\n' > "${HOME}/.local/bin/cortex"
printf 'seed data\n' > "${HOME}/bin/cortex"
forward_link_legacy_bin cortex
assert_symlink_to "C: regular file → now a forward-symlink" \
  "${HOME}/bin/cortex" "${HOME}/.local/bin/cortex"
assert_eq "C: seed data preserved in .pre-arc sidecar" \
  "seed data" "$(cat "${HOME}/bin/cortex.pre-arc")"

# Case C2 — a SECOND regular-file conflict must NOT clobber the first backup.
# (data-loss hardening: new backup lands at .pre-arc.<epoch>[.n]).
rm -f "${HOME}/bin/cortex"                 # drop the symlink from case C
printf 'seed data TWO\n' > "${HOME}/bin/cortex"
forward_link_legacy_bin cortex
assert_eq "C2: first backup intact (not clobbered)" \
  "seed data" "$(cat "${HOME}/bin/cortex.pre-arc")"
# Exactly one timestamped sidecar exists, holding the second file.
mapfile -t STAMPED < <(find "${HOME}/bin" -maxdepth 1 -name 'cortex.pre-arc.*' | sort)
assert_eq "C2: one timestamped sidecar created" "1" "${#STAMPED[@]}"
if [ "${#STAMPED[@]}" -eq 1 ]; then
  assert_eq "C2: second file preserved at timestamped sidecar" \
    "seed data TWO" "$(cat "${STAMPED[0]}")"
fi
assert_symlink_to "C2: link is the forward-symlink" \
  "${HOME}/bin/cortex" "${HOME}/.local/bin/cortex"

# Case D — target missing → no-op, no dangling forward-symlink.
reset_home_bins
# note: ~/.local/bin/cldyo-live intentionally absent
forward_link_legacy_bin cldyo-live
assert_false "D: no dangling forward-symlink when target absent" \
  test -e "${HOME}/bin/cldyo-live"
assert_false "D: not even a broken symlink is created" \
  test -L "${HOME}/bin/cldyo-live"

# ─── Section 2: reload_plist (bootout → bootstrap) ────────────────
printf '\n=== reload_plist ===\n'

# A rendered plist that execs the NEW ~/.local/bin path.
RENDERED_PLIST="${TMPHOME}/ai.meta-factory.cortex.work.plist"
cat > "${RENDERED_PLIST}" <<EOF
<plist><dict>
  <key>ProgramArguments</key>
  <array><string>${HOME}/.local/bin/cortex</string><string>start</string></array>
</dict></plist>
EOF

: > "${LAUNCHCTL_LOG}"
reload_plist "${RENDERED_PLIST}"

# Two calls, in order: bootout THEN bootstrap, both naming the re-rendered plist.
LINE1="$(sed -n '1p' "${LAUNCHCTL_LOG}")"
LINE2="$(sed -n '2p' "${LAUNCHCTL_LOG}")"
assert_true "reload: first call is bootout" \
  bash -c "printf '%s' \"${LINE1}\" | grep -q 'launchctl bootout'"
assert_true "reload: second call is bootstrap" \
  bash -c "printf '%s' \"${LINE2}\" | grep -q 'launchctl bootstrap'"
assert_true "reload: bootstrap targets the re-rendered plist" \
  bash -c "printf '%s' \"${LINE2}\" | grep -qF \"${RENDERED_PLIST}\""
assert_true "reload: bootout targets the same plist" \
  bash -c "printf '%s' \"${LINE1}\" | grep -qF \"${RENDERED_PLIST}\""
assert_eq "reload: exactly two launchctl calls" "2" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"

# Missing plist → no-op (no launchctl invocation at all).
: > "${LAUNCHCTL_LOG}"
reload_plist "${TMPHOME}/does-not-exist.plist"
assert_eq "reload: missing plist → no launchctl calls" "0" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"

# ─── Section 3: arc-version guard (cortex#1866 / arc#295) ─────────
printf '\n=== arc-version guard ===\n'

# Unit — semver comparison (pure bash, no sort -V).
assert_true  "ge: 0.38.0 >= 0.38.0"        arc_version_ge 0.38.0 0.38.0
assert_true  "ge: 0.38.1 >= 0.38.0"        arc_version_ge 0.38.1 0.38.0
assert_true  "ge: 1.0.0  >= 0.38.0"        arc_version_ge 1.0.0  0.38.0
assert_false "ge: 0.37.9 >= 0.38.0"        arc_version_ge 0.37.9 0.38.0
assert_false "ge: 0.9.0  >= 0.38.0"        arc_version_ge 0.9.0  0.38.0
assert_true  "ge: 0.38.0-rc.1 >= 0.38.0 (prerelease core equal)" \
  arc_version_ge 0.38.0-rc.1 0.38.0

# Integration — drive the real preupgrade.sh with a fake `arc` on PATH and
# mocked stop primitives, and assert the guard aborts BEFORE any stop/kill.
PREUP="${SCRIPT_DIR}/preupgrade.sh"

# Build a scratch bin dir that fakes `arc --version` (arg $1) and mocks every
# stop primitive preupgrade might reach (pgrep/kill/launchctl/sleep) so a real
# fleet is never touched. Each stop primitive appends to STOP_LOG; an empty
# STOP_LOG proves nothing was stopped.
make_preupgrade_env() {
  local ver="$1" dir
  dir="$(mktemp -d)"
  cat > "${dir}/arc" <<EOF
#!/bin/sh
[ "\$1" = "--version" ] && echo "arc ${ver}"
exit 0
EOF
  # pgrep: emit nothing (no matching processes) but log that it was consulted.
  cat > "${dir}/pgrep" <<'EOF'
#!/bin/sh
printf 'pgrep %s\n' "$*" >> "${STOP_LOG:-/dev/null}"
exit 1
EOF
  cat > "${dir}/kill" <<'EOF'
#!/bin/sh
printf 'kill %s\n' "$*" >> "${STOP_LOG:-/dev/null}"
EOF
  cat > "${dir}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${STOP_LOG:-/dev/null}"
EOF
  cat > "${dir}/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "${dir}"/arc "${dir}"/pgrep "${dir}"/kill "${dir}"/launchctl "${dir}"/sleep
  printf '%s' "${dir}"
}

# arc too old → exit 1, refuse message on stderr, and NOTHING stopped.
OLD_BIN="$(make_preupgrade_env 0.37.9)"
OLD_HOME="$(mktemp -d)"
STOP_LOG_OLD="$(mktemp)"
GUARD_OUT_FILE="$(mktemp)"
set +e
STOP_LOG="${STOP_LOG_OLD}" HOME="${OLD_HOME}" \
  PATH="${OLD_BIN}:${PATH}" bash "${PREUP}" > "${GUARD_OUT_FILE}" 2>&1
GUARD_CODE=$?
set -e
assert_eq "guard: old arc (0.37.9) → preupgrade exits 1" "1" "${GUARD_CODE}"
assert_grep_file "guard: old arc → refuse message printed" "${GUARD_OUT_FILE}" \
  'cortex bin cutover requires arc >= 0.38.0 (no-throw symlink installer, arc#295).'
assert_grep_file "guard: old arc → self-update remediation printed" "${GUARD_OUT_FILE}" \
  'Run `arc self-update` first, then retry `arc upgrade cortex`.'
assert_eq "guard: old arc → NO stop/kill/unload ran (STOP_LOG empty)" \
  "0" "$(wc -l < "${STOP_LOG_OLD}" | tr -d ' ')"
rm -rf "${OLD_BIN}" "${OLD_HOME}" "${STOP_LOG_OLD}" "${GUARD_OUT_FILE}"

# arc new enough → guard passes; preupgrade proceeds to completion (exit 0).
# Scratch HOME has no stacks + mocked launchctl, so it stops nothing and exits
# cleanly — proving the guard did not abort.
NEW_BIN="$(make_preupgrade_env 0.38.0)"
NEW_HOME="$(mktemp -d)"
mkdir -p "${NEW_HOME}/.config/cortex" "${NEW_HOME}/Library/LaunchAgents"
STOP_LOG_NEW="$(mktemp)"
GOOD_OUT_FILE="$(mktemp)"
set +e
STOP_LOG="${STOP_LOG_NEW}" HOME="${NEW_HOME}" \
  PATH="${NEW_BIN}:${PATH}" bash "${PREUP}" > "${GOOD_OUT_FILE}" 2>&1
GOOD_CODE=$?
set -e
assert_eq "guard: new arc (0.38.0) → preupgrade proceeds (exit 0)" "0" "${GOOD_CODE}"
assert_grep_file "guard: new arc → guard-pass line printed" "${GOOD_OUT_FILE}" \
  'no-throw symlink installer present (arc#295)'
rm -rf "${NEW_BIN}" "${NEW_HOME}" "${STOP_LOG_NEW}" "${GOOD_OUT_FILE}"

# ─── Section 4: skip-restart (CORTEX_UPGRADE_SKIP_RESTART) ────────
printf '\n=== skip-restart ===\n'

# Membership predicate.
( export CORTEX_UPGRADE_SKIP_RESTART="work,halden"
  assert_true  "member: 'work' is in the skip list"        stack_restart_skipped work
  assert_true  "member: 'halden' is in the skip list"      stack_restart_skipped halden
  assert_false "member: 'meta-factory' is NOT in the list"  stack_restart_skipped meta-factory )
( unset CORTEX_UPGRADE_SKIP_RESTART
  assert_false "member: empty list → nothing skipped"       stack_restart_skipped work )

# reload_stack_unless_skipped: a skip-listed slug is NOT bootout/bootstrapped;
# a non-listed slug IS; the relay is never routed through this predicate.
SKIP_LAUNCH_DIR="${TMPHOME}/skip-launch"
mkdir -p "${SKIP_LAUNCH_DIR}"
for s in work meta-factory relay; do
  printf '<plist/>\n' > "${SKIP_LAUNCH_DIR}/ai.meta-factory.cortex.${s}.plist"
done

export CORTEX_UPGRADE_SKIP_RESTART="work"

# Skip-listed 'work' → zero launchctl calls (kept on its live process).
: > "${LAUNCHCTL_LOG}"
reload_stack_unless_skipped "${SKIP_LAUNCH_DIR}" work >/dev/null
assert_eq "skip: listed slug 'work' NOT passed to reload_plist (0 launchctl calls)" \
  "0" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"

# Non-listed 'meta-factory' → bootout+bootstrap (2 launchctl calls).
: > "${LAUNCHCTL_LOG}"
reload_stack_unless_skipped "${SKIP_LAUNCH_DIR}" meta-factory >/dev/null
assert_eq "skip: non-listed slug 'meta-factory' IS reloaded (2 launchctl calls)" \
  "2" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')"

# Relay bypasses the skip check entirely: even were 'relay' skip-listed,
# postupgrade reloads it via reload_plist directly (not the predicate).
( export CORTEX_UPGRADE_SKIP_RESTART="relay"
  : > "${LAUNCHCTL_LOG}"
  reload_plist "${SKIP_LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
  assert_eq "skip: relay always reloads (2 launchctl calls, never skip-checked)" \
    "2" "$(wc -l < "${LAUNCHCTL_LOG}" | tr -d ' ')" )

unset CORTEX_UPGRADE_SKIP_RESTART

# filter_out_skipped_pids: drop the skip-listed stack's PID from a kill list,
# matched by the daemon's --config path. Mock `ps -o command= -p <pid>` from a
# pid→cmdline map so no real process table is consulted.
SKIP_CONFIG_DIR="${TMPHOME}/skip-config"
mkdir -p "${SKIP_CONFIG_DIR}"
WORK_CFG="$(resolve_stack_config_path "${SKIP_CONFIG_DIR}" work)"
MF_CFG="$(resolve_stack_config_path "${SKIP_CONFIG_DIR}" meta-factory)"
export PSMAP="${TMPHOME}/psmap"
{
  printf '1001 %s/.local/bin/cortex start --config %s\n' "${HOME}" "${WORK_CFG}"
  printf '1002 %s/.local/bin/cortex start --config %s\n' "${HOME}" "${MF_CFG}"
} > "${PSMAP}"
cat > "${MOCK_BIN}/ps" <<'EOF'
#!/bin/sh
pid=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "${pid}" ] && sed -n "s/^${pid} //p" "${PSMAP:-/dev/null}"
exit 0
EOF
chmod +x "${MOCK_BIN}/ps"

( export CORTEX_UPGRADE_SKIP_RESTART="work"
  KEPT="$(filter_out_skipped_pids "1001 1002" "${SKIP_CONFIG_DIR}")"
  assert_eq "filter: skip-listed 'work' PID 1001 dropped; 1002 kept" "1002" "${KEPT}" )
( export CORTEX_UPGRADE_SKIP_RESTART="meta-factory"
  KEPT="$(filter_out_skipped_pids "1001 1002" "${SKIP_CONFIG_DIR}")"
  assert_eq "filter: skip-listed 'meta-factory' PID 1002 dropped; 1001 kept" "1001" "${KEPT}" )
( unset CORTEX_UPGRADE_SKIP_RESTART
  KEPT="$(filter_out_skipped_pids "1001 1002" "${SKIP_CONFIG_DIR}")"
  assert_eq "filter: empty skip list → both PIDs kept" "1001 1002" "${KEPT}" )

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
