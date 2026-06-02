# Mission Control Cortex Cockpit

**Status:** draft for review  
**Tracking:** G-1113 — the-metafactory/cortex#354  
**Owners:** Andreas + Soma  
**Scope:** Re-ground Mission Control after the grove-v2 to Cortex/Myelin/NATS migration.

## 1. Purpose

Mission Control should become the principal cockpit for a Cortex stack. The
principal should be able to see what assistants and Cortex agents are doing,
inspect their current context, notice when work needs attention, provide input
or review feedback, and watch higher-level plans move through issues, pull
requests, checks, releases, and deployments.

The original Grove v2 Mission Control vision is still the source material:
attention, drill-down, input return, notifications, task curation, and live
agent observability. The substrate underneath has changed. Cortex now has stack
identity, Myelin/NATS, signed envelopes, capability dispatch, local substrate
sessions, and multiple collaboration surfaces.

This document translates the Grove v2 vision into Cortex terminology and adds
a plan-level view above individual tasks.

## 2. Design Lineage

Compass defines the document and execution chain:

```text
Research
  -> Design decisions
      -> Roadmap
          -> Design specs
              -> Iteration / migration / release plans
                  -> Umbrella issues
                      -> Feature issues / work items
                          -> Pull requests
                              -> Code
```

Mission Control should be the runtime view of that chain. It should not only
show individual sessions. It should show how sessions, issues, pull requests,
reviews, commits, checks, and releases roll up into a larger plan.

## 3. Core Concepts

### 3.1 Stack

A stack is the Cortex runtime boundary. It owns:

- stack identity
- signing key
- policy principals
- agents and presences
- Myelin/NATS subjects
- local execution permissions

Examples:

- `andreas/meta-factory`
- `andreas/work`

Mission Control is scoped to one stack at a time, with future support for a
multi-stack overview.

### 3.2 Assistant And Cortex Agent

Use Soma's layer split:

- **assistant**: persistent named being, such as Luna, PAI, or Sage.
- **Cortex agent**: the stack-local daemon/process identity that hosts or
  represents assistant work on Myelin/NATS.

Mission Control may show both. The principal cares about the assistant name,
while the runtime needs the stack-local Cortex agent identity and signing
provenance.

### 3.3 Substrate And Session

A substrate is the runtime where work is performed:

- Codex
- Claude Code
- Pi.dev
- Cortex/Myelin daemon
- future local or remote execution hosts

A session is one running substrate interaction. It has:

- assistant / Cortex agent
- stack
- task or work item
- substrate
- prompt/input context
- event stream
- tool calls
- status
- attention state

### 3.4 Task

A task is Mission Control's local unit of work. It can originate from many
places, but it is not identical to its provider object.

Examples of task sources:

- manual/internal task
- GitHub issue
- GitLab issue
- Azure Boards work item
- Jira issue
- Linear issue
- routine-generated task
- dispatch-generated task

Provider identity is metadata on the task, not the task itself.

### 3.5 Plan

A plan is the work-management layer above tasks.

Plan kinds:

- research plan
- design plan
- migration plan
- iteration plan
- release plan
- rollout plan
- incident response plan

A plan has a source document and a set of phases or waves. It may be backed by
an umbrella issue, a Jira version, an Azure Boards epic, a Linear project, or a
repo-local markdown file.

### 3.6 Phase Or Wave

A phase or wave is an ordered slice of a plan. It groups work items under a
high-level concept.

Examples:

- `Phase A — Data foundation`
- `Wave 2 — Slack work stack`
- `MIG-7 — top-level Cortex wiring`
- `v2.0.6 release hardening`

The UI may use either "phase" or "wave" depending on the plan's own language,
but the model should treat them as the same structural concept.

### 3.7 Work Item

A work item is the provider-backed executable tracking object under a phase.

Examples:

- GitHub issue
- GitLab issue
- Azure Boards work item
- Jira issue
- Linear issue
- internal Mission Control task

Work items can have child work items, and a plan can have an umbrella work
item that rolls up progress from child work items.

### 3.8 Git Objects

Software mode must preserve Git-native nouns. These are first-class concepts,
not vague "work products":

