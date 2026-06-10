<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# Cortex -- Layer-7 collaboration surface for the metafactory Myelin stack

Layer-7 collaboration surface for the metafactory Myelin stack

## Domain Context

Before doing work in this repo, load the domain language:

- **`./CONTEXT.md`** — this repo's bounded-context glossary, if present. One canonical term per concept, with the aliases to avoid. If you find yourself using a term loosely, check it here first. Every ecosystem repo is expected to grow a `CONTEXT.md` (authored via the `grill-with-docs` skill).
- **`compass/ecosystem/CONTEXT-MAP.md`** — the ecosystem context map: the bounded contexts (soma, cortex, myelin, signal, …) and how their boundary terms reconcile.

When `CONTEXT.md` and your instinct disagree, `CONTEXT.md` wins. When a term crosses a repo boundary, the `CONTEXT-MAP.md` is authoritative.

## Architecture

cortex is the **M7 application** of the metafactory Myelin stack — the operator's collaboration surface that consumes the bus (M2–M6) and presents activity to humans. It replaces both `the-metafactory/grove` (legacy v0.29.0) and `the-metafactory/grove-v2` (v0.22.1) as the canonical home for Discord/Mattermost adapters, Mission Control dashboard, workflow runner, and bus-side taps.

cortex is layer 7 in the OSI-style **M1–M7 Myelin stack**:

```
M7 SURFACES (cortex, pilot, signal-collector, future apps) ← cortex lives HERE
M6 COMPOSITION (myelin)
M5 DISCOVERY   (myelin)
M4 IDENTITY    (myelin)
M3 ENVELOPE    (myelin — schema + namespace)
M2 TRANSPORT   (myelin abstraction over NATS)
M1 CONNECTIVITY (NATS leaf nodes / federation)
```

cortex consumes contracts from M2–M6, owns no part of M1–M6 itself, and shares M7 with sibling apps (pilot for review-loop coordination, signal-collector for telemetry, future apps).

Internal componentisation (per `docs/architecture.md` §8):

