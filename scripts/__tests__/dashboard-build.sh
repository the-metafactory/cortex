#!/bin/bash
# cortex#2770 — unit test for scripts/lib/dashboard-build.sh (build_mc_dashboard),
# the step postinstall.sh and postupgrade.sh run so an install serves the
# dashboard bundle of the code it runs. bun is replaced by a stub via
# CORTEX_BUN, so no real build runs.
#
# Run:  bash scripts/__tests__/dashboard-build.sh
# Exit: 0 = all pass, non-zero = failure count.

set -uo pipefail

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/lib/dashboard-build.sh
source "${REPO_ROOT}/scripts/lib/dashboard-build.sh"

SCRATCH="$(mktemp -d)"
CALLS="${SCRATCH}/calls"

stub() {
  local name="$1" rc="$2"
  printf '#!/bin/sh\necho "$(pwd) $*" >> "%s"\nexit %s\n' "${CALLS}" "${rc}" > "${SCRATCH}/${name}"
  chmod +x "${SCRATCH}/${name}"
  echo "${SCRATCH}/${name}"
}

printf '\n=== bun succeeds ===\n'
CORTEX_DIR="${SCRATCH}/cortex"; mkdir -p "${CORTEX_DIR}"
OUT="$(CORTEX_BUN="$(stub bun-ok 0)" build_mc_dashboard "${CORTEX_DIR}")"; RC=$?
[ "${RC}" -eq 0 ] && pass "returns 0" || fail "returns 0 (got ${RC})"
grep -q "^${CORTEX_DIR} run build:dashboard$" "${CALLS}" && pass "runs 'bun run build:dashboard' in the cortex dir" || fail "runs 'bun run build:dashboard' in the cortex dir: $(cat "${CALLS}")"
grep -q "✓ Mission Control dashboard built" <<<"${OUT}" && pass "reports the build" || fail "reports the build: ${OUT}"

printf '\n=== bun fails ===\n'
OUT="$(CORTEX_BUN="$(stub bun-bad 1)" build_mc_dashboard "${CORTEX_DIR}")"; RC=$?
[ "${RC}" -eq 0 ] && pass "a failed build does not stop the hook" || fail "a failed build does not stop the hook (got ${RC})"
grep -q "build failed; the previous bundle stays" <<<"${OUT}" && pass "warns and names the manual command" || fail "warns and names the manual command: ${OUT}"

printf '\n=== bun missing ===\n'
OUT="$(CORTEX_BUN="${SCRATCH}/no-such-bun" build_mc_dashboard "${CORTEX_DIR}")"; RC=$?
[ "${RC}" -eq 0 ] && pass "a missing bun does not stop the hook" || fail "a missing bun does not stop the hook (got ${RC})"
grep -q "bun not found" <<<"${OUT}" && pass "says bun is missing" || fail "says bun is missing: ${OUT}"

printf '\n=== both hooks call it ===\n'
for hook in postinstall postupgrade; do
  grep -q '^build_mc_dashboard "${CORTEX_DIR}"$' "${REPO_ROOT}/scripts/${hook}.sh" && pass "${hook}.sh builds the dashboard" || fail "${hook}.sh builds the dashboard"
done

rm -rf "${SCRATCH}"
printf '\n%s passed, %s failed\n' "${PASS}" "${FAIL}"
exit "${FAIL}"
