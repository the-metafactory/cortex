# Grove API Security Hardening — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-api-security.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Scope:** Lock down all Grove API endpoints — cloud worker and local dashboard
**Mission:** No unauthenticated access to sensitive data. Write endpoints already protected; read endpoints are wide open.
**Prerequisite:** Security audit (2026-03-31) found 9 public read endpoints on cloud worker with no auth

---

## Current State

### What's Protected

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `POST /api/ingest` | API key (Bearer) | Operator key from GROVE_KEYS KV |
| `POST /api/sync` | API key (Bearer) | Same |
| `POST /admin/keys` | Admin secret | Shared ADMIN_SECRET env var |
| `DELETE /admin/keys/:key` | Admin secret | Same |
| `POST /api/github/webhook` | HMAC signature | x-hub-signature-256 |

### What's NOT Protected (the problem)

**Cloud worker** (`grove-api.meta-factory.ai`) — all GET endpoints are public:

| Endpoint | Data Exposed | Risk |
|----------|-------------|------|
| `GET /api/state` | Active agents, completions, usage stats | HIGH — full activity visibility |
| `GET /api/dashboard` | Combined state + repos + heatmap | HIGH — everything in one call |
| `GET /api/repos/:name/issues` | Issue titles, bodies, labels | MEDIUM — may contain sensitive info |
| `GET /api/repos/:name/pulls` | PR titles, branches, authors | MEDIUM |
| `GET /api/repos/:name/pulls/:n/comments` | Comment bodies | MEDIUM |
| `GET /api/stats/activity` | 90 days of who-did-what | HIGH — activity surveillance |
| `GET /api/pipeline/health` | Last event time, session count | LOW |
| `GET /api/health` | Runtime status | LOW |
| `GET /api/repos` | Repo list with counts | LOW |

**Local dashboard** (`localhost:8766`):
- Same read endpoints, plus `WS /ws` (unauthenticated WebSocket)
- Lower risk since it's localhost-bound, but any local process can connect

**CF Zero Trust Access** covers only the Pages frontend (`grove.meta-factory.ai`), NOT the worker API (`grove-api.meta-factory.ai`).

---

## S-001: CF Access on Cloud Worker Domain

**Problem:** `grove-api.meta-factory.ai` has no access control.

**Fix:** Add CF Access application policy to the worker domain. The dashboard frontend (on CF Pages behind CF Access) already has a valid CF Access JWT after user authenticates. The worker validates that JWT on read endpoints.

**How it works:**
1. User authenticates via CF Access on `grove.meta-factory.ai` (already happens)
2. Browser receives `CF_Authorization` cookie (JWT)
3. Dashboard frontend makes API calls to `grove-api.meta-factory.ai` — browser sends cookie cross-origin
4. Worker validates JWT using CF Access public keys (audience tag check)
5. Bot-to-worker calls (`POST /api/ingest`, `POST /api/sync`) bypass CF Access via Service Auth header

**Implementation:**
- CF dashboard: Add Access Application for `grove-api.meta-factory.ai` with same policy as Pages
- Worker code: Add `validateCfAccess()` middleware for GET endpoints
- Keep API key auth for POST endpoints (bot-to-worker) — these use service tokens, not browser sessions
- Health endpoint (`/api/health`) stays public (uptime monitoring)

**Files:** `src/worker/src/auth.ts`, CF Zero Trust dashboard
**Effort:** 1 hour

**Acceptance Criteria:**
- Unauthenticated `curl https://grove-api.meta-factory.ai/api/state` returns 403
- Dashboard frontend (authenticated via CF Access) can still fetch all endpoints
- `POST /api/ingest` with valid API key still works (service auth bypass)
- `/api/health` remains public

---

## S-002: CORS Lockdown

**Problem:** CORS origin is `"*"` — any website can make API requests.

**Fix:** Restrict CORS to known origins only.

**Allowed origins:**
- `https://grove.meta-factory.ai` (production dashboard)
- `https://*.grove-dashboard-bky.pages.dev` (CF Pages preview deploys)
- `http://localhost:8766` (local development)

