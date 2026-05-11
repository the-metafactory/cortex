# Agent Visibility — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-agent-visibility.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Scope:** Worklog channel with threaded updates (B), responsive dashboard on Cloudflare Pages (C)
**Mission:** Agent work is visible in real-time — threaded in Discord, browsable on a phone-friendly dashboard, without anyone manually updating anything.
**Stack:** Bun + discord.js (existing), Bun.serve() for dashboard API, Cloudflare Pages for hosting, Cloudflare Access for auth
**Inputs:** ARCHITECTURE.md, event-taxonomy.ts, relay-policy.yaml, PlatformAdapter interface (F-007)

---

## Why This Exists

Grove captures rich event data from Claude Code sessions (task starts, file changes, progress, completions). Today it posts a flat text stream to #agent-log. With multiple agents working in parallel, this becomes noise — you can't follow one agent's work without wading through all of them.

The worklog channel solves this with threads. The dashboard solves it with a phone-friendly real-time view.

---

## Features

### G-200: Worklog Channel with Threaded Updates

A new Discord channel where each agent task gets its own thread. The channel feed stays clean (thread creation/completion only). All detail flows into the thread.

**Configuration (`bot.yaml`):**
```yaml
discord:
  - instanceId: "main"
    # ... existing config ...
    worklogChannelId: "CHANNEL_ID"     # New: worklog channel
```

**Thread lifecycle:**

1. **Agent starts a task** (`agent.task.started` event):
   - Grove creates a thread in #worklog: `"I-400: Test Stabilization (Luna)"`
   - Thread name format: `"{task_identifier} ({agent_name})"`
   - Opening message includes: task description, GitHub issue link (if detectable), timestamp

2. **During work** (events stream to the thread):
   - `tool.file.changed` → `"📝 src/lib/crypto.ts (edited)"`
   - `tool.todo.updated` → `"📋 Progress: 3/6 tasks complete"`
   - `tool.agent.spawned` → `"🤖 Spawned: explore test failures"`
   - Formatted using existing `event-formatter.ts` (enhanced with richer formatting)

3. **Agent completes** (`agent.task.completed` event):
   - Final message in thread: summary, duration, files changed count, PR link if available
   - Thread is archived (not deleted — history preserved)
   - Channel gets a completion message: `"✅ I-400: Test Stabilization (Luna) — 12m 34s"`

**Thread-to-task mapping:**
- Grove maintains an in-memory map: `session_id → thread_id`
- Events arriving for a session_id are routed to the correct thread
- If no thread exists (session started before worklog was enabled), create one on first event

**Channel feed (what you see without opening threads):**
```
#worklog
├── 🏃 I-400: Test Stabilization (Luna)          10:15
├── 🏃 I-403: Cloudflare Dev Environment (Ivy)    10:17
├── ✅ I-400: Test Stabilization (Luna) — 12m 34s  10:28
└── 🏃 I-401: Integration Harness (Luna)          10:30
```

**Acceptance Criteria:**
- `worklogChannelId` configurable in bot.yaml
- Agent task start creates a Discord thread in worklog channel
- All events for that task post to the correct thread (not the channel)
- Task completion posts summary to thread + completion line to channel
- Multiple concurrent agents = multiple threads, no cross-contamination
- Thread names include task identifier and agent name

---

### G-201: Dashboard Event API

An HTTP API served by Grove that exposes current agent work state for the dashboard.

**Endpoint: `GET /api/state`**
Returns current state of all active and recent tasks:

```json
{
  "projects": [
    {
      "id": "meta-factory",
      "repo": "the-metafactory/meta-factory",
      "display_name": "metafactory"
    },
    {
      "id": "grove",
      "repo": "the-metafactory/grove",
      "display_name": "Grove"
    }
  ],
  "agents": [
    {
      "id": "luna",
      "name": "Luna",
      "status": "active",
      "current_task": {
        "session_id": "abc123",
        "project": "meta-factory",
        "description": "I-400: Test Stabilization",
        "github_issue": "https://github.com/the-metafactory/meta-factory/issues/21",
        "started_at": "2026-03-29T10:15:00Z",
        "events_count": 14,
        "last_event": "tool.todo.updated",
        "progress": { "completed": 3, "total": 6 }
      }
    },
    {
      "id": "ivy",
      "name": "Ivy",
      "status": "active",
      "current_task": {
        "session_id": "def456",
        "project": "grove",
        "description": "G-200: Worklog Channel",
        "github_issue": "https://github.com/the-metafactory/grove/issues/32",
        "started_at": "2026-03-29T10:17:00Z",
        "events_count": 8,
        "last_event": "tool.file.changed",
        "progress": { "completed": 1, "total": 4 }
      }
    }
  ],
  "recent_completions": [
    {
      "agent": "luna",
      "project": "meta-factory",
      "description": "I-400: Test Stabilization",
      "duration_ms": 754000,
      "completed_at": "2026-03-29T10:28:00Z",
      "pr_url": "https://github.com/the-metafactory/meta-factory/pull/26"
    }
  ],
  "updated_at": "2026-03-29T10:30:00Z"
}
```

