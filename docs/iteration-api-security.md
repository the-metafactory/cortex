# API Security Hardening Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-api-security.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan tracks security hardening of Grove API endpoints.

**Mission:** No unauthenticated access to sensitive data on public endpoints.
**Design Spec:** `docs/design-api-security.md`
**Tracking Issue:** [#107](https://github.com/the-metafactory/grove/issues/107)

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress

---

## P0 — Close the Gaps

### S-001: CF Access on Cloud Worker Domain

- [x] Add CF Access Application for `grove-api.meta-factory.ai` (same policy as Pages)
- [x] Add `validateCfAccess()` middleware to worker auth.ts
- [x] Apply CF Access check to all GET endpoints except `/api/health`
- [x] Verify bot POST requests (API key auth) bypass CF Access via Service Auth
- [x] Test: unauthenticated curl to `/api/state` returns 403

### S-002: CORS Lockdown

- [x] Change CORS_ORIGIN env var to specific allowed origins
- [x] Update worker CORS middleware to validate against allowlist
- [x] Test: requests from `grove.meta-factory.ai` succeed
- [x] Test: requests from random origins are blocked

### Acceptance (P0)

- [x] Cloud worker read endpoints require CF Access authentication
- [x] CORS blocks cross-origin requests from unauthorized domains
- [x] Dashboard frontend still works (CF Access JWT passed via cookie)
- [x] Bot ingest/sync still works (API key auth, service token bypass)

---

## P1 — Defense in Depth

### S-003: Rate Limiting

- [x] Configure rate limits per endpoint category (public/read/write/admin)
- [x] Add 429 response with Retry-After header
- [x] Verify normal dashboard polling stays within limits
- [x] Verify multi-agent event bursts don't trigger ingest limits

### Acceptance (P1)

- [x] Rate limiting active on all endpoint categories
- [x] Normal usage unaffected
- [x] Excessive requests return 429

---

## P2 — Hardening (stretch)

### S-004: Local WebSocket Auth

- [x] Add `/api/ws-token` endpoint (short-lived token generation)
- [x] Require token on WebSocket upgrade
- [x] Dashboard frontend acquires token before connecting

### S-005: Audit Logging

- [x] Create `audit_log` D1 table
- [x] Log auth events in all middleware (success + failure)
- [x] Add `GET /admin/audit` endpoint

---

## Exit Criteria

- [x] All P0 checkboxes complete
- [x] All P1 checkboxes complete
- [x] No regressions in dashboard functionality
- [x] Unauthenticated access to sensitive endpoints returns 403
