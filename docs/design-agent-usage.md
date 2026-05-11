# Agent Usage Visibility — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-agent-usage.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Feature ID:** G-206
**Scope:** Per-session token usage tracking, account-level rate limit polling, usage API endpoint
**Mission:** The dashboard shows how much budget has been consumed and how much remains — per-session token counts on agent cards, account-wide rate limits (5H/7D) at the top. Plan your agent work without guessing.
**Stack:** Existing Bun.serve() API, SQLite persistence, Anthropic OAuth usage API
**Prerequisite:** G-205a (session activity buffer) ✅, G-203a (SQLite persistence) ✅

---

## Why This Exists

The dashboard shows *what* agents are doing (sessions, file changes, progress) but not *what it costs*. When multiple bots work in parallel, there's no way to see:
- How much of the shared 5-hour and weekly rate limit has been consumed
- How many tokens a session has used
- What it cost in dollars
- When rate limits reset

The PAI status line already surfaces this beautifully (`USE: 5H: 20% ⬆now | WK: 56% ⬆1d8h | A:$0`). The data sources exist — Claude Code's stream-json emits per-session token counts, and the Anthropic OAuth API returns rate limit percentages. Neither flows to the dashboard today.

---

## Features

### G-206a: Per-Session Token Usage

Capture token counts and cost from Claude Code sessions, persist to SQLite, include in dashboard snapshots.

**Data source:** `CCSession` already parses `UsageStats` from stream-json `result` events (`stream-parser.ts`) and emits `"usage"` events (`cc-session.ts:316`). The message router logs this to console (`message-router.ts:351`) but never forwards it to dashboard state.

**Data model — extend existing `AgentTask`:**

```typescript
// In dashboard-state.ts — add to AgentTask interface:
usage?: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
};
```

**Event flow:**

```
CCSession → emit("usage", UsageStats)
  ↓
message-router.ts → emit("session-usage", sessionId, usage)
  ↓
grove-bot.ts → dashboardState.updateSessionUsage(sessionId, usage)
  ↓
DashboardState → AgentTask.usage + DB persist on completion
  ↓
DashboardSnapshot → WebSocket broadcast to dashboard
```

**Wiring — MessageRouter emits usage events:**

Sync path (after `session.start().wait()` completes):
```typescript
if (result.usage && result.sessionId) {
  this.emit("session-usage", result.sessionId, result.usage);
}
```

Async path (on session `"exit"` event):
```typescript
if (session.usage && session.sessionId) {
  this.emit("session-usage", session.sessionId, session.usage);
}
```

**DashboardState — new method:**

```typescript
updateSessionUsage(sessionId: string, usage: UsageStats): boolean {
  const task = this.activeTasks.get(sessionId);
  if (!task) return false;
  task.usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: usage.costUsd,
  };
  return true;
}
```

**Persistence — extend sessions table:**

```sql
ALTER TABLE sessions ADD COLUMN input_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN output_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN cost_usd REAL;
```

On `completeSession()`, persist the usage fields from `AgentTask.usage`.

**Acceptance Criteria:**
- [ ] `AgentTask` includes `usage` field with token counts in API responses
- [ ] Usage captured from CC stream-json `result` event for both sync and async sessions
- [ ] Token counts and cost persisted to SQLite `sessions` table on completion
- [ ] Usage included in WebSocket snapshot broadcasts
- [ ] Completed sessions show usage in `recentCompletions` (via DB query)

---

### G-206b: Account Usage Poller

Poll the Anthropic OAuth usage API for account-level rate limit percentages. This is the same data shown in the PAI status line (5H: 20%, WK: 56%).

**Data source:** `https://api.anthropic.com/api/oauth/usage` — returns:

```json
{
  "five_hour": { "utilization": 20, "resets_at": "2026-03-29T09:00:01Z" },
  "seven_day": { "utilization": 56, "resets_at": "2026-03-30T19:00:00Z" },
  "seven_day_opus": null,
  "seven_day_sonnet": { "utilization": 3, "resets_at": "2026-03-31T21:00:00Z" },
  "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null }
}
```

**Key insight:** Rate limits are **account-level**, not per-agent. All bots sharing the same Claude account share the same 5H/7D budget. The dashboard shows this as a single account-wide indicator, not per-agent bars.

**Data model — new type:**

```typescript
interface AccountUsage {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDayOpus: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
  } | null;
  updatedAt: string;
}
```

**New file — `src/bot/lib/usage-poller.ts`:**

```typescript
export class UsagePoller {
  private timer: Timer | null = null;
  private current: AccountUsage | null = null;
  private onUpdate: (usage: AccountUsage) => void;

  constructor(onUpdate: (usage: AccountUsage) => void);

  start(): void;    // Poll immediately, then every 60s
  stop(): void;     // Clear timer
  getCurrent(): AccountUsage | null;

  private async poll(): Promise<void>;
  private async getOAuthToken(): Promise<string | null>;
}
```

**OAuth token extraction** — same method as the PAI status line (`statusline-command.sh:341-346`):

