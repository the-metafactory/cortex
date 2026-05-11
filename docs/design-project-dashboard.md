# Project Dashboard — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-project-dashboard.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Feature ID:** G-204
**Scope:** GitHub state sync, repo-aware dashboard, channel-based context routing
**Mission:** The dashboard shows what exists to work on (repos, issues, PRs) and overlays agent activity on top. GitHub is the skeleton, agent sessions are the muscle.
**Stack:** Bun, bun:sqlite (existing), GitHub REST API via `gh` or Octokit, existing grove-api
**Prerequisite:** G-203 (GitHub webhooks, SQLite persistence) — merged

---

## Why This Exists

The dashboard currently shows agent events — sessions started, tools used, tasks completed. But it has no awareness of the *project state* underneath. You can't see what repos exist, which issues are open, which PRs need attention. Agent sessions appear disconnected from the work items they're actually addressing.

What we want: open the dashboard and immediately see the state of the project — repos, open issues, active PRs — with agent activity overlaid. When Luna works on issue #43, that should be visible *on* issue #43, not as a disconnected session event.

---

## Features

### G-204a: GitHub State Sync

Fetch current project state from GitHub on startup, keep it updated via webhooks.

**Startup sync (one-time fetch per configured repo):**

```
For each repo in github.repos:
  GET /repos/{owner}/{repo}              → repo metadata (description, default branch)
  GET /repos/{owner}/{repo}/issues       → open issues (state=open, first 100)
  GET /repos/{owner}/{repo}/pulls        → open PRs (state=open, first 50)
  GET /repos/{owner}/{repo}/branches     → active branches
```

**Storage:** New SQLite tables in `dashboard.db`:

```sql
CREATE TABLE repos (
  full_name TEXT PRIMARY KEY,        -- "the-metafactory/grove"
  short_name TEXT NOT NULL,          -- "grove"
  description TEXT,
  default_branch TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,               -- open | closed
  author TEXT,
  labels TEXT,                       -- JSON array
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,               -- open | closed | merged
  author TEXT,
  branch TEXT,                       -- head ref
  base TEXT,                         -- base ref
  agent_authored INTEGER DEFAULT 0,
  linked_issues TEXT,                -- JSON array of issue numbers
  created_at TEXT,
  updated_at TEXT,
  merged_at TEXT,
  UNIQUE(repo, number)
);
```

**Webhook keeps it current:** G-203 webhooks already fire for PR/issue/push/release events. Add handlers to upsert into the new tables (instead of just the flat `github_events` log).

**Sync frequency:** Full sync on startup only. Webhooks handle all subsequent changes. Optional manual re-sync via API endpoint `POST /api/sync`.

### G-204b: Repo-Aware Dashboard UI

Replace the flat activity list with a project-structured view.

**Landing view:**

```
REPOSITORIES
┌─────────────────────────────────────────────────┐
│ grove          3 open issues · 2 PRs · 11m ago  │
│ meta-factory   5 open issues · 1 PR  · 2h ago   │
│ arc        1 open issue  · 0 PRs · 3d ago   │
└─────────────────────────────────────────────────┘

ACTIVE WORK
┌─────────────────────────────────────────────────┐
│ ⚡ Luna — "G-203 review findings" — grove#45    │
│ ⚡ Andreas — "composability stack" — 23m        │
└─────────────────────────────────────────────────┘

RECENT ACTIVITY  30
┌─────────────────────────────────────────────────┐
│ ✅ PR #45 merged — G-203 GitHub Visibility      │
│ 🔀 PR #47 opened — fix review findings          │
│ ⚡ Luna completed — "review grove#45" — 11m     │
│ 📋 Issue #43 closed — grove — 15m ago           │
└─────────────────────────────────────────────────┘
```

**Drill-down — by repo:** Click a repo → see its open issues and PRs with agent session links:

```
grove — Open Issues
┌─────────────────────────────────────────────────┐
│ #43  G-203 GitHub Visibility          ✅ closed  │
│      └── Luna session: 23m, PR #45 merged       │
│ #35  G-200 Agent Visibility           ✅ closed  │
│      └── Luna session: 1h 12m, PR #38 merged    │
│ #46  G-204 Project Dashboard          🟢 open   │
│      └── no sessions yet                         │
└─────────────────────────────────────────────────┘
```

**Drill-down — by entity:** Click an issue or PR → see all activity for that entity:

