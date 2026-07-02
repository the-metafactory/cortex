#!/usr/bin/env bash
#
# check-carveouts.sh — the 0002 vocabulary-migration ratchet.
#
# This is the grep-based check that 0002 §"0001-carve-out self-check" (line 84)
# specifies as TODO. It FAILS (exit non-zero) when any UNGATED R-cluster
# deprecated term appears as a LIVE VIOLATION in src/ or docs/, EXCLUDING the
# carve-out allowlist enumerated in 0002 §"Completion signal" (line 1257) and
# §"Carve-out summary" (line 48).
#
# Reference: docs/migrations/0002-vocabulary-finish-2026-05.md
#
# What it FAILS on (ungated, must-rename clusters):
#   R1/R2/R8/R13  operator / Operator prose + symbols  → principal / network
#   R2            operatorId / operator_id / operator_pubkey
#   R2            OperatorConfig / OperatorKey / OperatorRecord / OperatorSchema
#   R2.J          home_operator policy-schema field
#   §6            operator.input / operator.curation MC eventKinds
#   R7.A          BotConfig / BotConfigSchema daemon-config type
#   R5 (emit)     distribution_mode emission of "broadcast"
#   R6 (opt-in)   persona as a domain term (see --persona; off by default
#                 because persona: field + personas/ path are carve-outs)
#
# What it DOES NOT fail on (carve-outs / myelin-GATED transition shims):
#   - NSC / NATS account "operator": OP_* names, operator NKey/JWT, `nsc`,
#     accountSigningKey, operator-account.
#   - GROVE_OPERATOR_* and the wider GROVE_* env tier (separate migration,
#     retires at MIG-8).
#   - migrate-config-lib.ts legacy reader + migrate-config*.test.ts fixtures.
#   - Frozen SQL DDL: src/surface/mc/worker/migrations/0001-0004 (+ later
#     historical migration files).
#   - grove-v2 / grove-dashboard / grove-bot historical refs + the "grove-bot"
#     NATS link client-name.
#   - Platform-bot contexts: trustedBotIds, botUserId, message.author.bot.
#   - myelin-GATED transition shims (R4 {org}, R5 broadcast-reader tolerance,
#     R10 target_assistant ?? target_principal, R11 stamp.identity ?? .principal)
#     — these wait for the myelin breaking cut and MUST NOT be flagged.
#   - The "Operator vision" reference label.
#   - Lines marked `// historical:` or `<!-- historical -->`.
#
# Usage:
#   scripts/check-carveouts.sh                  # scan whole tree (src/ + docs/)
#   scripts/check-carveouts.sh --persona        # also flag persona domain term
#   scripts/check-carveouts.sh FILE [FILE...]   # scan a passed file-list
#   scripts/check-carveouts.sh -                # read NUL/newline file-list on stdin
#   git diff --name-only origin/main | scripts/check-carveouts.sh -   # per-PR diff
#
# Exit codes:
#   0  clean — no ungated live violations
#   1  one or more live violations found (printed as file:line:text)
#   2  usage / environment error
#
# Plain bash + grep + jq. The deprecated-term patterns and the carve-out
# allowlist are read from scripts/vocab-ratchet.json (compass#98 F17), generated
# by scripts/gen-vocab-ratchet.ts from CONTEXT.md _Avoid_. Fail-closed if the
# manifest is missing/malformed.

set -euo pipefail

# ── Resolve repo root (so the allowlist paths are stable regardless of cwd) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

CHECK_PERSONA=0

