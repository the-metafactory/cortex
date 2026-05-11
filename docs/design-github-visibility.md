# GitHub Visibility & Dashboard Persistence — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-github-visibility.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Feature ID:** G-203
**Scope:** GitHub webhook ingestion, persistent dashboard state, unified activity timeline
**Mission:** See what agents have actually accomplished — PRs merged, issues closed, code committed — not just CC session events. Data persists across restarts and accumulates over time.
**Stack:** Bun + bun:sqlite, @octokit/webhooks, existing grove-api (Bun.serve), Cloudflare Pages dashboard
**Inputs:** design-agent-visibility.md (G-200/201/202), research into GitHub APIs and dashboard tools

---

## Why This Exists

The dashboard currently shows CC session events: "agent started", "tool used", "task completed". But the real output of agent work lives in GitHub — PRs opened, issues resolved, code merged, reviews completed. Without this, the dashboard shows process but not outcomes.

Additionally, the dashboard state is ephemeral — it rehydrates from the last 24h of event files but has no long-term memory. You can't see what happened yesterday or track progress over a week.

**Research findings (2026-03-29):**
- Polling GitHub Events API is unsuitable: 30s–6h latency, max 300 events, 98.5% of polls return nothing
- GitHub webhooks are the correct event-driven approach: real-time push, no rate limits consumed, automatic retry on failure
- `@octokit/webhooks` handles HMAC signature verification and event routing
- grove-api is already public via Cloudflare tunnel at `grove-api.meta-factory.ai` — webhooks can hit it directly
- No off-the-shelf tool does agent attribution; custom logic needed regardless
- Agent attribution via `Co-Authored-By: Claude` commit trailer, branch patterns, and issue comment SOPs

---

## Features

### G-203a: Persistent Dashboard Store

Replace in-memory state with SQLite for durable storage.

**Database:** `~/.config/grove/state/dashboard.db` (via `bun:sqlite`)

**Schema:**

```sql
-- Agent sessions (replaces in-memory activeTasks + completions)
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project TEXT,
  description TEXT,
  github_issue TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'active',  -- active | completed | failed
  pr_url TEXT,
  events_count INTEGER DEFAULT 0,
  last_event TEXT,
  last_event_at TEXT,
  progress_completed INTEGER,
  progress_total INTEGER
);

-- GitHub activity (populated by webhooks)
CREATE TABLE github_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,           -- GitHub delivery ID (dedup)
  repo TEXT NOT NULL,             -- e.g., "the-metafactory/grove"
  event_type TEXT NOT NULL,       -- pr_opened, pr_merged, pr_closed, issue_opened, issue_closed, comment, push, release
  title TEXT,                     -- PR title, issue title, commit message
  number INTEGER,                -- PR/issue number
  url TEXT,                       -- Link to PR/issue/commit on GitHub
  author TEXT,                    -- GitHub username
  agent_authored BOOLEAN DEFAULT FALSE,  -- Detected as agent work?
  linked_session TEXT,            -- FK to sessions.session_id (if matchable)
  payload TEXT,                   -- JSON blob for extra data (labels, reviewers, etc.)
  created_at TEXT NOT NULL,       -- When the event happened on GitHub
  received_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_completed ON sessions(completed_at);
CREATE INDEX idx_github_repo ON github_events(repo, created_at);
CREATE INDEX idx_github_agent ON github_events(agent_authored, created_at);
CREATE INDEX idx_github_event_id ON github_events(event_id);
```

**Migration from in-memory:**
- `DashboardState` backs its maps/arrays with SQLite reads/writes
- `handleEvent()` upserts into `sessions` table (INSERT OR REPLACE on session_id)
- `getSnapshot()` queries: active sessions (status='active'), recent completions (ORDER BY completed_at DESC LIMIT 50)
- Active tasks still held in-memory Map for fast access during real-time event processing, flushed to DB on completion
- Event dedup uses `seenEventIds` Set (in-memory) for hot path, DB UNIQUE constraint as safety net
- JSONL rehydration still works as bootstrap for fresh DB (replays into same handleEvent path)

**What this gives you:**
- Dashboard shows completions from all time, not just since last restart
- "What did Luna do this week?" is a DB query
- No data loss on restarts, upgrades, crashes
- GitHub events and CC sessions in the same store, queryable together

---

### G-203b: GitHub Webhook Ingestion

Receive GitHub webhook events on the existing grove-api. Real-time push, no polling.

**Architecture:**

```
GitHub repo webhooks
  │
  ▼  POST /api/github/webhook (HMAC-verified)
grove-api (Bun.serve, already running)
  │
  ├── @octokit/webhooks parses + verifies signature
  ├── Agent attribution logic (Co-Authored-By, branch patterns)
  ├── Insert into github_events table (SQLite)
  └── Broadcast snapshot to WebSocket clients
```

