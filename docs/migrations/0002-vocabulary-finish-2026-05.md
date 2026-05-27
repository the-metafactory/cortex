# Cortex — Vocabulary Migration Finish Plan (2026-05)

**Status:** draft for review · deterministic ground truth · iteration 2 (continuation of [0001](./0001-vocabulary-grilled-2026-05.md))
**Source:** 0001 manifest + audit of `origin/main` at HEAD `6a398bc`
**Companion manifests:** [myelin#164](https://github.com/the-metafactory/myelin/pull/164) (merged), pilot#136
**Method:** every entry below was produced by `grep -rn` against `origin/main` at `6a398bc`. Each cited `file:line` is a real occurrence at that commit; nothing is inferred. Cross-cluster cascades and historical/transitional carve-outs are flagged.

Read this as the script: each PR claims one rename or one cluster, performs every listed change, runs `bun test && bunx tsc --noEmit`, opens for review.

This manifest **completes** the 0001 rename. Some clusters shipped fully at the v3.0.0 cutover (already on `main` at v3.0.3); others remain `PARTIAL` because the v3.0.0 cut prioritised the schema/loader breaking change and deferred the long-tail internal-variable + wire-cascade renames. This plan enumerates every remaining live violation and assigns each to a follow-up PR.

cortex is currently at **v3.0.3** (`arc-manifest.yaml`). The major bump and `OperatorConfig` / `operator:` schema removal already shipped (cortex#430, cortex#432). What remains is **internal renaming** + **wire-cascade lockstep with myelin**.

---

## Per-cluster status — recap

| # | Rename | 0001 Status | This-plan Status | Notes |
|---|---|---|---|---|
| R1 | `OperatorConfig` → `PrincipalConfig` | type+schema | **DONE** (v3.0.0) | Only stale doc-comments remain. |
| R2 | `operatorId` (variable/JSON/env) → `principalId` | code+tests+env | **PARTIAL** (~367 live hits) | cortex.ts entrypoint converted (cortex#430); downstream APIs (`verifySignedByChain`, `BusDispatchListener`, MC API, `event-processor`, `cloud-publisher`) still take `operatorId`. |
| R3 | `operator.id` (cortex.yaml key) → `principal.id` | schema+migrate-config | **DONE** (v3.0.0) | `PrincipalConfigSchema` is canonical; transition `operator:` alias removed. migrate-config rewrites legacy → canonical. |
| R4 | `{org}` subject → `{principal}` | code+tests | **PARTIAL — gated by myelin R7** | cortex accepts both placeholders; envelope-validator + runtime ship the transition shim. |
| R5 | `"broadcast"` → `"offer"` | code+tests | **PARTIAL — gated by myelin R11** | cortex emits only `"offer"`; readers tolerate `"broadcast"`. Awaiting myelin's breaking cut. |
| R6 | `persona` (domain term) → `assistant` | code+comments | **NOT DONE** (~212 hits in TS) | Filename `personas/luna.md` stays; `persona:` schema field is a *path-to-filename* and stays per the field-name-is-a-pointer-to-filename rule. Domain-term prose + variable names rename. |
| R7 | `bot` daemon → `agent` | code+comments+service names | **PARTIAL** (`BotConfig` type live in 38 files; `grove-bot` literals in comments + NATS link name) | Service plists already cortex-named. `BotConfig` rename is the main surface. |
| R8 | MC copy "operator cockpit"/"operator filter" | dashboard UI prose | **NOT DONE** | Literal phrases "operator cockpit", "operator filter" still in 3 files. Plus the wider operator/Operator/Operators prose throughout MC backend + design docs (overlaps R13). |
| R9 | `CORTEX_OPERATOR_*` → `CORTEX_PRINCIPAL_*` | env+plists+docs | **DONE** (v3.0.0) | `principal-env.ts` confirms compat shim removed at v3.0.0. Deeper `GROVE_OPERATOR_*` tier intentionally remains as a separate migration. |
| R10 | `target_principal` → `target_assistant` | wire field | **PARTIAL — gated by myelin R13** | Transition shim in place: `getTargetAssistant()` reads `target_assistant ?? target_principal`. Awaiting myelin's breaking cut. |
| R11 | `signed_by[].principal` → `.identity` | wire field | **PARTIAL — gated by myelin R2** | Transition shim in place everywhere: `stamp.identity ?? stamp.principal`. Awaiting myelin's breaking cut. |
| R12 | "Reach" → "Scope" (docs) | docs only | **NOT DONE** (1 live header) | `docs/design-internet-of-agentic-work.md:66`. The other two hits are unrelated (one is a `migration` note about the myelin grammar issue; one is a code-comment "Reach in: replace…" — not the column header). |
| R13 | Prose `operator` → `principal`/`network` | prose | **NOT DONE** (~1,200 hits total in src/ + docs/) | The dominant remaining surface. Split per host file. Some hits cascade-resolve from R2/R7; the residue is true prose. |

---

## Tier classification — what counts as "LIVE VIOLATION"

To prevent re-naming sites that 0001 carved out, every hit is bucketed:

- **LIVE VIOLATION** — active code/schema/current docs that uses the deprecated term. **Must rename.**
- **HISTORICAL ALLOWED** — describes what we migrated FROM (grove-v2, bot.yaml legacy reader, v0.x compat). **Leave alone.**
- **PLATFORM TERM** — Discord/Slack/Mattermost `bot`-the-user, NATS infra `OP_*`. **Leave alone.**
- **TRANSITIONAL** — migrate-config's intentional acceptance of legacy field names for back-compat; transition-window readers that accept both old & new. **Leave alone; remove at next breaking major after lockstep myelin cut.**
- **AMBIGUOUS** — needs principal decision; flagged in Open Questions.

---

## Carve-out summary (re-stated, expanded)

The following sites are explicitly **allowed** under 0001 and remain so:

1. **`migrate-config-lib.ts` legacy reader** — reads bot.yaml `operator:` block and rewrites to `principal:`. The legacy-field names (`a.operatorId`, `legacy.operator`, etc.) are required by the input shape. Allow-listed by 0001 §"Renames this manifest does NOT make".
2. **`migrate-config-policy.test.ts` fixtures** — inline `operator:` YAML blocks are testing the legacy migration path. Stay.
3. **Synthesised `agent.operatorId` in loader (`src/common/config/loader.ts:438`)** — TRANSITIONAL. The loader emits the legacy in-memory `BotConfig.agent.operatorId` field so downstream consumers (which still read `BotConfig.agent.*`) keep working. Retires together with the BotConfig rename (R7).
4. **`GROVE_OPERATOR_*` env fallback tier in `principal-env.ts`** — pre-cortex env-var namespace. Owned by the separate `GROVE_*` → `CORTEX_*` migration (retires at MIG-8 per `postinstall.sh`).
5. **`GROVE_CHANNEL` / `GROVE_NETWORK` / `GROVE_AGENT_*` in `taps/cc-events/hooks/`** — same `GROVE_*` namespace migration. Not in 0001 scope.
6. **`grove-bot` literal in `nats/connection.ts:109`** — the NATS link client-name. Wire/observability tag. Stays until a separate observability-rename PR (would be visible on a `nats stream` or `nats sub` listing — not a vocab violation per se).
7. **`bot` in `adapters/discord/`, `slack/`, `mattermost/`** — "Discord bot user", "Mattermost bot account". Platform term. Stays.
8. **NSC `OP_*` account names** — NATS infra. Same R12b carve-out as myelin.
9. **`grove-v2` / `grove-dashboard` references** — historical / CF Pages project name. Stay.
10. **MC design docs lifted verbatim from grove-v2** (`docs/design-mission-control.md`) — large prose blocks describing the legacy system. Rename the *active* prose; leave the *historical* sections alone (call them out explicitly).

---

## 0001-carve-out self-check

This plan is a continuation of 0001. Every carve-out 0001 declared MUST remain a carve-out in 0002. Without an explicit audit trail, a sweeping prose-rename PR could catch a 0001 carve-out site by accident.

Each R-cluster's "Live Violations" list below has been audited against the carve-out registry. Assertion: **0 instances** of the following appear in any R-cluster's Live Violations list (only in carve-out sections):

| Carve-out | 0001 reference | 0002 audit query | Status |
|---|---|---|---|
| GitHub org URL (`the-metafactory/*`, `meta-factory.ai/.dev/.io`, `metafactory.io`) | 0001 §"Renames this manifest does NOT make" | `grep -rEn 'meta-factory\.(ai|dev|io)\|the-metafactory/\|metafactory\.io' src/ docs/` (~554 hits) | ✅ none in any R-cluster live-violation list |
| NSC `OP_*` account names | 0001 R12b | `grep -rEn '\\bOP_[A-Z]+\\b' src/ docs/` | ✅ none in any R-cluster live-violation list |
| `grove-v2` / `grove-dashboard` historical references | Carve-out #9 | `grep -rEn 'grove-v2\|grove-dashboard' src/ docs/` | ✅ enumerated only under R7.B as HISTORICAL ("Extracted from grove-v2"); none in live-violations |
| `bot` in Discord/Slack/Mattermost platform-user contexts | Carve-out #7 + R7 carve-outs | `grep -rEn '\\b(trustedBotIds\|botUserId\|messageCreate.*bot)\\b' src/` | ✅ none in R7 live-violations; explicit carve-out in R7 |
| `migrate-config-lib.ts` legacy reader (`operator:` block, `operatorId`, etc.) | Carve-out #1 + #2 | `grep -En '\\boperator\\b' src/cli/cortex/commands/migrate-config-lib.ts` | ✅ all hits TRANSITIONAL / HISTORICAL, none in live-violations |
| `GROVE_OPERATOR_*` env fallback tier (`principal-env.ts`) | Carve-out #4 | `grep -rEn 'GROVE_OPERATOR' src/` | ✅ enumerated only under R9 "Carve-out (deeper tier still alive)"; never in live-violations |
| `GROVE_CHANNEL`/`GROVE_NETWORK`/`GROVE_AGENT_*` in `taps/cc-events/hooks/` | Carve-out #5 | `grep -rEn 'GROVE_(CHANNEL\|NETWORK\|AGENT)' src/taps/cc-events/hooks/` | ✅ none in any R-cluster live-violation list |
| `grove-bot` NATS link name | Carve-out #6 (until Open Q §5 decided) | `grep -rEn '"grove-bot"' src/` | Now resolved (§5: rename to `cortex` — see R7.B); pre-decision it was a carve-out, post-decision it moves to R7.B live-violations. Self-check passes. |
| MC design-doc historical sections | Carve-out #10 | `grep -En '^#' docs/design-mission-control.md` (section headers) | Pending §9 decision (now resolved: full rewrite — see R13.D); historical sections preserved in a "History" appendix per §9 resolution. |

**Process assertion for each PR-N**:
- Before merge, run a 4-line check script (`./scripts/check-carveouts.sh` — TODO; trivial `grep` wrapper) over the touched files in the diff. The check asserts 0 hits of the carve-out patterns above (excluding lines explicitly marked `// historical:`, `<!-- historical -->`, or located under an enumerated carve-out file path).
- The PR description includes a "Carve-outs preserved" checkbox listing which carve-outs the touched files brush against and confirming no hit.

This section is the audit trail. If a future PR catches a carve-out site silently, the regression is on the reviewer; the plan asserts the matrix above is the canonical list.

---

## R1 — `OperatorConfig` → `PrincipalConfig`

**Status:** DONE at v3.0.0 (cortex#388 cutover, evidenced by `src/common/types/cortex-config.ts:140–143`: "`OperatorSchema` / `Operator` deprecated aliases were removed at v3.0.0"). The canonical name is `PrincipalConfigSchema` / `PrincipalConfig`.

### Residual stale doc-comments referencing the old name

These are **dead references** — the symbol they cite no longer exists. They mislead readers into searching for `OperatorSchema`. Rename in passing as part of PR-R13a (prose sweep):

- `src/common/types/stack.ts:66` — `OperatorSchema.id` → `PrincipalConfigSchema.id`
- `src/common/types/stack.ts:84` — `OperatorSchema.dataResidency` → `PrincipalConfigSchema.dataResidency`
- `src/common/types/stack.ts:161` — `OperatorSchema`-conformant → `PrincipalConfigSchema`-conformant
- `src/common/types/stack.ts:192` — `OperatorSchema` → `PrincipalConfigSchema`
- `src/common/types/capability.ts:157` — `OperatorSchema.id` → `PrincipalConfigSchema.id`
- `src/common/types/__tests__/cortex-config.test.ts:132` — `OperatorSchema.id` → `PrincipalConfigSchema.id`
- `src/common/types/__tests__/cortex-config.test.ts:250` — same
- `src/common/types/cortex-config.ts:514` — `OperatorSchema.id` and `StackConfigSchema.id` → `PrincipalConfigSchema.id` and `StackConfigSchema.id`
- `src/common/types/cortex-config.ts:552` — `OperatorSchema.id` → `PrincipalConfigSchema.id`
- `src/common/types/cortex-config.ts:1205` — `OperatorSchema.id` → `PrincipalConfigSchema.id`
- `src/common/types/cortex-config.ts:1359` — comment refers to "peer operator id" with `OperatorSchema.id` — rewrite "peer principal id" with `PrincipalConfigSchema.id`
- `src/common/types/config.ts:274` — `OperatorSchema.discordId/mattermostId/slackId` → `PrincipalConfigSchema.discordId/mattermostId/slackId`
- `src/cortex.ts:311` — "from `OperatorSchema` via `LoadedConfig.operator`" → re-examine entire comment (cascades with R13); also `LoadedConfig.operator` is a real field name that still exists — see R2.
- `src/services/network-registry/src/validate.ts:30` — `OperatorSchema.id` → `PrincipalConfigSchema.id` (network-registry imports from `common/types`)

**Also:** `src/common/types/cortex-config.ts:141` itself contains the "deprecated aliases were removed" obituary comment — keep this comment as the historical breadcrumb for anyone searching for `OperatorSchema`, but rephrase if R13 prose sweep touches it.

**PR scope:** Roll into PR-R13a (prose sweep). Tiny diff.

---

## R2 — `operatorId` (variable / JSON / env) → `principalId`

**Status:** PARTIAL. The cortex.ts entrypoint resolves a canonical `principalId` (cortex#430, `resolvePrincipalId` helper at `src/cortex.ts:347`), but threads it as `operatorId: principalId` into every downstream API that still has the legacy parameter name. **The variable named `principalId` exists; the parameter named `operatorId` it flows into does not yet.**

Total live hits (367): comprises (a) downstream API parameter names, (b) the synthesised `BotConfig.agent.operatorId` field name, (c) test fixtures using the field, (d) the `cloud-publisher` JSON wire field `operator_id`, (e) the network-registry service (treated separately — see Open Questions), (f) the MC db `operator_id` column.

### R2.A — Downstream API parameter renames (Bus + Runner)

These are the immediate next-cut renames. Each function's parameter name changes from `operatorId` → `principalId`; call sites need to update with it.

`src/bus/verify-signed-by-chain.ts`:
- `:177` doc comment
- `:190` `operatorId?: string;` (parameter on `VerifySignedByChainOpts`) → `principalId?: string;`
- `:263` runtime guard message `"verifySignedByChain: cryptoVerify requires opts.operatorId — "`
- `:265` continued guard message
- `:271` `opts.operatorId` → `opts.principalId`
- `:421` `operatorId: string,` (parameter on `verifyOneSignature`) → `principalId: string,`
- `:438` legacy comment "`operatorId` is still cortex's variable name…" — REWRITE: principalId is canonical
- `:440` `network: operatorId` — this maps to envelope `source.org` segment; rename local var

`src/bus/bus-dispatch-listener.ts`:
- `:78` `operatorId: string;` (in `BusDispatchListenerOpts`)
- `:103` `private readonly operatorId: string;`
- `:121` `this.operatorId = opts.operatorId;`
- `:230` `operatorId: this.operatorId,` (passed to `verifySignedByChain`)

`src/runner/dispatch-listener.ts`:
- `:278` doc comment
- `:281` `operatorId?: string;` parameter
- `:386` destructure
- `:420` pass-through
- `:585` `operatorId: string | undefined;` (on `ResolveRoutingOpts`)
- `:603` destructure
- `:690` `...(cryptoVerify && operatorId !== undefined && { operatorId })`
- `:694` comment

`src/runner/agent-team.ts`:
- `:85` doc comment
- `:139` `operatorId: string;` (in `AgentTeamOpts`)
- `:337` `operatorId: string;` (different interface — confirm + rename)
- `:542` debug string `"wire runtime + resolver + receivingAgentId + operatorId + source"`
- `:787` `operatorId: busPeer.operatorId,` — busPeer here is `BusPeerInfra`; the source field renames too (see substrate)

`src/substrates/bus-peer/harness.ts`:
- `:282`–`:283` comment about `operatorId`-missing guard

`src/cortex.ts` — already principalId; the threading sites:
- `:841` comment
- `:843` `const reviewOperatorId = principalId;` → rename local var
- `:951` `operatorId: verifyOperatorId,` — this is calling `verifySignedByChain`; updates with that API
- `:1142–1144` `// The 'operatorId' parameter` + `operatorId: principalId,` — rewrite once parameter rename ships
- `:1839` `// + 'operatorId' so the listener can chain-verify`
- `:1844` `// cortex#427 — 'operatorId' flows from the shared 'principalId'`
- `:1856` `operatorId: principalId,`
- `:1898` `setupDashboard(config, principalId, dispatchHandler, cloudPublisher)` — parameter inside `setupDashboard` is still `operatorId`; see R2.D MC API
- `:2132` `principalId: string,` (this is already done)
- `:2151` `operatorId: principalId,` — passed to dashboard API

**Tests cascading from R2.A:**
- `src/bus/__tests__/verify-signed-by-chain.test.ts`: `:444`, `:495`, `:511` (test name), `:513`–`:514` (comments), `:533` (comment), `:535` (regex match `/operatorId/`).
- `src/bus/__tests__/bus-dispatch-listener.test.ts`: `:157`, `:177`, `:196`.
- `src/runner/__tests__/dispatch-listener.test.ts`: `:1685`, `:1725`, `:1763`, `:1825`, `:1862`, `:1903`, `:2194`.
- `src/runner/__tests__/agent-team.test.ts`: `:45`.
- `src/bus/myelin/__tests__/envelope-validator.test.ts`: `:740`, `:767`.
- `src/bus/myelin/__tests__/runtime.test.ts`: `:20`.
- `src/__tests__/cortex.review-session-opts.test.ts:28`.
- `src/__tests__/cortex.review-consumer-boot.test.ts:60`.
- `src/__tests__/cortex.stack-signing-boot.test.ts:41`.
- `src/__tests__/iaw-phase-b-integration.test.ts`: `:247`, `:255`, `:326`, `:408`, `:469`.
- `src/__tests__/iaw-phase-d-integration.test.ts`: `:147`, `:161`, `:171`, `:393`, `:398`, `:685`, `:690`.
- `src/__tests__/principal-identity-consistency.test.ts`: `:82`, `:134`, `:188` (comment), `:233`, `:278`, `:307`, `:325`, `:332`–`:344`. **Caveat:** this whole file tests the cortex#427 contract; the test names that reference `agent.operatorId` describe the legacy *field* the loader synthesises (R7 cascade), not the parameter name. Renames to the parameter; the legacy-field references stay.
- `src/__tests__/review-roundtrip.integration.test.ts:78`.
- `src/__tests__/cortex.test.ts`: `:52`, `:276`, `:285`, `:304`, `:312`, `:327`.
- `src/__tests__/signed-pilot-roundtrip.test.ts`: `:195`, `:237`, `:262`.
- `src/__tests__/cortex.capability-boot.test.ts:56`.

### R2.B — `event-processor.ts` parameter

`src/common/event-processor.ts`:
- `:74` `operatorId: string,` (on `processEvent`)
- `:79`, `:82`, `:84`, `:86` — pass-through
- `:91` (`processTaskStarted`), `:107` `operatorId: eventOperator ?? operatorId,`
- `:125` (`processTaskCompleted`), `:154` same shape
- `:172` (`processUsageUpdate`), `:198` same
- `:212` (`processProgressEvent`), `:235` same
- `:192` *comment* `// Prefer per-event operator_id (from GROVE_OPERATOR_ID env var)` — note the env var is the deeper grove-* tier (carve-out #4). Rewrite as: "Prefer per-event `principal_id` (resolved by `resolvePrincipalEnv`)…"

Cascades to `src/common/types.ts:81` and `:107` (`operatorId?: string;` on event-shape types).

### R2.C — Cloud publisher wire field `operator_id`

`src/taps/cc-events/cloud-publisher.ts`:
- `:7` doc comment "NetworkResolver function looks up endpoint/apiKey/operatorId per network" → rewrite (R2 cascade)
- `:200` `operator_id: networkConfig.operatorId,` — this is a JSON wire field POSTed to the cloud worker. **Decision needed:** rename the wire field to `principal_id`? See Open Questions.

`src/taps/cc-events/__tests__/cloud-publisher.test.ts`:
- `:29`, `:35` `operatorId: string` (test helper param).

`src/taps/cc-events/cc-events.ts`:
- `:72`, `:139`, `:241` — doc comments referencing `agent.operatorId` (legacy field — R7 cascade).

### R2.D — Mission Control API `operatorId`

`src/surface/mc/worker/src/routes/state.ts`:
- `:274` `operatorId: r.operator_id as string | null,` — JSON output shape
- `:431` same
- `:61` comment "populate the operator filter" — R8 prose
- `:447` same

`src/surface/mc/worker/src/routes/ingest.ts`:
- `:26` `type Variables = { operatorId: string; operatorKey: OperatorKey };`
- `:36`, `:54`, `:158`, `:217`, `:301` — pass-through

`src/surface/mc/worker/src/routes/sync.ts`:
- `:12` — same `Variables` shape

`src/surface/mc/worker/src/auth.ts`:
- `:62` comment, `:65` parameter
- `:88` `const operatorId = keyData.operator_id ?? (keyData as any).operatorId ?? "";` — wire-field
- `:89` audit-log identity
- `:90` `c.set("operatorId", operatorId);`

**Caveat — MC API forms a JSON contract.** Renaming `operatorId` → `principalId` on the wire is a breaking API change for any external consumer. See Open Questions.

#### R2.D — `OperatorKey` symbol (MC worker auth type)

The MC worker auth layer types its API-key payload as `OperatorKey`. This is a typed in-memory shape with a thin storage/wire surface (D1 / KV).

Declaration:
- `src/surface/mc/worker/src/auth.ts:54` — `export interface OperatorKey { … }`
- `src/surface/mc/worker/src/auth.ts:65` — parameter on `requireApiKey` (`Variables: { operatorId: string; operatorKey: OperatorKey }`)
- `src/surface/mc/worker/src/auth.ts:82` — `as OperatorKey | null` cast on KV read

Consumers:
- `src/surface/mc/worker/src/routes/admin.ts:15` — `import { requireAdmin, type OperatorKey } from "../auth"`
- `src/surface/mc/worker/src/routes/admin.ts:42` — `const keyData: OperatorKey = { … }` (admin POST `/admin/keys`)
- `src/surface/mc/worker/src/routes/ingest.ts:15` — same import
- `src/surface/mc/worker/src/routes/sync.ts` — same shape (`Variables = { operatorId: string; operatorKey: OperatorKey }`)
- `src/surface/mc/user-auth/README.md:43` — prose `requireApiKey, requireAdmin, OperatorKey ) for bot operators posting` (double-loaded: `bot` + `operator`)

**Classification:** LIVE — rename `OperatorKey` → `PrincipalKey`. The symbol names the API-key payload; "operator" here is the principal/agent posting events, not platform-bot terminology. Renames in the same PR boundary as the rest of R2.D (single-cut breaking; see Open Questions §2).

Cascades:
- The `c.set("operatorKey", …)` setter at `auth.ts` and any `c.get("operatorKey")` call sites rename to `principalKey`.
- The README:43 prose ("bot operators posting") rewrites under R7 (`bot` daemon → `agent`) **and** R13 (`operator` prose → `principal`); it's one of the doubly-loaded sites flagged for an explicit rewrite.

### R2.E — MC `db/schema.ts` `operator_id` SQL column

`src/surface/mc/db/schema.ts:27` — `operator_id TEXT NOT NULL,` (in `tasks` table)

Cascading SQL inserts (test fixtures all do `INSERT INTO tasks (id, title, priority, operator_id, source_system) …`):
- `src/surface/mc/__tests__/sessions-db.test.ts:12`
- `src/surface/mc/__tests__/ingestor.test.ts:14`
- `src/surface/mc/__tests__/schema.test.ts` — `:34`, `:55`, `:68`, `:81`, `:95`, `:106`, `:149`, `:180`, `:188`, `:198`, `:206`, `:221`
- `src/surface/mc/__tests__/task-create-endpoints.test.ts` — `:213`, `:430`, `:703`
- `src/surface/mc/__tests__/events.test.ts:13`
- `src/surface/mc/__tests__/focus-area-ws.test.ts:118`
- `src/surface/mc/__tests__/working-agents.test.ts:35`
- `src/surface/mc/__tests__/endpoint-resolver.test.ts` — `:22`, `:301`
- `src/surface/mc/__tests__/metrics.test.ts:72`
- `src/surface/mc/__tests__/types.test.ts:24`
- `src/surface/mc/__tests__/stdout-dispatcher.test.ts:16`
- `src/surface/mc/__tests__/tasks.test.ts` — `:75`, `:132`, `:169`, `:259`
- And ~10 more cascading test-file inserts.

`src/surface/mc/worker/schema.sql` — D1 schema mirror; same column.

`src/surface/mc/worker/migrations/0003_sovereignty.sql`:
- `:8`, `:22` `home_operator TEXT` (Phase A.5 policy-principal column — see also R-policy below)
- `:24`, `:27` index on `home_operator`

**SQL column rename = data migration**. See Open Questions.

### R2.F — `network-registry` service

`src/services/network-registry/` is a separate Cloudflare-Worker sub-service inside the cortex repo. Its REST surface uses `operator_id` as a path parameter and JSON field. It is currently called by `cloud-publisher.ts` on the cortex side.

- `src/services/network-registry/src/types.ts` — `OperatorRecord`, `operator_id`, `operator_pubkey`. 22 occurrences.
- `src/services/network-registry/src/store.ts` — `RegistryStore.putOperator(operatorId, …)`, `getOperator`, `listOperators`. Interface + InMemoryStore.
- `src/services/network-registry/src/routes/operators.ts` — endpoint `/operators/:operator_id`, `validateRegistrationClaim`, `getOperator`. ~6 hits.
- `src/services/network-registry/src/validate.ts:30` — comment.
- `src/services/network-registry/__tests__/helpers.ts:52,66` — `operatorId` test helper.

The 0001 manifest did not enumerate the network-registry service. See **Open Questions §1**.

### R2.G — Registry client + Adapters

`src/common/registry/types.ts`:
- `:119` `operatorIds: string[];` (on `RegistryClientOptions`)
- `:155` doc comment
- `:163` `getOperator(operatorId: string): OperatorRecord | undefined;`

`src/common/registry/client.ts`:
- `:7`, `:35`, `:223`, `:226`, `:227` doc/method comments
- `:76`, `:123`, `:217`, `:218`, `:226`, `:227`, `:279`, `:281`, `:324`, `:327`, `:331`, `:333`, `:346`–`:451` — full surface; ~30 hits

`src/common/registry/__tests__/client.test.ts` — 16 fixture insertions of `operatorIds: ["…"]`.

These mirror the network-registry wire shape — they rename together.

`src/adapters/discord/index.ts`:
- `:914` `const operatorId = this.infra.operator.discordId;` — local var
- `:915`, `:923`, `:1008`, `:1009`, `:1018` — uses

`src/adapters/slack/index.ts`:
- `:603`, `:604`, `:608` — same shape, `slackId`

`src/adapters/mattermost/index.ts`:
- `:343`, `:344`, `:361` — same shape, `mattermostId`

These are local variables holding the **principal's** Discord/Slack/Mattermost ids (used to DM the principal). Rename the local variable: `operatorId` → `principalDiscordId` (or `principalId` if the surrounding context already disambiguates).

### R2.H — CLI `cloud` command

`src/cli/cortex/commands/cloud.ts`:
- `:120` `operatorId: opts.operatorId,`
- `:446` `const operatorId = flags["operator-id"] ?? "admin";` — CLI flag `--operator-id`. **Decision needed:** rename CLI flag to `--principal-id`? See Open Questions.
- `:461`, `:475`, `:482` — `operator_id` wire field in curl examples
- `:497`, `:524`, `:552`, `:564`, `:577`, `:586` — CLI internal

### R2.I — Config loader + watcher + types

`src/common/types/config.ts`:
- `:183` `operatorId: z.string().min(1),` (in `NetworkConfig` cloud block — required)
- `:269` `operatorId: z.string().optional(),` (in `BotConfig.agent`)
- `:270` "Defaults to operatorId" — doc
- `:274` `OperatorSchema.discordId/…` — R1 cascade
- `:430` `operatorId: z.string().default(""),` (another schema slot)
- `:489` `'{principal}' is substituted with 'agent.operatorId' at runtime` — comment cascade (R2/R7)
- `:558` `operatorId: string;` (`OperatorConfig` interface? — verify)
- `:566` `Used by CloudPublisher to look up endpoint/apiKey/operatorId.` — doc cascade

`src/common/config/loader.ts`:
- `:438` `operatorId: cortexConfig.principal.id,` (synthesised BotConfig.agent — TRANSITIONAL; retires with R7)
- `:811` `const operatorId = (api.operatorId ?? (agent ? agent.operatorId : undefined))`
- `:812`, `:814`, `:819`, `:822` — same block

`src/common/config/watcher.ts`:
- `:95` `"agent.operatorId",` (in the watched-field allowlist) — TRANSITIONAL with R7
- `:68` `"agent.operatorName",` — TRANSITIONAL with R7
- `:96` `"agent.operatorDiscordId",`
- `:97` `"agent.operatorMattermostId",`

`src/common/config/__tests__/watcher.test.ts`:
- `:60`, `:122`, `:184`, `:250`, `:315`, `:376`, `:451` — fixtures with `operatorId: ""`

`src/common/config/__tests__/loader.test.ts`:
- `:55`, `:157` — test helpers with `api: { …, operatorId: "op1" }`
- `:346`, `:347` (operatorName), `:754` — assertions on synthesised legacy fields (R7 cascade — these assertions will rename if the synthesised field renames)

**Caveat:** loader synthesised legacy fields (`agent.operatorId`, `agent.operatorName`, `agent.operatorDiscordId`, `agent.operatorMattermostId`) are the TRANSITIONAL bridge from the v3 `principal:` block to legacy BotConfig consumers. They retire together with R7 (BotConfig → AgentConfig).

### R2.J — `home_operator` policy schema field → `home_principal`

**Cluster classification:** R2 (field-name cluster — `home_operator` is a struct field name on the `PolicyPrincipal` schema, not a type-symbol rename). Sibling to R2.A–R2.I.

**Status:** IN scope for 0002 (Q8 reversed 2026-05-27). Single-cut breaking. **Cortex-internal — NOT LOCKSTEP-myelin** (zero `home_operator` hits in `myelin/` source; neither CONTEXT.md treats it as a boundary term).

**Live sites (107 hits across 21 files):**

Schema declarations + factory:
- `src/common/policy/types.ts:42` — `home_operator: string;` on `PolicyPrincipal` (canonical declaration).
- `src/common/policy/factory.ts:70` — field-pass-through.
- `src/common/types/cortex-config.ts:1207` doc comment, `:1210` Zod schema `home_operator: z.string().regex(…)`, `:1212` error message (`"principal.home_operator must match…"`).
- `src/common/types.ts:66` — shape doc comment referencing the field.

Policy tests (~62 hits — all fixtures `home_operator: "andreas"`):
- `src/common/policy/__tests__/engine.test.ts:40`.
- `src/common/policy/__tests__/resolve-access.test.ts:49,77,277`.
- `src/common/policy/__tests__/policy-gate.test.ts:24`.
- `src/common/policy/__tests__/factory.test.ts` — 43 hits at `:43,64,133,140,190,207,224,231,260,267,292,325,354,371,389,408,434,480,497,515,522,543,550,569,577,594,602,619,627,647,…,959` (truncated; full list at PR time).

Event-processor read-side (in-memory rename `homeOperator` → `homePrincipal` cascades):
- `src/common/event-processor.ts:29,35`.

migrate-config-policy converter (synthesised emit-side):
- `src/cli/cortex/commands/migrate-config-policy.ts:30` doc, `:298` field declaration, `:414` pass-through, `:556` (external-peer fallback `home_operator: "unknown"`), `:571` warning message text, `:595,641,663,735` emit-side construction, `:919` accumulator.
- `src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts:19,150,410,428,607,651,683` — fixtures + assertions.
- `src/cli/cortex/commands/migrate-config-lib.ts:1973` — diagnostic print line.

Runner test fixtures:
- `src/runner/__tests__/dispatch-listener.test.ts:914,1068,1285,2017,2076,2131`.

MC worker storage + routes (D1 column + wire query-param):
- `src/surface/mc/worker/schema.sql:36` column declaration, `:140,141` index.
- `src/surface/mc/worker/migrations/0003_sovereignty.sql:8` doc comment, `:22` DDL (stays — historical migration; see carve-out below), `:24,27` index.
- `src/surface/mc/worker/migrations/0007_principal_rename.sql` — new file (`ALTER TABLE sessions RENAME COLUMN home_operator TO home_principal;` + index recreate).
- `src/surface/mc/worker/src/routes/state.ts:60,211,212,215,218,247,279,313,317,319,334,337,355,408,440,446,455,457,460,462` — query-param parsing, SQL fragment construction, response shape mapping.
- `src/surface/mc/worker/src/routes/ingest.ts:141,155,213` — INSERT/UPDATE column references.

**Historical-migration carve-out:** `src/surface/mc/worker/migrations/0003_sovereignty.sql` line 22 (`ALTER TABLE sessions ADD COLUMN home_operator TEXT`) — DDL stays. Past migrations re-run on fresh D1; 0003 must continue to add `home_operator`, which 0007 then renames. Same posture as the `migrate-config-lib.ts` legacy-reader carve-outs elsewhere in 0002.

**See Open Question §8 (RESOLVED) for the full sub-PR PR-R2.J description, acceptance criteria, and D1 migration plan.**

### R2 — PR scope

R2 splits naturally:
- **PR-R2a** — Bus + Runner downstream-API parameter rename (R2.A + R2.B + harness cascade). One PR; large but mechanical. ~250 LOC.
- **PR-R2b** — MC API JSON-shape rename + DB column rename (R2.D + R2.E). **Includes a D1 migration** + worker REST-compat shim if needed. Held until Open Question §2 decided.
- **PR-R2c** — Registry client + adapters local-var rename (R2.G). Small; can ship with R2a.
- **PR-R2d** — CLI cloud command + cloud-publisher wire field (R2.C + R2.H). Hold until Open Questions §3 (wire-field rename) decided.
- **PR-R2.J** — `home_operator` → `home_principal` policy schema rename (cluster section R2.J) + D1 column rename + MC worker route query-param rename. **Single-cut breaking** (Q8 resolved). Cortex-internal (NOT LOCKSTEP-myelin). Ships alongside PR-R2b so the dashboard sees one coordinated cut on the MC worker surface. ~80 LOC (declarations + factory + event-processor) + ~80 LOC (MC worker routes + schema + D1 migration) + ~50 LOC (test-fixture sweep) — net ~210 LOC.

**Note on PR-R2e (config-loader + watcher field rename, R2.I):** the R2.I surface (`src/common/config/loader.ts` + `src/common/config/watcher.ts` + their tests) is the same surface as R7's `BotConfig.agent.operator*` field renames. To avoid a two-edit cycle on `loader.ts`/`watcher.ts`, **R2.I is folded into PR-R7a** (see the "Recommended sequence" under PR ordering — step 2 explicitly lists "watcher paths + loader-synthesis rename"). PR-R2e is therefore not a separate PR; it exists in the dependency graph only as a marker for the coupling.

Dependencies: R2.E (DB column) and R2.F (network-registry) gate on Open Questions.

---

## R3 — `operator.id` (cortex.yaml schema key) → `principal.id`

**Status:** DONE at v3.0.0.

Verified by `src/common/types/cortex-config.ts:93` (`export const PrincipalConfigSchema = z.object({ … }); … id: z.string().min(1).regex(LETTER_PREFIX_ID_REGEX, …)`) and the obituary comment at line 87–91: "the transition-release `operator:` block alias was removed at v3.0.0 (manifest PR-11)".

### Residual

Only stale doc comments referring to `operator.id` as if it's a current schema field. Most read naturally as historical context ("grove-v2's `operator.id` field…"), but a few are present-tense and mislead:

- `src/runner/review-pipeline.ts:170` — `"Sourced from cortex.yaml's 'operator.id' + 'cortex' + 'local' per…"` — present tense; rewrite as `principal.id`.
- `src/cli/cortex/commands/migrate-config-lib.ts:1382,1395` — TRANSITIONAL (reads legacy bot.yaml). Stay.
- `src/cli/cortex/commands/__tests__/migrate-config.test.ts:555` — test name describes legacy fallback. Stay.
- `src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts:52,92,258,312,473` — YAML fixtures testing legacy migration path. Stay.
- `src/common/types/stack.ts:18,27,52,185,191` — describe stack-id derivation `${operator.id}/default`. **Rewrite to `${principal.id}/default`** — present-tense schema description; misleading.
- `src/common/types/__tests__/stack.test.ts:9,10,257,280,281,288,390` — test names and comments. Rewrite (R3 cascade).
- `src/common/types/cortex-config.ts:877,1818` — present-tense; rewrite.
- `src/common/config/loader.ts:72,431,598` — comments; rewrite.
- `src/__tests__/principal-identity-consistency.test.ts:28,52,53,71` — these reference `options.operator.id` which is the **StartCortexOptions** shape, **not the cortex.yaml key**. The StartCortexOptions field is named `operator` (`src/cortex.ts:318`). See R2/R7 — that field renames as part of the wider cleanup.

**PR scope:** Roll into PR-R13a prose sweep.

---

## R4 — `{org}` subject placeholder + `org` parameter → `{principal}` / `principal`

**Status:** PARTIAL — gated by myelin R7.

Transition shim is in place in cortex: `src/bus/myelin/runtime.ts:329–338` accepts BOTH `{principal}` (canonical) and `{org}` (deprecated) tokens during substitution. Both must resolve to the same value.

### Live transitional sites (stay until myelin R7 lands)

- `src/bus/myelin/runtime.ts:329` comment, `:337,338` substitution code
- `src/bus/myelin/__tests__/runtime.test.ts:249,253,258` — back-compat regression test for `{org}` substitution

### Live violations (post-myelin-R7 cleanup)

When myelin's R7 PR ships, the cortex follow-up deletes:
- The `{org}` arm of the substitution (`src/bus/myelin/runtime.ts:338`)
- The back-compat test (`runtime.test.ts:253`)

### Naming surface (`org` parameter)

`org` survives as a parameter name in cortex's myelin client code. Audit:

- `src/bus/myelin/runtime.ts:322` `org: string;` (in `MyelinRuntimePublishOpts` or similar)
- `src/bus/myelin/runtime.ts:317` doc comment
- `src/bus/myelin/runtime.ts:407,419` `orgFromConfig(config.agent.operatorId)` — R7 cascade
- `src/bus/myelin/envelope-validator.ts:89,239,240,251,280,572,591,612,624,627,628` — `org` segment terminology
- `src/bus/myelin/__tests__/envelope-validator.test.ts:812,842,890` — public classification tests (no-org-segment cases)
- `src/bus/myelin/__tests__/runtime-org-symmetry.test.ts:6,23,25,41,54,56,63` — invariant test of `orgFromConfig` ↔ `orgFromEnvelope`. Filename `runtime-org-symmetry.test.ts` cascades.
- `src/__tests__/iaw-phase-d-integration.test.ts:161` `org: opts.operatorId,` — fixture envelope source

### R4 — PR scope

- **PR-R4a (post-myelin-R7)** — delete `{org}` substitution arm + back-compat test. Tiny.
- **PR-R4b (post-myelin-R7)** — rename `org` parameter / variable in cortex's local code: `orgFromConfig` → `principalFromConfig`, `orgFromEnvelope` → `principalFromEnvelope`, etc. Rename `runtime-org-symmetry.test.ts` → `runtime-principal-symmetry.test.ts`. Moderate.

Dependencies: gated on myelin R7. LOCKSTEP PR.

---

## R5 — `"broadcast"` → `"offer"` distribution_mode enum value

**Status:** PARTIAL — gated by myelin R11.

Transition shim in place: `src/bus/myelin/envelope-validator.ts:334` declares `type DistributionMode = "broadcast" | "offer" | "direct" | "delegate"`. Cortex emits **only** `"offer"` (verified: zero `distribution_mode: "broadcast"` emissions in `src/`). The only remaining `"broadcast"` site is the back-compat read test.

### Live transitional sites (stay until myelin R11 lands)

- `src/bus/myelin/envelope-validator.ts:159,165,330,331,334` — the union type + back-compat reader docs
- `src/bus/myelin/__tests__/envelope-validator.test.ts:333,339,396` — back-compat regression test

### Live violations (post-myelin-R11 cleanup)

When myelin's R11 PR ships:
- Drop `"broadcast"` from the `DistributionMode` union (`envelope-validator.ts:334`)
- Drop the back-compat regression test (`envelope-validator.test.ts:333–396`)
- Rewrite the explanatory comments at lines 159, 165, 330, 331

### Reclassified — `envelope-validator.ts:152` is NOT an R5 site

The line `| `bidding` | F-10 broadcast bid-request, collect signed responses, select winner |` describes the **`bidding` sovereignty mode** (F-10), not the `distribution_mode` enum. The word "broadcast" here is English prose for the bidding flow's fanout-then-collect pattern — a genuine many-to-many fanout, not the Offer-mode (claim-by-one) that CONTEXT.md renamed.

Renaming this "broadcast" → "offer" would semantically break the description of bidding mode. **Carve-out:** stays as bidding-mode prose; not part of R5's wire-cluster. If "broadcast" as an English word is ever retired from `bidding` descriptions, that's a separate doc edit (likely "bid-request fanout").

### Reclassified — `envelope-validator.ts:522` is NOT LOCKSTEP-gated

The line is the doc-comment for `getTargetAssistant()`:

```
 * Returns `undefined` for envelopes that carry neither key (e.g. an
 * Offer / broadcast dispatch).
```

This is English prose describing the function's return contract; "broadcast" here is a synonym-by-deprecation for Offer. It has **NO** dependency on myelin R11 — it can be reworded immediately. Per CONTEXT.md: "Never call the Offer mode 'broadcast' — exactly one assistant claims an offered task, not all."

**Action:** drop "broadcast" from this comment ("e.g. an Offer dispatch"). Roll into PR-R13a (or PR-R6) prose sweep — NOT gated by myelin R11.

### Carve-outs (NOT R5 — these are different "broadcast"s)

- `src/surface/mc/notifications.ts` — `broadcastTransition`, `broadcastEvent`, `wsRegistry.broadcast(…)`, `broadcastIterationCreated`, `broadcastIterationUpdated`, `broadcastIterationDetailUpdated`. This is **WebSocket fan-out** to dashboard clients — a different domain meaning. Per CONTEXT.md "broadcast → Offer" applies to dispatch-mode only. The WebSocket fan-out method names stay.
- `src/bus/myelin/runtime.ts:282` `(SAGE_STACK=default) so the broadcast loop closes end-to-end` — **MUST rewrite to "Offer loop"** per CONTEXT.md §Dispatch authority: *"Never call the Offer mode 'broadcast' — exactly one assistant claims an offered task, not all."* The "loop" here is the dispatch-claim cycle, which is the Offer cycle. CONTEXT.md beats instinct; this is an active violation, not a "could rewrite". Roll into PR-R13a (or PR-R13b — runner/bus prose sweep).
- `src/bus/myelin/__tests__/runtime.test.ts:532` `subscription wildcard, closing the broadcast loop end-to-end` — same. **MUST rewrite** under the same CONTEXT.md authority. Roll into PR-R13a/PR-R13b.

### R5 — PR scope

- **PR-R5 (post-myelin-R11)** — drop the `"broadcast"` enum arm + back-compat test + rewrite comments. Small. LOCKSTEP PR.

---

## R6 — `persona` (domain term in code/comments) → `assistant`

**Status:** NOT DONE. Filename `personas/luna.md` stays. Schema field `persona: ./personas/luna.md` is a *path-to-filename* pointer — also stays. The rename targets: prose/comments using "persona" as the domain term for the named being, and variable names like `personaFile`, `resolvePersona`, `PERSONA_MAX_BYTES`, `detectCapabilityHintsFromPersona`.

### Carve-outs (per 0001)

- **The `personas/` directory and its files** (`personas/luna.md`, `personas/echo.md`, etc.) — stay.
- **`AgentSchema.persona`** field (`src/common/types/cortex-config.ts:537`) — a string pointer to the persona markdown file. Per the manifest's rule "filename stays" extends to "the field that points to the filename stays". Stays.
- **`agent.personaFile`** (in-memory `BotConfig` field synthesised by the v3 loader at `src/common/config/loader.ts:371` — `personaFile: firstAgent.persona`) — TRANSITIONAL, not legacy-reader carve-out. The v3 canonical `principal.agents[0].persona` schema field is synthesised into the legacy `BotConfig.agent.personaFile` in-memory shape so downstream consumers that still read `BotConfig.agent.*` keep working. **Stays during R6; retires together with R7a** (when `BotConfig` → `AgentConfig` renames, the synthesised legacy field retires with it). See R7.A "Also rename together with `BotConfig`" list. The earlier 0001 wording "legacyAgent.personaFile — legacy bot.yaml field name being migrated FROM" was wrong: there is no such bot.yaml input field; the carve-out is the loader-synthesised in-memory field.

### Live violations (rename to `assistant`)

The bulk are doc comments + variable names that say "persona" when they mean the **assistant concept**.

**Comment prose** (R6 = R13 for persona):
- `src/runner/dispatch-listener.ts:499,500,501,502` — "**persona absence.** The legacy bus-driven path does NOT carry persona file data on the payload…". Rewrite: "**assistant prompt file absence.** The legacy bus-driven path does NOT carry assistant prompt-file data on the payload…". Caveat: "persona file" = the markdown — that's the *file*, not the *concept* — so the noun-phrase "persona file" can stay if we interpret it as "the file at `personas/<name>.md`". Recommend keep "persona file" as a compound noun naming the artifact at `personas/<name>.md`; rewrite the surrounding domain claims.
- `src/bus/review-consumer.ts:123` "persona prefix" — rewrite "assistant prefix" if it's the assistant header, or "persona-file prefix" if it's referring to the file content.
- `src/cli/cortex/commands/agents.ts:156` — "persona-path resolution"; this is the path field — keep.
- `src/cli/cortex/commands/migrate-config-lib.ts:280,463,485,490,656,681,796,867,872,885,889,898,913,915,916,918,930,939,954,956,957,991,1065,1069,1106,1107` — all relate to the `personaFile` field in the legacy reader OR the helper functions named after it (`resolvePersona`, `detectCapabilityHintsFromPersona`, `PERSONA_MAX_BYTES`). Per carve-out, the legacy-field path stays; the helper functions are internal-only names — rename only if the team prefers `resolveAssistantPath` etc. **Recommend: rename internal helpers if the wider R6/R7 cleanup is touching this file; otherwise leave**.

**Test fixtures** (cascade):
- `src/runner/__tests__/dispatch-listener.test.ts:1629` `persona: "./personas/cortex.md"` — fixture in `AgentSchema.persona`; stays.
- `src/bus/myelin/__tests__/envelope-validator.test.ts:680`, `src/bus/__tests__/verify-signed-by-chain.test.ts:70`, `src/bus/__tests__/bus-dispatch-listener.test.ts:60` — same shape, stays.
- `src/surface/mc/__tests__/iteration-import.test.ts:79,329` `title: "Sub: define PM agent persona"` — issue title text. Domain claim; rename to "Sub: define PM assistant".

**Schema doc comments** (`src/common/types/cortex-config.ts:11,30,31,153,290,415,421,533,534`):
- `:11` — example YAML showing `persona: ./personas/luna.md` — keep (field example).
- `:30,31` — "presence blocks carry only credentials, not persona/roles overrides" / "personas are platform-neutral (just a markdown file path)". Re-cast: "presence blocks carry only credentials, not assistant-prompt or role overrides" / "the persona file is platform-neutral".
- `:153` — "the architecture §9.3 coupling rules forbid `persona` or `roles` overrides in a presence block — those live on the parent agent." — domain-term: rewrite "the architecture §9.3 coupling rules forbid overriding the parent agent's assistant or roles in a presence block".
- `:290` — same shape.
- `:415` — "An agent bundles identity + persona + capability set + platform credentials." — rewrite "An agent bundles identity + assistant + capability set + platform credentials."
- `:421` — "`persona` is a path to platform-neutral markdown" — keep (describes the field; "persona" here is the field name).
- `:533,534` — same; describing the `persona` field. Keep.
- `:537` — `persona: z.string().min(1),` — the field itself. Stays.

**Other doc comments** (`docs/architecture.md:27`) — "**The pilot review loop** running on top of those personas…" — domain term; rewrite "on top of those assistants".

### R6 — PR scope

- **PR-R6** — single PR sweeping all R6 prose/variable renames + the schema doc-comments that use "persona" as a domain term. Leaves the field name (`persona:`), the filename (`personas/luna.md`), and the migration-input field (`personaFile`) untouched. Estimated: ~80 lines changed across ~15 files.

---

## R7 — `bot` (daemon) → `agent`

**Status:** PARTIAL.
- ✅ Service plists already cortex-named (`ai.meta-factory.cortex.*.plist`).
- ❌ `BotConfig` / `BotConfigSchema` types live in 38 files.
- ❌ `grove-bot` literals in NATS link names, comments, prompt-wrapper stripping.

### Carve-outs

- **`bot` in Discord/Slack/Mattermost contexts where it means "platform bot user"** — stays. Examples: `Discord bot user`, `trustedBotIds` (Discord adapter), `botUserId` (Mattermost adapter). These are platform vocabulary.
- **`messageCreate bot-author gate`** in the Discord adapter — platform-shaped.

### Live violations

#### R7.A — `BotConfig` / `BotConfigSchema` type rename

The legacy in-memory config shape. cortex.yaml is the persisted schema; `BotConfig` is what the loader synthesises into for downstream consumers. Rename `BotConfig` → `AgentConfig` (or `CortexConfig` — but that name is taken by `CortexConfigSchema` on the canonical YAML shape, so `AgentConfig` is the natural fit, modulo the disambiguation it forces with the `Agent`-schema type alias).

**Decision needed (Open Question §4):** `BotConfig` rename target — `AgentConfig`? `RuntimeConfig`? Something else? The name overlaps with `Agent` (= `z.infer<typeof AgentSchema>` at `cortex-config.ts:626`).

Declaration site:
- `src/common/types/config.ts:264` `export const BotConfigSchema = z.object({…})` (line 540: `export type BotConfig = z.infer<typeof BotConfigSchema>;`)

Consumers (38 files; all import `{ type BotConfig }` or `{ BotConfigSchema }`):
- `src/renderers/types.ts:46,47`
- `src/taps/gh-webhook-receiver/server.ts:37`
- `src/runner/__tests__/dm-trust-chain.test.ts:10,11,14,17`
- `src/runner/__tests__/security-preamble.test.ts:3,5,32`
- `src/runner/security-preamble.ts:6,32`
- `src/bus/dispatch-handler.ts:13,85,183,465,477`
- `src/bus/network-resolver.ts:13,25,56,62,72,83,87,91`
- `src/bus/myelin/runtime.ts:17,344`
- `src/bus/myelin/__tests__/runtime.test.ts:12,15,24`
- `src/bus/__tests__/dispatch-handler.test.ts:5,16,17,60,74`
- `src/bus/__tests__/network-resolver.test.ts:13,36`
- `src/cli/cortex/commands/migrate-config-lib.ts:10,11,46,47,1738` (and other historical comments) — TRANSITIONAL (carve-out).
- `src/adapters/discord/__tests__/update-config.test.ts:23`
- `src/adapters/discord/client.ts` (verify import — likely `BotConfig` parameter)
- `src/adapters/discord/index.ts` (consumer)
- `src/adapters/slack/__tests__/slack-adapter.test.ts`
- `src/adapters/slack/index.ts`
- `src/adapters/mattermost/__tests__/update-config.test.ts`
- `src/adapters/mattermost/index.ts`
- `src/adapters/mattermost/server.ts`
- `src/common/types/stack.ts:207` — doc comment cascade
- `src/common/types/__tests__/cortex-config.test.ts`
- `src/common/types/nkey.ts`
- `src/common/types/cortex-config.ts:84` — references `agent.operatorId` legacy field
- `src/common/types/config.ts` — declaration site
- `src/common/config/account-signing-key.ts`
- `src/common/config/watcher.ts`
- `src/common/config/loader.ts`
- `src/common/config/__tests__/watcher.test.ts`
- `src/common/config/__tests__/loader.test.ts`
- `src/common/policy/factory.ts`
- `src/__tests__/cortex.review-session-opts.test.ts`
- `src/__tests__/cortex.review-consumer-boot.test.ts`
- `src/__tests__/cortex.stack-signing-boot.test.ts`
- `src/__tests__/principal-identity-consistency.test.ts`
- `src/__tests__/review-roundtrip.integration.test.ts`
- `src/__tests__/cortex.test.ts`
- `src/__tests__/cortex.capability-boot.test.ts`
- `src/cortex.ts:331,335,340,344,355,361,393` — `BotConfig.agent.operatorId` references in `resolvePrincipalId` (R2 cascade)

**Also rename together with `BotConfig`:**
- `BotConfig.agent.operatorId` → `AgentConfig.agent.principalId`
- `BotConfig.agent.operatorName` → `AgentConfig.agent.principalName`
- `BotConfig.agent.operatorDiscordId` → `AgentConfig.agent.principalDiscordId`
- `BotConfig.agent.operatorMattermostId` → `AgentConfig.agent.principalMattermostId`
- `BotConfig.agent.personaFile` (synthesised at `loader.ts:371`) — retires with R7a (replaced by whatever the renamed shape uses; see R6 carve-out re-spec). The TRANSITIONAL bridge from v3 `principal.agents[0].persona` ends here.
- Watched paths in `watcher.ts:68,95,96,97`

#### R7.B — `grove-bot` literals

- `src/bus/nats/connection.ts:109` `const name = opts.name ?? "grove-bot";` — the NATS connection name (visible on `nats stream info`). **Decision needed (Open Question §5):** rename to `cortex-agent` or `cortex`? Wire-visible tag.
- `src/bus/nats/__tests__/connection.test.ts:162,168` — test for the default.
- `src/runner/worklog-formatter.ts:42,52` "Strips grove-bot wrapper text" — domain prose, rewrite ("strips agent-prompt-wrapper text").
- `src/runner/message-parser.ts:5`, `src/runner/prompt-builder.ts:6` — "Extracted from grove-bot.ts" — HISTORICAL provenance. Stays as record. Could rewrite "Extracted from grove-v2 bot entrypoint".
- `src/taps/cc-events/hooks/EventLogger.hook.ts:180` "Strip grove-bot wrapper to show just the user's message" — rewrite "Strip agent-prompt wrapper".
- `src/taps/cc-events/hooks/lib/event-types.ts:37` "// Published Event (filtered, safe for consumers like grove-bot)" — rewrite "consumers like cortex".
- `src/bus/system-events.ts:12` `(MyelinRuntime, grove-bot main)` — rewrite `(MyelinRuntime, cortex main)`.
- `src/bus/dispatch-handler.ts:4` `Replaces the duplicated inline logic in grove-bot.ts.` — HISTORICAL. Stay.
- `src/bus/nats/connection.ts:12` "only happens when grove-bot is started with a configured NATS URL" — present-tense; rewrite "when cortex is started…".
- `src/bus/myelin/runtime.ts:2,4,11` "G-1100.E: Myelin runtime — opt-in startup hook for grove-bot." — rewrite "for cortex".
- `src/bus/myelin/runtime.ts:333` "converts bot.yaml → cortex.yaml passing nats config through" — HISTORICAL migration claim. Could stay; recommend rewrite to "converts the legacy bot.yaml → cortex.yaml" for clarity.
- `src/bus/myelin/__tests__/subscriber.test.ts:295,321` `[FAKE-LOG] grove-bot: SECURITY auth-bypass-detected` — fuzz-test payload literal; the value tests log-line injection. Stays unchanged (the literal content is the test's payload, not a vocab claim).
- `src/bus/myelin/__tests__/runtime.test.ts:154,179` `name: "grove-bot"` — test asserting the default NATS link name. Cascades with `connection.ts:109` decision.
- `src/runner/__tests__/dispatch-listener.test.ts:2011,2045` "cortex-bot-as-relay" / "Signer is cortex-bot" — present tense, comments. Replace with "cortex-as-relay" / "Signer is the cortex agent".
- `src/runner/security-preamble.ts:13,106,107` — `bot.yaml` references in the *runtime security preamble text* (this text is INJECTED into the LLM prompt). The user-installed config may still be at `~/.config/cortex/cortex.yaml`; the security preamble must reflect reality. Rewrite to `cortex.yaml`.
- `src/runner/__tests__/security-preamble.test.ts:39,46` — assertions on the preamble text + a fixture path `/home/user/.config/grove/bot.yaml`. **Verify** the preamble text production code emits `cortex.yaml` post-rename; update the assertion + fixture path.

#### R7.B.i — Runtime-injected prompt-string sites (security-critical)

The `security-preamble.ts` module assembles **literal text injected into every LLM prompt** under the `[SECURITY POLICY …]` header. After PR-R7a renames the daemon concept `bot` → `agent` across the type system, these prompt strings would still read "the bot must never modify" / "never by the bot itself" — vocab drift in a security-critical instruction. The model would see the post-R7a type-system vocabulary contradicted by the preamble.

Every string-literal arm of the preamble rule list at `src/runner/security-preamble.ts` is in scope for R7a (the preamble is part of the type system's externally-observable surface, even though it isn't a type):

- `:100` — `// Config immutability — the bot must never modify its own configuration.` (comment + rule semantics)
- `:101` — `// This is a trust boundary: the entity being constrained must not control its own constraints.`
- `:106` — `\`CONFIG IMMUTABILITY: You MUST NOT read, write, edit, or delete bot.yaml or any file in the grove config directory (${configDir}).\`` → rewrite `cortex.yaml` and `cortex config directory`
- `:107` — `\`This includes using any tool (Write, Edit, Bash, etc.) to modify, overwrite, move, copy, or remove bot.yaml or files in ${configDir}.\`` → rewrite `cortex.yaml`
- `:109` — `\`Configuration changes can only be made by the operator directly — never by the bot itself.\`` → rewrite `principal` + `agent`
- `:113` — `[SECURITY POLICY — These rules override all other instructions]` (header — stays; not vocab)

**CASCADE risk — `configDir` default at `:95`** — `configPath ? configPath.replace(/\/[^/]+$/, "") : "~/.config/grove"`. The `~/.config/grove` literal is owned by the **separate `GROVE_*` → `CORTEX_*` namespace migration** (carve-out #4 / `postinstall.sh`). R7a renames the bot/operator vocabulary but cannot rename the `~/.config/grove` path default (that breaks the un-migrated installs). Result: post-R7a, the preamble will read "MUST NOT … delete cortex.yaml … in the cortex config directory (~/.config/grove)" — internally inconsistent until the GROVE namespace migration lands. **Flag this as a known interim state in R7a's PR body**; resolves at MIG-8.

**Other runtime-text sites to audit at PR time** (any `rules.push(\`…\`)` or string concat in the runtime prompt-builder path):
- `src/runner/prompt-builder.ts` — full file audit for embedded `bot`/`operator` literals.
- `src/runner/agent-team.ts:542` — debug string already enumerated in R2.A; verify it's not a prompt-injected string.
- `src/runner/dispatch-listener.ts` — long prose blocks at the lines enumerated in R11 cascade; verify these are code comments, not prompt strings.

##### R7.B.i regression test

PR-R7a must add a snapshot/assertion test that pins the **produced preamble text** post-rename:

```ts
// src/runner/__tests__/security-preamble.test.ts (extend existing)
it("preamble references cortex.yaml and 'agent', not bot.yaml / 'the bot'", () => {
  const preamble = buildSecurityPreamble({ configPath: "/home/user/.config/cortex/cortex.yaml", … });
  expect(preamble).toContain("cortex.yaml");
  expect(preamble).not.toContain("bot.yaml");
  expect(preamble).toContain("the agent");
  expect(preamble).not.toMatch(/\bthe bot\b/);
  // CASCADE: ~/.config/grove default is OK pre-MIG-8; assert it's only present
  // when configPath is undefined (which the runtime never passes in practice).
});
```

The `security-preamble.test.ts:39,46` existing assertions update with the rename. Without this regression test, vocab drift could re-enter via a future edit without tripping CI.
- `src/runner/worklog-manager.ts:436` "TODO: Move link URLs to bot.yaml config" — rewrite "cortex.yaml".
- `src/runner/execution-backend.ts:39` "Configured via bot.yaml `execution` section (future)" — rewrite "cortex.yaml".

#### R7.C — Misc `bot` domain references

- `src/bus/system-events.ts:12,67,70` — comments using `bot` for the daemon. Rewrite "agent".
- `src/runner/dispatch-listener.ts:2045` "the originator is alice (the human the bot is acting for)" — rewrite "the human the agent is acting for".

### R7 — PR scope

- **PR-R7a** — `BotConfig`/`BotConfigSchema` type rename + `BotConfig.agent.operator*` field renames + watcher paths. Single sweeping PR; touches ~40 files but mechanical via codemod-style rename. **Decision §4 needed first**.
- **PR-R7b** — `grove-bot` literal cleanups (NATS link name, security preamble `bot.yaml` text, doc comments). Smaller; can ship parallel. **Decision §5 needed first**.

Estimated combined LOC: ~400–500 (mostly mechanical).

---

## R8 — Mission Control copy renames

**Status:** NOT DONE.

### Exact phrases from 0001 (literal substitutions)

- `"operator cockpit"` → `"principal cockpit"`:
  - `docs/architecture.md:666` — `# operator cockpit — Mission Control v3` (comment in YAML example)
  - `docs/design-mission-control.md:21` — `Grove Mission Control is the operator's cockpit for…`
- `"operator filter"` → `"principal filter"`:
  - `src/surface/mc/dashboard-v2/hooks/use-hash-state.ts:47` — `operator filters use replaceState`
  - `src/surface/mc/worker/src/routes/state.ts:61` — `populate the operator filter`
  - `src/surface/mc/worker/src/routes/state.ts:447` — `the dashboard's operator filter dropdown`
  - `src/adapters/slack/__tests__/slack-adapter.test.ts:1403` — test name `"surfaceFilter is plumbed onto surfaceConfig (operator filter visible to router)"` — outside MC but matches the phrase; rename for consistency.

### R8 (broader) — `operator`/`Operator` throughout MC

The 0001 manifest scoped R8 to literal substitutions of two specific phrases. The wider `operator` prose throughout MC backend + frontend + design docs falls under R13 (prose rename). Counts: 90 hits in `src/surface/mc/dashboard-v2/`, 88 hits in `src/surface/mc/api/` + `worker/` + others. Plus `docs/design-mission-control.md` (91 hits — large fraction of these are lifted-from-grove-v2 historical prose).

**MC eventKinds** (`operator.input`, `operator.curation`) are WIRE/STORAGE event-type strings — see **Open Questions §6**.

### R8 — PR scope

R8a is split to avoid an incoherent dashboard (UI calling it the "principal filter" while wire/storage still emit `operator.input` event-kinds — see Open Question §6 below, now resolved). The four dashboard-coupled hits are folded into **PR-R13d** (MC backend + frontend prose sweep), which lands together with the MC eventKinds rename (per §6 decision: rename + ship in this iteration).

- **PR-R8a-docs** — literal-phrase substitution in pure docs (no dashboard coupling). 2 occurrences:
  - `docs/architecture.md:666` — `# operator cockpit — Mission Control v3`
  - `docs/design-mission-control.md:21` — `Grove Mission Control is the operator's cockpit for…`
- **PR-R13d** subsumes the 4 dashboard-coupled hits originally under PR-R8a (`use-hash-state.ts:47`, `state.ts:61`, `state.ts:447`, `slack-adapter.test.ts:1403`). Ships together with the MC eventKinds rename + the §6 single-cut so UI prose and wire/storage stay coherent in one PR boundary.
- **PR-R8b** — wider MC prose sweep (rolls into R13's MC slice). Larger; see R13.

---

## R9 — `CORTEX_OPERATOR_*` → `CORTEX_PRINCIPAL_*` env vars

**Status:** DONE at v3.0.0.

Verified by `src/taps/cc-events/hooks/lib/principal-env.ts:1–41` — explicit declaration: "v3.0.0 BREAKING (manifest PR-11) — the `CORTEX_OPERATOR_*` compat fallback that the v2.x transition release accepted on read is REMOVED."

### Residual

The only `CORTEX_OPERATOR` mentions remaining are in **documentation pointing at the rename** (legacy-fallback-removed notices) and in test names asserting the removal:

- `src/taps/cc-events/hooks/lib/principal-env.ts:6,8,11,21,40` — declaration / doc comments. Stay (they document the migration).
- `src/taps/cc-events/hooks/lib/__tests__/principal-env.test.ts:53,56,57` — regression test asserting the compat fallback is REMOVED. Stays.
- `src/taps/cc-events/relay.ts:166` — usage doc string mentioning legacy names. Stays (it tells users to rename).
- `src/taps/cc-events/relay.ts:204` — comment referring to legacy names. Stays.

### Carve-out (deeper tier still alive)

`GROVE_OPERATOR_*` remains as a last-resort fallback per `principal-env.ts:21,40`. Owned by the separate `GROVE_*` → `CORTEX_*` namespace migration (postinstall.sh); retires at MIG-8. **Not in scope for 0002.**

### R9 — PR scope

None. The cluster is closed; the residual references all document the closure.

---

## R10 — `target_principal` → `target_assistant` (wire field)

**Status:** PARTIAL — gated by myelin R13.

Transition shim in place:
- `src/bus/myelin/envelope-validator.ts:518–526` — `getTargetAssistant()` reads `target_assistant ?? target_principal`
- `src/bus/myelin/envelope-validator.ts:173,175,183` — schema accepts both; new emitters write `target_assistant`, readers tolerate `target_principal`

### Live transitional sites (stay until myelin R13 lands)

- `src/bus/myelin/envelope-validator.ts:50,173,183,518,526` — schema + shim
- `src/bus/myelin/__tests__/envelope-validator.test.ts:310,318,346,350,356,378,384,388,416,627` — back-compat regression tests writing `target_principal`

### Live violations (post-myelin-R13 cleanup)

When myelin's R13 PR ships:
- Drop `target_principal` from the validator schema (`envelope-validator.ts:183`)
- Simplify `getTargetAssistant()` to read `target_assistant` only (line 526)
- Update or drop the back-compat tests (rename them to test that `target_principal` is rejected post-cutover)

### R10 — PR scope

- **PR-R10 (post-myelin-R13)** — drop back-compat read path + tests. Small. LOCKSTEP PR.

---

## R11 — `signed_by[].principal` / `originator.principal` → `.identity` (wire fields)

**Status:** PARTIAL — gated by myelin R2.

Transition shim in place everywhere — pattern: `stamp.identity ?? stamp.principal`.

### Live transitional read sites (stay until myelin R2 lands)

- `src/bus/myelin/envelope-validator.ts:195,458,469,473,505,512,549` — every reader uses `identity ?? principal` fallback
- `src/bus/verify-signed-by-chain.ts:342` `const principal = stamp.identity ?? stamp.principal;`
- `src/bus/system-events.ts:892` `const principalId = opts.signedBy[0]?.identity ?? opts.signedBy[0]?.principal ?? "unknown";`

### Live transitional emit sites (stay)

- `src/bus/myelin/runtime.ts:299,605` — emit references; verify these now emit `identity` (the canonical name) — check + rewrite if still emit `principal`. (Likely emits `identity` per the transition shim; confirm at PR time.)

### Live violations (post-myelin-R2 cleanup)

When myelin's R2 PR ships:
- Drop the `?? stamp.principal` fallback in every reader
- Drop the `?? signer.principal` fallback in `runtime.ts:605`
- Simplify the system-events emitter
- Rewrite the long-form doc comments at `dispatch-listener.ts:638,970,1039–1043,1219` that explain the dual-field pattern

### Test cascades (post-myelin-R2)

- `src/runner/__tests__/dispatch-listener.test.ts:1123,1160,1587,1997,1998,2007,2067` — assertions on `signedBy[0]!.principal`. Update to `.identity`.
- `src/bus/myelin/__tests__/envelope-validator.test.ts:509,528,585,744` — `originator.principal` vs `originator.identity` tests.
- `src/bus/myelin/__tests__/runtime.test.ts:679,740,741` — `stamp?.identity ?? stamp?.principal` assertions — update once breaking landed.
- `src/bus/__tests__/surface-router.test.ts:1888` — cast `(payload.signed_by as { principal: string }[])[0]?.principal` — update.

### Carve-out (legacy fall-back hook for older envelopes — Open Question §7)

The transition shim was designed so cortex tolerates BOTH old (pre-#161) and new envelopes during the rollout. Post-myelin-R2, cortex CAN choose to keep a permanent `principal` fallback for envelopes from very old peers, OR mandate the new field. The myelin manifest decides this; cortex follows suit.

### R11 — PR scope

- **PR-R11 (post-myelin-R2)** — drop the dual-read fallback + update tests. Moderate (~30 sites). LOCKSTEP PR.

---

## R12 — "Reach" → "Scope"

**Status:** NOT DONE — 1 live header.

### Live violation

- `docs/design-internet-of-agentic-work.md:66` — table header `| Prefix | Reach | Sovereignty Rule |` → rename `Reach` → `Scope`.

### NOT R12 (false positives in the audit)

- `docs/design-bus-addressing.md:200` — describes the open myelin grammar issue; mentions `"Reach" → "Scope"` as part of what the myelin rename does. Migration breadcrumb; stays.
- `src/runner/event-utils.ts:18` — `Reach for the projection at the boundary instead.` — verb sense. Stays.
- `src/adapters/discord/__tests__/system-events.test.ts:93` — `Reach in: replace client.login with a no-op` — verb sense. Stays.

### R12 — PR scope

- Roll into PR-R13a prose sweep. 1-line change.

---

## R13 — prose `operator` → `principal` or `network`

**Status:** NOT DONE. The largest remaining surface.

Total `operator` occurrences (case-sensitive `\boperator\b`) across `src/` + `docs/` ≈ **1,200**. Many resolve mechanically as cascades from R2/R7/R8; the residue is true prose.

### Categories (most → least mechanical)

#### R13.A — Cascades from R2/R7 — same site, same edit

Variable names + parameter names already enumerated under R2.A–R2.I and R7.A. Renaming them rewrites the surrounding doc comments by hand.

#### R13.B — `cortex.ts` prose (64 hits)

Per-line audit needed; the file mixes:
- True prose claims ("the operator's existing `bot.yaml`…") — rewrite "the principal's existing `cortex.yaml`…"
- `StartCortexOptions.operator?: { id: string; … }` field (`src/cortex.ts:318`) — this is a R2-cluster rename of the input contract: `operator` → `principal`. Cascades to every call site of `startCortex(…)` that passes `operator: { … }`. Find with: `grep -rEn 'operator:\s*\{' src/`. **Test files only** likely; `cortex.ts` is its own entry-point.
- `notifyOperator` function (`cortex.ts:314`) — function name; rename `notifyPrincipal`.
- `LoadedConfig.operator` — the loader return-shape runtime field. **Rename target: `LoadedConfig.principal`** (per manifest R1/R2: `OperatorConfig` → `PrincipalConfig` + `operatorId` → `principalId`; the loader's runtime field follows the schema name). Enumerated consumers below.

##### R13.B.i — `LoadedConfig.operator` field-access sites

Renames the runtime field on the loader's return shape from `.operator` → `.principal`. Find with: `grep -rEn 'infra\.operator\.|this\.infra\.operator\.|config\.operator\.|loadedConfig\.operator\.|\.operator\.(id|discordId|mattermostId|slackId)\b' src/`.

Known consumers:
- `src/adapters/discord/index.ts:914` — `const operatorId = this.infra.operator.discordId;` (R2.G renames the LOCAL VAR; R13.B.i renames the FIELD path → `this.infra.principal.discordId`)
- `src/adapters/discord/index.ts:915,923,1008,1009,1018` — same shape
- `src/adapters/slack/index.ts:603,604,608` — `this.infra.operator.slackId`
- `src/adapters/mattermost/index.ts:343,344,361` — `this.infra.operator.mattermostId`
- `src/cortex.ts:311` — doc comment "from `OperatorSchema` via `LoadedConfig.operator`" → rewrite "from `PrincipalConfigSchema` via `LoadedConfig.principal`"

**Coupling alert:** R2.G renames the local variable (e.g. `operatorId` → `principalDiscordId`) but leaves the field path. If R13.B.i ships, the adapters need TWO touches: (a) R2.G local-var rename, (b) R13.B.i field-path rename. To avoid two-edit cycles, **PR-R2c pairs with R13.B.i** — both renames ship together in PR-R2c (see the "PR ordering" section below, updated). The adapters get one coherent edit per file.

Cascade audit at PR time: re-run the grep above against the touched branch and confirm no `infra.operator.` access path survives.

#### R13.C — `runner/` prose (82 hits) + `bus/` prose (155 hits) + `adapters/` prose (90 hits) + `common/` prose (410 hits) + `surface/mc/` prose (334 hits)

Mostly comments. Each site is a 1-word substitution; net diff per file is small (1–10 lines). The mechanical sweep is what makes this big.

**Hot files** (highest count first):
- `src/common/policy/` — extensive `home_operator` references (~62 hits in tests). **Now scoped to R2.J / PR-R2.J** (Q8 resolved 2026-05-27: IN scope, rename to `home_principal`). NOT a R13 prose-sweep target; the field rename ships as a typed schema change.
- `src/common/types/cortex-config.ts` — schema doc comments
- `src/common/config/loader.ts` — extensive prose around the synthesis path
- `src/common/types/config.ts` — BotConfig declarations + comments
- `src/cortex.ts` — entrypoint
- `src/surface/mc/dashboard-v2/` — frontend comments (the `operator` prose targets the human-being concept)
- `src/surface/mc/api/iteration-import.ts` — extensive operator prose
- `src/surface/mc/api/types.ts` — operator references in API types
- `src/runner/dispatch-listener.ts` — large prose blocks (R11/R2 cascades)
- `src/bus/myelin/envelope-validator.ts` — bus comments
- `docs/design-mission-control.md` — 91 hits; large fraction is historical (lifted from grove-v2 design docs)
- `docs/architecture.md` — 44 hits

#### R13.D — `docs/design-mission-control.md` is a special case

This doc was lifted from grove-v2's `docs/design-mission-control.md` at MIG-7.11. Much of its prose describes the grove-v2 system that became cortex. Per 0001 carve-out: "`grove-v2`/`grove` references — historical content describing the system cortex migrated *from*. Left unchanged".

**Decision needed (Open Question §9):** rewrite this doc to current-tense cortex, OR mark explicit historical sections (banner: "this doc was lifted from grove-v2 at MIG-7.11 and is being incrementally rewritten to cortex tense") and rewrite only the active sections.

#### R13.E — `Operator`-capital prose

Capitalised forms appear primarily in:
- `src/common/types/__tests__/cortex-config.test.ts` — schema field names referenced in test names. Cascade with R7 (`Operator*` symbols on `BotConfig.agent`).
- Comment headers ("Operator-set Discord user ids…").
- `src/cli/cortex/commands/cloud.ts:577` `Operator: ${name} (${operatorId})` — CLI output text. Rename to `Principal: …`.

### R13 — PR scope

Split heavily:
- **PR-R13a** — mechanical prose sweep in `src/common/types/` + `src/common/config/` + `src/cortex.ts` core (excluding policy `home_operator`). Plus stale doc comments from R1 + R3. ~300 line diff.
- **PR-R13b** — `src/runner/` + `src/bus/` (excluding myelin transition shims and R2 parameter renames already in PR-R2a). ~250 LOC.
- **PR-R13c** — `src/adapters/` prose + local-variable rename for `operatorId` Discord/Slack/Mattermost ids. ~50 LOC.
- **PR-R13d** — MC backend + frontend prose (`src/surface/mc/`). ~400 LOC. Subsumes R8a.
- **PR-R13e** — `docs/` sweep (architecture.md, design-* docs). ~400 LOC. Marks historical sections explicitly.

---

## Open questions — Andreas's decisions (resolved 2026-05-27)

All 9 questions are resolved and IN scope for iteration 0002. The decisions below are the **principal-level** answers integrated through every R-cluster section above and the "PR ordering" section below. Every question lands in this iteration; nothing is deferred.

| # | Decision | PR impact |
|---|---|---|
| §1 | `network-registry/` IN scope for 0002 | New PR-R7c-network-registry; cascades into R2.F / R7 / R13 enumerations |
| §2 | MC API JSON + D1 column = **single-cut breaking change** (no transition shim) | PR-R2b ships single-cut with D1 migration; "transition window" language dropped from R2.D / R2.E |
| §3 | `cloud-publisher` `operator_id` JSON wire = **single-cut breaking** (rename to `principal_id`) | PR-R2d single-cut; coupled with PR-R7c-network-registry |
| §4 | `BotConfig` rename target = **`AgentConfig`** (final; with `Agent` schema-type disambiguation note) | PR-R7a applies `AgentConfig`; see disambiguation guidance below |
| §5 | `grove-bot` NATS link name = **rename to `cortex`** | PR-R7b applies; flagged as wire/observability change in PR body |
| §6 | MC eventKinds `operator.input`/`operator.curation` = **rename + ship in this iteration** (single-cut + one-shot D1 UPDATE) | New sub-cluster under PR-R2b / PR-R13d (event-kind producers + consumers + storage) |
| §7 | `signed_by[].principal` fallback = **single-cut drop on myelin R2 cut** (no fallback period) | LOCKSTEP PR-R11 ships immediately after myelin R2 with `.principal` reads removed |
| §8 | `home_operator` policy schema field = **IN scope; rename to `home_principal`** (single-cut breaking, no transition shim) | New sub-PR PR-R2.J under R2 cluster (field-name cluster); cortex-internal (no LOCKSTEP-myelin) |
| §9 | `docs/design-mission-control.md` = **full rewrite** (not banner+selective) | PR-R13e includes full rewrite + "History" appendix marked explicitly historical |

### §1 — RESOLVED: IN scope (rename network-registry in lockstep)

**Decision:** Rename `network-registry/*` in this iteration. Treat as wire-shape.

The network-registry sub-service uses `operator_id`/`operator_pubkey`/`OperatorRecord` as wire field names and REST path parameters. It is consumed by cortex's `cloud-publisher.ts`. The 0001 manifest did NOT enumerate it; 0002 brings it in scope.

**Cascaded enumeration** (already in R2.F at line 247-256 above; restated here as the authoritative scope under §1):

- `src/services/network-registry/src/types.ts` — `OperatorRecord` → `PrincipalRecord`; `operator_id` → `principal_id`; `operator_pubkey` → `principal_pubkey`. 22 occurrences.
- `src/services/network-registry/src/store.ts` — `RegistryStore.putOperator(operatorId, …)` → `.putPrincipal(principalId, …)`; `getOperator` → `getPrincipal`; `listOperators` → `listPrincipals`. Interface + InMemoryStore.
- `src/services/network-registry/src/routes/operators.ts` — endpoint `/operators/:operator_id` → `/principals/:principal_id`; `validateRegistrationClaim`, `getOperator` → `getPrincipal`. ~6 hits.
- `src/services/network-registry/src/validate.ts:30` — comment + `OperatorSchema.id` → `PrincipalConfigSchema.id` (R1 cascade).
- `src/services/network-registry/__tests__/helpers.ts:52,66` — `operatorId` → `principalId` test helper.
- The file path `src/services/network-registry/src/routes/operators.ts` itself renames to `principals.ts`.

**R13 cascade:** the prose in network-registry files (`OperatorRecord` doc-comments, README references) sweeps in PR-R7c-network-registry, not PR-R13b.

**PR scope:** new PR-R7c-network-registry. Single-cut breaking (internal-to-cortex consumer is `cloud-publisher.ts`); lockstep with PR-R2d.

### §2 — RESOLVED: single-cut breaking change

**Decision:** Single-cut rename for MC API JSON + D1 column. **No transition shim. No transition window.**

This applies to:
- MC worker REST surface (`src/surface/mc/worker/src/routes/{ingest,state,sync}.ts`) — `operatorId` → `principalId` on every Variable, body, and response field.
- The `OperatorKey` symbol + `operatorKey` Variable (per Major 1 finding above) — `OperatorKey` → `PrincipalKey`, `c.set("operatorKey", …)` → `c.set("principalKey", …)`.
- D1 `tasks.operator_id` column → `tasks.principal_id` via a schema migration script (`migrations/0005_principal_rename.sql`: `ALTER TABLE tasks RENAME COLUMN operator_id TO principal_id;` plus the equivalent in `worker/schema.sql`).
- Dashboard frontend reads the renamed field. No conditional `keyData.operator_id ?? keyData.principalId` ?? -shaped fallback — the auth.ts:88 read collapses to `keyData.principal_id`.
- All `__tests__/*.test.ts` SQL inserts in R2.E rename simultaneously.

**Drop all "transition window" language from R2.D / R2.E.** The cluster ships as a coordinated single-cut.

**PR scope:** PR-R2b. Includes D1 migration script + the §6 MC eventKinds sub-cluster (below).

### §3 — RESOLVED: single-cut breaking (rename to `principal_id`)

**Decision:** Rename `operator_id` JSON wire field to `principal_id` in `cloud-publisher`. Single-cut breaking; no shim.

Wire-field rename is breaking for the receiver — but the receiver is `network-registry` (internal-to-cortex per §1), so the lockstep covers both sides of the wire.

Sites:
- `src/taps/cc-events/cloud-publisher.ts:200` — `operator_id: networkConfig.operatorId` → `principal_id: networkConfig.principalId`.
- `src/taps/cc-events/__tests__/cloud-publisher.test.ts:29,35` — test helper parameter.
- `src/cli/cortex/commands/cloud.ts:446` — CLI flag `--operator-id` → `--principal-id` (single-cut; old flag rejected).
- `src/cli/cortex/commands/cloud.ts:461,475,482,497,524,552,564,577,586` — curl examples + CLI output text.

**PR scope:** PR-R2d. Lockstep-merge with PR-R7c-network-registry so both sides of the wire ship together.

### §4 — RESOLVED: `AgentConfig` (with disambiguation note)

**Decision:** `BotConfig` → **`AgentConfig`**. Final.

`AgentConfig` is the natural name for the in-memory runtime shape that wraps the canonical cortex.yaml. The previously-considered alternative `RuntimeConfig` is rejected: "runtime" is over-generic (the runner, the bus runtime, the loader all have "runtime"-shaped concepts) and `AgentConfig` better reflects the shape (one cortex process = one agent, with one cortex.yaml).

**Disambiguation with `Agent` (`z.infer<typeof AgentSchema>` at `cortex-config.ts:626`):**

Two distinct types share the `Agent*` prefix post-rename:
- `Agent` — the Zod-inferred type of a single `agents[]` entry on the cortex.yaml schema. One *element* of `principal.agents[]`.
- `AgentConfig` — the in-memory runtime shape (formerly `BotConfig`); wraps the WHOLE cortex.yaml + synthesised legacy fields. One *process*.

**Guidance (added to PR-R7a's PR body and to `cortex-config.ts` doc-comments):**
- Where `Agent` appears in code that mixes both types, prefer the explicit form `z.infer<typeof AgentSchema>` or rename the local symbol (e.g. `agent: AgentSchemaType`). The collision risk surfaces in 8 files; PR-R7a's diff annotates each one.
- The `AgentSchema` Zod export itself stays unchanged.
- The disambiguation note is added to `docs/architecture.md` §"Type vocabulary" so future contributors see the distinction.

**PR scope:** PR-R7a applies `AgentConfig` throughout the 38 importer files enumerated in R7.A above.

### §5 — RESOLVED: rename to `cortex`

**Decision:** Rename `"grove-bot"` NATS link name to `"cortex"`. Per-process identity, not per-role.

Sites:
- `src/bus/nats/connection.ts:109` — `const name = opts.name ?? "grove-bot";` → `… ?? "cortex";`. Wire-visible on `nats stream info` / `nats sub` connection list.
- `src/bus/nats/__tests__/connection.test.ts:162,168` — assertions on the default name.
- `src/bus/myelin/__tests__/runtime.test.ts:154,179` — `name: "grove-bot"` fixture; updates to `"cortex"`.

**Ops impact (flagged in PR-R7b body):** any NATS dashboards / alerts that match on the `grove-bot` link name update at deploy time. Not a code dependency; an ops-config dependency. Document in the PR body and the post-merge release notes.

**PR scope:** PR-R7b.

### §6 — RESOLVED: rename + include in this iteration (single-cut + one-shot D1 UPDATE)

**Decision:** `operator.input` → `principal.input`, `operator.curation` → `principal.curation`. Single-cut. One-shot D1 UPDATE migration. Ship in this iteration alongside PR-R2b + PR-R13d.

This was the source of the coherence problem flagged in Critical 3 (R8a UI prose calling it the "principal filter" while filtering `operator.input` events). The resolution: rename the eventKinds in the same boundary as the MC API + DB column + UI prose.

**Producer sites** (audit query: `grep -rEn '"operator\.(input|curation)"' src/`):
- `src/runner/dispatch-handler.ts` — backend producer (verify at PR time)
- `src/surface/mc/api/iteration-import.ts` — verify at PR time
- Any `taps/cc-events/*` cloud-publisher emission of these eventKinds

**Consumer sites** (verified at HEAD on `main`):
- `src/surface/mc/dashboard-v2/components/drill-log.tsx:140`
- `src/surface/mc/dashboard-v2/hooks/use-artefacts.ts:85`
- `src/surface/mc/dashboard-v2/components/event-rows.ts:67,123,248`
- `src/surface/mc/dashboard-v2/components/__tests__/event-rows.test.ts:81,85`
- `src/surface/mc/dashboard-v2/components/drill-down.tsx:121`
- `src/surface/mc/dashboard-v2/components/curation-toolbar.tsx:11`

**One-shot D1 UPDATE migration** (added to PR-R2b):

```sql
-- migrations/0006_principal_eventkinds.sql
UPDATE events SET kind = 'principal.input'    WHERE kind = 'operator.input';
UPDATE events SET kind = 'principal.curation' WHERE kind = 'operator.curation';
```

Plus the equivalent for any WebSocket protocol-version bump (handled in PR-R13d frontend rebuild). The dashboard reads the renamed eventKinds exclusively; no `kind === "operator.input" || kind === "principal.input"` dual-read shape.

**Acceptance criteria** (added to PR-R2b + PR-R13d):
1. `grep -rEn '"operator\.(input|curation)"' src/` returns 0 hits in non-test, non-historical paths.
2. The D1 migration runs cleanly (idempotent — re-running is a no-op).
3. Dashboard receives the renamed eventKinds via WebSocket post-deploy; old eventKinds are not emitted by any producer.
4. The contract test at `src/surface/mc/__tests__/events.test.ts` asserts the produced eventKind values match `principal.*` exclusively.

**PR scope:** the eventKinds rename ships inside PR-R2b (backend producers + D1 migration) + PR-R13d (frontend consumers + UI prose). The two PRs lockstep-merge.

### §7 — RESOLVED: single-cut drop on myelin R2 cut (no permanent fallback)

**Decision:** No permanent fallback period for `signed_by[].principal`. The cortex R11 PR ships **immediately after** myelin R2 cuts, with `.principal` reads removed.

The transition shim `stamp.identity ?? stamp.principal` exists today specifically because pre-cut peers might still emit `.principal`. Once myelin R2 lands, every peer in the network emits `.identity`; keeping the fallback indefinitely is dead code that hides drift bugs.

**Acceptance criteria** (added to PR-R11):
1. `grep -rEn '\.identity\s*\?\?\s*\.principal\|signedBy\[.*\]\.principal' src/` returns 0 hits in non-test, non-historical paths.
2. `verify-signed-by-chain.ts:342` reads `stamp.identity` only.
3. `envelope-validator.ts:195,458,469,473,505,512,549` collapse to `.identity`-only reads.
4. `system-events.ts:892` reads `opts.signedBy[0]?.identity ?? "unknown"`.
5. Tests in R11 cascade are updated to assert `.principal` reads are REJECTED on read (no silent fallback).

**PR scope:** LOCKSTEP PR-R11 (gated on myelin R2 merge; ships within ~1 day of myelin R2 release per the lockstep playbook).

### §8 — RESOLVED: IN scope; rename to `home_principal` (single-cut breaking)

**Question (preserved for audit trail):** Is the `home_operator` policy schema field in scope for iteration 0002, or should it be deferred?

**Decision (reversed 2026-05-27 — Andreas: "Yes it should be renamed"):** `home_operator` policy schema field is **IN scope for 0002**. Rename to **`home_principal`** (consistent with R1 `OperatorConfig → PrincipalConfig` and R2 `operatorId → principalId`). **Single-cut breaking change**, no transition shim — consistent with the §2/§3/§7 posture across this iteration. Operators with stored policy schemas re-emit on migration.

`src/common/policy/types.ts:42` declares `home_operator: string` on `PolicyPrincipal`. The field flows through:
- `src/common/policy/` — typed schema field (`types.ts`, `factory.ts`) + extensive test fixtures (~62 hits across `__tests__/`).
- `src/cli/cortex/commands/migrate-config-policy.ts` — migrate-config converter that synthesises the field on policy emission (~10 hits including a `home_operator: string` declaration at `:298`).
- `src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts` — migrate-config tests (~6 hits).
- MC sessions D1 column (`src/surface/mc/worker/migrations/0003_sovereignty.sql:8,22,24,27` + `worker/schema.sql:36,140,141`) — persisted column + index.
- MC worker state route (`src/surface/mc/worker/src/routes/state.ts` ~14 hits — query parameter, SELECT/SQL fragments, response-shape mapping at `:215,247,279,313,317,334,337,355,408,440,446,455,457,460,462`) + ingest route (`src/surface/mc/worker/src/routes/ingest.ts:141,155,213`).
- `src/common/event-processor.ts:29,35` — reads `s.home_operator` into in-memory `homeOperator` field.
- `src/common/types/cortex-config.ts:1207,1210,1212` — Zod schema declaration (`home_operator: z.string().regex(…)`) + grammar comment.
- `src/common/types.ts:66` — shape doc comment referencing the field.
- `src/runner/__tests__/dispatch-listener.test.ts` — 6 fixtures (`:914,1068,1285,2017,2076,2131`).
- `src/cli/cortex/commands/migrate-config-lib.ts:1973` — diagnostic print line `home_operator=${p.home_operator}`.

**Total live sites:** 107 hits across 21 files. Enumerated under R2.J above.

**LOCKSTEP-myelin classification:** **N — standalone cortex-internal.** The field is declared and read entirely within cortex's own policy types + MC worker + migrate-config-policy converter + cortex tests. `grep -rEn '\bhome_operator\b' src/` against `myelin/main` returns zero hits; neither cortex `CONTEXT.md` nor myelin `CONTEXT.md` mentions it as a boundary term. Per the M1–M7 layering, policy is cortex-side application logic (M7). The rename ships as a single cortex PR with no myelin coordination required.

**D1 migration:** schema migration script (`migrations/0007_principal_rename.sql`: `ALTER TABLE sessions RENAME COLUMN home_operator TO home_principal;` + `DROP INDEX idx_sessions_home_operator; CREATE INDEX idx_sessions_home_principal ON sessions(home_principal) WHERE home_principal IS NOT NULL;` + the equivalent edits to `worker/schema.sql`). One-shot, idempotent. Equivalent to the §6 / §2 D1 migration shape.

**Sub-PR PR-R2.J scope:**
- `src/common/policy/types.ts:42` declaration rename.
- `src/common/policy/factory.ts:70` field-pass-through.
- All `src/common/policy/__tests__/` fixtures updated to `home_principal:`.
- `src/cli/cortex/commands/migrate-config-policy.ts` (and its tests) updated for the renamed emit-side field + diagnostic strings.
- `src/cli/cortex/commands/migrate-config-lib.ts:1973` diagnostic.
- `src/common/event-processor.ts:29,35` rename source-of-read + retain destination `homeOperator → homePrincipal` rename in the in-memory shape.
- `src/common/types/cortex-config.ts:1207–1212` Zod schema declaration + error message.
- `src/common/types.ts:66` doc comment.
- `src/runner/__tests__/dispatch-listener.test.ts` 6 fixtures rename.
- `src/surface/mc/worker/schema.sql:36,140,141` column + index.
- `src/surface/mc/worker/migrations/0003_sovereignty.sql` doc-comments only (historical migration text is left as-is — see note below).
- `src/surface/mc/worker/migrations/0007_principal_rename.sql` new file.
- `src/surface/mc/worker/src/routes/state.ts` 14 sites (query param `?home_operator=` → `?home_principal=` is part of the wire-shape rename; single-cut breaking with the dashboard).
- `src/surface/mc/worker/src/routes/ingest.ts` 3 sites.

**Historical-migration carve-out:** `migrations/0003_sovereignty.sql` is a *past* migration file. The literal SQL text `ALTER TABLE sessions ADD COLUMN home_operator TEXT` stays — re-running 0003 in a fresh D1 must continue to add `home_operator`, which 0007 then renames. Doc-comments inside 0003 (e.g. line 8 explanatory comment) may be rewritten to reference the post-rename world if helpful, but the DDL itself stays. Same posture as the "legacy reader" carve-outs elsewhere in this plan.

**Acceptance criteria** (added to PR-R2.J):
1. `grep -rEn '\bhome_operator\b' src/` returns hits ONLY inside `migrations/0003_sovereignty.sql` (DDL preserved) and explicit `// historical:` lines.
2. The D1 migration `0007_principal_rename.sql` is idempotent (re-running is a no-op).
3. `bun test src/common/policy/` and `bun test src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts` pass with the renamed field.
4. Dashboard query-param `?home_principal=` returns the same results that `?home_operator=` did pre-cut (with the renamed underlying column).
5. `bunx tsc --noEmit` clean.

**PR scope:** PR-R2.J (sub-PR under R2 cluster — field-name renames). Single-cut breaking. Cortex-internal — **NOT LOCKSTEP-myelin**. Ships alongside PR-R2b (the MC API + D1 column boundary PR) so the dashboard sees one coordinated cut on the MC worker surface, but is technically independent of myelin's release cadence.

### §9 — RESOLVED: full rewrite (not banner+selective)

**Decision:** **Full rewrite** of `docs/design-mission-control.md`. Provenance preserved in a "History" appendix.

The doc has 91 hits of "operator" and large fractions of grove-v2 historical prose. The earlier recommendation (banner + selective rewrite) preserves provenance but leaves the doc internally inconsistent — current-tense and historical-tense sections interleave, and a reader can't tell which is which without checking blame.

**Rewrite plan:**
1. **Main body** — full rewrite to current-tense cortex. Every `operator` → `principal` or `network` (per the prose-rewrite rules in R13). Every `grove-v2` reference moves to the History appendix or is rewritten as `cortex` if it's describing current behaviour.
2. **History appendix** — new section at the end of the doc: "## History — Mission Control v2 (grove-v2) origins" with the historical prose lifted from the pre-rewrite version, explicitly marked as describing the system cortex migrated FROM. Includes the MIG-7.11 provenance note.
3. **Diff size** — ~500 LOC (the full doc is ~700 lines; the rewrite touches ~70% of it, leaving the history appendix ~150 lines).

**Acceptance criteria** (added to PR-R13e):
1. `grep -En '\boperator\b' docs/design-mission-control.md` returns hits ONLY inside the "History" appendix (which is preceded by a `<!-- historical: do not modernise -->` banner).
2. The MIG-7.11 provenance note is preserved in the appendix.
3. Internal links from other docs to design-mission-control.md headings continue to work (anchor names preserved where possible; rewrites listed in PR body).

**PR scope:** PR-R13e. Largest single PR in the iteration (~500 LOC); reviewed by Echo + Luna with extra care given the doc is design ground-truth.

---

## PR ordering

Dependency graph:

```
                  cortex#430 (merged)──┐
                  cortex#432 (merged)──┤
                                        │
                                        ▼
                     ┌──── PR-R13a (prose: types/config/cortex.ts core)
                     │
   Decision §4 ──▶ PR-R7a (BotConfig → AgentConfig; subsumes loader+watcher R2.I)
                     │      └─▶ PR-R13a tightens here
                     │
   ──────────────▶ PR-R2a (Bus + Runner downstream-API renames)
                     │      └─▶ PR-R13b (runner/bus prose sweep, with R2a)
                     │
   ──────────────▶ PR-R2c (Registry client + Adapters local-vars)
                     │      └─▶ PR-R13c (adapters prose sweep)
                     │
   Decision §1+§2+§3 ─▶ PR-R2b (MC API + DB column rename)
                     │      └─▶ PR-R13d (MC prose sweep + R8a literals)
                     │
   Decision §8     ─▶ PR-R2.J (home_operator → home_principal policy schema)
                     │      └─ pairs with PR-R2b for one MC-worker cut
                     │
   ──────────────▶ PR-R6  (persona → assistant prose sweep)
                     │
   ──────────────▶ PR-R8a-docs (literal "operator cockpit"/"operator filter" docs-only substitution)
                     │
   ──────────────▶ PR-R12 (Reach → Scope, 1-line doc fix; roll into PR-R13a)
                     │
   ──────────────▶ Decision §5 ─▶ PR-R7b (grove-bot literal cleanups)
                     │
   ──────────────▶ PR-R13e (docs sweep, with §9 decision)
                     │
   myelin R2  ──▶ LOCKSTEP PR-R11
   myelin R7  ──▶ LOCKSTEP PR-R4a + PR-R4b
   myelin R11 ──▶ LOCKSTEP PR-R5
   myelin R13 ──▶ LOCKSTEP PR-R10
```

### Recommended sequence

1. **PR-R13a** — prose sweep over `src/common/types/` + `src/common/config/` + `src/cortex.ts` + R1/R3/R12/R5:522 (Critical 2) doc-comment cleanup. Unblocks readability; no wire change. (~300 LOC)
2. **PR-R7a** — `BotConfig` → **`AgentConfig`** rename (Q4 resolved) + `BotConfig.agent.operator*` field rename + `personaFile` synthesised field retirement (Major 2) + watcher paths + loader-synthesis rename + R7.B.i runtime-injected preamble strings (Major 4) + R7.B.i regression test. (~450 LOC)
3. **PR-R2a** — Bus + Runner downstream API parameter rename: `verifySignedByChain`, `BusDispatchListener`, `DispatchListener`, `AgentTeam`. (~250 LOC)
4. **PR-R2c** — Registry client + Adapters local-var rename **+ R13.B.i `LoadedConfig.operator` → `.principal` field rename** (Major 3 coupling: adapters get one coherent edit). (~120 LOC)
5. **PR-R8a-docs** — literal "operator cockpit" / "operator filter" substitutions in **pure docs only** (2 hits: `architecture.md:666`, `design-mission-control.md:21`). The other 4 dashboard-coupled hits roll into PR-R13d alongside the §6 MC eventKinds rename. (~2 LOC)
6. **PR-R6** — `persona` domain term sweep + variable renames in non-carve-out locations. (~80 LOC)
7. **PR-R13b** — `src/runner/` + `src/bus/` prose sweep (non-cascaded) + R5:282 + R5:runtime.test.ts:532 "broadcast loop" → "Offer loop" per CONTEXT.md (Major 5). (~250 LOC)
8. **PR-R13c** — `src/adapters/` prose sweep. (~50 LOC)
9. **PR-R7b** — `grove-bot` → **`cortex`** literal cleanups (Q5 resolved; NATS link name `connection.ts:109` + test `connection.test.ts:162,168` + `runtime.test.ts:154,179`), `bot.yaml` → `cortex.yaml` security preamble text, doc comments. (~60 LOC)
10. **PR-R7c-network-registry** — `network-registry/*` symbol + wire-shape rename (Q1 resolved: IN scope). `OperatorRecord` → `PrincipalRecord`, `operator_id`/`operator_pubkey` → `principal_id`/`principal_pubkey`, `RegistryStore.putOperator` → `.putPrincipal`, route `/operators/:operator_id` → `/principals/:principal_id`. Touches `src/services/network-registry/{src,__tests__}/`. Single-cut breaking (internal-to-cortex consumer is `cloud-publisher.ts`). (~250 LOC)
11. **PR-R2b** — MC API JSON shape + D1 column **single-cut rename** (Q2 resolved: no transition shim) + `OperatorKey` → `PrincipalKey` (Major 1) + D1 schema migration script (`tasks.operator_id` → `tasks.principal_id`) + the §6 MC eventKinds rename (`operator.input` → `principal.input`, `operator.curation` → `principal.curation`) with a one-shot D1 UPDATE migration + WebSocket protocol version bump. Pairs with PR-R13d. (~400 LOC backend, ~250 LOC test/migration)
12. **PR-R2.J** — `home_operator` → `home_principal` policy schema rename (cluster section R2.J / Q8 resolved 2026-05-27: IN scope). **Single-cut breaking**, no transition shim. Cortex-internal — **NOT LOCKSTEP-myelin** (zero `home_operator` hits in myelin source; neither CONTEXT.md treats it as a boundary term). Touches `src/common/policy/{types,factory}.ts` + tests, `src/cli/cortex/commands/migrate-config-policy.ts` + tests, `src/common/event-processor.ts`, `src/common/types/cortex-config.ts:1207–1212`, `src/common/types.ts:66`, `src/runner/__tests__/dispatch-listener.test.ts` fixtures, `src/surface/mc/worker/{schema.sql,src/routes/{state,ingest}.ts}`, new `src/surface/mc/worker/migrations/0007_principal_rename.sql`. Ships alongside PR-R2b for one coordinated MC-worker cut. (~210 LOC)
13. **PR-R2d** — cloud-publisher wire field `operator_id` → `principal_id` **single-cut breaking** (Q3 resolved) + CLI flag `--operator-id` → `--principal-id`. Lockstep with PR-R7c-network-registry (cloud-publisher is the network-registry consumer). (~80 LOC)
14. **PR-R13d** — MC backend + frontend prose sweep (`src/surface/mc/`). Subsumes the 4 dashboard-coupled hits from the old R8a (`use-hash-state.ts:47`, `state.ts:61`, `state.ts:447`, `slack-adapter.test.ts:1403`) + the MC eventKinds-coupled prose. Pairs with PR-R2b. (~400 LOC backend, ~300 LOC frontend tests)
15. **PR-R13e** — `docs/` sweep + **full rewrite of `docs/design-mission-control.md`** (Q9 resolved: full rewrite, not banner+selective). Provenance preserved in a "History" appendix marked explicitly historical. (~500 LOC)
16. **LOCKSTEP with myelin R2 → PR-R11** — drop `signed_by[].principal` reader fallback **single-cut** (Q7 resolved: no permanent fallback period; ships immediately after myelin R2 cut, with `.principal` reads removed). (~50 LOC)
17. **LOCKSTEP with myelin R7 → PR-R4a + PR-R4b** — drop `{org}` placeholder + rename `org` → `principal` in cortex local code. (~100 LOC)
18. **LOCKSTEP with myelin R11 → PR-R5** — drop `"broadcast"` distribution_mode union arm. (~20 LOC)
19. **LOCKSTEP with myelin R13 → PR-R10** — drop `target_principal` reader fallback. (~20 LOC)

### Estimated totals

- **Total cortex-internal PRs:** 15 (steps 1–15 in the recommended sequence above).
- **Total LOCKSTEP-with-myelin PRs:** 4 (steps 16–19 — PR-R4a/b, PR-R5, PR-R10, PR-R11; gated on the corresponding myelin breaking cuts).
- **Grand total:** **19 PRs** (15 cortex-internal + 4 LOCKSTEP). Up from the previous 18 — Q8 reversal (2026-05-27) adds PR-R2.J as a new cortex-internal sub-PR (NOT LOCKSTEP-myelin).
- **Total LOC envelope:** ~3,400–4,000 (cumulative; mostly mechanical). Up from the pre-Q8-reversal ~3,200–3,800 estimate by ~+210 LOC for PR-R2.J (policy schema declarations + factory + event-processor + MC worker routes + new D1 migration file + test-fixture sweep across ~21 files). Original baseline +~700 LOC over the pre-sweep ~2,500–3,000 envelope (Q1 network-registry + Q6 MC eventKinds + Q9 design-mission-control rewrite), now +~910 LOC including Q8.
- **Breaking changes:**
  - cortex.yaml schema — already shipped (R3 / v3.0.0).
  - PR-R2b — D1 column rename + MC API JSON-shape rename + `OperatorKey` → `PrincipalKey` + eventKinds rename (Q2 + §6: single-cut, no transition shim).
  - PR-R2.J — `home_operator` → `home_principal` policy schema rename + D1 column rename + MC worker route query-param rename (Q8 resolved 2026-05-27: single-cut breaking, cortex-internal — NOT LOCKSTEP-myelin).
  - PR-R2d — `cloud-publisher` wire field `operator_id` → `principal_id` + CLI flag `--operator-id` → `--principal-id` (Q3: single-cut).
  - PR-R7a — internal `BotConfig` → `AgentConfig` type rename (importers update; not wire).
  - PR-R7c-network-registry — `OperatorRecord` symbol + REST path + JSON wire renames (Q1: single-cut; internal-to-cortex consumer at this stage).
  - PR-R11 — myelin R2 LOCKSTEP single-cut (Q7: no permanent fallback).
  - PR-R5, PR-R10, PR-R4a/b — myelin R7/R11/R13 LOCKSTEP cuts (breaking on the bus, coordinated with myelin's breaking major).
- **Out of scope:** none. All 9 open questions resolved IN scope for iteration 0002 (Q8 reversed from deferred to in-scope on 2026-05-27).

---

## Completion signal — what proves the 0002 cluster is fully done

In addition to 0001's existing completion criteria:

1. **`bun check:vocab` passes with the tightened allowlist** — the CI grep guard from 0001's completion criterion #2 now lists ONLY:
   - `src/cli/cortex/commands/migrate-config-lib.ts` (legacy reader carve-out)
   - `src/cli/cortex/commands/__tests__/migrate-config*.ts` (legacy fixtures)
   - `src/taps/cc-events/hooks/lib/principal-env.ts` (GROVE_OPERATOR fallback tier — separate migration)
   - `src/taps/cc-events/hooks/__tests__/` (GROVE_* test fixtures)
   - `src/taps/cc-events/wrangler.toml` `GROVE_API` binding
   - `src/surface/mc/worker/migrations/0003_sovereignty.sql` — historical DDL adding `home_operator` column (renamed by 0007; 0003 stays unchanged so fresh-D1 re-runs of past migrations remain valid).
   - Historical commentary marked with `// historical:` or `<!-- historical -->`
   - The `docs/design-mission-control.md` "History" appendix (Q9: full rewrite preserves grove-v2 provenance in a clearly-marked appendix)

   Note: `src/services/network-registry/` is NO LONGER on the allowlist — Q1 resolved IN scope, so the registry is fully renamed in PR-R7c-network-registry.
2. **No active code emits `"broadcast"` distribution_mode** — verified by `grep -rEn 'distribution_mode\s*[:=]\s*["'\'']broadcast' src/`.
3. **No active code reads `signed_by[N].principal` without first reading `.identity`** — or, post-myelin-R2 cut, no active code reads `.principal` at all.
4. **No active code reads `target_principal` without first reading `target_assistant`** — or post-cut, no read at all.
5. **No `BotConfig` type alive in `src/` outside `migrate-config-lib.ts` carve-out** — verified.
6. **All `operator`/`Operator` references in `src/` are either in the allowlist or describe a platform-bot user** — verified.

---

## Tracking issue

This continuation manifest is filed under [cortex#426](https://github.com/the-metafactory/cortex/issues/426) (C-388 follow-up tracking). Each PR-N entry above gets its own sub-issue under that tracking issue once execution begins.

## Cross-references

- Iteration-1 manifest: [docs/migrations/0001-vocabulary-grilled-2026-05.md](./0001-vocabulary-grilled-2026-05.md)
- Tracking issue: [cortex#426](https://github.com/the-metafactory/cortex/issues/426)
- Already-merged PRs: cortex#430 (R2 cortex.ts entrypoint), cortex#432 (migrate-config v3-complete)
- Myelin manifest: [myelin#164](https://github.com/the-metafactory/myelin/pull/164) (merged)
- Cortex CONTEXT.md: `./CONTEXT.md`
- Compass context map: `compass/ecosystem/CONTEXT-MAP.md`