- repository
- branch
- commit
- tag
- release
- pull request
- review
- check / status check
- build
- deployment
- artifact

The provider is abstracted; the Git concept is not. For example, a GitLab
merge request maps to Mission Control's pull request concept while retaining
`providerNativeType: "merge_request"` for display and provider API calls.

## 4. Modes

Mission Control should support modes or lenses. The model stays shared; the UI
changes what it promotes.

### 4.1 Generic Mode

Generic mode centers:

- tasks
- source refs
- assignees
- status
- priority
- comments
- sessions
- attention items

This mode works for non-software workflows and for provider backends such as
Jira, Linear, or Azure Boards when no Git objects are attached.

### 4.2 Software Mode

Software mode promotes software-development objects:

- repositories
- branches
- commits
- tags
- releases
- pull requests / merge requests
- reviews
- checks and builds
- deployments
- artifacts

This mirrors Jira Software: a generic task/work-item system becomes a software
cockpit when connected to source control, CI, and release providers.

Software mode should be the first real Cortex Mission Control mode because the
immediate principal workflows are software-agent workflows.

## 5. Provider Neutrality

Mission Control should be provider-neutral at the source/ref boundary.

Provider-specific adapters or taps normalize provider-native objects into
Mission Control concepts:

| Provider object | Mission Control concept |
| --- | --- |
| GitHub issue | Work item |
| GitLab issue | Work item |
| Azure Boards work item | Work item |
| Jira issue | Work item |
| Linear issue | Work item |
| GitHub pull request | Pull request |
| GitLab merge request | Pull request with native label "Merge request" |
| Azure DevOps pull request | Pull request |
| Git tag | Tag |
| GitHub release | Release |
| GitLab release | Release |
| Azure DevOps build | Check / build |

The UI should use provider-native labels when they help the principal, but the
core model should not fork by provider.

### 5.1 GitHub Abstraction Is In Scope

Cortex currently has real GitHub-specific implementation: webhook ingestion,
issue/PR import, GitHub URL parsing, `github.repos` config, GitHub event
envelopes, and dashboard inbox paths that assume `source=github`.

This design treats that as implementation history, not as the target Mission
Control model. Abstracting GitHub into provider-neutral Mission Control concepts
is in scope for this cockpit line of work.

The rule:

- keep Git-native concepts concrete: repository, branch, commit, tag, release,
  pull request, review, check, build, deployment, artifact
- abstract the provider layer: GitHub, GitLab, Azure DevOps, Bitbucket, custom
- preserve provider-native display labels where useful
- keep existing GitHub behavior working while moving it behind normalized
  source/work-item/Git-object boundaries

In other words, GitHub becomes the first provider adapter for the new model, not
the model itself.

## 6. Proposed Domain Model

Illustrative TypeScript shape:

```ts
type Provider =
  | "internal"
  | "github"
  | "gitlab"
  | "azure-devops"
  | "jira"
  | "linear"
  | "bitbucket"
  | "custom";

interface Plan {
  id: string;
  title: string;
  kind: "research" | "design" | "iteration" | "migration" | "release" | "rollout" | "incident";
  sourceDocumentUrl: string | null;
  provider: Provider;
  externalId: string | null;
  umbrellaWorkItemId: string | null;
  status: "draft" | "active" | "blocked" | "done" | "cancelled";
}

interface PlanPhase {
  id: string;
  planId: string;
  title: string;
  order: number;
  status: "not_started" | "active" | "blocked" | "done" | "cancelled";
}

interface WorkItem {
  id: string;
  planId: string | null;
  phaseId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  provider: Provider;
  externalId: string | null;
  url: string | null;
}

interface GitRepository {
  id: string;
  provider: Provider;
  owner: string | null;
  name: string;
  url: string | null;
  defaultBranch: string | null;
}

interface GitBranch {
  id: string;
  repositoryId: string;
  name: string;
  baseRef: string | null;
  headSha: string | null;
  provider: Provider;
  externalId: string | null;
  url: string | null;
}

interface GitCommit {
  id: string;
  repositoryId: string;
  sha: string;
  title: string;
  author: string | null;
  url: string | null;
}

interface PullRequest {
  id: string;
  workItemId: string | null;
  repositoryId: string;
  provider: Provider;
  providerNativeType: "pull_request" | "merge_request" | string;
  externalId: string;
  numberOrKey: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  reviewState: "none" | "needs_review" | "changes_requested" | "approved";
}

interface Release {
  id: string;
  repositoryId: string | null;
  provider: Provider;
  externalId: string | null;
  name: string;
  tagName: string | null;
  url: string | null;
  state: "draft" | "published" | "failed" | "archived";
}

interface Session {
  id: string;
  stackId: string;
  assistantId: string;
  cortexAgentId: string | null;
  substrate: string;
  workItemId: string | null;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
}

interface AttentionItem {
  id: string;
  stackId: string;
  workItemId: string | null;
  sessionId: string | null;
  kind: "input_needed" | "permission" | "review" | "failed_dispatch" | "stale" | "blocked";
  severity: "low" | "normal" | "high" | "critical";
  status: "open" | "resolved" | "dismissed";
}
```

