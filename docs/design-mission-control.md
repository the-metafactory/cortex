# Grove Mission Control — v2

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mission-control.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** Design spec. Replaces the prior `design-mission-control.md` and supersedes `research-2026-04-12-mission-control-synthesis.md`.
**Date:** 2026-04-15
**Driver:** Andreas
**Sprint artifacts:** `Plans/design-sprint-mc/00-plan.md` … `03-decisions.md`
**Related docs:** `docs/design-spawn-integration.md` — preserved spawn-backed execution design, on ice until Spawn is ready.

This document is the single source of truth for Grove Mission Control. Every claim in it traces back to either one of Andreas's 8 concerns or a cross-doc conflict resolution in `03-decisions.md`.

---

## 1. Goal and non-goals

### 1.1 Goal

Grove Mission Control is **the operator's cockpit for running many agents against a curated backlog**. One operator, many agents, many tasks, one dashboard. The core job of the dashboard is: **surface the agent that needs the operator right now, and let the operator unblock it without leaving the UI.**

Three properties follow from that job:

1. **Visibility.** The operator can see, at a glance, which agents need attention and which are making progress on their own.
2. **Drill-down.** Any attention item opens into a rich view of the agent's current task: summary, time-descending event log, input affordance.
3. **Action return.** The operator can respond from the UI — text and screenshot — and the agent continues. The operator never has to drop into the terminal to unblock an agent.

Beyond the visible cockpit, mission control is also:

- **A task funnel.** Source backlogs (GitHub issues, PRs, future Jira tickets) are upstream of a curated internal queue. Not every issue becomes agent work; the operator decides what enters the queue.
- **A notification system.** When something exceptional happens outside the operator's current view, Discord gets pinged with a deep link back into the dashboard.
- **A local-first service that is ready to become multi-operator.** v1 ships single-operator Tier 1 (local Bun + SQLite). The data model and access patterns are built so Tier 2 (cloud CF Worker + D1, multi-operator) is a runtime change, not a redesign.

### 1.2 Non-goals for v2

- **Multi-operator runtime.** v1 is single-operator. Schema and access paths must not preclude Tier 2 multi-operator, but the runtime is single-operator only (Concern 2 Q2.2, Concern 5 Q5.5).
- **Spawn-backed execution.** v1 uses local `Bun.spawn` at Tier 1. Spawn (the metafactory execution engine) is not ready; its integration design is preserved in `docs/design-spawn-integration.md` and will be re-integrated once Spawn ships.
- **Phone push notifications.** Tier 2 only (Concern 1 Q1.1).
- **OS desktop notifications.** Future capability once event-back-in automations ship (Concern 1 Q1.1).
- **TaskSource abstraction.** No pluggable interface in v2 — one concrete GitHub path via `sourceRef` (Conflict 4).
- **Classifier service / notification router service.** Hardcoded ~10-line priority map in grove-bot (Concern 1 Q1.2, Conflict 1).
- **Stale-task sweepers, retry budgets, DLQ.** No background reconciliation. Operator has manual move-along controls (Concern 2 Q2.5).
- **LAN device hopping (reading Discord on phone/tablet at Tier 1).** Not supported; Tier 1 is local-desktop only (Concern 8 Q8.2, Q8.3).
- **Pets/cattle vocabulary.** Dropped. Replaced by head/hands (Conflict 5).
- **Luna as privileged orchestrator.** The operator is the orchestrator; Luna is one agent instance (Conflict 6).

---

## 2. Core operator flow

The dashboard is designed around one loop. Everything else serves it.

```
┌──────────────────────────────────────────────────────────────────┐
│  1. Operator opens Grove dashboard                               │
│     ↓                                                            │
│  2. Focus area: "who needs me right now"                         │
│     ↓  (or Discord ping with deep link back into the dashboard)  │
│  3. Operator clicks an attention card                            │
│     ↓                                                            │
│  4. Attention view opens:                                        │
│        ├─ Summary header  (which agent, which task, state)      │
│        ├─ Event log       (time-descending, rich, scrollable)   │
│        └─ Input affordance (text + screenshot)                   │
│     ↓                                                            │
│  5. Operator types / pastes response                             │
│     ↓                                                            │
│  6. Input is delivered to the agent's session (queued if busy)   │
│     ↓                                                            │
│  7. Agent continues; event log updates live                      │
│     ↓                                                            │
│  8. Attention card clears when the agent moves on                │
└──────────────────────────────────────────────────────────────────┘
```

The critical primitive: **the attention view is scoped to one `agent_task_assignment` row** — the link between an agent (head) and a task. "Something needs my attention" is never "an agent needs me in the abstract" and never "a task needs me in the abstract." It is always "this agent, on this task, in this state." (Concern 4 framing, Concern 2 Q2.1/Q2.4.)

Three concrete examples of the loop, covering the common block shapes:

- **Error.** Luna is running on task T-42 ("fix webhook HMAC verification"); a bash tool call fails. Assignment transitions `running → blocked` with `block_reason = { kind: 'tool.error', tool_name: 'tool.bash', message: 'permission denied', exit_code: 1 }`. Dashboard attention card for the Luna×T-42 assignment appears; Discord pings the operator. Operator clicks the card, sees the failed bash in the event log, types "try running it in the src/worker dir", submits. Assignment returns to `running`; card clears.
- **Permission request.** An implementer agent running in default-permission CC mode on task T-17 ("refactor dashboard state hook") wants to edit `src/dashboard/use-grove-api.ts`. Assignment transitions `running → blocked` with `block_reason = { kind: 'permission.request', requested_action: 'tool.edit', target: 'src/dashboard/use-grove-api.ts', risk_hint: 'medium' }`. Dashboard attention card surfaces the exact edit target; Discord pings. Operator clicks card, sees the proposed edit inline, presses **Approve**. Assignment resumes; card clears.
- **Review checkpoint.** An ephemeral implementer agent on task T-51 ("bump grove-bot to v0.23.0") has prepared a release draft and needs human sign-off that is not a CC permission prompt but a task-level gate the agent asked for. Assignment is `blocked` with `block_reason = { kind: 'review.checkpoint', note: 'release draft ready' }`. Operator opens the card, reads the release draft in the event log, pastes a screenshot of the changelog with a checkmark, types "approved, ship it", submits. Assignment goes `running`; agent merges; card clears.

All three go through the same primitive: **assignment state change → attention item appears → drill-down shows context → operator action (input or approve/deny) → assignment state change.**

---

## 3. The task funnel

The task is the vessel for all orchestration in Grove. Everything else hangs off it.

### 3.1 What a task is

A task is a **first-class Grove object that references a source system** (Concern 2 framing, Concern 3 framing). Grove's orchestration history — the queue, the state machine, the sessions, the events — lives against the Grove task row. The source system (GitHub issue, PR, future Jira) is authoritative for its own state, but is not where Grove tracks orchestration.

### 3.2 Task schema

```
tasks
  id                     TEXT PRIMARY KEY          -- Grove-internal ID
  title                  TEXT NOT NULL
  description            TEXT
  priority               INTEGER NOT NULL          -- P0..P3 (Concern 7 Q7.4 — NEW)
  operator_id            TEXT                      -- nullable Tier 1, required Tier 2 (Q2.2)
  source_system          TEXT NOT NULL             -- 'github' | 'internal'
  source_url             TEXT                      -- canonical URL, nullable
  source_external_id     TEXT                      -- issue number / PR number, nullable
  related_refs_json      TEXT                      -- JSON array of {system, url, external_id} triples — display only (Q3.3)
  created_at             INTEGER NOT NULL
  updated_at             INTEGER NOT NULL
```

The `source_system`/`source_url`/`source_external_id` triple is the flat three-field `sourceRef` from Concern 3 Q3.1 — no nesting, no abstraction. Throughout this doc, "sourceRef" is the conceptual name for the triple; the physical columns are always the three separately named fields above. `related_refs_json` holds additional display-only refs (e.g., the PR that closes the issue) as a JSON array of the same three-field shape.

**Reuse of existing grove schema.** Grove already tracks GitHub entities via `repos`, `issues`, `pull_requests`, and `github_events` in `src/worker/schema.sql`, updated by the webhook-proxy → grove-api pipeline. The task row does **not** duplicate issue or PR data — it joins to the existing tables via `source_external_id` for display (Concern 3 Q3.2, Conflict 4). No new reconciler is introduced.

### 3.3 Assignment schema

```
agent_task_assignment
  id                     TEXT PRIMARY KEY
  task_id                TEXT NOT NULL  → tasks.id
  agent_id               TEXT NOT NULL  → agents.id
  state                  TEXT NOT NULL  -- queued | dispatched | running | blocked | completed | failed
  block_reason           TEXT           -- structured JSON when state=blocked
  operator_id            TEXT           -- same nullable→required pattern
  dispatched_at          INTEGER
  completed_at           INTEGER
  created_at             INTEGER NOT NULL
  updated_at             INTEGER NOT NULL
```

Agent ↔ task is **many-to-many** (Concern 2 Q2.4). An agent can have assignments on multiple tasks; a task can have assignments from multiple agents (e.g., one analysing, one implementing). **The state machine lives on the assignment row, not on the task and not on the agent.**

