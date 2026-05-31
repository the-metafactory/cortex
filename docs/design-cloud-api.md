# Cloud API — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-cloud-api.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Scope:** Cloudflare Worker + D1 event store (G-400), bot cloud publisher (G-401), API key management (G-402), dashboard mode detection (G-403), GitHub webhook migration (G-404)
**Mission:** Multiple bot principals share a single dashboard without tunnels. Local-first mode stays as default zero-config option. Cloud mode is opt-in for multi-principal networks.
**Stack:** Cloudflare Workers (Hono + D1 + KV), batched event ingestion from bots, dashboard reads from cloud or local API
**Inputs:** dashboard-api.ts contract, DashboardSnapshot schema, PublishedEvent schema, existing relay pipeline

---

## Why This Exists

Today, each principal runs local SQLite + dashboard API + Cloudflare Tunnel. The dashboard merges multiple APIs in the browser with dedup heuristics. This works but is fragile:

- GitHub events duplicated across principals
- Merge logic is approximate (same agent ID = same agent?)
- Every principal needs tunnel infrastructure
- Dashboard reads from N endpoints, each with its own schema drift risk

The cloud API is a single endpoint that all bots POST to. The dashboard reads from one place. Local mode (no cloud, no tunnel) remains the default for solo principals.

---

## Two Deployment Modes

| Mode | Config | Infrastructure | Use Case |
|------|--------|---------------|----------|
| `local` (default) | Zero config | Bot + SQLite only | Solo principal, no internet needed |
| `cloud` | `api.mode: cloud` in bot.yaml | CF Worker + D1 | Multi-principal network |

**Local mode:**
- Bot runs dashboard API on localhost:8766 (Bun.serve)
- Dashboard connects to `http://localhost:8766/api/state`
- No cloud, no tunnel, no config — just works
- SQLite database at `~/.config/grove/dashboard.db`

**Cloud mode:**
- Bot POSTs events to `https://grove-api.{domain}.workers.dev/api/ingest`
- Dashboard connects to the same Worker endpoint
- Principal-scoped API keys via Workers KV (G-402)
- All principals see all agents on one dashboard
- D1 database (`grove-events`) in OC/AKL region

**Mode detection (G-403):**
- Dashboard reads `?api=` URL param or env var at build time
- If `api=local`, connect to `http://localhost:8766`
- If `api=cloud`, connect to the configured Worker endpoint
- Auto-detect: try cloud, fall back to local if unreachable

---

## Features

### G-400: Cloud Worker + D1 Event Store

A Cloudflare Worker exposing the same REST API contract as the local dashboard-api.ts.

**Endpoints:**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | None | Health check |
| POST | `/api/ingest` | API key | Batched event ingestion from bots |
| GET | `/api/state` | None | Dashboard snapshot (same shape as local API) |
| GET | `/api/state?project={id}` | None | Project-filtered snapshot |
| GET | `/api/events?since={ts}` | None | Event stream since timestamp |
| GET | `/api/repos` | None | List repos with metadata |
| GET | `/api/repos/{owner}/{repo}/issues` | None | List issues for a repo |
| GET | `/api/repos/{owner}/{repo}/pulls` | None | List PRs for a repo |
| GET | `/api/stats` | None | Daily stats (PRs merged, issues closed, commits) |
| POST | `/api/github/webhook` | HMAC | GitHub webhook ingestion |
| POST | `/admin/keys` | Admin secret | Create principal API key |
| DELETE | `/admin/keys/:key` | Admin secret | Revoke API key |
| POST | `/api/sync/issues` | None | Trigger GitHub issue sync |
| POST | `/api/sync/prs` | None | Trigger GitHub PR sync |

**D1 Schema:**

Tables:
- `sessions` — agent sessions (task start, progress, completion)
- `github_events` — GitHub activity (PRs, issues, pushes)
- `repos` — repo metadata
- `issues` — issue state
- `pull_requests` — PR state
- `usage_snapshots` — account usage tracking (5H/7D rate limits)

Key fields:
- `operator_id` on sessions/github_events — which bot principal sent this data
- `event_id` — dedup key (events are idempotent)
- `session_id` — links agent sessions to events

