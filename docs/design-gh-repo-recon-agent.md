# `gh-repo-recon-agent` — First Deterministic Agent Spec

**Status:** Draft. Lands after cortex#92 (`SessionHarness`) merges. Untracked working doc.
**Date:** 2026-05-14
**Driver:** Andreas
**Depends on:** cortex#92 (substrate harness interface), cortex#91 (multi-substrate dispatch)
**Introduces:** `deterministic-agent` as a new `HarnessId` and a new agent class on the bus
**Related:** `feedback_check_prs_first` (the user-facing rule this agent automates), `design-collaboration-surface.md` §reference to Stripe Minions

---

## 1. Goal + Non-Goals

### Goal

Land the first **deterministic-class agent** on cortex's bus, packaged as a **PAI skill** with a **slash-command** wrapper. Validate the agent class itself, prove the trust boundary (sealed execution, no LLM in the loop, no judgment), and absorb the highest-frequency recurring read pattern in observed PAI usage (multi-call GitHub repo recon before any non-trivial work).

Land in two repos. One **skill** is the load-bearing artefact; the slash command is the principal surface, and the bus path invokes the same skill directly without LLM rendering.

**Repo 1 — `the-metafactory/arc-skill-recon`** (new repo).

Matches the **repo shape** of `arc-skill-code-review` (manifest + skill + prompt directories, same arc-install behavior). Extends it with a `skill/scripts/` directory — a **new convention this design introduces for deterministic-class skills**. The existing `arc-skill-code-review` precedent is LLM-driven workflow markdown (lens files + workflow files) with no executable scripts; deterministic-class skills add scripts as the sealed contract.

| Path | Purpose | Precedent match? |
|---|---|---|
| `arc-manifest.yaml` | `schema: arc/v1`, `type: skill`, name + triggers + bash capabilities | ✓ same as code-review |
| `skill/SKILL.md` | PAI skill metadata + workflow routing table | ✓ same as code-review |
| `skill/Workflows/RepoRecon.md` | MVP workflow — "what's in flight" for a repo | ✓ same shape as code-review's `Workflows/FullReview.md` |
| `skill/scripts/recon.ts` | Sealed deterministic implementation (TypeScript via Bun) | **NEW pattern for deterministic-class skills** |
| `prompt/recon.md` | Slash command. Parses `--parameters` to route to a workflow. | ✓ same as code-review's `prompt/review-pr.md` |
| `CLAUDE.md`, `README.md`, `package.json`, `.gitignore` | Standard repo files | ✓ |

Arc-install drops the skill into `~/.claude/skills/Recon/` and the slash command into `~/.claude/commands/recon.md`. Same pattern as `arc install github:the-metafactory/arc-skill-code-review`.

**Repo 2 — `the-metafactory/cortex`** (this PR is the design step there).
Contains the deterministic-agent class itself: new `HarnessId` value, the `DeterministicAgentHarness` implementation, `AgentRuntimeSchema` delta, `invokeSkill` resolver, fragment example. Cortex imports nothing from the skill — it resolves the skill name to its `~/.claude/skills/<name>/scripts/<workflow>.ts` script and spawns it via `Bun.spawn`.

**Three invocation surfaces, one script, two resolution paths:**

| Surface | Entry | Resolution path | Output |
|---|---|---|---|
| **Principal** | `/recon the-metafactory/cortex` from any CC session | LLM-driven: model parses `--parameters` from `$ARGUMENTS`, invokes `Skill("Recon", "RepoRecon", ...)`, renders verdict as principal-readable summary | Rendered Markdown |
| **Judgment agent (inline)** | `Skill("Recon", "RepoRecon", ...)` from within a model's tool-use loop | LLM in the calling agent, but the skill's script execution is deterministic | Raw verdict, optionally LLM-rendered downstream |
| **Deterministic agent (bus)** | `dispatch.recon.<id>` envelope to `gh-repo-recon-agent` | **Direct**: harness calls `invokeSkill(skill, workflow, input)` → spawns the script. No LLM in the loop. | Raw verdict envelope on `recon.<id>.complete` |

Same script (`skill/scripts/recon.ts`) backs all three. The slash command's `--parameters` parsing happens in LLM-prose (the slash command body), so the bus path **deliberately bypasses the slash command file** and goes straight to the skill+workflow resolver. The "one canonical entry point" intent is preserved at the **script** layer, not the slash-command layer.

The design pattern follows `arc-skill-code-review` for the workflow-routing precedent (`/review-pr --sweep | --standard | --security | --full` → `Workflows/FullReview.md | SweepReview.md | StandardReview.md | SecurityReview.md`). For Recon, MVP ships only `RepoRecon`; future `--branches`, `--prs`, `--sweep` parameters can route to additional workflows without changing any caller.

### Non-goals

- Not a general-purpose GitHub agent. This skill runs **one** fixed query shape (`RepoRecon` workflow). Other GitHub operations (PR creation, label apply, merge) are separate skills with their own deterministic agents.
- Not a substrate for LLM work. The whole point is no model in the skill's execution loop.
- Not a write surface. Read-only, declared at capability level, enforced at NATS account level.
- Not a replacement for `gh` CLI usage by Cortex's existing `claude-code` substrate. Existing flows keep working; this is an additional bus primitive and a new slash command.

---

## 2. Class — Deterministic Agent

This agent is the first instance of a new class on the bus. The class introduces these invariants, none of which existing judgment-class agents (Luna, Echo, Forge, Sage, Alpha, Gorse) satisfy:

| Property | Means |
|---|---|
| **Deterministic** | No LLM nondeterminism in the loop. Given identical CLI tool outputs for a given input, the verdict envelope is bytewise-identical. This is **not** a cache or reproducibility guarantee against upstream state changes; the live GitHub world is allowed to move between invocations. |
| **Sealed** | Execution path is fixed at agent-definition time. The caller (including the judgment agent that dispatched it) cannot inject, modify, or steer execution mid-flight. The **skill's script** is the contract. **Trust assumption: the seal is only as strong as the integrity of (a) the YAML fragment that names which skill to invoke, and (b) the skill files at `~/.claude/skills/<Name>/`. Both must be git-tracked. An principal with edit access to either can swap the behavior. Out-of-band skill or fragment tampering is out of scope for this design and is the responsibility of the principal's deployment pipeline.** |
| **Judgment-free** | No LLM call, no model output, no tool selection during the skill's execution. The skill's `scripts/recon.ts` runs gh commands and structures the output. There is no model loop. |
| **Identity-bearing** | Has a `did:mf:` identity, claims tasks on the bus, publishes verdict envelopes, shows up in the dashboard. Same fabric as judgment agents, different inside. |

