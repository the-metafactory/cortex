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

# ─── Case 3: generated seed is a SINGLE bare nkey, not nsc's multi-line dump (cortex#1106) ──
# `nsc generate nkey -u` prints seed + pubkey + blank (3 lines); writing all of
# them makes cortex's `fromSeed(content.trim())` fail ("invalid encoded key").
# The seed must be one bare S-prefixed token that round-trips through fromSeed.
TH3="$(mktemp -d)"
mkdir -p "${TH3}/.config/nats"
HOME="${TH3}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/seed.nk\"" \
  >/dev/null 2>&1 || true
SEED3="${TH3}/.config/nats/seed.nk"
if [ -f "${SEED3}" ]; then
  # Newline count: 0 (bare, no trailing) or 1 (trailing) for a valid single
  # seed; nsc's unfixed 3-line dump yields 2 → this is the core regression guard.
  nl="$(wc -l < "${SEED3}" | tr -d ' ')"
  tok="$(tr -d '[:space:]' < "${SEED3}")"
  if [ "${nl}" -le 1 ] && printf '%s' "${tok}" | grep -qE '^S[A-Z2-7]+$'; then
    pass "generated seed is a single bare S-prefixed line, not nsc's 3-line dump (cortex#1106)"
  else
    fail "generated seed is multi-line / malformed (${nl} newline(s)) — cortex#1106 regression"
  fi
  # The exact parse cortex's stack-signing loader performs.
  if command -v bun >/dev/null 2>&1; then
    if bun -e "import {fromSeed} from 'nkeys.js'; import {readFileSync} from 'fs'; fromSeed(new TextEncoder().encode(readFileSync('${SEED3}','utf-8').trim())).getPublicKey();" >/dev/null 2>&1; then
      pass "generated seed parses via nkeys.js fromSeed (cortex#1106)"
    else
      fail "generated seed does NOT parse via fromSeed — cortex#1106 regression"
    fi
  else
    # bun is a hard cortex dep, so this should not happen — make the degraded
    # guard VISIBLE rather than silently skipping the strongest assertion.
    printf '  ⓘ skip: bun not on PATH — fromSeed round-trip assertion not run\n'
  fi
else
  fail "generate_nkey_seed produced no seed file (neither nsc nor bun available?)"
fi
rm -rf "${TH3}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
