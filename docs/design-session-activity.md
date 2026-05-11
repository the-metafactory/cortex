# Live Session Activity — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-session-activity.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Feature ID:** G-205
**Scope:** Per-session activity timeline on dashboard, clickable session cards, Discord parity
**Mission:** The dashboard shows what agents are *doing* right now — not just that they're active. File edits, commands, subagents, progress — the same richness Discord worklog threads get.
**Stack:** Existing Bun.serve() API, React dashboard, WebSocket push
**Prerequisite:** G-202 (dashboard) ✅, G-204b (repo-aware UI) ✅

---

## Why This Exists

The dashboard currently shows agent sessions as static cards with:
- The user's prompt (set once at session start, never updated)
- An event counter (just a number)
- The last event *type* name (e.g., `"tool.file.changed"` — no detail)
- Optional progress bar (from todo events)

Meanwhile, Discord worklog threads show rich, real-time activity:
- `📝 event-utils.ts` — file changed
- `💻 \`bun test src/bot/lib/\`` — command executed
- `🤖 → explore test failures` — subagent spawned
- `📋 3/6 Fix attribution logic` — progress updated

The same published events power both. Discord gets the formatted detail via `formatEventForThread()`. The dashboard throws it away in `handleProgressEvent()`, incrementing counters only.

This is a parity gap, not a new feature. The data is already flowing — the dashboard just isn't storing or displaying it.

---

## Features

### G-205a: Session Activity Buffer

Store recent activity entries per active session in `DashboardState`.

**Data model — new type:**

```typescript
interface SessionActivity {
  timestamp: string;
  icon: string;       // "📝", "💻", "🤖", "📋"
  label: string;      // "file changed", "command", "subagent", "progress"
  detail: string;     // "event-utils.ts", "bun test src/bot/lib/", etc.
}
```

**State change — `DashboardState`:**

```typescript
// Existing
interface AgentTask {
  // ... existing fields ...
  // ADD:
  activity: SessionActivity[];  // most recent N entries (capped at 50)
}
```

**Event processing — `handleProgressEvent()`:**

Currently increments counters only. Change to also extract and append an activity entry:

```typescript
private handleProgressEvent(event: PublishedEvent): boolean {
  // ... existing counter logic ...

  // NEW: extract activity entry from event payload
  const entry = extractActivityEntry(event);
  if (entry) {
    task.activity.push(entry);
    if (task.activity.length > 50) {
      task.activity = task.activity.slice(-50);
    }
  }

  return true;
}
```

**Activity extraction — new function in `event-utils.ts`:**

Mirrors the logic in `worklog-formatter.ts::formatEventForThread()` but returns structured data instead of Discord markdown:

```typescript
export function extractActivityEntry(event: PublishedEvent): SessionActivity | null {
  switch (event.event_type) {
    case "tool.file.changed": {
      const path = event.payload.path ? String(event.payload.path) : null;
      if (!path) return null;
      const filename = path.split("/").pop() ?? path;
      return { timestamp: event.timestamp, icon: "📝", label: "file changed", detail: filename };
    }
    case "tool.bash.executed": {
      const cmd = String(event.payload.command_preview ?? event.payload.command ?? "");
      if (!cmd || /^(cat|echo|ls|pwd|cd)\s/.test(cmd)) return null;
      return { timestamp: event.timestamp, icon: "💻", label: "command", detail: truncate(cmd, 100) };
    }
    case "tool.agent.spawned": {
      const desc = String(event.payload.agent_description ?? event.payload.summary ?? "");
      if (!desc) return null;
      return { timestamp: event.timestamp, icon: "🤖", label: "subagent", detail: truncate(desc, 100) };
    }
    case "tool.todo.updated": {
      const summary = event.payload.todo_summary as { total?: number; completed?: number } | undefined;
      const task = event.payload.active_task ? String(event.payload.active_task) : "";
      const progress = summary ? `${summary.completed ?? 0}/${summary.total ?? 0}` : "";
      return { timestamp: event.timestamp, icon: "📋", label: "progress", detail: [progress, task].filter(Boolean).join(" ") };
    }
    default:
      return null;
  }
}
```

**Snapshot inclusion:**

The `AgentTask` in the snapshot already includes all fields. Adding `activity: SessionActivity[]` means WebSocket pushes automatically include the timeline. No API changes needed — `GET /api/state` and WebSocket snapshots already serialize the full `AgentTask`.

**Buffer lifecycle:**
- Activity accumulates while the session is active
- On completion, activity is discarded (completed sessions show summary only)
- On rehydrate, activity is replayed from published events (existing mechanism)
- Cap at 50 entries per session (most recent kept)

### G-205b: Session Detail View

Clickable session cards that expand to show the live activity feed.

**Navigation — add to `DashboardView`:**

```typescript
export type DashboardView =
  | { type: "home" }
  | { type: "repo"; repoName: string }
  | { type: "issue"; repoName: string; number: number }
  | { type: "pr"; repoName: string; number: number }
  | { type: "agent"; agentName: string }
  | { type: "session"; sessionId: string };  // NEW
```

**Session detail layout:**