```typescript
// macOS Keychain
const { stdout } = await Bun.$`security find-generic-password -s "Claude Code-credentials" -w`.quiet();
const creds = JSON.parse(stdout.toString());
const token = creds.claudeAiOauth?.accessToken;
```

Falls back to `~/.claude/.credentials.json` on Linux. Falls back to `CLAUDE_CODE_OAUTH_TOKEN` env var as last resort.

**Polling frequency:** Every 60 seconds (Anthropic recommends ≤1 poll/minute). Silent failures — if API is unreachable, keep last known value.

**Wiring in grove-bot.ts:**

```typescript
if (dashboardApi) {
  const usagePoller = new UsagePoller((usage) => {
    dashboardApi!.getState().setAccountUsage(usage);
  });
  usagePoller.start();
  // Stop on shutdown
}
```

**DashboardState — new field and method:**

```typescript
private accountUsage: AccountUsage | null = null;

setAccountUsage(usage: AccountUsage): void {
  this.accountUsage = usage;
}
```

Include in `getSnapshot()`:
```typescript
return {
  ...existing,
  accountUsage: this.accountUsage,
};
```

**Acceptance Criteria:**
- [ ] `UsagePoller` polls Anthropic OAuth API every 60s
- [ ] OAuth token extracted from macOS Keychain (or credentials file on Linux)
- [ ] `DashboardSnapshot` includes `accountUsage` with 5H/7D utilization and reset times
- [ ] Poller handles API failures gracefully (keeps last known value, no crash)
- [ ] Poller starts on bot startup and stops on shutdown
- [ ] Model-specific usage (opus/sonnet) included when available

---

### G-206c: Usage REST Endpoint

Expose account usage via a dedicated REST endpoint for direct polling.

**Endpoint: `GET /api/usage`**

Returns current account usage:

```json
{
  "fiveHour": { "utilization": 20, "resetsAt": "2026-03-29T09:00:01Z" },
  "sevenDay": { "utilization": 56, "resetsAt": "2026-03-30T19:00:00Z" },
  "sevenDayOpus": null,
  "sevenDaySonnet": { "utilization": 3, "resetsAt": "2026-03-31T21:00:00Z" },
  "extraUsage": { "isEnabled": false, "monthlyLimit": null, "usedCredits": null },
  "updatedAt": "2026-03-30T10:30:00Z"
}
```

Returns `204 No Content` if no usage data has been polled yet.

**Implementation:** Add route to existing `Bun.serve()` router in `dashboard-api.ts`. Reads from `DashboardState.accountUsage`.

The snapshot (via WebSocket and `GET /api/state`) already includes `accountUsage` — this endpoint is for lightweight direct polling without the full snapshot payload.

**Acceptance Criteria:**
- [ ] `GET /api/usage` returns current account usage as JSON
- [ ] Returns 204 when no usage data available yet
- [ ] CORS headers match existing API endpoints
- [ ] Response includes `updatedAt` timestamp

---

## Files to Change

| File | Feature | Change |
|------|---------|--------|
| `src/dashboard/types.ts` | G-206a | Add `UsageStats` type, add `usage` to `AgentTask` |
| `src/bot/lib/dashboard-state.ts` | G-206a | Add `usage` to `AgentTask`, `updateSessionUsage()` method |
| `src/bot/lib/dashboard-db.ts` | G-206a | Add token/cost columns, update `completeSession()` |
| `src/bot/lib/message-router.ts` | G-206a | Emit `session-usage` event in sync + async paths |
| `src/dashboard/types.ts` | G-206b | Add `AccountUsage` type, add to `DashboardSnapshot` |
| `src/bot/lib/dashboard-state.ts` | G-206b | Add `accountUsage` field, `setAccountUsage()`, include in snapshot |
| **New: `src/bot/lib/usage-poller.ts`** | G-206b | OAuth usage API poller |
| `src/bot/grove-bot.ts` | G-206a+b | Wire `session-usage` listener + usage poller |
| `src/bot/lib/dashboard-api.ts` | G-206c | Add `GET /api/usage` route |

---

## Execution Order

```
G-206a (Per-Session Token Usage)
  │
  ├── G-206c (Usage REST Endpoint) — can ship once G-206b exists
  │
G-206b (Account Usage Poller) — independent of G-206a
```

G-206a and G-206b are independent — one captures per-session data, the other polls account-level data. G-206c depends on G-206b (needs `accountUsage` in state to serve).

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| G-205a (session activity buffer) | ✅ Merged | `AgentTask` structure, snapshot pattern |
| G-203a (SQLite persistence) | ✅ Merged | Sessions table, `DashboardDb` |
| Stream-json usage parsing | ✅ Working | `cc-session.ts` + `stream-parser.ts` |
| Anthropic OAuth usage API | ✅ Available | Rate limit data source |
| macOS Keychain access | ✅ Working | Same method as PAI status line |

---

## Not In Scope

- Dashboard UI rendering of usage data (separate feature — G-206d or similar)
- Per-agent rate limit tracking (rate limits are account-level, not per-agent)
- Token budget enforcement or alerts (future feature)
- Historical usage analytics or cost trends (future feature)
- Cost forecasting or predictions
- Billing integration