- `src/cortex.ts` — Top-level entrypoint (MIG-7.1). Wires bus + adapters + runner + taps + renderers.
- `src/bus/` — M2–M6 client code: NATS connection, envelope validator, surface-router, dispatch-handler, system-events. The G-1100 ladder lifted from grove-v2 plus the surface-router (G-1111.A).
- `src/bus/myelin/` — Vendored myelin schema + envelope + subscription primitives.
- `src/bus/nats/` — NATS client wrapping.
- `src/surface/mc/` — Mission Control v3 (149 files lifted from grove-v2 `src/mission-control/`). API, state, DB, dashboard-v2 React tree, worker (CF Worker REST API + WebSocket), notifications.
- `src/adapters/` — Platform adapters (Discord, Mattermost) that register with the surface-router rather than subscribing to NATS directly. `mock.ts` for tests.
- `src/runner/` — CC orchestration: cc-session (streaming `claude --print --output-format stream-json`), session-manager (per-thread CC session for `--resume`), stream-parser, agent-team (multi-agent moderator + participants), dispatch-listener, security-preamble, prompt-builder, worklog-manager, task-tracker, bash-guard hook.
- `src/taps/` — Publishers onto the bus: `cc-events/` (CC hooks + EventLogger + relay + cloud-publisher), `gh-webhook/` (CF Worker at `hooks.meta-factory.ai` validating GitHub HMAC and forwarding).
- `src/cli/` — Principal CLIs: `discord/` (post messages, read channels, list threads from terminal), `cldyo-live` (instrumented Opus session wrapper), `cortex/` (top-level CLI).
- `src/renderers/` — Renderer interface + dashboard renderer + pagerduty renderer (the G-1111 §4.6 fail-safe pair).
- `src/common/` — Shared types + utilities: agent-detection, event-processor, event-utils, github-events, agents/, config/, timeout, types/, usage.
- `src/services/` — launchd plists: `ai.meta-factory.cortex.meta-factory.plist` (metafactory dev stack), `ai.meta-factory.cortex.work.plist` (parallel work stack — cortex#244), `ai.meta-factory.cortex.relay.plist` (shared relay).
- `src/settings/` — `cortex-hooks.json` (CC hook registration).
- Config: `~/.config/cortex/cortex.yaml` (post-MIG-7.9 — migrated from grove-v2 `~/.config/grove/bot.yaml` via `migrate-config`).

Read `docs/architecture.md` for the full layered model + agent + presence/renderer model + event architecture + agent task routing pattern. Read `docs/plan-cortex-migration.md` for the per-phase migration plan (MIG-0..MIG-8) that drives all current work.

## Migration provenance

cortex inherits source from `the-metafactory/grove-v2`. Legacy `the-metafactory/grove` (v0.29.0) is in maintenance-mode for security work and contributes nothing to cortex (per migration plan §2.2 — ~6,500 LOC of legacy-only agent/persona/AAA + parallel NATS work that does not migrate).

The migration is phased MIG-0 (bootstrap) through MIG-8 (legacy retirement). Per-phase work is tracked as GitHub issues `cortex#1` umbrella (C-100) + `cortex#2..#10` for each phase.

## Message Keywords

- `async:` prefix — fire-and-forget. Ack immediately, post result when done.
- `team:` prefix — spawn multi-agent team (moderator + participants).
- No prefix — synchronous chat, response posted when CC finishes.

## Discord Channel Routing

Repos get channels. GitHub entities get threads. No `cortex.yaml` config needed.

```
#cortex (channel)                  — repo context
  └── cortex/issue/9 (thread)      — issue #9
  └── cortex/pr/54 (thread)        — PR #54
  └── cortex/c-108 (thread)        — feature C-108 (→ resolves to issue)
```

When invoked from a channel or thread, the agent should:
1. Match channel name against `github.repos` short names → scope work to that repo
2. If in a thread, parse the entity: `{repo}/issue/{N}`, `{repo}/pr/{N}`, `{repo}/{feature-id}`
3. When starting work on an entity with no existing thread, create one
4. Route worklog to the invoking thread/channel

See `docs/sop-discord-channel-routing.md` for the full SOP (lifted from grove-v2 at MIG-7.11).

## PAI Integration

cortex provides two ways to integrate from PAI sessions (outside of Discord):

### Session Instrumentation (live dashboard)

Any Claude Code session can pipe events to the cortex Mission Control dashboard by setting env vars:

```bash
CORTEX_CHANNEL=<name> CORTEX_AGENT_NAME=<display> CORTEX_AGENT_ID=<id> claude
```

| Env Var | Purpose | Example |
|---------|---------|---------|
| `CORTEX_CHANNEL` | **Required.** Enables the EventLogger hook. Value is the channel/identity label. | `andreas` |
| `CORTEX_AGENT_NAME` | Display name shown on dashboard agent cards. | `Andreas` |
| `CORTEX_AGENT_ID` | Agent identifier for event correlation. | `andreas` |
| `CORTEX_PRINCIPAL` | Principal (the human running the stack) stamped onto events for correlation. | `Andreas` |

During the MIG-7 cutover window the legacy `GROVE_*` env vars remain accepted by the EventLogger for backward compatibility; new sessions should prefer the `CORTEX_*` names. The deprecation shim retires at MIG-8.

`CORTEX_PRINCIPAL` is the vocabulary-migration (R9) rename of the operator-the-human env var. During the transition release the EventLogger still accepts the legacy `CORTEX_OPERATOR` (emits a deprecation warning) and `GROVE_OPERATOR` names; both fallbacks are removed in the breaking v3.0.0.

**Event pipeline:** CC hooks → `~/.claude/events/raw/` → cortex-relay (policy filter) → `~/.claude/events/published/` → cortex daemon (`ai.meta-factory.cortex.meta-factory` and/or `.work` plist) → bus → dashboard API → `cortex.meta-factory.ai`

**Pre-configured wrapper:** `cldyo-live` (at `~/.local/bin/`) starts an instrumented Opus session. Plain `cldyo` stays dark (no events). Use `cldyo-live` when you want your work visible on the dashboard.

### Discord CLI (team updates)

Post messages to Discord channels from any terminal session:

```bash
discord post "PR merged, tests passing"              # Default channel
discord post --channel tasks "Deployed v0.5.0"       # Specific channel
discord post --thread 1487204875912609844 "Done"     # Specific thread
discord read                                          # Read last 10 messages
```

Useful at the end of workflows to update the team. See `discord --help` for full command list.

## Configuration files

cortex is configured with the **config-split (multi-file) layout** — this is the
**standard**. A stack's config is a directory the daemon points `--config` at; a
pointer (sentinel) file's dirname selects the layout, and the boot composer
(`composeRawConfig`, `src/common/config/loader.ts`) deep-merges the layers in a
fixed precedence (later layers win on leaf keys), producing the SAME
`LoadedConfig` the old single file produced.

| Layer | Owns | Blast radius |
|---|---|---|
| `system/system.yaml` | substrate / transport: `claude`, `execution`, `attachments`, `paths`, **`nats` (incl. the `nats.subjects` landmine — ONE place), `bus`** | whole stack |
| `network/*.yaml` | federation roster (`policy.federated.{registry, networks[]}`) — OPTIONAL | cross-principal |
| `surfaces/surfaces.yaml` | shared surface-gateway bindings (Discord/Slack/Mattermost tokens) — OPTIONAL | cross-stack |
| `stacks/*.yaml` | per-deployment `principal` / `stack` / `policy` / `capabilities` / `agents` / `github` | one stack |

Precedence: `system/` → `network/*` (sorted) → `surfaces/` → `stacks/*` (sorted).
`nats.subjects` lives in **exactly one place** (`system/system.yaml`) — a
duplicate double-binds the boot subscriber and double-delivers every envelope
(cortex#491). Never re-declare it in a stack file.

- **Single-file `cortex.yaml` is LEGACY.** It still loads via the transitional
  single-file fallback (no `system/system.yaml` marker present), so monolith
  deployments keep working — but it is not the form a fresh install should adopt.
- **Pointer-file naming is load-bearing.** cortex derives its single-instance
  PID file from the `--config` basename; per-stack deployments MUST give each
  pointer a per-stack name (`research.yaml`, `work.yaml`, …), never a uniform
  `cortex.yaml`, or the second daemon collides on `cortex-cortex.pid`.

**Canonical template:** [`docs/config-layout/`](docs/config-layout/) — copy that
directory to `~/.config/cortex/<slug>/`, fill the `<REPLACE_ME>` markers, point
your daemon at the pointer file. The repo-root `cortex.yaml.example` is the
legacy single-file reference. See
[`docs/config-layout/README.md`](docs/config-layout/README.md),
[`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) (Step 3 copies
this template), and
[`docs/migrations/0003-config-split-layout.md`](docs/migrations/0003-config-split-layout.md).


## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- An **"X doesn't exist" claim is an assertion — verify it before acting on it.** Grep is case- and separator-blind: a `response_routing` search silently misses `responseRouting`/`ResponseRouting`. Before concluding a symbol/field/string is absent, prefer **LSP symbol search** (`workspaceSymbol`/`findReferences`), or grep case-insensitively (`-i`) and across snake/camel/Pascal variants. Case-blind greps have caused both a missed-migration cluster and a redundant rebuild of already-shipped code.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.
- Before merging a PR, verify the branch is up to date with the base branch. If other PRs have merged since the branch was created, rebase or merge base into the branch first. Squash merges on stale branches silently overwrite changes that landed in the interim -- this has caused data loss (PR #120 overwrote real page implementations with stubs).
- Control plane vs data plane: review-style output (PR review, design note, code analysis, decision record) goes to **GitHub** as a full PR/issue comment via `gh pr comment` / `gh issue comment` (or `gh pr review` for formal approvals). Then post a **one-liner in the matching Discord entity thread** (`{repo}/pr/{N}` or `{repo}/issue/{N}`) — verdict, counts, deep link to the GitHub comment. Discord = control plane; GitHub = data plane. See [docs/design-control-vs-data-plane.md](https://github.com/the-metafactory/compass/blob/main/docs/design-control-vs-data-plane.md) for exceptions and rationale.
- **Dual-announce for community-announced repos.** Post **when you land a PR** (on merge) — and on release — keeping development interactive/visible; you need not cut a version release on every PR. Before posting, check whether the repo is **community-announced**. The authoritative, single-source list is the set of repos flagged `community_announce: true` in [`compass/ecosystem/repos.yaml`](https://github.com/the-metafactory/compass/blob/main/ecosystem/repos.yaml) (1:1-linked to meta-factory product repos that are public or shortly becoming public; the list is dynamic — repos join it as they go public, so read the registry, never a hardcoded name list). Post to **the repo's OWN channel** — `#<repo>` (e.g. `#signal` for signal, `#cortex` for cortex, `#myelin`, `#arc`, `#soma`), **never** a fixed channel. Then:
  - **Community-announced repo →** post to that repo's `#<repo>` channel on **BOTH** Discord servers — two `discord` CLI calls:
    - `discord post --channel <repo> "<announcement>"` (the **grove** server, default)
    - `discord post --guild <community-guild-id> --channel <repo> "<announcement>"` (or `--server <community-profile>`) for the **metafactory-community** server
  - **Not community-announced →** post to the **grove** server's `#<repo>` channel only.
  - **No PII or secrets in the community post** — the metafactory-community server is public-facing. The community copy carries the public-safe announcement only; keep internal IDs, principal-private detail, and unreleased specifics out of it.

- During migration phases (MIG-0..MIG-8), every PR cites a phase + checklist item from `docs/plan-cortex-migration.md`. The plan is the ground truth for what moves where; if the plan and reality disagree, update the plan first, then the code.
- The architecture spec (`docs/architecture.md`) is **static reference** — when the plan and architecture disagree on what cortex IS, the architecture wins. When the plan and reality disagree on migration mechanics, the plan wins (or is updated, never silently).
- NEVER add CF Access bypass-everyone policies or disable authentication on any endpoint. If cross-origin auth fails, fix the architecture (same-subdomain routing, proper CORS), don't bypass auth. If you encounter a bypass-everyone policy during any investigation, immediately flag it as a SEV-1 security finding.
- cortex does NOT have: ProcessManager, ManagedProcess, FileWatcher, `grove.config.ts`, or any process orchestration. The runtime is a single `src/cortex.ts` entrypoint plus relay + CLIs; daemons are launchd plists, not bot-side orchestration.
- NEVER use empty catch blocks. Every catch must either: (a) log the error via `process.stderr.write()` or the event pipeline (`system.error` event), (b) handle it meaningfully (e.g., return a fallback value with a comment explaining why), or (c) name the variable with `_err` and add a comment explaining why it's safe to ignore. Silently swallowing errors hides bugs.
- Hooks must stay non-blocking. The cc-events EventLogger writes JSONL to `~/.claude/events/raw/` and returns; the cortex-relay process picks up files asynchronously. Never call out to the bot, the bus, or any network endpoint from inside a hook.
- Migration moves preserve behavior. MIG-1..MIG-7 PRs are file moves + minimal import-path rewrites unless the plan explicitly calls for a refactor. If a move tempts you to "fix something while I'm in here", file a follow-up issue instead.

## CLAUDE.md Management

**CLAUDE.md is fully generated — NEVER hand-edit it.** It is produced by `arc upgrade compass` from:

- **Template:** `compass/templates/CLAUDE.md.template` (shared ecosystem template; the installed copy lives at `~/.config/metafactory/pkg/repos/compass/templates/CLAUDE.md.template`)
- **Config:** `agents-md.yaml` (repo-specific placeholders and section list)
- **Section files:** `docs/agents-md/*.md` (repo-specific content injected at marked positions)

**To change agent rules:**

1. Edit the appropriate section file in `docs/agents-md/`:
   - `architecture.md` — System architecture overview + migration provenance
   - `critical-rules.md` — Repo-specific rules (injected after the standard Critical Rules block)
   - `implementation-workflow.md` — Migration + feature workflow, blueprint integration
   - `dashboard-deployment.md` — CF Pages / wrangler deploy instructions
   - `message-keywords.md` — Bot message keyword reference
   - `discord-routing.md` — Discord channel routing SOP
   - `pai-integration.md` — PAI session instrumentation and Discord CLI
2. Update `agents-md.yaml` if adding a new section file (specify `position` and `file`)
3. Regenerate: `arc upgrade compass` (regenerates CLAUDE.md for every repo under `~/Developer/` that has an `agents-md.yaml`)
4. Commit both the source files AND the regenerated `CLAUDE.md`

**Injection positions:** `after:description`, `after:critical-rules`, `after:sop-table`, `after:versioning`

## Open Source Attribution

When incorporating open-source code, UX patterns, or significant ideas from other projects:

1. Add an entry to `THIRD-PARTY-NOTICES.md` with: repository URL, author, license type, full license text, and a note explaining what was incorporated (code import vs pattern inspiration)
2. If the source project has no LICENSE file but declares a license in README, note this discrepancy
3. The dashboard footer links to `THIRD-PARTY-NOTICES.md` on GitHub for end-user visibility

## Generated images

All AI-generated images (architecture diagrams, infographics, etc.) for cortex follow the ecosystem rule:

- **Source of truth** lives in **`~/Documents/andreas_brain/assets/`** following the naming convention `YYYY-MM-DD-{topic}/YYYY-MM-DD-{descriptive-name}.{ext}`.
- **Repo copy** at `docs/diagrams/` is for inline rendering in `docs/architecture.md`, README, and design specs. Treat the repo copy as a render artifact; the andreas_brain copy is the source.
- The art skill outputs to `~/Downloads/` first for preview; once approved, move to andreas_brain (not directly into the repo).
- Existing example: `docs/diagrams/cortex-architecture.jpg` + source at `~/Documents/andreas_brain/assets/2026-05-09-cortex-architecture/2026-05-09-cortex-architecture.jpg`.

When updating or regenerating a diagram, update both the andreas_brain canonical copy and the in-repo render copy.


## GitHub Labels (ecosystem standard)

All metafactory ecosystem repos use a shared label set. Do not create ad-hoc labels.

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `bug` | Something isn't working | `#d73a4a` | Defect tracking |
| `documentation` | Improvements or additions to documentation | `#0075ca` | Docs work |
| `feature` | Feature specification | `#1D76DB` | Feature work |
| `infrastructure` | Cross-cutting infrastructure work | `#5319E7` | Infra/tooling |
| `now` | Currently being worked | `#0E8A16` | Priority: active |
| `next` | Next up after current work | `#FBCA04` | Priority: queued |
| `future` | Planned but not yet scheduled | `#C5DEF5` | Priority: backlog |
| `handover` | NZ/EU timezone bridge -- work session summary | `#F9D0C4` | Async handoffs |

| `migration` | | | Project-specific |

Every issue must have at least one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`) if open.

## GitHub Issue Tracking
When working on a GitHub issue in this repo, keep the issue updated as you work. This is default agent behavior, not optional.

**On starting work:**
- Comment on the issue: what you're working on.
- Example: `gh issue comment 1 --body "Starting: implement initial project structure"`

**During work:**
- Link every PR to its issue with `Closes #N` in the PR body (or `gh pr create` with an issue reference).
- If the issue body has a flat checkbox list, tick items as you complete them.

**On completing work:**
- Comment with a summary: what was done, what changed, any follow-up needed.
- Merging the PR auto-closes the issue via `Closes #N`. For iteration umbrellas, the sub-issue rollup updates automatically.
- If the issue is not PR-closable (e.g. a tracking or umbrella issue), close it manually once every child is done.

### Iteration umbrellas (sub-issues, not flat checkboxes)

Iterations with more than ~3 slices use GitHub's native **sub-issues**:

```
Iteration umbrella issue (parent)
  ├── sub-issue: slice A feature issue → closed by its PR
  ├── sub-issue: slice B feature issue → closed by its PR
  └── sub-issue: slice C feature issue → closed by its PR
```

- The umbrella links the `iterations/iteration-{n}.md` file in its body. Slice issues are added as sub-issues, not as markdown bullets.
- Each slice is a real issue (assignable, commentable, PR-linkable). Its PR closes it.
- The parent aggregates progress automatically — no manual ticking of nested checkboxes.
- Update both the repo iteration file and the umbrella when slices are added, split, or reprioritised.

**Tooling:** `gh extension install yahsan2/gh-sub-issue` gives `gh sub-issue add <parent> <child>`. Otherwise use the "Sub-issues" section on any issue page or the REST API (`POST /repos/{owner}/{repo}/issues/{n}/sub_issues`).

**Why:** GitHub is the shared collaboration surface. Team members and agents all read it. If you do work but don't update the issue, it looks like nothing happened.

## Standard Operating Procedures

This repo follows ecosystem SOPs defined in [compass](https://github.com/the-metafactory/compass). **Before starting work, identify which SOPs apply and Read them. Output the pre-flight line from each loaded SOP.**

| SOP | Activate when | File |
|-----|--------------|------|
| **Dev pipeline** | Creating branches, making PRs, starting any feature/fix work | `compass/sops/dev-pipeline.md` |
| **Versioning** | After merging PRs, before deploying, any version bump | `compass/sops/versioning.md` |
| **Deployment** | Deploying to dev or production after a release | `compass/sops/deployment.md` |
| **Worktree discipline** | Starting feature work (always — even solo) | `compass/sops/worktree-discipline.md` |
| **Design process** | Creating specs, design docs, or research docs | `compass/sops/design-process.md` |
| **Retrospective** | Post-work review, extracting process patterns | `compass/sops/retrospective-and-process-mining.md` |
| **New repo** | Bootstrapping a new repository in the ecosystem | `compass/metafactory/sops/new-repo.md` |
| **PR review** | Reviewing a PR, before approving or merging | `compass/sops/pr-review.md` |
| **Federation wire protocol** | Writing/reviewing any `federated.*` / cross-principal bus code (subjects, source, originator, deriveNatsSubject, selectLink, peers[], review consumer) | `compass/sops/federation-wire-protocol.md` |
| **Autonomous work** | Driving delegated work unattended (principal asleep/away) — slice loop, review, gate, merge | `compass/sops/autonomous-work.md` |
| **Security incident response** | Detecting, containing, or investigating a security finding | `compass/metafactory/sops/security-incident-response.md` |

### Examples

**Starting a feature:**
```
Task: "Add a dashboard panel"
→ Activate: dev-pipeline + worktree
→ Read both SOPs
→ Output: "SOP: dev-pipeline | Branch: feat/g-300-panel | Prefix: feat:"
→ Output: "SOP: worktree | Worktree: ../Cortex-panel | Branch: feat/g-300-panel | Main: untouched"
```

**After merging a PR:**
```
Task: "Merge PR #42"
→ After merge, activate: versioning
→ Read SOP
→ Output: "SOP: versioning | Current: v0.2.0 | Bump: patch → v0.2.1"
```

## Implementation Workflow

cortex uses one feature numbering scheme during MIG-0..MIG-8 and adds a second one after cutover:

- **C-series** (e.g., C-108): cortex features and migration phases. Tracked in `blueprint.yaml` + GitHub issues (`cortex#1` umbrella for C-100, `cortex#2..#10` for C-101..C-109 migration phases).
- **MIG-N.x** (e.g., MIG-7.10): per-phase checklist items in `docs/plan-cortex-migration.md`. Each MIG-N maps to one C-NNN feature.
- **F-/G-series** (post-MIG-8): inherited from grove-v2 design specs that migrate at MIG-7.11. Activate after the migration plan retires.

**Workflow (migration mode — MIG-0..MIG-8):**

```
1. Read docs/plan-cortex-migration.md — pick the next phase + checklist item
2. Check blueprint.yaml: `blueprint ready` shows what's unblocked
3. Create feature branch via worktree:
     git worktree add ../cortex-{slug} -b feat/c-{id}-{slug} origin/main
4. Implement the move/refactor (most files are ports from grove-v2; few new)
5. Push + open PR with title `feat(cortex): C-NNN.X — {scope} (MIG-N.Y)`
6. Drive PR through pilot-loop review (Echo for code review, Luna for design review)
7. After merge: tick the checkbox on BOTH docs/plan-cortex-migration.md AND the GitHub issue
8. Close the phase issue when all its phase items tick
```

**Workflow (post-MIG-8, normal feature mode):**

```
1. Read the design spec (e.g., docs/design-collaboration-surface.md)
2. Pick next feature by dependency order from the iteration plan
3. Create feature branch: feat/c-{id}-{slug} (or feat/f-{id}-{slug}, feat/g-{id}-{slug})
4. Work the checkboxes against acceptance criteria in the design spec
5. PR → review → merge to main
6. Tick checkboxes in BOTH the iteration plan AND the GitHub tracking issue
```

**Sync rule:** Iteration plans exist in two places — `docs/iteration-*.md` (repo artifact, agents read it) and a GitHub Issue (trackable, commentable). When a checkbox is completed, update both.

**Migration artefacts:**
- `docs/plan-cortex-migration.md` — Per-phase migration plan (MIG-0..MIG-8). Drives all current work; retires at MIG-8.
- `docs/architecture.md` — Canonical M1–M7 stack + cortex internal componentisation. Static reference.

**Design + iteration docs** (lifted from grove-v2 at MIG-7.11):
- `docs/design-collaboration-surface.md` + `docs/iteration-collaboration-surface.md`
- `docs/design-mission-control.md` + `docs/iteration-mission-control.md`
- See `docs/` for the full set.

## Platform Management

`cortex stack` + `cortex network` are the control plane for a stack's full lifecycle: stand one up locally (`stack`), then federate it onto a network (`network`).

### Standing up a stack

`cortex stack create <slug>` scaffolds a config-split stack skeleton **born aligned** — the dir basename, the slug, and the trailing segment of `stack.id` are all the same — so the slug↔`stack.id` drift the install-time `warn_stack_identity_drift` detector catches ([ADR-0004](docs/adr/0004-stack-slug-authority.md)) can never form for a stack created this way. It is the prevent-side complement to that detector.

| Command | Purpose |
|---|---|
| `cortex stack create <slug> [--principal <id>] [--apply]` | Scaffold a born-aligned (dir==slug==`stack.id` trailing segment), unique-within-principal config-split stack from the `docs/config-layout/` template (#808). Sets `stack.nkey_seed_path` to the conventional path — `arc upgrade Cortex` auto-provisions the seed. Dry-run by default; never overwrites an existing dir. |
| `cortex stack list [--config-dir <path>]` | List discovered stacks with their `stack.id` and an aligned/DRIFT flag. |

### Network lifecycle

A **network** is a federation of principals whose stacks interconnect at the NATS leaf-node layer ("feel like TCP/IP" join, #738).

| Command | Purpose |
|---|---|
| `cortex network create <id> --hub <tls-url> --leaf-port <port> --admin-seed <path> [--apply]` | Network admin stands up a NEW network's topology row in the registry — a signed-admin claim, **no raw SQL** (#747). Dry-run by default. |
| `cortex network join <id> [--principal-seed <root>] [--apply]` | A principal joins one of their stacks to a network. Derives inputs from `cortex.yaml` (#753). Idempotent. Dry-run by default. |
| `cortex network status --principal <id>` | Read-only: joined networks, leaf link state, peers, accept-subjects, counters. |
| `cortex network leave <id> [--apply]` | Reverse a join cleanly + idempotently. Dry-run by default. |
| `cortex provision-stack register <principal> --seed-path <p> --registry-url <u> [--principal-seed <root>]` | Register a stack's pubkey + capabilities with the registry (proof-of-possession). |

The one-rule essentials:

- **Stacks are scaffolded with `cortex stack create`** — born aligned (dir==slug==`stack.id` trailing segment) so drift can't form, and unique within the principal (it refuses a dir collision OR a duplicate `stack.id`). Dry-run by default; pass `--apply` to write.
- **Networks are created with `cortex network create`, not SQL.** The registry's `POST /networks/<id>` is fail-closed: the admin pubkey must be on `REGISTRY_ADMIN_PUBKEYS` or it returns `503 admin_not_configured` / `403 admin_not_authorized`.
- **A principal's 2nd+ stack joins with `--principal-seed <root>`** (the FIRST stack's seed, #791). The add-stack claim is root-signed and fetch-merges the principal's existing stacks so they survive; on the standalone `provision-stack register` path the pinned `--registry-pubkey` is also required. Omit `--principal-seed` for a first-stack join.
- **A federating stack's bus must be operator-mode** — it must define the NSC operator + the account the leaf binds to (mirror `~/.config/nats/local.conf`). An **anonymous / hard-isolated** bus (the `halden` / `community` pattern) **cannot federate**: the leaf remote names an account the server doesn't know and `nats-server` crashes. The #794 fix makes `cortex network join` refuse (fail-fast) on such a bus rather than taking it offline — convert the bus to operator-mode first.
- **`stack create` / network `join` / `leave` / `create` default to dry-run** — they print the intended actions and touch nothing. Pass `--apply` to mutate the live deployment.

SOPs: [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) (stand up a stack with `cortex stack create`, then federate it; §B0.1 operator-mode bus), [`docs/sop-network-join.md`](docs/sop-network-join.md) (join / multi-stack / status / leave), [`docs/sop-federation-onboarding.md`](docs/sop-federation-onboarding.md) (peer-principal onboarding).


## Blueprint-Driven Development

All ecosystem repos track features in `blueprint.yaml`. Before starting feature work, check the dependency graph:

```bash
# What's ready to work on? (dependencies satisfied)
blueprint ready

# Claim a feature
blueprint update {REPO_SHORT}:{ID} --status in-progress

# After PR merges
blueprint update {REPO_SHORT}:{ID} --status done
blueprint lint   # Validate graph integrity
```

**Statuses:** Only `planned`, `in-progress`, and `done` are settable. `ready`, `blocked`, and `next` are computed from the dependency graph.

**Cross-repo dependencies:** Use `{repo}:{ID}` format (e.g., `grove:G-200`, `arc:A-100`). A feature is `blocked` if any dependency in another repo isn't `done`.

## Versioning & Releases

See `compass/sops/versioning.md` for the full procedure. Key repo-specific details:

- Version source of truth: `arc-manifest.yaml`
- Release title format: `"Cortex vX.Y.Z -- Short Description"`
- Deploy command: `arc upgrade Cortex`

## Dashboard Deployment

The dashboard frontend (`src/surface/mc/dashboard-v2/`) is a React app deployed to **Cloudflare Pages** as a separate step. It is NOT automatically deployed via GitHub — it requires a manual build + deploy.

**Project:** `grove-dashboard` on CF Pages → `grove.meta-factory.ai`. The DNS rename to `cortex.meta-factory.ai` is out of scope for v1 cortex (see `docs/plan-cortex-migration.md` open question 12) — operator-facing brand (`Cortex`) and the legacy DNS host can legitimately differ; rename is a separate post-MIG-8 phase with a 30-day redirect window.

**Deploy workflow:**

```bash
# 1. Build the frontend (from repo root)
bun build src/surface/mc/dashboard-v2/index.html --outdir dist/dashboard-v2 --target browser

# 2. Deploy to CF Pages
bunx wrangler pages deploy dist/dashboard-v2 --project-name grove-dashboard
```

The `build:dashboard` + `watch:dashboard` scripts in `package.json` codify steps 1.

**When to deploy:**
- After any change to `src/surface/mc/dashboard-v2/` files (app.tsx, types.ts, hooks, etc.)
- After merging a PR that modifies dashboard components
- The backend (`cortex` bot via `arc upgrade Cortex`) and the frontend (CF Pages via `wrangler`) are deployed independently.

**Architecture:**
- `cortex` serves the REST API + WebSocket at `localhost:8767` locally, or via the CF Worker at `grove.meta-factory.ai/api/*` in production (`src/surface/mc/worker/`).
- The dashboard frontend is static HTML/JS hosted on CF Pages.
- Frontend connects to the API via URL params (`?api=`) or auto-detection.
- CF Access cookies cover dashboard + API on each TLD (`.ai`, `.dev`, `.io`) — no cross-origin cookie issue, no bypass-everyone policies (see Critical Rules).


## Multi-Agent Worktree Discipline

See `compass/sops/worktree-discipline.md` for the full procedure. Key repo-specific details:

- Worktree directory pattern: `../Cortex-{slug}`
- Example: `git worktree add ../Cortex-feature -b feat/{branch-name} main`

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
