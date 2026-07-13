#!/bin/bash
# XDG wave-4 (cortex#1869) — end-to-end test for the config-dir move driver
# (scripts/migrate-config-dir.sh) and its shell helpers (canonical_config_dir /
# resolve_config_dir in plist-render.sh).
#
# Proves, ENTIRELY inside a scratch $HOME with a mocked launchctl (PATH override,
# same pattern as plist-render-bin-cutover.sh), that the RESTART op:
#   - carries the union of both legacy trees (cortex-wins-on-dup; grove-only
#     files carried; .bak sidecars + personas/ carried);
#   - excludes state/data subtrees (state/, logs/, agents/);
#   - keeps the legacy sources (rollback anchor) and writes a journal;
#   - re-renders every plist's --config argv at the NEW canonical dir;
#   - bootout/bootstraps the daemons, SPARING a skip-listed production stack;
#   - never touches the real home (asserted: the journal's canonical root is
#     under the scratch $HOME, and no real-home path is created).
#
# Run:  bash scripts/__tests__/migrate-config-dir.sh
# Exit: 0 = all pass, non-zero = failure count.

set -euo pipefail

PASS=0
FAIL=0
pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  ↷ %s (skipped: not applicable on %s)\n' "$1" "$(uname)"; PASS=$((PASS + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then pass "${label}"
  else fail "${label}: expected «${expected}» got «${actual}»"; fi
}
assert_true()  { local l="$1"; shift; if "$@"; then pass "${l}"; else fail "${l}"; fi; }
assert_false() { local l="$1"; shift; if "$@"; then fail "${l}"; else pass "${l}"; fi; }
assert_grep_file() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "${needle}" "${file}"; then pass "${label}"; else fail "${label}: «${needle}» not in ${file}"; fi
}
assert_not_grep_file() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "${needle}" "${file}"; then fail "${label}: «${needle}» unexpectedly in ${file}"; else pass "${label}"; fi
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIVER="${REPO_ROOT}/migrate-config-dir.sh"
REAL_HOME="${HOME}"   # captured before override — used only for leak assertions

# ── resolve_config_dir / canonical_config_dir unit checks ──────────────────
printf '\n=== resolve_config_dir precedence ===\n'
source "${REPO_ROOT}/lib/plist-render.sh"
(
  U="$(mktemp -d)"; export HOME="${U}"
  unset CORTEX_CONFIG_DIR
  assert_eq "resolve: nothing present → canonical path" \
    "${U}/.config/metafactory/cortex" "$(resolve_config_dir)"
  mkdir -p "${U}/.config/grove"
  assert_eq "resolve: only grove → grove" "${U}/.config/grove" "$(resolve_config_dir)"
  mkdir -p "${U}/.config/cortex"
  assert_eq "resolve: flat cortex present → cortex (wins over grove)" \
    "${U}/.config/cortex" "$(resolve_config_dir)"
  mkdir -p "${U}/.config/metafactory/cortex"
  assert_eq "resolve: canonical present → canonical (wins over legacy)" \
    "${U}/.config/metafactory/cortex" "$(resolve_config_dir)"
  export CORTEX_CONFIG_DIR="/tmp/override-root"
  assert_eq "resolve: \$CORTEX_CONFIG_DIR wins over everything" \
    "/tmp/override-root" "$(resolve_config_dir)"
  assert_eq "canonical_config_dir: \$CORTEX_CONFIG_DIR verbatim" \
    "/tmp/override-root" "$(canonical_config_dir)"
  unset CORTEX_CONFIG_DIR
  assert_eq "canonical_config_dir: default → metafactory/cortex" \
    "${U}/.config/metafactory/cortex" "$(canonical_config_dir)"
  rm -rf "${U}"
)

# ── Full driver run in scratch HOME ────────────────────────────────────────
printf '\n=== migrate-config-dir.sh (scratch HOME, mocked launchctl) ===\n'

TMPHOME="$(mktemp -d)"
trap 'rm -rf "${TMPHOME}"' EXIT