The trust value of the class lives in the seal: a judgment agent that dispatches a deterministic agent does not need to be trusted to faithfully execute the operation. The operation is fixed. The judgment agent decides *whether* to dispatch; it does not decide *what runs*. Two trust boundaries, cleanly separated.

---

## 3. Identity + Capability Declaration

```yaml
identity: did:mf:gh-repo-recon-agent

capabilities:
  - github-read              # reads PRs, issues, repos, commits — no write surface
  - identity-aware-read      # uses caller identity to filter "mine" but does not impersonate
```

The agent declares **zero write capabilities**. Its NATS account is scoped to publishing only on `recon.>`. Any attempt to dispatch it on a write subject is rejected at the bus layer (matches the existing capability-scoped NKey pattern Sage uses).

---

## 4. Invocation Surfaces + Parameters

The `Recon` skill is invocable from four surfaces. The skill itself is unchanged across all four; the parameters select which workflow runs.

| Surface | Entry | When | Ships in MVP |
|---|---|---|---|
| **Slash command** | `/recon <owner/repo> [--parameters]` | Principal runs it from any CC session | Yes |
| **PAI Skill tool** | `Skill("Recon", "<args>")` from within an agent's loop | Judgment agent invokes inline (no bus round-trip) | Yes |
| **Bus call-style** | `dispatch.recon.<request-id>` envelope | Judgment agent dispatches and awaits verdict | Yes |
| **Bus scheduled** | cron-driven, no caller | Nightly tick to populate dashboard cache for active repos | Future |
| **Bus event-style** | subscribes to `code.pr.opened` | Auto-emits recon for the affected repo on PR open | Future |

### 4.1 The `--parameter` set (the workflow router)

The slash command parses parameters and selects a workflow. The bus dispatch maps `recon-input` context into the same parameter space. MVP ships one workflow; the parameter set is designed so future workflows slot in without breaking existing callers.

| Parameter | Workflow | Behaviour | Ships in MVP |
|---|---|---|---|
| *(no parameter)* | `RepoRecon` (default) | Default include set: prs + issues + branches + commits + mine | Yes |
| `--prs` | `RepoRecon` | Restricts to PRs only | Yes (via `--include prs`) |
| `--issues` | `RepoRecon` | Restricts to issues only | Yes (via `--include issues`) |
| `--include <subset>` | `RepoRecon` | Comma-separated subset of `prs,issues,branches,commits,mine` | Yes |
| `--state <state>` | `RepoRecon` | `open` (default), `closed`, `all` | Yes |
| `--branches` | `BranchRecon` | Per-branch deep-dive (last commit author + age + associated PR) | Future |
| `--sweep` | `SweepRecon` | Multi-repo recon across an org, intended for dashboard population | Future |
| `--org <owner>` | `OrgRecon` | Org-level summary (one row per repo, sorted by last activity) | Future |

The `--parameters` design follows the `arc-skill-code-review` precedent: `/review-pr --sweep` selects `Workflows/SweepReview.md` over the default `FullReview`. Same shape, different content.

---

## 5. Envelope Contracts

### 5.1 Input envelope (call-style)

```yaml
subject: dispatch.recon.<request-id>
correlation_id: <uuid>                 # = DispatchRequest.requestId
source: did:mf:luna                    # or any judgment-class agent
sovereignty: { classification: internal }
context:
  # Recon-specific input. The dispatcher attaches this as a context entry
  # with kind: "recon-input" when constructing the DispatchRequest; the
  # harness reads it via req.context.find(c => c.kind === "recon-input").
  - kind: recon-input
    data:
      owner: the-metafactory           # required
      repo: cortex                     # required
      include:                         # optional, default = all five
        - prs
        - issues
        - branches
        - commits
        - mine
      state: open                      # optional, default "open"; "closed" | "all"
      pr_limit: 30                     # optional, default 30
      issue_limit: 30                  # optional, default 30
      commit_limit: 20                 # optional, default 20
  # Principal identity for the "mine" cross-cut. Uses the existing "env"
  # context kind per cortex's convention; absent → no mine filtering.
  - kind: env
    data:
      principal: andreas                # optional GitHub login of the caller
```

### 5.2 Output envelope (verdict)

```yaml
subject: recon.<request-id>.complete
correlation_id: <uuid>                 # echoes input
source: did:mf:gh-repo-recon-agent
status: complete | partial | error
payload:
  repo:
    owner: the-metafactory
    name: cortex
    default_branch: main
    visibility: private
    pushed_at: 2026-05-14T03:00:00Z
  prs:
    - number: 92
      title: "docs(design): substrate harness interface ..."
      author: andreas
      state: open
      created_at: 2026-05-13T09:00:00Z
      head: feat/c-091-substrate-harness-design
      base: main
      additions: 582
      deletions: 0
      mergeable: true
      review_decision: REVIEW_REQUIRED
      assignees: [andreas]
      labels: [feature, next]
  issues:
    - number: 91
      title: "design: SessionHarness interface ..."
      state: open
      author: andreas
      assignees: [andreas]
      labels: [feature, next]
      created_at: 2026-05-13T05:27:48Z
  branches:                            # active only (commit within last 14 days)
    - name: feat/c-091-substrate-harness-design
      last_commit_at: 2026-05-13T...
      pr: 92
  commits:                             # recent on default branch
    - sha: 7371f8e
      author: andreas
      date: 2026-05-13T22:00:00Z
      message: "docs: add Grove integration ..."
  mine:                                # cross-cut, only if env-context "principal" was provided
    open_prs: [92]
    open_issues: [91, 107]
metadata:
  duration_ms: 1840
  gh_calls: 5
  partial_sections: []                 # populated when status=partial
```

