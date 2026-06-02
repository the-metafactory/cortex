# Plan — Mission Control Cortex Cockpit (G-1113)

**Status:** draft for review
**Branch:** `feat/g-1113-mission-control-cockpit`
**Driver:** Andreas
**Design:** [`docs/design-mission-control-cortex-cockpit.md`](design-mission-control-cortex-cockpit.md)
**Umbrella issue:** _(to be filed once this plan is agreed)_
**Process:** umbrella → phase sub-issues → sub-feature PRs; one PR per sub-feature; pilot review loop with Echo primary

---

## 1. What we're building (recap from design spec)

Turn the current Mission Control dashboard into an **principal cockpit**: one
pane of glass over plans, their phases, work items, branches, PRs, checks,
releases, agent sessions, and what needs attention. The same surface should
work for software workflows (Git-native) and generic workflows (Jira / Linear
/ internal tasks).

Four shifts make this different from today's dashboard:

1. **Provider-neutral.** Today the code assumes `source=github`. Tomorrow
   GitHub is the first of several adapters (GitLab, Azure DevOps, Jira,
   Linear, internal). Provider becomes metadata, not a type fork.
2. **Git objects are first-class.** Repository, branch, commit, tag,
   release, pull request, review, check, build, deployment, artifact — each
   has a typed shape, storage, and ingestion path. No vague "work product"
   union.
3. **Plans above tasks.** The Compass execution chain
   (research → design → roadmap → spec → iteration plan → umbrella → work
   item → PR → code) becomes Mission Control's runtime view. Plans / Phases
   live above tasks and roll up state.
4. **One attention queue.** Blocked sessions, PR review requests, failed
   checks, stale work, failed dispatches — one queue, one set of deep-links,
   one notification path.

**Shape of the work:** five phases (A–E), `A → B → (C ∥ D) → E`,
17–27 PRs total.

The methodology we use here — markdown plan doc + GitHub umbrella + sub-issues
+ blueprint dependency graph + task list — is intentionally the same chain
Mission Control will eventually visualize. This plan is dogfood for the
cockpit it produces.

### 1.1 Iterative delivery — each phase ships visible value

This is not a big-bang redesign. **Every phase ships an principal-visible
improvement to Mission Control.** If we stop after any phase, the principal is
left with a surface that is better than before, not a half-finished
construction site.

| Phase | What the principal sees after this phase |
|---|---|
| A — Grounding | Dashboard builds again; glossary linked from footer; "G-1113 cockpit redesign" badge in header linking to the plan |
| B — Provider-neutral refs | Each task row shows a provider badge; a "Sources" view lists configured providers |
| C — Software mode model | Branches + PRs as first-class chips on task rows; a per-repo Git-object grouping |
| D — Plan lineage UI | A "Plans" surface with this plan as the first card; phase progress, drill-down to phase detail |
| E — Attention + notifs | Unified attention queue with deep-links; routed notifications across Discord/Slack/Mattermost |

Within a phase, sub-features are sequenced so each PR moves something
principal-visible forward, not just internal plumbing. Model-layer PRs that
don't have an immediate UI manifestation are scheduled so they ship in the
same phase as the UI affordance that exposes them.

## 2. What this plan covers

This is the execution plan for the design spec
`design-mission-control-cortex-cockpit.md`. It defines:

- How the design's five slices (§10) become GitHub issues
- How those issues break into pools of pull requests
- The phase/wave structure and dependency order
- Per-phase acceptance criteria and visible deliverables
- The conventions agents use when working autonomously against this plan

When this plan and reality disagree, this plan wins (or is updated, never
silently). When this plan and the design spec disagree on what Mission Control
*is*, the design spec wins.

## 3. Issue + PR structure

```
G-1113  Mission Control Cortex Cockpit (umbrella issue)
  ├── G-1113.A  Phase A — Grounding              (sub-issue → 1 PR)
  ├── G-1113.B  Phase B — Provider-Neutral Refs  (sub-issue → N PRs)
  ├── G-1113.C  Phase C — Software Mode Model    (sub-issue → N PRs)
  ├── G-1113.D  Phase D — Plan Lineage UI        (sub-issue → N PRs)
  └── G-1113.E  Phase E — Attention + Notifications (sub-issue → N PRs)
```