**Webhook endpoint:** `POST /api/github/webhook` on existing `grove-api.meta-factory.ai`

**Signature verification:** `@octokit/webhooks` handles `X-Hub-Signature-256` HMAC validation using a configured webhook secret.

**Configuration (`bot.yaml`):**
```yaml
github:
  webhookSecret: "whsec_..."       # GitHub webhook secret (HMAC verification)
  repos:                            # Repos to accept webhooks from (allowlist)
    - the-metafactory/meta-factory
    - the-metafactory/grove
    - mellanon/arc
  agentDetection:
    commitTrailers:                 # Strings to match in commit messages
      - "Co-Authored-By: Claude"
    branchPatterns:                 # Regex patterns for agent-created branches
      - "^feat/(g|f|i)-\\d+"
    commentPatterns:                # Regex patterns for agent issue comments
      - "^Starting:"
      - "^Completed:"
```

**GitHub events to subscribe to (configure per-repo webhook):**

| GitHub Event | What We Extract | Dashboard Event Type |
|---|---|---|
| `pull_request.opened` | title, number, author, branch, body | `pr_opened` |
| `pull_request.closed` (merged=true) | title, number, merge commit | `pr_merged` |
| `pull_request.closed` (merged=false) | title, number | `pr_closed` |
| `pull_request.review_requested` | title, reviewers | `pr_review_requested` |
| `issues.opened` | title, number, labels | `issue_opened` |
| `issues.closed` | title, number, closer | `issue_closed` |
| `issue_comment.created` | body preview, issue number | `comment` |
| `push` (default branch only) | commits, files changed | `push` |
| `release.published` | tag, title, body | `release` |

**Agent attribution heuristics (applied at ingestion time):**

1. **Commit trailer match:** Scan commit messages for configured trailer strings (e.g., `Co-Authored-By: Claude`). Applies to `push` events and PR merge commits.
2. **Branch pattern match:** PR source branch matches configured regex (e.g., `feat/g-203-*`). Agents follow naming conventions from CLAUDE.md.
3. **Comment pattern match:** Issue comment body starts with configured pattern (e.g., `Starting:`, `Completed:`). These are agent SOP phrases from Grove's CLAUDE.md.
4. **Author match:** If agents have dedicated GitHub accounts, match by username.

**Session linking:**
- When a GitHub event mentions an issue number (`#42`), search `sessions.github_issue` and `sessions.description` for matches
- When a PR is merged with `Co-Authored-By: Claude`, search recent sessions with matching project
- Store `linked_session` FK for dashboard to show the connection

**Implementation:**

```typescript
// src/bot/lib/github-webhook.ts

import { Webhooks } from "@octokit/webhooks";

export class GitHubWebhookHandler {
  private webhooks: Webhooks;
  private db: DashboardDb;
  private config: GitHubConfig;
  private onUpdate: () => void;  // trigger dashboard broadcast

  constructor(opts: { secret: string; db: DashboardDb; config: GitHubConfig; onUpdate: () => void }) {
    this.webhooks = new Webhooks({ secret: opts.secret });
    this.db = opts.db;
    this.config = opts.config;
    this.onUpdate = opts.onUpdate;

    this.webhooks.on("pull_request", ({ payload }) => this.handlePR(payload));
    this.webhooks.on("issues", ({ payload }) => this.handleIssue(payload));
    this.webhooks.on("issue_comment", ({ payload }) => this.handleComment(payload));
    this.webhooks.on("push", ({ payload }) => this.handlePush(payload));
    this.webhooks.on("release", ({ payload }) => this.handleRelease(payload));
  }

  /** Handle incoming webhook HTTP request */
  async handleRequest(req: Request): Promise<Response> {
    const body = await req.text();
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const event = req.headers.get("x-github-event") ?? "";
    const deliveryId = req.headers.get("x-github-delivery") ?? "";

    try {
      await this.webhooks.verifyAndReceive({
        id: deliveryId,
        name: event as any,
        payload: body,
        signature,
      });
      return new Response("ok", { status: 200 });
    } catch (err) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  private handlePR(payload: any): void {
    const repo = payload.repository.full_name;
    if (!this.isAllowedRepo(repo)) return;

    const action = payload.action;
    let eventType: string;
    if (action === "opened") eventType = "pr_opened";
    else if (action === "closed" && payload.pull_request.merged) eventType = "pr_merged";
    else if (action === "closed") eventType = "pr_closed";
    else return; // ignore other actions

    const agentAuthored = this.detectAgent(payload.pull_request);

    this.db.insertGitHubEvent({
      eventId: `pr-${payload.pull_request.id}-${action}`,
      repo,
      eventType,
      title: payload.pull_request.title,
      number: payload.pull_request.number,
      url: payload.pull_request.html_url,
      author: payload.pull_request.user.login,
      agentAuthored,
      linkedSession: this.findLinkedSession(payload.pull_request),
      createdAt: payload.pull_request.updated_at,
    });

    this.onUpdate();
  }

  // ... similar handlers for issues, comments, push, release
}
```

