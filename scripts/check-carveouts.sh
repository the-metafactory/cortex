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
# Widened from `\b[Oo]perator\b` to bare `[Oo]perator` so the recall catches
# camelCase/snake_case compounds the word-boundary form was BLIND to — operatorId,
# operator_id, home_operator, OperatorConfig, operatorRole, isOperator (the R2
# identifier cluster, ~190 live sites). The carve-out filter below removes the
# legitimate non-principal senses (NSC operatorAccount, policy authz-role literal,
# R7-gated operatorDiscordId, EventBridge comparison operator). Verified no
# `cooperat*` false-friends in the tree.
PAT_OPERATOR='[Oo]perator'
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
  # CONTEXT.md is the vocabulary CONTRACT — it DEFINES principal, the NSC
  # operator carve-out, and the Mission Control authorization role, and lists
  # the deprecated terms in _Avoid_ / Flagged-ambiguities. Same class as the
  # manifests: a hit here is a definition, never a violation.
  'CONTEXT.md'
  # The gate's own source + CI definition necessarily NAME the deprecated
  # terms (regex patterns + doc comments). Allowlist them so diff-mode runs
  # that touch the gate don't self-flag. (Whole-tree mode scans only src/+docs/
  # so these never appear there; this matters for the `-` per-PR-diff path.)
  'scripts/check-carveouts.sh'
  '.github/workflows/'
  # Policy authorization-role cluster — `operator` here is the reserved
  # authz ROLE / capability literal (CONTEXT.md → Mission Control authorization
  # role; #513), NOT the principal. The policy engine + its fixtures + the
  # cutover design doc carry it as a kept role-id string.
  'src/common/policy/'
  'docs/design-policy-cutover.md'
  # cortex.yaml.example policy roles — the `operator` capability literal in the
  # principal role's `capabilities[]` is the reserved authz CAPABILITY token the
  # PolicyEngine checks (`allow("operator")` in src/common/policy/resolve-access.ts,
  # already allowlisted above), NOT the principal vocabulary. Renaming it would
  # break the worked example. Same class as the `src/common/policy/` cluster.
  # RETIRE: with the `operator` policy-capability literal itself.
  'cortex.yaml.example'
  # User-auth RBAC tier `viewer|operator|admin` — the MC authorization role
  # (CONTEXT.md, #513). A persisted privilege level, never the principal.
  'src/surface/mc/worker/src/user-auth/'
  # EventBridge comparison OPERATOR (equals / anything-but) — a programming
  # term, not the vocab. Single-purpose filter-grammar file.
  'src/bus/payload-filter.ts'
  'src/bus/__tests__/payload-filter.test.ts'
  # R2.I/R3 transition tests: loader.test.ts NAMES the legacy cloud `operatorId`
  # and the flat `api.operatorId` reader on purpose (now flipped to rejection
  # assertions); watcher.test.ts fixtures carry the flat `api.operatorId` slot
  # (carve-out #3 legacy `api` block). Siblings to the migrate-config legacy-reader
  # tests already allowlisted. Class: LEGACY-READER fixtures.
  'src/common/config/__tests__/loader.test.ts'
  'src/common/config/__tests__/watcher.test.ts'
  # NSC trust/signing infrastructure — `operator` = the NATS account operator
  # (cortex#76 trust anchor): OperatorVerifier, verifyOperator, operator pubkey,
  # SA/SO/SU seed hierarchy. Platform term throughout these files.
  'src/common/agents/trust-resolver.ts'
  'src/common/agents/__tests__/trust-resolver-operator-verify.test.ts'
  'src/common/config/account-signing-key.ts'
  'src/common/config/stack-signing-key.ts'
  # NATS connection wrapper — `operator` throughout = NSC operator-mode `.creds`
  # auth + the operator-account signing-key loader it mirrors (cortex#86/#87).
  # A NATS-infrastructure file, never the principal. Class: NSC.
  # RETIRE: never (NSC operator is the permanent qualified survivor).
  'src/bus/nats/connection.ts'
  # NSC operator-account signing TEST fixtures — siblings of the two source files
  # above (already allowlisted). They import nkeys.js `createOperator`, mint
  # SO-prefixed operator seeds, and assert the loader REJECTS them. `operator`
  # throughout = the NATS account-tree root, never the principal. Class: NSC.
  # RETIRE: never (NSC operator is the permanent qualified survivor, CONTEXT.md).
  'src/common/config/__tests__/account-signing-key.test.ts'
  'src/common/config/__tests__/stack-signing-key.test.ts'
  # G1 account-topology design doc — its entire subject is the NSC account tree
  # (operator/account export-import, resolver_preload, leaf-bound accounts). Every
  # "operator" is the NATS account-tree root, never the principal. Class: NSC.
  # RETIRE: never (NSC operator is the permanent qualified survivor, CONTEXT.md).
  'docs/design-g1-account-topology.md'
  # ADR-0013 sovereign federation — its whole subject is the NSC operator/account
  # model (own-operator federation, per-side export/import). Every "operator" is the
  # NATS account-tree root, never the principal. Class: NSC.
  # RETIRE: never (NSC operator is the permanent qualified survivor, CONTEXT.md).
  'docs/adr/0013-sovereign-federation-model.md'
  # HISTORICAL removed-field regression test — describes and guards the
  # v3-REMOVED `config.agent.operatorId` legacy field (cortex#429 PR-C). Its
  # whole purpose is to assert a stray reader of the removed field never creeps
  # back; renaming the token would misdescribe WHAT was removed. Class: HISTORICAL.
  # RETIRE: when the legacy-field-reader guard is no longer worth keeping (post
  # v3.0.0 stabilisation).
  'src/__tests__/principal-identity-consistency.test.ts'
  # Legacy-migration cortex.yaml example configs — `before-*.yaml` is the
  # pre-cutover shape (legacy `operator:` block + `operator` synthetic-principal
  # role), `after-*.yaml` shows the migrated output; README documents the path.
  # They EXIST to demonstrate the migrate-config legacy reader; same class as the
  # migrate-config fixtures. RETIRE: when migrate-config is removed (v3.0.0 cut).
  'docs/migration-examples/'
  # Legacy v2 `.bot.yaml` migrate-config TEST fixtures — carry the deprecated
  # `operatorId:` / `operatorName:` v2 keys (cortex#429 PR-C drop) as INPUT to
  # the migrate-config path. Same class as migrate-config*.test.ts (allowlisted).
  # RETIRE: with the migrate-config CLI removal (v3.0.0 cut).
  'src/cli/cortex/commands/__tests__/fixtures/'
  # Archived v1→v2 cutover note — frozen historical doc describing the legacy
  # `sessions.operator_id` schema drift that the v2 cutover resolved. Class:
  # HISTORICAL (archive). RETIRE: never (archive is immutable).
  'docs/archive/'
  # Policy converter — emits + reads the legacy `operator:` block and the
  # reserved `operator` role/capability literal. Sibling to migrate-config-lib.
  'src/cli/cortex/commands/migrate-config-policy.ts'
  # normalize-config — names the legacy key it renames FROM (`home_operator`)
  # in the UNAMBIGUOUS_RENAME_MAP and in the AMBIGUOUS_KEY_WARNINGS list. Same
  # class as migrate-config-lib.ts: a migration tool that NAMES the deprecated
  # terms in order to rename/detect them. RETIRE: with normalize-config removal.
  'src/cli/cortex/commands/normalize-config.ts'
  'src/cli/cortex/commands/__tests__/normalize-config.test.ts'
  # (normalize-config's fixture needs no entry — the dir-level
  # `__tests__/fixtures/` allowlist above already covers it.)
  # IAW design/plan docs — #510-owned (refreshed); residual hits are
  # code-identifier mentions discussed as prose, tracked on the IAW epic.
  'docs/design-internet-of-agentic-work.md'
  'docs/plan-internet-of-agentic-work.md'
  'src/__tests__/iaw-phase-d-integration.test.ts'
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
  # NSC camelCase/snake forms newly visible under the widened recall.
  '[Oo]peratorAccount'
  '[Oo]peratorVerifier'
  'verify[Oo]perator'
  '[Oo]peratorSign'
  'operator_pubkey'
  'operator-mode'
  '[Oo]peratorRecord'
  # O-3 (cortex#1053) — the NSC operator-JWT / operator-mode-conversion vocabulary
  # that `cortex network join` auto-converts an anonymous bus with. ALL the NSC
  # account-tree sense (the operator JWT the leaf binds under), NEVER the
  # principal. Class: NSC (the permanent qualified survivor). Covers:
  #   - the `OperatorMode*` renderer type/symbol prefix (OperatorModeLeafPackage,
  #     OperatorModeConversion, renderOperatorModeBlocks, convertToOperatorMode);
  #   - the `operatorJwt` field + the `operator_jwt` config key + `--operator-jwt`
  #     flag (the operator JWT, an NSC artifact);
  #   - a rendered `operator:` config line (the operator-mode block this writes).
  '[Oo]peratorMode'
  'operatorJwt'
  'operator_jwt'
  '--operator-jwt'
  'operator:[[:space:]]*\$\{?operatorJwt'
  '`operator:'
  'operator[[:space:]]+(JWT|that owns)'
  # O-3 test fixtures — the operator-mode-conversion suite's NSC vocabulary:
  #   - `foreign-operator` — the bus-type fixture modelling a bus already
  #     operator-mode under a DIFFERENT operator JWT (the never-clobber case);
  #   - a rendered `operator: eyJ…` block line + its `A_DIFFERENT_OPERATOR` fake;
  #   - the design-doc filename `…-operator-onboarding.md`.
  # All the NSC account-tree sense, never the principal. Class: NSC.
  'foreign-operator'
  'operator: eyJ'
  'A_DIFFERENT_OPERATOR'
  'operator-onboarding'
  # NSC operator-account signing seed/nkey file paths (`operator.nk`, `operator.nkey`,
  # `operator.creds`). The NATS account-tree root seed (CONTEXT.md → NSC operator);
  # a filesystem path to the operator-account key, never the principal. Class: NSC.
  'operator\.(nk|nkey|creds|seed)'
  # R7-gated network.operator block (operatorDiscordId/Mattermost/Slack) — the
  # held R7 wire fields; rename waits for the myelin {org}→{principal} cut.
  'operator(DiscordId|MattermostId|SlackId|PlatformIds|Role|RoleId)'
  # ── LEGACY config-key tokens (R2.D/R2.I/R2.G + cortex#429 PR-C) ────────────
  # v4.0.0 BREAKING CUT (#536) — the transition-era legacy config-key READERS are
  # GONE: cloud `operatorId` (config.ts `acceptLegacyCloudPrincipalId`), federated
  # `operator_id`/`operator_pubkey` (cortex-config.ts `acceptLegacyFederatedPeerPrincipal`),
  # and the top-level `operator:` block (loader.ts `DualBlockConflictError`) are all
  # deleted, and the cloud/peer schemas are `.strict()` canonical-only. `operatorId`
  # is therefore FULLY RATCHETED: the bare token-global carve (`operator(Id|Name)\b`,
  # `\boperator_id\b`) has been REMOVED so a fresh `operatorId` in a NEW src/ file
  # FAILS the gate. The narrow patterns below carve only the genuine SURVIVORS, each
  # anchored to its distinctive non-principal context:
  #
  #   (a) the flat `api.operatorId` bot.yaml LEGACY READER (carve-out #3) — the
  #       in-loader sibling of migrate-config-lib: reads an old bot.yaml's flat
  #       `api.operatorId` and rewrites it to the canonical cloud `principalId`.
  #       Its source file (loader.ts) + the watcher fixtures that feed the `api`
  #       block are path-allowlisted below; the single schema-slot declaration in
  #       config.ts is line-carved here.
  #   (b) HISTORICAL prose describing the v3-REMOVED PR-C fields — always the
  #       dotted `agent.operatorId` / `config.agent.operatorId` / `agent.operatorName`
  #       (and slash-compounds) accessor form. A new genuine field declaration is
  #       never written as a dotted `agent.`-prefixed accessor in a comment.
  #   (c) the `operatorId → principalId` / `operator_id → principal_id` RENAME-MAP
  #       prose (cloud.ts emitter doc, cloud-publisher comment, migration DDL prose)
  #       — documents WHAT was renamed; carries an explicit rename arrow.
  #
  # GROVE `payload.operator_id` (event-processor) keeps its own pattern below; NSC
  # `operator_pubkey` / `operator-mode` keep theirs; the frozen `idx_sessions_operator`
  # DDL keeps its own.
  # (a) flat `api.operatorId` legacy-reader schema slot (config.ts:447 declaration +
  #     reader/fixture lines). The bare `api.operatorId` accessor + the lone
  #     `operatorId: z.string().default("")` slot.
  '\bapi\.operatorId\b'
  'operatorId:[[:space:]]*z\.string\(\)\.default\(""\)'
  'agent\.operatorId'                                       # (b) bot.yaml legacy accessor + PR-C prose
  # (b) HISTORICAL prose describing the removed PR-C `agent.operator*` fields —
  # the dotted accessor form (incl. `config.agent.operatorId`, `agent.operatorName`,
  # `agent.operatorId/operatorName`, `agent.operatorId/Discord`).
  'agent\.operator(Id|Name)'
  'operatorId/(operatorName|Discord)'
  # (c) RENAME-MAP prose carrying an explicit arrow: `operatorId → principalId`,
  # `operator_id → principal_id`, `operator_id` → `principal_id` (DDL prose).
  'operator(Id|_id)[^A-Za-z]{0,4}(→|->)[^A-Za-z]{0,4}principal'
  # (c) misc kept rename-map / emitter doc prose that names the legacy cloud
  # `operatorId:` key it no longer writes, + the dashboard `operatorId` wiring note,
  # + the `expect(...).not.toContain("operatorId:")` assertion guarding the emitter.
  'legacy `operatorId:`'
  'operatorId:"'
  'dashboard.{0,3}`?operatorId'
  # Backtick-QUOTED config-key reference in prose/JSDoc — `operatorId` /
  # `operatorId:` naming the v4-REMOVED cloud key (config.ts cut docstring,
  # NetworkConfig doc, api-reader comment). A fresh genuine field declaration is
  # never backtick-quoted; this only carves prose that NAMES the removed key.
  '`operatorId:?`'
  # frozen-DDL prose: `sessions.operator_id` / `tasks.operator_id` (migration 0004
  # rename note in types.ts + the DDL file itself, already path-allowlisted).
  '(sessions|tasks|github_events|usage_snapshots)\.operator_id'
  # Frozen D1 index identifier — `idx_sessions_operator` is KEPT as the index
  # name in migration 0004 even though its column was renamed to `principal_id`
  # (renaming a live index name is churn with no benefit). A frozen DDL
  # identifier, same class as the allowlisted SQL migrations. RETIRE: never.
  'idx_sessions_operator'
  # GROVE_* event-payload wire key (separate GROVE migration, retires MIG-8):
  # `payload.operator_id` / `p.operator_id` reads in event-processor.ts.
  'payload\.operator_id'
  '\bp\.operator_id'
  # Policy authz-role predicate `isOperatorPrincipal` — exported from
  # src/common/policy/resolve-access.ts (already path-allowlisted); the adapter
  # call sites (discord/mattermost/slack) import it. "is this principal the
  # operator (MC authorization role)?" per CONTEXT.md MC-role. Class: AUTHZ-ROLE.
  # Stays a GLOBAL carve — it's the policy authz predicate, not a principal id.
  'isOperatorPrincipal'
  # Adapter-local `isOperator(authorId)` method (mattermost/slack adapters) — the
  # per-adapter "is this author the MC-authorization-role operator?" check. Class:
  # AUTHZ-ROLE, path-scoped to the method-call form so a bare `isOperator`
  # IDENTIFIER outside the adapter method can't free-ride. The bare token-global
  # `\bisOperator\b` carve was REMOVED with the v4.0.0 cut.
  'isOperator\('
  # R4 rename-map PROSE — design/code lines that DOCUMENT the myelin-gated
  # `operator.id` → `principal.id` / `Identity.operator` → `.network` rename by
  # NAMING the pre-rename field. Renaming the token here would destroy the
  # description of WHAT is being renamed (same logic as the HISTORICAL class).
  # RETIRE with the myelin R4 breaking cut (#168/#171). Scoped to lines that
  # carry an explicit rename arrow so it cannot mask a bare live `operator`.
  'operator(\.id|`)?[[:space:]]*(→|->|renamed|is being renamed)'
  '(renamed|rename)[[:space:]]*`?operator'
  # Legacy `operator:` CONFIG-BLOCK reader (R3 transition + buildLegacyNetwork).
  # The top-level `operator:` cortex.yaml block is the v2 key the loader still
  # ACCEPTS (and migrate-config rewrites to `principal:`); same class as the
  # already-allowlisted loader.test.ts R3 dual-block-guard. Matches the backtick-
  # quoted prose key, the `raw.operator` / `hasOperator` reader symbols, and the
  # `network.operator` held-block assignment. RETIRE: v3.0.0 breaking cut deletes
  # the legacy reader (manifest PR-11).
  '`operator:`'
  # `operator.id` legacy-block field accessor — the dotted field on the legacy
  # `operator:` cortex.yaml block. The only live code reads are in the
  # already-allowlisted migrate-config-lib reader; every other occurrence is R4
  # rename-map prose in design docs documenting `operator.id` → `principal.id`
  # (myelin-gated R4 cut, design-bus-addressing.md §201). Class: LEGACY-BLOCK / R4.
  # RETIRE: v3.0.0 legacy-reader deletion + myelin R4 cut.
  '\boperator\.id\b'
  '\braw\.operator\b'
  '\bhasOperator\b'
  '\bnetwork\.operator\b'
  'operator:[[:space:]]*z\.object'              # R7 held network.operator block schema
  'operator:.*→.*principal:|`operator:`→`principal:`'  # R3 transition prose
  # `operator` POLICY CAPABILITY / authz-role literal in prose — "is this
  # principal an operator?" decisions consult the PolicyEngine `operator`
  # capability (CONTEXT.md MC authorization role). Class: AUTHZ-ROLE (kept).
  'an operator\?|`operator`[[:space:]]*(capability|role)'
  "'operator',?[[:space:]]*'code-reviewer'"     # role-id example string (cortex-config.ts)
  # Legacy federated-peer `operator_*` keys (R2.G reader) — the cortex-config.ts
  # acceptLegacyPeer reader prose/code naming the deprecated `operator_*` peer
  # keys it rewrites to `principal_*`. Same class as the cloud `operatorId`
  # reader. RETIRE: v3.0.0 cut. (`operator_pubkey`/`operator_id` tokens already
  # covered; this catches the `operator_*` glob prose.)
  'operator_\*'
  'operator\*Id'                                # removed-field glob prose (loader.ts:452)
  # Config-shape detection prose naming the legacy `operator:` block alongside
  # the canonical `principal:` key (loader.ts detectConfigShape). LEGACY-BLOCK.
  'principal/operator'
  # Policy authz-role literal appearing in NON-policy test fixtures (bus/runner
  # dispatch tests): `role: ["operator"]`, `id: "operator"`, `role("operator"`.
  '(role|roles|id|capability|allow)[^A-Za-z]{1,4}["(]operator'
  # Authz-role literal in YAML config EXAMPLES (cortex-config.ts header doc,
  # design-soma-integration.md policy block): `role: [operator]` / `roles: [operator]`
  # — the MC/policy authorization role (CONTEXT.md #513), kept. Bracket-list form
  # the quoted pattern above misses. Class: AUTHZ-ROLE.
  '\broles?:[[:space:]]*\[operator'
  # (2/4) GROVE_* env tier (separate migration).
  'GROVE_OPERATOR'
  'GROVE_[A-Z]'
  # (5) grove historical references + grove-bot NATS link name.
  'grove-v2'
  'grove-dashboard'
  'grove-bot'
  # Historical grove-v2 doc filename whose NAME carries the legacy term; the
  # file itself is bannered/path-allowlisted. Bare references to it (e.g. the
  # G-1113 plan's banner-target list) are filename citations, not vocab usage.
  'design-dm-operator-channel'
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
GATED_TEST_PATHS=(
  'src/bus/myelin/__tests__/envelope-validator.test.ts'
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
