#!/bin/bash
# cortex#700 — unit tests for stack discovery + plist rendering in plist-render.sh.
#
# Tests run entirely in tmp fixtures; no live ~/.config/cortex is touched and
# launchctl is never invoked (mocked via PATH override).
#
# Run:
#   bash scripts/__tests__/plist-render-stack-discovery.sh
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

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "${haystack}" | grep -qF "${needle}"; then
    pass "${label}"
  else
    fail "${label}: expected «${needle}» in «${haystack}»"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if ! printf '%s\n' "${haystack}" | grep -qF "${needle}"; then
    pass "${label}"
  else
    fail "${label}: did NOT expect «${needle}» in «${haystack}»"
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "${path}" ]; then
    pass "${label}"
  else
    fail "${label}: file not found: ${path}"
  fi
}

assert_file_not_exists() {
  local label="$1" path="$2"
  if [ ! -f "${path}" ]; then
    pass "${label}"
  else
    fail "${label}: expected file absent but found: ${path}"
  fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source the lib (uname guard in render_cortex_plists will short-circuit on
# non-Darwin hosts; we test lower-level functions directly so that's fine).
source "${SCRIPT_DIR}/lib/plist-render.sh"

# Temp workspace — cleaned up on EXIT.
TMPBASE="$(mktemp -d)"
trap 'rm -rf "${TMPBASE}"' EXIT

CONFIG_DIR="${TMPBASE}/config"
LAUNCH_DIR="${TMPBASE}/LaunchAgents"
mkdir -p "${CONFIG_DIR}" "${LAUNCH_DIR}"

# Mock bun: the real bun isn't needed for slug/render tests; we provide a
# stub that prints a fixed path so sed substitution produces a valid (non-
# empty) string in the rendered plist without requiring bun to be installed.
MOCK_BIN="${TMPBASE}/mock-bin"
mkdir -p "${MOCK_BIN}"
# Use a heredoc so the path literal is baked into the stub at creation time.
cat > "${MOCK_BIN}/bun" <<EOF
#!/bin/sh
printf '%s' "${MOCK_BIN}/bun"
EOF
chmod +x "${MOCK_BIN}/bun"

# Mock launchctl: never actually invoke launchctl — just emit a trace line
# so tests can assert it was (or wasn't) called.
# Export LAUNCHCTL_LOG before writing the heredoc so the subshell (the mock
# binary) inherits the variable when invoked by plist-render.sh functions.
export LAUNCHCTL_LOG="${TMPBASE}/launchctl.log"
cat > "${MOCK_BIN}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${LAUNCHCTL_LOG:-/dev/null}"
EOF
chmod +x "${MOCK_BIN}/launchctl"
export PATH="${MOCK_BIN}:${PATH}"

# ─── Section 1: config_file_to_slug ──────────────────────────────
printf '\n=== config_file_to_slug ===\n'

assert_eq "cortex.yaml → meta-factory" \
  "meta-factory" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.yaml")"

assert_eq "cortex.work.yaml → work" \
  "work" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.work.yaml")"

assert_eq "cortex.halden.yaml → halden" \
  "halden" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.halden.yaml")"

assert_eq "cortex.my-stack.yaml → my-stack" \
  "my-stack" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.my-stack.yaml")"

# Unrecognised filename should fail (non-zero exit).
if config_file_to_slug "${CONFIG_DIR}/bot.yaml" 2>/dev/null; then
  fail "bot.yaml should return non-zero"
else
  pass "bot.yaml returns non-zero (not a cortex config)"
fi

# ─── Section 2: slug_to_config_file (inverse of config_file_to_slug) ─
printf '\n=== slug_to_config_file ===\n'

assert_eq "meta-factory → cortex.yaml" \
  "cortex.yaml" \
  "$(slug_to_config_file "meta-factory")"

assert_eq "work → cortex.work.yaml" \
  "cortex.work.yaml" \
  "$(slug_to_config_file "work")"

assert_eq "halden → cortex.halden.yaml" \
  "cortex.halden.yaml" \
  "$(slug_to_config_file "halden")"

# ─── Section 3: discover_stack_slugs ─────────────────────────────
printf '\n=== discover_stack_slugs ===\n'

# Empty dir — no stacks.
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_eq "empty config dir → no slugs" "" "${SLUGS}"

# Single default config.
touch "${CONFIG_DIR}/cortex.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_eq "cortex.yaml only → meta-factory" "meta-factory" "${SLUGS}"

# Add work stack.
touch "${CONFIG_DIR}/cortex.work.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_contains "cortex.yaml + cortex.work.yaml includes meta-factory" "meta-factory" "${SLUGS}"
assert_contains "cortex.yaml + cortex.work.yaml includes work" "work" "${SLUGS}"

# Add halden stack.
touch "${CONFIG_DIR}/cortex.halden.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_contains "three configs includes meta-factory" "meta-factory" "${SLUGS}"
assert_contains "three configs includes work" "work" "${SLUGS}"
assert_contains "three configs includes halden" "halden" "${SLUGS}"

# Non-cortex YAML files must NOT be discovered.
touch "${CONFIG_DIR}/other.yaml"
touch "${CONFIG_DIR}/readme.txt"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_not_contains "other.yaml not included" "other" "${SLUGS}"
assert_not_contains "readme.txt not included" "readme" "${SLUGS}"

# Line count matches file count (3 cortex*.yaml files → 3 slugs).
SLUG_COUNT="$(discover_stack_slugs "${CONFIG_DIR}" | wc -l | tr -d ' ')"
assert_eq "3 cortex*.yaml → 3 slugs" "3" "${SLUG_COUNT}"

# ─── Section 3: render_stack_plist — meta-factory (generic template) ──
# cortex#1848: the personal ai.meta-factory.cortex.meta-factory.plist
# template (which hardcoded a real agent name via __AGENT_NAME__) is gone.
# meta-factory is just another slug now — it renders from the same generic
# ai.meta-factory.cortex.stack.plist template as every other stack.
printf '\n=== render_stack_plist: meta-factory (generic template) ===\n'

# Write a minimal meta-factory config with an agents[].id field. The agent id
# is no longer read into the plist at all (no more __AGENT_NAME__ slot), so
# this just proves render_stack_plist doesn't choke on a config that has one.
cat > "${CONFIG_DIR}/cortex.yaml" <<'EOF'
agents:
  - id: my-test-agent
    token: "fake"
EOF

MF_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.meta-factory.plist"

render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "meta-factory" "${MOCK_BIN}/bun"
assert_file_exists "meta-factory plist rendered" "${MF_DST}"
assert_contains "meta-factory plist contains label" "ai.meta-factory.cortex.meta-factory" "$(cat "${MF_DST}")"
assert_contains "meta-factory plist CORTEX_CHANNEL substituted from slug" "meta-factory" "$(cat "${MF_DST}")"
assert_not_contains "meta-factory plist has no leftover __STACK_SLUG__ placeholder" "__STACK_SLUG__" "$(cat "${MF_DST}")"
assert_not_contains "meta-factory plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${MF_DST}")"
assert_not_contains "meta-factory plist carries no CORTEX_AGENT_NAME (vestigial, removed)" "CORTEX_AGENT_NAME" "$(cat "${MF_DST}")"
assert_not_contains "meta-factory plist carries no CORTEX_AGENT_ID (vestigial, removed)" "CORTEX_AGENT_ID" "$(cat "${MF_DST}")"
assert_not_contains "meta-factory plist agent id NOT embedded (personal-identity template deleted)" "my-test-agent" "$(cat "${MF_DST}")"

# ─── Section 4: render_stack_plist — work (generic template) ─────────
# cortex#1848: the personal ai.meta-factory.cortex.work.plist template (which
# hardcoded CORTEX_AGENT_NAME=luna / CORTEX_AGENT_ID=luna-work) is gone. work
# is just another slug now — same generic template as everything else.
printf '\n=== render_stack_plist: work (generic template) ===\n'

WORK_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"

render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "work" "${MOCK_BIN}/bun"
assert_file_exists "work plist rendered" "${WORK_DST}"
assert_contains "work plist contains label" "ai.meta-factory.cortex.work" "$(cat "${WORK_DST}")"
assert_contains "work plist CORTEX_CHANNEL substituted from slug" "work" "$(cat "${WORK_DST}")"
assert_not_contains "work plist has no leftover __STACK_SLUG__ placeholder" "__STACK_SLUG__" "$(cat "${WORK_DST}")"
assert_not_contains "work plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${WORK_DST}")"
assert_not_contains "work plist carries no CORTEX_AGENT_NAME (vestigial, removed)" "CORTEX_AGENT_NAME" "$(cat "${WORK_DST}")"
assert_not_contains "work plist carries no CORTEX_AGENT_ID=luna-work (personal identity, removed)" "luna-work" "$(cat "${WORK_DST}")"
assert_not_contains "work plist carries no luna identity (personal identity, removed)" "luna" "$(cat "${WORK_DST}")"