**Environment variables:**
- `GROVE_DB` — D1 binding
- `GROVE_KEYS` — KV binding for API keys
- `ADMIN_SECRET` — admin key for `/admin/keys` endpoints
- `GITHUB_WEBHOOK_SECRET` — GitHub webhook HMAC secret
- `GITHUB_TOKEN` — GitHub PAT for sync operations
- `GITHUB_REPOS` — comma-separated list of `owner/repo` to sync
- `CORS_ORIGIN` — CORS origin for dashboard (default `*`)

**Acceptance Criteria:**
- Worker deploys to `https://grove-api.{domain}.workers.dev`
- `GET /api/health` returns `{ status: "ok", runtime: "cloudflare-workers" }`
- `POST /api/ingest` with valid API key stores events in D1
- `GET /api/state` returns DashboardSnapshot matching local API schema
- Invalid API key returns 401
- Missing Authorization header returns 401
- Admin endpoints require `ADMIN_SECRET` Bearer token
- CORS headers set correctly for dashboard origin

---

### G-401: Bot Cloud Event Publisher

Batched event publisher that POSTs published events from the bot to the cloud Worker.

**Configuration (`bot.yaml`):**
```yaml
api:
  mode: cloud                                      # "local" | "cloud"
  endpoint: "https://grove-api.andreas-aastroem.workers.dev"
  apiKey: "grove_sk_..."                           # principal API key
  operatorId: "andreas"                            # principal identifier
```

**Behavior:**
- `publish(event)` adds event to buffer
- Every 2s OR when buffer hits 50 events, POST batch to `{endpoint}/api/ingest`
- On failure: retry with exponential backoff (2s, 4s, 8s), then drop
- `flush()` sends pending events immediately
- `close()` flushes + stops the interval timer

**Request format:**
```json
{
  "operator_id": "andreas",
  "events": [
    {
      "event_id": "abc123",
      "event_type": "agent.task.started",
      "timestamp": "2026-03-29T10:15:00Z",
      "session_id": "def456",
      "agent_id": "luna",
      "agent_name": "Luna",
      "grove_channel": "grove",
      "payload": { "prompt_preview": "G-400: Cloud API..." }
    }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "ingested": 50,
  "skipped": 0
}
```

**Integration:**
- CloudPublisher instantiated if `api.mode === "cloud"`
- Wired into the bot's event pipeline (parallel to worklog posting)
- On bot shutdown, `cloudPublisher.close()` flushes pending events
- If cloud POST fails, events are NOT lost — they're in local JSONL (`~/.claude/events/published/`)

**Acceptance Criteria:**
- Bot with `api.mode: cloud` POSTs batched events to Worker
- Events arrive in D1 with correct `operator_id`
- Duplicate events (same `event_id`) are ignored (INSERT OR IGNORE)
- Failed POST retries with exponential backoff
- After 3 retries, batch is dropped (logged, not fatal)
- Bot shutdown waits for pending flush to complete

---

### G-402: API Key Management

Principal API keys stored in Workers KV. Admin endpoints for create/revoke.

**Key format:** `grove_sk_{48-char-hex}` (24 random bytes)

**KV schema:**
```json
{
  "operator_id": "andreas",
  "name": "Luna bot",
  "created_at": "2026-03-29T10:00:00Z"
}
```

**Admin endpoints:**

**POST /admin/keys**
```bash
curl -X POST https://grove-api.{domain}.workers.dev/admin/keys \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"operator_id": "andreas", "name": "Luna bot"}'
```

Response:
```json
{
  "key": "grove_sk_abc123...",
  "operator_id": "andreas",
  "name": "Luna bot",
  "created_at": "2026-03-29T10:00:00Z"
}
```

**DELETE /admin/keys/:key**
```bash
curl -X DELETE https://grove-api.{domain}.workers.dev/admin/keys/grove_sk_abc123... \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Response:
```json
{
  "ok": true,
  "revoked": "grove_sk_abc123..."
}
```

**Middleware:**
- `requireApiKey(c, next)` — validates Bearer token against KV, sets `c.set("operatorId", ...)`
- `requireAdmin(c, next)` — validates Bearer token against `ADMIN_SECRET` env var

**Acceptance Criteria:**
- POST /admin/keys creates key in KV and returns it
- DELETE /admin/keys/:key removes key from KV
- POST /api/ingest with invalid key returns 401
- Admin endpoints without ADMIN_SECRET return 403
- Generated keys are 24 bytes (48 hex chars) + `grove_sk_` prefix
- Key validation extracts `operator_id` from KV and uses it for event attribution

---

### G-403: Dashboard Mode Detection

Dashboard auto-detects local vs cloud mode.

**Build-time config:**
```bash
# Local mode (default)
bun build src/dashboard/index.html --outdir dist/dashboard

