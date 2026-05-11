# MC v3 — Iteration planning surface (design spec)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-iteration-planning.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §3 ("The task funnel") and §8 ("Dashboard surfaces").
**Phase:** F (post-MIG-6).
**Date:** 2026-04-26.
**Status:** Draft. Open questions enumerated; decisions to be pinned before any code lands.

## Why this spec

MC v1 (Phases A–E) and MC v2 (the React migration MIGs 1–6) cover the **execution half** of the funnel: a curated queue of tasks → assignments → state machine → drill-down. Everything *upstream* of that — figuring out what should enter the queue, sequencing it, writing the design notes — currently happens in the operator's head plus the `docs/iteration-*.md` files.

That works at single-developer scale. It will not work as the bot fleet scales or as a PM-agent starts pre-baking iterations. We need a **first-class design surface** in the dashboard:

> Above the meat grinder. Below the source backlog. A place to assemble issues into iterations, write the design intent, decide what's ready, and promote it into the queue with one click.

This is the gap the design conversation on 2026-04-26 surfaced. Phrased as the operator quote that triggered it: *"I want a kanban-type view so I can see what's in the meat grinder and what's being designed, what's being planned."*

Three concrete reasons to build it now rather than later:

1. **Multi-source future.** The current "promote one issue at a time via the F-12b modal" works while we have one source (GitHub). The moment Jira / Linear / internal-spec docs land, the modal pattern doesn't scale — the operator needs a board view to scan.
2. **PM-agent role.** A long-running head whose job is "watch new issues and draft candidate iterations" needs an inbox + draft surface to write into. No surface = no place for that agent to exist.
3. **Iteration plans are already a thing in this repo.** `docs/iteration-mission-control.md` is the manual version of what this spec formalizes. Promoting it from a flat markdown file to a tracked entity removes a coordination tax we're already paying.

## Concept

```
GITHUB / JIRA / LINEAR     GROVE ITERATION PLANNING        GROVE EXECUTION
─────────────────────      ─────────────────────────       ────────────────
                                                            (existing today)

upstream issues  ──────►  inbox        ──promote──► queued ──dispatch──► running
(streaming via                                                              │
 webhook-proxy)            designing                                        ▼
                           ─────────                                     blocked
                           iteration A                                  /done
                           iteration B          ──ready──► queued
                           ...
```

Two new entities, three new surfaces, one extension to the existing `tasks` schema. Everything composes onto existing primitives — no rearchitecture of the execution path.

## Decision 1 — Grove owns the lifecycle. Source is import-only.

**Import is an event, not an ongoing sync.** When an issue (or PR, or Jira ticket, or Linear story) lands in Grove's inbox, we snapshot the upstream metadata (title, body, labels, parent-issue ref, source URL) at that moment. After import, the source link is purely a **display reference** — not a state input. Grove holds the canonical lifecycle.

We deliberately reject "derived status from source state" because it re-couples the two systems we're trying to separate, forces continuous source-state polling, and creates ambiguity when the source changes state after import (does Grove follow? on what cadence? what overrides what?). Cleaner is: import once, manage in Grove.

**Grove's lifecycle (stored, not derived) — six states + one terminal partition:**

| Grove status   | What it means                                                          |
|----------------|------------------------------------------------------------------------|
| `inbox`        | Imported from upstream. Not yet attached to any iteration.             |
| `designing`    | Attached to an iteration that is being shaped (draft).                 |
| `queued`       | Iteration promoted; task is in the dispatch queue waiting to start.    |
| `in_flight`    | At least one active assignment running.                                |
| `blocked`      | Active assignment blocked.                                             |
| `done`         | All assignments terminal AND operator marked the iteration complete.   |
| `cancelled`    | Operator-driven abandonment (separate from `done`).                    |

