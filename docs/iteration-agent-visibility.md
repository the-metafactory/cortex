# Agent Visibility Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-agent-visibility.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for agent visibility features. Iterations are logical vehicles, not timeboxes — this ships when the work is done.

**Mission:** Agent work is visible in real-time — threaded in Discord, browsable on a phone-friendly dashboard, without anyone manually updating anything.
**Scope:** Grove worklog channel, dashboard API, Cloudflare Pages dashboard
**Design Spec:** `docs/design-agent-visibility.md`
**Project Brief:** `docs/agent-visibility-brief.md`
**Prerequisite:** PlatformAdapter (F-007) ✅ — merged in #30
**Tracking Issue:** [#35](https://github.com/the-metafactory/grove/issues/35)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Worklog Channel with Threaded Updates (G-200)

### Configuration

- [x] Add `worklogChannelId` to bot.yaml schema
- [ ] Create #worklog channel in Discord server

### Thread Lifecycle

- [x] `agent.task.started` event creates a thread: `"{task_identifier} ({agent_name})"`
- [x] Opening message includes: task description, GitHub issue link (if detectable), timestamp
- [x] Events during work post to the correct thread (not the channel)
- [x] `agent.task.completed` posts summary to thread + completion line to channel
- [x] Thread archived on completion (not deleted)

### Event Routing

- [x] In-memory map: `session_id → thread_id`
- [x] Events arriving for a session_id route to correct thread
- [x] Late-join: if no thread exists, create one on first event
- [x] Richer event formatting in `event-formatter.ts` (file changes, progress, sub-agents)

### Acceptance

- [ ] Multiple concurrent agents = multiple threads, no cross-contamination
- [ ] Channel feed shows only thread creation + completion (clean overview)

---

## Dashboard Event API (G-201)

### HTTP Endpoints

- [x] `GET /api/state` returns current agent work state as JSON
- [x] `GET /api/events?since=` returns events since timestamp
- [x] CORS headers for Cloudflare Pages origin

### WebSocket

- [x] `ws://localhost:{port}/ws` pushes events in real-time
- [x] Clients receive events as they arrive

### Infrastructure

- [x] Extend `grove-bot.ts` with `Bun.serve()` alongside Discord client
- [x] `api.port` configurable in bot.yaml (default: 8766)
- [x] In-memory state populated from published events
- [x] State resets on restart (JSONL is durable store)

### Acceptance

- [x] API serves alongside Discord bot (same process)
- [x] State endpoint returns well-formed JSON matching design spec schema

---

## Cloudflare Pages Dashboard (G-202)

### Build & Deploy

- [x] `src/dashboard/index.html` entry point (Bun HTML imports, no Vite)
- [x] React + Tailwind CSS
- [x] `bun build src/dashboard/index.html --outdir dist/dashboard`
- [x] Deploy to Cloudflare Pages (`grove-dashboard` project)
- [ ] Custom domain configured (e.g., `dashboard.meta-factory.dev`)

### UI (mobile-first)

- [x] Active agent cards: agent name, task, progress, duration, issue link
- [x] Completed section: today's finished work
- [x] Connection status indicator (green dot = connected)
- [x] Dark theme
- [ ] 💪 Pull-to-refresh on mobile

### Data & Connection

- [x] Connects to Grove API via WebSocket
- [x] Falls back to polling `GET /api/state` every 10s if WebSocket fails
- [x] Auto-reconnect on connection loss
- [x] Shows last known state with "disconnected" indicator when offline

### Auth

- [x] Cloudflare Access application policy configured
- [x] Allowed identities: Andreas, JC (configurable)
- [x] Session duration: 7 days

### Acceptance

- [x] Dashboard loads on mobile browser with responsive layout
- [x] Protected by Cloudflare Access (unauthenticated → login page)
- [x] Works offline-capable (shows last known state)

---

## Execution Order

```
G-200 (Worklog Channel)
  │
  ▼
G-201 (Dashboard API)
  │
  ▼
G-202 (Cloudflare Pages Dashboard)
```

- **G-200 first** — most immediate value, builds event routing that G-201 reuses
- **G-201 second** — API layer consuming same event state as G-200's thread routing
- **G-202 last** — pure frontend consuming G-201's API

---

## Exit Criteria

1. Agent task creates a thread in #worklog, all events post to that thread
2. Multiple concurrent agents produce separate threads with no cross-contamination
3. `GET /api/state` returns current agent work state
4. WebSocket pushes events in real-time
5. Dashboard loads on mobile with responsive layout
6. Dashboard protected by Cloudflare Access
7. Dashboard shows active tasks, completed tasks, and connection status
