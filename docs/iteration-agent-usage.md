# Agent Usage Visibility Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-agent-usage.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for agent token usage visibility on the dashboard. Iterations are logical vehicles, not timeboxes — this ships when the work is done.

**Mission:** The dashboard shows token usage and rate limits — per-session costs on agent cards, account-wide 5H/7D budget at the top.
**Scope:** Per-session token capture, account usage polling, usage API endpoint
**Design Spec:** `docs/design-agent-usage.md`
**Prerequisite:** G-205a (session activity buffer) ✅, G-203a (SQLite persistence) ✅
**Tracking Issue:** [#59](https://github.com/the-metafactory/grove/issues/59)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Per-Session Token Usage (G-206a)

### Data Model

- [x] Add `UsageStats` type to `src/dashboard/types.ts`
- [x] Add `usage?: UsageStats` field to `AgentTask` in `src/bot/lib/dashboard-state.ts`
- [x] Add `usage` to dashboard `AgentTask` type in `src/dashboard/types.ts`

### Database

- [x] Add `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd` columns to `sessions` table
- [x] Update `completeSession()` in `dashboard-db.ts` to accept and persist usage fields
- [ ] 💪 Update `upsertSession()` to handle usage on active session updates

### Event Wiring

- [x] `MessageRouter` emits `"session-usage"` event in sync path (`handleSync`)
- [x] `MessageRouter` emits `"session-usage"` event in async path (`handleAsync`)
- [x] `grove-bot.ts` listens for `"session-usage"` and calls `dashboardState.updateSessionUsage()`

### State Integration

- [x] `DashboardState.updateSessionUsage()` sets usage on active task
- [x] Usage included in `DashboardSnapshot` via `getSnapshot()`
- [x] Usage persisted to DB when `handleTaskCompleted()` fires
- [ ] 💪 Usage available in `recentCompletions` (DB query includes token columns)

### Acceptance

- [x] API response includes usage for active sessions with token counts
- [x] Completed sessions have tokens and cost persisted in SQLite
- [x] WebSocket snapshot broadcasts include per-session usage

---

## Account Usage — Event Pipeline + Tiered Monitor (G-206b)

### Event Pipeline (Primary — via existing JSONL relay)

- [x] Add `USAGE_UPDATE: "agent.usage.update"` to `src/hooks/lib/event-taxonomy.ts`
- [x] `EventLogger.hook.ts` reads `~/.claude/MEMORY/STATE/usage-cache.json` on Stop/UserPromptSubmit
- [x] Emits `agent.usage.update` event with five_hour, seven_day, etc. payload
- [x] Add `agent.usage.update` to `src/relay/relay-policy.yaml` allow list
- [x] `DashboardState.handleUsageUpdate()` parses event payload into `AccountUsage`

### Tiered Monitor (Fallback chain)

- [x] Create `src/bot/lib/usage-monitor.ts` with `UsageMonitor` class
- [x] Tier 1: Event pipeline events (primary, via `receiveEvent()`)
- [x] Tier 2: Poll `usage-cache.json` file every 30s (secondary)
- [x] Tier 3: Direct API call every 5min (last resort, OAuth token from Keychain/credentials/env)
- [x] Tiers are suppressed when a higher-priority source has recent data

### SQLite Time-Series

- [x] Add `usage_snapshots` table to `dashboard-db.ts` migration
- [x] `insertUsageSnapshot()` persists each update with source tag
- [x] `getUsageHistory()` returns snapshots for last N hours
- [x] `GET /api/usage/history` endpoint with period aggregation (avg by hour/15min/day)

### Data Model

- [x] Add `AccountUsage` type to `src/dashboard/types.ts`
- [x] Add `accountUsage: AccountUsage | null` to `DashboardSnapshot` type

### State Integration

- [x] `DashboardState.setAccountUsage()` setter method
- [x] `DashboardState.getAccountUsage()` getter method
- [x] `accountUsage` included in `getSnapshot()` return value
- [x] WebSocket broadcasts include account usage

### Bot Wiring

- [x] `grove-bot.ts` creates `UsageMonitor` when dashboard API is enabled
- [x] `DashboardApi.setUsageMonitor()` for event pipeline integration
- [x] `DashboardApi.handleEvent()` feeds usage events to monitor
- [x] Monitor stopped on graceful shutdown

### Acceptance

- [x] `DashboardSnapshot` includes `accountUsage` with 5H/7D utilization
- [x] Reset times included (ISO 8601 format)
- [x] Model-specific usage (opus/sonnet) included when available
- [x] Time-series snapshots persisted in SQLite with source tag
- [x] `GET /api/usage/history` returns averaged time-series data

---

## Usage REST Endpoint (G-206c)

### API

- [x] Add `GET /api/usage` route to `dashboard-api.ts`
- [x] Returns `AccountUsage` JSON with CORS headers
- [x] Returns 204 No Content when no data available
- [x] Response includes `updatedAt` timestamp

### Acceptance

- [x] `curl localhost:8766/api/usage` returns rate limit data
- [x] Response format matches design spec schema

---

## Dashboard UI (G-206d)

### Agent Overview Section

- [ ] `AccountUsageBar` component — 5H/7D bars with % and reset timers
- [ ] `AgentOverviewCard` component — status, current task, token usage
- [ ] `TokenUsageInline` component — compact token/cost display
- [ ] Agents section on home view (between header and Repositories)
- [ ] Click-through to existing `AgentDetailView`

### Agent Detail Enhancements

- [ ] Token usage on session rows in `AgentDetailView`
- [ ] 💪 Usage history chart (time-series from `/api/usage/history`)

### Acceptance

- [ ] Home view shows all known agents with active/idle status
- [ ] Account usage bar visible with 5H/7D percentages
- [ ] Per-session token counts visible on agent cards

---

## Execution Order

```
G-206a (Per-Session Tokens)    G-206b (Event Pipeline + Monitor)
         │                                    │
         └──────────┬─────────────────────────┘
                    │
              G-206c (Usage REST)
                    │
              G-206d (Dashboard UI)
```

---

## Exit Criteria

1. Active session cards include token usage (input/output tokens, cost) in API responses
2. Completed sessions have tokens and cost persisted in SQLite
3. Dashboard snapshot includes account-level 5H/7D rate limit utilization
4. `GET /api/usage` returns current rate limit data
5. Usage data flows through JSONL event pipeline with tiered fallback
6. Dashboard home view shows Agents section with usage visibility
7. Usage time-series persisted in SQLite for historical charts