**Sub-issue scope.** Each phase sub-issue (`G-1113.A` .. `G-1113.E`) is itself
a mini-umbrella. When a phase starts, its sub-features (`G-1113.B.1`,
`G-1113.B.2`, ...) are filed as further sub-issues, each closed by exactly one
PR. We do not pre-file phase sub-feature issues — they are filed at phase
start, after the prior phase's findings inform sub-feature shape.

**PR convention.** One sub-feature == one PR. Branch name
`feat/g-1113-{phase-letter}-{slot}-{slug}`, e.g.
`feat/g-1113-b-1-source-ref-types`. Title `feat(mc): G-1113.B.1 — {scope}`.
Body links `Closes the-metafactory/cortex#{sub-feature issue}` and references
the phase sub-issue.

**Plan doc tick-through.** Every merged PR ticks its box in §5 below AND in
the phase sub-issue's checklist.

## 4. Phase sequencing

```
                                      ┌─→ C  Software Mode Model ─┐
A  Grounding ──→ B  Provider Refs ────┤                           ├──→ E  Attention
                                      └─→ D  Plan Lineage UI ─────┘
```

Mirrors `blueprint.yaml`:

- `G-1113.A` ← no deps
- `G-1113.B` ← `[G-1113.A]`
- `G-1113.C` ← `[G-1113.B]`
- `G-1113.D` ← `[G-1113.B]`
- `G-1113.E` ← `[G-1113.C, G-1113.D]`

- **Phase A** is gating: it lands the plan doc itself + fixes the build-script
  drift that blocks any dashboard work.
- **Phase B** is the foundation. C, D, and E all consume provider-neutral
  source refs and Mission Control's normalized work-item model.
- **Phase C** and **Phase D** can be developed in parallel once B lands. C
  fleshes out the Git-object domain model; D fleshes out the Plan/Phase model.
- **Phase E** depends on C + D being far enough along that attention items
  can reference real Git objects + plan lineage. It can begin in parallel
  with C/D once both have landed their model types.

A given phase ships when its acceptance criteria (§5) are met, not when an
arbitrary PR count is hit.

## 5. The phases

### 5.1 Phase A — Grounding (G-1113.A)

**Goal:** make the work plan executable and put a first cockpit-shaped
visible signal in the existing dashboard.

**Visible deliverable (what the principal sees after Phase A):**

- The dashboard builds and runs again (today the build script points at the
  wrong path).
- A small "G-1113 · Mission Control Cockpit redesign" badge in the dashboard
  header, linking to the umbrella issue + plan doc on GitHub.
- A "Glossary" link in the dashboard footer pointing at
  `docs/glossary-mission-control.md`.

**Sub-features:**

- [ ] **G-1113.A.1** — Grounding PR · single PR · branch `feat/g-1113-a-1-grounding`
  - Add `docs/plan-mission-control-cockpit.md` (this file).
  - Fix `package.json` `build:dashboard` + `watch:dashboard` to point at
    `src/surface/mc/dashboard-v2/` (currently still `src/mission-control/...`).
  - Add `docs/glossary-mission-control.md` covering: Stack, Assistant,
    Cortex Agent, Substrate, Session, Task, Plan, Phase/Wave, Work Item,
    Repository, Branch, Commit, Pull Request, Review, Check, Release,
    Deployment, Artifact, Generic Mode, Software Mode.
  - Add the header "G-1113" badge + footer "Glossary" link to
    `src/surface/mc/dashboard-v2/`. Hardcoded URLs are fine; no ingestion.
  - Annotate genuinely-misleading lifted Grove v2 docs with a one-paragraph
    "Historical — lifted from grove-v2" banner. Scope: only docs whose
    architecture/paths actively mislead current Cortex work. Skip pure-language
    drift; skip iteration retros; skip `architecture.md` (Cortex-canonical).
    Target list (subject to verification during PR):
    `design-mc-f7-attention-view.md`, `design-mc-f9-working-grid.md`,
    `design-mc-f12-task-curation.md`, `design-mc-f12b-add-to-queue.md`,
    `design-mc-f18-metrics.md`, `design-session-activity.md`,
    `design-dashboard-efficiency.md`, `design-dm-operator-channel.md`,
    `design-cloud-api.md`, `design-api-security.md`, `design-test-rig.md`,
    `design-spawn-integration.md`.

