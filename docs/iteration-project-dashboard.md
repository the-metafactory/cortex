# Project Dashboard Iteration

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-project-dashboard.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

This plan captures the work for the project dashboard features. Iterations are logical vehicles, not timeboxes.

**Mission:** Dashboard shows project state (repos, issues, PRs) with agent activity overlaid. Channel names route context automatically.
**Scope:** GitHub state sync, repo-aware UI, channel-based context routing
**Design Spec:** `docs/design-project-dashboard.md`
**Tracking Issue:** [#46](https://github.com/the-metafactory/grove/issues/46)
**Prerequisite:** GitHub Visibility (G-203) — merged

---

## Legend

- `[x]` done
- `[ ]` not started

---

## GitHub State Sync (G-204a)

### Database

- [x] Add `repos` table to dashboard-db.ts (full_name, short_name, description, default_branch)
- [x] Add `issues` table (repo, number, title, state, author, labels, timestamps)
- [x] Add `pull_requests` table (repo, number, title, state, author, branch, agent_authored, linked_issues)
- [x] Migration: auto-create new tables on startup (existing pattern)

### Startup Sync

- [x] Create `src/bot/lib/github-sync.ts` — fetches repos, issues, PRs via GitHub REST API
- [x] Use `gh` CLI (simpler, no new deps, already available)
- [x] Sync open issues (state=open, first 100 per repo)
- [x] Sync open PRs (state=open, first 50 per repo)
- [x] Agent attribution on PRs (reuse branch/trailer patterns from G-203)
- [x] Call sync from grove-bot.ts before `dashboardApi.start()`
- [x] Sync completes in < 5s for 3 repos

### Webhook Integration

- [x] Upsert issues table on `issues` webhook events (opened, closed, reopened)
- [x] Upsert pull_requests table on `pull_request` webhook events (opened, closed, merged)
- [x] Link PRs to issues via `closes #N` / `fixes #N` patterns in PR body

### API

- [x] `GET /api/repos` — repo summaries with open issue/PR counts
- [x] `GET /api/repos/:name/issues` — issues with linked agent sessions
- [x] `GET /api/repos/:name/pulls` — PRs with agent attribution
- [x] `POST /api/sync` — manual re-sync trigger

---

## Repo-Aware Dashboard UI (G-204b)

### Landing View

- [x] Repo summary cards (name, open issues count, open PRs count, last activity)
- [x] Active work section (existing, unchanged)
- [x] Recent activity section (existing, now includes repo context)

### Drill-Down

- [x] Click repo card → expanded view with open issues and PRs
- [x] Issues show linked agent sessions inline
- [x] PRs show agent attribution badge
- [x] Click issue/PR → entity detail view: agent sessions, related PRs, GitHub activity
- [x] Click agent name → agent view: all sessions with linked entities
- [x] Three browsing lenses: by repo/entity, by agent, by time
- [x] Back navigation to landing view

### Polish

- [x] Project filter scopes all sections including repo cards
- [ ] Mobile-responsive repo cards
- [ ] Stats row includes repo-level breakdown

---

## Channel-Based Context Routing (G-204c)

### Channel Resolution

- [x] Create `src/bot/lib/channel-context.ts` — channel name → repo/feature resolver
- [x] Match channel name against `github.repos` short names
- [x] Extract feature ID patterns (G-\d+, F-\d+, I-\d+, DD-\d+)
- [x] Unit tests for resolution logic

### Integration

- [x] MessageRouter calls channel resolver on incoming messages
- [x] Security preamble includes repo context when resolved
- [ ] Worklog manager routes to invoking channel (not hardcoded #agent-log)
- [ ] Dashboard events tagged with channel → repo mapping

### PAI Session Bucketing

- [x] `cldyo-live` accepts repo arg: `cldyo-live grove` → `GROVE_CHANNEL=grove`
- [ ] Dashboard resolves `grove_channel` against repo short names for bucketing
- [ ] PAI sessions and Discord-triggered sessions both appear under same repo

### SOP

- [x] SOP documented: `docs/sop-discord-channel-routing.md`
- [x] CLAUDE.md updated with channel routing convention