```
agents ───┐                   ┌─── tasks
          │                   │
          └─► agent_task_assignment ◄─┘   (state machine here)
                      │
                      └─► sessions (0..N per assignment)
```

`sessions` is the existing grove session record (`src/bot/lib/session-manager.ts`, per-thread Claude Code session). A session now points up to an assignment rather than floating. Session lifecycle events mutate assignment state; they do not mutate task state directly.

**State machine:**

```
queued ──dispatch──▶ dispatched ──start──▶ running ──block──▶ blocked
                                              │
                                              ├── complete ──▶ completed  (terminal)
                                              │
                                              └── fail ─────▶ failed
```

Transitions not drawn in the diagram (to keep it readable):

- `blocked ──resume──▶ running` — the agent's block clears (tool call approved, error recovered, review checkpoint satisfied) and it continues.
- `blocked ──operator_requeue──▶ queued` — the operator escape hatch from a stuck-blocked assignment (Concern 2 Q2.5).
- `failed ──operator_requeue──▶ queued` — the operator retry escape hatch from a terminal-failed assignment.

`completed` is terminal; there is no `operator_requeue` out of it (a re-run creates a new assignment row). `operator_requeue` is the only manual move-along in the model — there are no automatic timers. The operator is the only non-agent actor who can pull an assignment out of a stuck state.

### 3.4 The funnel

```
source backlogs              curated queue            dispatch              work
────────────────────         ──────────────           ─────────────         ────────
GitHub issues      ─┐        tasks                   agent_task_           sessions
GitHub PRs          ├──▶     (operator curated)──▶   assignment       ──▶  (CC runs)
internal notes     ─┘        priority-ordered        state machine
future: Jira etc.                                    link table
```

**The operator decides what enters the queue.** Not every GitHub issue becomes a task. The issue view has an "add to queue" affordance that creates a task row with a `sourceRef` pointer into the existing `issues` table (Concern 2 Q2.3). The queue is a subset of the source backlog, curated by hand.

The "curation UX" is the task view itself. Opening a task opens the agent's attention view for that task's primary assignment (§5). Task opening and attention drill-down are the same interaction — the task is the context source.

**Pre-implementation addendum:** `docs/design-mc-f12-task-curation.md` resolves ten open questions before F-12 lands — the F-12 / F-12b scope split (assignment-state verbs ship first; GitHub add-to-queue ships in a sibling PR), the curation toolbar living inside the F-7 drill-down (no side panel, no separate route), the per-state button-enablement matrix derived from the state machine, the agent-picker dropdown for Dispatch and Hand off, the assignment-vs-task branching for Abandon, the cancel-and-respawn semantics for Hand off, the 1-to-1 mirror of `operator_requeue` for Requeue, the confirmation gate posture (Abandon and Hand off prompt; Dispatch and Requeue do not), the `operator.curation` event family with `kind` discriminator (and a synthetic per-task shadow session for assignment-less curation events), and explicit deferral of bulk operations / templates / dependencies / tagging / slash-commands.

**Pre-implementation addendum:** `docs/design-mc-f12b-add-to-queue.md` resolves eleven open questions before F-12b lands — placement of the `+ Add task` affordance at the top of the F-8 task table (with ⌘K palette as a sibling shortcut once MIG-3 lands real palette commands), the input → preview → submit modal flow, GitHub access via the existing `gh` CLI / `Bun.spawn` shape (no `@octokit/rest` dependency), the URL/shorthand parser accepting full URL plus `owner/repo#N` plus `#N`-with-default-repo, dedup by reject-and-deeplink at preview time (no UNIQUE index in v1), the two-endpoint shape (`POST /api/tasks/preview` and `POST /api/tasks`) plus the F-12-inherited `POST /api/tasks/:taskId/abandon`, the empty-assignment Dispatch site rewire at `dashboard/index.html:2134`, the `task-shadow-{taskId}` synthetic-session helper using a `mc-shadow-agent` sentinel and `endpoint_kind='local.observed'`, the form-blocks-with-spinner UX during the GitHub fetch, the `operator.curation` event with new `kind: "task.imported"` variant, and explicit deferral of bulk import / scheduled imports / GitHub project boards / Linear-Jira-Asana / two-way sync / inbound-webhook auto-add.

---

## 4. Notification system

**Pre-implementation addendum:** `docs/design-mc-f11-discord-notifications.md` resolves ten open questions before F-11 lands — the full transition × priority × block-reason-kind × risk notification matrix, DM-vs-channel-post split (one event, one surface; with role-ping escalation for high-risk P0/P1 blocks), the concrete deep-link URL shape with `from=dm` / `from=channel` param, channel-routing that reads the v1 SOP's config when present and falls through cleanly when it doesn't (no thread auto-creation in v2), the `grove.notifications.discord` toggle + `grove.baseUrl` + `discord.operatorRoleId` config keys with off-by-default posture, a three-layer dedup + coalesce + channel-throttle rate-limiting model, the single-event and coalesced payload shapes, reuse of the existing `DiscordAdapter` (no new bot / no new token), and explicit deferral of interactive buttons / slash-commands / additional channels / preferences UI / multi-operator fanout.

Notifications are a **requirement layered on top of the dashboard attention core**. The dashboard visual attention indicator (§5, §7) is the foundation. Push is additive. If push is ever paused or swapped, the core does not move. (Concern 1 framing.)

### 4.1 Channels in v1

**Discord only** (DM + channel post). No OS desktop notifications. No phone push. (Concern 1 Q1.1.)

Rationale: Discord is already shipped — zero new dependency. Grove already has `grove-bot` wired to Discord gateway; reuse it as the sink. OS desktop notifications may return later through the event pipeline once event-back-in enables arbitrary automations — that's a post-MVP capability, not v2 scope.

### 4.2 Routing

**Hardcoded priority map, ~10 lines, in grove-bot.** No classifier service. No router abstraction. (Concern 1 Q1.2, Conflict 1.)

```ts
// grove-bot, concrete, not abstract
function shouldNotify(event: AssignmentStateChange): NotificationIntent | null {
  // Permission requests are a distinct blocked-reason that the operator resolves via approve/deny (§5.3.1).
  if (event.to === 'blocked' && event.blockReason?.kind === 'permission.request') {
    const risk = event.blockReason.risk_hint;
    if (risk === 'high' || event.task.priority <= 1) return { channel: 'dm', urgency: 'high' };
    return { channel: 'dm', urgency: 'normal' };
  }
  if (event.to === 'blocked' && event.task.priority <= 1) return { channel: 'dm', urgency: 'high' };
  if (event.to === 'blocked') return { channel: 'dm', urgency: 'normal' };
  if (event.to === 'failed') return { channel: 'channel', urgency: 'normal' };
  if (event.to === 'completed' && event.task.priority === 0) return { channel: 'channel', urgency: 'low' };
  return null;
}
```

Only promote to a data-driven classifier when the map is observably wrong in interesting ways. "Don't build a traffic-shaping system before there is traffic" (Council §1.1).

### 4.3 Channel opt-in

One-bit toggle in `bot.yaml`:

```yaml
grove:
  notifications:
    discord: true
```

Revisit only when a second channel lands. (Concern 1 Q1.3.)

### 4.4 Deep links

Every notification includes a deep link back into the dashboard. The link opens to the relevant attention card.

**Base URL comes from `bot.yaml`:**

```yaml
grove:
  baseUrl: http://localhost:8766   # Tier 1 default
  # baseUrl: https://grove.meta-factory.ai  # Tier 2
```

Tier 1 defaults to `http://localhost:8766`. Tier 2 points at the cloud origin. No runtime base-URL detection. (Concern 8 Q8.1.)

**Scope limits:**

- **LAN:** not supported in v2. If Grove runs on one machine and Discord is read on another, the link will not work. (Concern 8 Q8.2.)
- **Mobile at Tier 1:** not supported. If the operator reads a Tier 1 notification from their phone, the localhost link will not open. Tier 1 is a local-desktop experience. (Concern 8 Q8.3.)
- **Mobile at Tier 2:** works natively because the base URL is a public origin.

Deep-link format:

```
{grove.baseUrl}/?focus=assignment/{assignment_id}
```

---

## 5. Agent attention view

**Pre-implementation addendum:** `docs/design-mc-f7-attention-view.md` resolves nine open questions from this section before F-7 lands — input-affordance placeholder posture, overlay-vs-route navigation, the events pagination endpoint, D/A/H classification at content-block granularity, operator-vs-tool `stream-json.user` disambiguation, Approve/Deny wire-up gate, summary header minimum viable content, hand-rolled virtualisation, and single-drill-down enforcement.

The attention view is the **drill-down**. It is scoped to exactly one `agent_task_assignment` row (§3.3). It renders the head (agent), the task, the current hands run (session), and the operator's input affordance.

**Reference implementation for rich-context rendering:** `~/Developer/miner` — metafactory's process-mining repo. Phase 4 borrowing targets are summarised in §5.4.

### 5.1 Layout

Three vertical sections, top to bottom. (Concern 4 Q4.1.)