**GitHub repo webhook setup (one-time per repo):**
```bash
# For each repo, create a webhook pointing to grove-api:
gh api repos/the-metafactory/grove/hooks --method POST \
  --field url="https://grove-api.meta-factory.ai/api/github/webhook" \
  --field content_type="json" \
  --field secret="$WEBHOOK_SECRET" \
  --field events='["pull_request","issues","issue_comment","push","release"]'
```

**Resilience:**
- GitHub retries failed webhook deliveries (up to 3 times over 1 hour)
- If grove-api is down during delivery, events arrive on retry when it comes back
- Dedup via `event_id` UNIQUE constraint prevents double-processing on retry
- For initial setup or gap-filling: one-time `gh api` polling script can backfill recent events

---

### G-203c: Dashboard UI — Unified Activity Timeline

Extend the dashboard to show GitHub data alongside CC session data in a single chronological feed.

**Updated layout:**

```
┌──────────────────────────────┐
│  Grove Dashboard         🟢  │
│  [All] [metafactory] [Grove] │
├──────────────────────────────┤
│  ACTIVE (1)                  │
│ ┌──────────────────────────┐ │
│ │ 🏃 Luna • grove           │ │
│ │ G-203: GitHub Visibility  │ │
│ │ 3/6 tasks • 12m           │ │
│ │ #42 ↗                     │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│  RECENT ACTIVITY             │
│  🔀 PR #43 merged — grove    │
│    "feat: dashboard persist" │
│    Luna • 12m ago            │
│  ✅ Issue #35 closed — grove │
│    "Agent Visibility"        │
│    Luna • 1h ago             │
│  💬 Comment on #42 — grove   │
│    "Starting: implement..."  │
│    Luna • 2h ago             │
│  ⚡ CC task completed         │
│    "please review again"     │
│    Luna • 3h ago             │
├──────────────────────────────┤
│  STATS (today)               │
│  3 PRs merged  2 issues done │
│  47 files changed  12 commits│
├──────────────────────────────┤
│  Last updated: 10:30         │
└──────────────────────────────┘
```

**Key changes from current dashboard:**
- **RECENT ACTIVITY** replaces COMPLETED — unified timeline of CC sessions and GitHub events, sorted by time
- **Activity items** have type icons: 🔀 PR merged, ✅ issue closed, 💬 comment, ⚡ CC task, 📦 release, 🔓 issue opened
- **Agent badge** on agent-authored GitHub events (green dot or "Luna" label)
- **STATS row** — daily counters (PRs merged, issues closed, files changed, commits)
- **Project filter** works across both data sources (GitHub repo maps to project)
- **Clickable links** — PR/issue items link to GitHub

**API changes to `GET /api/state`:**

```json
{
  "projects": [...],
  "agents": [...],
  "recentActivity": [
    {
      "type": "pr_merged",
      "source": "github",
      "repo": "the-metafactory/grove",
      "title": "feat: dashboard persistence",
      "number": 43,
      "url": "https://github.com/the-metafactory/grove/pull/43",
      "author": "jcfischer",
      "agentAuthored": true,
      "agentName": "Luna",
      "timestamp": "2026-03-29T10:30:00Z"
    },
    {
      "type": "task_completed",
      "source": "session",
      "agentId": "luna",
      "agentName": "Luna",
      "project": "grove",
      "description": "please review again",
      "durationMs": 45000,
      "timestamp": "2026-03-29T10:15:00Z"
    }
  ],
  "stats": {
    "today": {
      "prsMerged": 3,
      "issuesClosed": 2,
      "commits": 12,
      "filesChanged": 47,
      "sessionsCompleted": 5
    }
  },
  "updatedAt": "..."
}
```

**Repo-to-project mapping:**
- `the-metafactory/meta-factory` → project `meta-factory`
- `the-metafactory/grove` → project `grove`
- `mellanon/arc` → project `arc`
- Derived from repo name (last segment), configurable override in bot.yaml

---

## Files to Change

