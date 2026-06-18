#!/bin/bash
# G3 (cortex#1119) — 3-site nkey_pub write-back tests.
#
# Guards the idempotent patching of ALL THREE nkey_pub sites in a stack config
# after arc upgrade derives the real pubkey from the signing seed:
#
#   1. stack.nkey_pub
#   2. policy.principals[<agent>].nkey_pub  (the agent signing identity, NOT the human)
#   3. agents[*].nkey_pub
#
# Placeholder pattern: UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
# (56 chars, the NKEY_PUB_PLACEHOLDER emitted by `cortex stack create`).
# Sites holding a REAL pubkey (different U…56 value) MUST NOT be clobbered.
#
# Run:
#   bash scripts/__tests__/stack-identity-provision-g3.sh
#
# Exit code: 0 = all pass, non-zero = failure count.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

# The exact placeholder emitted by `cortex stack create` (NKEY_PUB_PLACEHOLDER).
PLACEHOLDER="UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
# A synthetic real pubkey (different value, same valid format U + 55 base32 chars).
REAL_PUB="UBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

# count_occurrences <file> <value>
# Returns the number of nkey_pub lines in the file whose value equals <value>.
count_nkey_occurrences() {
  local config="$1"
  local val="$2"
  # Match lines of the form:  [whitespace]nkey_pub: VALUE[whitespace or end]
  # Use grep -c with a fixed string that includes the key and value.
  grep -c "nkey_pub: ${val}" "${config}" 2>/dev/null || true
}

# Build a minimal config-split stacks/<slug>.yaml that mirrors `cortex stack create` output.
# $1 = dir prefix (e.g. /tmp/xxx/.config/cortex/<slug>)
# $2 = agent id (e.g. ivy)
# $3 = stack nkey_pub value (placeholder or real)
# $4 = policy.principals[agent].nkey_pub value
# $5 = agents[agent].nkey_pub value
make_stack_config() {
  local dir="$1" agent="$2" stack_pub="$3" policy_pub="$4" agent_pub="$5"
  mkdir -p "${dir}/stacks"
  cat > "${dir}/stacks/${agent}.yaml" <<YAML
principal:
  id: tester
  displayName: Tester
  discordId: "<REPLACE_ME>"

stack:
  id: tester/${agent}
  nkey_seed_path: ~/.config/nats/cortex-${agent}-test.nk
  nkey_pub: ${stack_pub}  # <REPLACE_ME>

capabilities:
  - id: chat
    description: chat
    provided_by: [${agent}]

policy:
  principals:
    - id: ${agent}
      home_principal: tester
      home_stack: tester/${agent}
      nkey_pub: ${policy_pub}  # <REPLACE_ME>
      role:
        - principal-role
      trust: []
      platform_ids: {}
    - id: tester
      home_principal: tester
      home_stack: tester/${agent}
      role:
        - principal-role
      trust: []
      platform_ids:
        discord:
          - "<REPLACE_ME>"
  roles:
    - id: principal-role
      capabilities:
        - chat

agents:
  - id: ${agent}
    displayName: "${agent}"
    persona: ./personas/${agent}.md
    nkey_pub: ${agent_pub}  # <REPLACE_ME>
    roles: []
    trust: []
    runtime:
      substrate: claude-code
      mode: in-process
      capabilities:
        - chat
    presence: {}
YAML
}

# ─── Case 1: fresh stack — all 3 sites hold placeholder → all 3 get patched ──
printf '\n=== Case 1: all 3 sites hold placeholder → all 3 patched ===\n'
TH1="$(mktemp -d)"
make_stack_config "${TH1}/.config/cortex/ivy" "ivy" \
  "${PLACEHOLDER}" "${PLACEHOLDER}" "${PLACEHOLDER}"

mkdir -p "${TH1}/.config/nats"
HOME="${TH1}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  >/dev/null 2>&1

REAL_PUB_1="$(HOME="${TH1}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; derive_pubkey_from_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  2>/dev/null || echo '')"

if [ -z "${REAL_PUB_1}" ]; then
  printf '  ⓘ skip Case 1: bun/nkeys.js not available — cannot derive pubkey\n'