```
┌──────────────────────────────────────────────────┐
│  ① Summary header  (collapsed by default)        │
│     Luna × T-42 "fix webhook HMAC verification"  │
│     State: blocked  ·  waiting on:  tool.bash    │
│     Dispatch cycle: 3                            │
│     [▾ expand]                                   │
├──────────────────────────────────────────────────┤
│  ② Time-descending event log  (virtualised)      │
│     [newest]                                     │
│     ├─ operator: "try running it in src/worker"  │
│     ├─ tool.bash: exit 1 — "permission denied"   │
│     ├─ tool.bash: cd src/worker && bun test      │
│     ├─ assistant: "I'll run the tests next..."   │
│     ├─ tool.read: src/worker/webhook.ts          │
│     │  ⋯ scroll for older events ⋯               │
│     [oldest]                                     │
├──────────────────────────────────────────────────┤
│  ③ Input affordance                              │
│     ┌──────────────────────────────────────────┐ │
│     │ [text box — supports drag/drop/paste]   │ │
│     └──────────────────────────────────────────┘ │
│     [📎 attach]  [↩ submit]      queue: 0 items │
└──────────────────────────────────────────────────┘
```

### 5.2 Summary header

- **Collapsed default:** agent name, task title, current state, one-line block reason (if blocked), dispatch cycle number.
- **Expanded:** adds the agent's own `block_reason` content, the task `sourceRef` context (issue title, PR number, etc.), any assignment metadata.

**Source of the summary is hybrid.** When the assignment is `blocked`, the summary uses the agent's own explicit `block_reason` (required as part of the block protocol — no guessing). When the assignment is `running`, the summary is inferred from the last N events with simple "current phase" heuristics. (Concern 4 Q4.2.)

The summary is **scaffolding, not a source of truth** — the event log below is authoritative. The summary just helps the operator orient in under a second.

### 5.3 Event log

Time-descending, newest at the top, full session history, virtualised scroll, no hard cap (Concern 4 Q4.3).

**Prominence is not flat.** When an agent is making progress, the operator's primary signal is **what the agent reports back** — the assistant messages, the "I found X, I'm doing Y, here's the result" stream. Tool calls and tool results are secondary context for a progressing agent. But the event log must also render well for the **blocked** case, which is the other main reason to drill into an attention item — most commonly a permission denial where the agent needs explicit operator approval to use a tool, read a file, run a command, or edit a file.

Event rows are therefore rendered at three visual weights, mirroring Maestro's `TerminalOutput` pattern (see "Reference implementation pins" at the end of this section for Maestro file anchors; line numbers drift, so pin by file + function name):

| Weight    | Event types                                   | Rendering                                                         |
| --------- | --------------------------------------------- | ----------------------------------------------------------------- |
| **Primary**   | `assistant.message`, `operator.input`, `block.reason`, `permission.request` | Full-width markdown bubble via `MarkdownRenderer`. Always expanded. Streams in chunks (per §5.3 streaming note). `permission.request` renders with an inline **approve / deny** affordance — see §5.3.1 below. |
| **Secondary** | `tool.call`, `tool.result`                | Compact left-border accent row with tool name + status glyph. **Collapsed by default.** Click to expand arguments / output. Maestro's `ToolCallCard` is the reference. |
| **Tertiary**  | `thinking.chunk`, `subagent.trace`, `state.change` | Thin inline marker with a badge. Thinking renders inline expanded (Maestro pattern); subagent traces collapsed; state changes as one-line chips. |

Note: when a permission request *is* the reason the agent is blocked, the relevant `tool.call` is visually promoted to primary for that one row — it is what the operator is being asked to approve, so it must not be hidden behind a collapse.

**Streaming.** Assistant text arrives in chunks (not character-by-character) and is batched via requestAnimationFrame for paint cost, matching Maestro's stdout-batching pattern (see reference pins below). Grove's dashboard is multi-agent — events are routed to the right attention view by `assignment_id`, not a single active session like Maestro. Virtualisation is required for Grove (not present in Maestro); default viewport renders the last 20 events, older lazy-loaded on scroll.

**Reference implementation pins (Maestro, `~/Developer/maestro`).** Line numbers are given for orientation only — they drift across commits. Pin by file + function name when in doubt.

| Responsibility              | Maestro anchor                                                   |
| --------------------------- | ---------------------------------------------------------------- |
| Primary markdown bubble     | `src/renderer/components/TerminalOutput.tsx` — `MarkdownRenderer` usage around lines 637-648 at time of audit |
| Secondary tool card         | `src/renderer/components/ToolCallCard.tsx` — component definition |
| Streaming chunk batching    | `src/main/process-manager/handlers/StdoutHandler.ts` — `handleData` (line 118) dispatches to `handleStreamJsonData` (line 143) |
| Renderer batched dispatch   | `src/renderer/hooks/agent/useAgentListeners.ts` — RAF-flushed thinking-chunk buffer inside the `onThinkingChunk` handler (RAF call ~line 1321) |
| Client-side execution queue | `src/renderer/hooks/input/useInputProcessing.ts` — `executionQueue` ~lines 255-330 |
| Paste / drag-drop handling  | `src/renderer/hooks/input/useInputHandlers.ts` — paste and drop handlers ~lines 484-552, 554-599 |

#### 5.3.1 Permission / approval blocks are first-class

Claude Code can be run in two postures: default (asks for approval on each new tool use, file read, edit, bash command, etc.) or `--dangerously-skip-permissions` (auto-accepts everything; the "YOLO" posture some operators prefer). **Grove must support both.** The default posture is common and is in fact one of the most frequent reasons an agent becomes blocked — it is stuck waiting for a human approve/deny decision, not on missing information.

`block_reason` is a **tagged union on `kind`**. The `permission.request` kind is first-class; the other two kinds (tool error, review checkpoint) cover the remaining block cases from §2. The wire format schema — one Phase A deliverable (§11 item 6) — enumerates at least these three:

```
block_reason (tagged union, discriminated on `kind`)

  kind = 'permission.request'          -- default CC posture asked for approval
    requested_action                   -- e.g. 'tool.bash' | 'tool.edit' | 'tool.read' | 'tool.webfetch'
    target                             -- command string / file path / URL
    context                            -- one-line rationale from the agent
    risk_hint                          -- 'low' | 'medium' | 'high' (from CC's own classification)

  kind = 'tool.error'                  -- a tool call failed
    tool_name                          -- e.g. 'tool.bash'
    message                            -- error message returned by the tool
    exit_code                          -- when applicable (bash etc.)

  kind = 'review.checkpoint'           -- agent explicitly asked for human sign-off
    note                               -- one-line rationale from the agent
```

`§4.2`'s `shouldNotify` routing branches on `event.blockReason?.kind`. `§2`'s three examples each use one of the three kinds. Adding a fourth kind is a single row in this table plus a new branch in `shouldNotify` — the schema stays open on purpose.

When an assignment enters `blocked` because of a `permission.request`:

1. The assignment's `block_reason` structured field carries the request payload (Concern 4 Q4.2).
2. The summary header shows *exactly* what the agent is asking for — action, target, rationale — not a generic "waiting for operator".
3. The `permission.request` row in the event log renders with **Approve** and **Deny** buttons inline. Approve resumes the assignment via the session endpoint (§6.1); deny sends a structured decline that the agent can route around. Text/screenshot input is still available as a third option for "deny with instructions to try differently".
4. Discord push notification (§4) for permission blocks is sent at the urgency level appropriate to `risk_hint` — low/medium as a normal DM, high bumps to the same tier as a tool failure.

**CC stream-json permission dependency.** The interactive approve/deny flow depends on CC emitting a structured `permission.request` event in its `--output-format stream-json` output and accepting an approval response via `--input-format stream-json` stdin — i.e., a non-TTY approval mechanism. Neither Maestro nor Paperclip (the two reference systems — see §7.6) has tested this path: both bypass permissions entirely (`--dangerously-skip-permissions` / yolo mode). **This is a Phase A verification task (§11 item 10).** If CC does not support structured permission events in stream-json mode, Grove ships with yolo mode as the default and the `permission.request` block_reason kind becomes a design-ready placeholder activated once CC gains support. The schema, the attention view rendering, and the shouldNotify routing all ship regardless — they cost nothing to carry and avoid a redesign when CC catches up.

**Auth constraint.** Approve/deny is an operator action and is subject to the same single-operator-in-v1 auth posture (§6.5). In Tier 2, approve/deny is pinned to the authenticated operator identity on the WebSocket; Grove records *who* approved each request in the audit log.

**Working vs blocked.** Same layout, different affordance state (Concern 4 Q4.4):

- **Working:** event log is live-updating, assistant messages are the main thing the operator reads, input affordance is "interrupt / inject note" — present but quiet.
- **Blocked on information / error:** summary header prominently shows the block reason; the text/screenshot input affordance becomes the primary action.
- **Blocked on permission request:** summary header shows the requested action and target; **Approve / Deny** are the primary actions, text/screenshot input is still available as a secondary path.