### 5.3 Error envelope

```yaml
subject: recon.<request-id>.error
status: error
payload:
  code: NOT_FOUND | RATE_LIMITED | TIMEOUT | GH_AUTH_FAILED | UNKNOWN
  message: "human-readable detail"
  retry_after_ms: 60000                # populated when code = RATE_LIMITED
```

---

## 6. Sealed Execution — The Recon Skill Repo

The source of truth is **`the-metafactory/arc-skill-recon`** (new repo). Arc-install lands the skill files at `~/.claude/skills/Recon/` and the slash command at `~/.claude/commands/recon.md`.

```
the-metafactory/arc-skill-recon/
├── arc-manifest.yaml             # schema: arc/v1, type: skill, name: recon, triggers + capabilities
├── CLAUDE.md                     # repo-specific agent rules (from ecosystem template)
├── README.md                     # public-facing repo description
├── package.json
├── .gitignore
├── skill/
│   ├── SKILL.md                  # YAML frontmatter + workflow routing table
│   ├── Workflows/
│   │   └── RepoRecon.md          # MVP workflow — "what's in flight" for a repo
│   └── scripts/
│       └── recon.ts              # Sealed deterministic implementation (Bun + TypeScript)
└── prompt/
    └── recon.md                  # Slash command — parses --parameters to route to workflow
```

The `RepoRecon` workflow is the only workflow shipped in MVP. `scripts/recon.ts` is its implementation. The script is the contract; reading it tells you exactly what every recon invocation does, regardless of which surface invoked it (principal slash, Skill tool, or bus harness).

### 6.1 The sealed sequence (implemented in `scripts/recon.ts`)

```
1.  gh repo view <owner>/<repo>
      --json defaultBranchRef,visibility,pushedAt

2.  if "prs" in include:
      gh pr list -R <owner>/<repo> --state <state> --limit <pr_limit>
        --json number,title,author,state,createdAt,headRefName,baseRefName,
                additions,deletions,mergeable,reviewDecision,assignees,labels

3.  if "issues" in include:
      gh issue list -R <owner>/<repo> --state <state> --limit <issue_limit>
        --json number,title,state,author,labels,assignees,createdAt

4.  if "branches" in include:
      gh api graphql -f query='
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            refs(first: 100, refPrefix: "refs/heads/", orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
              nodes {
                name
                target { ... on Commit { committedDate oid } }
              }
            }
          }
        }' -F owner=<owner> -F repo=<repo>
      → filter to refs with committedDate within last 14 days

5.  if "commits" in include:
      gh api repos/<owner>/<repo>/commits?per_page=<commit_limit>
      → project to {sha, author, date, message}

6.  if "mine" in include AND caller present:
      derive open_prs / open_issues from steps 2+3 where
        assignees[].login == caller OR author.login == caller
```

No conditional branching beyond the `include` flag set, which is data, not judgment. No retries inside the script — retries are the bus harness's responsibility per the agent config (for bus dispatches) or non-existent for slash-command invocations.

**Call count is bounded and deterministic:** at most six external calls (steps 1, 2, 3, 4, 5, plus optionally `gh api user` if caller-identity is needed for `mine` and not supplied). The §5.2 `metadata.gh_calls` field reflects the actual count for the dispatch. Step 4 uses GraphQL deliberately to keep step count flat regardless of branch count — a per-branch REST loop would make the call count vary with repo size and weaken the seal.

### 6.2 SKILL.md shape

```yaml
---
name: Recon
description: |
  Deterministic GitHub recon. Returns structured "what's in flight" for a
  repo — open PRs, open issues, active branches, recent commits,
  my-assigned cross-cut. Future workflows add branch-, PR-, org-recon.
  USE WHEN: check repo state before non-trivial work, recon, gh recon,
  what's in flight, repo overview, before starting work, sweep recon.
---

# Recon

Multi-workflow GitHub-recon skill. MVP ships `RepoRecon`; future workflows
add `BranchRecon`, `PrRecon`, `SweepRecon`, `OrgRecon`.

## Workflow Routing

| Workflow | Trigger | File |
|---|---|---|
| **RepoRecon** | default (`/recon <owner/repo>`) | `Workflows/RepoRecon.md` |
| **BranchRecon** (future) | `/recon --branches <owner/repo>` | `Workflows/BranchRecon.md` |
| **PrRecon** (future) | `/recon --prs <owner/repo>` | `Workflows/PrRecon.md` |
| **SweepRecon** (future) | `/recon --sweep <owner>` | `Workflows/SweepRecon.md` |
| **OrgRecon** (future) | `/recon --org <owner>` | `Workflows/OrgRecon.md` |
```

### 6.3 Slash command shape (`prompt/recon.md`)

Matches the `prompt/review-pr.md` pattern from `arc-skill-code-review`. Single command, `--parameters` route to workflows. MVP only routes to RepoRecon.

```markdown
---
description: Run repo recon — what's in flight for a repo. Deterministic, no LLM in the execution loop.
argument-hint: <owner/repo> [--prs | --issues | --include a,b,c] [--state open|closed|all] [--branches | --sweep | --org]
---

You are invoking the `recon` slash command. Parse `$ARGUMENTS` as:

- **`<owner/repo>`** (required, first positional) — e.g., `the-metafactory/cortex`.
- **Workflow flag** (optional, default `RepoRecon`):
  - *(no flag)* → `RepoRecon` (default)
  - `--branches` → `BranchRecon` (future)
  - `--sweep` → `SweepRecon` (future)
  - `--org` → `OrgRecon` (future)
- **`--include <subset>`** (optional, `RepoRecon` only) — comma-separated from `prs,issues,branches,commits,mine`. Default = all five.
- **`--prs` / `--issues`** (optional shorthand) — equivalent to `--include prs` or `--include issues`.
- **`--state <state>`** (optional) — `open` (default), `closed`, `all`.

Invoke the `Recon` skill via the `Skill` tool with the parsed parameters. The skill's matching workflow runs `bun skill/scripts/recon.ts` with structured input and returns a `ReconVerdict` JSON. Render the verdict as a compact summary for the principal.
```