```
grove #46 — G-204 Project Dashboard         🟢 open
┌─────────────────────────────────────────────────┐
│ AGENT SESSIONS                                   │
│   Luna — "G-204a sync implementation" — 23m      │
│     14 tool calls · 3 files changed              │
│   Luna — "G-204b dashboard UI" — in progress     │
│                                                   │
│ RELATED PRs                                       │
│   #47 feat/g-204-project-dashboard — 🟢 open     │
│                                                   │
│ GITHUB ACTIVITY                                   │
│   🔀 PR #47 opened — 11m ago                     │
│   💬 Comment: "Starting: G-204a" — 45m ago       │
│   📋 Issue opened — 2h ago                       │
└─────────────────────────────────────────────────┘
```

**Drill-down — by agent:** Click an agent name → see all their sessions:

```
Luna — 4 sessions today
┌─────────────────────────────────────────────────┐
│ G-204a sync implementation — 23m — grove #46     │
│   14 tool calls · PR #47 opened                  │
│ Review findings fix — 11m — grove #43            │
│   8 tool calls · PR #45 merged                   │
│ Worklog formatting — 8m — grove                  │
│ Bot config update — 3m — grove                   │
└─────────────────────────────────────────────────┘
```

**Three lenses, same data:** The dashboard supports browsing by repo/entity, by agent, or by time (the existing activity timeline). All views draw from the same underlying tables — sessions, issues, PRs, github_events — joined by issue number, repo, and agent ID.

**Project filter:** Existing filter pills work — selecting a project scopes all sections to that repo.

### G-204c: Channel & Thread Context Routing

Repos get channels. GitHub entities get threads under them. No bot.yaml config, no scope metadata on events — the Discord structure IS the data model.

**Structure:**
```
#grove (channel)                    → repo: the-metafactory/grove
  └── grove/issue/43 (thread)       → issue #43
  └── grove/pr/45 (thread)          → PR #45
  └── grove/g-204 (thread)          → feature G-204 (→ auto-resolves to issue)
#meta-factory (channel)             → repo: the-metafactory/meta-factory
  └── meta-factory/issue/12 (thread)
```

**Resolution (most specific → least specific):**