The view is usable on any agent, not just blocked ones. The operator's primary use case depends on the agent's CC posture: for auto-accept sessions, drill-down is mostly for watching progress; for default-permission sessions, drill-down is also the place where approval decisions happen.

### 5.4 Borrowing from miner

From inspection of `~/Developer/miner`:

- **Three-panel rendering pattern.** Miner uses Matrix (raw event stream) + Analysis (live process DAG) + Signal Palette (operator annotations). Grove's attention view uses the **same layered pattern at single-assignment scope**: Summary ≈ Analysis, Event Log ≈ Matrix, Input Affordance ≈ Signal Palette.
- **Colour classification.** D/A/H — Deterministic (green), Agentic (amber), Human (rose). Grove uses the same three colours to classify event rows so the operator can tell at a glance whether an event came from a tool (D), the agent's reasoning (A), or the operator (H).
- **Intent extraction.** Miner uses post-hoc extractive summarisation (rule-based, not LLM) to truncate assistant intents to 8–16 words. Grove's summary header uses the same approach — no LLM call in the render path.
- **Event schema shape.** Grove's event log types (above) align with miner's MinerEvent (`event_id`, `event_type`, `timestamp`, `session_id`, `source`, `payload`). Grove already captures most of what the attention view renders via the existing hook pipeline (`src/hooks/`, `src/relay/`), so most of the borrowing is rendering not capture. Any event types the attention view needs that are not yet in the published stream — in particular fine-grained `tool.call` / `tool.result` / `thinking.chunk` / `assistant.message` decomposition — are added in the Phase A `events` table schema, not at capture time.

What is **not** borrowed: miner's DAG view (React Flow), Signal Palette annotation UI, or its capture pipeline (miner sits behind its own CC hook). Those belong to a separate process-mining use case.

### 5.5 Multiple attention items

**Multiple items exist concurrently; one drill-down is visible at a time.** (Concern 4 Q4.5.)

The dashboard shows each attention item as a card in the focus area (§7). Each card has a high-level state-machine overview: agent name, task title, state, time in state, priority. Clicking a card opens its attention view as the foreground; other cards remain visible as context. Only one detailed view is foregrounded at a time to preserve operator focus. Plural instances, singular focus.

---

## 6. Operator input channel

**Pre-implementation addendum:** `docs/design-mc-f10-operator-input.md` resolves ten open questions before F-10 lands — text-first scope with images deferred, Enter submit with Shift+Enter newline, reuse of the existing `POST /api/assignments/:id/input` endpoint rather than a new WS path, queue-depth surfacing in the drill-down, observed-session + ended-session UI gates, inline error banner with status-code-specific copy, and the v1 placeholder deferred-removal plan.

The input affordance in §5.1 (③) is implemented by borrowing from **Maestro** (`~/Developer/maestro`), metafactory's Electron UI over agent harnesses. Grove copies Maestro's patterns verbatim where possible. No first-principles reinvention. (Concern 5 framing.)

### 6.1 Transport

**Pattern: stdin piping, IPC-mediated, abstracted behind a session endpoint.** (Concern 5 Q5.1.)

#### Verified Maestro invocation model (2026-04-16 code audit)

Maestro does **not** use `claude --print`. It spawns `claude` normally with `--output-format stream-json` and keeps the process alive:

```
Maestro renderer ──(IPC process:write)──▶ main ProcessManager ──(childProcess.stdin.write)──▶ claude
                                                                                               │
claude stdout (stream-json JSONL) ──▶ StdoutHandler.handleData ──▶ IPC process:data ──▶ renderer
```

Key details from Maestro's `src/main/process-manager/`:

- **Spawn:** `child_process.spawn()` with `--output-format stream-json` + `--input-format stream-json` (conditional). No `--print`. Process stays alive. (`ChildProcessSpawner.ts:316`)
- **Multi-turn stdin:** Each operator turn is framed via `buildStreamJsonMessage()` (`streamJsonBuilder.ts`) and written to stdin with a newline delimiter. Stdin stays open between turns. (`ChildProcessSpawner.ts:501-515`)
- **Process lifecycle:** `ProcessManager` holds a `Map<sessionId, ManagedProcess>`. Processes remain in the map, accepting new stdin writes, until explicitly killed or they exit naturally. (`ProcessManager.ts:31-47`)
- **Session resume:** `--resume <sessionId>` is used only for reconnecting to a previously-exited session, not between turns of a live session. (`agent-args.ts:97-99`)
- **Permission bypass:** Maestro uses `yoloModeArgs` (e.g., `--dangerously-bypass-approvals-and-sandbox`). No interactive approval UI. (See §5.3.1 CC stream-json permission dependency.)

#### Grove v2 adaptation

Grove v2 replicates Maestro's model, replacing Electron IPC with WebSocket:

```
browser ──(WebSocket)──▶ grove-bot ──(stdin.write via session endpoint)──▶ claude
                                                                            │
claude stdout (stream-json) ──▶ event parser ──▶ WebSocket ──▶ browser dashboard
```

- The dashboard is a browser app, not Electron, so the renderer↔main IPC becomes a WebSocket to grove-bot. The contract on the bot side mirrors Maestro's `process:write` IPC handler: `{ assignment_id, payload }`.
- grove-bot resolves `assignment_id` to a **session endpoint** and writes the payload to it. For controlled sessions, "write" frames a stream-json message and delivers it to the CC process's stdin. For observed sessions (hook-ingested, read-only), "write" throws `NotControllable`.
- **Sessions are long-lived.** The CC process stays alive for the duration of the operator's interaction. No cold-start between turns. Context stays hot in memory. `--resume` is used only for session compaction (see §6.6) or reconnection after a crash — never between operator turns of a live session.
- **Session compaction.** Long-lived sessions eventually fill CC's context window. When context pressure is detected (from stream-json usage events), Grove gracefully ends the current CC process and starts a new one with `--resume`, preserving continuity. Compaction triggers (borrowed from Paperclip's session rotation policy): max operator turns, max input tokens, max session age. See §6.6.
- **The session endpoint is an abstraction boundary.** Even at local Tier 1, the hands run may live in a different sandbox context from grove-bot (different cwd, container, mount namespace), which means the transport cannot assume in-process stdin forever. v2 ships the same-process implementation but phrases every write as "look up the session endpoint for this assignment, deliver the payload" — not "write to the local child process stdin". This keeps the data shape and the call site stable when Spawn, sandboxed local backends, or Tier 2 remote backends land later.

#### Endpoint kinds

v2 ships two endpoint kinds and stubs a third:

- `local.process.controlled` — long-lived CC child process spawned by Grove. `write()` delivers stream-json-framed turns to stdin. (**v2 interactive sessions**)
- `local.observed` — external CC session (e.g., `cldyo-live`) observed via the hook stream. `write()` throws `NotControllable`. (**v2 observed sessions**)
- `local.process.autonomous` — single-turn CC child process (`--print` + `--dangerously-skip-permissions`), spawned by Grove for routine/trusted work, exits on completion. (**Future: heartbeat mode, see §10.**)

Future kinds (preserved in `design-spawn-integration.md`):
- `local.sandbox` — local sandbox (container / bwrap) over a unix socket
- `remote.spawn` — Spawn-hosted hands run, over the authenticated RPC Spawn exposes

At Tier 2 the WebSocket terminates at the CF Worker; the Worker still resolves `assignment_id` → endpoint, and the endpoint is remote. No new primitive, just a different resolution. See §7.3 and `design-spawn-integration.md` §5a for the full picture.

### 6.2 Image and screenshot support

**Pre-implementation addendum:** `docs/design-mc-image-input.md` resolves ten open questions before image-input code lands — paste + drag-drop ship together, `buildStreamJsonMessage` grows a content-block overload (backward-compatible), base64 stays embedded in events (blob storage deferred to Tier 2 revisit), `POST /api/assignments/:id/input` body grows an `images[]` field, per-image / per-message / per-body caps with media-type allowlist, thumbnail-chip UI above the textarea, F-7 renderer grows an `image` content-block case with a click-to-enlarge lightbox, observed/ended sessions inherit F-10's disable gate, and full test scope across framer + endpoint.

**Borrowed from Maestro.** (Concern 5 Q5.2.)

Maestro supports:

- Paste images from clipboard (PNG base64 data URLs)
- Drag-and-drop image files
- Embedding in the stream-json message via Maestro's `buildStreamJsonMessage` helper

Grove v1 ships the same three capabilities. Images are sent as base64 data URLs, embedded in the message written to the session's stdin. No temp files, no upload-to-cloud step.

### 6.3 Input queue

**Yes — client-side input queue, borrowed from Maestro.** (Concern 5 Q5.3.)

Maestro's pattern:

```ts
// renderer state
executionQueue: QueuedItem[]

// when session.state === 'busy', new input is appended to the queue
// when session.state transitions to 'idle', the queue drains into stdin
```

Grove v1 mirrors this. The dashboard state holds a per-assignment `executionQueue`. If the operator submits input while the assignment is `running` (i.e., the session is mid-tool-call), the input is queued and delivered at the next prompt cycle. The UI reflects the queue depth under the submit button.

