# HITL Dashboard & PR Review — Iteration Plan (G-900 Series)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-hitl-pr-review.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan tracks the HITL dashboard and PR review integration work. Features are ordered by dependency, not timeboxed.

**Mission:** Humans supervise agent work by exception. PRs get AI-narrated reviews. The dashboard becomes an inbox, not a monitoring wall.
**Scope:** Inbox view, ai-pr-review integration, approval gates, notification tiers, OSS attribution
**Design Spec:** `docs/design-hitl-pr-review.md`
**Research:** `docs/research-hitl-design.md`, `docs/research-hitl-orchestration.md`, `docs/research-hitl-vibe-kanban.md`, `docs/research-hitl-council-debate.md`
**Tracking Issue:** [#130](https://github.com/the-metafactory/grove/issues/130)
**Depends on:** [#128](https://github.com/the-metafactory/grove/issues/128) — Dashboard refactor (DX-001) ✅ merged as v0.17.0
**Cross-repo deps:** grove-auth Phase 1 (roles + ownership for write endpoints), grove-auth Phase 2 (PassKey step-up for agent actions), spawn Phase 5 (dashboard → spawn dispatch)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Phase 0 — Legal Hygiene

### G-904: Open Source Attribution

- [x] Create `THIRD-PARTY-NOTICES.md` at repo root with ai-pr-review MIT license text
- [x] Add "Open Source Licenses" link to dashboard footer
- [x] Document attribution approach in CLAUDE.md or contributing guide
- [x] Verify ai-pr-review LICENSE file content (currently 404 on GitHub — contact author or use README declaration)

### Acceptance (Phase 0)

- [x] THIRD-PARTY-NOTICES.md exists and includes ai-pr-review with MIT license text
- [x] Dashboard footer shows attribution link

---

## Phase 1 — Core Decision Surface

### G-900: Dashboard Inbox View

#### Data Model

- [ ] Create `inbox_items` table in D1 schema (id, type, priority, title, description, agent_name, entity_ref, status, created_at, actioned_at, metadata)
- [ ] Add D1 migration for inbox_items table
- [ ] Apply schema to D1 database

#### API Endpoints (Cloud Worker)

- [ ] `GET /api/inbox` — list pending inbox items, sorted by priority then recency
- [ ] `POST /api/inbox/:id/action` — approve, reject, dismiss an item
- [ ] `GET /api/inbox/count` — return count of pending items (for badge)
- [ ] `POST /api/inbox` — create inbox item (used by event handlers internally)

#### Inbox Population from Existing Events

- [ ] GitHub PR `ready_for_review` webhook → creates P1 inbox item (type: `pr_review`)
- [ ] GitHub `check_suite` failure webhook → creates P0 inbox item (type: `pr_failure`)
- [ ] Agent session error → creates P0 inbox item (type: `session_failure`)
- [ ] Agent session completion → creates P2 inbox item (type: `completion`, batched)

#### Dashboard UI

- [ ] Add "Inbox" nav tab to dashboard (alongside Agents, Activity, Repos, Tech Tree)
- [ ] Inbox badge showing pending count on nav tab
- [ ] Inbox item list with priority indicators (red P0, yellow P1, green P2)
- [ ] Item cards: agent name, entity ref, title, description, time ago, action buttons
- [ ] P0 items: "View Logs" + "View PR" actions
- [ ] P1 items: "View PR Review" + "Approve" + "Request Changes" actions
- [ ] P2 items: "Dismiss" + "View Activity" actions
- [ ] Empty state: "All clear — no items need attention" with checkmark
- [ ] Auto-refresh inbox on WebSocket event or polling interval
- [ ] Mobile-responsive inbox layout

#### Acceptance (G-900)

- [ ] Inbox view shows pending items sorted by priority
- [ ] Actions (approve, reject, dismiss) update item status
- [ ] Badge count reflects pending items
- [ ] Empty inbox shows "all clear" state
- [ ] PR webhook events populate inbox automatically

---

### G-901: AI PR Review Integration

#### 🔵 Investigation Phase

- [ ] Install `diff2html` npm package, verify it works with Bun build
- [ ] Test GitHub API diff endpoint: `GET /repos/:owner/:repo/pulls/:number` with `Accept: application/vnd.github.diff`
- [ ] Prototype Claude structured review generation prompt, evaluate output quality on a real Grove PR
- [ ] Measure review JSON size (will inform storage: D1 text column vs R2 blob)
- [ ] Determine Claude model/cost for review generation (haiku for speed? sonnet for quality?)

#### New Worker Endpoints

- [ ] `GET /api/repos/:name/pulls/:number/diff` — fetches PR diff from GitHub API, returns raw diff text
- [ ] `POST /api/repos/:name/pulls/:number/ai-review` — generates structured review JSON via Claude
- [ ] `GET /api/repos/:name/pulls/:number/ai-review` — returns cached review JSON if exists
- [ ] `POST /api/repos/:name/pulls/:number/review` — submits GitHub PR review (approve/request-changes)
- [ ] Store generated review JSON in D1 `pr_reviews` table
- [ ] Wire GitHub `pull_request.opened` / `ready_for_review` webhook to auto-generate review
- [ ] Handle review staleness: re-generate on `push` to open PR branch

#### Dashboard Integration (Native React)

- [ ] Add tabbed layout to PRDetailView: Overview | Changes | AI Review | Comments
- [ ] **Changes tab**: fetch PR diff via new Worker endpoint, render with `diff2html`
- [ ] Side-by-side and unified diff toggle
- [ ] File tree sidebar with changed files and +/- line counts
- [ ] **AI Review tab**: render structured review sections as collapsible React cards
- [ ] Importance indicators: critical (red), important (yellow), supporting (blue), context (gray)
- [ ] Each section has: title, narrative, code references (clickable → Changes tab)
- [ ] Loading state while review generates
- [ ] "Review not yet generated" state with manual trigger button
- [ ] "Stale review — regenerate?" prompt when review is outdated
- [ ] **Approve/Request Changes** buttons on PR detail view
- [ ] Approve: one-click, calls `POST /api/repos/:name/pulls/:number/review`
- [ ] Request Changes: shows text input for reason, then calls same endpoint

#### Acceptance (G-901)

- [ ] PR detail view has tabbed layout with all 4 tabs
- [ ] Changes tab shows syntax-highlighted diffs
- [ ] AI Review tab shows structured narrative sections with importance levels
- [ ] Review auto-generates on PR webhook events
- [ ] Stale reviews are flagged and can be regenerated
- [ ] Approve/Request Changes actions work from dashboard

---

## Phase 2 — Push Model

### G-903: Notification Tiers

#### Event Urgency Classification

- [ ] Define urgency enum: `critical`, `review`, `ambient`
- [ ] Add urgency field to inbox item creation logic
- [ ] Map existing event types to urgency tiers:
  - `critical`: session failure, PR check failure, approval gate (critical)
  - `review`: PR ready for review, approval gate (review)
  - `ambient`: session completed, phase transitions

#### Discord Notification Routing

- [ ] On P0 inbox item creation → post to operator DM (if configured) or channel
- [ ] On P1 inbox item creation → post to relevant channel thread
- [ ] On P2 inbox item creation → no Discord notification
- [ ] Notification format: emoji + agent name + summary + dashboard link
- [ ] De-duplicate: don't re-notify if item already notified

#### Configuration

- [ ] Add `notifications` section to `bot.yaml` schema
- [ ] Configurable: which urgency tiers go to DM vs channel vs silent
- [ ] 💪 Quiet hours: suppress non-critical during configured hours
- [ ] 💪 Voice notification for critical items (via localhost:8888)

#### Acceptance (G-903)

- [ ] Critical events produce Discord DM to operator
- [ ] Review events produce Discord channel notification
- [ ] Ambient events are dashboard-only
- [ ] Notification config in bot.yaml is respected

---

### G-902: Approval Gates via Dashboard + Discord

#### Event Schema

- [ ] Define `agent.approval.requested` event type
- [ ] Define `agent.approval.resolved` event type
- [ ] Add approval events to relay allow list
- [ ] Document event schema for agent producers

#### Approval Flow — Dashboard Side

- [ ] Approval request event → creates P1 inbox item (type: `approval`)
- [ ] Inbox card shows: gate title, description, context, approve/reject buttons
- [ ] Approve action → emits `agent.approval.resolved` with `approved` status
- [ ] Reject action → shows reason input → emits `agent.approval.resolved` with `rejected` status + reason

#### Approval Flow — Discord Side

- [ ] Approval request → Discord message with approve/reject reactions
- [ ] Operator reacts → grove-bot captures reaction → resolves approval
- [ ] 💪 Operator replies with text → captured as rejection reason

#### Agent Resolution Endpoint

- [ ] `GET /api/approvals/:session_id` — returns pending/approved/rejected status
- [ ] Agent sessions poll this endpoint (or receive via grove-bot injection)
- [ ] Timeout handling: configurable, default = wait indefinitely

#### Acceptance (G-902)

- [ ] Agent can request approval via event emission
- [ ] Approval appears on dashboard inbox AND Discord
- [ ] Human can approve/reject from either surface
- [ ] Agent session receives the resolution
- [ ] Rejection includes reason text

---

## Phase 3 — Stretch Goals

- [ ] 💪 Dashboard sound/chime on P0 item arrival
- [ ] 💪 Batch approve: select multiple P2 items → dismiss all
- [ ] 💪 Inbox SLA tracking: how long items waited before action
- [ ] 💪 Inbox history view: past actioned items with timestamps
- [ ] 💪 ai-pr-review postMessage bridge for in-iframe actions
- [ ] 💪 Review comparison: show delta between two review generations
- [ ] 💪 Mobile push notifications via web push API

---

## Exit Criteria

The iteration is complete when:

- G-904 merged (attribution in place before any ai-pr-review code ships)
- G-900 inbox view functional with PR webhooks populating items
- G-901 AI PR review renders in dashboard iframe for at least one real PR
- G-903 critical events produce Discord notifications
- G-902 approval round-trip works (request → inbox → action → resolution)
- No regressions in existing dashboard, Discord, or cloud API functionality
