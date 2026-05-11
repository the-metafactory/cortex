# Mission Control v2 — Iteration plan

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-mission-control.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status tracker for `docs/design-mission-control.md`.**
Updated: 2026-04-24. Edit in place as features ship; mirror status on GitHub issue [#2](https://github.com/the-metafactory/grove-v2/issues/2).

This doc maps the design spec's Phase A–E to concrete features, SpecFlow IDs,
and shipped PRs. It is the operator/agent view of "what's done, what's next".
When a box ticks here, tick it on the GitHub tracking issue too.

---

## Phase A — Data foundation + local bot scaffold

**Goal (from §9 of the design spec):** self-contained `src/mission-control/`
module running on `localhost:8767` with HTTP + WebSocket + SQLite. Schema, state
machine, session endpoint resolver, event ingestion, WS server.

- [x] **F-1** — Bot scaffold + SQLite schema (tasks, assignments, agents, sessions, events) — `41be1b5`
- [x] **F-2** — Assignment state machine + `operator.input` / `permission.request` events — `cc43727`
- [x] **F-3** — Session endpoint resolver (`local.process.controlled` + `local.observed`) — `680059a`
- [x] **F-4** — Hook-stream reader for observed sessions (cursor-based) — `46b7a16`
- [x] **F-5** — WebSocket server at `:8767/ws` — `56adeec`
- [x] REST endpoints — `GET /api/assignments`, `POST /api/sessions`, `POST /api/assignments/:id/input` — PR #1 (`10a89da`)
- [x] Minimal dashboard HTML served at `/` (placeholder — real Phase B layout is F-6…F-9) — PR #1

**Phase A is complete.** The endpoint resolver ships the `{ kind, write, close }`
interface per §9. Reading CC stdout for controlled sessions is a Phase B
concern — see `notifications.ts` "Phase B dispatcher after applyTransition"
note — and is tracked as F-13 under Phase B below.

## Phase B — Dashboard attention core

**Goal:** replace the PR #1 placeholder with the designed attention-first layout,
and wire the dispatcher that reads CC stdout for controlled sessions into events + WS broadcast.

- [x] **F-13** — Controlled-session dispatcher: stdout stream-json parser → events table + `broadcastEvent` + terminal-event state transition (§6.1 Transport, notifications.ts "Phase B dispatcher" note) — PR #5 (`6c92de2`)
- [x] **F-6** — Focus area "who needs me" (§8.2) — PR #8 (`3ea1ec8`)
- [x] **F-7** — Attention view rendering — three-section, D/A/H colour classification, miner-borrowed (§5, §5.4) — PR #11 (`2559e75`)
- [x] **F-8** — Task table, sortable + filterable (§8.4) — PR #13 (`a333331`)
- [x] **F-9** — Working-agent grid below focus area (§8.3) — PR #15 (`bdbc21a`)

**Phase B is complete.** The dashboard now implements the full §8.1 layout: focus area, working-agent grid, task table, attention drill-down.

## Phase C — Operator input return

**Goal:** turn the cockpit from a monitor into a console.

- [x] Transport — write-to-session via endpoint resolver (covered by F-3 + PR #1)
- [x] **F-10** — Text input affordance in the F-7 drill-down + `executionQueue` (§5.1 ③, §6.3) — PR #17 (`d0fbb84`)
- [x] Image/screenshot paste + drag-drop (§6.2) — design addendum `docs/design-mc-image-input.md` — PR #21
- [ ] Operator audit-log aggregation (§6.4) — already implicit via `operator.input` events and F-7/F-8 views; dedicated cross-operator view deferred post-Phase-B

## Phase D — Discord notifications

- [x] **F-11** — Hardcoded priority map + DM + channel post on state change + deep links back to focus area — PR #23 (`3bad23d`); addendum `docs/design-mc-f11-discord-notifications.md`

**Phase D is shipped.** Default off (`grove.notifications.discord=false`); operator opts in via `bot.yaml`. 401 tests, FlushScheduler injection, per-channel coalescing.

## Phase E — Task curation UX

- [x] **F-12** — Manual dispatch, requeue, abandon, hand-off — PR #30 (`07a7cba`); addendum `docs/design-mc-f12-task-curation.md`
- [x] **F-12b** — "Add to queue" from GitHub issue — PR #31 (`4093d57`); addendum `docs/design-mc-f12b-add-to-queue.md`

**Phase E is shipped.** Four-verb curation toolbar + add-to-queue from GitHub issue both live in the legacy F-7 drill-down. Decision 11 `state.transition` observer kills zombie subprocesses. `task-shadow-{taskId}` synthetic-session pattern wired for empty-assignment tasks. 520 tests on F-12b head; XSS-fix sweep + body-validation tightening landed in #31's sweep round. Pre-existing flake in `curation-process-kill.test.ts` ("Abandon on running closes live process") tracked as a follow-up de-flake chore — not introduced by these PRs.

## Dashboard React migration (architectural, cross-cuts all phases)

Revised 2026-04-25: drill-down port folds V4 Session Context into MIG-3 so the drill-down ships CC-session-parity from day one; MIG-6 (standalone F-10/image port) merged into MIG-3; final cutover is now MIG-6.

- [x] **MIG-1** — Scaffold + shared primitives + `/v2` route — PR #26 (`9235eab`)
- [x] **MIG-2** — Port F-6 focus area — PR #29 (`d652977`)
- [x] **MIG-3** — V4-flavoured drill-down (F-7 overlay + F-10 input + image + plan/progress pane + artefact chips + canned actions + focus mode) — PR #34 (`c284edd`)
- [x] **MIG-4** — Port F-8 task table (incl. F-12 curation toolbar + F-12b `+ Add task` button + modal in React) — PR #36 (`91fd840`)
- [x] **MIG-5** — Port F-9 working-agent grid — PR #37 (`424d43e`)
- [x] **MIG-6** — Cutover: delete monolith, swap `/v2` → `/` — this PR

---

## Current position

**Last updated:** 2026-04-26 (after MIG-4 + MIG-5 + MIG-6 cutover round).
**Master HEAD:** this PR — MIG-6 cutover (legacy monolith deleted, React app at `/`).

**Phase status:**

| Phase | Status | Notes |
|---|---|---|
| A — Data foundation + bot scaffold | ✅ complete | F-1…F-5 + REST + WS shipped via PR #1, #5 |
| B — Dashboard attention core | ✅ complete | F-6 / F-7 / F-8 / F-9 / F-10 + image-input + server-side caps shipped |
| C — Operator input return | ✅ shipped | F-10 + image-input on main |
| D — Discord notifications | ✅ shipped (off by default) | F-11 via PR #23 (`3bad23d`) |
| E — Task curation UX | ✅ shipped | F-12 via PR #30 (`07a7cba`) + F-12b via PR #31 (`4093d57`); curation toolbar + add-to-queue ported to React in MIG-4 |
| Dashboard React migration | ✅ complete | All six MIGs landed; legacy monolith deleted; React app at `/` |

**Critical-path next items:** none — Phase B + the React migration are both done.

**Parallel slots (per recall rule 12):**

- **Slot A** (code, dashboard-v2 React): empty — migration complete.
- **Slot B** (legacy implementations): empty — `dashboard/index.html` deleted in MIG-6.
- **Slot C** (docs, follow-up addenda): empty by default.

**Open chore candidates (off the critical path):**

- Backfill jsdom + `@testing-library/react` to add hook + component tests in `dashboard-v2/__tests__/` — flagged as deferred across MIG-1..MIG-6 sweeps; addendum's Decision 8 says post-migration. Now unblocked.
- Tracker rename: `iteration-mission-control.md` → `iteration-dashboard.md` once Phase F kicks off (the v2 cutover supersedes the React-migration framing).

**Gate honesty (recall rule 5):** no gates currently outstanding.

## Sync rule

Iteration plans live in two places:
- This file (`docs/iteration-mission-control.md`) — the repo artifact.
- The GitHub tracking issue — commentable, mobile-friendly.

When a checkbox is completed here, tick it on the tracking issue. When the
tracking issue comment thread reaches a decision, fold the outcome back here.