# ─── Section 5: render_stack_plist — generic (halden) ─────────────
printf '\n=== render_stack_plist: halden (generic template) ===\n'

GENERIC_TEMPLATE="${REPO_ROOT}/src/services/ai.meta-factory.cortex.stack.plist"
HALDEN_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"

if [ -f "${GENERIC_TEMPLATE}" ]; then
  render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "halden" "${MOCK_BIN}/bun"
  assert_file_exists "halden plist rendered via generic template" "${HALDEN_DST}"
  assert_contains "halden plist label correct" "ai.meta-factory.cortex.halden" "$(cat "${HALDEN_DST}")"
  assert_contains "halden plist --config flag correct" "cortex.halden.yaml" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover STACK_SLUG" "__STACK_SLUG__" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover CONFIG_FILE" "__CONFIG_FILE__" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${HALDEN_DST}")"
else
  fail "generic stack template missing: ${GENERIC_TEMPLATE}"
fi

# ─── Section 6: render_stack_plist — missing config removes stale plist
printf '\n=== render_stack_plist: stale plist cleanup ===\n'

# Create a stale plist for a stack whose config was deleted.
STALE_SLUG="vanished"
STALE_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.${STALE_SLUG}.plist"
touch "${STALE_DST}"
# Do NOT create cortex.vanished.yaml — the config is absent.