**Acceptance criteria:**

- `bun run build:dashboard` succeeds.
- Header badge + footer link render in the dashboard and resolve correctly.
- New glossary doc renders in repo without broken internal links.
- Each annotated historical doc carries the standard banner (consistent
  wording, link back to the new design spec).
- This plan doc and the design spec are both on `main` via this PR's merge.

**Dependencies:** none (gating).

---

### 5.2 Phase B — Provider-Neutral Source Refs (G-1113.B)

**Goal:** introduce a normalized source-ref model + make provider
provenance visible on every task. Keep existing GitHub behavior working.

**Visible deliverable (what the principal sees after Phase B):**

- Every task row shows a small provider badge (icon + provider name).
  Today they all read "GitHub"; the badge is provider-aware so future
  GitLab / Azure DevOps / Jira tasks render distinctly.
- A "Sources" config view (under Settings or as a sidebar item) lists the
  configured providers and their basic state (today: GitHub only).

**Sub-features (sketched — refined at phase start):**

- [ ] **G-1113.B.1** — Source-ref type + Provider enum
  - Add `Provider` union (`internal | github | gitlab | azure-devops | jira | linear | bitbucket | custom`).
  - Add normalized `SourceRef` shape (`{ provider, externalId, url, providerNativeType }`).
  - No behavior change; types only.
- [ ] **G-1113.B.2** — Task schema: replace `source=github` assumptions with `SourceRef`
  - Update task storage + API contracts to accept the new shape.
  - Migration shim: existing GitHub tasks read as `{ provider: 'github', ... }`.
- [ ] **G-1113.B.3** — GitHub adapter boundary
  - Move GitHub URL parsing / webhook ingestion / API fetch behind an
    `adapters/github/` boundary that emits normalized source refs.
  - No new providers wired; just moving the existing code behind the
    boundary.
- [ ] **G-1113.B.4** — Provider badge on task rows + Sources view
  - Small provider-aware badge component, fed by `SourceRef`.
  - "Sources" config view listing configured providers.
- [ ] **G-1113.B.5** — Fixture-based adapter parity tests
  - Provider examples for GitHub (real), GitLab (fixture), Azure DevOps
    (fixture), Jira (fixture), internal (synthetic).
  - Tests assert each adapter produces a valid `SourceRef`.

**Acceptance criteria:**

- All existing GitHub-sourced tasks still flow end-to-end (no regression).
- Provider badge visible on every task row and reflects `SourceRef.provider`.
- Sources view renders configured providers from config.
- New `SourceRef` is the only way new code in this phase touches a provider.
- Fixture suite covers all five listed providers at the source-ref level.

**Dependencies:** Phase A.

**Open question carried from design §11:** Provider naming — `merge_request`
preserved as `providerNativeType` on a normalized `PullRequest`, or distinct
top-level `ChangeRequest` concept? Resolution should happen during B.1.

---

### 5.3 Phase C — Software Mode Domain Model (G-1113.C)

**Goal:** first-class Git objects in the model layer **and** surface them
in the UI as first-class chips/rows.

**Visible deliverable (what the principal sees after Phase C):**

- Each task row shows linked branches + PRs as compact first-class chips
  (not just a link). Chip hover reveals check status + review state.
- A new "Repositories" sidebar / panel groups branches + PRs + recent
  releases per repository.
- Provider-native labels preserved on chips ("Merge request" when
  applicable).

**Sub-features (sketched — refined at phase start):**

- [ ] **G-1113.C.1** — `GitRepository` + `GitBranch` types + storage
- [ ] **G-1113.C.2** — `GitCommit` + `GitTag` types + storage
- [ ] **G-1113.C.3** — `PullRequest` (+ `Review`) types + storage
- [ ] **G-1113.C.4** — `Check` / `Build` + `Deployment` + `Artifact` types
- [ ] **G-1113.C.5** — GitHub adapter populates the new model from existing
  webhook + REST data
