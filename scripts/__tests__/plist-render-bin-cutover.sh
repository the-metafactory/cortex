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

# ─── Results ──────────────────────────────────────────────────────
printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