### 6.4 RepoRecon workflow shape

`skill/Workflows/RepoRecon.md` declares the script path in **machine-readable YAML frontmatter**, then describes the workflow principal-readably in the body. The frontmatter is the resolver's source of truth (so `invokeSkill` does not have to parse prose); the body is documentation for humans and LLM-driven surfaces.

```markdown
---
script: scripts/recon.ts          # REQUIRED — resolved relative to the skill root
default: true                      # OPTIONAL — marks this as the skill's default workflow
inputs:                            # OPTIONAL — JSON-schema-style description of stdin shape
  owner: string
  repo: string
  include: string[] (default = all five)
  state: "open" | "closed" | "all"
  pr_limit: integer (default 30)
  issue_limit: integer (default 30)
  commit_limit: integer (default 20)
---

# RepoRecon

Run `bun ~/.claude/skills/Recon/scripts/recon.ts` with `{ input, caller }` as JSON on stdin.

Returns a `ReconVerdict` JSON object (schema in `scripts/recon.ts`).

Invoked by:
- `/recon` slash command (default workflow)
- PAI `Skill("Recon")` tool calls
- cortex `deterministic-agent` harness for `dispatch.recon.*` envelopes
```

The `script:` frontmatter field is the single load-bearing piece of routing metadata. SKILL.md's `Workflow Routing` table in §6.2 names which workflow file to look at; the workflow file's frontmatter names which script to run. Two levels of indirection, both machine-parseable, no LLM in the resolution path.

The judgment-free property of the deterministic class is enforced by the workflow being a single non-branching invocation of a known script. There are no decision steps for the LLM to take. If a future workflow under `Recon/` needs LLM-driven branching, it becomes a judgment-class skill workflow and the bus-side agent that uses it is no longer deterministic-class — a deliberate split, not an accident.

---

## 7. Cortex Config Block

Registered as a fragment under `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml`. Loaded by cortex's existing fragment loader. Discriminator: `runtime.harness: deterministic-agent` (the new `HarnessId` entry).

```yaml
agents:
  - name: gh-repo-recon-agent
    identity: did:mf:gh-repo-recon-agent
    persona:
      kind: behavior-contract                  # not a system prompt — links to this doc
      path: ./design-gh-repo-recon-agent.md
    runtime:
      # substrate is the discriminator for harness selection at runtime;
      # there is no separate `harness` YAML field (HarnessId is a TypeScript
      # union, not a config key).
      substrate: deterministic-agent           # NEW AgentRuntimeSchema.substrate value
      mode: in-process                         # required by current schema
      skill: Recon                             # PAI skill name; resolves to ~/.claude/skills/Recon/
      workflow: RepoRecon                      # optional — when omitted, resolver picks the workflow whose frontmatter has `default: true`
      timeout_ms: 10000
      retry:
        max_attempts: 2
        backoff: linear-2s
      capabilities:                            # NEW — schema addition (see §7 delta)
        - github-read
        - identity-aware-read
      task_subjects:                           # NEW — schema addition (see §7 delta)
        - dispatch.recon.>
      publish_subjects:                        # NEW — schema addition (see §7 delta)
        - recon.>
      secrets:                                 # NEW — schema addition (see §7 delta)
        - GH_TOKEN                             # MVP reuses existing env var; see §12 R2 for the eventual GH_TOKEN_READONLY follow-up
```

The `skill` field names the PAI skill this agent invokes. Cortex resolves it to `~/.claude/skills/<skill>/`, reads the SKILL.md routing table to find the workflow's script, and spawns the script via `Bun.spawn`. Cortex never reads the slash-command file `prompt/recon.md` — that's principal-facing LLM-prose, not machine-routable. An principal running `/recon owner/repo` ends up invoking the same `skill/scripts/recon.ts` via the LLM-driven slash-command path; the bus path skips the LLM and goes direct.

### Schema delta — TWO parallel enums + persona shape + four runtime fields

Cortex currently has two substrate enums living in different files. They are not unified today; this design touches both and acknowledges the unification work as out of scope for this PR.

**1. `AgentRuntimeSchema.substrate` (principal-facing, `src/common/types/cortex-config.ts`).** Today a flat `z.enum(["claude-code", "codex", "pi-dev", "cursor", "custom"])` after cortex#124 merge. Gains `"deterministic-agent"` as a sixth value. The schema is NOT a discriminated union today; this design does not propose restructuring it. Instead, the new fields land as **optional top-level fields on `AgentRuntimeSchema`**, gated by a `.refine()` that requires `skill` when `substrate === "deterministic-agent"`. No breaking change to existing claude-code / codex / pi-dev / cursor / custom configs. Precedent for adding a substrate enum value is cortex#124 itself — one-line enum change plus design doc.

```ts
// Sketch — actual implementation lands in the follow-up PR
AgentRuntimeSchema.extend({
  skill: z.string().min(1).optional(),           // PAI skill name (e.g. "Recon"); resolves to ~/.claude/skills/<name>/
  workflow: z.string().min(1).optional(),        // workflow within the skill; defaults to skill's default workflow
  retry: z.object({
    max_attempts: z.number().int().min(1).max(10),
    backoff: z.string(),
  }).optional(),

  // The following four fields already conceptually belong at the runtime level
  // (substrate-coupled) but are not declared on AgentRuntimeSchema today.
  // This design proposes adding them now alongside skill/workflow/retry.
  task_subjects: z.array(z.string().min(1)).default([]),    // NATS subjects this agent claims (e.g. ["dispatch.recon.>"])
  publish_subjects: z.array(z.string().min(1)).default([]), // NATS subjects this agent publishes (e.g. ["recon.>"])
  secrets: z.array(z.string().min(1)).default([]),          // env vars this agent's skill requires (e.g. ["GH_TOKEN"])
  // capabilities already exists at runtime level — no schema change for that field.
}).refine(
  (rt) => rt.substrate !== "deterministic-agent" || rt.skill !== undefined,
  { message: "runtime.skill required when substrate is 'deterministic-agent'", path: ["skill"] },
);
```

