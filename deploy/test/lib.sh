# deploy/test/lib.sh — tiny shared helpers for the container bench (cortex#2284).
#
# Sourced by container-compose.sh. Provides logging, the exit-coded assertion
# ledger, and a generic poll-until helper. No side effects at source time.
#
# Contract (cortex#2284 §3): the FIRST failing assertion is named on stderr,
# a summary table always prints, and the exit code is 0 iff every assertion
# passed.

# ── Logging ──────────────────────────────────────────────────────────────────

log() { printf 'bench: %s\n' "$*"; }
warn() { printf 'bench: %s\n' "$*" >&2; }

# ── Assertion ledger ─────────────────────────────────────────────────────────
# Groups are recorded in order as "<status>\t<group>\t<detail>". PASS/FAIL/SKIP.

BENCH_RESULTS=()
BENCH_FAILED=""

record_pass() { # group detail
  BENCH_RESULTS+=("PASS	$1	${2:-}")
  log "PASS: $1${2:+ — $2}"
}

record_skip() { # group detail
  BENCH_RESULTS+=("SKIP	$1	${2:-}")
  log "SKIP: $1${2:+ — $2}"
}

# Record a failure. The first failure is remembered so the exit path can name
# it on stderr (the issue's exit contract). Does NOT exit — the caller decides
# (container-compose.sh fails fast via bench_fail).
record_fail() { # group detail
  BENCH_RESULTS+=("FAIL	$1	${2:-}")
  warn "FAIL: $1${2:+ — $2}"
  if [ -z "${BENCH_FAILED}" ]; then BENCH_FAILED="$1"; fi
}

# Print the summary table (always — pass or fail).
print_summary() {
  printf '\n'
  printf '── bench summary ─────────────────────────────────────────────\n'
  printf '%-6s %-34s %s\n' 'STATUS' 'ASSERTION GROUP' 'DETAIL'
  # ${#…[@]} guard: expanding an EMPTY array under `set -u` errors on the
  # bash 3.2 that macOS hosts still ship.
  local row
  [ "${#BENCH_RESULTS[@]}" -eq 0 ] && { printf '(no assertions ran)\n'; }
  for row in ${BENCH_RESULTS[@]+"${BENCH_RESULTS[@]}"}; do
    printf '%-6s %-34s %s\n' "$(cut -f1 <<<"${row}")" "$(cut -f2 <<<"${row}")" "$(cut -f3 <<<"${row}")"
  done
  printf '──────────────────────────────────────────────────────────────\n'
}

# ── Polling ──────────────────────────────────────────────────────────────────
# wait_for <timeout-seconds> <interval-seconds> <description> <cmd...>
# Runs <cmd...> until it exits 0 or the timeout elapses. Returns the command's
# last status (0 on success, nonzero on timeout).
wait_for() {
  local timeout="$1" interval="$2" desc="$3"
  shift 3
  local waited=0
  while true; do
    if "$@" >/dev/null 2>&1; then
      log "ready after ${waited}s: ${desc}"
      return 0
    fi
    if [ "${waited}" -ge "${timeout}" ]; then
      warn "timed out after ${waited}s waiting for: ${desc}"
      return 1
    fi
    sleep "${interval}"
    waited=$((waited + interval))
  done
}
