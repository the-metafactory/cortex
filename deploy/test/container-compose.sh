#!/usr/bin/env bash
#
# deploy/test/container-compose.sh — the container-compose regression bench
# (cortex#2284): the manual OrbStack release ritual, scripted as a one-command,
# exit-coded gate.
#
#   bun run bench:container            # from the repo root
#   CORTEX_REF=my-branch bun run bench:container   # bench a branch build
#   deploy/test/container-compose.sh --keep        # leave the stack up after
#
# What it guards (assert-only — it never changes compose/Dockerfile; a failing
# assertion that exposes a product bug gets FILED, not fixed here):
#   1. no-eacces          — no EACCES in cortex logs (#2269 volume-perms guard)
#   2. volume-ownership   — the three named volumes' _data owned by uid 1000
#                           (#2269 guard)
#   3. quickstart-steps   — steps 1–7 ✓, step 8 "deferred", and no
#                           '"status": "error"' in logs (#2275 honest gate)
#   4. boot-lines         — "cortex quickstart: complete ✓" + "cortex: starting"
#   5. healthcheck-flip   — daemon bus link up ("connected to nats"), compose
#                           health flips healthy, then `stop nats` flips it
#                           unhealthy within 90s (#2275 /connz guard)
#
# Exit contract: 0 = all assertions pass; nonzero = first failing assertion
# named on stderr. A summary table always prints. Fail-fast: groups after the
# first failure are reported SKIP.
#
# STAGING (why a work dir): docker-compose.yaml declares `env_file: .env`,
# which compose resolves relative to the COMPOSE FILE's directory. The bench
# must (a) never read a developer's real, secret-bearing deploy/compose/.env
# and (b) never write into deploy/compose/ (assert-only). So it stages the
# compose inputs (docker-compose.yaml, Dockerfile.cortex, docker-entrypoint.sh,
# nats.conf, .dockerignore) plus the placeholder fixture AS `.env` into
# deploy/test/.work/ (git-ignored) and runs compose from there. The staged
# files are byte-copies — nothing is edited.
#
# Fixtures are PLACEHOLDER-ONLY (fixtures/.env.bench): dummy tokens, numeric
# placeholder snowflakes. Never put real values there (confidentiality rule).
#
# Requirements: a Linux-semantics docker host (OrbStack / Docker on Linux)
# with `docker compose` v2+. First run builds the image (network required).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="${SCRIPT_DIR}/../compose"
FIXTURE="${SCRIPT_DIR}/fixtures/.env.bench"
WORKDIR="${SCRIPT_DIR}/.work"
PROJECT="cortex-bench"

# The three named volumes from docker-compose.yaml, namespaced by -p (#2269).
VOLUMES=("${PROJECT}_cortex-config" "${PROJECT}_cortex-state" "${PROJECT}_cortex-nats")

# Timeouts (seconds). HEALTHY_TIMEOUT = cortex healthcheck start_period (90s)
# + 30s (issue spec). UNHEALTHY_TIMEOUT = the 90s /connz-guard budget.
BOOT_LOG_TIMEOUT=120
HEALTHY_TIMEOUT=120
UNHEALTHY_TIMEOUT=90

# shellcheck source=deploy/test/lib.sh
. "${SCRIPT_DIR}/lib.sh"

KEEP=0
for arg in "$@"; do
  case "${arg}" in
    --keep) KEEP=1 ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "unknown argument: ${arg} (supported: --keep)"; exit 2 ;;
  esac
done

compose() {
  docker compose -p "${PROJECT}" \
    --env-file "${WORKDIR}/.env" \
    -f "${WORKDIR}/docker-compose.yaml" "$@"
}

cortex_logs() { compose logs --no-color cortex 2>/dev/null; }

# NOTE: capture-then-grep, NOT `cortex_logs | grep -q` — under `set -o
# pipefail`, grep -q exits on first match, SIGPIPEs `docker compose logs`
# (exit 141), and the pipeline would report failure precisely when the
# string IS present.
logs_contain() { grep -qF -- "$1" <<<"$(cortex_logs)"; }