- [ ] **G-1113.C.6** — UI: first-class branch + PR chips on task rows;
  check/review state on hover
- [ ] **G-1113.C.7** — UI: per-repository panel grouping branches + PRs +
  recent releases (gated behind a software-mode flag)

**Acceptance criteria:**

- Every Git noun listed in design §3.8 has a typed shape, storage, and an
  ingestion path from the GitHub adapter.
- Branch + PR chips visible on every task row that has linked refs.
- Per-repo panel renders and stays consistent with task-row chips.
- No visual regression on existing surfaces.
- New types are not yet referenced by the Plan model (that's Phase D).

**Dependencies:** Phase B.

---

### 5.4 Phase D — Plan Lineage UI (G-1113.D)

**Goal:** the plan/program surface that rolls up phase, work item, PR,
session, and attention state. Recasts the existing `Iterations` tab.

**Visible deliverable (what the principal sees after Phase D):**

- A new "Plans" tab (or recast Iterations tab) shows plans as cards: title,
  current phase, per-phase progress bar, work-item / PR / release /
  attention counts.
- This plan doc itself appears as the first Plan card with phases A–E
  enumerated.
- Drilling into a phase opens phase detail: work items, sessions, linked
  branches/PRs/checks/reviews.
- Work-item detail shows plan/phase context + linked Git objects.

**Sub-features (sketched — refined at phase start):**

- [x] **G-1113.D.1** — `Plan` + `PlanPhase` types + storage (#584)
- [x] **G-1113.D.2** — Plan ingestion: parse repo-local plan docs
  (`docs/plan-*.md`, `docs/iteration-*.md`) into `Plan` rows with
  `sourceDocumentUrl` (#585)
- [x] **G-1113.D.3** — Plan overview surface (a new tab or recast `Iterations`)
  showing the design §7.1 layout: title, current phase, per-phase progress,
  WI/PR/release/attention counts (#586)
- [ ] **G-1113.D.4** — Phase detail view (design §7.2) — *in review (#588)*.
  Introduces the `WorkItem` model + `work_items` storage + phase-detail
  projection/UI. Honest empty state until ingestion (D.5b) lands.
- [ ] **G-1113.D.5** — Work-item detail evolves to show plan/phase context
  + linked branches/PRs/checks (design §7.3)
- [ ] **G-1113.D.5b** — WorkItem ingestion, **provider-neutral from the start**
  (#587): define a generic `WorkItemSource` interface behind `adapters/`,
  implement GitHub as the *first* adapter against it (umbrella → sub-issues →
  `WorkItem`s; link PRs via `pull_requests.work_item_id`). Forces neutrality to
  be exercised by design rather than asserted.
- [ ] **G-1113.D.6** — Compatibility: keep the legacy iteration kanban
  available behind a tab toggle until plan surface reaches parity
- [ ] **G-1113.D.7** — Migrate the legacy github-coupled `tasks`/`iterations`
  layer (`source_system` CHECK, `api/iteration-import.ts`) onto the
  provider-neutral `SourceRef` (#590). Behaviour-preserving; coordinates with
  D.5b's adapter boundary so GitHub stays *a* provider, not *the* provider.

**Acceptance criteria:**

- A plan defined in markdown (e.g. this file) appears as a Plan row in the
  UI with each Phase A–E enumerated and progress accurate.
- Drilling into a phase shows its sub-feature work items + linked PRs +
  current session, sourced from the Phase C model.
- No regression in principal-visible task flow.

**Dependencies:** Phase B; benefits from Phase C but does not block on C
beyond the WI ⇄ PR linkage (D.5).

**Resolved (D.1, #584):** canonical noun is **`Plan`** (design §11 Q1 struck).

---

### 5.5 Phase E — Attention + Notifications (G-1113.E)

**Goal:** one attention queue across plans, phases, work items, PRs, and
sessions. Notifications routed through stack surfaces (Discord, Slack,
Mattermost).

**Visible deliverable (what the principal sees after Phase E):**

- An "Attention" panel (or header icon with counter) listing everything
  that needs principal action: blocked sessions, PR review requests,
  permission requests, failed checks, failed dispatches, stale work.
- Each item carries a deep-link to the exact plan / phase / work item /
  PR / session that needs action.
- The same deep-links arrive as routed notifications in Discord / Slack /
  Mattermost channels.

**Sub-features (sketched — refined at phase start):**

- [ ] **G-1113.E.1** — `AttentionItem` type + storage + lifecycle (open →
  resolved/dismissed)
- [ ] **G-1113.E.2** — Attention sources wired:
  - blocked sessions (from runner)
  - permission requests
  - review checkpoints (PR review_requested)
  - failed dispatches (Myelin envelope nak)
  - failing checks
  - stale work items
- [ ] **G-1113.E.3** — Attention queue UI surface (design §7.4) with
  deep-links into plan / phase / WI / PR / session
- [ ] **G-1113.E.4** — Notification routing: emit `system.attention.*`
  envelopes; Discord adapter renders them in the appropriate channel/thread

**Acceptance criteria:**

- Every attention kind listed in design §7.4 has a producer + a deep-link.
- Notifications land in the principal's expected Discord/Slack/Mattermost
  channel for each kind.
- Attention items resolve correctly when their underlying condition clears
  (PR approved, check passes, session unblocks).

**Dependencies:** Phase C (Git-object attention sources) + Phase D (deep-link
targets). Can begin once C and D have landed their model layers; UI work
may parallelize with later D sub-features.

---

## 6. Sequencing summary

| Phase | Depends on | Blocks | Indicative PR count |
|---|---|---|---|
| A — Grounding | — | B | 1 |
| B — Provider-neutral refs | A | C, D, E | 4–6 |
| C — Software mode model | B | E (partial) | 6–9 |
| D — Plan lineage UI | B (+ C for D.5) | E (partial) | 5–8 |
| E — Attention + notifications | C + D | — | 3–5 |

Total indicative: **19–29 PRs** across the umbrella. (Slightly larger than
the original 17–27 because each phase now ships a UI affordance, not just
plumbing.)

## 7. Open decisions

Carried from design §11. Resolve at the start of the phase that depends on
each, not now:

1. Canonical top-level noun — `Plan` (provisional default) vs `Program` vs
   `Work Plan`. → resolved by D.1.
2. `phase` vs `wave` alias-or-canonical. → resolved by D.1.
3. `PullRequest` vs `ChangeRequest`. → resolved by B.1.
4. Iteration board: replace vs compatibility-tab. → resolved by D.3 / D.6.
5. Next provider after GitHub. → resolved when Phase B+ findings inform.
6. Plan state: passive mirror vs write-back. → resolved during D.5.
7. Myelin events vs direct provider API for which signals. → resolved
   during E.2.

## 8. Process notes

- **Worktree discipline.** Each sub-feature gets its own worktree under
  `../cortex-g-1113-{slot}-{slug}` cut from `origin/main`. The umbrella
  branch (`feat/g-1113-mission-control-cockpit`) only carries this plan +
  the design spec; sub-feature work happens on fresh branches.
- **Review loop.** Echo primary on PR review via the pilot loop; in-session
  sub-agent (Engineer subagent_type) fallback when Echo dispatch flakes.
- **Tick discipline.** Merging a sub-feature PR ticks the box in this plan
  AND comments-and-closes the sub-feature sub-issue. The phase sub-issue
  closes when all its sub-features tick. The umbrella closes when all
  phases close.
- **Plan vs blueprint.** The dependency graph lives in `blueprint.yaml`
  under `G-1113` + `G-1113.A` .. `G-1113.E` (+ `G-1113.A.1` pre-filed). This
  doc is the human-readable narrative; the blueprint is the queryable
  source of truth. `blueprint ready` shows what's unblocked; `blueprint
  update cortex:G-1113.X --status in-progress` claims a phase. Sub-feature
  blueprint nodes for B/C/D/E are filed at phase start, matching the
  sub-issue filing convention in §3.
- **No GitHub Projects board.** The umbrella + sub-issues are the board.
  Sub-issue rollup is GitHub's native sub-issue feature.
- **Autonomous work mode.** Once this plan is agreed, the TaskList is
  populated from §5: one TaskCreate per open `G-1113.X.Y` checkbox. Agents
  pick the next ready task (dependencies satisfied) and work it through
  to merged PR.
