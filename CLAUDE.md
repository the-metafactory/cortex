<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# Cortex -- Layer-7 collaboration surface for the metafactory Myelin layer model

Layer-7 collaboration surface for the metafactory Myelin layer model

## Domain Context

Before doing work in this repo, load the domain language:

- **`./CONTEXT.md`** — this repo's bounded-context glossary, if present. One canonical term per concept, with the aliases to avoid. If you find yourself using a term loosely, check it here first. Every ecosystem repo is expected to grow a `CONTEXT.md` (authored via the `grill-with-docs` skill).
- **`compass/ecosystem/CONTEXT-MAP.md`** — the ecosystem context map: the bounded contexts (soma, cortex, myelin, signal, …) and how their boundary terms reconcile.

When `CONTEXT.md` and your instinct disagree, `CONTEXT.md` wins. When a term crosses a repo boundary, the `CONTEXT-MAP.md` is authoritative.

<!--
  Wire-contract grounding — optional per-repo slot (`wire_grounding`).

  Repos that touch the wire (subject grammar, envelope, identity, transport,
  discovery, admission — the M2–M6 protocol contracts of the Myelin layer model)
  populate this slot with a trigger→RFC routing table so wire-touching work is
  routed to the governing myelin RFC on demand rather than always-loaded. The
  slot renders empty for repos with no wire surface.

  How to populate (per-repo, NOT here): add to the repo's `agents-md.yaml`
      sections:
        - position: "after:domain-context"
          file: docs/agents-md/wire-grounding.md
  and author the trigger→RFC table in that section file. The template owns the
  slot; the repo owns the table content. See compass/standards/domain-grounding.md.
-->
### Wire-contract grounding (RFC routing)

cortex's bus client (`src/bus/**`) implements the **client side** of the myelin wire
contracts. The contracts themselves are **normative** and live in myelin, not here — so
wire-touching work is routed to the governing RFC **on demand** rather than always-loaded.
Before you touch a row's surface, **Read the RFC** it points at, then proceed grounded (same
"trigger → Read the governing document → proceed" shape as the SOP activation table below).

The RFCs are addressed **cross-repo** — they live in `the-metafactory/myelin` `specs/rfc/`,
never a local cortex path. The routing table is a copy of a list myelin owns; a CI no-drift
check (`scripts/check-wire-vocab.ts`) asserts every path below resolves to a real file in the
myelin pack.

| Trigger — you are touching… | Governing RFC (`the-metafactory/myelin specs/rfc/`) |
|---|---|
| `did:mf` identifiers, actor/agent id, `signed_by` chain construction (`verify-signed-by-chain.ts`, `envelope-builder.ts`) | `rfc-0001-identifiers.md` |
| subjects, `deriveNatsSubject`, subject namespace/grammar, `nats.subjects` (`surface-router.ts`, `network-resolver.ts`, `nats/`) | `rfc-0002-subject-namespace.md` |
| envelope format, headers, payload, the envelope validator (`myelin/envelope-validator.ts`, `envelope-builder.ts`) | `rfc-0003-envelope.md` |
| envelope signing, signature verification, key material (`verify-signed-by-chain.ts`, `verifier-self-check.ts`) | `rfc-0004-envelope-signing.md` |
| sovereignty, boundary crossing, `federated.*`, `source`/`originator`, `selectLink`, cross-principal routing (`sovereignty-gate.ts`, `network-resolver.ts`) | `rfc-0005-sovereignty-and-boundary-crossing.md` |
| membership, admission, join/leave, admit request (`admission/`, `admit-offered-dispatch.ts`, `stack-provisioning.ts`) | `rfc-0006-membership-and-admission.md` |
| transport, delivery modes, backoff, request-reply, reliability (`nats/`, `jetstream/`) | `rfc-0007-transport-and-reliability.md` |
| capability discovery, signed capability advertisements (`capability-registry.ts`, `probe-responder.ts`) | `rfc-0008-capability-discovery.md` |
| rate-limit / refusal / access-denied taxonomy (`gate-floor.ts`, `access-denied-dedup.ts`, `emit-system-access-denied.ts`) | `rfc-0010-rate-limit-and-refusal-taxonomy.md` |