# Cloud mode
API_ENDPOINT=https://grove-api.andreas-aastroem.workers.dev \
  bun build src/dashboard/index.html --outdir dist/dashboard
```

**Runtime behavior:**
1. Dashboard reads `API_ENDPOINT` env var (injected at build time)
2. If unset, defaults to `http://localhost:8766` (local mode)
3. Tries WebSocket connection to detected endpoint
4. If connection fails for 10s, shows "disconnected" indicator
5. User can override with `?api=` URL param

**URL param override:**
- `?api=local` → force `http://localhost:8766`
- `?api=cloud` → force configured cloud endpoint
- `?api=https://custom.workers.dev` → custom endpoint

**Acceptance Criteria:**
- Dashboard built without env var connects to localhost:8766
- Dashboard built with API_ENDPOINT connects to that URL
- `?api=local` overrides and connects to localhost
- `?api=cloud` uses configured cloud endpoint
- Disconnected indicator shows when endpoint is unreachable
- No error thrown if cloud API is unreachable (graceful degradation)

---

### G-404: GitHub Webhook Migration

Migrate GitHub webhooks from per-bot tunnels to the cloud Worker.

**Today:**
- Each principal runs a Cloudflare Tunnel
- GitHub webhooks point to `https://{tunnel-id}.trycloudflare.com/api/github/webhook`
- Each bot receives duplicate events
- Dashboard deduplicates in browser

**With G-404:**
- GitHub webhooks point to `https://grove-api.{domain}.workers.dev/api/github/webhook`
- Worker verifies HMAC, writes to D1
- All bots read from same D1 source
- No duplication, no dedup logic needed

**Endpoint: POST /api/github/webhook**
- Verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`
- Extracts event type from `X-GitHub-Event` header
- Parses payload and stores in `github_events` table
- Returns 204 No Content

**Supported events:**
- `push` — commit activity
- `pull_request` — PR opened/closed/merged
- `issues` — issue opened/closed
- `issue_comment` — comments (for agent attribution)

**Acceptance Criteria:**
- Worker endpoint verifies GitHub HMAC
- Invalid HMAC returns 401
- Supported events stored in `github_events` table
- `GET /api/state` includes GitHub activity in `recentActivity`
- Dashboard shows PRs merged, issues closed
- Agent-authored PRs detected via author heuristic (agent usernames in config)

---

### G-405: Automated Cloud Setup CLI

A CLI command for principals to set up cloud mode in one step.

**Usage:**
```bash
grove-bot cloud setup
```

**Behavior:**
1. Prompts for principal ID (e.g., "andreas")
2. Prompts for bot name (e.g., "Luna")
3. Prompts for admin secret (from Cloudflare Workers env vars)
4. Calls `POST /admin/keys` to create API key
5. Writes `~/.config/grove/bot.yaml` with cloud config
6. Prints success message with endpoint and key (masked)

**Output:**
```
✓ Cloud API key created for principal: andreas
✓ bot.yaml updated with cloud mode config
✓ Ready to start grove-bot

Endpoint: https://grove-api.andreas-aastroem.workers.dev
Principal: andreas
API key:  grove_sk_***...*** (48 chars)

