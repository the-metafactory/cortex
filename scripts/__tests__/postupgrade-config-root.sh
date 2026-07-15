#!/bin/bash
# cortex#2044 — end-to-end test for scripts/postupgrade.sh, guarding two
# upgrade-path regressions found on a fresh Linux install (6.8.2):
#
#   (1) postupgrade MUST NOT scaffold a state-class `logs/` dir under the
#       canonical CONFIG root (~/.config/metafactory/cortex/logs) — the #2030
#       misplacement shape. PR#2032 fixed the twin line in postinstall.sh; this
#       proves the postupgrade line is fixed too (the `xdg-audit --machine`
#       config-root-state-misplacement gate depends on it).
#   (2) the "Provisioning stack signing identity…" header is only printed when
#       ≥1 stack is discovered — an install-only box (zero stacks) stays quiet.
#   (3) a fresh box (no legacy ~/bin) is NOT given a materialized ~/bin by the
#       bin-cutover bridge (forward_link_legacy_bin guard; see also the unit
#       cases in plist-render-bin-cutover.sh).
#
# Runs ENTIRELY inside a scratch $HOME; launchctl/systemctl are mocked via a
# PATH override so no live daemon or launchd/systemd domain is touched.
#
# Run:  bash scripts/__tests__/postupgrade-config-root.sh
# Exit: 0 = all pass, non-zero = failure count.

set -uo pipefail

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_true()  { local l="$1"; shift; if "$@"; then pass "${l}"; else fail "${l}"; fi; }
assert_false() { local l="$1"; shift; if "$@"; then fail "${l}"; else pass "${l}"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTUPGRADE="${REPO_ROOT}/scripts/postupgrade.sh"
REAL_HOME="${HOME}"   # captured before override — used only for the leak assertion

# Mock launchctl + systemctl so the Darwin/Linux daemon-reload legs are inert.
MOCKBIN="$(mktemp -d)"
for tool in launchctl systemctl; do
  printf '#!/bin/sh\nexit 0\n' > "${MOCKBIN}/${tool}"
  chmod +x "${MOCKBIN}/${tool}"
done

run_postupgrade() {
  # Drive the real postupgrade in a scratch HOME. PAI_INSTALL_PATH points
  # cortex's runtime dir resolution at the repo. stderr+stdout captured to $2.
  local scratch="$1" outfile="$2"
  HOME="${scratch}" PAI_INSTALL_PATH="${REPO_ROOT}" \
    PATH="${MOCKBIN}:${PATH}" \
    PAI_OLD_VERSION="6.8.2" PAI_NEW_VERSION="6.8.3" \
    bash "${POSTUPGRADE}" > "${outfile}" 2>&1
}

CONFIG_MF="/.config/metafactory/cortex"

# ── Case 1: fresh/install-only box (no stacks, no legacy ~/bin) ──────────────
printf '\n=== postupgrade on a fresh install-only box ===\n'
FRESH="$(mktemp -d)"
FRESH_OUT="${FRESH}/run.out"
run_postupgrade "${FRESH}" "${FRESH_OUT}"
RC=$?
if [ "${RC}" -ne 0 ]; then printf '  ✗ postupgrade exited %s:\n' "${RC}"; sed 's/^/      /' "${FRESH_OUT}"; FAIL=$((FAIL + 1)); fi
assert_true  "fresh: postupgrade exits 0" test "${RC}" -eq 0
# (1) the state-class logs dir must NOT appear under the config root.
assert_false "fresh: NO ~/.config/metafactory/cortex/logs scaffolded" test -d "${FRESH}${CONFIG_MF}/logs"
assert_false "fresh: NO legacy ~/.config/cortex/logs scaffolded"      test -d "${FRESH}/.config/cortex/logs"
# (2) the signing header stays quiet with zero stacks.
assert_false "fresh: signing-identity header NOT printed (0 stacks)" \
  grep -qF "Provisioning stack signing identity" "${FRESH_OUT}"
# (3) no ~/bin materialized on a box that never had one.
assert_false "fresh: NO ~/bin created" test -d "${FRESH}/bin"
# Isolation: real home untouched.
assert_false "fresh: real home got NO config-root logs" test -d "${REAL_HOME}${CONFIG_MF}/logs"
rm -rf "${FRESH}"

# ── Case 2: legacy ~/bin present → bridge still runs (no regression) ─────────
printf '\n=== postupgrade on a box WITH a legacy ~/bin ===\n'
LEG="$(mktemp -d)"
mkdir -p "${LEG}/bin" "${LEG}/.local/bin"
printf '#!/bin/sh\n' > "${LEG}/.local/bin/cortex"        # arc-installed target
printf '#!/bin/sh\n' > "${LEG}/.local/bin/cortex-relay"
printf '#!/bin/sh\n' > "${LEG}/.local/bin/cldyo-live"
LEG_OUT="${LEG}/run.out"
run_postupgrade "${LEG}" "${LEG_OUT}"
RC=$?
if [ "${RC}" -ne 0 ]; then printf '  ✗ postupgrade exited %s:\n' "${RC}"; sed 's/^/      /' "${LEG_OUT}"; FAIL=$((FAIL + 1)); fi
assert_true  "legacy: postupgrade exits 0" test "${RC}" -eq 0
assert_true  "legacy: bridge forward-symlinked ~/bin/cortex → ~/.local/bin" \
  test -L "${LEG}/bin/cortex"
assert_false "legacy: still NO config-root logs" test -d "${LEG}${CONFIG_MF}/logs"
rm -rf "${LEG}"

rm -rf "${MOCKBIN}"
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
