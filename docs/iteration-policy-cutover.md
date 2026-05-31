# Iteration — v2.0.0 policy cutover

**Design spec:** [`docs/design-policy-cutover.md`](./design-policy-cutover.md)
**Parents:** [cortex#243](https://github.com/the-metafactory/cortex/issues/243) (CLI work) + [cortex#242](https://github.com/the-metafactory/cortex/issues/242) (breaking removal)
**Target version:** v2.0.0

## Goal

Retire the legacy per-adapter `roles[]` blocks from `DiscordPresenceSchema` / `MattermostPresenceSchema` / `SlackPresenceSchema`. Make the top-level `policy: { principals[], roles[] }` block the authoritative source for all authorization decisions. PolicyEngine becomes the single decision point; adapters become thin lookup-and-call shells.

## Why this iteration exists

Phase C.2a (PR #219) shipped the additive `policy:` block. The legacy per-adapter `roles[]` schema has remained in place since — both shapes coexist. v2.0.0 is the cleanup: drop the legacy, commit to PolicyEngine-only, give operators a `migrate-config` path to lift their existing configs.

Naive framing of cortex#242/#243 is "lift roles[] into policy:". The design spec (PR #291, ratified through 3 review rounds) surfaces why this understates the work and locks in the schema + 5-PR sequence below.

## Dependency DAG

```
243a  ──┬──►  243c  ──┐
        │             │
243b  ──┘             ├──►  242b  (v2.0.0 bump)
                      │
        243a  ──►  242a  ──┘
```

- **243a + 243b** are parallelisable (no dependency between them)
- **243c** depends on both (CLI uses schema + tool inventory)
- **242a** depends only on 243a (parallel mode runs against legacy configs)
- **242b** depends on 243c (operators have migration path) AND 242a (parallel validated)

## Slices

### cortex#243a — Schema extension (additive, non-breaking)

Add to `PolicyPrincipalSchema` in `src/common/types/cortex-config.ts`:

- [ ] `platform_ids: z.record(z.string().regex(LETTER_PREFIX_ID_REGEX), z.array(z.string()))` (open record, not closed enum — pressure-test §15.5 finding)
- [ ] `session_config: { default: SessionConfigShape, dm?: SessionConfigShape }` with `SessionConfigShape = { allowed_dirs, allowed_skills, bash_guard, bash_allowlist }`
- [ ] Principal-id uniqueness scoped to `(id, home_stack)` — replaces existing `id`-only uniqueness in the `.refine()` validator (per §15.4 multi-stack collision resolution)
- [ ] `(platform_name, platform_id)` tuple uniqueness across all principals
- [ ] Convention note in JSDoc: federation-peer principals SHOULD NOT carry `platform_ids` (identity asserted via `signed_by` chain's stack NKey)
- [ ] Unit tests for all of the above
- [ ] Cross-link the schema JSDoc back to `docs/design-policy-cutover.md` §16

**Scope:** ~150 LOC + tests. Single PR. Purely additive — no consumer changes, no migration involved.

### cortex#243b — Canonical tool inventory (parallelisable with 243a)

- [ ] New file `src/common/policy/tool-inventory.ts` exporting canonical list of Claude tool names (`Bash`, `Edit`, `Write`, `NotebookEdit`, `Read`, `Glob`, `Grep`, `Task`, `TodoWrite`, etc.)
- [ ] Helper `invertDisallowedTools(disallowed: string[]): string[]` returning the complement set as `tool.<name>` capability ids
- [ ] Unit tests pinning the canonical list against the current Claude SDK shape
- [ ] No consumers yet — 243c will be the first

**Scope:** ~50 LOC + tests. Single PR. Independent of 243a; can ship in parallel.

### cortex#243c — migrate-config CLI extension

In `src/cli/cortex/commands/migrate-config.ts` + `migrate-config-lib.ts`:

- [ ] Read legacy `agents[].presence.<discord|mattermost|slack>.roles[]` from input `cortex.yaml`
- [ ] Unify per-user across the three adapter copies (§11.3 — 3 agents × 10 roles → 12 distinct principals + 3 synthetic anonymous + 1 template)
- [ ] Emit top-level `policy.principals[]` per §6 algorithm — synthesise principal IDs from platform user IDs (or read from optional `--labels labels.yaml`)
- [ ] Emit top-level `policy.roles[]` with namespaced capabilities (`keyword.{chat,async,team}`, `tool.<name>` via 243b's `invertDisallowedTools`, `operator`, `dispatch.<agent_id>`) <!-- historical: `operator` here is the reserved policy-capability literal (migrate-config-policy.ts §5.5/§12.1); code identifier, not human-operator prose; not renamed by vocab-migration 0002 -->
- [ ] Synthesise anonymous-per-instance principals for `defaultRole` semantic (§5.4)
- [ ] Synthesise principal from `agent.operatorDiscordId/Mattermost/Slack` + DM `operatorRole` → `session_config.dm`
- [ ] Emit external-peer principals with `home_operator: "unknown"` + warning per §12.3
- [ ] Cross-adapter role-conflict handling — warn + conservative union (§13 Q4)
- [ ] **New `--check` mode** for the 242a principal pre-flight: fail when legacy role-resolver's principal set is not a subset of the new `policy.principals[]` lookup space (§9.1)
- [ ] Idempotent: running twice produces identical output
- [ ] Principal-facing SOP at `docs/sop-migrate-config.md`
- [ ] Sample inputs + expected outputs in `docs/migration-examples/`
- [ ] Migration test against principal's actual `cortex.yaml` (snapshot test)

**Scope:** ~400 LOC + tests + docs. Single PR but the biggest of the five.

### cortex#242a — Adapter PolicyEngine wiring (parallel mode)

In `src/adapters/discord/index.ts`, `src/adapters/mattermost/index.ts`, `src/adapters/slack/index.ts`:

- [ ] Add PolicyEngine consultation alongside (not replacing) the legacy role-resolver
- [ ] Lookup principal by `(platform, message.author.id) → principal` using the new `platform_ids` index
- [ ] For each gating decision (keyword feature, tool, allowedDirs, allowedSkills, bashGuard), call `policyEngine.check(principalId, intent)`
- [ ] **Resolution semantic:** most-restrictive intersection of legacy + new gates (§9.1 — security default, NOT new-system-wins)
- [ ] Emit `system.access.disagreement` envelopes when legacy and new disagree (audit + dashboard visibility)
- [ ] Add `system.access.disagreement` to `src/bus/system-events.ts` envelope builders
- [ ] Add `cortex.yaml` flag `policy.parallel_mode_enabled` to gate the parallel-mode rollout per-deployment (default off until principal opts in)
- [ ] Integration tests pinning intersection semantics for: both-allow, both-deny, legacy-allow-new-deny, legacy-deny-new-allow
- [ ] Principal pre-flight doc note: `migrate-config --check` MUST pass before enabling parallel mode

**Scope:** ~250 LOC + tests. Single PR. Adapter changes touch 3 files but mechanically similar.

### cortex#242b — Legacy schema removal + v2.0.0 bump

- [ ] Drop `DiscordInstanceSchema.roles[]` + `defaultRole`
- [ ] Drop `MattermostInstanceSchema.roles[]` + `defaultRole`
- [ ] Drop `SlackInstanceSchema.roles[]` + `defaultRole`
- [ ] Drop entire `DMConfigSchema`
- [ ] Drop `AgentSchema.operatorDiscordId/Mattermost/Slack` + `AgentSchema.roles[]`
- [ ] Delete `src/adapters/discord/role-resolver.ts`
- [ ] Remove parallel-mode plumbing added in 242a — PolicyEngine is the sole gate
- [ ] Strict-mode parse error on legacy configs with pointer to `migrate-config`
- [ ] Bump `arc-manifest.yaml` → `v2.0.0`
- [ ] Update `docs/design-policy-cutover.md` status: "ratified" → "shipped"
- [ ] Migration test: every existing test that previously seeded `presence.discord.roles[]` now seeds `policy.principals[] + policy.roles[]` (~30 tests touched)

**Scope:** ~300 LOC removed + ~30 tests updated. Single PR. The breaking change.

## Acceptance — when is this iteration done?

- [ ] All 5 sub-issues merged
- [ ] `arc-manifest.yaml` at v2.0.0
- [ ] Principal's `~/.config/cortex/cortex.yaml` migrated via `migrate-config` and running cleanly
- [ ] `~/.config/cortex/cortex.work.yaml` rewritten by `migrate-config` to namespaced capabilities (`keyword.chat` etc.)
- [ ] PolicyEngine is the sole authorization decision point — no role-resolver code anywhere
- [ ] Phase E gaps explicitly tracked in their own follow-up issues (per-principal federated caps; Q2 `capabilities:` block)

## What this iteration deliberately does NOT do

- **Per-principal capability checks on federated dispatches.** Today's federation gate (Phase D) is network-level (`accept_subjects[]` + peer roster). Per-principal capability checking on inbound federated traffic is Phase E follow-up. The v2.0.0 schema doesn't block any approach.
- **Q2 stack capability advertisement** (`capabilities:` block for the cloud network registry). Distinct namespace from `PolicyRole.capabilities[]` (auth vs. advertisement). Lands as Phase E additive work.
- **Cloud-side network registry service** for cross-principal discovery. Phase E.

## Status tracking

This iteration's checkboxes ARE the status. As each slice ships, tick its sub-issue's items here AND in the parent issue (cortex#242 or cortex#243). When all five are merged, this file's "Acceptance" section ticks fully and the iteration closes.