# ──────────────────────────────────────────────────────────────────────────
# DEPRECATED-TERM PATTERNS (extended regex, OR-joined per pass).
#
# Pass 1 is the broad word-boundary `operator`/`Operator` sweep that catches
# R1/R2/R2.J/R8/R13/§6 in one go (operatorId, operator_id, OperatorConfig,
# OperatorKey, OperatorRecord, OperatorSchema, home_operator, operator.input,
# operator.curation, and bare prose `operator`). The carve-out filter below
# removes the legitimate hits (NSC OP_*, GROVE_OPERATOR_*, platform bot, etc.).
#
# Pass 2 catches the BotConfig daemon-config type (R7.A) WITHOUT tripping on
# platform-bot vocabulary, which the carve-out filter handles separately.
#
# Pass 3 catches actual EMISSION of the broadcast distribution_mode (R5);
# the reader-side union/shim is myelin-gated and excluded by construction
# (we only match `distribution_mode ... = / : "broadcast"`, i.e. a write).
# ──────────────────────────────────────────────────────────────────────────
# Widened from `\b[Oo]perator\b` to bare `[Oo]perator` so the recall catches
# camelCase/snake_case compounds the word-boundary form was BLIND to — operatorId,
# operator_id, home_operator, OperatorConfig, operatorRole, isOperator (the R2
# identifier cluster, ~190 live sites). The carve-out filter below removes the
# legitimate non-principal senses (NSC operatorAccount, policy authz-role literal,
# R7-gated operatorDiscordId, EventBridge comparison operator). Verified no
# `cooperat*` false-friends in the tree.
#
# F18 (compass#98) — added the all-caps `OPERATOR` alternate so the recall also
# catches SCREAMING_SNAKE operator forms the `[Oo]perator` recall was BLIND to:
# `OPERATOR_ID`, `OPERATOR_PUBKEY`, `HOME_OPERATOR`, etc. (env-var / constant /
# SQL-column casing). We add a specific alternate rather than switching the whole
# grep to `-i`: `-i` over-broadens past the carve-out line-filter tuning (it would
# also match mixed-case noise like `OpErAtor` and defeat the case-sensitive
# carve-outs). The legitimate all-caps survivors (NSC `OPERATOR_MODE*` constants,
# the `GROVE_OPERATOR` env tier, fake test-fixture IDs, the policy-role
# `OPERATOR_POLICY` fixture) are carved by the path/line allowlist below.
# The pattern VALUES (and the carve-out allowlist below) are no longer hard-coded
# here — they are loaded from the manifest (compass#98 F17). The semantics above
# still describe what each pattern catches; the strings live in the JSON.
#
# ──────────────────────────────────────────────────────────────────────────
# LOAD THE MACHINE-READABLE MANIFEST (compass#98 F17).
#
# scripts/vocab-ratchet.json (generated by scripts/gen-vocab-ratchet.ts from
# CONTEXT.md _Avoid_ + this gate's allowlist) is the ONE source the merge gate
# and the review lens both read. Requires jq (preinstalled on GitHub ubuntu
# runners). FAIL-CLOSED: a missing / malformed / empty manifest exits 2 — the
# gate never passes vacuously by silently loading zero patterns.
# ──────────────────────────────────────────────────────────────────────────
MANIFEST="${REPO_ROOT}/scripts/vocab-ratchet.json"

command -v jq >/dev/null 2>&1 || {
  printf 'check-carveouts: jq is required to read %s\n' "$MANIFEST" >&2
  exit 2
}
[[ -f "$MANIFEST" ]] || {
  printf 'check-carveouts: manifest not found at %s\n' "$MANIFEST" >&2
  exit 2
}
jq -e . "$MANIFEST" >/dev/null 2>&1 || {
  printf 'check-carveouts: manifest %s is not valid JSON\n' "$MANIFEST" >&2
  exit 2
}

# Portable (bash 3.2 — no mapfile): read a jq expression into a named bash array.
read_json_into() {
  local __name="$1" __expr="$2" __line
  eval "$__name=()"
  while IFS= read -r __line; do
    [[ -n "$__line" ]] && eval "$__name+=(\"\$__line\")"
  done < <(jq -r "$__expr" "$MANIFEST")
}

read_json_into MANIFEST_TERM_PATTERNS    '.terms[] | select(.optIn | not) | .pattern'
read_json_into MANIFEST_PERSONA_PATTERNS '.terms[] | select(.optIn) | .pattern'
read_json_into ALLOWLIST_PATHS           '.carveouts.paths[]'
read_json_into CARVEOUT_LINE_PATTERNS    '.carveouts.linePatterns[]'
read_json_into GATED_TEST_PATHS          '.carveouts.gatedTestPaths[]'
GATED_TERM_RE="$(jq -r '.carveouts.gatedTermPattern // empty' "$MANIFEST")"