else
  HOME="${TH1}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  CONFIG="${TH1}/.config/cortex/ivy/stacks/ivy.yaml"

  # Verify: all 3 placeholder occurrences should be gone (0 left).
  placeholder_left="$(count_nkey_occurrences "${CONFIG}" "${PLACEHOLDER}")"
  if [ "${placeholder_left}" -eq 0 ]; then
    pass "Case 1: no placeholder values remain in config after patch"
  else
    fail "Case 1: ${placeholder_left} placeholder value(s) still present (want 0)"
  fi

  # Verify: the real pubkey appears exactly 3 times (stack + policy agent + agents[]).
  real_count="$(count_nkey_occurrences "${CONFIG}" "${REAL_PUB_1}")"
  if [ "${real_count}" -eq 3 ]; then
    pass "Case 1: real pubkey appears exactly 3 times (all 3 sites patched)"
  else
    fail "Case 1: real pubkey appears ${real_count} time(s) (want 3)"
  fi

  # Verify: the human principal entry (id: tester) does NOT have nkey_pub inserted.
  # The config template has no nkey_pub on the human entry — should still be absent.
  total_nkey_lines="$(grep -c 'nkey_pub:' "${CONFIG}" 2>/dev/null || true)"
  if [ "${total_nkey_lines}" -eq 3 ]; then
    pass "Case 1: exactly 3 nkey_pub lines total (human principal not touched)"
  else
    fail "Case 1: found ${total_nkey_lines} nkey_pub lines (want 3)"
  fi

  # Backup was created.
  backup_count="$(find "${TH1}/.config/cortex/ivy/stacks" -name '*.pre-stack-identity-*' | wc -l | tr -d ' ')"
  if [ "${backup_count}" -ge 1 ]; then
    pass "Case 1: backup created before edit"
  else
    fail "Case 1: no backup created"
  fi
fi
rm -rf "${TH1}"

# ─── Case 2: real pubkey already in place → not clobbered ──
printf '\n=== Case 2: real pubkey site not clobbered (mixed-state) ===\n'
# Mixed-state: stack.nkey_pub = placeholder, policy + agent have real pubkey.
# Only stack.nkey_pub should be replaced; the other two must survive.
TH2="$(mktemp -d)"
make_stack_config "${TH2}/.config/cortex/ivy" "ivy" \
  "${PLACEHOLDER}" "${REAL_PUB}" "${REAL_PUB}"
mkdir -p "${TH2}/.config/nats"
HOME="${TH2}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  >/dev/null 2>&1

REAL_PUB_2="$(HOME="${TH2}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; derive_pubkey_from_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  2>/dev/null || echo '')"

if [ -z "${REAL_PUB_2}" ]; then
  printf '  ⓘ skip Case 2: bun not available\n'
else
  HOME="${TH2}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  CONFIG2="${TH2}/.config/cortex/ivy/stacks/ivy.yaml"

  # No placeholder should remain.
  placeholder_left2="$(count_nkey_occurrences "${CONFIG2}" "${PLACEHOLDER}")"
  if [ "${placeholder_left2}" -eq 0 ]; then
    pass "Case 2: no placeholder values remain (stack.nkey_pub was patched)"
  else
    fail "Case 2: ${placeholder_left2} placeholder(s) still present"
  fi

  # The REAL_PUB (pre-existing) values should still be there — 2 occurrences.
  real_pre_count="$(count_nkey_occurrences "${CONFIG2}" "${REAL_PUB}")"
  if [ "${real_pre_count}" -eq 2 ]; then
    pass "Case 2: pre-existing real pubkey kept in 2 sites (not clobbered)"
  else
    fail "Case 2: pre-existing real pubkey count = ${real_pre_count} (want 2)"
  fi

  # The derived pubkey (for stack.nkey_pub) should appear exactly 1 time.
  real_new_count="$(count_nkey_occurrences "${CONFIG2}" "${REAL_PUB_2}")"
  if [ "${real_new_count}" -eq 1 ]; then
    pass "Case 2: stack.nkey_pub patched to derived pubkey (1 occurrence)"
  else
    fail "Case 2: derived pubkey count = ${real_new_count} (want 1)"
  fi
fi
rm -rf "${TH2}"

# ─── Case 3: human principal entry nkey_pub NOT inserted ──
printf '\n=== Case 3: human principal (no nkey_pub) not touched ===\n'
TH3="$(mktemp -d)"
make_stack_config "${TH3}/.config/cortex/ivy" "ivy" \
  "${PLACEHOLDER}" "${PLACEHOLDER}" "${PLACEHOLDER}"
mkdir -p "${TH3}/.config/nats"
HOME="${TH3}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  >/dev/null 2>&1

REAL_PUB_3="$(HOME="${TH3}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; derive_pubkey_from_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  2>/dev/null || echo '')"

