# Live Session Activity Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-session-activity.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for live session activity on the dashboard. Iterations are logical vehicles, not timeboxes — this ships when the work is done.

**Mission:** The dashboard shows what agents are doing right now — file edits, commands, subagents, progress — the same richness Discord worklog threads get.
**Scope:** Activity buffer in state, session detail view, activity previews on cards
**Design Spec:** `docs/design-session-activity.md`
**Prerequisite:** G-202 (dashboard) ✅, G-204b (repo-aware UI) ✅

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Activity Buffer (G-205a)

### Data Model

- [x] Add `SessionActivity` type to `src/dashboard/types.ts`
- [x] Add `activity: SessionActivity[]` field to `AgentTask` in `src/bot/lib/dashboard-state.ts`
- [x] Add `activity` to dashboard `AgentTask` type in `src/dashboard/types.ts`

### Event Extraction

- [x] Add `extractActivityEntry()` to `src/bot/lib/event-utils.ts`
- [x] Handle `tool.file.changed` → filename
- [x] Handle `tool.bash.executed` → command preview (filter noisy: cat, echo, ls, pwd, cd)
- [x] Handle `tool.agent.spawned` → agent description
- [x] Handle `tool.todo.updated` → progress + active task

### State Integration

- [x] `handleProgressEvent()` appends activity entries
- [x] `handleTaskStarted()` initializes empty activity array
- [x] Buffer capped at 50 entries per session
- [x] Activity included in snapshot (WebSocket + REST)
- [x] Rehydrate replays activity from published events

### Acceptance

- [x] API response includes activity array for active sessions
- [x] WebSocket pushes include activity updates in real-time
- [ ] Tests for `extractActivityEntry()` covering all event types

---

## Session Detail View (G-205b)

### Navigation

- [x] Add `{ type: "session"; sessionId: string }` to `DashboardView`
- [x] `ActiveCard` clickable → navigates to session detail
- [x] Unattributed session rows clickable → navigates to session detail
- [x] Repo card session overlays clickable → navigates to session detail
- [x] Breadcrumb navigation back to previous context

### UI

- [x] `SessionDetailView` component with full activity timeline
- [x] Agent header: avatar, name, project badge, elapsed time
- [x] Description section: user's original prompt
- [x] Activity timeline: scrollable list of activity entries with timestamps
- [x] Progress bar (if todo events present)
- [x] Footer: event count, last event type, GitHub issue link
- [x] Mobile-friendly layout

### Real-time

- [x] Timeline updates live on WebSocket snapshot push
- [x] New entries appear at bottom of list
- [ ] 💪 Auto-scroll to latest entry when near bottom

### Acceptance

- [x] Clicking any session card navigates to detail view
- [x] Activity timeline matches Discord worklog thread content
- [x] View updates in real-time without manual refresh
- [x] Back navigation returns to correct previous view

---

## Activity Preview on Cards (G-205c)

### Active Cards

- [x] Show 3 most recent activity entries below description
- [x] Each entry: icon + detail + relative timestamp
- [x] Updates in real-time as new events arrive

### Unattributed Session Rows

- [x] Show latest activity entry inline after agent name and elapsed time
- [x] Format: `A  Andreas · 12m · 📝 event-utils.ts`

### Acceptance

- [x] Cards show live activity without clicking in
- [x] Activity tail doesn't break card layout on mobile
- [x] Empty activity (no events yet) shows gracefully

---

## Execution Order

```
G-205a (Activity Buffer)
  │
  ├── G-205c (Card Preview)
  │
  └── G-205b (Detail View)
```

---

## Exit Criteria

1. Active session cards show latest activity entries (not just the user's prompt)
2. Clicking a session opens a detail view with full activity timeline
3. Activity timeline updates in real-time via WebSocket
4. Dashboard activity parity with Discord worklog thread formatting
5. All four event types rendered: file changes, commands, subagents, progress