# Legacy flat cortex tree — the pre-move canonical.
LC="${TMPHOME}/.config/cortex"
mkdir -p "${LC}/personas" "${LC}/state" "${LC}/logs"
printf 'stack:\n  id: andreas/meta-factory\nTREE: cortex\n' > "${LC}/cortex.yaml"   # monolith → meta-factory
printf 'stack:\n  id: andreas/work\n'                        > "${LC}/cortex.work.yaml" # work (skip-listed)
printf 'prev cortex.yaml\n'                                  > "${LC}/cortex.yaml.bak"  # .bak sidecar → carried
printf '# pier persona\n'                                    > "${LC}/personas/pier.md" # personas/ → carried
printf '4242\n'                                              > "${LC}/state/cortex.pid" # state → EXCLUDED
printf 'log line\n'                                          > "${LC}/logs/cortex.log"  # logs → EXCLUDED

# Legacy grove tree — divergent: a grove-only secret + a dup cortex.yaml (grove
# loses to cortex-wins-on-dup, and its copy must be KEPT, never deleted).
GV="${TMPHOME}/.config/grove"
mkdir -p "${GV}"
printf 'discord_token: SECRET\n'      > "${GV}/bot.yaml"    # grove-ONLY → carried
printf 'stack:\n  id: x\nTREE: grove\n' > "${GV}/cortex.yaml" # dup → shadowed by cortex, kept

CANON="${TMPHOME}/.config/metafactory/cortex"

# Mock launchctl (trace each call so bootout/bootstrap + skip can be asserted).
MOCK_BIN="${TMPHOME}/mock-bin"; mkdir -p "${MOCK_BIN}"
LAUNCHCTL_LOG="${TMPHOME}/launchctl.log"; : > "${LAUNCHCTL_LOG}"
export LAUNCHCTL_LOG
cat > "${MOCK_BIN}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${LAUNCHCTL_LOG:-/dev/null}"
EOF
chmod +x "${MOCK_BIN}/launchctl"

# Drive the real script: scratch HOME, work spared, mocked launchctl on PATH.
RUN_OUT="${TMPHOME}/run.out"
set +e
HOME="${TMPHOME}" CORTEX_UPGRADE_SKIP_RESTART="work" \
  PATH="${MOCK_BIN}:${PATH}" bash "${DRIVER}" > "${RUN_OUT}" 2>&1
RUN_CODE=$?
set -e
if [ "${RUN_CODE}" -ne 0 ]; then
  printf '  ✗ driver exited %s:\n' "${RUN_CODE}"; sed 's/^/      /' "${RUN_OUT}"
  FAIL=$((FAIL + 1))
fi
assert_eq "driver: exits 0" "0" "${RUN_CODE}"

# ── Merge-policy assertions (the config data-safety core) ──
assert_true  "carry: canonical cortex.yaml exists"      test -f "${CANON}/cortex.yaml"
assert_grep_file "cortex-wins-on-dup: canonical cortex.yaml is the CORTEX copy" \
  "${CANON}/cortex.yaml" "TREE: cortex"
assert_not_grep_file "cortex-wins-on-dup: NOT the grove copy" \
  "${CANON}/cortex.yaml" "TREE: grove"
assert_true  "carry: grove-ONLY bot.yaml carried (secret not lost)" test -f "${CANON}/bot.yaml"
assert_grep_file "carry: grove-only secret content intact" "${CANON}/bot.yaml" "discord_token: SECRET"
assert_true  "carry: .bak sidecar carried"              test -f "${CANON}/cortex.yaml.bak"
assert_true  "carry: personas/ carried"                 test -f "${CANON}/personas/pier.md"
assert_true  "carry: work stack config carried"         test -f "${CANON}/cortex.work.yaml"

# ── Exclusion assertions (state/data owned by #1902/#1903) ──
assert_false "exclude: state/ NOT carried"              test -e "${CANON}/state/cortex.pid"
assert_false "exclude: logs/ NOT carried"               test -e "${CANON}/logs/cortex.log"