# FAIL-CLOSED: empty required data means the manifest failed to load — refuse.
if [[ ${#MANIFEST_TERM_PATTERNS[@]} -eq 0 || ${#ALLOWLIST_PATHS[@]} -eq 0 \
      || ${#CARVEOUT_LINE_PATTERNS[@]} -eq 0 || -z "$GATED_TERM_RE" ]]; then
  printf 'check-carveouts: manifest %s produced empty term/carve-out data — refusing to run (fail-closed)\n' "$MANIFEST" >&2
  exit 2
fi


usage() {
  grep -E '^# ' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

# ── Build the carve-out line filter as one ERE alternation ──
build_carveout_filter() {
  local IFS='|'
  printf '%s' "${CARVEOUT_LINE_PATTERNS[*]}"
}

# ── Is this file path on the enumerated allowlist? ──
path_is_allowlisted() {
  local path="$1" entry
  for entry in "${ALLOWLIST_PATHS[@]}"; do
    case "$path" in
      *"$entry"*) return 0 ;;
    esac
  done
  return 1
}

# ── myelin-GATED transition-test files (R5 back-compat regression suite).
#    The bare fixture line `distribution_mode: "broadcast"` (R5) in
#    envelope-validator.test.ts exercises the read-tolerance shim and carries
#    no per-line marker, so it's suppressed here rather than by the line-pattern
#    filter. This entry deletes when the myelin R5/R11 `broadcast`→`offer`
#    breaking cut lands (f5ec865 still ACCEPTS `broadcast` on read).
#    Ref 0002 §R5 (envelope-validator.test.ts).
#
#    Removed at the #81 / cortex#436 myelin re-pin (4c54b8e → f5ec865, R10/R13
#    breaking cut on `target_principal`):
#      - runtime.test.ts — its R4 `{org}` substitution test retired with
#        myelin#185 and it carries no broadcast-emit / target_principal /
#        signed_by-principal fixture; the only deprecated-term hit is the
#        historical `agent.operatorId/operatorName` comment, which the
#        standalone `agent.operator(Id|Name)` line carve-out already covers.
#      - runtime-principal-symmetry.test.ts — carries zero deprecated-term
#        hits (all `principal:` refs are the canonical `source.principal`
#        field), so it no longer needs file-level suppression. ──
path_is_gated_test() {
  local path="$1" entry
  for entry in "${GATED_TEST_PATHS[@]}"; do
    case "$path" in
      *"$entry"*) return 0 ;;
    esac
  done
  return 1
}

# ── Collect the target file list ──
declare -a TARGETS=()
read_stdin_list=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --persona) CHECK_PERSONA=1; shift ;;
    -) read_stdin_list=1; shift ;;
    --) shift; while [[ $# -gt 0 ]]; do TARGETS+=("$1"); shift; done ;;
    -*) printf 'check-carveouts: unknown option %s\n' "$1" >&2; usage 2 ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

if [[ "$read_stdin_list" -eq 1 ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && TARGETS+=("$line")
  done
fi

# Default scope: the whole tree (src/ + docs/), text files only.
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  while IFS= read -r f; do
    TARGETS+=("$f")
  done < <(find src docs -type f \
            \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
               -o -name '*.md' -o -name '*.sql' -o -name '*.yaml' -o -name '*.yml' \
               -o -name '*.toml' -o -name '*.json' \) 2>/dev/null | sort)
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  printf 'check-carveouts: no files to scan\n' >&2
  exit 0
fi

# ── Assemble the deprecated-term pattern alternation for this run ──
declare -a TERM_PATTERNS=("${MANIFEST_TERM_PATTERNS[@]}")
if [[ "$CHECK_PERSONA" -eq 1 && ${#MANIFEST_PERSONA_PATTERNS[@]} -gt 0 ]]; then
  TERM_PATTERNS+=("${MANIFEST_PERSONA_PATTERNS[@]}")
fi
TERM_RE="$(IFS='|'; printf '%s' "${TERM_PATTERNS[*]}")"
CARVEOUT_RE="$(build_carveout_filter)"

violations=0

for f in "${TARGETS[@]}"; do
  [[ -f "$f" ]] || continue                       # skip deleted/renamed paths
  # Normalise a leading ./ so allowlist substring matches are stable.
  rel="${f#./}"
  path_is_allowlisted "$rel" && continue

  # In myelin-gated transition-test files, suppress the gated-shim terms
  # (broadcast / target_principal / .principal) that have no per-line marker.
  extra_filter="$CARVEOUT_RE"
  if path_is_gated_test "$rel"; then
    extra_filter="${CARVEOUT_RE}|${GATED_TERM_RE}"
  fi

  # grep -nE: numbered matches of any deprecated term.
  # Then drop any line that ALSO matches a carve-out line pattern.
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    violations=$((violations + 1))
    printf '%s:%s\n' "$rel" "$hit"
  done < <(grep -nE "$TERM_RE" -- "$f" 2>/dev/null \
             | grep -vE "$extra_filter" || true)
done

echo "──────────────────────────────────────────────────────────────"
if [[ "$violations" -gt 0 ]]; then
  printf 'check-carveouts: FAIL — %d ungated deprecated-term live violation(s)\n' "$violations" >&2
  printf 'See docs/migrations/0002-vocabulary-finish-2026-05.md for the rename map.\n' >&2
  exit 1
fi

printf 'check-carveouts: PASS — no ungated deprecated-term live violations\n'
exit 0
