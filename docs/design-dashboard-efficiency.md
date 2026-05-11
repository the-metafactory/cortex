# Dashboard Efficiency — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-dashboard-efficiency.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Scope:** Worker-side caching (G-406), combined dashboard endpoint (G-407), adaptive polling with error backoff (G-408), Server-Sent Events for cloud mode (G-409)
**Mission:** Reduce cloud Worker request volume by 90%+ so the dashboard runs sustainably on a CF Workers Free plan (100K reqs/day) or comfortably within Paid plan limits.
**Stack:** Cloudflare Workers (Hono, D1, KV cache), React dashboard
**Inputs:** design-cloud-api.md (G-400 series), current dashboard polling in use-grove-api.ts, Worker routes in src/worker/src/

---

## Why This Exists

On 2026-03-30, the Grove cloud Worker (`grove-api`) went down returning Cloudflare error 1027. Root cause: the CF Workers Free plan limit of 100K requests/day was exceeded — actual usage was **165,979 requests in 10 hours**, peaking at 33,873 requests/hour.

The dashboard polls 3 separate endpoints every 10 seconds per open tab. Cross-origin CORS preflights double each request. When the Worker started returning errors, the dashboard kept polling at the same rate, burning quota on failed requests. There's no caching on the Worker side — every `/api/state` request rebuilds the full snapshot from D1 queries.

This is unsustainable. A single dashboard tab generates ~2,160 requests/hour. Two operators with the dashboard open burn through the daily Free plan limit in under 24 hours.

---

## Request Budget Analysis

**Current (broken):**

| Source | Reqs/hr per unit | Units | Total/hr |
|--------|-----------------|-------|----------|
| Dashboard tab (3 endpoints × 6/min × 2 CORS) | 2,160 | 2 tabs | 4,320 |
| WS reconnect attempts | ~60 | 2 tabs | 120 |
| CloudPublisher (bot event batches) | ~1,800 (worst case) | 1 bot | 1,800 |
| GitHub webhooks | ~10 | 5 repos | 50 |
| **Total** | | | **~6,290/hr** |

At 6,290/hr sustained, we hit 100K in ~16 hours. With active sessions generating more events and more dashboard opens, the spike to 33K/hr is explained.

**Target:** Under 1,000 reqs/hr with 2 dashboard tabs + active bot. That gives ~100 hours of headroom on Free plan, or is negligible on Paid.

---

## Features

### G-406: Worker-Side Snapshot Caching

The `/api/state` endpoint currently runs 7+ D1 queries per request to rebuild the full DashboardSnapshot. Most of the time, nothing has changed since the last request.

**Design:**

1. **In-memory cache:** Module-level variable holding the last-built snapshot JSON + ETag (SHA-256 hash of JSON)
2. **Cache invalidation:** After every `POST /api/ingest` and `POST /api/github/webhook` that modifies data, rebuild the snapshot and update the cache
3. **Conditional responses:** `/api/state` checks `If-None-Match` header against cached ETag. If match → return 304 Not Modified (zero body). If no match → return cached snapshot with `ETag` and `Cache-Control: no-cache` headers
4. **Cold start:** If cache is empty (Worker cold start), rebuild from D1 on first request, then serve from cache

**Why in-memory, not KV?**
- Worker isolates persist across requests within the same instance
- KV has eventual consistency (up to 60s) and adds a subrequest per read
- In-memory is instant and free
- Cache miss on cold start is rare and the D1 rebuild is cheap (happens once)

**ETag format:** `W/"sha256-{first16chars}"` (weak ETag, 16 chars of SHA-256)

**Acceptance Criteria:**
- `GET /api/state` returns `ETag` header
- `GET /api/state` with matching `If-None-Match` returns 304 with empty body
- After `POST /api/ingest` changes data, next `GET /api/state` returns updated snapshot with new ETag
- Cold start: first request rebuilds from D1, subsequent requests serve from cache
- Cache invalidation happens synchronously within the ingest/webhook handler (not async)

---

### G-407: Combined Dashboard Endpoint

Instead of 3 separate requests per poll (state + repos + heatmap), serve everything from one endpoint.

**New endpoint:** `GET /api/dashboard`

**Query parameters:**
- `include` — comma-separated sections to include (default: `state,repos,heatmap`)
- `project` — optional project filter (passed through to state query)

**Response:**
```json
{
  "state": { /* DashboardSnapshot */ },
  "repos": { "repos": [ /* RepoSummary[] */ ] },
  "heatmap": { "days": [ /* ActivityDay[] */ ] },
  "etag": "W/\"sha256-abc123...\"",
  "updatedAt": "2026-03-30T10:00:00Z"
}
```

**Caching:** Same ETag mechanism as G-406. The combined response has one ETag covering all included sections. Dashboard sends `If-None-Match` — gets 304 when nothing changed across any section.

**Migration:** Keep existing `/api/state`, `/api/repos`, `/api/stats/activity` endpoints for backward compatibility. Dashboard switches to `/api/dashboard` when available (feature-detect via `/api/health` version field).

**Acceptance Criteria:**
- `GET /api/dashboard` returns combined state + repos + heatmap
- `GET /api/dashboard?include=state` returns only state section
- `GET /api/dashboard` with matching `If-None-Match` returns 304
- Existing individual endpoints still work (backward compat)
- CORS preflight is 1 request instead of 3

---

### G-408: Dashboard Adaptive Polling + Error Backoff

The dashboard currently polls every 10 seconds unconditionally. This needs to be smarter.

**Polling strategy:**

