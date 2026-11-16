<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# Cortex -- Layer-7 collaboration surface for the metafactory Myelin stack

Layer-7 collaboration surface for the metafactory Myelin stack

## Domain Context

Before doing work in this repo, load the domain language:

- **`./CONTEXT.md`** — this repo's bounded-context glossary, if present. One canonical term per concept, with the aliases to avoid. If you find yourself using a term loosely, check it here first. Every ecosystem repo is expected to grow a `CONTEXT.md` (authored via the `grill-with-docs` skill).
- **`compass/ecosystem/CONTEXT-MAP.md`** — the ecosystem context map: the bounded contexts (soma, cortex, myelin, signal, …) and how their boundary terms reconcile.

When `CONTEXT.md` and your instinct disagree, `CONTEXT.md` wins. When a term crosses a repo boundary, the `CONTEXT-MAP.md` is authoritative.

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
- Deploy command: `arc upgrade cortex`

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