# ── Rollback-safety assertions ──
assert_true  "rollback: journal written canonical-side" test -f "${CANON}/.xdg-config-migration.json"
assert_true  "rollback: legacy cortex.yaml SOURCE kept (never renamed)" test -f "${LC}/cortex.yaml"
assert_true  "rollback: legacy grove bot.yaml SOURCE kept" test -f "${GV}/bot.yaml"
assert_grep_file "rollback: shadowed grove cortex.yaml recorded in journal" \
  "${CANON}/.xdg-config-migration.json" "shadowedGrove"

# ── Real-home leak guard: the journal's canonical root is UNDER scratch HOME ──
assert_grep_file "isolation: journal canonical root is under scratch HOME" \
  "${CANON}/.xdg-config-migration.json" "${TMPHOME}/.config/metafactory/cortex"
assert_false "isolation: real home got no migration journal" \
  test -e "${REAL_HOME}/.config/metafactory/cortex/.xdg-config-migration.json"

# ── RESTART op: plists re-rendered at the NEW dir + bootout/bootstrap ──
if [ "$(uname)" != "Darwin" ]; then
  skip "restart: plist re-render + launchctl (Darwin-only)"
  skip "restart: skip-listed production stack spared (Darwin-only)"
else
  MF_PLIST="${TMPHOME}/Library/LaunchAgents/ai.meta-factory.cortex.meta-factory.plist"
  WORK_PLIST="${TMPHOME}/Library/LaunchAgents/ai.meta-factory.cortex.work.plist"
  assert_true "restart: meta-factory plist rendered" test -f "${MF_PLIST}"
  assert_grep_file "restart: meta-factory plist --config points at MOVED canonical dir" \
    "${MF_PLIST}" "${CANON}/cortex.yaml"
  assert_not_grep_file "restart: meta-factory plist --config NO LONGER the legacy tree" \
    "${MF_PLIST}" "<string>${LC}/cortex.yaml</string>"
  # work plist is re-rendered too (so a later natural reload boots the moved dir)…
  assert_grep_file "restart: work plist ALSO re-rendered at canonical dir" \
    "${WORK_PLIST}" "${CANON}/cortex.work.yaml"
  # …but the work daemon is NOT bootout/bootstrapped (spared).
  assert_grep_file "restart: meta-factory bootout issued" "${LAUNCHCTL_LOG}" "bootout"
  assert_grep_file "restart: meta-factory bootstrap issued" "${LAUNCHCTL_LOG}" "ai.meta-factory.cortex.meta-factory.plist"
  assert_grep_file "restart: relay reloaded" "${LAUNCHCTL_LOG}" "ai.meta-factory.cortex.relay.plist"
  assert_not_grep_file "restart: skip-listed 'work' daemon NOT bootstrapped" \
    "${LAUNCHCTL_LOG}" "ai.meta-factory.cortex.work.plist"
fi

# ── Idempotency: a second run carries nothing new, still exits 0 ──
printf '\n=== idempotency (second run) ===\n'
set +e
HOME="${TMPHOME}" CORTEX_UPGRADE_SKIP_RESTART="work" \
  PATH="${MOCK_BIN}:${PATH}" bash "${DRIVER}" > "${TMPHOME}/run2.out" 2>&1
RUN2_CODE=$?
set -e
assert_eq "idempotent: second run exits 0" "0" "${RUN2_CODE}"
assert_grep_file "idempotent: second run reports all-already-present" \
  "${TMPHOME}/run2.out" "already present"

# ── PLAN_ONLY dry-run writes nothing ──
printf '\n=== PLAN_ONLY dry-run ===\n'
PLANHOME="$(mktemp -d)"
mkdir -p "${PLANHOME}/.config/cortex"
printf 'stack:\n  id: a/meta-factory\n' > "${PLANHOME}/.config/cortex/cortex.yaml"
set +e
HOME="${PLANHOME}" PLAN_ONLY=1 PATH="${MOCK_BIN}:${PATH}" bash "${DRIVER}" > "${PLANHOME}/plan.out" 2>&1
PLAN_CODE=$?
set -e
assert_eq "plan-only: exits 0" "0" "${PLAN_CODE}"
assert_false "plan-only: wrote NO canonical tree" \
  test -e "${PLANHOME}/.config/metafactory/cortex/cortex.yaml"
rm -rf "${PLANHOME}"

printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
