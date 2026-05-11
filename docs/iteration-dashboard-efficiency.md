# Dashboard Efficiency Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-dashboard-efficiency.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for dashboard efficiency features. Iterations are logical vehicles, not timeboxes — this ships when the work is done.

**Mission:** Reduce cloud Worker request volume by 90%+ so the dashboard runs sustainably within CF Workers limits.
**Scope:** Worker-side caching, combined dashboard endpoint, adaptive polling, SSE
**Design Spec:** `docs/design-dashboard-efficiency.md`
**Tracking Issue:** TBD

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Worker-Side Snapshot Caching (G-406)

### Cache Infrastructure

- [ ] Add module-level `cachedSnapshot` variable and `cachedETag` in state.ts
- [ ] Create `buildAndCacheSnapshot(db)` helper that queries D1, builds JSON, computes ETag
- [ ] ETag format: `W/"sha256-{first16chars}"` via Web Crypto API
- [ ] On cold start (cache empty): `buildAndCacheSnapshot()` on first `/api/state` request

### Conditional Response

- [ ] Read `If-None-Match` header in `/api/state` handler
- [ ] If ETag matches: return `304 Not Modified` with empty body
- [ ] If no match: return cached snapshot JSON with `ETag` and `Cache-Control: no-cache` headers

### Cache Invalidation

- [ ] Export `invalidateSnapshotCache(db)` that rebuilds cache from D1
- [ ] Call from `POST /api/ingest` after successful D1 writes
- [ ] Call from `POST /api/github/webhook` after successful D1 writes
- [ ] Invalidation is synchronous (await rebuild before responding to ingest)

### Acceptance

- [ ] `GET /api/state` returns `ETag` header
- [ ] `GET /api/state` with matching `If-None-Match` returns 304
- [ ] After `POST /api/ingest`, next `GET /api/state` returns new ETag
- [ ] Cold start: first request rebuilds, subsequent serve from cache

---

## Combined Dashboard Endpoint (G-407)

### Endpoint Implementation

- [ ] Create `src/worker/src/routes/dashboard.ts`
- [ ] `GET /api/dashboard` handler
- [ ] Parse `include` query param (default: `state,repos,heatmap`)
- [ ] Parse `project` query param (pass through to state query)
- [ ] Assemble response from cached state + repos + heatmap
- [ ] Single ETag covering all included sections

### Cache Integration

- [ ] Repos and heatmap included in the cached snapshot (invalidated together)
- [ ] Or: separate cache entries per section with combined ETag

### Route Registration

- [ ] Register `GET /api/dashboard` in `src/worker/src/index.ts`
- [ ] Add to CORS preflight handler

### Version Detection

- [ ] Add `version` field to `/api/health` response (e.g., `"api_version": 2`)
- [ ] Dashboard uses version to decide `/api/dashboard` vs legacy endpoints

### Acceptance

- [ ] `GET /api/dashboard` returns combined state + repos + heatmap
- [ ] `GET /api/dashboard?include=state` returns only state
- [ ] `GET /api/dashboard` with matching `If-None-Match` returns 304
- [ ] Existing `/api/state`, `/api/repos`, `/api/stats/activity` still work
- [ ] 1 CORS preflight instead of 3

---

## Dashboard Adaptive Polling + Error Backoff (G-408)

### Adaptive Timer

- [ ] Replace `setInterval(pollOnce, 10_000)` with `setTimeout`-based adaptive timer
- [ ] Compute next interval after each poll based on response + state
- [ ] Active agents detected → 10s interval
- [ ] No active agents → 30s interval
- [ ] Error → exponential backoff (30s → 60s → 120s → 300s max)
- [ ] Success after error → reset to normal interval

### Combined Endpoint Migration

- [ ] Detect `/api/dashboard` availability via health version check
- [ ] If available: use single `/api/dashboard` fetch per poll
- [ ] If not: fall back to 3 separate fetches (backward compat with local mode)

### ETag Support

- [ ] Store last ETag per connection
- [ ] Send `If-None-Match` header on every poll
- [ ] On 304: skip state update, skip React re-render
- [ ] On 200: update state, store new ETag

### Visibility API

- [ ] Listen for `document.visibilitychange` event
- [ ] `hidden` → clear polling timer (zero requests while tab hidden)
- [ ] `visible` → immediate poll, then resume adaptive timer

### Acceptance

- [ ] Dashboard uses `/api/dashboard` when available
- [ ] Polling interval adapts: 10s (active) / 30s (idle)
- [ ] Tab hidden → polling stops completely
- [ ] Tab visible → immediate poll + resume
- [ ] Errors → backoff to 300s max
- [ ] 304 → no re-render, no wasted bandwidth
- [ ] Request volume < 1,000/hr with 2 idle dashboard tabs

---

## Server-Sent Events for Cloud Mode (G-409)

### 💪 SSE Endpoint

- [ ] Create `src/worker/src/routes/stream.ts`
- [ ] `GET /api/stream` returns `text/event-stream`
- [ ] On connect: send full snapshot as `event: snapshot`
- [ ] Keepalive comment every 25 seconds
- [ ] Track connected clients in module-level Set

### 💪 Push on Data Change

- [ ] After cache invalidation (G-406), push new snapshot to all SSE clients
- [ ] Use `writer.write(encoder.encode(...))` on each client's stream
- [ ] Remove closed connections from client Set

### 💪 Dashboard SSE Client

- [ ] Create `EventSource` connection to `/api/stream`
- [ ] On `snapshot` event: update state, disable polling
- [ ] On connection drop: fall back to polling (G-408)
- [ ] On reconnect: resume SSE, stop polling

### 💪 Acceptance

- [ ] `GET /api/stream` returns `text/event-stream`
- [ ] Connected dashboards receive pushes on data changes
- [ ] Keepalive prevents proxy timeout
- [ ] Fallback to polling on SSE failure
- [ ] Near-zero request overhead (1 connection per tab)

---

## Execution Order

```
G-406 (Worker cache + ETag)
  │
  ▼
G-407 (Combined endpoint)
  │
  ▼
G-408 (Adaptive polling + backoff)     ← minimum viable fix
  │
  ▼
G-409 (SSE)                            ← 💪 stretch goal
```

---

## Exit Criteria

1. Worker caches snapshot in memory, serves ETag + 304
2. `/api/dashboard` serves combined payload (1 request instead of 3)
3. Dashboard adapts polling interval based on state + errors + tab visibility
4. Request volume under 1,000/hr with 2 dashboard tabs (idle)
5. Worker survives 24+ hours on CF Free plan with typical usage
6. (Stretch) SSE eliminates polling for cloud mode entirely