| Condition | Interval | Rationale |
|-----------|----------|-----------|
| Active agents visible | 10s | Real-time feel during active work |
| No active agents | 30s | Nothing is changing, conserve quota |
| Tab hidden (`document.hidden`) | Stop polling | Zero requests when not looking |
| Tab visible again | Immediate poll, then resume | Catch up on changes |
| 304 Not Modified received | Keep current interval | Server confirms nothing changed |
| Error/timeout | Exponential backoff: 30s → 60s → 120s → 300s | Stop hammering a broken endpoint |
| Recovery after error | Reset to normal interval | Resume normal operation |

**Implementation in `use-grove-api.ts`:**

1. Replace fixed `setInterval(pollOnce, 10_000)` with adaptive timer
2. After each poll, compute next interval based on:
   - Response status (200/304/error)
   - Whether snapshot contains active agents
   - `document.visibilityState`
3. Use `setTimeout` instead of `setInterval` for variable delays
4. On `visibilitychange` event: pause/resume polling
5. Track consecutive errors for backoff calculation

**ETag integration:**
- Store last ETag from server response
- Send `If-None-Match` on every poll
- 304 response = no state update needed, skip React re-render

**Request reduction math:**

| Scenario | Current | After G-408 |
|----------|---------|-------------|
| 2 tabs, active agents, 1 hour | 2,160 | 720 (combined endpoint) |
| 2 tabs, idle, 1 hour | 2,160 | 240 (30s interval) |
| 2 tabs, 1 hidden, idle, 1 hour | 2,160 | 120 (1 tab stopped) |
| 2 tabs, Worker down, 1 hour | 2,160 | ~48 (backoff to 300s) |

**Acceptance Criteria:**
- Dashboard uses `/api/dashboard` combined endpoint (1 request per poll instead of 3)
- Polling interval increases to 30s when no active agents
- Polling stops when tab is hidden
- Polling resumes immediately when tab becomes visible
- Errors trigger exponential backoff (30s → 60s → 120s → 300s)
- Successful response after errors resets to normal interval
- Dashboard sends `If-None-Match` header, handles 304 responses
- 304 response does not trigger React re-render

---

### G-409: Server-Sent Events for Cloud Mode

SSE eliminates polling entirely. The Worker pushes updates to connected dashboards.

**Endpoint:** `GET /api/stream`

**Protocol:** `text/event-stream` (SSE)

**Events:**
```
event: snapshot
data: {"state":{...},"repos":{...},"heatmap":{...}}

event: keepalive
data: {"ts":"2026-03-30T10:00:00Z"}
```

**Worker behavior:**
1. On SSE connect: send full snapshot immediately
2. On data change (ingest/webhook): send updated snapshot to all connected SSE clients
3. Every 25 seconds: send keepalive comment (prevents proxy timeouts)
4. Connection stays open until client disconnects

**CF Workers SSE support:**
- Workers support streaming responses via `ReadableStream`
- The 30s CPU time limit is per-invocation CPU, not wall time — SSE connections can stay open for minutes
- Workers have a max of 6 concurrent outgoing connections, but SSE is an incoming connection held open — no limit documented
- Caveat: CF may terminate idle connections after ~100 seconds without keepalive

**Dashboard behavior:**
1. Try SSE first: `new EventSource("/api/stream")`
2. On `snapshot` event: update state, skip polling entirely
3. On connection drop: fall back to polling (G-408) with backoff
4. On reconnect: SSE `Last-Event-ID` header for server-side dedup (optional)

**Request reduction:**
- 1 persistent connection per tab instead of 120+ requests/hour
- Server pushes only when data changes
- Keepalive is in-band (no extra HTTP requests)

**Acceptance Criteria:**
- `GET /api/stream` returns `text/event-stream` content type
- Connected clients receive `snapshot` event on data changes
- Keepalive sent every 25 seconds
- Dashboard prefers SSE, falls back to polling on failure
- Multiple concurrent SSE connections supported
- Connection cleanup on client disconnect (no resource leak)

---

## Execution Order

```
G-406 (Worker cache + ETag)
  │
  ▼
G-407 (Combined endpoint)
  │
  ▼
G-408 (Adaptive polling + backoff)     ← This alone fixes the outage
  │
  ▼
G-409 (SSE — eliminates polling)       ← Ideal end state
```

- **G-406 first** — server-side prerequisite (ETag, cache invalidation)
- **G-407 next** — reduces 3 requests to 1 per poll
- **G-408 next** — dashboard uses combined endpoint + adaptive intervals (this is the minimum viable fix)
- **G-409 last** — eliminates polling entirely for cloud mode

**Minimum viable:** G-406 + G-407 + G-408 cuts requests by ~90%. G-409 is the proper long-term solution.

---

## Files to Change

| File | Feature | Change |
|------|---------|--------|
| `src/worker/src/routes/state.ts` | G-406 | Add in-memory cache, ETag generation, 304 support |
| `src/worker/src/routes/ingest.ts` | G-406 | Invalidate cache after data write |
| `src/worker/src/routes/github.ts` | G-406 | Invalidate cache after webhook write |
| **New: `src/worker/src/routes/dashboard.ts`** | G-407 | Combined endpoint |
| `src/worker/src/index.ts` | G-407 | Register `/api/dashboard` route |
| `src/dashboard/use-grove-api.ts` | G-408 | Adaptive polling, ETag, combined endpoint, visibility API |
| **New: `src/worker/src/routes/stream.ts`** | G-409 | SSE endpoint |
| `src/dashboard/use-grove-api.ts` | G-409 | EventSource client, SSE-first with polling fallback |

---

## Non-Goals

- Upgrading to CF Workers Paid plan (solves the symptom, not the cause)
- Changing the bot's CloudPublisher batch interval (2s is fine — event volume is low)
- Adding WebSocket support to the Worker (SSE is simpler and sufficient for server→client push)
- Durable Objects (overkill for a cache that can be rebuilt from D1)