This is not a final schema. It is the vocabulary boundary the implementation
should converge toward.

## 7. UI Shape

### 7.1 Plan Overview

Top-level plan view:

- plan title and source document
- current phase/wave
- progress by phase
- open/blocked/done work item counts
- pull request counts by review state
- release/deployment status when present
- attention summary

Example:

```text
Cortex v2.0.6 Release Plan
Phase A  Docs and grounding      3/4 done
Phase B  Software mode model     1/5 active
Phase C  Live session rollup     blocked
Phase D  Release and rollout     not started
```

### 7.2 Phase Detail

Phase detail shows:

- work items in the phase
- assigned assistant / Cortex agent
- current session status
- linked branches
- linked pull requests
- checks and reviews
- attention items

### 7.3 Work Item Detail

Work item detail is the operational drill-down:

- source provider and external link
- current assistant/session
- event log
- branch and pull request links
- review comments
- checks/builds
- principal input box
- curation actions: dispatch, requeue, abandon, hand off

### 7.4 Attention Queue

Attention queue cuts across plans and phases:

- blocked sessions
- permission requests
- review checkpoints
- failed dispatches
- stale work
- PR review requests
- failing checks requiring triage

Every attention item should deep-link to the exact plan, phase, work item,
pull request, or session that needs action.

## 8. Pipeline Rollup

Mission Control should be able to answer:

- Which plan is this work part of?
- Which phase/wave is currently active?
- Which work items are blocked?
- Which pull requests are waiting for review?
- Which branches are active but have no pull request?
- Which checks are failing?
- Which sessions are running, stale, or waiting for input?
- Which releases are ready, blocked, or shipped?

This is the pane-of-glass goal: the principal sees the whole execution pipeline
from design document to release.

## 9. Relation To Existing Cortex Mission Control

Current Cortex Mission Control already has:

- React dashboard under `src/surface/mc/dashboard-v2/`
- tasks
- assignments
- sessions
- event log
- focus area
- working-agent grid
- iteration board
- metrics
- GitHub-specific issue/PR ingestion pieces

Known drift to resolve:

- docs still refer to `src/mission-control` even though Cortex uses
  `src/surface/mc`
- package scripts still point at the old dashboard path
- task source schema is still constrained around GitHub/internal
- GitHub parser/fetch code is provider-specific
- inbox views assume `source=github`

### 9.1 Current UI Findings

The existing React UI has useful structure:

- `App` owns the top-level tabs: default execution view, metrics, iterations,
  and iteration detail.
- The default view already gives the principal execution visibility through
  `FocusArea`, `WorkingGrid`, and `TaskTable`.
- The drill-down overlay already gives a session/assignment attention surface:
  `DrillHeader`, `DrillLog`, `CurationToolbar`, and `DrillInput`.
- The iterations view already has a kanban board plus a full-page detail view.
- The task table already supports dispatch and links tasks to iteration detail.
- The hook/test layout is relatively modular: data hooks, pure display helpers,
  and component tests already exist under `dashboard-v2/`.