Next steps:
1. Start the bot: grove-bot start
2. Deploy dashboard: cd src/dashboard && bun build && npx wrangler pages deploy dist/dashboard
```

**Acceptance Criteria:**
- `grove-bot cloud setup` prompts for operator ID, bot name, admin secret
- Creates API key via POST /admin/keys
- Writes bot.yaml with `api.mode: cloud`, endpoint, key, principal ID
- Prints success message with masked key
- If admin secret is invalid, prints error and exits (no partial config)

---

## Security Model

**API Keys (G-402):**
- Principal keys stored in Workers KV
- Keys are Bearer tokens: `Authorization: Bearer grove_sk_...`
- Key format: `grove_sk_{48-char-hex}` (24 random bytes)
- Each key tied to one `operator_id`
- Events ingested with a key are attributed to that principal
- Keys can be revoked via admin endpoint

**Admin Secret:**
- Single shared secret for admin endpoints
- Set via `wrangler secret put ADMIN_SECRET`
- Required for creating/revoking keys
- NOT exposed to bots or dashboard

**GitHub Webhook HMAC:**
- Worker verifies `X-Hub-Signature-256` header
- Secret set via `wrangler secret put GITHUB_WEBHOOK_SECRET`
- Invalid HMAC returns 401
- Prevents spoofed GitHub events

**Dashboard:**
- No auth on `GET /api/state` (public read)
- Dashboard is a static site on Cloudflare Pages
- Protected by Cloudflare Access (email OTP or GitHub OAuth)
- Access policy configured per deployment (e.g., Andreas + JC only)

**Threat model:**
- **Leaked API key:** Attacker can POST events attributed to that principal. Mitigation: revoke key via admin endpoint.
- **Leaked admin secret:** Attacker can create/revoke keys. Mitigation: rotate secret via `wrangler secret put`.
- **No GitHub webhook HMAC:** Attacker can inject fake events. Mitigation: HMAC is mandatory, enforced at Worker.
- **Public dashboard data:** Anyone with Cloudflare Access can see all agent work. Mitigation: Access policy limits who can authenticate.

---

## Data Model (D1 Schema)

**sessions table:**
```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  operator_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project TEXT,
  description TEXT,
  github_issue TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'active',
  pr_url TEXT,
  events_count INTEGER DEFAULT 0,
  last_event TEXT,
  last_event_at TEXT,
  progress_completed INTEGER,
  progress_total INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_usd REAL
);
```

**github_events table:**
```sql
CREATE TABLE github_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  operator_id TEXT,
  repo TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT,
  number INTEGER,
  url TEXT,
  author TEXT,
  agent_authored INTEGER DEFAULT 0,
  linked_session TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now'))
);
```

**repos, issues, pull_requests, usage_snapshots:**
See `src/worker/schema.sql` for full schema.

**Indexes:**
- `idx_sessions_status` — query active sessions
- `idx_sessions_completed` — query recent completions
- `idx_sessions_operator` — filter by principal
- `idx_github_repo` — query GitHub events by repo
- `idx_github_agent` — filter agent-authored events

---

## Implementation Order

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

**Rationale:**
- G-400 first: foundation (Worker + D1 + endpoints)
- G-402 next: security layer (can't POST without keys)
- G-401 next: bot integration (can now send events)
- G-403 next: dashboard reads from cloud or local
- G-404 next: migrate GitHub webhooks (eliminates duplication)
- G-405 last: UX polish (automated setup)

---

## Not In Scope

- **Multi-region D1:** Single OC/AKL region. If latency matters, add read replicas later.
- **Event retention policy:** D1 grows forever. Add TTL or archival later if needed.
- **Principal-scoped dashboard views:** All authenticated users see all principals. Per-principal filtering is a future option.
- **Real-time WebSocket from Worker:** Dashboard polls `GET /api/state`. WebSocket support is a stretch goal.
- **Billing/usage enforcement:** Principals trust each other. No rate limits or quotas.
- **Audit log:** No log of who accessed what. Add if needed.
- **Event replay:** Events are idempotent, but no UI to replay from JSONL.
- **Local-to-cloud migration tool:** Principals manually reconfigure. No automated migration script.

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| Cloudflare Workers account | Have (meta-factory.dev) | Required for G-400 |
| D1 database | Created (grove-events) | Required for G-400 |
| Workers KV namespace | Created (grove-keys) | Required for G-402 |
| Cloudflare Pages | Have | Required for dashboard |
| Hono framework | Installed | Required for Worker routing |
| Existing dashboard API contract | Defined (dashboard-api.ts) | G-400 must match this |
| PublishedEvent schema | Defined (event-types.ts) | G-401 uses this |
| Local bot event pipeline | Working | G-401 plugs into this |

---

## Exit Criteria

1. Worker deployed at `https://grove-api.{domain}.workers.dev`
2. `POST /api/ingest` with valid API key stores events in D1
3. `GET /api/state` returns DashboardSnapshot matching local API
4. Bot with `api.mode: cloud` sends events to Worker
5. Dashboard connects to cloud API and shows all principals
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
