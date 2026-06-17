#!/bin/bash
# cortex#1101 — unit tests for provision_stack_identity's file-aware idempotency.
#
# Regression guard: `cortex stack create` pre-declares stack.nkey_seed_path, and
# the old provisioner skipped seed generation on the declared KEY alone — so a
# stack-created stack never got its seed file. Idempotency must key on the FILE.
#
# Tests run entirely in a tmp HOME; no live ~/.config/nats is touched.
#
# Run:
#   bash scripts/__tests__/stack-identity-provision.sh
#
# Exit code: 0 = all pass, non-zero = failure count.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

make_config() {
  # $1 = stack dir; writes a config-split stacks/x.yaml declaring the seed path.
  local dir="$1"
  mkdir -p "${dir}/stacks"
  cat > "${dir}/stacks/x.yaml" <<'YAML'
stack:
  id: tester/x
  nkey_seed_path: ~/.config/nats/cortex-x-test.nk
agents:
  - id: luna
YAML
}

# ─── Case 1: declared path, MISSING file → generate (the #1101 fix) ──
TH1="$(mktemp -d)"
make_config "${TH1}/.config/cortex/x"
HOME="${TH1}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/x/stacks/x.yaml\" cortex-x-test" \
  >/dev/null 2>&1 || true
if [ -f "${TH1}/.config/nats/cortex-x-test.nk" ]; then
  pass "declared path + missing seed file → seed generated (cortex#1101)"
else
  fail "declared path + missing seed file → seed NOT generated"
fi
# chmod-600 posture
perms="$(stat -f '%Lp' "${TH1}/.config/nats/cortex-x-test.nk" 2>/dev/null || stat -c '%a' "${TH1}/.config/nats/cortex-x-test.nk" 2>/dev/null || echo '?')"
[ "${perms}" = "600" ] && pass "generated seed is chmod 600" || fail "generated seed perms = ${perms} (want 600)"
rm -rf "${TH1}"

# ─── Case 2: declared path, EXISTING file → idempotent skip (no regen) ──
TH2="$(mktemp -d)"
make_config "${TH2}/.config/cortex/x"
mkdir -p "${TH2}/.config/nats"
printf 'SUEXISTINGSEEDPLACEHOLDER' > "${TH2}/.config/nats/cortex-x-test.nk"
before="$(cat "${TH2}/.config/nats/cortex-x-test.nk")"
HOME="${TH2}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/x/stacks/x.yaml\" cortex-x-test" \
  >/dev/null 2>&1 || true
after="$(cat "${TH2}/.config/nats/cortex-x-test.nk")"
[ "${before}" = "${after}" ] && pass "declared path + existing seed → not regenerated (idempotent)" || fail "existing seed was clobbered"
rm -rf "${TH2}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