if [ -z "${REAL_PUB_3}" ]; then
  printf '  ⓘ skip Case 3: bun not available\n'
else
  HOME="${TH3}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  CONFIG3="${TH3}/.config/cortex/ivy/stacks/ivy.yaml"

  # Count total nkey_pub lines — should be exactly 3 (stack, policy[ivy], agents[ivy]).
  # The human principal (id: tester) has no nkey_pub field in the template.
  nkey_pub_count="$(grep -c 'nkey_pub:' "${CONFIG3}" || true)"
  if [ "${nkey_pub_count}" -eq 3 ]; then
    pass "Case 3: exactly 3 nkey_pub entries (human principal not touched)"
  else
    fail "Case 3: found ${nkey_pub_count} nkey_pub entries (want 3)"
  fi
fi
rm -rf "${TH3}"

# ─── Case 4: config with valid pubkey already — no-op ──
printf '\n=== Case 4: all 3 sites already hold real pubkey → no-op ===\n'
TH4="$(mktemp -d)"
# All 3 sites have the same real pubkey (not the placeholder).
make_stack_config "${TH4}/.config/cortex/ivy" "ivy" \
  "${REAL_PUB}" "${REAL_PUB}" "${REAL_PUB}"
mkdir -p "${TH4}/.config/nats"
HOME="${TH4}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  >/dev/null 2>&1

REAL_PUB_4="$(HOME="${TH4}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; derive_pubkey_from_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  2>/dev/null || echo '')"

if [ -z "${REAL_PUB_4}" ]; then
  printf '  ⓘ skip Case 4: bun not available\n'
else
  before4="$(cat "${TH4}/.config/cortex/ivy/stacks/ivy.yaml")"

  HOME="${TH4}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  after4="$(cat "${TH4}/.config/cortex/ivy/stacks/ivy.yaml")"

  # All 3 sites hold REAL_PUB (not the placeholder) — no patching should occur.
  if [ "${before4}" = "${after4}" ]; then
    pass "Case 4: config unchanged when all sites already hold real pubkey"
  else
    fail "Case 4: config was modified even though no placeholders present"
  fi
fi
rm -rf "${TH4}"

# ─── Case 5: re-run after patching → fully idempotent ──
printf '\n=== Case 5: second run after patch → idempotent ===\n'
TH5="$(mktemp -d)"
make_stack_config "${TH5}/.config/cortex/ivy" "ivy" \
  "${PLACEHOLDER}" "${PLACEHOLDER}" "${PLACEHOLDER}"
mkdir -p "${TH5}/.config/nats"
HOME="${TH5}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; generate_nkey_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  >/dev/null 2>&1

REAL_PUB_5="$(HOME="${TH5}" bash -c \
  "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; derive_pubkey_from_seed \"\${HOME}/.config/nats/cortex-ivy-test.nk\"" \
  2>/dev/null || echo '')"

if [ -z "${REAL_PUB_5}" ]; then
  printf '  ⓘ skip Case 5: bun not available\n'
else
  # First run.
  HOME="${TH5}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  config5="${TH5}/.config/cortex/ivy/stacks/ivy.yaml"
  after_first="$(cat "${config5}")"
  backup_count_after_first="$(find "${TH5}/.config/cortex/ivy/stacks" -name '*.pre-stack-identity-*' | wc -l | tr -d ' ')"

  # Second run — seed file already exists, declared in config → early-return path.
  HOME="${TH5}" bash -c \
    "source '${SCRIPT_DIR}/lib/stack-identity-provision.sh'; provision_stack_identity \"\${HOME}/.config/cortex/ivy/stacks/ivy.yaml\" cortex-ivy-test" \
    >/dev/null 2>&1 || true

  after_second="$(cat "${config5}")"
  backup_count_after_second="$(find "${TH5}/.config/cortex/ivy/stacks" -name '*.pre-stack-identity-*' | wc -l | tr -d ' ')"

  if [ "${after_first}" = "${after_second}" ]; then
    pass "Case 5: second run left config unchanged (idempotent)"
  else
    fail "Case 5: second run modified the config"
  fi

  if [ "${backup_count_after_second}" -eq "${backup_count_after_first}" ]; then
    pass "Case 5: no extra backup created on second run"
  else
    fail "Case 5: backup count grew from ${backup_count_after_first} to ${backup_count_after_second} on second run"
  fi
fi
rm -rf "${TH5}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