| File | Feature | Change | ~Lines |
|------|---------|--------|--------|
| **New: `src/bot/lib/dashboard-db.ts`** | G-203a | SQLite store: create tables, insert/query sessions + github_events | 200 |
| `src/bot/lib/dashboard-state.ts` | G-203a | Backed by SQLite for persistence, in-memory for hot path | 80 changed |
| `src/bot/lib/dashboard-api.ts` | G-203a+c | Webhook route, unified activity timeline response | 60 changed |
| **New: `src/bot/lib/github-webhook.ts`** | G-203b | @octokit/webhooks handler, agent attribution, DB insertion | 200 |
| `src/bot/grove-bot.ts` | G-203b | Wire webhook handler, pass DB to dashboard | 20 changed |
| `src/bot/types/config.ts` | G-203b | Add `github` config schema (webhookSecret, repos, agentDetection) | 25 changed |
| `src/bot/bot.yaml.template` | G-203b | Add `github` config section | 15 changed |
| `src/dashboard/app.tsx` | G-203c | Unified activity timeline, stats row, type icons | 120 changed |

**Total new code: ~400 lines across 2 new files. Total changed: ~320 lines.**

**New dependency:** `@octokit/webhooks` (webhook signature verification + event routing)

---

## Configuration

```yaml
# bot.yaml additions
github:
  webhookSecret: ""                 # Set via: openssl rand -hex 32
  repos:
    - the-metafactory/meta-factory
    - the-metafactory/grove
    - mellanon/arc
  agentDetection:
    commitTrailers:
      - "Co-Authored-By: Claude"
    branchPatterns:
      - "^feat/(g|f|i)-\\d+"
    commentPatterns:
      - "^Starting:"
      - "^Completed:"
```

---

## Execution Order

```
G-203a (Persistent Store)
  │    Foundation: nothing else works without this
  ▼
G-203b (GitHub Webhooks)
  │    Data source: feeds GitHub events into the store
  ▼
G-203c (Dashboard UI)
       Presentation: renders both data sources in unified timeline
```

G-203a can ship independently — it improves the dashboard even without GitHub data. G-203b+c build on it.

---

## Acceptance Criteria

### G-203a: Persistent Dashboard Store
- [ ] SQLite DB created at `~/.config/grove/state/dashboard.db`
- [ ] Dashboard state survives restarts with full history
- [ ] Completions from previous days visible on dashboard
- [ ] Existing CC event handling works identically (no regression)
- [ ] JSONL rehydration bootstraps fresh DB correctly
- [ ] `bun test` — all existing tests pass, new DB tests added

### G-203b: GitHub Webhook Ingestion
- [ ] `POST /api/github/webhook` endpoint on grove-api
- [ ] HMAC signature verification via @octokit/webhooks
- [ ] Webhook accepts: pull_request, issues, issue_comment, push, release events
- [ ] Repo allowlist enforced (unknown repos rejected)
- [ ] Agent-authored events detected via commit trailers and branch patterns
- [ ] GitHub events stored in `github_events` table with dedup
- [ ] New events trigger dashboard WebSocket broadcast
- [ ] GitHub webhooks configured on all 3 repos
- [ ] `bun test` — webhook handler tests with sample payloads

### G-203c: Dashboard UI
- [ ] Unified RECENT ACTIVITY timeline shows both CC sessions and GitHub events
- [ ] Activity items show type icon, title, repo, agent badge, relative time
- [ ] Clickable links to GitHub PRs/issues
- [ ] STATS row shows daily summary (PRs, issues, commits, sessions)
- [ ] Project filter works across both data sources
- [ ] Mobile-responsive (same standards as G-202)
- [ ] Dashboard rebuilt and deployed to Cloudflare Pages

---

## Setup Steps (Post-Implementation)

1. Generate webhook secret: `openssl rand -hex 32`
2. Add to `~/.config/grove/bot.yaml` under `github.webhookSecret`
3. For each repo, create webhook:
   ```bash
   gh api repos/{owner}/{repo}/hooks --method POST \
     --field url="https://grove-api.meta-factory.ai/api/github/webhook" \
     --field content_type="json" \
     --field secret="$WEBHOOK_SECRET" \
     --field events='["pull_request","issues","issue_comment","push","release"]'
   ```
4. Verify: push a commit, check dashboard shows it

---

## Not In Scope

- GitHub API polling (webhooks are superior for real-time use)
- Write operations to GitHub from dashboard (read-only visibility)
- Cross-repo dependency tracking (just activity feed)
- Git blame or diff analysis
- Notifications or alerts based on GitHub activity
- Grafana integration (existing dashboard is sufficient)
- GitHub App registration (simple repo webhooks are enough)
- Historical backfill on first install (future enhancement)

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| grove-api (G-201) | Working | Webhook endpoint lives here |
| Cloudflare tunnel | Working | Makes grove-api reachable from GitHub |
| bun:sqlite | Built-in | No new dependency for persistence |
| @octokit/webhooks | Need to install | Webhook signature verification |
| GitHub repo admin | Have access | Required to create webhooks |
| Dashboard (G-202) | Working | UI to extend |