```
← grove / Andreas
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  A  Andreas · Grove · 12m
     "Update yourself with what's happening on this repo"

  ACTIVITY (14 events)
  ┌──────────────────────────────────────┐
  │ 📝 event-utils.ts              2m   │
  │ 💻 bun test src/bot/lib/       3m   │
  │ 🤖 → explore test failures     5m   │
  │ 📋 3/6 Fix attribution logic   7m   │
  │ 📝 dashboard-state.ts          8m   │
  │ 💻 git diff --stat             9m   │
  │ 📝 app.tsx                     11m  │
  └──────────────────────────────────────┘

  Progress  ████████░░░░  3/6 tasks
  Events: 14 · Last: tool.file.changed
  Issue: #46 ↗
```

**Clickable surfaces — make session cards navigable:**

1. **Active cards** (`ActiveCard` component, line 123): Add `onClick={() => navigate({ type: "session", sessionId: task.sessionId })}` and `cursor-pointer`

2. **Unattributed session rows** (line 1265): Wrap in `<button>` with same navigation

3. **Repo card session overlays** (line 389): Add click handler that navigates to session detail

**Real-time updates:**

The session detail view re-renders on each WebSocket snapshot push. Since `activity` is part of `AgentTask` in the snapshot, the timeline updates live as the agent works — no polling needed.

**Back navigation:**

Breadcrumb pattern matching existing drill-downs:
- From home: `Home / Session`
- From repo: `Repos / grove / Session`
- From agent: `Agents / Luna / Session`

### G-205c: Activity Preview on Session Cards

Even without clicking in, session cards should show the latest activity — not just the user's prompt.

**Active card enhancement:**

Below the description (user's prompt), show the 3 most recent activity entries:

```
┌──────────────────────────────────────────┐
│ 🏃 Andreas · Grove                  12m │
│ "Update yourself with what's happening"  │
│                                          │
│ 📝 event-utils.ts                    2m  │
│ 💻 bun test src/bot/lib/            3m  │
│ 🤖 → explore test failures          5m  │
│                                          │
│ ████████░░░░  3/6 tasks                  │
│ 14 events | Last: tool.file.changed      │
└──────────────────────────────────────────┘
```

This replaces the current static display where only the prompt is shown. The description stays (it's the task context), but now there's a live activity tail underneath.

**Unattributed session rows — same treatment:**

Currently show only agent name and elapsed time. Add the most recent activity entry inline:

```
  A  Andreas · 12m · 📝 event-utils.ts
```

---

## Files to Change

| File | Feature | Change |
|------|---------|--------|
| `src/bot/lib/event-utils.ts` | G-205a | Add `extractActivityEntry()` function |
| `src/bot/lib/dashboard-state.ts` | G-205a | Add `activity: SessionActivity[]` to `AgentTask`, populate in `handleProgressEvent()` |
| `src/dashboard/types.ts` | G-205a | Add `SessionActivity` type, add `activity` to `AgentTask` |
| `src/dashboard/app.tsx` | G-205b | Add `SessionDetailView` component, make session cards clickable |
| `src/dashboard/types.ts` | G-205b | Add `session` variant to `DashboardView` |
| `src/dashboard/app.tsx` | G-205c | Enhance `ActiveCard` with activity tail, enhance unattributed rows |

---

## Acceptance Criteria

### G-205a
- [ ] `AgentTask` includes `activity: SessionActivity[]` in API responses
- [ ] Activity entries extracted from `tool.file.changed`, `tool.bash.executed`, `tool.agent.spawned`, `tool.todo.updated` events
- [ ] Activity buffer capped at 50 entries per session
- [ ] Noisy events filtered (cat, echo, ls, pwd, cd)
- [ ] Activity cleared on session completion
- [ ] Rehydrate replays activity from published events

### G-205b
- [ ] Clicking an active session card navigates to session detail view
- [ ] Session detail shows: agent info, description, full activity timeline, progress, links
- [ ] Activity timeline updates in real-time via WebSocket
- [ ] Breadcrumb navigation back to previous view
- [ ] Clicking unattributed session rows also navigates to detail
- [ ] Mobile-friendly layout (existing responsive patterns)

### G-205c
- [ ] Active cards show 3 most recent activity entries below the description
- [ ] Unattributed session rows show latest activity entry inline
- [ ] Activity entries show relative timestamps (2m, 5m ago)
- [ ] Cards update in real-time as new events arrive

---

## Execution Order

```
G-205a (Activity Buffer)
  │
  ├── G-205c (Card Preview)  — can ship independently once buffer exists
  │
  └── G-205b (Detail View)   — can ship independently once buffer exists
```

G-205a first — it's the data layer. G-205b and G-205c are independent UI changes that both consume the same `activity` array.

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| G-202 (dashboard) | ✅ Merged | Foundation |
| G-204b (repo-aware UI) | ✅ Merged | Navigation patterns, drill-down conventions |
| `worklog-formatter.ts` | ✅ Exists | Reference implementation for event formatting |
| WebSocket snapshot push | ✅ Working | Real-time delivery mechanism |

---

## Not In Scope

- Persisting activity history to SQLite (activity is ephemeral — published JSONL is the durable store)
- Streaming agent text output (response content) to the dashboard
- Interactive controls (stop session, send follow-up) from the dashboard
- Activity for completed sessions (summary only, same as today)
- Aggregated activity analytics (file change frequency, command patterns)