The four runtime-level additions (`task_subjects`, `publish_subjects`, `secrets`, plus the already-existing `capabilities`) are broadly useful across substrates — judgment-class agents will eventually want to declare their bus subjects too. They are not gated by `substrate === "deterministic-agent"`; they are general additions. Documented here because the deterministic-agent path is the first user.

**Two `capabilities` concepts — explicit bridge.** `AgentRuntimeSchema.capabilities` is `string[]` (principal-declared in YAML, consumed by the dispatcher and the NATS-KV capability registry). `SessionHarness.capabilities` is `Capability[]` with `{id, description, tags?}` objects (declared in TypeScript by the harness implementation). The contract between them: **each principal-declared string MUST equal a harness `Capability.id`.** The harness is the authoritative source of metadata; the YAML is the authoritative source of which subset this agent claims. At dispatch time, cortex validates that every `runtime.capabilities[]` string resolves to a known `Capability.id` on the resolved `SessionHarness`. Future deterministic-agent skills follow the same bridge: declare capability objects in the harness's `CAPABILITIES` constant, declare matching string ids in the principal fragment.

**`.refine()` stacking.** Zod supports chaining `.refine()` calls; the existing standalone-mode refine on `AgentRuntimeSchema` (which requires `capabilities.length >= 1` when `mode === "standalone"`, per cortex#62 Echo M2) is **not replaced** by the new deterministic-agent refine — both apply. Per-refine error paths stay separate, so the principal sees one error message per violated invariant.

**2. `HarnessId` (runner-facing, `src/common/substrates/types.ts`).** Today a TypeScript union of seven values. Gains `"deterministic-agent"` as an eighth. This is the type the runner uses to select a `SessionHarness` implementation; not principal-facing.

The two enums are deliberately separate today (principal vocabulary vs runner vocabulary) and unifying them is a separate piece of work that belongs in cortex#92's follow-ups, not here. This design adds the new value to both lists.

**3. `persona` shape — additive via union, not breaking.** Today `persona: z.string().min(1)` is a bare path. Becomes `persona: z.union([z.string().min(1), z.object({ kind, path })])`. A bare string is interpreted as `{ kind: "system-prompt", path: <string> }` for backward compatibility. Existing principal configs continue to parse without migration. The new `kind: "behavior-contract"` variant signals that the linked file IS the contract (deterministic agents) rather than a system prompt (judgment agents).

---

## 8. Harness Implementation Sketch

A new `DeterministicAgentHarness` implementing `SessionHarness` per cortex#92. Single responsibility: resolve the named skill+workflow to its script, spawn the script with the structured input from `DispatchRequest.context`, parse and validate the JSON verdict, emit the envelope.

The harness does **not** read the slash-command file `~/.claude/commands/recon.md` — that file is principal-facing LLM-prose and contains no machine-parseable workflow routing. The skill's SKILL.md routing table is the machine-parseable mapping from workflow name to script path. The slash command exists for the principal surface only; the bus path bypasses it.

```ts
// src/substrates/deterministic-agent/harness.ts (NEW)

import type { Capability, SessionHarness, DispatchRequest } from "../../common/substrates/types";
import type { Envelope as MyelinEnvelope } from "../../bus/myelin/envelope-validator";
import { invokeSkill } from "../../skills/invoke";  // resolves skill+workflow to script
import { ReconVerdictSchema } from "@arc-skill-recon/types";  // imported from the skill repo's published types

const CAPABILITIES: Capability[] = [
  { id: "github-read", description: "Reads GitHub repo metadata, PRs, issues, branches, commits via gh CLI", tags: ["github", "read-only"] },
  { id: "identity-aware-read", description: "Optionally filters results by caller identity supplied via env context", tags: ["read-only"] },
];

export class DeterministicAgentHarness implements SessionHarness {
  readonly id: "deterministic-agent" = "deterministic-agent";
  readonly capabilities: Capability[] = CAPABILITIES;

  constructor(
    private readonly skill: string,             // PAI skill name (e.g. "Recon")
    private readonly workflow: string | null,   // optional workflow name (e.g. "RepoRecon"); null → skill's default
    private readonly timeoutMs: number,
  ) {}

  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    // Extract recon input from context. The dispatcher attaches a "recon-input"
    // context kind whose .data is the ReconInput shape from §5.1. The "principal"
    // for the mine cross-cut comes from the existing "env" context kind.
    const reconInput = req.context.find((c) => c.kind === "recon-input")?.data;
    const principal = (req.context.find((c) => c.kind === "env")?.data as { principal?: string } | undefined)?.principal;

    yield envelope("dispatch.task.started", {
      requestId: req.requestId,
      agentId: req.agent.id,
    });

    try {
      // invokeSkill resolves <skill> to ~/.claude/skills/<skill>/, reads SKILL.md's
      // routing table to find the workflow's script path, spawns the script via
      // Bun.spawn, passes input as JSON on stdin, returns parsed JSON stdout.
      const rawResult = await withTimeout(
        invokeSkill(this.skill, this.workflow, { input: reconInput, caller: principal }),
        this.timeoutMs,
      );
      // Validate at the seam — invokeSkill returns unknown; the schema is the contract.
      const result = ReconVerdictSchema.parse(rawResult);

      yield envelope("dispatch.task.completed", {
        requestId: req.requestId,
        durationMs: result.metadata.duration_ms,
      });

      yield envelope(`recon.${req.requestId}.complete`, {
        status: result.status,
        payload: result,
      });
    } catch (err) {
      yield envelope(`recon.${req.requestId}.error`, errorPayload(err));
      yield envelope("dispatch.task.failed", {
        requestId: req.requestId,
        error: serializeError(err),
      });
    }
  }
}
```

Field-name and contract notes for implementers:

- `req.requestId` — the dispatch-correlation id (per `DispatchRequest`'s Q5 lock-in).
- `req.agent.id` — logical agent id (`gh-repo-recon-agent`).
- Input arrives via `req.context[]` with `kind: "recon-input"` (or whatever kind the dispatcher chooses — that decision is for cortex#92's dispatcher work, not this design). Recon must not assume an arbitrary `payload` field on the request.
- Principal identity (for the `mine` cross-cut) arrives via `req.context[]` with `kind: "env"` per the existing convention. If absent, the cross-cut is skipped.
- `capabilities` must be `Capability[]` — array of `{ id, description, tags? }` objects, not bare strings.
- `invokeSkill` is the new shared resolver at `src/skills/invoke.ts`. Its contract:
  1. Take `(skill, workflow | null, input)`.
  2. Locate the skill at `~/.claude/skills/<skill>/`.
  3. Read SKILL.md's `Workflow Routing` table to map `workflow → workflow_markdown_file`. **If `workflow` is null,** enumerate the workflow files referenced from the table, open each one, and pick the file whose YAML frontmatter has `default: true`. At most one workflow per skill may carry this flag; the resolver throws `SkillInvocationError("ambiguous default workflow")` if more than one is found. The SKILL.md `Trigger` column is human-readable enumeration only, not consulted by the resolver — the frontmatter is the single source of truth for default-flagging.
  4. Open the resolved workflow markdown file. Read its YAML frontmatter. The `script:` field is the **machine-readable** path to the executable, resolved relative to the skill root.
  5. Spawn `bun <script_path>` via `Bun.spawn`, pass `{ input, caller }` as JSON on stdin.
  6. Parse the JSON it writes to stdout, return as `unknown` for caller-side schema validation.
  7. Errors are thrown as typed `SkillInvocationError`.

  This is the only point of coupling between cortex and the PAI skill system; the same `invokeSkill` is usable by other cortex code paths (the Skill tool's invocation, future skill-shaped substrates). The resolver never parses workflow-markdown prose — only YAML frontmatter.
- `ReconVerdictSchema.parse(rawResult)` enforces the verdict contract at the seam between `invokeSkill`'s `unknown` return and the typed envelope emission. The schema is imported from the skill repo's published types — same source of truth as the script itself uses for `ReconInputSchema` on the input side.

### 8.1 The skill's script (lives in `~/.claude/skills/Recon/scripts/recon.ts`)

```ts
// ~/.claude/skills/Recon/scripts/recon.ts
//
// Sealed deterministic implementation of the RepoRecon workflow.
// Invocable from: /recon slash command, cortex deterministic-agent harness,
// PAI Skill tool, or directly via `bun .../recon.ts`.

import { $ } from "bun";
import { ReconInputSchema, type ReconVerdict } from "./types";

const stdin = await Bun.stdin.json();
const input = ReconInputSchema.parse(stdin.input);
const caller = stdin.caller as string | undefined;
const start = Date.now();

// Step 1: repo metadata
const repo = await ghRepoView(input.owner, input.repo);

// Steps 2–5: parallel where independent
const [prs, issues, branches, commits] = await Promise.all([
  input.include.has("prs") ? ghPrList(input) : null,
  input.include.has("issues") ? ghIssueList(input) : null,
  input.include.has("branches") ? ghBranchesGraphQL(input) : null,  // GraphQL — one call regardless of branch count
  input.include.has("commits") ? ghCommits(input) : null,
]);

// Step 6: cross-cut "mine"
const mine = input.include.has("mine") && caller
  ? crossCutMine(prs ?? [], issues ?? [], caller)
  : null;

const verdict: ReconVerdict = {
  status: "complete",
  payload: { repo, prs, issues, branches, commits, mine },
  metadata: {
    duration_ms: Date.now() - start,
    gh_calls: 1 + [prs, issues, branches, commits].filter(Boolean).length,
    partial_sections: [],
  },
};

process.stdout.write(JSON.stringify(verdict));
```

The script is the contract. Reading it tells you exactly what every recon invocation does, regardless of which surface invoked it. There is no `if` based on a runtime decision the LLM might make. The only branching is over the `include` flag set, which is data.

### 8.2 Slash-command wrapper

```markdown
# ~/.claude/commands/recon.md
---
name: recon
description: |
  Run the Recon skill against a GitHub repo. Returns a structured
  "what's in flight" verdict (open PRs, issues, active branches,
  recent commits, my-assigned cross-cut).
arguments:
  - name: target
    description: owner/repo (e.g. the-metafactory/cortex)
    required: true
  - name: include
    description: comma-separated subset of {prs,issues,branches,commits,mine}
    required: false
---

Invoke the Recon skill on `{{target}}` with default include set (or `{{include}}` if supplied).
The skill's RepoRecon workflow runs `~/.claude/skills/Recon/scripts/recon.ts` and returns
a `ReconVerdict` JSON. Render the verdict as a compact summary for the principal.
```

The whole script is testable as a pure function: mock `ghPrList` etc. with fixtures, assert the verdict shape. No bus, no harness, no envelope concerns.

---

## 9. Error Modes

| Code | Triggered by | Behavior |
|---|---|---|
| `NOT_FOUND` | `gh repo view` returns 404 | Skill exits non-zero with structured error JSON; harness emits `recon.<id>.error`, no retry |
| `RATE_LIMITED` | gh returns 403 with X-RateLimit-Remaining: 0 | Skill exits with `retry_after_ms`; harness retries after backoff |
| `TIMEOUT` | Skill execution exceeds `timeout_ms` | Harness kills the subprocess and emits `dispatch.task.failed` with `code: TIMEOUT`, no partial verdict |
| `GH_AUTH_FAILED` | gh returns 401 | Skill exits with auth error; harness emits error, no retry (config issue, needs principal) |
| `partial` | Some sections succeed, some fail | Skill writes verdict with `status: partial` and `metadata.partial_sections: [...]` |
| `UNKNOWN` | Any other exception | Skill writes error with stack trace; harness propagates |

The harness enforces the timeout (process kill on overrun). The skill's script enforces nothing — if `gh` hangs, the harness aborts and emits a TIMEOUT envelope.

---

## 10. Testing Strategy

Deterministic agents test like functions, not like LLM agents. No eval suite needed.

### 10.1 Unit tests (skill script)

Tests live in the **source repo** at `arc-skill-recon/skill/__tests__/recon.test.ts` (run via `bun test` from the repo root). Arc-install does NOT ship the `__tests__/` directory to `~/.claude/skills/Recon/`; the manifest's `provides.files` block lists production files only. Tests run on CI of the skill repo and locally during development.

Mock the gh calls with JSON fixtures. Assertions: verdict shape, partial-section handling, mine cross-cut correctness, identity fallback.

```
arc-skill-recon/skill/__tests__/recon.test.ts
  ✓ returns complete verdict for happy-path cortex repo
  ✓ omits sections not in include
  ✓ returns partial verdict when commits section fails
  ✓ NOT_FOUND when repo doesn't exist
  ✓ skips mine when caller absent
  ✓ filters mine to assignee + author match
  ✓ verdict passes ReconVerdictSchema validation
```

### 10.2 Integration test (harness → skill)

Use a fixture repo (`the-metafactory/hello-world` or similar low-traffic test repo). Dispatch a real recon envelope through the cortex deterministic-agent harness, assert end-to-end:

- `dispatch.task.started` published
- `recon.<id>.complete` published within 5s
- Verdict envelope schema-valid
- Verdict content matches the live repo's actual PR/issue state at time of test
- Slash command `/recon the-metafactory/hello-world` produces the same verdict shape (same skill, different surface)

### 10.3 Property test

For any well-formed input that passes `ReconInputSchema`, the output passes `ReconVerdictSchema`. No need for property fuzzing on actual gh output (gh's contract is upstream).

---

## 11. Acceptance Criteria

### Repo 1 — `the-metafactory/arc-skill-recon`

- [ ] Repo bootstrapped via the ecosystem `new-repo` SOP, matching `arc-skill-code-review` shape
- [ ] `arc-manifest.yaml` declares `schema: arc/v1`, `type: skill`, `name: recon`, triggers + gh-restricted bash capabilities
- [ ] `skill/SKILL.md` carries the routing table (one workflow MVP, future workflows listed)
- [ ] `skill/Workflows/RepoRecon.md` documents the workflow + script invocation
- [ ] `skill/scripts/recon.ts` is the sealed implementation matching §6.1 sequence + §5.2 verdict shape
- [ ] `prompt/recon.md` is the slash command with `--parameter` parsing per §6.3
- [ ] Unit tests on `skill/scripts/recon.ts` reach 100% branch coverage (gh calls mocked with fixtures)
- [ ] `arc install github:the-metafactory/arc-skill-recon` lands files at `~/.claude/skills/Recon/` + `~/.claude/commands/recon.md`
- [ ] Manual smoke: `/recon the-metafactory/cortex` from any CC session returns a valid `ReconVerdict`

### Repo 2 — `the-metafactory/cortex`

- [ ] `HarnessId` gains `"deterministic-agent"` in `src/common/substrates/types.ts`
- [ ] `AgentRuntimeSchema.substrate` gains `"deterministic-agent"` in `src/common/types/cortex-config.ts`
- [ ] `AgentRuntimeSchema` extended with optional `skill`, `workflow`, `retry`, `task_subjects`, `publish_subjects`, `secrets` fields; `.refine()` requires `skill` when `substrate === "deterministic-agent"`
- [ ] `persona` field changed from `z.string()` to `z.union([z.string(), z.object({ kind, path })])` with bare-string interpreted as `kind: "system-prompt"` for backward compatibility
- [ ] `DeterministicAgentHarness` implements `SessionHarness`, passes the existing contract tests applicable to all harnesses
- [ ] Harness validates `invokeSkill`'s return via `ReconVerdictSchema.parse()` at the seam
- [ ] `invokeSkill` resolver lands at `src/skills/invoke.ts`, reads SKILL.md routing table to map workflow → script path, spawns via Bun.spawn, returns parsed JSON
- [ ] Fragment example at `docs/examples/agents.d/gh-repo-recon-agent.yaml` references `skill: Recon`, `workflow: RepoRecon`, and the four new runtime fields
- [ ] Integration test in cortex dispatches a real recon envelope through the harness, verifies verdict shape end-to-end

### Principal-side

- [ ] Fragment at `~/.config/cortex/agents.d/gh-repo-recon-agent.yaml` loaded by cortex without rejection
- [ ] Manual smoke: Luna in `#cortex` channel emits `dispatch.recon.cortex`, receives verdict within 5s, summarizes "what's in flight for cortex" without making any gh calls herself
- [ ] Verdict envelope is renderable in the Mission Control dashboard (existing envelope-viewer surfaces it)

---

## 12. Open Questions

### Resolved in this design (Echo round-1 feedback)

- **R1. Persona `kind` naming → `behavior-contract`.** Considered `function-spec` and `handler-contract`; rejected both. `function-spec` underweights the trust contract (the doc isn't just a function signature, it's the sealed-execution contract). `handler-contract` is fine but less general — future deterministic agents may have multiple handlers (e.g. one per trigger shape). `behavior-contract` reads as "this doc declares the behavior; the linked handler IS that behavior" and generalises cleanly. Locked.
- **R2. GH token → reuse `GH_TOKEN` in MVP.** The §7 fragment uses `GH_TOKEN`. A dedicated read-only PAT (`GH_TOKEN_READONLY`) scoped to the orgs cortex cares about is the eventual target, minted via the per-service secrets pattern at `~/.config/pai/secrets/gh-repo-recon-agent.env` — but is a follow-up, not a blocker for first land.

### Remaining open

1. **Caching policy.** MVP is no caching — every dispatch is a fresh fetch. If rate limits bite, add a 60-second TTL cache keyed by `(owner, repo, include-set, state)`. Defer until measured.
2. **One agent per ecosystem, or per-org?** MVP: one agent, takes `owner` in the envelope. If we later want per-org scoping for credential reasons (different PATs for different orgs), split.
3. **NATS queue group behavior.** Single subscriber for MVP. If a second instance is ever wanted (fan-out, redundancy), queue-group semantics apply for free — no agent-side changes.
4. **`mine` cross-cut for non-GitHub identity.** Principals identified as `did:mf:...` in metafactory might not have a corresponding GitHub login. Need a mapping. Defer until first non-Andreas principal.
5. **Streaming progress.** For typical-size repos (<30 PRs), the verdict completes in ~2s — no need for streaming. For very large repos (Linux-kernel sized), would the deterministic-agent class want to emit `dispatch.task.progress` envelopes for each section? Defer until measured.
6. **`AgentRuntimeSchema.substrate` and `HarnessId` unification.** The two enums are deliberately separate today (principal vocabulary vs runner vocabulary). This design adds `"deterministic-agent"` to both. Unification is a real piece of cortex#92 follow-up work; not blocking this design but worth tracking. File as `cortex#92` follow-up.

---

## 13. Why This Is the Right First Deterministic Agent

Three reasons grounded in observation, not speculation.

1. **Frequency.** Mining 499 sessions in `~/.claude/projects/-Users-andreas-Developer/`: the multi-call gh recon pattern (`gh pr list` + `gh issue list` + `gh repo view`, often 3–6 calls together) is the most-frequent investigation primitive across PAI history. `feedback_check_prs_first` mandates it before any non-trivial work, which means every judgment agent should be doing it constantly. Today they don't, because the prompting overhead is high. A bus primitive collapses that overhead.

2. **Pure read.** No side effects on the world, no auth surface beyond the read-only GH token, no risk on rollback. The cheapest possible production target for validating the class.

3. **Clear verdict shape.** Structured "what's in flight" — list of PRs, list of issues, recent commits, my-assigned items. That envelope is consumable by judgment agents and by the dashboard alike. No ambiguity about what the agent produces.

The trust-bearing demonstration of the class (a deterministic agent that *does something* to the world) is best deferred to the second deterministic agent — likely `cortex-restart` or a generalized `pai-pkg-restart`. Starting with a pure read lets the class itself be debugged before the trust boundary is exercised on a write.

---

## 14. Migration

Three landing steps. The new skill repo lands first (lowest dependency); cortex changes land after #92 merges; principal install last.

### Step 1 — `the-metafactory/arc-skill-recon` (new repo)

Bootstrap via the `new-repo` SOP (`compass/sops/new-repo.md`). Files match the `arc-skill-code-review` shape exactly.

| File | Source/template |
|---|---|
| `arc-manifest.yaml` | copy + adapt from arc-skill-code-review's manifest |
| `CLAUDE.md` | ecosystem template via `arc upgrade compass` |
| `README.md`, `package.json`, `.gitignore` | standard |
| `skill/SKILL.md` | written per §6.2 |
| `skill/Workflows/RepoRecon.md` | written per §6.4 |
| `skill/scripts/recon.ts` | implementation per §6.1 + §8.1 verdict shape |
| `skill/__tests__/recon.test.ts` | unit tests with mocked gh fixtures |
| `prompt/recon.md` | slash command per §6.3 |

Independent of cortex#92 — can land in parallel.

### Step 2 — `the-metafactory/cortex` (single PR after #92)

| Lands | Files |
|---|---|
| `HarnessId` += `"deterministic-agent"` | `src/common/substrates/types.ts` |
| `AgentRuntimeSchema` += substrate value + optional `skill`/`workflow`/`retry`/`task_subjects`/`publish_subjects`/`secrets` + `.refine()` | `src/common/types/cortex-config.ts` |
| `persona` shape union (additive, backward-compatible) | `src/common/types/cortex-config.ts` |
| `DeterministicAgentHarness` impl + contract tests | `src/substrates/deterministic-agent/` |
| `invokeSkill` resolver | `src/skills/invoke.ts` |
| Fragment example | `docs/examples/agents.d/gh-repo-recon-agent.yaml` |
| This doc, promoted | `docs/design-gh-repo-recon-agent.md` (currently this PR — already in place) |

### Step 3 — Principal side

- `arc install github:the-metafactory/arc-skill-recon` — drops skill + slash command
- `cp <fragment-example> ~/.config/cortex/agents.d/gh-repo-recon-agent.yaml`
- Restart cortex so the new agent loads. Restart command is principal-deployment-specific:
  - On macOS (Andreas' deployment): `launchctl kickstart -k gui/$(id -u)/ai.meta-factory.cortex.meta-factory` (or `.work` for the parallel work stack)
  - On Linux / containers: per the principal's process manager (systemd unit, docker restart, etc.)
- Smoke test: `/recon the-metafactory/cortex` (slash command) AND publish a `dispatch.recon.<id>` envelope to verify the bus path (different resolution path, same verdict shape).

---

## 15. Anti-Scope

- No second deterministic agent in this PR. `cortex-restart`, `wrangler-deploy`, `vault-snapshot` are follow-ups.
- No deterministic-agent SDK or registry yet. The command-by-name pattern is intentionally minimal. SDKs come after we have 3+ deterministic agents and can see the actual abstraction shape.
- No multi-agent orchestration features (callable_agents, sub-dispatch). Deterministic agents publish verdicts; judgment agents read them. Composition happens at the bus layer, not in the agent.
- No deterministic-agent-specific dashboard. Mission Control's existing envelope viewer renders the verdict; a dedicated deterministic-agents panel can come if and when the pattern proliferates.
- No future `BranchRecon` / `SweepRecon` / `OrgRecon` workflows in MVP. The slash-command parameter set in §4.1 is designed to admit them later without breaking callers; they ship as separate follow-up PRs in `arc-skill-recon` once the shape is proven.

---

## 16. References

- cortex#91 — design: SessionHarness interface — multi-substrate agent dispatch
- cortex#92 — design doc on `feat/c-091-substrate-harness-design` (this spec lands after)
- `the-metafactory/arc-skill-code-review` — exact precedent for the skill+slash repo pattern (`skill/SKILL.md`, `skill/Workflows/*.md`, `prompt/review-pr.md`, `arc-manifest.yaml`)
- `compass/sops/new-repo.md` — ecosystem repo bootstrap SOP (used for Step 1 of migration)
- `~/.claude/projects/-Users-andreas-Developer/memory/feedback_check_prs_first.md` — the rule this agent automates
- `~/.claude/projects/-Users-andreas-Developer/memory/feedback_unify_cross_cutting.md` — relevant if `wrangler-deploy` (in spawn) and `cortex-restart` (in cortex) need unification
- `docs/design-collaboration-surface.md` — Stripe Minions reference (deterministic agent graphs as prior inspiration)
- `docs/design-pi-dev-review-agent.md` — Sage as judgment-class peer; this agent's verdict is a likely input to Sage's review context