**Implementation:**
- Change `CORS_ORIGIN` env var from `"*"` to comma-separated allowed origins
- Update CORS middleware to check against allowlist

**Files:** `src/worker/src/index.ts`, CF Worker env vars
**Effort:** 15 minutes

**Acceptance Criteria:**
- Requests from `grove.meta-factory.ai` succeed with correct CORS headers
- Requests from random origins get blocked by CORS
- Preflight OPTIONS requests handled correctly

---

## S-003: Rate Limiting on Public Endpoints

**Problem:** No rate limiting — endpoints can be scraped or DoS'd.

**Fix:** Add rate limiting via CF Worker bindings (Rate Limiting API) or simple in-memory counters.

**Strategy:**
- Public endpoints (`/api/health`, `/api/pipeline/health`): 60 req/min per IP
- Authenticated read endpoints: 120 req/min per session
- Write endpoints (`/api/ingest`): 300 req/min per API key (burst tolerance for multi-agent)
- Admin endpoints: 10 req/min per IP

**Implementation:** CF Rate Limiting rules (configured in dashboard, not code) or Worker-level `RateLimiter` binding.

**Files:** CF dashboard or `src/worker/src/index.ts`
**Effort:** 30 minutes

**Acceptance Criteria:**
- Exceeding rate limit returns 429 with `Retry-After` header
- Normal dashboard polling (every 30s) stays well within limits
- Multi-agent bursts (3 agents × 10 events/min) don't trigger ingest limits

---

## S-004: Local WebSocket Authentication

**Problem:** Local `/ws` endpoint has no auth — any process on the machine can connect and receive real-time dashboard snapshots.

**Fix:** Require a session token on WebSocket upgrade. The dashboard frontend gets a token from a new `/api/ws-token` endpoint (localhost-only), and passes it as a query parameter on WebSocket connect.

**Implementation:**
- `GET /api/ws-token` returns a short-lived random token (stored in memory, 5-minute TTL)
- WebSocket upgrade checks `?token=` query parameter
- Invalid/missing token → reject upgrade with 401

**Files:** `src/bot/lib/dashboard-api.ts`
**Effort:** 30 minutes

**Acceptance Criteria:**
- WebSocket connection without token is rejected
- Dashboard frontend acquires token and connects successfully
- Tokens expire after 5 minutes (reconnect gets new token)

---

## S-005: Audit Logging for Auth Events

**Problem:** No visibility into who accessed what, or auth failures.

**Fix:** Log auth events (successes and failures) to D1 `audit_log` table.

**Events logged:**
- API key auth success/failure (principal, endpoint, IP)
- Admin auth success/failure (endpoint, IP)
- CF Access JWT validation success/failure (email, endpoint)
- Rate limit hits (IP, endpoint)

**Implementation:**
- Create `audit_log` D1 table
- Add logging in `requireApiKey`, `requireAdmin`, and new CF Access middleware
- `GET /admin/audit` endpoint (admin-only) to query recent events

**Files:** `src/worker/src/auth.ts`, `src/worker/schema.sql`
**Effort:** 1 hour

**Acceptance Criteria:**
- All auth attempts (success and failure) appear in audit log
- Admin can query recent auth events via `/admin/audit`
- Audit log entries include timestamp, IP, endpoint, result, and identity

---

## Priority Order

| ID | Feature | Priority | Effort | Impact |
|----|---------|----------|--------|--------|
| S-001 | CF Access on worker domain | P0 | 1h | Closes the main vulnerability |
| S-002 | CORS lockdown | P0 | 15m | Prevents cross-origin scraping |
| S-003 | Rate limiting | P1 | 30m | DoS protection |
| S-004 | WebSocket auth | P2 | 30m | Local-only, lower risk |
| S-005 | Audit logging | P2 | 1h | Observability, not protection |

---

## Out of Scope

- Per-principal admin keys (replacing shared ADMIN_SECRET) — separate feature
- API key rotation/expiry — separate feature
- mTLS between bot and worker — unnecessary given API key auth
- Encrypting JSONL files at rest — local files, user's machine