The state lives as a column on the iteration row (and an aggregated column on the task row, derived from the iteration + the task's own assignment states — but **not** from the source). Transitions are operator-driven moves on the kanban board, not source-state-driven.

**What the source link gives us, then:**
- A clickable URL on the iteration card (operator can open the upstream issue when they want context).
- An indicator chip showing whether the source is still open or has been closed since import (display only — does not move the Grove state).
- A snapshot of the body at import time, editable in Grove afterward (Decision 9 — no write-back).

**Source-closed-but-Grove-active** (and the inverse) are both legitimate states. The operator might close a GitHub issue early because the work scope changed, while the Grove iteration continues against revised acceptance criteria. The reverse — Grove-`done`-but-source-still-open — happens when the operator considers the work shipped from Grove's perspective and will close upstream separately. Neither case fights the model; both render with a small "source: closed" or "source: open" badge so the operator sees the divergence.

**Vocabulary normalization is automatic** because Grove's status is independent. We never need to map "GitHub open + iteration draft" to a Grove column. The Grove column is just the Grove column.

**Interaction with existing `tasks.status`.** Today `tasks.status` is `open / in_progress / done / cancelled`. The new lifecycle subsumes and refines it: `inbox` / `designing` / `queued` map onto the old `open`; `in_flight` / `blocked` map onto `in_progress`; `done` / `cancelled` are unchanged. We migrate existing rows by mapping `open → inbox` (operator drags into iterations later) and leaving the rest in place.

## Decision 2 — GitHub parent-issue + sub-issues IS the iteration

Don't reinvent grouping. GitHub already has parent-issue / sub-issue (and before that, checklist sub-issues). Lean on it.

- A GitHub issue tagged `iteration` is **imported once** as a Grove `iteration` row.
- That issue's sub-issues (or checklist items, normalized to issue refs) are imported as Grove `task` rows linked to the iteration.
- Iteration title, body (design notes), priority, labels — snapshotted from the parent issue at import time, then Grove-owned (per Decision 1).
- Grove holds the Grove-specific lifecycle (`inbox / designing / queued / in_flight / blocked / done / cancelled` per Decision 1), the queue position, and the bot assignments.

**No ongoing sync.** Per Decision 1 (Grove owns the lifecycle) and Decision 9 (no write-back, ever), import is a one-time event. Subsequent edits to the GitHub parent issue do not flow into Grove; Grove edits do not flow back to GitHub. The operator can manually trigger a re-import on a single iteration if the upstream changed materially and they want the Grove copy refreshed — that's an explicit operator action, not background reconciliation.

**Non-GitHub sources later.** A `source_parent_ref` column on `iteration` rows points to the umbrella entity in the source (Jira epic, Linear project, internal-spec doc id). One adapter per source converts the upstream hierarchy into the Grove iteration shape. v1 ships GitHub only.

**Iterations without an upstream parent.** Allowed — the iteration row can have `source_parent_ref = null`. This is the "internal-only" case for design work that has no upstream issue (e.g., a chore iteration the operator types straight into Grove). The kanban renders these alongside source-backed iterations; no special case in the UI.

## Decision 3 — Two new entities, one schema extension

```sql
-- New table. Lifecycle state lives here as a stored column — not derived
-- from source state (Decision 1). `imported_at` + `imported_body` capture
-- the source snapshot for audit; the live `body` column is what the
-- operator edits in Grove.
CREATE TABLE iterations (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  body                 TEXT,                       -- design notes (markdown), Grove-owned
  imported_body        TEXT,                       -- snapshot at import time (audit only, never edited)
  priority             INTEGER NOT NULL DEFAULT 2, -- P0..P3 mirrors tasks
  state                TEXT NOT NULL DEFAULT 'inbox'
    CHECK(state IN ('inbox','designing','queued','in_flight','blocked','done','cancelled')),
  source_system        TEXT,                       -- 'github' | 'jira' | 'linear' | NULL (internal)
  source_url           TEXT,                       -- display reference only after import
  source_parent_ref    TEXT,                       -- e.g., 'github:owner/repo#42' (display)
  imported_at          INTEGER,                    -- unixepoch when snapshot taken; NULL for internal-only
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_iterations_state_priority ON iterations(state, priority, updated_at DESC);

-- Schema extension on existing tasks table.
ALTER TABLE tasks ADD COLUMN iteration_id TEXT REFERENCES iterations(id);
CREATE INDEX idx_tasks_iteration ON tasks(iteration_id);
```

**Why a separate `iterations` table** rather than a self-referencing `tasks.parent_id`? Iterations have shape that tasks don't: design-notes body, distinct lifecycle states, different priority semantics (an iteration's P0 isn't directly comparable to a task's P0 because iteration P0 means "ship this iteration ASAP", task P0 means "individual task is most urgent within its iteration"). Mixing them in one table breeds nullable columns and ambiguous queries. F-8's pattern (separate table + FK) wins.

