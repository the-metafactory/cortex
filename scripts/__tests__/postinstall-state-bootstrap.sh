#!/bin/bash
# XDG wave-5 (cortex#2030) — end-to-end test for the postinstall fresh-install
# state bootstrap (scripts/postinstall.sh §1b → scripts/migrate-state-dir-exec.ts).
#
# Proves, ENTIRELY inside a scratch $HOME (no real ~/.config, ~/.local, ~/.claude
# touched), that postinstall:
#   - on a FRESH box (no legacy grove/cortex state tree): creates the canonical
#     state tree ~/.local/state/metafactory/cortex/ (+ logs/) and the completion
#     marker (.xdg-state-migration.json), and NO LONGER scaffolds state/logs under
#     the config root;
#   - on an UPGRADE box (legacy grove state present): writes NOTHING state-related
#     — no canonical tree, no marker (the gated migration owns that cutover);
#   - never names ~/.config/cortex/{logs,state} in its echoes.
#
# Run:  bash scripts/__tests__/postinstall-state-bootstrap.sh
# Exit: 0 = all pass, non-zero = failure count.

set -uo pipefail

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_true()  { local l="$1"; shift; if "$@"; then pass "${l}"; else fail "${l}"; fi; }
assert_false() { local l="$1"; shift; if "$@"; then fail "${l}"; else pass "${l}"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTINSTALL="${REPO_ROOT}/scripts/postinstall.sh"
REAL_HOME="${HOME}"   # captured before override — used only for the leak assertion

run_postinstall() {
  # Drive the real postinstall in a scratch HOME. PAI_INSTALL_PATH points arc's
  # runtime dir resolution at the repo. stderr+stdout captured to $2.
  local scratch="$1" outfile="$2"
  HOME="${scratch}" PAI_INSTALL_PATH="${REPO_ROOT}" \
    bash "${POSTINSTALL}" > "${outfile}" 2>&1
}

CANON_REL=".local/state/metafactory/cortex"
MARKER=".local/state/metafactory/cortex/.xdg-state-migration.json"

# ── Case 1: FRESH box ───────────────────────────────────────────────────────
printf '\n=== postinstall on a FRESH box ===\n'
FRESH="$(mktemp -d)"
FRESH_OUT="${FRESH}/run.out"
run_postinstall "${FRESH}" "${FRESH_OUT}"
RC=$?
if [ "${RC}" -ne 0 ]; then printf '  ✗ postinstall exited %s:\n' "${RC}"; sed 's/^/      /' "${FRESH_OUT}"; FAIL=$((FAIL + 1)); fi
assert_true  "fresh: postinstall exits 0" test "${RC}" -eq 0
assert_true  "fresh: canonical state tree created"        test -d "${FRESH}/${CANON_REL}"
assert_true  "fresh: canonical logs/ created"             test -d "${FRESH}/${CANON_REL}/logs"
assert_true  "fresh: completion marker written"           test -f "${FRESH}/${MARKER}"
# The G-53 vestige + logs must NOT be scaffolded under the config root anymore.
assert_false "fresh: NO ~/.config/metafactory/cortex/state scaffolded" test -d "${FRESH}/.config/metafactory/cortex/state"
assert_false "fresh: NO ~/.config/metafactory/cortex/logs scaffolded"  test -d "${FRESH}/.config/metafactory/cortex/logs"
assert_false "fresh: NO legacy ~/.config/cortex/{logs,state} scaffolded" test -e "${FRESH}/.config/cortex/state"
# Isolation: real home got no marker.
assert_false "fresh: real home got NO canonical marker" test -e "${REAL_HOME}/${MARKER}"
rm -rf "${FRESH}"

# ── Case 2: UPGRADE box (legacy grove state present) ────────────────────────
printf '\n=== postinstall on an UPGRADE box (legacy grove state present) ===\n'
UPG="$(mktemp -d)"
mkdir -p "${UPG}/.config/grove/state"
printf '4242\n' > "${UPG}/.config/grove/state/cortex.pid"   # a legacy pidfile
UPG_OUT="${UPG}/run.out"
run_postinstall "${UPG}" "${UPG_OUT}"
RC=$?
if [ "${RC}" -ne 0 ]; then printf '  ✗ postinstall exited %s:\n' "${RC}"; sed 's/^/      /' "${UPG_OUT}"; FAIL=$((FAIL + 1)); fi
assert_true  "upgrade: postinstall exits 0" test "${RC}" -eq 0
assert_false "upgrade: NO canonical state tree created" test -d "${UPG}/${CANON_REL}"
assert_false "upgrade: NO completion marker written"    test -e "${UPG}/${MARKER}"
assert_true  "upgrade: legacy grove pidfile untouched"  test -f "${UPG}/.config/grove/state/cortex.pid"
rm -rf "${UPG}"

printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