# Health state of the cortex service per `docker compose ps` (issue spec).
cortex_health() {
  compose ps --format json cortex 2>/dev/null \
    | grep -o '"Health": *"[^"]*"' | head -n1 | sed 's/.*"Health": *"\([^"]*\)".*/\1/'
}

health_is() { [ "$(cortex_health)" = "$1" ]; }

teardown() {
  if [ "${KEEP}" -eq 1 ]; then
    log "--keep: leaving the stack up for debugging."
    log "  inspect: docker compose -p ${PROJECT} --env-file ${WORKDIR}/.env -f ${WORKDIR}/docker-compose.yaml ps"
    log "  teardown later: docker compose -p ${PROJECT} --env-file ${WORKDIR}/.env -f ${WORKDIR}/docker-compose.yaml down -v --remove-orphans"
    return 0
  fi
  log "teardown: down -v (removing ${PROJECT} containers + volumes)…"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}

finish() { # exit-code
  local rc="$1"
  teardown
  print_summary
  if [ "${rc}" -ne 0 ]; then
    warn "bench FAILED — first failing assertion: ${BENCH_FAILED:-unknown}"
  else
    log "bench PASSED — all assertion groups green."
  fi
  exit "${rc}"
}

# ── Assertion groups ─────────────────────────────────────────────────────────

# 1. #2269 guard: the volume-perms fix means no EACCES ever appears in logs.
group_no_eacces() {
  if grep -q "EACCES" <<<"$(cortex_logs)"; then
    record_fail "no-eacces" "cortex logs contain EACCES (volume-perms regression, #2269)"
    return 1
  fi
  record_pass "no-eacces" "no EACCES in cortex logs"
}

# 2. #2269 guard: each named volume's _data is owned by uid 1000 (the image's
#    cortex user), copied from the pre-created mount points (Dockerfile 8a).
group_volume_ownership() {
  local vol uid ok=1 details=""
  for vol in "${VOLUMES[@]}"; do
    uid="$(docker run --rm -v "${vol}:/v" alpine stat -c '%u' /v 2>/dev/null || echo "stat-failed")"
    if [ "${uid}" != "1000" ]; then
      record_fail "volume-ownership" "${vol} owned by uid '${uid}', expected 1000 (#2269)"
      ok=0
      break
    fi
    details="${details}${vol}=1000 "
  done
  [ "${ok}" -eq 1 ] || return 1
  record_pass "volume-ownership" "${details% }"
}

# 3. #2275 guard: quickstart steps 1–7 all ✓, step 8 explicitly deferred, and
#    no '"status": "error"' anywhere in the logs (the honest-gate contract).
group_quickstart_steps() {
  local logs n
  logs="$(cortex_logs)"
  for n in 1 2 3 4 5 6 7; do
    if ! grep -Eq "── ${n}\. .* ✓ ──" <<<"${logs}"; then
      record_fail "quickstart-steps" "step ${n} missing or not ✓ in cortex logs (#2275)"
      return 1
    fi
  done
  if ! grep -qF "deferred to supervisor healthcheck" <<<"${logs}"; then
    record_fail "quickstart-steps" "step 8 'deferred to supervisor healthcheck' line missing (#2275)"
    return 1
  fi
  if grep -qF '"status": "error"' <<<"${logs}"; then
    record_fail "quickstart-steps" "logs contain '\"status\": \"error\"' (#2275)"
    return 1
  fi
  record_pass "quickstart-steps" "steps 1-7 ✓, step 8 deferred, no error envelope"
}

# 4. Boot lines: provisioning completed green and the daemon took over PID 1.
group_boot_lines() {
  if ! logs_contain "cortex quickstart: complete ✓"; then
    record_fail "boot-lines" "'cortex quickstart: complete ✓' missing from cortex logs"
    return 1
  fi
  if ! logs_contain "cortex: starting"; then
    record_fail "boot-lines" "'cortex: starting' missing from cortex logs"
    return 1
  fi
  record_pass "boot-lines" "quickstart complete ✓ + cortex: starting"
}