Queued items are **not** durable across dashboard reloads in v1 — they live in browser state. Durable queuing is a post-v2 capability. (The aggregated audit log §6.4 still records the input once it is delivered.)

### 6.4 Audit log

**Full audit log of operator ↔ agent interactions, across all agents.** (Concern 5 Q5.4.)

Operator input is a first-class event — `operator.input` — written into the same event stream as agent events (tool calls, tool results, assistant messages). The mission control dashboard provides an **aggregated audit view** sitting on top of all agents, sliceable per agent, per task, or per assignment.

Implementation: a single `events` table accessed through the new `src/common/grove-db/` shared layer (§7.3), with columns `assignment_id`, `event_type`, `payload`, `timestamp`. The existing per-agent detailed logging paths continue to exist; the aggregated view is a query against the new table, not a separate data model.

### 6.5 Auth

**Single operator only in v1.** No role-based access. (Concern 5 Q5.5.)

Tier 2 multi-operator auth is out of scope for v2, but the data model (Concern 2 Q2.2 — `operator_id` from day one on tasks and assignments) does not preclude it. When Tier 2 ships, the WebSocket authenticates via CF Access and the operator identity is pinned to the connection.

### 6.6 Session compaction

**Long-lived interactive sessions fill CC's context window.** Grove must detect context pressure and gracefully rotate to a new session without losing continuity.

