# Cortex — Vocabulary Migration Manifest (2026-05)

**Status:** draft for review · deterministic ground truth · iteration 1
**Source:** `CONTEXT.md` (cortex) + `compass/ecosystem/CONTEXT-MAP.md` — grill-with-docs sessions, May 2026
**Companion manifests:** [myelin#164](https://github.com/the-metafactory/myelin/pull/164) (merged), pilot#136
**Method:** every entry below was produced by `rg -n` against `main` (current branch base). Each cited line is a real occurrence in the codebase at that commit; nothing is inferred. Where a line could not be pinned to an exact number, the entry says so and defers to a PR-time `rg` pass.

Read this as the script: each PR claims one rename or one cluster, performs every listed change, runs `bun test && bunx tsc --noEmit`, opens for review.

**The principal has decided the full vocabulary rename proceeds** — this is a root-cause fix across the ecosystem, not a one-line patch. This manifest's job is to make that rename *correct, complete, and safe to execute* on the cortex side.

cortex is downstream of [myelin#164](https://github.com/the-metafactory/myelin/pull/164) — every wire-field rename (R2, R6, R11, R13 in the myelin manifest) cascades into a cortex consumer change tracked here. The myelin manifest is the contract; this manifest is the cortex adaptation.

---

## Rename inventory (canonical)

| # | Old | New | Tier | Scope | Source |
|-----|---|---|---|---|---|
| R1 | `OperatorConfig` (TS type + Zod schema) | `PrincipalConfig` | 2 | code + schema | cortex-Q2 |
| R2 | `operatorId` (variable, JSON, env) | `principalId` | 2 | code + tests + env | cortex-Q2 |
| R3 | `operator.id` (cortex.yaml schema key) | `principal.id` | **3 (BREAKING v3.0.0)** | schema + migrate-config | cortex-Q2 |
| R4 | `{org}` subject-segment derivation + `org` parameter | `{principal}` / `principal` | 3 (wire) | code + tests + comments | cortex-Q3 (consumes myelin R7) |
| R5 | `Broadcast` / `"broadcast"` dispatch mode + `distribution_mode` enum value | `Offer` / `"offer"` | 3 (wire) | code + tests + comments | cortex-Q13b (consumes myelin R11) |
| R6 | `persona` (domain term in code/comments) | `assistant` | 1 (concept) | code + tests + comments | cortex-Q4 — **filename `personas/luna.md` stays** |
| R7 | `bot` (when meaning the daemon — `cortex-bot`, `bot.yaml` legacy) | `agent` | 2 | code + comments + service names | cortex-Q4 |
| R8 | Mission Control copy: "operator cockpit" → "principal cockpit"; "operator filter" → "principal filter" | (literal substitution) | 1 | dashboard UI prose | cortex-Q2 |
| R9 | env vars `CORTEX_OPERATOR_*` | `CORTEX_PRINCIPAL_*` | 2 | env + launchd plists + docs | cortex-Q2 |
| R10 | `target_principal` (wire field, consumed from myelin envelopes) | `target_assistant` | 3 (wire) | code + tests | cortex-Q5 (consumes myelin R13) |
| R11 | `signed_by[].principal` / `originator.principal` (wire fields, consumed) | `.identity` | 3 (wire) | code + tests | consumes myelin R2 |
| R12 | "Reach" column header in any subject-namespace doc | "Scope" | 1 | docs only | cortex-Q10 (consumes myelin R8) |
| R13 | Prose `operator` (mechanically resolvable) | `principal` or `network` | 1 | prose | cortex-Q2 + myelin-Q2 |

### Renames this manifest does NOT make

- **GitHub-org name in URLs** (`the-metafactory/...`, `metafactory.io`, `meta-factory.ai`) — DNS/registry strings, not the cortex `operator`-the-human concept. Left unchanged.
- **NSC `OP_*` account names** — NATS infrastructure terminology; cortex inherits the same R12b carve-out as myelin.
- **`grove-v2`/`grove` references** — historical content describing the system cortex migrated *from*. Left unchanged; that is a record, not live vocabulary.
- **`bot` in Discord/Slack contexts where it means "Discord bot user / API client"** — that's the platform's term, not the cortex daemon. The R7 rename only touches `bot` when meaning the cortex daemon (e.g. `cortex-bot.service` → `cortex-agent.service`).

### R3 note — `operator.id` is a BREAKING config schema change

`operator.id` is a persisted-config field consumed at every stack startup (`src/common/config/loader.ts`). Renaming it requires:
- A v3.0.0 major bump on cortex.
- An updated `migrate-config` CLI that rewrites `operator.id` → `principal.id` (extending the existing grove-v2 → cortex.yaml migration path).
- A **mixed-version-tolerance read window** where loader accepts BOTH `operator:` and `principal:` blocks during the transition major. The breaking major removes the `operator:` reader.
- **`dual_field_conflict` rejection (per myelin manifest pattern):** if a single `cortex.yaml` contains BOTH `operator:` and `principal:` blocks, loader MUST raise a typed `dual_field_conflict` error before any membership / capability decisions are made (this is a deployment-config trust boundary). Loader ships a regression test asserting the conflict rejection.

### R5 + R10 + R11 — consumed wire changes from myelin

Cortex does not own these field/enum names — myelin does. The rename lands on cortex when myelin ships the corresponding PR in the [myelin#164 manifest](https://github.com/the-metafactory/myelin/pull/164):

- R5 (`"broadcast"` → `"offer"`) lands when myelin's R11 PR ships
- R10 (`target_principal` → `target_assistant`) lands when myelin's R13 PR ships
- R11 (`signed_by[].principal` → `.identity`) lands when myelin's R2 PR ships

Each cortex follow-up PR for these renames runs in lockstep with its myelin sibling (companion PR). The myelin transition release accepts both old and new names; cortex updates its readers, then both sides cut over to the breaking major together.

---

## Per-cluster changes

### Config schema + loader cluster

**Files (verified via `rg`):**
- `src/common/config/loader.ts` — `OperatorConfig` Zod schema + `operator:` block parsing
- `src/common/config/__tests__/loader.test.ts` — fixtures
- `src/cli/cortex/commands/migrate-config.ts` — `operator.id` → `principal.id` rewriter
- `src/cli/cortex/commands/__tests__/migrate-config.test.ts` — golden fixtures

**Scope:** R1 + R3 + R13 (prose).

**Key rename pattern:**
```yaml
# Before
operator:
  id: jc
  dataResidency: NZ

# After (v3 breaking)
principal:
  id: jc
  dataResidency: NZ
```

Transition major accepts both blocks but rejects when both are present (dual_field_conflict).

### Bus + dispatch cluster

**Files (verified via `rg`):**
- `src/bus/myelin/runtime.ts`, `src/bus/myelin/envelope-validator.ts` — consumes wire field names; updates when myelin R2 ships
- `src/bus/myelin/vendor/envelope.schema.json` — vendored myelin schema; updates when myelin's $id → v2 ships
- `src/runner/review-consumer.ts` — already partially aligned (cortex#384 PR shipped Pilot-shape acceptance); will rename `OFFER_DISPATCH_REVIEWER` references when R5 lands
- `src/__tests__/iaw-phase-d-integration.test.ts` — fixture envelopes carrying `distribution_mode: "broadcast"`

**Scope:** R4 + R5 + R10 + R11 (all cascade from myelin).

### Runner + agent-team cluster

**Files (verified via `rg`):**
- `src/runner/cc-session.ts`, `src/runner/agent-team.ts` — `persona` references in code + comments
- `src/runner/__tests__/agent-team.test.ts` — already touched by cortex#385 (testClaude gating). R6 renames `persona` → `assistant` where it refers to the named being (not the file).

**Scope:** R6 (concept rename — filename `personas/luna.md` stays).

### Surface / Mission Control cluster

**Files (verified via `rg`):**
- `src/surface/mc/dashboard-v2/` — React components with copy ("operator cockpit", "operator filter")
- `src/surface/mc/api/` — REST handlers, JSON shapes carrying `operatorId`
- `src/surface/mc/server.ts` — start-up paths
- `src/surface/mc/__tests__/*.test.ts` — fixture rename cascade

**Scope:** R2 + R8 + dashboard-side renames. Sub-cluster A: API + server. Sub-cluster B: dashboard React (separate PR — large React rename surface; can ship independently after API stabilises).

### CLI + env-var cluster

**Files (verified via `rg`):**
- `src/cli/cortex/commands/*.ts` — `CORTEX_OPERATOR_*` env references
- `src/services/*.plist` — launchd plists
- `src/taps/cc-events/` — `CORTEX_CHANNEL` / `CORTEX_AGENT_*` already aligned; check `CORTEX_OPERATOR_*` cleanup needed

**Scope:** R9 (with compat-shim during transition release that accepts both old and new env var names).

### Discord adapter cluster

**Files (verified via `rg`):**
- `src/adapters/discord/` — `bot` references in code (R7 — `bot` daemon vs. Discord-bot-user; flag each)
- `src/adapters/discord/__tests__/` — fixture cascade

**Scope:** R7 (selective — only daemon-meaning).

### Persona / personas/ directory cluster

**Files (verified via `rg`):**
- `personas/luna.md`, `personas/echo.md`, etc. — filenames STAY (per CONTEXT.md flagged ambiguity)
- Comments/docs referring to "persona" as a domain term → renamed to "assistant"

**Scope:** R6 prose only.

---

## PR ordering (dependency-ordered sequence)

```
PR-1  src/common/config/loader.ts       — R1 (OperatorConfig → PrincipalConfig type)
      + Zod schema                        with deprecated re-export alias.
                                          R3 transition: loader accepts BOTH
                                          `operator:` and `principal:` blocks,
                                          rejects when both present.
PR-2  migrate-config CLI                — R3 rewriter (operator.id → principal.id);
                                          companion PR to PR-1.
PR-3  CORTEX_OPERATOR_* env vars       — R9 with compat shim. Touches plists +
                                          CLI commands + docs.
PR-4  persona/assistant prose rename    — R6 + R13. No code semantics change;
                                          comments + variable names.
PR-5  Mission Control React UI         — R8 dashboard copy. Independent of
                                          backend rename — UI text only.
PR-6  Mission Control REST + server    — R2 (operatorId → principalId) on JSON
                                          shapes + handlers. Companion to PR-5.
PR-7  bot → agent (daemon-meaning)      — R7. Service-name rename. Plist update.
PR-8  Wire-field consumers              — R10 + R11 (cascade from myelin#164).
                                          LOCKSTEP with myelin's R2/R13 PR
                                          shipping.
PR-9  Broadcast → Offer dispatch        — R5 (cascade from myelin's R11 PR).
                                          LOCKSTEP with myelin.
PR-10 {org} → {principal} subject       — R4 (cascade from myelin's R7 PR).
                                          LOCKSTEP with myelin.
PR-11 Major version bump                — v3.0.0 release. Removes the
                                          transition-window compat shims.
                                          Deletes the deprecated `operator:`
                                          loader path + `operatorId` field +
                                          env-var compat shim.
PR-12 docs + comments + CHANGELOG       — R12 + R13 prose cleanup. Can run
                                          parallel.
```

PR-1..PR-7 are cortex-internal renames; PR-8..PR-10 are myelin-cascade renames that land in lockstep with myelin's matching follow-ups. PR-11 is the breaking major.

---

## Completion signal — what proves the cortex migration is done

1. **Integration test on the new shape:** a `tests/integration/` test publishes a `pilot request-review` envelope using the new vocabulary end-to-end (subject `local.{principal}.{stack}.tasks.code-review.typescript`, payload `target_assistant`, envelope `signed_by[].identity`) and asserts cortex's `ReviewConsumer` accepts and routes it. This test depends on the matching myelin transition release.

2. **CI vocab grep guard:** a CI check asserts no `operator` and no `operatorId` appear in `src/` outside an explicit allow-list. Allow-list: the R12b NSC carve-out (NATS infra), `bot.yaml` legacy-config migration paths in `migrate-config.ts` (historical record), the deprecated back-compat aliases, and the dashboard's grove-v2 historical-banner copy. Any new occurrence fails CI. Implement as a `bun` script in `package.json` (`check:vocab`) — mirror myelin#164's same guard.

3. **Deprecated aliases removed:** the v3.0.0 major has deleted every `@deprecated` alias (`OperatorConfig`, `operatorId`, `CORTEX_OPERATOR_*` env shim, etc.) — confirmed by the grep guard.

4. **`cortex.yaml` migration tested:** `migrate-config` round-trips a v2 `operator:`-shaped cortex.yaml into a v3 `principal:`-shaped one without losing fields; the loader rejects a config that contains BOTH blocks with `dual_field_conflict`.

5. **All companion PRs in myelin merged + cut over:** the myelin breaking major is live; cortex's wire-field consumers (R5/R10/R11) read the new names; cortex's v3.0.0 is tagged.

---

## Tracking issue

This manifest is filed under [cortex#388](https://github.com/the-metafactory/cortex/issues/388). Each PR-N entry above gets its own sub-issue under that tracking issue once execution begins.

## Cross-references

- Cortex CONTEXT.md: `~/work/mf/cortex/CONTEXT.md`
- Myelin manifest: [myelin#164](https://github.com/the-metafactory/myelin/pull/164) (merged)
- Pilot manifest: [pilot#136](https://github.com/the-metafactory/pilot/pull/136) (open)
- Compass context map: `~/work/mf/compass/ecosystem/CONTEXT-MAP.md`
- Vocab-alignment plan: `~/.claude/PAI/MEMORY/WORK/vocab-alignment/PLAN.md`