**Cardinality.** One iteration ↔ many tasks (1:N). One task ↔ at most one iteration (`iteration_id` is nullable for tasks not yet promoted to a iteration, including the legacy tasks already in `tasks` from MIG-1..6). No M:N — a task that contributes to two iterations is the operator's signal to clone, not to model nesting.

**Migration.** Existing tasks get `iteration_id = NULL`. They render in the "ungrouped" lane of the kanban (Decision 5). Operator can drag them into iterations retroactively.

## Decision 4 — Three new surfaces in the dashboard

```
┌──────────────────────────── Mission Control ────────────────────────────┐
│ [Focus] [Working] [Tasks] [Iterations]                                  │  ← new top-nav tab
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  inbox        designing      queued       in-flight    blocked    done  │
│  ─────        ─────────      ──────       ─────────    ───────    ────  │
│  [issue]      [iteration A]  [iter A]     [iter B]     [iter C]   ...   │
│  [issue]       └ task        [iter D]     ...                           │
│  [issue]       └ task                                                   │
│  ...           └ task                                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Surface 1 — Iteration kanban (`/iterations`)**.
- Six columns (Decision 1's Grove-normalized funnel).
- Cards = iterations (in `designing` / `queued` / `in-flight` / `blocked` / `done`); raw issues without an iteration = single-task cards in `inbox`.
- Drag a card from `inbox` to `designing` → creates a new iteration around that issue.
- Drag a card from `designing` to `queued` → flips iteration state from `designing` to `queued` per the D1 enum, and enqueues all tasks.
- Click a card → opens iteration detail (Surface 2).

**Surface 2 — Iteration detail (`/iterations/:id`)**.
- Iteration header: title, body (design notes, markdown editor), priority, source link.
- Task list: rows for each task in this iteration. Each row shows task title + state pill + agent chips (mirrors F-8 task table column shape).
- "Add task" affordance: pulls from the inbox lane or creates a new internal-only task.
- "Promote to queued" button: gated on iteration having ≥1 task and the operator confirming.

**Surface 3 — Iteration drill-down hook**.
- The existing F-7 drill-down (assignment-keyed) gets a header chip: "Iteration: <title>". Clicking it goes to Surface 2.
- The existing F-8 task table gets a column or pill for the iteration the task belongs to (or `—` for ungrouped).

The existing focus area / working grid / task table do **not** change behaviour — they continue to surface execution-side state. The new surfaces are additive, not replacements.

**Why not fold the kanban into the task table?** Different jobs. The task table answers "what's the state of every task right now" (operational query); the kanban answers "where in the funnel is each piece of work" (planning query). Conflating them produces a UI that does neither well — the F-9 / F-8 split already chose the same way.

## Decision 5 — Promotion path: explicit operator action, no auto-promote

`inbox → designing → queued` is always an operator-driven transition in v1. No "auto-promote when CI green", no "auto-add new GitHub issues to the queue", no "auto-create iteration when ≥3 issues share a milestone".

**Why?** The whole point of this surface is to give the operator (or the PM-agent — Decision 6) a place to think before work hits the meat grinder. Auto-promotion bypasses that thinking and reintroduces the original gap.

Auto-promote is a Phase G capability gated on the PM-agent landing.

**Movement rules:**
- `inbox → designing`: operator drags a card to the designing column. Creates iteration if none exists; or attaches to an existing iteration the operator picks from a popover.
- `designing → queued`: operator clicks "Promote" on the iteration. Iteration state flips `designing → queued` (per the D1 enum). All tasks in the iteration get a task row in `tasks` (if they don't have one already from F-12b) and enter the dispatch queue.
- `queued → in-flight`: derived. Computed when any task's assignment becomes active.
- `in-flight → blocked`: derived. Any task's assignment hits `blocked`.
- `* → done`: derived. All tasks terminal AND source closed.
- `* → cancelled`: explicit operator action — closes the source issue, cancels open assignments, archives the iteration.

## Decision 6 — PM-agent role (sketched, deferred to Phase G)

The schema and surfaces above already support a long-running PM-agent without further change. Sketch:

- A `head`-type agent with `agent_id = 'pm-agent'` (or named `Iris` etc.) and an internal-only assignment to a long-running "PM duties" task.
- Watches new issues via the existing webhook-proxy + DB. When a batch of related issues arrives (heuristic TBD), drafts a candidate iteration: groups them, sequences them, writes a first-pass design note in the iteration body.
- The drafted iteration appears in the `designing` column with a marker `proposed by Iris`. Operator approves or edits, then promotes (Decision 5).
- The PM-agent never auto-promotes to `queued`. That's the operator's gate (or a future Phase H autonomous-mode toggle).

**Why this works without schema changes**: the PM-agent's actions look like operator actions — write iteration body, set state to `designing`, attach tasks. Same writes, different actor. Audit trail comes from the existing `events` stream.

**v1 ships without the PM-agent.** Surfaces 1–3 give the operator the manual version; the PM-agent is an additive head once the surfaces stabilize.

## Decision 7 — Multi-source: GitHub in v1, others behind a small adapter

v1 ships GitHub-only. The schema (`source_system` column, generic `source_parent_ref`) already accommodates Jira / Linear / internal-only.

Each future source needs:
1. **An adapter** (`src/mission-control/sources/<system>.ts`) that normalizes upstream hierarchy → Grove iteration shape.
2. **A webhook subscription** (or polling fallback) so new issues land in the inbox.
3. **A vocabulary mapping** for the lifecycle table in Decision 1.

The kanban + iteration detail UI does not change per source. Source is a column in the iteration card metadata; otherwise the rendering is uniform.

**Explicitly out of scope for v1:** Jira API integration, Linear API integration, polling fallbacks, write-back to non-GitHub sources.

## Decision 8 — Endpoints, routes, file layout

**REST**
- `GET /api/iterations?state=...` → list iterations grouped by Grove status (powers the kanban).
- `GET /api/iterations/:id` → iteration detail (header + tasks).
- `POST /api/iterations` → create (empty or from a source ref).
- `PATCH /api/iterations/:id` → update body / priority / title / state transition.
- `POST /api/iterations/:id/tasks` → attach an existing task or create a new one in this iteration.
- `DELETE /api/iterations/:id/tasks/:taskId` → detach (does not delete the task).
- `GET /api/inbox?source=github` → upstream issues not yet linked to any iteration (powers the inbox column).

**WS**
- New event types: `iteration.created`, `iteration.updated`, `iteration.state_changed`. Same shape as existing `state.transition` events. Dashboard hooks subscribe per the MIG-2..MIG-6 pattern.

**File layout** (mirrors existing dashboard-v2 conventions)
- `src/mission-control/db/iterations.ts` — list / get / create / update.
- `src/mission-control/api/handlers.ts` — endpoint handlers.
- `src/mission-control/dashboard-v2/hooks/use-iterations.ts` — kanban data hook.
- `src/mission-control/dashboard-v2/components/iteration-board.tsx` — kanban surface.
- `src/mission-control/dashboard-v2/components/iteration-detail.tsx` — detail surface.
- `src/mission-control/dashboard-v2/lib/iteration-status.ts` — pure derivation of Grove status from (source, iteration, assignments). Tested in isolation.

## Decision 9 — Source is upstream-only. No write-back, ever.

This falls out of Decision 1: import is an event, Grove owns the lifecycle. Once an issue is in Grove, edits to title / body / priority / state happen in Grove and stay in Grove. We never push back to GitHub (or any future source).

**v1 behaviour:**
- Iteration body / title / priority editable in Grove. All writes land in the Grove DB only.
- Source URL stays on the iteration card as a clickable display reference + open/closed badge (Decision 1).
- The original imported body is preserved as a snapshot column for audit; Grove's edits live in the regular body column.
- No write-back surface, no permission expansion on the grove-bot, no last-write-wins drift to design around.

Operators who want to update the upstream issue (close it, edit the title there) do that through GitHub directly. Grove is the operator's planning surface; the upstream is the audit trail for non-operator stakeholders. The two intentionally diverge once import has happened.

**Why this is a feature, not a limitation.** It means a multi-operator team can adopt Grove without negotiating "who's allowed to write to GitHub on behalf of the team." It means future sources (Jira, Linear) need only an import adapter, never a write adapter. It means the security surface area on the grove-bot stays exactly as small as it is today.

If a write-back path is ever genuinely needed (e.g., closing GitHub issues automatically when a Grove iteration completes), it lands as an explicit additive Phase H feature with its own threat model — it does not retrofit into v1.

## Decision 10 — Open questions to pin before code

1. **Iteration completion criterion.** Is iteration `done` strictly "all tasks terminal AND source closed", or allow operator-driven `done` with open tasks (e.g., "shipped enough; remaining tasks become a follow-up iteration")? **Lean: derived only in v1; manual override is Phase G.**
2. **Drag-and-drop library.** No external dep currently. Native HTML5 drag-and-drop is awkward but works; alternatives (`@dnd-kit/core`) add ~30KB. **Lean: native HTML5 in v1; revisit if the UX is poor.**
3. **Inbox cap.** Streaming all GitHub issues from all repos could surface hundreds. Cap at N (e.g. 100), most recent first, with a "load older" button? **Lean: 100, server-side, mirrors F-8's `TASKS_QUERY_LIMIT`.**
4. **Iteration sort within a kanban column.** Priority ASC → updated_at DESC (mirrors F-8 default)? Operator can re-sort? **Lean: priority + updated_at, server-side, no client re-sort in v1.**
5. **Cross-iteration task dependencies.** Iteration A's task X depends on iteration B's task Y. Modelled? **Lean: no dependencies in v1; operator sequences via column ordering. Phase G.**
6. **GitHub label conventions.** `iteration` label is required for parent-issue detection? Or any issue with sub-issues? **Lean: explicit label `iteration` (or configurable per-repo); avoids accidental promotion of unrelated parent issues.**
7. **Per-repo scope.** Does the iteration board show all repos in the network, or one at a time? **Lean: one at a time, with a repo selector. All-repos view is Phase G.**
8. **Operator-as-user.** PM-agent action audit trail — does the events stream distinguish "operator wrote the body" from "PM-agent wrote the body"? **Lean: yes, `actor` field on iteration events.**

## Acceptance criteria

- [ ] `iterations` table + `tasks.iteration_id` extension + migration shipped.
- [ ] `GET /api/iterations` and `GET /api/inbox` return Grove-normalized status per Decision 1.
- [ ] Pure `iteration-status.ts` transition-validator function (Grove-only state machine, no source inputs) with ≥20 unit tests covering every (current state × proposed transition) cell. Source state is never an input.
- [ ] Iteration kanban renders six columns; drag from inbox → designing → queued works.
- [ ] Iteration detail surface: editable body, task list, "Promote to queued" button.
- [ ] WS `iteration.*` events trigger debounced kanban refresh.
- [ ] F-7 drill-down header gains an iteration chip; F-8 task table optionally surfaces iteration column.
- [ ] No write-back to GitHub (read-only baseline + Grove overlay).
- [ ] Documentation: `iteration-planning` SOP added to `compass/sops/`; `docs/iteration-mc-iteration-planning.md` tracker for the multi-PR roll-out (mirrors `iteration-mission-control.md`).

## Where this goes

**Phase F — Iteration planning surface.** Post-MIG-6.

Suggested PR sequence (each ≈ 600–1000 lines net):
1. **F-13 schema + endpoints** — `iterations` table, `tasks.iteration_id`, `GET /api/iterations`, `GET /api/inbox`, derived-status view, `iteration-status.ts` lib + tests.
2. **F-14 iteration kanban** — `iteration-board.tsx` + `use-iterations.ts` + dragging.
3. **F-15 iteration detail** — `iteration-detail.tsx` + body editor + promote action.
4. **F-16 cross-surface integration** — F-7 drill-down chip, F-8 task table iteration column, navigation.
5. **F-17 GitHub parent-issue ingestion** — webhook handler that auto-creates iteration rows from GitHub `iteration`-labelled parent issues + sub-issues.

Phase G (post-Phase-F):
- PM-agent role (Decision 6).
- Write-back to GitHub (Decision 9).
- Auto-promotion (Decision 5).
- Multi-source adapters (Jira / Linear).
- Operator-driven `done` override (Decision 10 Q1).

## Forward links to add when this lands

- `docs/design-mission-control.md` §3 ("The task funnel") — add a paragraph forward-linking to this doc and naming Phase F.
- `docs/iteration-mission-control.md` (the post-MIG-6 tracker) — add a Phase F section pointing here.
- `compass/sops/design-process.md` — note iteration-planning as the next standard surface for any cross-iteration work.