**Triggers** (borrowed from Paperclip's session rotation policy in `server/src/services/heartbeat.ts:1641-1759`):

- **Max operator turns.** After N turns (configurable, default ~50), rotate.
- **Max input tokens.** When CC's stream-json usage event reports `inputTokens` approaching the model's context limit (e.g., 80% of capacity), rotate.
- **Max session age.** After N hours (configurable, default ~4h), rotate regardless of token usage. Prevents unbounded session staleness.

**Rotation sequence:**

1. Grove detects a compaction trigger.
2. Dashboard shows a brief "session rotating..." indicator.
3. Grove sends a graceful close to the current CC process.
4. Grove spawns a new CC process with `--resume <previousSessionId>`. CC loads the session history from disk and continues.
5. The new process becomes the live session. The endpoint handle is updated in place.
6. The assignment row does not change state — it stays `running`. The `sessions` table gains a new row for the new process.

**This is infrequent** — every few hours or every ~50 turns, not every turn. The brief cold-start during rotation (~2-5s) is acceptable. Between rotations, the session stays hot.

**Compaction is transparent to the operator.** The attention view shows a one-line "session rotated" state-change event in the event log. The operator does not need to take any action.

---

## 7. Architecture

### 7.1 Heads, hands, and the agent model

Grove adopts **head / hands** as the agent model, taken from Anthropic's sandboxed-environment terminology. (Conflict 5.)

- **Head** = the agent's identity, persona, memory, skills, role, configuration. One row in the `agents` table per head. Persistent heads (e.g., Luna) retain memory, skills, and history across runs. Ephemeral heads do not — they exist only for the lifetime of their assignment.
- **Hands** = the sandboxed execution run that carries out work on behalf of the head. Each `session` (the existing `cc-session.ts` mechanism) is one hands run. A head can spawn 0..N hands runs over its lifetime.
- **Mapping to the schema:**
  - `agents` row = head
  - `agent_task_assignment` row = "this head is assigned to this task"
  - `sessions` (0..N per assignment) = hands runs
- **UI rendering:** persistent heads render as always-visible agent cards; ephemeral heads appear during an active assignment and fade out when the assignment completes. A single `persistent: bool` attribute on the `agents` row, not a taxonomy.
- **No use of "pets" or "cattle" anywhere in the design.**

This framing is load-bearing for two reasons:

1. It lets Grove talk cleanly about **backend-agnostic execution** later. Any execution backend — local `Bun.spawn` today, other backends once they ship — is just "a host for hands runs." The head doesn't care where its hands execute. The preserved backend design is in `docs/design-spawn-integration.md`.
2. It naturally accommodates Luna's recursive sub-team pattern (`src/bot/lib/agent-team.ts`) — Luna's sub-agents are additional **hands runs within Luna's own assignment**, not new rows in `agents`.

### 7.2 Operator as orchestrator

**The operator is the orchestrator. Luna is one agent instance.** (Conflict 6.)

- The operator drives mission control: curates the task queue, reviews attention items, sends input, moves stuck tasks, approves dispatch. The operator is the orchestrator at Tier 1.
- Luna is **one row in the `agents` table** — a persistent head. She has no privileged position in the schema, the attention model, or the UI.
- Luna's agent-team capability (`src/bot/lib/agent-team.ts`) is preserved but **internal to her own assignment**. When Luna spawns sub-agents to get work done, those are recursive hands activity within her current hands run. They do not create rows in `agents` or `agent_task_assignment`. Sub-team work is an implementation detail of Luna's head, not a top-level architectural pattern.
- The v2 dashboard is **agent-neutral**: it names Luna only as an example persistent head, never as the orchestrator or as a privileged dispatch surface.

### 7.3 Tier 1 and Tier 2: shared model, different composition

Earlier mission control drafts said "identical interface, only the transport changes." That statement is false in a way that matters. v2 says plainly: **shared data model and core domain logic; honestly different runtime composition.** (Conflict 2.)

#### Ground truth: what is actually shared today

Before describing the v2 target, this is what grove has today — not a claim, a file audit (2026-04-15):

| Area                    | Bot (Tier 1)                                                    | Worker (Tier 2)                                              | Shared?                            |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| Database driver         | `bun:sqlite` via `DashboardDb` (`src/bot/lib/dashboard-db.ts`) | Raw D1 via `db.prepare()` in `src/worker/src/routes/*.ts`    | **No** — two separate drivers       |
| Schema source-of-truth  | Inline TypeScript migrations in `DashboardDb.migrate()` (`dashboard-db.ts:127-247`) | `src/worker/schema.sql`                                      | **No** — drift: worker has `session_activity` and `audit_log` tables; bot does not. Both carry `operator_id` on `sessions` (bot at `dashboard-db.ts:246`), but worker also has `operator_id` on `github_events` and `audit_log`. |
| Query logic             | `DashboardDb` methods (`handleState`, `handleRepos`, …)         | Route handlers in `routes/state.ts`, `routes/repos.ts`, …    | **No** — duplicated                 |
| HTTP API surface        | `Bun.serve()` at `dashboard-api.ts:130`, same `/api/*` shape   | Hono at `src/worker/src/index.ts`, same `/api/*` shape       | **Same shape, two implementations** |
| Event ingestion         | `POST /api/events/ingest` (`dashboard-api.ts:418-448`)          | `POST /api/ingest` (`src/worker/src/routes/ingest.ts:35-97`) | Shape shared; handlers duplicated   |
| Event processing        | Bot's own path: `dashboard-api.handleEvent` + relay's `src/relay/lib/event-processor.ts` | Imports `src/common/event-processor.ts` | **No** — duplicated; `src/common/event-processor.ts` is consumed only by the worker. The bot's relay has its own parallel implementation at `src/relay/lib/event-processor.ts`. |
| Domain types            | Bot does not import `src/common/types.ts` at all                | Imports `src/common/types.ts` (e.g. `routes/github.ts:22`, `routes/ingest.ts:23`) | **No** — worker-only |
| Shared modules          | `common/github-events.ts` and `common/agent-detection.ts` via `src/bot/lib/github-webhook.ts:18-24` | Same two modules, plus `common/event-processor.ts`, `common/event-utils.ts`, `common/types.ts` | **Partial** — GitHub event shape + agent detection are the only modules both sides import today |
| GitHub webhook handling | `GitHubWebhookHandler` (bot, opt-out in cloud mode)             | `routes/github.ts` (worker)                                  | Duplicated handlers, shared event shape via `common/github-events.ts` |
| Discord gateway         | `DiscordAdapter` (bot)                                          | None                                                         | Bot-only                            |

**Honest assessment.** Grove does not have a `GroveDb` today. What it has is:

- Two separate database implementations (`bun:sqlite` via `DashboardDb` vs raw D1 bindings) that happen to expose the same REST shape.
- Two separate event processing paths: the worker imports `src/common/event-processor.ts`; the bot does not, and its relay has its own parallel implementation at `src/relay/lib/event-processor.ts`.
- Two `src/common/` modules that are genuinely shared by both sides: `common/github-events.ts` and `common/agent-detection.ts`. That is the entire shared surface today.
- Schema drift between bot and worker — the bot is missing the worker's `session_activity` and `audit_log` tables, and several of the worker's new `operator_id` columns outside of `sessions`.

**Bot is primary**: it owns Discord, the live event pipeline, and the dashboard frontend via `Bun.serve()`. **Worker is a read-replica snapshot** of the same data surface, cached with ETags (`src/worker/src/routes/state.ts:18-20`).

#### What v2 introduces

v2 Mission Control adds new tables: `tasks`, `agent_task_assignment`, a unified `events` table (§7.4). These tables do not exist today in either bot or worker. **The v2 design target is that new v2 tables land via a shared data-access layer** — not the existing duplicated path. Two options, one picked:

- **(A)** Extract a `src/common/grove-db/` module with a thin interface (`getTask`, `getAssignment`, `appendEvent`, …) and two adapters: `SqliteAdapter` wrapping the bot's `bun:sqlite` and `D1Adapter` wrapping worker's D1 bindings. New tables live here from day one.
- **(B)** Accept the duplication and write each new table twice — once in `dashboard-db.ts`, once in worker routes — enforcing consistency by contract tests.

**Decision:** Option (A). Phase A (§9) **creates** the shared data-access layer as its first deliverable, not assumes it exists. This is the only correct interpretation of "SQLite at Tier 1, D1 at Tier 2, identical schema" — it has to be built; it is not free.

**Migration posture for existing tables** (`sessions`, `github_events`, `repos`, `issues`, `pull_requests`, `audit_log`, `session_activity`): they stay where they are in v2. The new layer is introduced alongside, not instead of, the current duplicated path. Folding the existing tables into the shared layer is a follow-up cleanup, not a v2 commitment.

**Genuinely shared at v2:**

- `src/common/github-events.ts` and `src/common/agent-detection.ts` — the only modules both bot and worker import today (via `src/bot/lib/github-webhook.ts:18-24` and `src/worker/src/routes/github.ts:17` / `routes/sync.ts:101`). These stay as they are.
- The new `src/common/grove-db/` shared layer (new in Phase A) — the v2 tables (`tasks`, `agent_task_assignment`, `events`) land through it from day one.
- Core task / assignment / session state machines as pure functions in `src/common/`, consumed by both bot and worker.
- Rendering logic for the attention view (§5) and the task list (§3).
- The `operator.input` and `permission.request` event shapes and the audit-log schema.

**Deliberately left as-is in v2.** `src/common/event-processor.ts` stays worker-only; the bot's relay keeps its own `src/relay/lib/event-processor.ts`. Unifying them is a post-v2 cleanup — not a Phase A commitment — because the relay's responsibilities (JSONL policy filter over filesystem events) and the worker's (HTTP-ingested session events into D1) differ enough that collapsing them now is scope creep.

**Different between Tier 1 and Tier 2:**

| Aspect         | Tier 1                                      | Tier 2                                            |
| -------------- | ------------------------------------------- | ------------------------------------------------- |
| Runtime        | Single-process Bun app                      | CF Worker + D1                                    |
| DB adapter     | `SqliteAdapter` over `bun:sqlite`           | `D1Adapter` over D1 bindings                      |
| Notifications  | In-process function call into grove-bot     | Per-operator routed path, identity-aware          |
| Auth           | None (single-operator)                      | CF Access, operator-scoped                        |
| Deep links     | `http://localhost:8766`                     | `https://grove.meta-factory.ai` (per `baseUrl`)   |
| Consistency    | Local writes immediately visible            | D1 consistency semantics apply                    |
| Fan-out        | One process, one listener                   | Per-operator scoped subscriptions                 |
| Session endpoint resolution | Direct to in-process `cc-session.ts`  | Routed to remote hands run (§6.1, spawn doc)      |

Other divergences (rate limiting, cross-operator conflict resolution, ordering across operators) are **parked in §11 Open questions**. They do not affect v2 single-operator scope.

### 7.4 Data model summary

```
┌────────┐     ┌───────────────────────┐     ┌───────┐
│ agents │────▶│ agent_task_assignment │◀────│ tasks │
└────────┘     └───────────────────────┘     └───────┘
    head            link row (STATE MACHINE)      │
                            │                     │ joined to
                            │                     ▼
                            ▼                ┌──────────┐
                       ┌──────────┐          │  issues  │  (existing
                       │ sessions │          │pull_requ.│   src/worker
                       └──────────┘          │  repos   │   schema.sql)
                        hands runs            └──────────┘
                            │
                            ▼
                       ┌──────────┐
                       │  events  │  (unified stream:
                       └──────────┘   tool.*, assistant.*,
                         audit log    operator.input,
                                      state.change, etc.)
```

- `tasks` — first-class Grove object, one primary `sourceRef`, `priority`, `operator_id`.
- `agent_task_assignment` — many-to-many link, owns the state machine, 0..N sessions per assignment.
- `sessions` — existing `cc-session.ts` record, one CC process per session.
- `events` — unified stream powering the attention view event log and the aggregated audit log.
- `issues`, `pull_requests`, `repos`, `github_events` — **existing** tables in `src/worker/schema.sql`, reused as the source-of-truth for GitHub entities. Joined to `tasks` via `source_external_id` for display.

### 7.5 The components

```
┌─────────────────────────────┐
│  Dashboard (browser)        │
│  - Focus area (§7 below)    │
│  - Attention view (§5)      │
│  - Task list (§3)           │
│  - Input affordance (§6)    │
└──────────────┬──────────────┘
               │ WebSocket (Tier 1: local; Tier 2: CF Access)
               ▼
┌─────────────────────────────┐     ┌──────────────────────┐
│  grove-bot (Bun process)    │────▶│  Discord gateway     │
│  - WebSocket server         │     │  (notifications)     │
│  - cc-session.ts (hands)    │     └──────────────────────┘
│  - session endpoint write   │
│  - notification priority    │
│    map (§4.2)               │
│  - grove-db/SqliteAdapter   │────▶  bun:sqlite file
│  - legacy DashboardDb*      │────▶  (unchanged today)
└─────────────────────────────┘
```

`grove-bot` is the single backend at Tier 1. The dashboard is a browser app that talks to it over WebSocket. `cc-session.ts` is the hands runner for all agents running in-process.

**Data access in v2:**
- New v2 tables (`tasks`, `agent_task_assignment`, `events`) go through the new `src/common/grove-db/` layer (`SqliteAdapter` at Tier 1, `D1Adapter` at Tier 2).
- Existing Grove tables (`sessions`, `github_events`, `repos`, `issues`, `pull_requests`, …) continue to live in the current duplicated path (`DashboardDb` bot-side; raw D1 SQL worker-side). Folding them into the shared layer is post-v2 cleanup.

At Tier 2, the Bun-process box becomes a CF Worker, the WebSocket terminates at the Worker, the DB adapter swaps from `SqliteAdapter` to `D1Adapter`, and session endpoint resolution (§6.1) routes to a remote hands run. The dashboard code does not change. The dashboard↔bot protocol does not change. What changes is process boundary, auth, deep-link origin, and where hands runs live — the honestly-different-composition list from §7.3.

### 7.6 Reference implementations

Three external systems were audited during this design. Each contributed specific, citable patterns. This section records **what was borrowed and why**, so future implementers can trace the provenance and consult the source when edge cases arise.

#### Maestro (Electron-based CC IDE — `~/Developer/maestro`)

Audited 2026-04-16. Maestro is the closest architectural match: it runs long-lived CC processes with interactive operator input, exactly the execution model Grove v2 targets.

| Pattern | Where it appears in this spec | Source location |
|---------|-------------------------------|-----------------|
| Long-lived CC process with `--output-format stream-json` (no `--print`) | §6.1 Transport | `src/main/process-manager/spawners/ChildProcessSpawner.ts:316` |
| `ProcessManager` holding `Map<sessionId, ManagedProcess>` | §6.1 (session endpoint resolver) | `src/main/process-manager/ProcessManager.ts:31-47` |
| Stdin write via `--input-format stream-json` for operator turns | §6.1, §6.2 | `src/main/process-manager/spawners/ChildProcessSpawner.ts:501-515` |
| IPC bridge: renderer → main → stdin (WebSocket in Grove's case) | §6.2, §7.5 | `src/main/ipc/handlers/process.ts:574-585` |
| `--resume <sessionId>` only for reconnection, not for turn continuity | §6.1, §6.6 | `src/main/utils/agent-args.ts:97-99` |

**Not borrowed from Maestro:** permission prompt handling (Maestro uses yolo mode, same gap as Grove — §5.3.1), multi-agent orchestration (Maestro manages folders/workspaces, not agent teams).

#### Paperclip (queue-based agent orchestrator — `~/Developer/paperclip`)

Audited 2026-04-16. Paperclip's execution model is fundamentally different (single-turn heartbeat with `--print` and `stdin.end()`), so the _execution_ layer is not borrowed. But Paperclip's **operational patterns** for managing CC processes at scale contributed several ideas.

| Pattern | Where it appears in this spec | Source location |
|---------|-------------------------------|-----------------|
| Session compaction (max turns, max tokens, max age) | §6.6 Session compaction | `server/src/services/heartbeat.ts:1641-1759` |
| `assistant-ui/react` for rendering agent transcripts | §5 Attention view (rendering library candidate) | `packages/adapters/claude-local/` dependencies |
| State-machine guards with `block_reason` decomposition | §5.3.1 (tagged-union block reasons) | Heartbeat service state transitions |
| Cost tracking per session (token-level) | §10 Deferred — budget enforcement | Usage event parsing in heartbeat |
| Workspace-scoped configuration | §7.3 Tier 1 config (`~/.config/grove/mission-control.yaml`) | `server/src/services/heartbeat.ts` workspace resolution |

**Not borrowed from Paperclip:** heartbeat execution model (`--print`, stdin-close, queue-pull — fundamentally incompatible with Grove's interactive sessions), organisation-chart hierarchy (Grove uses flat head/hands, not org trees), `--dangerously-skip-permissions` as default (Grove keeps approve/deny as a requirement with yolo fallback — §5.3.1).

#### Miner (PAI dashboard — `~/Developer/miner`)

Previously audited during Phase 1 source mapping. Miner contributed the attention view rendering patterns.

| Pattern | Where it appears in this spec |
|---------|-------------------------------|
| Three-section layout (summary / event log / input) | §5.1 |
| D/A/H colour classification for event types | §5.2 |
| Extractive summary header (not generative) | §5.1 |

---

## 8. Primary attention focus (dashboard layout)

**Architectural migration:** The dashboard is being migrated from a monolithic inline-HTML file to a React + TypeScript component tree, per `docs/design-mc-dashboard-react-migration.md`. The migration is an incremental seven-PR sequence; the layout spec below remains the source of truth for behaviour. The vendored Claude Design handoff at `docs/design-artifacts/grove-mission-control/` is the visual reference.

This section details the dashboard layout that §2's core operator flow steps through. (Concern 7.)

### 8.1 Structure

```
┌──────────────────────────────────────────────────────────────────┐
│  GROVE MISSION CONTROL                   operator: andreas       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① FOCUS AREA — "who needs me"                                   │
│     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│     │ Luna × T-42  │  │ impl × T-51  │  │ rev × T-33   │         │
│     │ blocked      │  │ blocked      │  │ running      │         │
│     │ tool.bash x1 │  │ approval     │  │ (review req) │         │
│     │ P0 · 3m ago  │  │ P1 · 1m ago  │  │ P2 · 8m ago  │         │
│     └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                  │
│  ② WORKING AGENTS — grid below (not in focus area)               │
│     ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                           │
│     │Luna│ │ Lu │ │impl│ │rev │ │ rp │                           │
│     │run │ │idle│ │run │ │run │ │done│                           │
│     └────┘ └────┘ └────┘ └────┘ └────┘                           │
│                                                                  │
│  ③ TASK TABLE — sliceable / sortable                             │
│     ┌──────────────────────────────────────────────────────┐     │
│     │ Priority │ Title           │ Agents │ State  │ Age  │     │
│     ├──────────┼─────────────────┼────────┼────────┼──────┤     │
│     │ P0       │ fix webhook HMAC│ Luna   │ block. │ 3m   │     │
│     │ P1       │ bump v0.23.0    │ impl   │ block. │ 1m   │     │
│     │ P2       │ review PR #195  │ rev    │ runnin │ 8m   │     │
│     └──────────────────────────────────────────────────────┘     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 Focus area — "who needs me"

**Pre-implementation addendum:** `docs/design-mc-f6-focus-area.md` resolves three open questions from this section — the `operator.input.requested` event scope, time-in-state source field, and keyboard navigation split between F-6 and F-7.

**Content:** exclusively items that need the operator's input. `blocked` assignments, plus any assignment with an `operator.input.requested` event. (Concern 7 Q7.1, Q7.2.)

**Empty state:** "All clear" heartbeat with one-line summary of the most active agent. Green indicator. Optional mute-for-N-minutes control.

**Cards (not drill-downs):** each card shows agent name, task title, state, time in state, task priority, and one-line "what it needs". Cards are the high-level overview; clicking one opens the drill-down attention view (§5).

**Ordering.** **Priority comes from the task, not from the attention type.** (Concern 7 Q7.4.) An error on a P0 task outranks an approval on a P2 task. The attention type (error / block / review / approval) is displayed as metadata on the card but does **not** drive ordering.

**Presentation.** Default is a horizontal card row as illustrated. For more than ~6 active items, the operator switches to the table view (§8.4).

**Keyboard navigation.** (Concern 7 Q7.3.)

- `1`–`9` select focus-area cards by position.
- `Enter` dives into the attention view for the selected card.
- `Esc` returns to the focus area root.

### 8.3 Working agents — grid below the focus area

**Pre-implementation addendum:** `docs/design-mc-f9-working-grid.md` resolves ten open questions before F-9 lands — tile granularity (agent-keyed with +N badge for additional active assignments), which states count as "working" (`running`/`dispatched`/`queued`, excluding `blocked`), idle-persistent-agent handling, list endpoint shape, tile layout (160 × 80 CSS grid), tile click target, empty-state presentation, WS refetch filter, placement in the §8.1 layout, and the deliberate absence of grid-level sort/filter UI.

Working-but-not-blocked agents render in the grid below. State-machine indicators, no attention prompts. Clicking a grid tile opens the attention view (§5) — same primitive, different entry point. Useful when the operator wants to check on progress proactively. (Concern 7 Q7.2.)

### 8.4 Task table — sortable, filterable

**Pre-implementation addendum:** `docs/design-mc-f8-task-table.md` resolves ten open questions before F-8 lands — list endpoint shape, "agents" column rendering (inline chips, oldest-first), filter persistence via `location.hash`, aggregate-state ordering, primary-active tie-break for drill-down entry, closed-task inclusion policy, empty-state copy, tie-break sort, inline-vs-route placement + keyboard bindings, and title-search scope.

Table view of all tasks. v1 columns: `priority`, `title`, `agents` (assigned heads), `state` (worst-case across assignments), `age`. v1 sorts: `priority`, `age`. v1 filters: `priority`, `age`. (Concern 7 Q7.4.)

Within a priority lane, default sort is oldest first (longest-waiting surfaces first). The operator can re-sort by any column.

More filters (source system, agent type, task status) are added as the list grows. Not v1.

### 8.5 Task detail == attention drill-down

Opening a task from the table opens the attention view for that task's primary active assignment. If no active assignment exists, the task detail shows the task metadata + "[Dispatch]" button that creates an assignment to a chosen head. The task is the curation vessel (§3); the attention view is the drill-down; they share one entry point.

---

## 9. Phase order

Capability groups delivered in dependency order, local-readiness first. Each phase is a named capability bundle, not a feature-ID list.

### Phase A — Data foundation + local bot scaffold (no UI changes)

**Development posture:** Phase A develops on the `v2` branch in a worktree (`Grove-v2`), entirely independent of v1 on `main`. The two share only the `claude` binary on PATH — zero runtime coupling, zero shared database, zero shared process. See `docs/v1-to-v2-cutover.md` for the full isolation model and deferred refactors.

**What ships:**

- **`src/mission-control/` module** — self-contained local bot that runs on `localhost:8767` (v1 uses `8766`). Bun process with HTTP + WebSocket server, `bun:sqlite` database at `~/.local/share/grove/mission-control.db`, config at `~/.config/grove/mission-control.yaml`.
- **Schema** — `tasks`, `agent_task_assignment`, `agents`, `sessions`, `events` tables. No shared `grove-db` adapter layer in Phase A (that's a cutover concern — v2 is SQLite-only). Schema leaves room for `budget` fields and `blocked_by_task_id` dependency edges even though enforcement logic comes later.
- Assignment state machine with `operator_requeue` escape hatch (pure function, tested independently).
- `operator.input` as a first-class event type in `events`.
- `permission.request` as a first-class event type (§5.3.1) with a structured payload — `requested_action`, `target`, `context`, `risk_hint`. Approve/deny are operator events that mutate assignment state via the session endpoint.
- **Session endpoint resolver** (§6.1): given an `assignment_id`, return an endpoint handle `{ kind, write, close }`. Phase A implements two kinds: `local.process.controlled` (Grove-spawned CC processes) and `local.observed` (external `cldyo-live` sessions, hook-ingested, read-only — `write` throws `NotControllable`).
- **Hook-stream reader** — reads `~/.claude/events/raw/` with its own cursor file, independent of v1's `grove-relay`. Ingests events from observed sessions into the `events` table.

**PR breakdown (5 PRs, dependency order):**

1. **A1 — Bot scaffold + schema.** `src/mission-control/` directory, `package.json`, SQLite schema with all tables, config loading, `bun run dev` entry point that starts the HTTP server on `:8767`. No business logic.
2. **A2 — State machine + events.** Assignment state machine (pure function + tests), event insertion, `operator.input` and `permission.request` event types.
3. **A3 — Session endpoint resolver.** `resolveSessionEndpoint()` returning `{ kind, write, close }`. Two kinds: `local.process.controlled` (spawns CC with `--output-format stream-json`, holds process in a `Map<assignmentId, ManagedProcess>`), `local.observed` (read-only).
4. **A4 — Hook-stream reader.** Cursor-based reader for `~/.claude/events/raw/`, ingestion into `events` table, correlation with observed sessions.
5. **A5 — WebSocket server.** WS endpoint on `:8767/ws`, broadcasts state changes and events to connected dashboard clients. No dashboard yet — just the server side of the contract.

**Why first:** every subsequent phase writes against this schema and these contracts. Ship the foundation before any UI binds to it.

### Phase B — Dashboard attention core

**What ships:**

- Focus area layout (§8.1, §8.2) binding to `agent_task_assignment` state.
- Attention view (§5) rendering against the event log.
- Miner-borrowed rendering: three-section layout, D/A/H colour classification, extractive summary header.
- Task table (§8.4) with priority + age sort/filter.
- Working-agent grid (§8.3).

**Why next:** this is what the operator sees on day one. It is the new mental model the redesign exists for.

### Phase C — Operator input return

**What ships:**

- WebSocket `writeToSession` path in grove-bot (Maestro-borrowed contract).
- Dashboard input affordance with paste/drag-drop image support.
- Client-side `executionQueue` for busy-session queuing.
- `operator.input` events flowing into the aggregated audit log.

**Why third:** the attention view is usable read-only before this. Input-return turns the cockpit from a monitor into a console.

### Phase D — Discord notifications

**What ships:**

- Hardcoded priority map in grove-bot (§4.2).
- Discord DM + channel post for assignment state changes.
- `bot.yaml` toggle and `grove.baseUrl` config.
- Deep links from Discord into the focus area.

**Why fourth:** the dashboard is already usable standalone. Push is additive — it drags operator attention into the existing cockpit, it does not provide new capability. Ship it last so operators pull rather than being pushed first.

### Phase E — Task curation UX

**Pre-implementation addendum:** `docs/design-mc-f12-task-curation.md` covers F-12 (manual dispatch + requeue + abandon + hand-off). Add-to-queue from GitHub issue is split into F-12b with its own addendum (`docs/design-mc-f12b-add-to-queue.md`) in the same iteration-tracker bullet — together the two close Phase E.

**What ships:**

- "Add to queue" affordance on the existing issue view.
- Task creation from a GitHub issue (populating `sourceRef` into the existing schema).
- Manual dispatch button (create `agent_task_assignment` row).
- Manual `operator_requeue` / abandon / hand-off controls on stuck assignments.

**Why last:** earlier phases can be exercised by tasks created programmatically or via a dev console. The curation UX makes the system usable by an operator who does not want to touch a CLI. It is the "day-two" delight, not the day-one foundation.

**Tier 2 is not a phase.** It is a runtime-composition change applied across phases A–E once the data model and contracts are stable.

---

## 10. Deferred capabilities

Explicitly out of scope for v2, with the reason each is deferred:

| Capability                       | Why deferred                                                   | When to revisit                               |
| -------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| Phone push notifications         | Concern 1 Q1.1 — Tier 2 only                                   | With Tier 2 multi-operator runtime            |
| OS desktop notifications         | Concern 1 Q1.1 — belongs to event-back-in automation capability | When event-back-in lands                      |
| Multi-operator runtime           | Concern 2 Q2.2, Concern 5 Q5.5 — v1 single-operator            | Tier 2 rollout                                |
| Spawn-backed execution           | Spawn is not ready — design preserved in `docs/design-spawn-integration.md` | When Spawn ships                |
| Classifier / router services     | Concern 1 Q1.2, Conflict 1 — no traffic yet                    | When the ~10-line map is observably wrong     |
| `TaskSource` interface           | Conflict 4 — one concrete source (GitHub)                      | When a second source (Linear/Jira) arrives    |
| Stale-task sweepers / DLQ        | Concern 2 Q2.5 — operator has manual controls                  | When manual controls prove insufficient       |
| LAN multi-device routing         | Concern 8 Q8.2 — niche                                         | When users ask                                |
| Phone reading Tier 1 links       | Concern 8 Q8.3 — Tier 1 is local-desktop                       | Operators should use Tier 2 for phone access  |
| Persistent (cross-reload) input queue | §6.3 — v1 queue is browser-state                          | When operators hit the limitation             |
| Pets/cattle taxonomy             | Conflict 5 — replaced by `persistent: bool` + head/hands       | Never — dropped by design                     |
| Heartbeat execution mode         | Paperclip pattern (`--print`, stdin-close, queue-pull) — useful for autonomous batch work but incompatible with interactive sessions. §6.1 defines the `local.process.autonomous` kind placeholder. | When Grove needs fire-and-forget batch dispatch |
| Budget enforcement               | Paperclip pattern (hard-stop auto-pause per agent). Useful for multi-operator cost control and for sharing agent access with spending limits. Schema leaves room for budget fields from Phase A. | Grove Cloud / multi-operator rollout          |
| Task dependency resolution       | Paperclip pattern (`blockedByIssueIds` with auto-wake). Useful even in Grove Local — manual queue curation doesn't scale past ~10 active tasks. Schema leaves room for `blocked_by_task_id` edges from Phase A. | Post-Phase A, before task list grows large    |

---

## 11. Open questions

Questions the design does not yet resolve. Each has a proposed owner and a phase gate.

### Tier 2 semantic divergences (beyond v2 scope)

1. **Cross-operator ordering.** When two operators act on the same task simultaneously at Tier 2, whose change wins? Not a v2 concern (single-operator v1), but the design must not preclude an answer.
   - *Owner:* next designer. *Gate:* before Tier 2 multi-operator rollout.
2. **Rate limiting at Tier 2.** Per-operator WebSocket throttling, D1 write backpressure.
   - *Owner:* Tier 2 implementer. *Gate:* Tier 2 rollout.
3. **Notification fan-out at Tier 2.** How a state change on a shared task fans out to multiple operators.
   - *Owner:* Tier 2 implementer. *Gate:* Tier 2 rollout.

### Implementation details that Phase 4 deferred to code

4. **Exact WebSocket protocol** (message envelope, error semantics, reconnect backoff). Borrow from Maestro's IPC contract where shapes match.
   - *Owner:* Phase C implementer. *Gate:* before Phase C code lands.
5. **Event log virtualisation strategy** — rough heuristic is "last 20 events hot, lazy-load older on scroll", but library choice and pre-fetch sizing are code decisions.
   - *Owner:* Phase B implementer. *Gate:* before Phase B code lands.
6. **`block_reason` extensibility beyond the three kinds in §5.3.1.** The tagged union in §5.3.1 names `permission.request`, `tool.error`, and `review.checkpoint`. Additional block kinds (e.g., `quota.exceeded`, `subagent.handoff`) are not specified yet. Adding one is a single row in the §5.3.1 schema + a branch in §4.2's `shouldNotify`.
   - *Owner:* Phase A implementer (schema), any later phase for new kinds. *Gate:* before the attention view binds to a new kind.

### Open but not blocking

7. **Task priority authority.** Who sets `priority`? Today, the operator types it when adding a task to the queue. Future: could be inherited from the source issue's label (`now`/`next`/`future`), or computed. Not v1 blocker.
8. **Persistent input queue.** v1 queue is browser-state (§6.3). If an operator reloads mid-type, queued items are lost. Acceptable for v1; revisit if operators hit the limitation.
9. **Attention-item dismissal semantics.** When an assignment transitions out of `blocked`, its card clears automatically. What if the operator wants to snooze a card without resolving the underlying block? No answer yet; no one has asked for it yet.
10. **CC stream-json permission event support.** Does CC emit a structured `permission.request` event in `--output-format stream-json` output and accept an approval response via `--input-format stream-json` stdin? Neither Maestro nor Paperclip has tested this path — both bypass permissions entirely (§5.3.1, §7.6). **Phase A verification task:** spawn a CC process in stream-json mode, trigger a permission prompt (e.g., a `tool.bash` that needs approval), and inspect the output for a structured permission event. If CC does not support it, ship with yolo mode as default; the `permission.request` schema and UI rendering ship regardless as a placeholder.
   - *Owner:* Phase A implementer (PR A3). *Gate:* before Phase C input-return code assumes permission events exist.

---

## 12. Attribution

Every major claim in this doc traces back to one of:

- **A of Andreas's 8 concerns** (`Plans/design-sprint-mc/02-concerns.md`)
- **A Phase 3 decision** (`Plans/design-sprint-mc/03-decisions.md`)
- **A research source** from the Phase 1 source map (`01-source-map.md`)
- **A cited reference implementation** (`~/Developer/miner`, `~/Developer/maestro`, `~/Developer/paperclip`)

Specific anchors:

- §2 (Core operator flow) — Concerns 4, 5, 7
- §3 (Task funnel) — Concerns 2, 3; Conflicts 3, 4
- §4 (Notifications) — Concerns 1, 8; Conflict 1
- §5 (Attention view) — Concern 4; miner inspection report; Paperclip `assistant-ui` library
- §6 (Operator input) — Concern 5; Maestro inspection report (2026-04-16 code audit)
- §6.6 (Session compaction) — Paperclip heartbeat service session rotation policy
- §7 (Architecture) — Conflicts 2, 5, 6
- §7.6 (Reference implementations) — Maestro, Paperclip, miner pattern audit (2026-04-16)
- §8 (Dashboard layout) — Concern 7
- §9 (Phase order) — all; local-only development posture from v1/v2 isolation decision
- §10 (Deferred) — explicit non-goals across concerns; Paperclip-borrowed patterns deferred to post-Phase A
- §11 (Open questions) — Phase 3 items intentionally parked; Q10 CC permission verification from Maestro/Paperclip audit

This is the v2 contract. Phase 5 verifies every claim. Phase 6 commits the sprawl retirement.