| Thread Name | Resolves To |
|---|---|
| `grove/issue/43` | Issue #43 in grove |
| `grove/pr/45` | PR #45 in grove |
| `grove/g-204` | Feature G-204 → lookup issue by title |
| *(no thread, just #grove)* | Repo-level, no entity |

The existing `grove_channel` event field carries the channel name. Thread context comes from the Discord thread the agent is invoked in — no new event fields needed.

**Context resolution:**

```typescript
interface ChannelContext {
  repo: string | null;          // "the-metafactory/grove"
  entityType: "issue" | "pr" | "feature" | null;
  entityRef: string | null;     // "43", "45", "g-204"
}

function resolveChannelContext(
  channelName: string,
  threadName: string | null,
  repos: string[],
): ChannelContext {
  // Match channel name against repo short names
  for (const fullRepo of repos) {
    const short = fullRepo.split("/").pop()!;
    if (channelName !== short) continue;

    if (!threadName) return { repo: fullRepo, entityType: null, entityRef: null };

    // Parse thread name: grove/issue/43, grove/pr/45, grove/g-204
    const prefix = `${short}/`;
    if (!threadName.startsWith(prefix)) return { repo: fullRepo, entityType: null, entityRef: null };

    const rest = threadName.slice(prefix.length);
    const issueMatch = rest.match(/^issue\/(\d+)$/);
    if (issueMatch) return { repo: fullRepo, entityType: "issue", entityRef: issueMatch[1] };

    const prMatch = rest.match(/^pr\/(\d+)$/);
    if (prMatch) return { repo: fullRepo, entityType: "pr", entityRef: prMatch[1] };

    const featureMatch = rest.match(/^(g|f|i|dd)-(\d+)$/i);
    if (featureMatch) return { repo: fullRepo, entityType: "feature", entityRef: rest };

    return { repo: fullRepo, entityType: null, entityRef: null };
  }
  return { repo: null, entityType: null, entityRef: null };
}
```

**Thread creation via CLI:**
```bash
discord thread create --channel grove "grove/issue/43"
discord thread create --channel grove "grove/g-204"
```

**Dashboard bucketing:** Events from a session invoked in thread `grove/issue/43` get bucketed under issue #43. Viewing at issue level shows all PR threads that belong to it. Viewing at repo level shows everything.

**PAI session bucketing:** The same `grove_channel` field is used by `cldyo-live` sessions. When `GROVE_CHANNEL=grove`, events from that PAI session get bucketed under the grove repo — same resolution as Discord `#grove`. The agent name (`GROVE_AGENT_NAME`) distinguishes human PAI sessions from bot sessions.

```bash
# PAI session scoped to a repo:
cldyo-live grove          # → GROVE_CHANNEL=grove, events bucket under grove repo
cldyo-live meta-factory   # → GROVE_CHANNEL=meta-factory
cldyo-live                # → GROVE_CHANNEL=andreas (default, no repo bucketing)
```

Both Discord-triggered (Luna) and PAI-triggered (Andreas) sessions appear under the same repo, with agent name as the differentiator. Convention: one `cldyo-live` session per repo.

**No bot.yaml changes. No new event fields.** Channel/thread naming IS the config.

---

## Files to Change

| File | Feature | Change |
|------|---------|--------|
| **New: `src/bot/lib/github-sync.ts`** | G-204a | Startup sync via GitHub REST API |
| `src/bot/lib/dashboard-db.ts` | G-204a | New tables: repos, issues, pull_requests |
| `src/bot/lib/github-webhook.ts` | G-204a | Upsert into new tables on webhook events |
| `src/bot/lib/dashboard-api.ts` | G-204a | New endpoints: `/api/repos`, `/api/repos/:name/issues`, `POST /api/sync` |
| `src/bot/grove-bot.ts` | G-204a | Call startup sync before `dashboardApi.start()` |
| `src/bot/lib/dashboard-api.ts` | G-204b | New endpoints: `/api/agents`, `/api/issues/:repo/:number` for drill-downs |
| `src/dashboard/app.tsx` | G-204b | Repo cards, entity drill-down, agent drill-down, three browsing lenses |
| `src/dashboard/types.ts` | G-204b | New types for repos, issues, PRs, agent summaries |
| **New: `src/bot/lib/channel-context.ts`** | G-204c | Channel name → repo/feature resolution |
| `src/bot/lib/message-router.ts` | G-204c | Inject channel context into agent sessions |
| `src/bot/lib/security-preamble.ts` | G-204c | Include repo/feature context in preamble |

---

## Acceptance Criteria

### G-204a
- [ ] On startup, dashboard DB contains repos, open issues, and open PRs for all configured repos
- [ ] Webhook events update issues/PRs in real-time (close, merge, open)
- [ ] `GET /api/repos` returns repo summaries with issue/PR counts
- [ ] `GET /api/repos/:name/issues` returns issues with linked agent sessions
- [ ] Startup sync completes in < 5s for 3 repos

### G-204b
- [ ] Dashboard landing shows repo cards with issue/PR counts
- [ ] Clicking a repo shows open issues and PRs
- [ ] Agent sessions linked to issues are shown inline
- [ ] Clicking an issue/PR drills down to entity detail: agent sessions, related PRs, GitHub activity
- [ ] Clicking an agent name drills down to agent view: all their sessions with linked entities
- [ ] Three browsing lenses: by repo/entity, by agent, by time (existing activity timeline)
- [ ] Project filter scopes all sections to selected repo
- [ ] Mobile-friendly (existing responsive design)

### G-204c
- [ ] Channel name `#grove` resolves to repo `the-metafactory/grove`
- [ ] Channel name `#grove-g203` resolves to repo + feature G-203
- [ ] Agent in `#grove` gets grove repo directory in security preamble
- [ ] Worklog threads in feature channels stay in that channel (not #agent-log)
- [ ] Works with existing channels — no retroactive renaming needed
- [ ] PAI sessions with `GROVE_CHANNEL=grove` bucket under grove repo on dashboard
- [ ] `cldyo-live grove` sets `GROVE_CHANNEL=grove` (repo arg, defaults to "andreas")

---

## Dependencies

- G-203 (merged) — SQLite DB, webhook handler, dashboard API
- `github.repos` config in bot.yaml (exists)
- `github.webhookSecret` config in bot.yaml (exists)
- GitHub personal access token or `gh` CLI for REST API calls

---

## Out of Scope

- GitHub Actions / CI status (future: G-205?)
- Cross-repo dependency tracking
- Automatic channel creation (channels are created manually per SOP)
- PR review assignment or triage automation