The existing UI gaps are equally clear:

- "Iteration" is currently a kanban/task wrapper, not the plan-lineage object
  described in this document.
- There is no top-level plan/program view that rolls up phases/waves, work
  items, pull requests, branches, checks, releases, sessions, and attention.
- GitHub-specific source assumptions leak into the task/inbox flow.
- Git objects are not first-class UI/model concepts yet. Branches, pull
  requests, checks, releases, and deployments appear only indirectly or through
  provider-specific paths.
- The dashboard still carries Grove-era language in comments and docs.

### 9.2 Response To Findings

The next cycle should preserve the current surfaces and evolve them:

- Keep `FocusArea`, `WorkingGrid`, `TaskTable`, and `DrillDown` as the
  execution cockpit foundation.
- Recast the existing `Iterations` tab into a broader `Plans` or `Work Plans`
  surface rather than adding plan lineage to the task table.
- Treat the current iteration board/detail as a candidate implementation
  substrate for plan phases/waves, not as the final information architecture.
- Add provider-neutral source refs and first-class Git objects behind the UI
  before adding new visual affordances that depend on them.
- Keep GitHub working as the first provider while moving GitHub parsing/fetching
  behind provider adapter boundaries.
- Rename or annotate Grove-era comments/docs only when they mislead current
  Cortex work; avoid noisy historical churn.

## 10. First Implementation Slices

### Slice 1 — Grounding PR

- Add this design document.
- Fix dashboard build/watch script paths.
- Mark lifted Grove v2 docs as historical/source material where needed.
- Add a short glossary in the docs index or Mission Control design area.
- Record the current UI findings from §9.1 as the baseline for follow-up work.

### Slice 2 — Provider-Neutral Source Refs

- Relax source provider vocabulary in types and schema.
- Add normalized source ref helpers.
- Keep GitHub behavior working.
- Add tests with GitHub, GitLab, Azure DevOps, Jira, and internal examples.
- Move GitHub-specific parsing/fetching behind adapter-shaped boundaries where
  the Mission Control model consumes normalized source refs.

### Slice 3 — Software Mode Model

- Add first-class Git object types for repository, branch, commit, tag,
  release, pull request, review, check/build, deployment, and artifact.
- Map existing GitHub data into the new model.
- Preserve provider-native display labels.
- Ensure branch is represented explicitly as a Git object, because feature
  branches are central to Compass worktree and pull-request workflow.

### Slice 4 — Plan Lineage UI

- Add a plan overview surface.
- Roll up phase/work-item/pull-request/session state.
- Link existing iteration board concepts into the new plan model.
- Decide whether the existing `Iterations` tab becomes `Plans` directly or
  remains a compatibility view while the new plan surface lands beside it.

### Slice 5 — Attention And Notifications

- Connect blocked sessions, review checkpoints, failed checks, and PR review
  requests into one attention queue.
- Route notifications through stack surfaces such as Slack, Discord, or
  Mattermost.

## 11. Open Questions

1. ~~Should the canonical top-level noun be `Plan`, `Program`, or `Work Plan`?~~
   **Resolved (G-1113.D.1, #578): `Plan`.** Matches the §3.5 and §6 doc
   default; the `Plan` type + `plans` table commit to it.
2. Should "phase" and "wave" be aliases, or should one be canonical?
3. ~~Should `PullRequest` be the normalized model name, with GitLab merge request
   as a provider-native label, or should the model use `ChangeRequest`?~~
   **Resolved (G-1113.B.1, #544): native-type-as-field.** `PullRequest` is the
   normalized name; the provider-native label rides as `providerNativeType`
   (e.g. `"merge_request"`) on the `SourceRef` / Git concept — no separate
   top-level `ChangeRequest`.
4. How much of the existing iteration board should be preserved versus folded
   into the new plan overview?
5. Which provider should be added first after GitHub: Azure DevOps, GitLab,
   Jira, or Linear?
6. Should plan state mirror provider state passively, or should Mission Control
   write back status changes to provider work items?
7. Which events should be sourced from Myelin envelopes versus direct provider
   API/tap ingestion?
