# GitHub Visibility Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-github-visibility.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for GitHub visibility and dashboard persistence features. Iterations are logical vehicles, not timeboxes.

**Mission:** See agent outcomes (PRs, issues, commits) on the dashboard, with data that persists across restarts.
**Scope:** SQLite persistence, GitHub webhook ingestion, unified activity timeline
**Design Spec:** `docs/design-github-visibility.md`
**Tracking Issue:** [#43](https://github.com/the-metafactory/grove/issues/43)
**Prerequisite:** Agent Visibility (G-200/201/202) -- merged

---

## Legend

- `[x]` done
- `[ ]` not started
- `[ ]` in progress

---

## Persistent Dashboard Store (G-203a)

### Database

- [x] Create `src/bot/lib/dashboard-db.ts` with SQLite schema (sessions + github_events tables)
- [x] Auto-create DB at `~/.config/grove/state/dashboard.db` on first run
- [x] Insert/upsert methods for sessions (start, progress, complete)
- [x] Insert method for github_events (with UNIQUE dedup on event_id)
- [x] Query methods: active sessions, recent completions, recent activity (both sources)
- [x] Stats query: daily counts (PRs merged, issues closed, commits, sessions completed)

### State Migration

- [x] `DashboardState` writes completions to SQLite on task complete
- [x] `DashboardState` reads completions from SQLite for `getSnapshot()`
- [x] Active tasks remain in-memory Map (fast hot path), flushed to DB on complete/fail
- [x] JSONL rehydration still works — replays into handleEvent which writes to DB
- [x] Remove in-memory `completions` array (replaced by DB queries)

### API Changes

- [x] `GET /api/state` returns `recentActivity` (unified timeline) instead of `recentCompletions`
- [x] `recentActivity` merges session completions + github_events, sorted by timestamp
- [x] Add `stats.today` object to API response

### Testing

- [x] Unit tests for dashboard-db.ts (CRUD, dedup, queries)
- [x] Integration test: handleEvent → DB → getSnapshot round-trip
- [x] Existing dashboard tests still pass

---

## GitHub Webhook Ingestion (G-203b)

### Dependencies

- [x] `bun add @octokit/webhooks`

### Webhook Handler

- [x] Create `src/bot/lib/github-webhook.ts`
- [x] HMAC signature verification via @octokit/webhooks
- [x] Handle `pull_request` events (opened, merged, closed)
- [x] Handle `issues` events (opened, closed)
- [x] Handle `issue_comment.created` events
- [x] Handle `push` events (default branch only)
- [x] Handle `release.published` events
- [x] Repo allowlist check (reject unknown repos)

### Agent Attribution

- [x] Commit trailer detection (`Co-Authored-By: Claude` in commit messages)
- [x] Branch pattern detection (configurable regex, e.g., `^feat/(g|f|i)-\d+`)
- [x] Comment pattern detection (`^Starting:`, `^Completed:`)
- [x] Session linking: match issue numbers in github_events to sessions.github_issue

### Integration

- [x] Add `POST /api/github/webhook` route to dashboard-api.ts
- [x] Wire webhook handler in grove-bot.ts
- [x] Add `github` section to config schema (types/config.ts)
- [x] Add `github` section to bot.yaml.template
- [x] Webhook events trigger dashboard WebSocket broadcast

### Setup

- [x] Generate webhook secret
- [x] Configure webhook on the-metafactory/grove
- [x] Configure webhook on the-metafactory/meta-factory
- [x] Configure webhook on mellanon/arc
- [ ] Verify: push commit → dashboard shows event

### Testing

- [x] Unit tests for webhook handler with sample GitHub payloads
- [x] Test HMAC verification (valid + invalid signatures)
- [x] Test agent attribution logic (trailer, branch, comment patterns)
- [x] Test repo allowlist enforcement

---

## Dashboard UI (G-203c)

### Activity Timeline

- [x] Replace COMPLETED section with RECENT ACTIVITY
- [x] Unified list: session completions + GitHub events, sorted by time
- [x] Activity item component with type-specific icons (PR, issue, comment, commit, release, session)
- [x] Agent badge on agent-authored GitHub events
- [x] Clickable links to GitHub (PR/issue URLs)
- [x] Relative timestamps ("12m ago", "1h ago")
- [x] Repo/project label on each item

### Stats Row

- [x] Daily summary counters: PRs merged, issues closed, commits, sessions completed
- [x] Compact horizontal layout between activity and footer

### Polish

- [x] Project filter works across both GitHub and session data
- [x] Mobile-responsive (same breakpoints as existing cards)
- [x] Empty states for no GitHub data ("No GitHub activity yet")
- [ ] Build and deploy to Cloudflare Pages

---

## Execution Order

```
G-203a (Persistent Store)
  │
  ▼
G-203b (GitHub Webhooks)
  │
  ▼
G-203c (Dashboard UI)
```

G-203a ships first and independently improves the dashboard. G-203b+c build on it.

---

## Exit Criteria

1. Dashboard shows completions from previous days (not just current session)
2. GitHub PR/issue/commit events appear in real-time on dashboard
3. Agent-authored events are tagged and visually distinguished
4. Unified timeline interleaves CC sessions and GitHub activity
5. Data survives restarts — no empty dashboard after upgrade
6. Stats row shows daily summary
