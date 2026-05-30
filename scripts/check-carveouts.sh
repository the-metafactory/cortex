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
# Plain bash + grep. No dependencies.

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
PAT_OPERATOR='\b[Oo]perator\b'
PAT_BOTCONFIG='\bBotConfig(Schema)?\b'
PAT_BROADCAST_EMIT='distribution_mode[[:space:]]*[:=][[:space:]]*["'"'"']broadcast'
PAT_PERSONA='\bpersona\b'

# ──────────────────────────────────────────────────────────────────────────
# CARVE-OUT FILE PATHS — enumerated allowlist (0002 §1257 + §48).
# A hit located in one of these paths is NEVER a violation.
# Matched as substrings against the (repo-relative) file path.
# ──────────────────────────────────────────────────────────────────────────
ALLOWLIST_PATHS=(
  # (1) NSC/NATS account operator — no dedicated file; handled by line filter.
  # (2/4) GROVE_* env tier — the principal-env fallback + its tests + bindings.
  'src/taps/cc-events/hooks/lib/principal-env.ts'
  'src/taps/cc-events/hooks/__tests__/'
  'src/taps/cc-events/wrangler.toml'
  # (3) migrate-config legacy reader + legacy fixtures.
  'src/cli/cortex/commands/migrate-config-lib.ts'
  'src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts'
  'src/cli/cortex/commands/__tests__/migrate-config.test.ts'
  # (4) frozen SQL DDL — historical migrations, never edited.
  'src/surface/mc/worker/migrations/0001'
  'src/surface/mc/worker/migrations/0002'
  'src/surface/mc/worker/migrations/0003'
  'src/surface/mc/worker/migrations/0004'
  # The 0002 manifest itself enumerates every deprecated term as prose.
  'docs/migrations/0001-vocabulary-grilled-2026-05.md'
  'docs/migrations/0002-vocabulary-finish-2026-05.md'
  # The gate's own source + CI definition necessarily NAME the deprecated
  # terms (regex patterns + doc comments). Allowlist them so diff-mode runs
  # that touch the gate don't self-flag. (Whole-tree mode scans only src/+docs/
  # so these never appear there; this matters for the `-` per-PR-diff path.)
  'scripts/check-carveouts.sh'
  '.github/workflows/'
)

# ──────────────────────────────────────────────────────────────────────────
# CARVE-OUT LINE PATTERNS — a matched line is dropped when it ALSO matches one
# of these (extended regex, OR-joined). This covers carve-outs that live
# line-by-line rather than file-by-file.
# ──────────────────────────────────────────────────────────────────────────
CARVEOUT_LINE_PATTERNS=(
  # Explicit historical markers.
  '//[[:space:]]*historical:'
  '<!--[[:space:]]*historical'
  # (1) NSC / NATS account operator vocabulary.
  '\bOP_[A-Z0-9]'
  '\bnsc\b'
  'accountSigningKey'
  'operator-account'
  'operator[[:space:]]+(NKey|JWT|account)'
  '(NKey|JWT|account)[[:space:]]+operator'
  # (2/4) GROVE_* env tier (separate migration).
  'GROVE_OPERATOR'
  'GROVE_[A-Z]'
  # (5) grove historical references + grove-bot NATS link name.
  'grove-v2'
  'grove-dashboard'
  'grove-bot'
  # (6) platform-bot contexts.
  'trustedBotIds'
  'botUserId'
  'message\.author\.bot'
  'author\.bot'
  # (7) myelin-GATED transition shims — MUST NOT flag (wait for myelin cut).
  '\{org\}'                                   # R4 placeholder shim
  'orgFrom(Config|Envelope)'                  # R4 symmetry helpers (shim era)
  'target_assistant[[:space:]]*\?\?[[:space:]]*target_principal'  # R10 shim
  'identity[[:space:]]*\?\?[[:space:]]*(stamp\.|signer\.|opts\.signedBy.*)?principal' # R11 shim
  '\.identity[[:space:]]*\?\?'                # R11 shim (generic identity ?? form)
  # R5 broadcast-reader tolerance: shim-doc lines that carry an explicit
  # deprecated/back-compat note stay until myelin R11.
  '(deprecated alias|back-compat|transition schema still accepts)'
  # (8) the "Operator vision" reference label.
  'Operator vision'
)

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

# ── myelin-GATED transition-test files (R5/R10/R11 back-compat regression
#    suites). The bare fixture line `distribution_mode: "broadcast"` (R5) and
#    `target_principal` / `signed_by[].principal` (R10/R11) fixture values in
#    these files exercise the read-tolerance shim and carry no per-line marker,
#    so they're suppressed here rather than by the line-pattern filter. These
#    suites delete when the corresponding myelin breaking cut lands.
#    Ref 0002 §R5 (envelope-validator.test.ts:333,339,396), §R10, §R11. ──
GATED_TEST_PATHS=(
  'src/bus/myelin/__tests__/envelope-validator.test.ts'
  'src/bus/myelin/__tests__/runtime.test.ts'
)
path_is_gated_test() {
  local path="$1" entry
  for entry in "${GATED_TEST_PATHS[@]}"; do
    case "$path" in
      *"$entry"*) return 0 ;;
    esac
  done
  return 1
}
# Gated-shim terms that are allowed to appear in a gated transition-test file.
GATED_TERM_RE='broadcast|target_principal|\bprincipal\b'

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
declare -a TERM_PATTERNS=("$PAT_OPERATOR" "$PAT_BOTCONFIG" "$PAT_BROADCAST_EMIT")
[[ "$CHECK_PERSONA" -eq 1 ]] && TERM_PATTERNS+=("$PAT_PERSONA")
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
