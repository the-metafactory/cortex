# Cloud API Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-cloud-api.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for cloud API features. Iterations are logical vehicles, not timeboxes — this ships when the work is done.

**Mission:** Multiple bot principals share a single dashboard without tunnels. Local-first mode stays as default zero-config option. Cloud mode is opt-in for multi-principal networks.
**Scope:** Grove cloud Worker, D1 event store, bot cloud publisher, API key management, dashboard mode detection, GitHub webhook migration, automated setup CLI
**Design Spec:** `docs/design-cloud-api.md`
**Project Brief:** None (tracked via GitHub issue #65)
**Tracking Issue:** [#65](https://github.com/the-metafactory/grove/issues/65)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- 💪 stretch goal
- ✋ blocked
- 🔵 needs investigation

---

## Cloud Worker + D1 Event Store (G-400)

### Infrastructure Setup

- [x] Create D1 database (`grove-events`) in OC/AKL region
- [x] Create KV namespace (`grove-keys`) for API keys
- [x] Set up `wrangler.toml` with bindings
- [x] Define D1 schema (`schema.sql`) with sessions, github_events, repos, issues, pull_requests, usage_snapshots tables
- [x] Apply schema to D1: `wrangler d1 execute grove-events --file schema.sql`

### Hono Worker Scaffold

- [x] Install Hono framework
- [x] Create `src/worker/src/index.ts` with Hono app
- [x] Define Env interface (GROVE_DB, GROVE_KEYS, ADMIN_SECRET, GITHUB_WEBHOOK_SECRET, etc.)
- [x] Add CORS middleware
- [x] Add health check endpoint (`GET /api/health`)
- [x] Add 404 handler
- [x] Deploy Worker: `wrangler deploy`

### Authentication Middleware

- [x] Create `src/worker/src/auth.ts` with OperatorKey interface
- [x] Implement `requireApiKey(c, next)` middleware (validates Bearer token against KV)
- [x] Implement `requireAdmin(c, next)` middleware (validates against ADMIN_SECRET)
- [x] Middleware sets `c.set("operatorId", ...)` on success

### Event Ingestion (POST /api/ingest)

- [x] Create `src/worker/src/routes/ingest.ts`
- [x] `POST /api/ingest` endpoint with `requireApiKey` middleware
- [x] Parse batched event payload: `{ operator_id, events: [...] }`
- [x] Route events by type: agent.task.started, agent.task.completed, tool.*, etc.
- [x] `handleTaskStarted` — INSERT OR REPLACE into sessions table
- [x] `handleTaskCompleted` — UPDATE sessions with completion data
- [x] `handleUsageUpdate` — INSERT into usage_snapshots
- [x] `handleProgressEvent` — UPDATE sessions with progress/last_event
- [x] Late-join logic: create session if event arrives before task.started
- [x] Return `{ ok: true, ingested: N, skipped: M }`
- [x] Deduplication: INSERT OR IGNORE on event_id

### State Endpoint (GET /api/state)

- [x] Create `src/worker/src/routes/state.ts`
- [x] `GET /api/state` returns DashboardSnapshot (same shape as local API)
- [x] Query active agents from sessions table (status = 'active' OR recently completed)
- [x] Query recent completions (status = 'completed' OR 'failed', ORDER BY completed_at DESC)
- [x] Merge session completions + GitHub events into recentActivity timeline
- [x] Calculate daily stats (PRs merged, issues closed, commits, sessions completed)
- [x] Detect unique projects from sessions and github_events
- [x] Query latest account usage from usage_snapshots
- [x] Optional `?project=` filter
- [x] Return JSON matching DashboardSnapshot schema

### GitHub Routes

- [x] Create `src/worker/src/routes/github.ts`
- [x] `POST /api/github/webhook` endpoint (no auth, HMAC verified)
- [x] Verify `X-Hub-Signature-256` header against GITHUB_WEBHOOK_SECRET
- [x] Parse `X-GitHub-Event` header for event type
- [x] Handle `push`, `pull_request`, `issues`, `issue_comment` events
- [x] Store in github_events table
- [x] Return 204 No Content on success
- [x] Return 401 on invalid HMAC

### Repo Routes

- [x] Create `src/worker/src/routes/repos.ts`
- [x] `GET /api/repos` — list all repos from repos table
- [x] `GET /api/repos/:owner/:repo/issues` — list issues for a repo
- [x] `GET /api/repos/:owner/:repo/pulls` — list PRs for a repo

### Stats Route

- [x] Create `src/worker/src/routes/stats.ts`
- [x] `GET /api/stats` — return daily stats (PRs merged, issues closed, commits, sessions completed)
- [x] Optional `?date=` param for historical stats

### Sync Routes

- [x] Create `src/worker/src/routes/sync.ts`
- [x] `POST /api/sync/issues` — fetch issues from GitHub API, upsert into D1
- [x] `POST /api/sync/prs` — fetch PRs from GitHub API, upsert into D1
- [x] Use GITHUB_TOKEN and GITHUB_REPOS env vars
- [x] Return sync summary: `{ synced: N, repos: [...] }`

### Deployment & Verification

- [x] Deploy Worker: `wrangler deploy`
- [x] Verify health check: `curl https://grove-api.{domain}.workers.dev/api/health`
- [x] Set secrets: `wrangler secret put ADMIN_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`
- [x] Test ingestion: POST /api/ingest with valid key
- [x] Test state endpoint: GET /api/state returns valid JSON
- [x] Verify CORS headers in browser

### Acceptance

- [x] Worker deploys successfully to Cloudflare
- [x] Health check returns `{ status: "ok", runtime: "cloudflare-workers" }`
- [x] POST /api/ingest with valid API key stores events in D1
- [x] GET /api/state returns DashboardSnapshot matching local API schema
- [x] Invalid API key returns 401
- [x] Admin endpoints require ADMIN_SECRET
- [x] CORS headers set for dashboard origin

---

## API Key Management (G-402)

### Admin Routes

- [x] Create `src/worker/src/routes/admin.ts`
- [x] `POST /admin/keys` with `requireAdmin` middleware
- [x] Generate key: `grove_sk_{48-char-hex}` (24 random bytes via crypto.getRandomValues)
- [x] Store in KV: key → `{ operator_id, name, created_at }`
- [x] Return `{ key, operator_id, name, created_at }`
- [x] `DELETE /admin/keys/:key` with `requireAdmin` middleware
- [x] Delete from KV, return `{ ok: true, revoked: key }`

### Key Validation

- [x] `requireApiKey` middleware reads key from KV
- [x] Extract operator_id from key metadata
- [x] Use operator_id for event attribution in ingest route
- [x] Return 401 if key not found or missing Authorization header

### Testing

- [x] Create test keys for Luna and Ivy
- [x] Verify POST /api/ingest with valid key succeeds
- [x] Verify invalid key returns 401
- [x] Verify DELETE /admin/keys revokes key

### Acceptance

- [x] POST /admin/keys creates key in KV and returns it
- [x] DELETE /admin/keys/:key removes key from KV
- [x] POST /api/ingest with invalid key returns 401
- [x] Admin endpoints without ADMIN_SECRET return 403
- [x] Generated keys are 24 bytes (48 hex chars) + `grove_sk_` prefix

---

## Bot Cloud Event Publisher (G-401)

### CloudPublisher Class

- [x] Create `src/bot/lib/cloud-publisher.ts`
- [x] CloudPublisherConfig interface (endpoint, apiKey, operatorId, batchIntervalMs, batchSizeLimit, maxRetries, retryBaseMs)
- [x] `publish(event)` — add to buffer
- [x] `flush()` — send pending events immediately
- [x] `close()` — flush + stop interval timer
- [x] Internal: batch buffer (array of PublishedEvent)
- [x] Internal: setInterval timer (triggers flush every 2s)
- [x] Internal: flush logic drains buffer, POSTs to /api/ingest
- [x] Retry logic: exponential backoff (2s, 4s, 8s)
- [x] Drop batch after maxRetries exhausted (log error, don't crash)

### Bot Integration

- [x] Update `src/bot/types/config.ts` with api.mode, api.endpoint, api.apiKey, api.operatorId
- [x] Instantiate CloudPublisher in `grove-bot.ts` if `api.mode === "cloud"`
- [x] Wire into event pipeline: call `cloudPublisher.publish(event)` after local processing
- [x] On shutdown: call `cloudPublisher.close()` to flush pending events
- [x] Log cloud publish errors (don't block local processing)

### Testing

- [x] Unit tests for CloudPublisher: `src/bot/lib/__tests__/cloud-publisher.test.ts`
- [x] Test batching behavior (50 events triggers immediate flush)
- [x] Test interval flush (2s timer)
- [x] Test retry logic (exponential backoff)
- [x] Test drop after maxRetries
- [x] Test close() waits for pending flush
- [x] Integration test: bot with cloud mode POSTs to mock Worker endpoint

### Acceptance

- [x] Bot with `api.mode: cloud` POSTs batched events to Worker
- [x] Events arrive in D1 with correct operator_id
- [x] Duplicate events (same event_id) ignored via INSERT OR IGNORE
- [x] Failed POST retries with exponential backoff
- [x] After 3 retries, batch is dropped (logged, not fatal)
- [x] Bot shutdown waits for pending flush to complete

---

## Dashboard Mode Detection (G-403)

> **Implementation note:** Build-time config was replaced with pure runtime resolution via `mode-detection.ts`. This is a better approach — no build step needed, all config via URL params and localStorage.

### Runtime Mode Resolution (replaced build-time config)

- [x] `resolveMode()` resolves connection from URL params, localStorage, and hostname detection
- [x] Default to `http://localhost:8766` for local, `https://grove-api.meta-factory.ai` for cloud
- [x] Auto-detect local vs cloud via `/api/health` response (`runtime` field)

### Runtime Detection

- [x] Dashboard reads mode at startup via `resolveMode()` priority chain
- [x] `detectModeFromHealth()` checks `/api/health` for `runtime: "cloudflare-workers"` vs `"bun"`
- [x] Disconnected state handled via `use-grove-api.ts` connection lifecycle
- [x] User can override with `?mode=` and `?api=` URL params

### URL Param Override

- [x] Parse `?mode=local` → force `http://localhost:8766`
- [x] Parse `?mode=cloud` → use configured cloud endpoint
- [x] Parse `?api=https://...` → custom endpoint (auto-detect mode)
- [x] Parse `?apis=url1,url2` → legacy multi-API merge mode

### Persistence

- [x] `saveConnection()` persists resolved mode + URLs to localStorage
- [x] `loadStoredConnection()` reads from localStorage as fallback
- [x] Hostname-based detection: `grove.meta-factory.ai` → cloud, `localhost` → local

### Testing

- [x] 24-case test suite in `src/dashboard/__tests__/mode-detection.test.ts`

### Acceptance

- [x] Dashboard on localhost auto-detects local mode (connects to same origin)
- [x] Dashboard on `grove.meta-factory.ai` auto-detects cloud mode
- [x] `?mode=local` overrides and connects to localhost
- [x] `?mode=cloud` uses configured cloud endpoint
- [x] `?api=` custom URL triggers auto-detect via health check
- [x] No error thrown if cloud API is unreachable (graceful degradation)

---

## GitHub Webhook Migration (G-404)

### Worker Webhook Endpoint

- [x] `POST /api/github/webhook` implemented (see G-400)
- [x] Verifies `X-Hub-Signature-256` HMAC
- [x] Parses `X-GitHub-Event` header
- [x] Stores in github_events table
- [x] Returns 204 No Content

### GitHub Configuration

- [ ] Update webhook URLs in GitHub repo settings
- [ ] Change from `https://{tunnel}.trycloudflare.com/api/github/webhook`
- [ ] To `https://grove-api.{domain}.workers.dev/api/github/webhook`
- [ ] Set webhook secret to GITHUB_WEBHOOK_SECRET value
- [ ] Test webhook delivery in GitHub UI

### Dashboard Integration

- [ ] Verify `GET /api/state` includes GitHub activity in recentActivity
- [ ] Verify PRs merged, issues closed show on dashboard
- [ ] Verify agent-authored PRs detected via author heuristic

### Acceptance

- [ ] GitHub webhooks point to Worker endpoint
- [ ] Worker verifies HMAC correctly
- [ ] Invalid HMAC returns 401
- [ ] Supported events stored in github_events table
- [ ] Dashboard shows GitHub activity (PRs, issues, commits)
- [ ] No duplicate events from multiple bots

---

## Automated Cloud Setup CLI (G-405)

### CLI Command

- [ ] Create `src/cli/cloud-setup.ts`
- [ ] Command: `grove-bot cloud setup`
- [ ] Prompt for principal ID (e.g., "andreas")
- [ ] Prompt for bot name (e.g., "Luna")
- [ ] Prompt for admin secret (from Cloudflare Workers)
- [ ] Prompt for Worker endpoint URL

### API Key Creation

- [ ] Call `POST /admin/keys` with provided operator_id, name, admin secret
- [ ] Parse response to extract generated key
- [ ] Handle errors (invalid admin secret, network failure)

### Config Writing

- [ ] Read existing `~/.config/grove/bot.yaml` (if exists)
- [ ] Update `api.mode: cloud`
- [ ] Update `api.endpoint: {provided URL}`
- [ ] Update `api.apiKey: {generated key}`
- [ ] Update `api.operatorId: {provided ID}`
- [ ] Write back to `~/.config/grove/bot.yaml`
- [ ] Preserve existing config (discord, security, relay, etc.)

### Success Output

- [ ] Print success message with masked key
- [ ] Print endpoint and principal ID
- [ ] Print next steps (start bot, deploy dashboard)

### Acceptance

- [ ] `grove-bot cloud setup` prompts for required inputs
- [ ] Creates API key via POST /admin/keys
- [ ] Writes bot.yaml with cloud mode config
- [ ] Prints success message with masked key
- [ ] If admin secret is invalid, prints error and exits (no partial config)

---

## Execution Order

```
G-400 (Worker + D1)
  │
  ▼
G-402 (API Key Management)
  │
  ▼
G-401 (Bot Cloud Publisher)
  │
  ▼
G-403 (Dashboard Mode Detection)
  │
  ▼
G-404 (GitHub Webhook Migration)
  │
  ▼
G-405 (Cloud Setup CLI)
```

- **G-400 first** — foundation (Worker + D1 + endpoints)
- **G-402 next** — security layer (can't POST without keys)
- **G-401 next** — bot integration (can now send events)
- **G-403 next** — dashboard reads from cloud or local
- **G-404 next** — migrate GitHub webhooks
- **G-405 last** — UX polish (automated setup)

---

## Exit Criteria

1. Worker deployed at `https://grove-api.{domain}.workers.dev`
2. POST /api/ingest with valid API key stores events in D1
3. GET /api/state returns DashboardSnapshot matching local API
4. Bot with `api.mode: cloud` sends events to Worker
5. Dashboard connects to cloud API and shows all operators
6. GitHub webhooks point to Worker, events stored in D1
7. `grove-bot cloud setup` creates key and configures bot.yaml
8. Local mode still works (zero-config default)

---

## Success Metrics

- **Zero-config local mode works:** Bot starts, dashboard loads, no cloud needed
- **Multi-principal cloud mode works:** Andreas + JC bots POST to one Worker, dashboard shows both
- **No tunnel infrastructure:** GitHub webhooks point to Worker, not per-bot tunnels
- **Event deduplication eliminated:** One D1 source, no browser-side merge logic
- **Setup time < 2 minutes:** `grove-bot cloud setup` gets you from zero to cloud-ready

---

## Cleanup

- [ ] Delete Cloudflare Tunnels from CF dashboard (grove-api, grove-api-jc) to stop incurring cost
- [ ] Remove tunnel DNS records (grove-api.meta-factory.ai, grove-api-jc.meta-factory.ai)
- [ ] Add custom domain to Worker (grove-api.meta-factory.ai → Worker route) if desired
- [ ] Remove `cloudflared` from principal machines (optional)

---

## Migration Checklist

- [ ] Admin runs `grove-bot cloud setup` (deploys Worker + D1)
- [ ] Admin runs `grove-bot cloud add-operator` for each operator
- [ ] Each principal adds `mode: cloud` + key to bot.yaml
- [ ] Verify: dashboard shows both agents
- [ ] Move GitHub webhooks to Worker endpoint
- [ ] Delete old CF tunnels to save cost
- [ ] Update installation.md with cloud setup option ✓
- [ ] Update roadmap.md with G-400 series ✓
