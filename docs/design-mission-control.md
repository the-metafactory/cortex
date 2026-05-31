# Cortex Mission Control — v3

**Status:** Living design reference for the shipped Mission Control surface (`src/surface/mc/`). Describes what Mission Control IS today in cortex, reverse-engineered from the implementation. The grove-v2 design-process origins of this surface are preserved in the [History](#history--mission-control-v2-grove-v2-origins) appendix.
**Surface:** M7 — `src/surface/mc/` (the principal's collaboration cockpit, per `docs/architecture.md` §9).
**Updated:** 2026-05-27 (vocabulary-migration rewrite, cortex#436 / PR-R13e).

> **Vocabulary note.** This surface is mid-way through the principal-vocabulary migration (cortex#436). This doc uses the **canonical `principal` terms** throughout. A handful of code symbols are still being renamed in lockstep PRs and may lag the doc until they land: the task / session owner columns → `principal_id` (PR-R2b, cortex#447), the sovereignty column → `home_principal` (PR-R2.J, cortex#448), and the curation / input event kinds → `principal.input` / `principal.curation` (producers in PR-R2b, frontend consumers in PR-R13d, cortex#450). Where this doc names those symbols it uses the post-rename canonical form.

---

## 1. Goal and non-goals

### 1.1 Goal

Cortex Mission Control is **the principal's cockpit for running many agents against a curated backlog**. One principal, many agents, many tasks, one dashboard. The core job of the dashboard is: **surface the agent that needs the principal right now, and let the principal unblock it without leaving the UI.**

Three properties follow from that job:

1. **Visibility.** The principal can see, at a glance, which agents need attention and which are making progress on their own.
2. **Drill-down.** Any attention item opens into a rich view of the agent's current task: summary, time-descending event log, input affordance.
3. **Action return.** The principal can respond from the UI — text and screenshot — and the agent continues. The principal never has to drop into the terminal to unblock an agent.

Beyond the visible cockpit, Mission Control is also:

- **A task funnel.** Source backlogs (GitHub issues, PRs) are upstream of a curated internal queue. Not every issue becomes agent work; the principal decides what enters the queue.
- **An iteration-planning kanban.** GitHub issues are imported into iterations and moved through planning columns (inbox → designing → ready → shipped).
- **A notification system.** When something exceptional happens outside the principal's current view, Discord gets pinged with a deep link back into the dashboard.
- **A local-first service with a cloud sibling.** Locally it runs as a single-process Bun app over SQLite; in the cloud the same data surface is served by a Cloudflare Worker over D1.

### 1.2 Non-goals

- **Multi-principal runtime as a first-class local feature.** The local surface is single-principal. The cloud (Worker + D1) surface carries `principal_id` / `home_principal` columns for multi-principal federation, but the local runtime is single-principal.
- **Spawn-backed execution.** Local execution uses `Bun.spawn`. The preserved Spawn integration design lives in `docs/design-spawn-integration.md`.
- **Phone push / OS desktop notifications.** Discord is the only notification sink.
- **A pluggable `TaskSource` abstraction.** One concrete GitHub path via the `sourceRef` triple.
- **A classifier / notification-router service.** A small hardcoded priority map decides what to notify.
- **Stale-task sweepers, retry budgets, DLQ.** No background reconciliation — the principal has manual move-along controls (requeue / handoff / abandon).

---

## 2. Core principal flow

The dashboard is designed around one loop. Everything else serves it.

```
┌──────────────────────────────────────────────────────────────────┐
│  1. Principal opens the Mission Control dashboard                │
│     ↓                                                            │
│  2. Focus area: "who needs me right now"                         │
│     ↓  (or Discord ping with deep link back into the dashboard)  │
│  3. Principal clicks an attention card                           │
│     ↓                                                            │
│  4. Drill-down opens:                                            │
│        ├─ Summary header  (which agent, which task, state)      │
│        ├─ Event log       (time-descending, rich, scrollable)   │
│        └─ Input affordance (text + screenshot) + curation tools │
│     ↓                                                            │
│  5. Principal types / pastes a response (or curates)             │
│     ↓                                                            │
│  6. Input is delivered to the agent's session (queued if busy)   │
│     ↓                                                            │
│  7. Agent continues; event log updates live over the WebSocket   │
│     ↓                                                            │
│  8. Attention card clears when the agent moves on                │
└──────────────────────────────────────────────────────────────────┘
```

The critical primitive: **the drill-down is scoped to one `agent_task_assignment` row** — the link between an agent (head) and a task. "Something needs my attention" is never "an agent needs me in the abstract" and never "a task needs me in the abstract." It is always "this agent, on this task, in this state."

Three concrete examples of the loop, covering the common block shapes:

- **Error.** An agent is running on task T-42 ("fix webhook HMAC verification"); a bash tool call fails. The assignment transitions `running → blocked` with `block_reason = { kind: 'tool.error', tool_name: 'tool.bash', message: 'permission denied', exit_code: 1 }`. The focus-area card appears; Discord pings the principal. The principal opens the card, sees the failed bash in the event log, types "try running it in the src/worker dir", submits. The assignment returns to `running`; the card clears.
- **Permission request.** An agent in default-permission CC mode on task T-17 wants to edit a file. The assignment transitions `running → blocked` with `block_reason = { kind: 'permission.request', requested_action: 'tool.edit', target: '<path>', risk_hint: 'medium' }`. The card surfaces the exact edit target; Discord pings. (Approve/Deny rendering ships, but is gated on CC's stream-json permission protocol — see §6.3.)
- **Review checkpoint.** An agent on task T-51 has prepared a release draft and asks for human sign-off. The assignment is `blocked` with `block_reason = { kind: 'review.checkpoint', note: 'release draft ready' }`. The principal reads the draft in the event log, pastes a screenshot, types "approved, ship it", submits. The assignment goes `running`; the card clears.

All three go through the same primitive: **assignment state change → attention item appears → drill-down shows context → principal action (input or approve/deny) → assignment state change.**

---

## 3. The task funnel

The task is the vessel for orchestration in Mission Control. Everything else hangs off it.

### 3.1 What a task is

A task is a **first-class object that references a source system**. Mission Control's orchestration history — the queue, the state machine, the sessions, the events — lives against the task row. The source system (GitHub issue or PR) is authoritative for its own state, but is not where Mission Control tracks orchestration.

### 3.2 Task schema (`tasks`, local SQLite)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Mission Control-internal ID |
| `title` | TEXT NOT NULL | |
| `description` | TEXT | |
| `priority` | INTEGER | P0..P3 |
| `principal_id` | TEXT | the owning principal (see vocabulary note) |
| `source_system` | TEXT | `'github'` \| `'internal'` |
| `source_url` | TEXT | canonical URL, nullable |
| `source_external_id` | TEXT | issue / PR number, nullable |
| `related_refs_json` | TEXT | JSON array of `{system, url, external_id}` triples — display only |
| `status` | TEXT | `'open'` \| `'in_progress'` \| `'done'` \| `'cancelled'` |
| `iteration_id` | TEXT FK | nullable; links a task to an iteration (§3.5) |
| `created_at` / `updated_at` | INTEGER | epoch ms |

The `source_system` / `source_url` / `source_external_id` triple is the flat `sourceRef`. Throughout this doc, "sourceRef" is the conceptual name for the triple; the physical columns are the three separately named fields above.

**Reuse of existing GitHub tables.** GitHub entities are tracked via `repos`, `issues`, `pull_requests`, and `github_events` (in the Worker D1 schema), updated by the webhook → ingest pipeline. The task row does **not** duplicate issue or PR data — it joins via `source_external_id` for display.

### 3.3 Assignment schema (`agent_task_assignment`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `task_id` | TEXT FK → `tasks.id` | |
| `agent_id` | TEXT FK → `agents.id` | |
| `state` | TEXT | `queued` \| `dispatched` \| `running` \| `blocked` \| `completed` \| `failed` \| `cancelled` |
| `block_reason` | TEXT (JSON) | structured, present when `state = blocked` (§6.3) |
| `created_at` / `updated_at` | INTEGER | |

Agent ↔ task is **many-to-many**: an agent can hold assignments on multiple tasks; a task can carry assignments from multiple agents. **The state machine lives on the assignment row, not on the task and not on the agent.**

```
agents ───┐                   ┌─── tasks
          │                   │
          └─► agent_task_assignment ◄─┘   (state machine here)
                      │
                      └─► sessions (0..N per assignment)
```

`sessions` rows point up to an assignment. Session lifecycle events mutate assignment state; they do not mutate task state directly.

### 3.4 The funnel

```
source backlogs              curated queue            dispatch              work
────────────────────         ──────────────           ─────────────         ────────
GitHub issues      ─┐        tasks                   agent_task_           sessions
GitHub PRs          ├──▶     (principal curated)─▶   assignment       ──▶  (CC runs)
internal notes     ─┘        priority-ordered        state machine
```

**The principal decides what enters the queue.** Not every GitHub issue becomes a task. `POST /api/tasks/preview` then `POST /api/tasks` create a task row with a `sourceRef` pointer (the `+ Add task` affordance at the top of the task table; URL / `owner/repo#N` / `#N` shorthand accepted, GitHub fetched via the `gh` CLI). The queue is a subset of the source backlog, curated by hand.

The "curation UX" is the task view itself. Opening a task opens the drill-down for that task's primary assignment (§5). Detailed feature designs: the task-table design (`docs/design-mc-f8-task-table.md`), the task-curation design covering manual dispatch / requeue / handoff / abandon, and the add-to-queue design.

### 3.5 Iterations (`iterations`)

Mission Control also owns an **iteration-planning kanban** (detailed in `docs/design-mc-iteration-planning.md`). The `iterations` table carries `id`, `title`, `body`, `imported_body`, `priority`, a lifecycle `state` (`inbox` \| `designing` \| `queued` \| `in_flight` \| `blocked` \| `done` \| `cancelled`), `source_system` / `source_url` / `source_parent_ref`, and timestamps. Iterations are imported from GitHub (`POST /api/iterations/from-github`, plus a `POST /api/github/webhook` path); their lifecycle is owned locally and is not synced back upstream. Tasks attach to iterations via `tasks.iteration_id`.

---

## 4. Notification system

Notifications are a **requirement layered on top of the dashboard attention core**. The dashboard visual attention indicator (§5, §8) is the foundation; push is additive. If push is paused or swapped, the core does not move. Detailed design: `docs/design-mc-f11-discord-notifications.md`.

### 4.1 Channels

**Discord only** (DM + channel post). No OS desktop notifications, no phone push. Rationale: Discord is already shipped — the existing `DiscordAdapter` is reused as the sink; no new bot, no new token.

### 4.2 Routing

A **small hardcoded priority map** decides what to notify — no classifier service, no router abstraction. It branches on the assignment state transition and the `block_reason.kind`:

```ts
function shouldNotify(event: AssignmentStateChange): NotificationIntent | null {
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

The map is promoted to a data-driven classifier only when it is observably wrong in interesting ways. "Don't build a traffic-shaping system before there is traffic."

### 4.3 Opt-in + deep links

Discord notifications are off by default and toggled in config. Every notification includes a deep link back into the dashboard, opening to the relevant attention card:

```
{baseUrl}/?focus=assignment/{assignment_id}
```

Locally `baseUrl` is the loopback origin; in the cloud it is the public origin (`grove.meta-factory.ai`). LAN / cross-device reading of a loopback link is not supported locally; the cloud surface is the path for phone access.

---

## 5. Agent attention view (drill-down)

The drill-down (`components/drill-down.tsx`, F-7) is scoped to exactly one `agent_task_assignment` row (§3.3). It renders the head (agent), the task, the current hands run (session), the event log, the curation toolbar (§3, §7), and the principal's input affordance (§6). Detailed design: `docs/design-mc-f7-attention-view.md`.

### 5.1 Layout

Three vertical sections, top to bottom:

```
┌──────────────────────────────────────────────────┐
│  ① Summary header  (task + iteration chip)        │
│     agent × T-42 "fix webhook HMAC verification"  │
│     State: blocked  ·  waiting on: tool.bash      │
├──────────────────────────────────────────────────┤
│  ② Time-descending event log  (virtualised)       │
│     [newest]                                      │
│     ├─ principal: "try running it in src/worker"  │
│     ├─ tool.bash: exit 1 — "permission denied"    │
│     ├─ assistant: "I'll run the tests next..."    │
│     │  ⋯ scroll for older events ⋯                │
│     [oldest]                                       │
├──────────────────────────────────────────────────┤
│  ③ Curation toolbar + input affordance            │
│     [Dispatch] [Requeue] [Handoff] [Abandon]      │
│     ┌──────────────────────────────────────────┐ │
│     │ [text box — drag/drop/paste images]      │ │
│     └──────────────────────────────────────────┘ │
│     [📎 attach]  [↩ submit]      queue: 0 items   │
└──────────────────────────────────────────────────┘
```

Global keys in the drill-down: `Esc` close, `]` / `[` cycle assignments, `f` toggle focus mode.

### 5.2 Summary header

Collapsed default shows agent name, task title, current state, and a one-line block reason when blocked. When the assignment is `blocked`, the summary uses the agent's explicit `block_reason` (part of the block protocol — no guessing). When `running`, it is inferred from recent events. The summary is **scaffolding, not a source of truth** — the event log below is authoritative.

### 5.3 Event log

Time-descending, newest at the top, full session history, hand-rolled virtualisation (default viewport renders the most recent events, older lazy-loaded on scroll). Events are rendered by `lib/event-rows.ts` and `components/drill-log.tsx`. Event rows carry a **D/A/H colour classification** (borrowed from the miner process-mining dashboard):

| Class | Colour | Sources |
|-------|--------|---------|
| **D — Deterministic** | purple | `stream-json.assistant` text blocks, non-blocking `state.transition` |
| **A — Agentic** | blue | `tool_use`, `tool_result` |
| **H — Human** | gold | `principal.input` |

Event-kind rendering, as implemented today:

- **`principal.input`** — the principal's authored turn; text rendered as markdown, images as a click-to-enlarge lightbox. (H, gold.)
- **`stream-json.assistant`** — Claude message blocks: text (markdown), thinking (collapsible with preview), tool_use / tool_result (paired, collapsible).
- **`stream-json.user`** — suppressed when a `principal.input` row is present (the `principal.input` row is the human source of truth).
- **`state.transition`** — state changes; blocking transitions render the block reason (expandable), non-blocking render a "from → to" chip.
- **`permission.request`** — renders the requested action / target / context / risk, with **Approve / Deny** buttons. The buttons are currently **disabled pending CC's stream-json permission protocol** (see §6.3).
- Fallback `raw` row for unknown event types.

### 5.4 Multiple attention items

Multiple items exist concurrently; one drill-down is foregrounded at a time. The focus area (§8) shows each as a card; clicking opens its drill-down as the foreground while other cards remain visible as context. Plural instances, singular focus.

---

## 6. Principal input channel

The input affordance (`components/drill-input.tsx`, F-10) lets the principal send a turn to the agent's session. Its transport pattern is borrowed from Maestro (long-lived CC process with `--output-format stream-json` + stdin-framed turns); see the [History](#history--mission-control-v2-grove-v2-origins) appendix for the original reference-implementation audit.

### 6.1 Transport

The dashboard POSTs to `POST /api/assignments/:id/input` with `{ text?, images? }`. The backend resolves the `assignment_id` to a **session endpoint** and delivers the payload. Endpoint kinds (the `sessions.endpoint_kind` column):

- **`local.process.controlled`** — a long-lived CC child process spawned by Mission Control (via its API layer's process manager). `write()` frames a stream-json message and delivers it to the process's stdin. The process stays alive between turns; `--resume` is used only for compaction or reconnection.
- **`local.observed`** — an external CC session (e.g. a `cldyo-live` terminal session) observed via the hook stream (§7.3). `write()` throws `NotControllable` — observed sessions are read-only.
- **`local.process.autonomous`** — single-turn `--print` process placeholder (stubbed; see Deferred).

The session endpoint is an abstraction boundary: every write is phrased as "look up the session endpoint for this assignment, deliver the payload," which keeps the call site stable when remote backends land.

### 6.2 Image input + queue

The input box accepts **text (≤ 50 KB UTF-8) plus images** by paste or drag-drop (PNG / JPEG / WebP / GIF, ≤ 5 MB each, ≤ 8 per message; the input endpoint allows up to 25 MB of body for image payloads). Images are sent as base64 content blocks. A small set of **canned actions** insert prompt text. Submissions are queued client-side per assignment; the next queued item is released on the assignment's `state.transition` WebSocket frame. The input is read-only in `observed`, `ended`, and `shadow` modes. Detailed designs cover the F-10 input return path and image input (`docs/design-mc-image-input.md`).

### 6.3 Permission / approval blocks

`block_reason` is a **tagged union on `kind`**:

```
block_reason (discriminated on `kind`)
  kind = 'permission.request'   → requested_action, target, context, risk_hint
  kind = 'tool.error'           → tool_name, message, exit_code
  kind = 'review.checkpoint'    → note
```

When an assignment enters `blocked` on a `permission.request`, the summary shows exactly what is being asked, and the event-log row renders **Approve / Deny**. **These buttons are currently disabled**: the interactive flow depends on CC emitting a structured `permission.request` event in `--output-format stream-json` and accepting an approval via `--input-format stream-json` stdin. Until that protocol is verified, the schema, rendering, and routing all ship (they cost nothing to carry) but approve/deny is inert; the operational posture is yolo-mode sessions plus text-based redirection. The principal's manual requeue / handoff / abandon controls (§7) are the move-along path in the meantime.

---

## 7. Curation + state machine

### 7.1 The state machine

The assignment state machine is a pure function (`state-machine.ts`) applied via `db/transitions.ts`:

| From | Action | To |
|------|--------|-----|
| `queued` | `dispatch` / `cancel` | `dispatched` / `cancelled` |
| `dispatched` | `start` / `cancel` | `running` / `cancelled` |
| `running` | `block` / `complete` / `fail` / `cancel` | `blocked` / `completed` / `failed` / `cancelled` |
| `blocked` | `resume` / `requeue` / `cancel` | `running` / `queued` / `cancelled` |
| `failed` | `requeue` | `queued` |
| `completed`, `cancelled` | — | (terminal) |

`requeue` is the principal's manual move-along — there are no automatic timers. Applying a transition validates it, writes the new `state` (and `block_reason` JSON on `block`), inserts a transition event, and returns the from/to states for the WebSocket broadcast.

### 7.2 Curation toolbar

The curation toolbar (`components/curation-toolbar.tsx`, F-12) lives inside the drill-down. Its verbs are enabled per the assignment-state matrix above:

- **Dispatch** → `POST /api/sessions { taskId }` — spawn an agent session for the task.
- **Requeue** → `POST /api/assignments/:id/requeue` — re-enqueue (the UI mirror of the `requeue` action).
- **Handoff** → `POST /api/assignments/:id/handoff` — cancel-and-respawn on a different agent (agent picker).
- **Abandon** → `POST /api/assignments/:id/abandon` (assignment) or `POST /api/tasks/:taskId/abandon` (task-terminal).

Dispatch and Requeue are fire-and-forget; Handoff and Abandon open an inline confirm. No manual refetch — `state.transition` and `principal.curation` WebSocket frames flip the button set. Curation actions are recorded as `principal.curation` events with a `kind` discriminator (e.g. `task.imported`, requeue, handoff); assignment-less curation events hang off a synthetic per-task shadow session.

---

## 8. Dashboard layout

The dashboard is a React + TypeScript SPA under `src/surface/mc/dashboard-v2/`, built with `bun build src/surface/mc/dashboard-v2/index.html --outdir dist/dashboard-v2 --target browser` (the MIG-6 cutover deleted the legacy monolithic inline-HTML dashboard; the React tree is now the only dashboard). Entry is `index.html → main.tsx → app.tsx`. There is no router; view switching is `useState<DashboardView>` over `"default" | "metrics" | "iterations" | "kanban-detail"`. The visual reference is the vendored design handoff under `docs/design-artifacts/`.

### 8.1 The default view

Header (title + theme toggle + ⌘K hint) → nav (Focus/Working/Tasks · Metrics · Iterations) → main. The default view stacks four execution-side sections:

```
┌──────────────────────────────────────────────────────────────────┐
│  MISSION CONTROL                            principal: andreas    │
├──────────────────────────────────────────────────────────────────┤
│  ① FOCUS AREA — "who needs me"                                    │
│     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│     │ agent × T-42 │  │ agent × T-51 │  │ agent × T-33 │          │
│     │ blocked      │  │ blocked      │  │ running      │          │
│     │ tool.bash x1 │  │ approval     │  │ (review req) │          │
│     │ P0 · 3m ago  │  │ P1 · 1m ago  │  │ P2 · 8m ago  │          │
│     └──────────────┘  └──────────────┘  └──────────────┘          │
│  ② WORKING AGENTS — grid below                                    │
│  ③ TASK TABLE — sliceable / sortable                              │
└──────────────────────────────────────────────────────────────────┘
```

| Panel | Component | Feature | Behaviour |
|-------|-----------|---------|-----------|
| **Focus area** | `focus-area.tsx` | F-6 | "Who needs me" — one card per blocked assignment (plus any with an input-requested signal), capped with an overflow chip. Keys `1`–`9` select, `Enter` opens drill-down. Empty state: "All clear" + most-active-agent line. Ordering is by **task priority**, not attention type. Served by `GET /api/focus-area`. |
| **Working grid** | `working-grid.tsx` | F-9 | Tiles for agents with active non-blocked assignments (`running` / `dispatched` / `queued`). Tile click opens the drill-down. Hidden when the focus row has items and the grid is empty. Served by `GET /api/working-agents`. |
| **Task table** | `task-table.tsx` | F-8 | All tasks with filters (priority bit-vector, min age, search, include-closed) and sort (priority / title / agents / state / age), persisted in URL hash (`#tasks?p=…&age=…&closed=…&q=…`, `replaceState` by default — `hooks/use-hash-state.ts`). Row click opens the drill-down on the primary assignment. |
| **Drill-down** | `drill-down.tsx` | F-7 | The attention view (§5). |

### 8.2 The other views

- **Metrics** (`metrics-panel.tsx`, F-18) — cycle-time big-numbers + wait-time stacked bar + per-agent table; default 24h window; refetched on `state.transition`. Served by `GET /api/metrics/fleet` and `GET /api/metrics/assignment/:id`.
- **Iterations** (`iteration-board.tsx`, F-14) — a drag-drop kanban with columns (backlog / designing / ready / shipped). Dragging an inbox item into "designing" creates an iteration; dragging between columns issues `PATCH /api/iterations/:id { state }`. A card opens the detail view.
- **Iteration detail** (`iteration-detail.tsx`, F-15) — a single iteration's planning surface (title, description, task list, state chips).
- **Command palette** (`command-palette.tsx`) — `⌘K`; current commands are theme toggle and help. **Toast** (`toast.tsx`) for transient messages.

---

## 9. Architecture

### 9.1 Heads, hands, and the agent model

Mission Control uses the **head / hands** agent model:

- **Head** = the agent's identity, persona, memory, skills, role. One row in the `agents` table per head (`type` is `head` or `hands`; a `persistent` flag distinguishes always-visible persistent heads from ephemeral ones).
- **Hands** = the sandboxed execution run that carries out work. Each `sessions` row is one hands run. A head can spawn 0..N hands runs.
- Mapping: `agents` row = head; `agent_task_assignment` row = "this head is assigned to this task"; `sessions` (0..N per assignment) = hands runs.

This lets Mission Control talk cleanly about backend-agnostic execution (`Bun.spawn` today, other backends later — `docs/design-spawn-integration.md`) and accommodates an agent's recursive sub-team work as additional hands activity within its own assignment, not new `agents` rows.

### 9.2 Principal as orchestrator

**The principal is the orchestrator.** The principal curates the queue, reviews attention items, sends input, moves stuck assignments, and approves dispatch. No agent holds a privileged position in the schema, the attention model, or the UI; the dashboard is agent-neutral.

### 9.3 Local + cloud composition

Mission Control runs in two compositions over **one shared data surface and shape**, with honestly-different runtime:

| Aspect | Local | Cloud |
|--------|-------|-------|
| Runtime | single-process Bun app (`index.ts` → `server.ts`) on `127.0.0.1:8767` | Cloudflare Worker (`worker/`) at `grove.meta-factory.ai/api/*` |
| Store | `bun:sqlite` (`~/.local/share/grove/mission-control.db`) | D1 (binding `GROVE_DB`) |
| API | `/api/*` + `/ws` WebSocket (protocol v1) + `/health` on the Bun server | `/api/*` on the Worker (Hono); ingest via `POST /api/ingest` |
| Auth | none (single-principal, loopback-only bind) | CF Access; principal-scoped |
| Notifications | in-process Discord sink | per-principal routed |

There is **no shared `grove-db` adapter layer** — the local server owns its `bun:sqlite` access directly (`db/`), the Worker owns raw D1 SQL (`worker/src/routes/*`); they share the `/api/*` shape, not an implementation. The Worker schema is a **denormalised snapshot** focused on dashboard rendering, not a mirror of the local schema (one-way ingest: local → cloud).

> **Path namespace.** The MC config and DB paths still use the legacy `grove` namespace (`~/.config/grove/mission-control.yaml`, `~/.local/share/grove/mission-control.db`, D1 binding `GROVE_DB`, host `grove.meta-factory.ai`). The grove→cortex namespace/DNS rename is a separate migration concern from the principal-vocabulary rename (cortex#436) and is tracked in `docs/plan-cortex-migration.md`; the paths above are accurate as of this writing.

### 9.4 Data model summary

```
┌────────┐     ┌───────────────────────┐     ┌───────┐     ┌────────────┐
│ agents │────▶│ agent_task_assignment │◀────│ tasks │────▶│ iterations │
└────────┘     └───────────────────────┘     └───────┘     └────────────┘
   head           link row (STATE MACHINE)       │ joined to GitHub
                          │                       ▼  (issues / pull_requests /
                          ▼                  ┌──────────┐  repos — Worker D1)
                     ┌──────────┐            │  issues  │
                     │ sessions │            │   ...    │
                     └──────────┘            └──────────┘
                      hands runs
                          │
                          ▼
                     ┌──────────┐  unified stream: stream-json.*,
                     │  events  │  principal.input, principal.curation,
                     └──────────┘  state.transition, permission.request, …
```

Local tables: `tasks`, `agents`, `agent_task_assignment`, `sessions`, `events`, `iterations`. The Worker D1 adds the snapshot/GitHub/auth tables: `sessions` (denormalised, with `classification` / `data_residency` / `home_principal` sovereignty fields added by migration `0003_sovereignty.sql`), `github_events`, `repos`, `issues`, `pull_requests`, `usage_snapshots`, `session_activity`, `audit_log`, `users`, `agents`, `agent_grants`.

### 9.5 Components

```
┌─────────────────────────────┐
│  Dashboard (browser, React)  │  src/surface/mc/dashboard-v2/
│  Focus · Working · Tasks ·   │
│  Drill-down · Metrics ·      │
│  Iterations                  │
└──────────────┬──────────────┘
               │ WebSocket /ws (protocol v1) + /api/*
               ▼
┌─────────────────────────────┐     ┌──────────────────────┐
│  MC server (Bun)            │────▶│  Discord (sink)      │
│  server.ts · API handlers   │     └──────────────────────┘
│  ws/ (broadcast) ·          │
│  state-machine.ts ·         │
│  session/ (endpoint write)  │────▶  bun:sqlite (db/)
│  hooks/ (event ingest)      │
└─────────────────────────────┘
```

The WebSocket protocol (`ws/types.ts`, `WS_PROTOCOL_VERSION = 1`):

- **Server → client:** `connected`, `state.transition`, `event`, `iteration.created` / `iteration.updated` / `iteration.detail_updated` / `iteration.state_changed`, `task.updated`, `subscribed`, `ping` / `pong`, `error`.
- **Client → server:** `subscribe` (optional `assignmentIds[]`), `ping` / `pong`.

The dashboard reconnects every ~2 s on disconnect; the server pings every ~30 s. JSON bodies are capped at 128 KB (25 MB on the input endpoint for images).

### 9.6 Event ingest

Mission Control ingests events from CC sessions; it does **not** subscribe to the NATS bus directly (that integration lives in cortex's `src/bus/` + `src/taps/`).

- **Local:** a hook poller (`hooks/poller.ts`) reads JSONL from `~/.claude/events/raw/` on an interval (default 2000 ms) with its own cursor; the ingestor (`hooks/ingestor.ts`) groups events by `cc_session_id`, inserts them into `events`, and broadcasts. **F-20 auto-transitions** for `local.observed` sessions: the first event while `dispatched` fires `start` (→ `running`); a `Stop` / `SessionEnd` while `running` fires `complete` (→ `completed`). Detailed design: `docs/design-mc-f20-observe.md`.
- **Cloud:** `POST /api/ingest` accepts `{ principal_id, events }`, normalises via the shared event-processor, and persists to D1; sovereignty fields (`classification`, `data_residency`, `home_principal`) are extracted from the myelin envelope when present.

---

## 10. Deferred capabilities

| Capability | Why deferred |
|------------|--------------|
| Multi-principal local runtime | local is single-principal; cloud carries `principal_id` / `home_principal` for federation |
| Spawn-backed execution | Spawn not ready — design preserved in `docs/design-spawn-integration.md` |
| Phone push / OS desktop notifications | Discord-only sink |
| `TaskSource` interface | one concrete GitHub path |
| Classifier / router service | the hardcoded map suffices until observably wrong |
| Stale-task sweepers / DLQ | manual requeue / handoff / abandon controls |
| Interactive Approve/Deny | gated on CC's stream-json permission protocol (§6.3) |
| `local.process.autonomous` heartbeat mode | stubbed endpoint kind; for future fire-and-forget batch dispatch |
| Budget enforcement, task-dependency auto-wake | schema leaves room; not yet enforced |
| Durable (cross-reload) input queue | the queue is browser state today |

---

## 11. Open questions

1. **Cross-principal ordering / rate-limiting / fan-out (cloud).** When multiple principals act on a shared task at the cloud tier, the conflict, throttling, and notification-fan-out semantics are unspecified. Not a local-runtime concern.
2. **CC stream-json permission support.** Does CC emit a structured `permission.request` event and accept an approval via stream-json stdin? Until verified, Approve/Deny is inert (§6.3).
3. **`block_reason` extensibility.** Adding a fourth `kind` (e.g. `quota.exceeded`) is a single schema row plus a `shouldNotify` branch.
4. **Task priority authority.** Today the principal sets `priority`; it could later be inherited from the source issue's label.

---

## History — Mission Control v2 (grove-v2) origins

<!-- historical: do not modernise -->

> This appendix preserves the provenance of the Mission Control surface. The text and design decisions below describe the system cortex migrated **from** — grove-v2's "Mission Control v2" design — and are retained for historical continuity. Do not modernise this section; the operator→principal and grove→cortex vocabularies are intentionally left in their original form here.

**Provenance.** This document descends from `the-metafactory/grove-v2` `docs/design-mission-control.md`, lifted into cortex at **MIG-7.11** of the grove-v2 → cortex migration (lifted 2026-05-11). The original was a design spec dated 2026-04-15, driven by Andreas, the single source of truth for **Grove Mission Control v2**, with every claim traced to one of Andreas's 8 concerns or a cross-doc conflict resolution in the design sprint's `03-decisions.md`. The body above is the current-tense Cortex Mission Control v3 description that replaces it; this appendix records where the design came from and how the shipped system diverged from the original v2 intentions.

**Original framing (grove-v2 v2 design).** Grove Mission Control was framed as "the operator's cockpit for running many agents against a curated backlog" — one operator, many agents, one dashboard. The v2 design was structured around two runtime tiers: **Tier 1** (local single-operator Bun + SQLite) and **Tier 2** (cloud multi-operator CF Worker + D1), with the explicit goal that Tier 2 be "a runtime change, not a redesign." The vocabulary throughout used "operator" for the human running the stack; cortex's vocabulary migration (cortex#436) renames that concept to "principal."

**Reference-implementation audits (2026-04-16).** The v2 design borrowed citable patterns from three external systems:

- **Maestro** (`~/Developer/maestro`, Electron CC IDE) — the closest architectural match. Borrowed: long-lived CC process with `--output-format stream-json` (no `--print`); `ProcessManager` holding `Map<sessionId, ManagedProcess>`; stdin-framed multi-turn input via `buildStreamJsonMessage`; the renderer→main→stdin IPC bridge (a WebSocket in Mission Control's case); `--resume` only for reconnection, not turn continuity; paste / drag-drop image input; the client-side `executionQueue`. Not borrowed: permission-prompt handling (Maestro runs yolo-mode) and multi-agent orchestration.
- **Paperclip** (`~/Developer/paperclip`, queue-based orchestrator) — its single-turn heartbeat execution model (`--print` + `stdin.end()`) was **not** borrowed, but its operational patterns were: session compaction (max turns / tokens / age), `block_reason` decomposition, per-session cost tracking, workspace-scoped config.
- **Miner** (`~/Developer/miner`, PAI process-mining dashboard) — contributed the attention-view rendering patterns: the three-section layout (summary / event log / input), the **D/A/H colour classification** (Deterministic / Agentic / Human), and the extractive (non-generative) summary header.

**Divergences — how the shipped v3 differs from the v2 design.** Several v2 design intentions did not ship as written; the body above reflects what actually exists:

- **No `src/common/grove-db/` shared adapter layer.** The v2 design (its §7.3) chose "Option A": a shared data-access module with `SqliteAdapter` and `D1Adapter` so new tables would land through one layer. This was never built. The shipped system keeps direct `bun:sqlite` access locally and raw D1 SQL in the Worker, sharing only the `/api/*` shape — the duplication the v2 design hoped to avoid.
- **`src/mission-control/` became `src/surface/mc/`.** The v2 design's standalone `src/mission-control/` module (developed on a `v2` branch in a `Grove-v2` worktree, isolated from v1 on `main` — see the archived `v1-to-v2-cutover.md`) was re-homed under cortex's M7 `src/surface/mc/` at the migration.
- **The "Tier 1 / Tier 2" framing became "local / cloud."** The shipped split is the same in spirit (Bun+SQLite vs Worker+D1) but the cloud surface is a denormalised one-way snapshot, not the symmetric multi-principal runtime the v2 design anticipated.
- **Features the v2 design did not include shipped anyway.** The iteration-planning kanban (`iterations` table, F-13/F-14/F-15), the metrics panel (F-18), the command palette, the explicit `cancelled` assignment state, and the F-20 observed-session auto-transitions are all part of v3 but post-date the original v2 spec.
- **Interactive Approve/Deny never activated.** The v2 design made `permission.request` a first-class `block_reason` kind with inline approve/deny; the buttons ship but remain disabled pending CC's stream-json permission protocol (Phase A verification item that did not resolve).

**Original phase plan (grove-v2 v2).** The v2 design sequenced delivery as Phase A (data foundation + local bot scaffold), Phase B (dashboard attention core), Phase C (operator input return), Phase D (Discord notifications), Phase E (task curation UX), with Tier 2 as a cross-phase runtime change rather than a phase. The shipped v3 covers all of these (the local surface, the attention/drill-down core, the input channel, Discord notifications, and the curation toolbar) plus the iteration/metrics surfaces noted above.

**Attribution (original).** Every major claim in the original v2 doc traced to one of Andreas's 8 concerns (`Plans/design-sprint-mc/02-concerns.md`), a Phase 3 decision (`03-decisions.md`), a research source (`01-source-map.md`), or a cited reference implementation (miner / maestro / paperclip). The companion feature-level design docs (`docs/design-mc-f6-focus-area.md` through `docs/design-mc-f20-observe.md`, the React-migration doc, the image-input doc, and the F-10 input-return doc) carry the per-feature resolutions and remain the detailed source for each capability.