When work touches the economics or wire-change-control surfaces, add the matching rows
(`rfc-0009-economics.md`, `rfc-bcp-0001-wire-change-control-and-versioning.md`). The RFC
grammar is normative for `src/bus/**`: code conforms to the spec; a spec change is a wire
change (governed by `rfc-bcp-0001`), a code change that diverges from the spec is a bug. See
`compass/standards/domain-grounding.md` and `src/bus/CLAUDE.md`.


## Architecture

cortex is the **M7 application** of the metafactory Myelin layer model: the principal's collaboration surface. It consumes the bus (M2–M6), owns no part of M1–M6, and presents activity to humans. The runtime is one entrypoint, `src/cortex.ts`, plus the relay and CLIs; daemons are launchd plists. No platform adapter lives in-tree: `web`, `slack`, `mattermost` and `discord` are first-party arc adapter bundles (ADR-0024).

cortex inherits its source from `the-metafactory/grove-v2`. The migration runs in phases MIG-0 to MIG-8, planned in `docs/plan-cortex-migration.md`.

### Task guides

Read the guide when your task touches its area. These are not loaded by default.

| When the task involves | Read |
|---|---|
| Finding your way around `src/`, or the layer model | `docs/agent-guide/architecture.md`, then `docs/architecture.md` |
| Stack configuration, `system.yaml`, `inference`, pointer files | `docs/agent-guide/config-files.md` |
| Picking up a MIG item or feature, branch and PR naming, ticking plans | `docs/agent-guide/implementation-workflow.md` |
| `cortex stack` or `cortex network` commands, federation | `docs/agent-guide/platform-management.md` |
| Building or deploying the dashboard or worker | `docs/agent-guide/dashboard-deployment.md` |
| Discord channels and threads, `async:` and `team:` messages | `docs/agent-guide/discord-routing.md`, `docs/agent-guide/message-keywords.md` |
| Session instrumentation (`CORTEX_*` env vars), the `discord` CLI | `docs/agent-guide/pai-integration.md` |
| Editing CLAUDE.md, shippable-path gates, third-party code, diagrams | `docs/agent-guide/repo-conventions.md` |
| Wire contracts in `src/bus/**` | `src/bus/CLAUDE.md` and `docs/agents-md/wire-grounding.md` |


## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- An **"X doesn't exist" claim is an assertion — verify it before acting on it.** Grep is case- and separator-blind (`response_routing` misses `responseRouting`): prefer LSP symbol search, or grep case-insensitively across snake/camel/Pascal variants.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- **Wrap the substrate — user-facing flows are tool-commands-only.** No onboarding or operational step a person follows should require a raw substrate command (raw `nsc`/`nats-server`, `wrangler`/D1, SQL, low-level `git` plumbing, etc.). If a step needs the substrate, wrap it behind a first-class verb of the tool. A raw substrate command surfacing in an SOP or onboarding step is a **finding, not a step** — a tool exposes its own domain language and never leaks the layer it is built on.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.
- Before merging a PR, verify the branch is up to date with the base branch. If other PRs have merged since the branch was created, rebase or merge base into the branch first. Squash merges on stale branches silently overwrite changes that landed in the interim -- this has caused data loss (PR #120 overwrote real page implementations with stubs).
- Control plane vs data plane: review-style output (PR review, design note, code analysis, decision record) goes to **GitHub** as a full PR/issue comment via `gh pr comment` / `gh issue comment` (or `gh pr review` for formal approvals). Then post a **one-liner in the matching Discord entity thread** (`{repo}/pr/{N}` or `{repo}/issue/{N}`) — verdict, counts, deep link to the GitHub comment. Discord = control plane; GitHub = data plane. See [docs/design-control-vs-data-plane.md](https://github.com/the-metafactory/compass/blob/main/docs/design-control-vs-data-plane.md) for exceptions and rationale.
- **Dual-announce on merge and release.** Post to the repo's own `#<repo>` channel on the grove server; if the repo is flagged `community_announce: true` in [`compass/ecosystem/repos.yaml`](https://github.com/the-metafactory/compass/blob/main/ecosystem/repos.yaml), post a public-safe copy to the metafactory-community server too. Commands and rules: [`compass/standards/agent-conventions.md`](https://github.com/the-metafactory/compass/blob/main/standards/agent-conventions.md).
- **Confidentiality — treat this repo as exposed unless you've confirmed otherwise.** Before every commit, push, or PR (titles included — a leaked term in a PR title is still a leak), self-check: no client or engagement names, phrases, or acronyms/codes derived from them; no real people's identities, emails, or seed data anywhere — including seeds/migrations/fixtures — use placeholders; no live platform IDs (Discord/Slack channel or guild snowflakes, webhook URLs, tokens); deployment-specific config lives in `~/.config/<tool>/` on the machine running the stack, never committed to this repo. Every shippable path (`agents.d/`, `personas/`, `arc-manifest*.yaml`, and anywhere `arc` ships verbatim) carries only `.example`/`<REPLACE_ME>`/zeroed placeholders. Never use a real organization as a doc or code example. See [`compass/standards/data-classification.md`](https://github.com/the-metafactory/compass/blob/main/standards/data-classification.md) for the full class taxonomy and placeholder mapping.

- During migration phases (MIG-0..MIG-8), every PR cites a phase + checklist item from `docs/plan-cortex-migration.md`. The plan is the ground truth for what moves where; if the plan and reality disagree, update the plan first, then the code.
- The architecture spec (`docs/architecture.md`) is **static reference** — when the plan and architecture disagree on what cortex IS, the architecture wins. When the plan and reality disagree on migration mechanics, the plan wins (or is updated, never silently).
- NEVER add CF Access bypass-everyone policies or disable authentication on any endpoint. If cross-origin auth fails, fix the architecture (same-subdomain routing, proper CORS), don't bypass auth. If you encounter a bypass-everyone policy during any investigation, immediately flag it as a SEV-1 security finding.
- cortex does NOT have: ProcessManager, ManagedProcess, FileWatcher, `grove.config.ts`, or any process orchestration. The runtime is a single `src/cortex.ts` entrypoint plus relay + CLIs; daemons are launchd plists, not bot-side orchestration.
- NEVER use empty catch blocks. Every catch must either: (a) log the error via `process.stderr.write()` or the event pipeline (`system.error` event), or (b) handle it meaningfully, with the reason said in code: return a named fallback (a constant or helper whose name states why falling back is safe), or bind the error as `_err` only where a test pins that ignoring it is correct. A comment never carries the reason (see the next rule). Silently swallowing errors hides bugs.
- **No new comments.** `cortex/no-comments` (`eslint/no-comments.ts`) fails lint on a new comment; say it in code instead: rename, extract a named function or constant, tighten a type, or add a test. Kept: a URL to the issue or vendor doc behind an external constraint, a `/** doc */` on an export, a license header, and tool directives (`prettier-ignore`, `glossary-ignore:`). `eslint-disable` comments do nothing (`noInlineConfig`). Existing comments are baselined in `eslint-suppressions.json`. `eslint/suppressions-guard.ts` fails any rule whose total grows past `origin/main`, except a non-preset rule this change switches on in `eslint.config.js` for the first time. To burn it down, follow the Soma `no-comments` skill.
- **Run `bun run check` before you push.** It runs every CI gate (lint, duplication, unused-exports, typecheck, vocab, sdk, shippable, xdg, test) plus a not-behind-`origin/main` check; CI calls the same gates. Run the suite with `bun run test`: a bare `bun test` refuses, because it would read this machine's real HOME. The rule table in `AGENTS.md` lists each rule and the check that enforces it.

- Hooks must stay non-blocking. The cc-events EventLogger writes JSONL to `~/.claude/events/raw/` and returns; the cortex-relay process picks up files asynchronously. Never call out to the bot, the bus, or any network endpoint from inside a hook.
- Migration moves preserve behavior. MIG-1..MIG-7 PRs are file moves + minimal import-path rewrites unless the plan explicitly calls for a refactor. If a move tempts you to "fix something while I'm in here", file a follow-up issue instead.
- Surface plugins (adapters and renderers) load with **full daemon authority**; there is no sandbox (ADR-0024 D4). Never load a third-party bundle by default (`system.plugins.external` stays off), and never widen the **first-party bundle exemption**: it keys on the arc-recorded `repoUrl` matching a dependency in cortex's own `arc-manifest.yaml`, narrowed by `ADAPTER_BUNDLE_DEP_NAME_RE` / `RENDERER_BUNDLE_DEP_NAME_RE`, never on the bundle's manifest, its arc `tier` or a name prefix (the spoof vectors PR #1942 closed). Don't re-add an in-tree copy of an extracted adapter or renderer.
- Deployment-specific identifiers NEVER ship in a committed path: real platform ids (Discord/Slack snowflakes), internal-domain emails, real principal or seed identities, tokens and secrets live only in `~/.config/metafactory/cortex/`. Ship `.example` placeholders. If `shippable-hygiene` or `confidentiality-gate` flags something real, remove it; never allowlist it. The two gates have different scopes: see `docs/agent-guide/repo-conventions.md`.
- Discord posts are substantive and low-ceremony: end on the substance, keep a closing 🙏 for genuine first-time moments, and use at most one lead emoji.
- `CLAUDE.md` is generated from `docs/agents-md/*.md`, `agents-md.yaml` and the compass template. Edit those, never `CLAUDE.md`; the procedure is in `docs/agent-guide/repo-conventions.md`.


## GitHub labels and issues

- Use only the shared labels in [`compass/standards/labels.yaml`](https://github.com/the-metafactory/compass/blob/main/standards/labels.yaml), plus this repo's own below. Every open issue has one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`).
- Keep the issue you work on updated: comment when you start, link the PR, and comment a summary when done. Iterations with more than about three slices use GitHub sub-issues, not checkbox lists. Detail: [`compass/standards/agent-conventions.md`](https://github.com/the-metafactory/compass/blob/main/standards/agent-conventions.md).

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `migration` | | | Project-specific |

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
| **In-session dev loop** | Driving feedback (a walker/tester report) or work to shipped *in-session* — main session diagnoses + verifies + narrates live to the channel; ephemeral sub-agents build + review | `compass/sops/in-session-dev-loop.md` |
| **Security incident response** | Detecting, containing, or investigating a security finding | `compass/metafactory/sops/security-incident-response.md` |


## Blueprint, versions and worktrees

- Features are tracked in `blueprint.yaml`: `blueprint ready` shows what is unblocked; set `in-progress` when you start and `done` after the PR merges. Commands: [`compass/standards/agent-conventions.md`](https://github.com/the-metafactory/compass/blob/main/standards/agent-conventions.md).
- Versioning follows `compass/sops/versioning.md`. The version source of truth is `arc-manifest.yaml`; if `package.json` also carries a version, the two must match (CI's `check-version-consistency`). Release title: `"Cortex vX.Y.Z -- Short Description"`. Deploy: `arc upgrade cortex`.
- Feature work happens in a worktree (`compass/sops/worktree-discipline.md`): `git worktree add ../Cortex-{slug} -b feat/{branch-name} main`.
- Use Bun, not Node: `bun`, `bun test`, `bun build`, `bun install`, `bun run`, `bunx`. Bun loads `.env` itself.