# 5. #2275 /connz guard: the daemon's own bus link drives compose health.
#    a) daemon connected to the bundled nats ("connected to nats" in logs)
#    b) compose health flips healthy within start_period+30s
#    c) `stop nats` flips it unhealthy within 90s
group_healthcheck_flip() {
  if ! wait_for "${HEALTHY_TIMEOUT}" 5 "'connected to nats' in cortex logs" \
      logs_contain "connected to nats"; then
    record_fail "healthcheck-flip" "'connected to nats' never appeared in cortex logs"
    return 1
  fi
  if ! wait_for "${HEALTHY_TIMEOUT}" 5 "cortex compose health = healthy" \
      health_is "healthy"; then
    record_fail "healthcheck-flip" "cortex never reached health=healthy within ${HEALTHY_TIMEOUT}s (last: $(cortex_health))"
    return 1
  fi
  log "stopping nats to exercise the /connz unhealthy leg…"
  compose stop nats >/dev/null 2>&1
  if ! wait_for "${UNHEALTHY_TIMEOUT}" 5 "cortex compose health = unhealthy after nats stop" \
      health_is "unhealthy"; then
    record_fail "healthcheck-flip" "cortex not unhealthy within ${UNHEALTHY_TIMEOUT}s of nats stop (last: $(cortex_health)) (#2275 /connz guard)"
    return 1
  fi
  record_pass "healthcheck-flip" "bus link up → healthy; nats stop → unhealthy in ≤${UNHEALTHY_TIMEOUT}s"
}

# ── Scenario ─────────────────────────────────────────────────────────────────

main() {
  command -v docker >/dev/null 2>&1 || { warn "docker not found on PATH"; exit 2; }
  docker compose version >/dev/null 2>&1 || { warn "docker compose v2+ required"; exit 2; }
  [ -f "${FIXTURE}" ] || { warn "fixture missing: ${FIXTURE}"; exit 2; }

  log "container-compose bench (cortex#2284) — project ${PROJECT}"
  if [ -n "${CORTEX_REF:-}" ]; then
    log "CORTEX_REF override: ${CORTEX_REF} (flows to the image build via compose interpolation)"
  fi

  # Stage the compose inputs + fixture-as-.env (see STAGING header note).
  rm -rf "${WORKDIR}"
  mkdir -p "${WORKDIR}"
  cp "${COMPOSE_SRC}/docker-compose.yaml" \
     "${COMPOSE_SRC}/Dockerfile.cortex" \
     "${COMPOSE_SRC}/docker-entrypoint.sh" \
     "${COMPOSE_SRC}/nats.conf" \
     "${COMPOSE_SRC}/.dockerignore" \
     "${WORKDIR}/"
  cp "${FIXTURE}" "${WORKDIR}/.env"

  # a) idempotent start: tear down any previous bench stack + volumes.
  log "down -v --remove-orphans (idempotent start)…"
  compose down -v --remove-orphans >/dev/null 2>&1 || true

  # b) build + boot. CORTEX_REF (if exported) reaches the Dockerfile via the
  #    compose `${CORTEX_REF:-…}` build-arg interpolation.
  log "up -d --build (first run builds the image — this can take minutes)…"
  if ! compose up -d --build; then
    record_fail "compose-up" "docker compose up -d --build failed"
    finish 1
  fi

  # Readiness: give provisioning time to finish before asserting on logs.
  wait_for "${BOOT_LOG_TIMEOUT}" 5 "quickstart completion in cortex logs" \
    logs_contain "cortex quickstart: complete ✓" || true

  # c) assertion groups, fail-fast, in issue order.
  local groups=(group_no_eacces group_volume_ownership group_quickstart_steps
                group_boot_lines group_healthcheck_flip)
  local names=(no-eacces volume-ownership quickstart-steps boot-lines healthcheck-flip)
  local i failed=0
  for i in "${!groups[@]}"; do
    if [ "${failed}" -eq 1 ]; then
      record_skip "${names[$i]}" "not reached (fail-fast)"
      continue
    fi
    if ! "${groups[$i]}"; then
      failed=1
    fi
  done

  # d) teardown (unless --keep) + summary + exit code.
  finish "${failed}"
}

main "$@"
