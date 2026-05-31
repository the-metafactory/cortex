# Iteration plan — F-19 Dispatch + F-20 Observe (principal loop closure)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-mc-dispatch-observe.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

Mirrors the umbrella GH issue. Specs: `docs/design-mc-f19-dispatch.md`, `docs/design-mc-f20-observe.md`.

This pair of features closes the principal loop end-to-end on a single machine: F-19 makes the dispatch primitive operable from the dashboard (Maestro pattern, controlled subprocess); F-20 makes terminal-launched `cldyo-live` sessions visible in the dashboard (read-only, observed kind).

## F-19 — Dispatch from task table / iteration kanban (PR 1)

Backend: small in-memory debounce in `handleCreateSession` (~15 lines).
Frontend: row-level Dispatch button + confirmation popover + optimistic state + WS-driven refresh.

- [ ] F-19.A — `dashboard-v2/components/dispatch-button.tsx` + `.css` + popover
- [ ] F-19.B — Wire button into `task-table.tsx` row actions; gate visibility on `aggregate_state === null`
- [ ] F-19.C — Wire button into iteration kanban card (`iteration-board.tsx`) for tasks attached to in-flight iterations
- [ ] F-19.D — Optimistic-UI flip + rollback on 4xx/5xx + toast surfacing
- [ ] F-19.E — Backend: 2-second `(taskId, agentId)` debounce in `handleCreateSession` returning 409 with the existing assignment id (per Echo PR #54 review — caps token cost of cross-tab parallel dispatch)
- [ ] F-19.F — Tests: button render gate, click → POST shape, optimistic flip, rollback path, debounce 409 path
- [ ] F-19.G — Manual smoke: dispatch a task locally, watch working grid populate

## F-20 — Observe `cldyo-live` sessions (PR 2)

Wrapper: register-then-spawn flow.
Backend: `POST /api/sessions` learns `kind: 'local.observed'` branch.
Ingestor: `dispatched → running` auto-transition on first observed event.
Frontend: `observed` badge on agent cards + drill-down input gate.

- [ ] F-20.A — `POST /api/sessions` `kind` parameter — branch on controlled vs observed; observed path inserts session row directly without `Bun.spawn`
- [ ] F-20.B — UUID validation + `cc_session_id` uniqueness check
- [ ] F-20.C — Ingestor: auto-transition `dispatched → running` on first event for an observed session
- [ ] F-20.C2 — Ingestor: auto-transition `running → completed` on `Stop` / `SessionEnd` hook event for an observed session (bounds cycle time so F-18 metrics don't skew — per Echo's PR #54 review)
- [ ] F-20.D — `src/cli/cldyo-live` — POST registration before exec (jq-based body to avoid shell-quote injection), pass `--session-id <uuid>` to claude
- [ ] F-20.E — Working grid + focus area: render `observed` badge from `endpoint_kind`
- [ ] F-20.F — Drill-down input gate + rationale message for observed sessions
- [ ] F-20.G — Tests: POST observed shape, ingestor `dispatched → running` and `running → completed` auto-transitions, badge render
- [ ] F-20.H — Manual smoke: `cldyo-live grove`, watch the dashboard show an observed session that transitions to `completed` when the terminal exits

## Deferred (file as separate issues post-merge)

### F-19 follow-ups
- F-19.1 — Principal agent picker (replaces default-agent with a dropdown)
- F-19.2 — Dispatch with custom prompt (one-line principal focus before confirm)
- F-19.3 — Bulk dispatch from kanban column
- F-19.4 — Re-dispatch on terminal-state task

### F-20 follow-ups
- F-20.1 — Resume an observed session on `cldyo-live` re-launch
- F-20.2 — Principal re-classify (mark `completed` observed session as `cancelled` after the fact — principal distinguishes finished from abandoned)
- F-20.3 — Stale-observed-session sweeper based on PID liveness (belt-and-braces fallback for lost hook events)
- F-20.4 — Backfill registration for already-running terminal sessions

## Acceptance — what success looks like

After both PRs merge and MC v2 restarts on the new build:

1. Open http://localhost:8767/, see an empty dashboard with a curated task on the table (or run F-12b "add from GitHub").
2. Click `Dispatch` on a task row. Confirm popover. Watch:
   - Row's State column flips to `queued → dispatched → running`
   - Working grid shows the agent
   - Drill into the agent → see real CC events streaming in
3. Open a terminal in another window, run `cldyo-live grove "test"`. Watch:
   - Working grid shows a second agent card with an `observed` badge
   - Drill into it → see the terminal's events in the log
   - Input textarea is hidden / shows the "owned by terminal" rationale
4. F-18 metrics tab shows non-zero numbers as work flows through both surfaces.

This is the spec's §2 principal loop, fully operable for the first time.