render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "${STALE_SLUG}" "${MOCK_BIN}/bun" || true
assert_file_not_exists "stale plist removed when config absent" "${STALE_DST}"

# ─── Section 7: render_cortex_plists drives relay + all stacks ────
printf '\n=== render_cortex_plists (integration) ===\n'

# Only runs on Darwin; skip on other hosts but still count the skip.
if [ "$(uname)" = "Darwin" ]; then
  # Reset LAUNCH_DIR for a clean run.
  rm -f "${LAUNCH_DIR}"/*.plist 2>/dev/null || true
  # Config dir has: cortex.yaml, cortex.work.yaml, cortex.halden.yaml (from above).
  render_cortex_plists "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}"

  RELAY_PLIST="${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
  assert_file_exists "relay plist rendered by render_cortex_plists" "${RELAY_PLIST}"
  assert_file_exists "meta-factory plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.meta-factory.plist"
  assert_file_exists "work plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"
  assert_file_exists "halden plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"
else
  printf '  ⊘ render_cortex_plists integration test skipped (non-Darwin host)\n'
fi

# ─── Section 8: config-split (directory layout) — cortex#717 ─────
printf '\n=== config-split layout: discovery + render (cortex#717) ===\n'

# Build a config dir that mirrors TONIGHT'S LIVE STATE after migration 0003:
#   - per-stack dirs (meta-factory/, work/, halden/) each with
#     system/system.yaml + a <slug>.yaml sentinel + stacks/<slug>.yaml
#   - retained root monoliths (cortex.yaml, cortex.work.yaml,
#     cortex.halden.yaml) left as rollback anchors.
# Expected: discover {meta-factory, work, halden} from the DIRS (not doubled),
# the root monoliths IGNORED, and each plist --config = the per-stack sentinel.
SPLIT_DIR="${TMPBASE}/split-config"
SPLIT_LAUNCH="${TMPBASE}/split-LaunchAgents"
mkdir -p "${SPLIT_LAUNCH}"

for s in meta-factory work halden; do
  mkdir -p "${SPLIT_DIR}/${s}/system" "${SPLIT_DIR}/${s}/stacks"
  # Directory-layout marker.
  cat > "${SPLIT_DIR}/${s}/system/system.yaml" <<EOF
nats:
  url: nats://127.0.0.1:4222
EOF
  # Per-stack sentinel (pointer; loader resolves dir = dirname).
  printf '' > "${SPLIT_DIR}/${s}/${s}.yaml"
  # The composed stack file — carries stack.id + agents[].id.
  cat > "${SPLIT_DIR}/${s}/stacks/${s}.yaml" <<EOF
stack:
  id: andreas/${s}
agents:
  - id: agent-${s}
    token: "fake"
EOF
done

# Retained root monoliths (rollback anchors) — MUST be ignored.
printf 'agents:\n  - id: monolith-agent\n' > "${SPLIT_DIR}/cortex.yaml"
printf 'agents:\n  - id: monolith-agent\n' > "${SPLIT_DIR}/cortex.work.yaml"
printf 'agents:\n  - id: monolith-agent\n' > "${SPLIT_DIR}/cortex.halden.yaml"

# --- discovery: exactly the three dir slugs, monoliths deduped away ---
SPLIT_SLUGS="$(discover_stack_slugs "${SPLIT_DIR}")"
assert_contains "split: discovers meta-factory (from dir)" "meta-factory" "${SPLIT_SLUGS}"
assert_contains "split: discovers work (from dir)" "work" "${SPLIT_SLUGS}"
assert_contains "split: discovers halden (from dir)" "halden" "${SPLIT_SLUGS}"
SPLIT_COUNT="$(discover_stack_slugs "${SPLIT_DIR}" | wc -l | tr -d ' ')"
assert_eq "split: 3 dirs + 3 monoliths → 3 slugs (not doubled)" "3" "${SPLIT_COUNT}"

# --- resolve_stack_config_path: per-stack sentinel, NOT the monolith ---
assert_eq "split: meta-factory --config = dir sentinel" \
  "${SPLIT_DIR}/meta-factory/meta-factory.yaml" \
  "$(resolve_stack_config_path "${SPLIT_DIR}" "meta-factory")"
assert_eq "split: work --config = dir sentinel" \
  "${SPLIT_DIR}/work/work.yaml" \
  "$(resolve_stack_config_path "${SPLIT_DIR}" "work")"
assert_eq "split: halden --config = dir sentinel" \
  "${SPLIT_DIR}/halden/halden.yaml" \
  "$(resolve_stack_config_path "${SPLIT_DIR}" "halden")"

# --- resolve_stack_agent_config_path: stacks/<slug>.yaml under dir layout ---
assert_eq "split: meta-factory agent-config = stacks/<slug>.yaml" \
  "${SPLIT_DIR}/meta-factory/stacks/meta-factory.yaml" \
  "$(resolve_stack_agent_config_path "${SPLIT_DIR}" "meta-factory")"

# --- render meta-factory (generic template): --config points at sentinel ---
# cortex#1848: render_stack_plist no longer reads an agent id at all (the
# __AGENT_NAME__ slot + extract_agent_name were removed with the personal
# meta-factory.plist template), so this only proves the --config path
# resolution stays layout-aware and no agent identity leaks into the output.
render_stack_plist "${REPO_ROOT}" "${SPLIT_LAUNCH}" "${SPLIT_DIR}" "meta-factory" "${MOCK_BIN}/bun"
MF_SPLIT="${SPLIT_LAUNCH}/ai.meta-factory.cortex.meta-factory.plist"
assert_file_exists "split: meta-factory plist rendered" "${MF_SPLIT}"
assert_contains "split: meta-factory --config = sentinel" \
  "${SPLIT_DIR}/meta-factory/meta-factory.yaml" "$(cat "${MF_SPLIT}")"
assert_not_contains "split: meta-factory --config is NOT the monolith" \
  "<string>${SPLIT_DIR}/cortex.yaml</string>" "$(cat "${MF_SPLIT}")"
assert_not_contains "split: meta-factory plist carries no agent id (agent identity no longer rendered)" \
  "agent-meta-factory" "$(cat "${MF_SPLIT}")"
assert_not_contains "split: meta-factory did NOT read monolith agent id" \
  "monolith-agent" "$(cat "${MF_SPLIT}")"
assert_not_contains "split: meta-factory no leftover __CONFIG_PATH__" \
  "__CONFIG_PATH__" "$(cat "${MF_SPLIT}")"

# --- render work: --config = sentinel ---
render_stack_plist "${REPO_ROOT}" "${SPLIT_LAUNCH}" "${SPLIT_DIR}" "work" "${MOCK_BIN}/bun"
WORK_SPLIT="${SPLIT_LAUNCH}/ai.meta-factory.cortex.work.plist"
assert_contains "split: work --config = sentinel" \
  "${SPLIT_DIR}/work/work.yaml" "$(cat "${WORK_SPLIT}")"
assert_not_contains "split: work no leftover __CONFIG_PATH__" \
  "__CONFIG_PATH__" "$(cat "${WORK_SPLIT}")"

# --- render halden (generic template): --config = sentinel; unique PID name ---
render_stack_plist "${REPO_ROOT}" "${SPLIT_LAUNCH}" "${SPLIT_DIR}" "halden" "${MOCK_BIN}/bun"
HALDEN_SPLIT="${SPLIT_LAUNCH}/ai.meta-factory.cortex.halden.plist"
assert_contains "split: halden --config = sentinel" \
  "${SPLIT_DIR}/halden/halden.yaml" "$(cat "${HALDEN_SPLIT}")"
# PID-collision lesson (migration 0003): each stack's log/PID name carries the
# unique slug, never cortex-cortex*. The generic template keys log paths off
# __STACK_SLUG__, so assert the slug-unique name is present and no collision.
assert_contains "split: halden log path uses unique cortex-halden name" \
  "cortex-halden.log" "$(cat "${HALDEN_SPLIT}")"
assert_not_contains "split: halden no cortex-cortex PID collision" \
  "cortex-cortex" "$(cat "${HALDEN_SPLIT}")"
assert_not_contains "split: halden no leftover __CONFIG_PATH__" \
  "__CONFIG_PATH__" "$(cat "${HALDEN_SPLIT}")"

# ─── Section 9: dir-wins dedup when only ONE stack is split ───────
printf '\n=== config-split layout: mixed (one split, others monolith) ===\n'

# work is split (dir), meta-factory + halden remain pure monoliths. Expect all
# three discovered, work from the dir, the other two from monoliths.
MIXED_DIR="${TMPBASE}/mixed-config"
mkdir -p "${MIXED_DIR}/work/system" "${MIXED_DIR}/work/stacks"
cat > "${MIXED_DIR}/work/system/system.yaml" <<EOF
nats:
  url: nats://127.0.0.1:4222
EOF
printf '' > "${MIXED_DIR}/work/work.yaml"
printf 'stack:\n  id: andreas/work\nagents:\n  - id: agent-work\n' > "${MIXED_DIR}/work/stacks/work.yaml"
# Monoliths for all three (work's monolith is the retained rollback anchor).
printf 'agents:\n  - id: m\n' > "${MIXED_DIR}/cortex.yaml"
printf 'agents:\n  - id: m\n' > "${MIXED_DIR}/cortex.work.yaml"
printf 'agents:\n  - id: m\n' > "${MIXED_DIR}/cortex.halden.yaml"

MIXED_COUNT="$(discover_stack_slugs "${MIXED_DIR}" | wc -l | tr -d ' ')"
assert_eq "mixed: 3 slugs (work deduped to dir, mf+halden from monolith)" "3" "${MIXED_COUNT}"
assert_eq "mixed: work resolves to dir sentinel" \
  "${MIXED_DIR}/work/work.yaml" \
  "$(resolve_stack_config_path "${MIXED_DIR}" "work")"
assert_eq "mixed: meta-factory resolves to monolith (no dir)" \
  "${MIXED_DIR}/cortex.yaml" \
  "$(resolve_stack_config_path "${MIXED_DIR}" "meta-factory")"
assert_eq "mixed: halden resolves to monolith (no dir)" \
  "${MIXED_DIR}/cortex.halden.yaml" \
  "$(resolve_stack_config_path "${MIXED_DIR}" "halden")"

# ─── Section 10: stack.id slug authority + drift detection (cortex#810) ─
printf '\n=== extract_stack_id_slug + warn_stack_identity_drift (cortex#810) ===\n'

# extract_stack_id_slug: trailing segment of stack.id, NOT confused by the
# sibling principal.id / agents[].id keys (both also use `id:`).
ID_DIR="${TMPBASE}/idslug"
mkdir -p "${ID_DIR}"
cat > "${ID_DIR}/aligned.yaml" <<'EOF'
principal:
  id: andreas
stack:
  id: andreas/community
  nkey_seed_path: ~/x.nk
agents:
  - id: luna
EOF
assert_eq "extract_stack_id_slug: andreas/community → community" \
  "community" "$(extract_stack_id_slug "${ID_DIR}/aligned.yaml")"

# principal.id appears BEFORE stack.id and uses the same `id:` key — must not win.
cat > "${ID_DIR}/principal-first.yaml" <<'EOF'
principal:
  id: jc
  displayName: JC
stack:
  id: jc/default
agents:
  - id: fern
EOF
assert_eq "extract_stack_id_slug: skips principal.id, reads stack.id" \
  "default" "$(extract_stack_id_slug "${ID_DIR}/principal-first.yaml")"

# CRLF line endings must NOT leave a trailing \r in the slug (#811 review MAJOR:
# a stray \r makes id_slug != slug on every upgrade → spurious drift warning).
printf 'principal:\r\n  id: andreas\r\nstack:\r\n  id: andreas/crlf\r\nagents:\r\n  - id: luna\r\n' \
  > "${ID_DIR}/crlf.yaml"
assert_eq "extract_stack_id_slug: CRLF config → no trailing CR" \
  "andreas/crlf-strip-check" \
  "andreas/$(extract_stack_id_slug "${ID_DIR}/crlf.yaml")-strip-check"

# Quoted + trailing-comment id → unwrapped, comment stripped.
printf 'stack:\n  id: "andreas/quoted"  # the canonical id\n' > "${ID_DIR}/quoted.yaml"
assert_eq "extract_stack_id_slug: quoted + comment → quoted" \
  "quoted" "$(extract_stack_id_slug "${ID_DIR}/quoted.yaml")"

# Absent stack.id → non-zero exit (caller falls back to filename locator).
printf 'agents:\n  - id: m\n' > "${ID_DIR}/no-stack.yaml"
if extract_stack_id_slug "${ID_DIR}/no-stack.yaml" >/dev/null 2>&1; then
  fail "extract_stack_id_slug: no stack.id should return non-zero"
else
  pass "extract_stack_id_slug: no stack.id returns non-zero"
fi

# Missing file → non-zero exit.
if extract_stack_id_slug "${ID_DIR}/does-not-exist.yaml" >/dev/null 2>&1; then
  fail "extract_stack_id_slug: missing file should return non-zero"
else
  pass "extract_stack_id_slug: missing file returns non-zero"
fi

# warn_stack_identity_drift: SILENT when locator slug == stack.id slug. The
# SPLIT_DIR fixture (Section 8) has dir <slug> and stack.id andreas/<slug> —
# perfectly aligned, like Andreas's real stacks.
ALIGNED_WARN="$(warn_stack_identity_drift "${SPLIT_DIR}" 2>&1 >/dev/null)"
assert_eq "warn_stack_identity_drift: aligned stacks → no warning" "" "${ALIGNED_WARN}"

# warn_stack_identity_drift: WARNS on drift. Build JC's case — dir 'meta-factory'
# but stack.id 'jc/default'.
DRIFT_DIR="${TMPBASE}/drift-config"
mkdir -p "${DRIFT_DIR}/meta-factory/system" "${DRIFT_DIR}/meta-factory/stacks"
cat > "${DRIFT_DIR}/meta-factory/system/system.yaml" <<EOF
nats:
  url: nats://127.0.0.1:4222
EOF
printf '' > "${DRIFT_DIR}/meta-factory/meta-factory.yaml"
printf 'stack:\n  id: jc/default\nagents:\n  - id: fern\n' \
  > "${DRIFT_DIR}/meta-factory/stacks/meta-factory.yaml"

DRIFT_WARN="$(warn_stack_identity_drift "${DRIFT_DIR}" 2>&1 >/dev/null)"
assert_contains "warn_stack_identity_drift: drift names the locator slug" \
  "meta-factory" "${DRIFT_WARN}"
assert_contains "warn_stack_identity_drift: drift names the stack.id slug" \
  "default" "${DRIFT_WARN}"
assert_contains "warn_stack_identity_drift: drift mentions reconcile" \
  "Reconcile" "${DRIFT_WARN}"
# The warning must go to STDERR, never stdout (stdout is the slug stream that
# discover_stack_slugs' callers consume). Capture stdout only — must be empty.
DRIFT_STDOUT="$(warn_stack_identity_drift "${DRIFT_DIR}" 2>/dev/null)"
assert_eq "warn_stack_identity_drift: nothing on stdout (stderr-only)" "" "${DRIFT_STDOUT}"

# ─── Summary ──────────────────────────────────────────────────────
printf '\n'
printf 'Results: %d passed, %d failed\n' "${PASS}" "${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