**Endpoint: `GET /api/state?project={id}`**
Optional `project` filter. Without it, returns all projects the caller has access to.

**Endpoint: `GET /api/events?since={timestamp}&project={id}`**
Returns published events since a timestamp (for polling). Optional project filter.

**WebSocket: `ws://localhost:{port}/ws`**
Real-time event stream for the dashboard. Pushes events as they arrive.

**Implementation:**
- Extend `grove-bot.ts` with `Bun.serve()` alongside the Discord client
- State is in-memory, populated from published events
- Configurable port in bot.yaml: `api.port: 8766`
- CORS headers for Cloudflare Pages origin

**Acceptance Criteria:**
- `GET /api/state` returns current agent work state as JSON
- `GET /api/events?since=` returns events since timestamp
- WebSocket pushes events in real-time
- API serves alongside Discord bot (same process)
- State resets on restart (events are transient — JSONL is the durable store)

---

### G-202: Cloudflare Pages Dashboard

A responsive, phone-first web dashboard showing real-time agent work.

**Tech stack:**
- Bun HTML imports for build (per CLAUDE.md — no Vite)
- React + Tailwind CSS
- Deployed to Cloudflare Pages
- Protected by Cloudflare Access (email OTP or GitHub OAuth)

**Layout (mobile-first):**

```
┌──────────────────────────────┐
│  Grove Dashboard         🟢  │  ← connection status
│  [All] [metafactory] [Grove] │  ← project filter tabs
├──────────────────────────────┤
│  ACTIVE (2)                  │
│ ┌──────────────────────────┐ │
│ │ 🏃 Luna • metafactory    │ │  ← project badge
│ │ I-400: Test Stab...      │ │
│ │ 3/6 tasks • 12m          │ │
│ │ #21 ↗                    │ │  ← GitHub issue link
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ 🏃 Ivy • Grove           │ │
│ │ G-200: Worklog Channel   │ │
│ │ 1/4 tasks • 3m           │ │
│ │ #32 ↗                    │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│  COMPLETED TODAY (3)         │
│  ✅ I-400 Luna 12m mf #21   │
│  ✅ PR #26 merged    mf      │
│  ✅ G-200 Ivy 8m  grove #32 │
├──────────────────────────────┤
│  Last updated: 10:30         │
└──────────────────────────────┘
```

**Cross-project visibility:**
- Dashboard shows work across ALL projects (metafactory, Grove, future repos)
- Project filter tabs: "All" (default), or filter to one project
- Each card shows project badge so you know which codebase the agent is working in
- Project list populated dynamically from API state (no hardcoded list)
- Access control: Cloudflare Access determines who sees the dashboard; project-level filtering is a future option

**Features:**
- Cards for each active agent task (agent name, project, task, progress, duration, issue link)
- Completed section (today's finished work, across all projects)
- Connection indicator (WebSocket connected/disconnected)
- Auto-reconnect on connection loss
- Pull-to-refresh on mobile
- Dark theme (matches Grove's identity)

**Cloudflare Access:**
- Application policy: require email OTP or GitHub identity
- Allowed emails: Andreas, JC (configurable)
- Session duration: 7 days

**Deployment:**
- Source: `src/dashboard/` in Grove repo
- Build: `bun build src/dashboard/index.html --outdir dist/dashboard`
- Deploy: `npx wrangler pages deploy dist/dashboard --project-name grove-dashboard`
- Domain: configured in Cloudflare Pages (e.g., `dashboard.meta-factory.dev`)

**Data source:**
- Connects to Grove's API (G-201) via WebSocket
- Falls back to polling `GET /api/state` every 10s if WebSocket fails
- API URL configurable (environment variable at build time)

**Acceptance Criteria:**
- Dashboard loads on mobile browser with responsive layout
- Active agent tasks shown as cards with real-time progress
- Completed tasks shown in history section
- Connection status indicator (green dot = connected)
- Protected by Cloudflare Access (unauthenticated requests → login page)
- Deployed to Cloudflare Pages with custom domain
- Works offline-capable (shows last known state with "disconnected" indicator)

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

- **G-200 first** — most immediate value, builds the event routing that G-201 reuses
- **G-201 second** — API layer that consumes the same event state as G-200's thread routing
- **G-202 last** — pure frontend consuming G-201's API

---

## Not In Scope

- GitHub issue auto-updating (this is CLAUDE.md/SOP behavior, not Grove)
- Mattermost worklog channel (Discord-first, Mattermost follow-on)
- Historical analytics or metrics (dashboard shows live state + today's history)
- Agent-to-agent coordination via dashboard (read-only visibility)
- Per-project access control on dashboard (all authenticated users see all projects for now)
- Multi-org/multi-workspace federation
- Authentication of the API itself (runs locally, dashboard uses Cloudflare Access)

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| discord.js thread support | Have (v14) | Required for G-200 |
| Bun.serve() | Have | Required for G-201 |
| Cloudflare Pages account | Have (meta-factory.dev) | Required for G-202 |
| Cloudflare Access | Available | Required for G-202 auth |
| Grove event pipeline | Working | Foundation for all features |
| PlatformAdapter (F-007) | Merged | G-200 uses Discord adapter |
