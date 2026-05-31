# F-12b — "Add to queue" from GitHub issue (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f12b-add-to-queue.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §3 (the task funnel) and §9 Phase E.
**Relationship to prior work:** Sibling of F-12. F-12's Decision 1 split add-to-queue out of F-12 into this PR; F-12's "Scope DEFERS" section names three things F-12b inherits — the empty-assignment Abandon row in the Decision 3 enablement matrix, the `POST /api/tasks/:taskId/abandon` route, and the `task-shadow-{taskId}` synthetic-session pattern for assignment-less curation events. This addendum picks all three up alongside the GitHub-import path that produces empty-assignment tasks.
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-12b implementation begins.

## Why this addendum

§3.4 of the parent spec contains one sentence about add-to-queue: *"the issue view has an 'add to queue' affordance that creates a task row with a `sourceRef` pointer into the existing `issues` table"*. The §9 Phase E bullet repeats it as one of five capabilities. F-12 shipped four of those five; this PR designs the fifth.

The reason the split happened (F-12 Decision 1) was that the four assignment-state verbs all act on existing rows — every endpoint takes `:assignmentId`, every mutation reuses `applyTransition` — and a reviewer could audit them as a class. Add-to-queue is qualitatively different: it spans URL parsing, an external-source fetch (calling `gh` to pull title/body/labels), a duplicate-check against `tasks.source_external_id`, a UI affordance that doesn't yet exist anywhere on the dashboard, and the empty-assignment task lifecycle (zero `agent_task_assignment` rows until the principal hits Dispatch from F-12). Folding it into F-12 would have halved the reviewer's ability to audit the assignment-state-mutation class.

F-12b therefore lives in its own design + PR. Together with F-12 it closes the Phase E iteration-tracker bullet. The two are independent at the route level (no shared endpoint), share two pieces of new wiring (the empty-assignment Dispatch site at `dashboard/index.html:2134` and the `principal.curation` event family), and share the synthetic shadow-session helper described below.

**Invariant the implementer must absorb — `tasks.source_external_id` is a free-form `TEXT` column, no UNIQUE constraint, no index** (verified at `src/mission-control/db/schema.ts:21–35`). The schema accepts duplicate rows for the same upstream issue without complaint. F-12b enforces dedup in application code (Decision 5), not in SQL. Adding a partial unique index is in scope for this PR's scaffolding but out of scope for behaviour — see Decision 5's escape-hatch discussion.

**Invariant the implementer must absorb — `sessions.assignment_id` is `NOT NULL REFERENCES agent_task_assignment(id) ON DELETE CASCADE`** (verified at `src/mission-control/db/schema.ts:70–79`). A "session attached to a task with zero assignments" is impossible at the schema level. Decision 8's `task-shadow-{taskId}` helper threads this needle by creating a synthetic *assignment* row first (against a synthetic agent), then attaching the shadow session to it; both are principal-visible only via the curation event log they anchor, never as runnable rows.

**Invariant the implementer must absorb — Grove's existing GitHub access path is `gh` CLI via `Bun.spawn`** (verified at `src/bot/lib/github-sync.ts:412–434`). No `@octokit/rest` import exists; only `@octokit/webhooks` is in `package.json` for HMAC verification of inbound webhooks. F-12b reuses the `gh` CLI shape (Decision 3) — no new SDK dependency, no new auth ceremony.

## Decision 1 — Where the principal clicks "Add to queue": a button at the top of the F-8 task table

The user's review enumerated four candidate placements: (a) top of the F-8 task table, (b) inside the F-6 focus area, (c) a dedicated `+` floating action button (FAB), (d) ⌘K command palette. F-12b picks (a) and adds (d) as a sibling shortcut once MIG-1's palette stub gains real commands (post-MIG-3).

```
┌─ Tasks ─────────────────────────────────────────────────────────────┐
│  [Priority ▾] [Age ≥ ___] [Search...] [☐ Show closed]   [+ Add task]│
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  P  Title              Agents      State      Age            │   │
│  │  …                                                           │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Why the task-table button.** The F-8 table is where tasks live; the "create" verb belongs adjacent to the list it mutates. The placement matches the pattern every CRUD-list UI uses (GitHub's "New issue", Linear's "New", JIRA's "Create") — principals do not have to learn a new convention. Concretely, F-12b adds a single `<button class="add-task-btn">+ Add task</button>` to the existing `<div class="tasks-filters">` block (`dashboard/index.html:558–578`), aligned right via existing flex layout — no new section, no new visual weight.

**Why not the F-6 focus area.** §3.4's "the curation UX is the task view itself" pins the principle. The focus area is for **attention** (blocked + critical assignments need-action), not for **funnel mutation**. Putting "+ Add task" in the focus area conflates two scopes the parent spec deliberately separated. Principals thinking *"I want to add a task"* are not in the same headspace as principals looking at *"what needs my attention right now"*; the affordance belongs adjacent to the funnel, not adjacent to the attention surface.

**Why not a floating action button.** FABs are mobile-first patterns; the dashboard is desktop-first (Tier 1 explicitly local-desktop, per parent spec §10). FABs also have to position-absolute over content, which competes with the `#drill` overlay's z-index — the existing layout has no FAB precedent and adding one introduces visual noise.

**Why ⌘K is a sibling, not a replacement.** ⌘K is great for power users who already know what they want; the explicit button onboards everyone else. Once MIG-3 lands the React palette with real commands (per the React migration addendum's "PR 7 — ⌘K real commands"), F-12b's task-create flow gets a parallel `Add task from GitHub…` palette entry that opens the same form modal. The two affordances cost ~10 lines of code together (one button click handler + one palette command, both opening the same modal); the redundancy is intentional — discoverable for new principals, fast for veterans. The palette entry ships in the same MIG-3-or-later PR that adds real commands; F-12b ships the button alone in v1.

**Touch-side note.** The Discord CLI (`discord post …`) is not part of F-12b. Principals who want to add a task without leaving the terminal use the CLI to drop a message in #grove with a URL; a principal-on-dashboard then clicks "+ Add task" and pastes it. A `discord task add <url>` command is post-v2 — same out-of-scope reasoning F-11 used (Decision 10) for inbound slash commands.

## Decision 2 — The form: a modal with paste-then-preview-then-confirm flow

Clicking "+ Add task" opens a modal centered over the dashboard, dimming the background. The modal has three states, walked through in sequence: **input**, **preview**, **submitting**.

```
┌─ Add task from GitHub ───────────────────────────────────────┐
│                                                              │
│  GitHub URL or shorthand                                     │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ the-metafactory/grove-v2#42                             │ │
│  └─────────────────────────────────────────────────────────┘ │
│  Examples: full URL, owner/repo#N, or #N if a default repo   │
│  is configured.                                              │
│                                                              │
│  Title override (optional)                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Priority   ( ) P0  ( ) P1  (●) P2  ( ) P3                   │
│                                                              │
│                              [Cancel]  [Preview]             │
└──────────────────────────────────────────────────────────────┘
```

**Accepted input formats.** Decision 4 pins the parser. The form's hint text enumerates the formats so principals learn by reading.

**Title override.** Optional. When non-empty, it overrides the GitHub-fetched title. When empty, the fetched title is used. The override is preserved through preview → submit (principals get to see what they typed even after the GitHub fetch succeeds).

**Priority picker.** Default `P2` (matches `DEFAULT_INTERNAL_TASK_PRIORITY` at `src/mission-control/api/handlers.ts:100`). Radio-button group, four values (`P0`/`P1`/`P2`/`P3`). No "no priority" option — every task in v2 has a priority per the schema's `NOT NULL DEFAULT 2`.

**Preview state.** Clicking `[Preview]` fires the URL/shorthand to the server, which validates + fetches GitHub metadata. The form transforms in place:

```
┌─ Add task from GitHub ───────────────────────────────────────┐
│                                                              │
│  ✓ the-metafactory/grove-v2 #42                              │
│                                                              │
│  Title:     "fix webhook HMAC verification bypass"           │
│  State:     OPEN                                             │
│  Labels:    bug, security                                    │
│  Body:      The HMAC signature comparison uses === which     │
│             allows timing-attacks against …                  │
│             (truncated — first 240 chars)                    │
│                                                              │
│  Priority:  P2                                               │
│                                                              │
│                       [← Back]  [Add to queue]               │
└──────────────────────────────────────────────────────────────┘
```

`[← Back]` returns to input state with all fields preserved (principal can correct a typo without re-entering everything). `[Add to queue]` fires the POST that creates the row.

**Submitting state.** Decision 9 covers the in-flight UX (spinner, disabled buttons). On success, the modal closes and the task table refreshes to show the new row at the top.

**Why a modal and not inline.** The form has three optional fields (title override, priority, plus the preview state itself), and the preview adds another ~6 lines of metadata display. Inline-rendered above the task table would push the actual table off-screen on smaller viewports. A modal scopes the interaction; on dismiss, the principal's view of the table returns unchanged.

**Why preview-before-commit.** Two reasons: (a) confirm the principal pasted the right URL (the title makes the issue identity human-checkable), (b) catch dedup before write (Decision 5's `409 Conflict` lands on Preview, not on Submit, so the principal sees the existing-task deeplink without a row already created). Principals who paste a URL for an already-tracked issue will see the deeplink at preview-time and never reach the Submit button.

**Keyboard.** `Enter` advances input → preview → submit. `Esc` closes the modal at any state. `Tab` flows URL → title-override → priority → primary-button. Same UX shape F-12's curation-toolbar inline confirm uses (`docs/design-mc-f12-task-curation.md` Decision 8).

## Decision 3 — GitHub access: reuse `gh` CLI via `Bun.spawn`; principal's existing `gh auth` is the trust root

The user's review asked which token F-12b uses. F-12b reuses Grove's existing GitHub access path: `gh` CLI shelled via `Bun.spawn`, exactly the shape `src/bot/lib/github-sync.ts:412–434` (`ghJsonArgs<T>`) uses today.

**Auth.** Whatever `gh auth` produces. The principal runs `gh auth login` once when setting up Grove; that token is then implicitly used by every `gh api …` call. F-12b adds no new env var, no new secret, no new auth ceremony. Principals who haven't authenticated `gh` see a clear failure message at preview time (Decision 7's 401 path).

**Why `gh` and not octokit.** `@octokit/rest` is not currently in `package.json` (verified — only `@octokit/webhooks` for HMAC verification on inbound webhooks). Adding a new dependency for one new endpoint when an existing CLI shells out cleanly is the wrong trade. The `gh` CLI also handles auth-token refresh transparently (octokit would require us to wire that ourselves), and matches the existing `github-sync.ts` shape — one less idiom for reviewers to absorb.

**Rate limits.** GitHub's REST API limit is 5000/hour authenticated, 60/hour unauthenticated. F-12b's request rate is ~1 per principal-driven task-create; a principal creating ten tasks in an hour uses 0.2% of the quota. **F-12b does not implement rate-limit handling** — the `gh` CLI surfaces 403 with `X-RateLimit-Remaining: 0` and the server maps that to Decision 7's "rate-limited" UX. If principals hit it in practice (they won't), backoff is a one-line addition in a follow-up PR. Cited here so reviewers don't ask why the topic is unhandled.

**Shared rate-limit budget with `github-sync.ts`.** The 5000/hour authenticated quota is keyed off the `gh auth` token, which is the principal's single GitHub identity on the local machine. Every `gh` invocation Grove issues — F-12b's preview/create calls **and** the existing webhook-driven enrichment in `src/bot/lib/github-sync.ts` — draws against the same budget. The webhook-driven `github-sync` flow is event-coupled (it fires on GitHub webhook deliveries forwarded through `webhook-proxy/`, not on a polling timer), so its baseline footprint is bounded by GitHub's webhook-delivery rate, not by a Grove-controlled cadence. F-12b's incremental footprint (~1 call per principal action — preview is one `gh api`, submit is the same call cached at 200ms-old, abandon is zero `gh` calls) is small relative to that baseline; combined headroom against the 5000/hour quota remains comfortable for single-principal (Tier 1) use. Posture: F-12b stays **principal-frequency only** (no auto-poll, no scheduled imports — both already in Decision 11's scope-out list), which is the budget-protecting shape. If a future PR adds a polling import path it must revisit this budget; F-12b alone does not.

**Network sandbox.** The mission-control server runs as a Bun process on the principal's local machine (Tier 1 deploy posture per parent spec §10). It has unrestricted outbound HTTPS via the principal's normal network stack — no CF Worker constraint applies. The `webhook-proxy/` and `worker/` Cloudflare Workers handle **inbound** GitHub webhooks (HMAC-validated, forwarded to `grove-api`); they are unrelated to F-12b's outbound `gh` call. Verified by reading `src/webhook-proxy/` and `src/worker/` directory listings in this worktree.

**Server-side, not client-side.** The dashboard does not call `gh` directly (no shell access from a browser, and even if there were, the CORS posture against `api.github.com` would require principal auth headers in the browser — wrong trust boundary). The flow:

```
dashboard           server (mission-control)         gh CLI / api.github.com
─────────           ─────────────────────────         ───────────────────────
[Add task] click
URL entered
[Preview] click ──▶ POST /api/tasks/preview ───▶ Bun.spawn gh api … ────▶
                                                                      ←── JSON
                                              ←── parse, validate, dedup
              ←── 200 PreviewResponse  /
                  409 ConflictResponse /
                  4xx/5xx ApiError
preview rendered
[Add to queue] ──▶ POST /api/tasks ─────────▶ INSERT INTO tasks (…)
                                              ↓
                                              create shadow assignment + session (Decision 8)
                                              ↓
                                              insert principal.curation event
              ←── 201 CreateTaskResponse
modal closes, task table refreshes
```

**Two endpoints, not one.** Preview fetches GitHub metadata + checks dedup but does NOT write. Submit writes. The split lets the principal see the issue title before committing, and lets dedup short-circuit at preview-time without leaving a half-created row on retry. Decision 6 pins both endpoint shapes.

## Decision 4 — URL parser: accept full URL, `owner/repo#N` shorthand, or `#N` if a default repo is configured

The form accepts three input formats; the server-side parser canonicalises all three to `{owner, repo, number}`.

**Accepted formats:**

| Input | Parse |
|---|---|
| `https://github.com/the-metafactory/grove-v2/issues/42` | `{owner: "the-metafactory", repo: "grove-v2", number: 42, kind: "issue"}` |
| `https://github.com/the-metafactory/grove-v2/pull/45` | `{owner: "the-metafactory", repo: "grove-v2", number: 45, kind: "pr"}` |
| `the-metafactory/grove-v2#42` | `{owner: "the-metafactory", repo: "grove-v2", number: 42, kind: "auto"}` |
| `grove-v2#42` (with `defaultOwner` configured) | `{owner: "<default>", repo: "grove-v2", number: 42, kind: "auto"}` |
| `#42` (with `defaultOwner` + `defaultRepo` configured) | `{owner: "<default>", repo: "<default>", number: 42, kind: "auto"}` |

**Parser shape.** A new `parseGitHubRef(input: string, defaults: { owner?: string; repo?: string }): GitHubRef | ParseError` helper in `src/mission-control/db/github-ref.ts` (or `src/mission-control/api/github-ref.ts`; pick whichever feels less "DB-coupled"). Pure function, exhaustively tested against every accepted format and three rejected ones (`http://github.com/...` without HTTPS, `gist.github.com/...`, `github.com/orgs/...`).

**`kind: "auto"` resolution.** Shorthand inputs don't carry issue-vs-PR distinction. The server resolves `auto` by trying `gh api /repos/{owner}/{repo}/issues/{number}` first; if that returns the issue, done. GitHub's REST API treats PRs as issues (they share the issue number space), so the call succeeds for both; the response's `pull_request` field disambiguates. The disambiguation lands in the preview metadata so the principal sees `State: OPEN (pull request)` vs `State: OPEN (issue)`.

**Default repo configuration.** Optional. Read from `bot.yaml` under a new key `mission_control.default_github_repo: "the-metafactory/grove-v2"`. When absent, `#N` shorthand fails parse with a clear message; when present, it parses to that repo. The config key is documented in the PR's commit message and in the `Where this goes` section below.

**Validation rules.** Owner/repo are validated against GitHub's identifier regex `^[A-Za-z0-9._-]+$` (length ≤ 100). Number is a positive integer (`> 0`, `< 2^31` to fit `INTEGER` in SQLite if we ever index on it). URLs that don't match `https://github.com/` are rejected with "Only github.com URLs are supported" — keeps F-12b's surface tight (Linear/Jira deferred per Decision 11).

**SSRF posture.** F-12b only ever shells `gh api /repos/...` with a parsed-and-validated `{owner, repo, number}` triple. The CLI itself uses `https://api.github.com` as a hardcoded base; there is no principal-controlled hostname surface. Verified by reading `gh`'s public docs — `gh api` resolves the host from `gh auth` config, not from arbitrary URL input. Pasting a URL with `https://github.com/...` does not cause F-12b to fetch that URL; it parses out the `{owner, repo, number}` and re-issues a structured `gh api` call. This means principals cannot trick the server into fetching `https://internal.corp/...` even with a creatively malformed input — the parser would reject it, and even if it didn't, the `gh api` call ignores arbitrary URL components.

## Decision 5 — Dedup: reject + deeplink at preview; no UNIQUE index in v1

The user's review asked what happens when the principal pastes a URL for an issue Grove already tracks. F-12b rejects-and-deeplinks at preview time.

**Behaviour:**

1. Preview fires.
2. Server canonicalises the input to `{owner, repo, number}`.
3. Server queries: `SELECT id, title, status FROM tasks WHERE source_system = 'github' AND source_external_id = ? LIMIT 1`, where the bound value is `${owner}/${repo}#${number}` (Decision 6 pins the canonical format).
4. If a row exists → return `409 Conflict` with body `{ existingTaskId, existingTitle, existingStatus, message }`. The dashboard renders the conflict state in-modal:

   ```
   ┌─ Add task from GitHub ─────────────────────────────────────┐
   │                                                            │
   │  ⚠ Already tracked                                         │
   │                                                            │
   │  Task T-42 already tracks the-metafactory/grove-v2#42      │
   │  Title: "fix webhook HMAC verification bypass"             │
   │  Status: open                                              │
   │                                                            │
   │             [Cancel]  [Open existing task →]               │
   └────────────────────────────────────────────────────────────┘
   ```

   `[Open existing task →]` closes the modal and opens the F-7 drill-down on the existing task (via `openTaskDrillDown(task)` at `dashboard/index.html:2122`).
5. If no row exists → continue with normal preview state (Decision 2).

**Why preview-time and not submit-time.** Hitting Submit on a duplicate would either (a) require a server-side rollback after creation succeeds, or (b) require a SELECT-then-INSERT race window. Catching it at preview is cleaner and gives the principal the deeplink-to-existing as a primary action — the right reaction in 95% of dedup cases is *"oh, someone already added that, let me look at it"*.

**Why not allow re-add with a warning.** Two tasks pointing at the same upstream issue is almost always a mistake, and it makes future behaviour weird (per-issue lookups return two rows; assignment counts get confusing; the dedup window for state-sync from GitHub webhooks would have to choose). The single-task-per-issue invariant is cheap to maintain and worth the tradeoff.

**Why not a UNIQUE index.** A partial unique index `CREATE UNIQUE INDEX ... ON tasks(source_external_id) WHERE source_system = 'github' AND source_external_id IS NOT NULL` would be the schema-level enforcement of the application-level rule. F-12b lands the application-level check in v1 and **defers the index** because: (a) backfilling a unique index on existing rows risks failing if any duplicate snuck in via direct `POST /api/sessions` task creation (today the `internal` source path doesn't write `source_external_id`, but a future bug could), and (b) the application check is the principal-visible enforcement point — principals see the helpful error message, the index would just `INSERT ... ON CONFLICT` reject which surfaces as a 500. The index ships when v2 has more than one principal and concurrent task-create races become possible (Tier 2). Until then, single-principal + application-check is sufficient.

**The dedup query is keyed off the canonical string.** Decision 6 pins `source_external_id = "owner/repo#number"`. The same canonicalisation runs on every input format from Decision 4, so paste-the-URL and paste-the-shorthand for the same issue both hit the same row.

## Decision 6 — Endpoint shapes

Two new endpoints. Plus one inherited from F-12 (the `POST /api/tasks/:taskId/abandon` deferred there).

### `POST /api/tasks/preview`

**Purpose:** Validate the URL/shorthand, fetch GitHub metadata, check dedup. Does NOT write.

**Body:**
```json
{
  "ref": "the-metafactory/grove-v2#42"
}
```

**200 OK** (no dedup conflict):
```json
{
  "kind": "preview",
  "ref": "the-metafactory/grove-v2#42",
  "url": "https://github.com/the-metafactory/grove-v2/issues/42",
  "type": "issue",
  "state": "open",
  "title": "fix webhook HMAC verification bypass",
  "labels": ["bug", "security"],
  "body_excerpt": "The HMAC signature comparison uses === which allows timing-attacks against the signature header. Switching to crypto.timingSafeEqual closes the window…",
  "fetched_at": "2026-04-24T10:32:11Z"
}
```

**409 Conflict** (already tracked):
```json
{
  "kind": "conflict",
  "existingTaskId": "T-42",
  "existingTitle": "fix webhook HMAC verification bypass",
  "existingStatus": "open",
  "message": "Task T-42 already tracks the-metafactory/grove-v2#42"
}
```

**400 Bad Request** — parse error (`message` carries the human-readable reason).
**404 Not Found** — GitHub returned 404 for the issue/PR.
**401 Unauthorized** — `gh` returned auth error (`gh auth login` needed).
**403 Rate-Limited** — GitHub returned 403 with `X-RateLimit-Remaining: 0`.
**5xx** — anything else (network error, GitHub 5xx, parse failure on response).

**Body excerpt.** First 240 characters of the issue body, with newlines collapsed to spaces and trailing `…` if truncated. Pure cosmetic — gives the principal enough context to recognise the issue.

**`fetched_at`.** ISO-8601 UTC timestamp the server fetched. Discarded after preview; not persisted.

### `POST /api/tasks`

**Purpose:** Commit the task. Creates the task row, the shadow assignment + session (Decision 8), and the `principal.curation` event with `kind: "task.imported"` (Decision 10).

**Body:**
```json
{
  "ref": "the-metafactory/grove-v2#42",
  "titleOverride": "",
  "priority": 2
}
```

**201 Created:**
```json
{
  "taskId": "T-42",
  "shadowAssignmentId": "A-shadow-42",
  "shadowSessionId": "S-shadow-42",
  "title": "fix webhook HMAC verification bypass",
  "source_url": "https://github.com/the-metafactory/grove-v2/issues/42",
  "source_external_id": "the-metafactory/grove-v2#42",
  "priority": 2
}
```

**409 Conflict** — same shape as preview's conflict (defense-in-depth: if the principal races the dedup window between preview and submit, they get the same error here).
**400 / 401 / 403 / 404 / 5xx** — same shapes as preview.

**Priority wire shape.** `priority` crosses the wire as **integer 0..3**, matching the schema column `tasks.priority INTEGER NOT NULL DEFAULT 2` (verified at `src/mission-control/db/schema.ts:21–35`) and matching F-8's existing `GET /api/tasks` projection which returns `priority` as integer. The `P0 / P1 / P2 / P3` strings are a **client-side render label only** — Decision 2's modal renders the integer as `P{n}` in the radio-button group, and the dashboard converts the picker selection back to integer (`0..3`) at submit time. The server never sees the `P` prefix. Validation: server accepts integers `0`, `1`, `2`, `3`; rejects anything else (including strings) with 400. This rule is uniform across `POST /api/tasks` (request body and 201 response body both use integer priority) and applies forward to any future task-mutation endpoint.

**Why two endpoints and not one with a `dryRun` flag.** Reviewer audit clarity. Two endpoints with one purpose each beats one endpoint with a mode parameter; the wire shapes are also different enough (preview returns metadata; create returns task IDs) that overloading would force union types on every consumer.

**Why server-side and not client-side.** Same reasoning Decision 6 of F-12 used for `POST /api/assignments/:id/handoff` — atomicity. The create path does three writes (task INSERT, shadow assignment INSERT, shadow session + curation event INSERT) under one transaction. If the GitHub fetch failed mid-way client-side, the dashboard would have to clean up half-created state.

### `POST /api/tasks/:taskId/abandon` — inherited from F-12

**Purpose:** Cancel a task whose assignments are all terminal (or which has zero non-shadow assignments). Inherited from F-12 Decision 5's "Empty-assignment Abandon" deferral.

**Body:**
```json
{
  "reason": ""
}
```

**200 OK:**
```json
{
  "taskId": "T-42",
  "status": "cancelled",
  "updated_at": "2026-04-24T10:45:00Z"
}
```

**404 Not Found** — `taskId` doesn't exist.
**409 Conflict** — task already `cancelled`, OR task has a non-terminal non-shadow assignment (use `POST /api/assignments/:id/abandon` from F-12 instead). The error message names the alternative endpoint.
**4xx / 5xx** as standard.

**Distinction from F-12's `POST /api/assignments/:id/abandon`.** F-12's route is **assignment-keyed** (`:id` is `assignment_id`); it cancels a specific assignment via `applyTransition(... cancel)`, leaving the task open. F-12b's `POST /api/tasks/:taskId/abandon` is **task-keyed**; it sets `tasks.status = 'cancelled'` directly (no state-machine action because the state machine is per-assignment). The two are siblings, not aliases:

| Verb | Route | Mutates | When to use |
|---|---|---|---|
| Abandon assignment | `POST /api/assignments/:id/abandon` (F-12) | `agent_task_assignment.state = 'cancelled'` | Principal says *"this agent is going down a wrong path"* |
| Abandon task | `POST /api/tasks/:taskId/abandon` (F-12b) | `tasks.status = 'cancelled'` | Principal says *"this whole task is no longer relevant"* (typically on empty-assignment GitHub-imported task or all-terminal task) |

The dashboard's curation toolbar (F-12 Decision 3) routes `[Abandon]` to the right endpoint based on context (per F-12 Decision 5). F-12b extends the routing for the empty-assignment case (Decision 7 below).

**Curation event.** Each `POST /api/tasks/:taskId/abandon` inserts an `principal.curation` event with `kind: "abandon"` and `targetKind: "task"` (matches F-12 Decision 9's payload shape). The event lands on the `task-shadow-{taskId}` session for empty-assignment tasks (Decision 8), or on the latest terminal session for tasks that had assignments. Either way, the event has a real session anchor — Decision 8 spells out the helper.

## Decision 7 — Task-creation flow + empty-assignment Dispatch site

Once `POST /api/tasks` returns 201, the new task is in the table with zero **non-shadow** assignments (the shadow assignment from Decision 8 is hidden from the F-8 task list and from the F-9 working grid; see Decision 8 for the filter shape). The principal now has two paths:

1. **Dispatch immediately.** From the new task's row in F-8, click → drill-down opens. F-12 Decision 3's matrix's "no assignments yet" row activates: the curation toolbar shows `[Dispatch ▾]` enabled (with the agent picker), `[Abandon]` enabled (routes to `POST /api/tasks/:taskId/abandon`), and the other two disabled. Principal clicks Dispatch → existing `POST /api/sessions` flow, taskId pre-filled, agent picked from the dropdown. F-12b lands no new endpoint for this — F-12's Dispatch handler is reused.

2. **Leave it queued.** The task sits in F-8 with `status='open'` and `aggregate_state=null` (no assignments). Visually it renders as a row with empty agents column and `—` in the state column. Principal can come back later and Dispatch from the drill-down.

**The empty-assignment drill-down site at `dashboard/index.html:2134`.** F-12 left this as a `showError("This task has no assignment yet…")` placeholder. F-12b replaces it with the F-12-curation-toolbar variant for zero-assignment tasks — task metadata header + curation toolbar with `[Dispatch]` and `[Abandon]` enabled, the rest disabled. Concretely:

```
function openTaskDrillDown(task) {
  const pick = pickPrimaryAssignment(task.assignments);
  if (pick) { openDrillDown(pick.id); return; }
  // F-12b: empty-assignment drill-down. Open the drill on the synthetic
  // shadow assignment so the curation toolbar has a row to act against.
  // The shadow assignment's id is on task.shadow_assignment_id (added to
  // the GET /api/tasks projection per Decision 8's filter exception).
  if (task.shadow_assignment_id) {
    openDrillDown(task.shadow_assignment_id);
    return;
  }
  // No shadow either (pre-F-12b internal-source task with no assignments
  // ever spawned): fall back to the original error pill until the principal
  // backfills via Dispatch.
  showError("This task has no assignment yet. Click Dispatch to start.");
}
```

The fallback pill stays for the rare case of a pre-F-12b `internal`-source task whose `POST /api/sessions` spawn-rollback path (`handlers.ts:347–364`) succeeded the rollback but somehow left the task row — defense-in-depth. New tasks created via F-12b always have a shadow assignment.

**Sub-decision — shadow sessions get distinct input-gate copy from ended sessions.** F-10 Decision 6 disables the drill-down textarea when `session === null || session.ended_at` and renders *"Session ended. History is read-only."* (verified at `src/mission-control/dashboard/index.html:2622–2657` — `resolveDrillInputMode` returns `"ended"` for both null sessions and sessions with `ended_at` set, and `renderDrillInput` renders the same "Session ended" copy for both). Decision 8 sets the shadow session's `ended_at` immediately at insert, so a never-Dispatched empty-assignment task that a principal drills into would trigger the F-10 gate with the misleading "Session ended" copy — there was no session to begin with, much less one that ended.

F-12b therefore extends `resolveDrillInputMode` to recognise the shadow case explicitly and route to a new `"shadow"` mode with distinct copy: *"This task has no active session yet. Click Dispatch to start one."* The detection is keyed on the assignment's `agent_id === 'mc-shadow-agent'` (the well-known sentinel id), not on `endpoint_kind === 'local.observed'` — the latter is a legitimate read-only mode for observed real sessions and must keep its existing copy *"This session is observed. Input ships when you open it in a controlled Grove session."* The three modes (`ended`, `observed`, `shadow`) all disable the textarea and submit button; only the placeholder copy varies. Concretely:

```js
function resolveDrillInputMode(assignmentId) {
  if (!assignmentId) return "ended";
  const a = state.assignments.get(assignmentId);
  if (!a) return "unknown";
  // F-12b: shadow assignments take precedence over the ended/observed checks.
  // The shadow session has ended_at set immediately and endpoint_kind='local.observed',
  // so without this branch resolveDrillInputMode would return "ended" (misleading)
  // or "observed" (also misleading — there is no real observation taking place).
  if (a.agent_id === "mc-shadow-agent") return "shadow";
  if (!a.session) return "ended";
  if (a.session.ended_at) return "ended";
  if (a.session.endpoint_kind === "local.observed") return "observed";
  return "active";
}
```

The `shadow` branch in `renderDrillInput` mirrors the `ended`/`observed` shape (textarea + submit disabled, input cleared, image staging cleared) and sets the placeholder to *"This task has no active session yet. Click Dispatch to start one."* This change is in scope for F-12b and lands alongside the empty-assignment drill-down rewire in this same PR — same file, two adjacent edits.

**Why detect on `agent_id`, not on a new column.** No schema change required. `mc-shadow-agent` is already the well-known sentinel from Decision 8; the `GET /api/tasks` projection already includes `agent_id` on the assignments roll-up. Detecting on a sentinel value the system already publishes is cheaper than threading a new flag through the projection + the dashboard's `state.assignments` cache.

## Decision 8 — `task-shadow-{taskId}` synthetic-session helper

The user's review asked when the shadow session gets created (at task-create time? at first event-emit time?), and what `endpoint_kind` it uses.

**Created at task-create time, eagerly, in the same transaction as the task row.** Lazy creation (at first event-emit) sounds cheaper but in practice every F-12b-imported task fires at least one event immediately (`principal.curation` with `kind: "task.imported"`), so there is no win. Eager creation also keeps `task.shadow_assignment_id` populated in the `GET /api/tasks` projection from the moment the task lands — the dashboard never has to handle a "task with no shadow yet" intermediate state.

**The shadow assignment.** A real `agent_task_assignment` row, attached to a synthetic agent named `mc-shadow-agent` (lazy-created via the existing `ensureDefaultAgent` pattern, see `handlers.ts:281–288`). State is `cancelled` from the moment it lands — this is critical: the shadow assignment must NOT appear in the F-8 task table's assignment roll-up, the F-9 working-grid count, the F-6 focus area, or any principal-visible projection. Its sole purpose is to satisfy the `sessions.assignment_id NOT NULL` FK so the shadow session can attach.

```sql
INSERT INTO agents (id, name, type, persistent)
  VALUES ('mc-shadow-agent', 'Mission Control shadow', 'hands', 1)
  ON CONFLICT(id) DO NOTHING;

INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
  VALUES (?, 'mc-shadow-agent', ?, 'cancelled');
-- block_reason stays NULL; CHECK constraint at schema.ts:62 holds because
-- the (state = 'blocked') = (block_reason IS NOT NULL) biconditional
-- evaluates true when both sides are false.
```

**The shadow session.** Anchored to the shadow assignment, with `endpoint_kind = 'local.observed'`. The user's review explicitly asked which `endpoint_kind` to use; `local.observed` is correct because (a) it carries the parent spec's "read-only display" semantics (verified at `src/mission-control/db/schema.ts:74–75`'s CHECK on the kind), (b) it does not invoke `processManager.spawnControlled` (no PID, no CC subprocess), and (c) the existing `endpoint-resolver.ts` paths that key off `local.process.controlled` simply skip a `local.observed` row.

```sql
INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at, ended_at)
  VALUES (?, ?, NULL, 'local.observed', NULL, datetime('now'), datetime('now'));
-- ended_at populated immediately so the partial unique index
-- idx_sessions_active_assignment (schema.ts:117–118) is not violated by
-- a future-spawned controlled session for this assignment ID, even
-- though the shadow assignment is itself terminal.
```

**Why `ended_at` set immediately.** Defense-in-depth. The shadow session is never "live" — it exists only as an event anchor. Setting `ended_at` at insert time makes the index invariant trivially true and prevents any future code path that filters `WHERE ended_at IS NULL` from accidentally treating the shadow session as alive.

**`mc-shadow-agent` invariant.** Two writes to this agent ID are legal: (a) `ensureShadowAgent` lazily inserts on first F-12b task-create, (b) every F-12b task-create writes one assignment row pointing at it. Principals never see this agent in the F-9 working grid because the existing query at `src/mission-control/db/working-agents.ts:102–130` already filters `WHERE a.state IN ('running','dispatched','queued')`, and the shadow assignment is `cancelled` from insert. F-12b nonetheless adds an explicit `WHERE ag.id != 'mc-shadow-agent'` clause as defense-in-depth — shadow sessions are not real working agents and a future bug that flipped the shadow assignment to a non-terminal state must not pollute the F-9 working grid (the agent-id filter is the second line of defense, independent of the state filter, and survives any state-machine refactor). The assertion that F-9 already uses a `WHERE agent.id !=` precedent was incorrect — there is no such precedent at `working-agents.ts:102–130`; the rationale here is "defensive isolation of the shadow sentinel," not "consistency with an existing pattern." Same filter applies to `GET /api/tasks`'s assignment roll-up — the projection skips assignments whose `agent_id = 'mc-shadow-agent'`, so `aggregate_state` correctly returns `null` for empty-assignment tasks.

**The `task.shadow_assignment_id` hint on `GET /api/tasks`.** The projection at `src/mission-control/db/tasks.ts:208–227` (the `hydrate` function) extends to include `shadow_assignment_id: string | null`, populated via a sibling subquery: `SELECT id FROM agent_task_assignment WHERE task_id = ? AND agent_id = 'mc-shadow-agent' LIMIT 1`. The dashboard reads this to wire `openTaskDrillDown`'s empty-assignment path (Decision 7).

**Why a real assignment row and not a sentinel `assignment_id = NULL` on sessions.** Schema-changing the FK to nullable is a wider blast radius than a synthetic row. A nullable FK forces every existing query against `sessions.assignment_id` to handle the null case (verified: `src/mission-control/db/sessions.ts:60–93` would all need updates), and the partial unique index on active sessions would need rewriting. The synthetic row threads the FK without any schema change.

**Why one shadow agent and not one shadow agent per task.** A per-task shadow agent multiplies the agents table for no benefit — the shadow agent has no principal-visible meaning, no behaviour, no preferences. One row, well-known ID, never displayed. Same posture `mc-default-agent` already uses (`handlers.ts:88, 281`).

**Lifecycle.** When the principal finally Dispatches from the empty-assignment drill-down (Decision 7), the existing `POST /api/sessions` handler creates a new `agent_task_assignment` row to a real agent + spawns a controlled session — the shadow assignment is **left in place** as the curation-event anchor. Future curation events on the same task continue to land on the shadow session (the `findLatestSessionForAssignment` lookup picks the most recent terminal session, which is now either the real agent's terminal session or, if the real agent is still running, the shadow session). The shadow row is durable; it is never deleted in v2.

**Test coverage.** A new `task-shadow.test.ts` covers: (a) shadow assignment + session created on `POST /api/tasks` 201, (b) shadow session has `endpoint_kind='local.observed'` and `ended_at` set, (c) shadow assignment is filtered out of `GET /api/tasks`'s assignment roll-up, (d) `GET /api/tasks` returns `shadow_assignment_id` populated for F-12b-created tasks, null for `internal`-source tasks, (e) `POST /api/tasks/:taskId/abandon` writes the curation event onto the shadow session, (f) Dispatch-from-empty creates a real assignment without disturbing the shadow.

## Decision 9 — UX during the GitHub fetch: form blocks with a small spinner

The user's review asked what the principal sees during the ~200ms–2s GitHub round-trip. F-12b's posture: form blocks with a spinner inside the primary button.

**Concretely.**

- On `[Preview]` click: button text becomes `Loading…` with a small inline spinner; `[Cancel]` stays enabled; URL/title/priority inputs are disabled (greyed). On 200, the form transforms to the preview state. On 4xx/5xx, the form returns to input state with an inline error banner above the URL field carrying the Decision 7-mapped message.
- On `[Add to queue]` click (from preview state): button text becomes `Adding…` with spinner; `[← Back]` disabled. On 201, the modal closes with a brief success toast (`Task T-42 added`) at the top-right of the dashboard. On 409, transforms to the conflict state (Decision 5). On other 4xx/5xx, returns to preview state with an inline error banner.

**No optimistic create.** Optimistic UX would mean inserting a row in the dashboard table immediately and rolling it back on 5xx. The complexity of "row appears, then disappears, then maybe reappears with a different ID" is worse than the 200ms–2s wait. F-12b waits.

**Spinner shape.** Reuses whatever spinner pattern the existing dashboard uses for `fetchTasks` (verified: there is none — `dashboard/index.html:1868–1885` shows `fetchTasks` doesn't render in-flight state; existing inline busy posture is "do nothing visually, operate fast"). F-12b adds the first dashboard spinner, scoped to the modal only — the rest of the dashboard remains spinner-free. CSS: a 12px circle with rotating gradient, inline with the button label. The implementation can lift the design from the React migration's component library when MIG-1 lands; in v1 it's hand-rolled CSS.

**Timeout.** The `gh api` call has no explicit timeout in `github-sync.ts` (it relies on `gh`'s defaults). F-12b adds a 30-second timeout via `AbortController`-equivalent (`Bun.spawn` supports `signal`). On timeout, the spinner clears and the form shows "GitHub took too long to respond. Try again." — same as a 5xx. Tests cover this path with a fake `Bun.spawn` that hangs.

**Network failure.** If the principal's machine is offline (or `gh` itself isn't installed), the spawn fails immediately. Decision 7's UX maps the error.

## Decision 10 — Observability: one `principal.curation` event with `kind: "task.imported"`

F-12 Decision 9 introduced the `principal.curation` event family with a `kind` discriminator. F-12b adds one new variant: `kind: "task.imported"`.

**Payload shape:**

```ts
type OperatorCurationPayload =
  | { kind: "dispatch"; agentId: string; reason?: string; newAssignmentId?: string }   // F-12
  | { kind: "requeue"; reason?: string }                                                 // F-12
  | { kind: "handoff"; fromAgentId: string; toAgentId: string; reason?: string;
      newAssignmentId: string }                                                          // F-12
  | { kind: "abandon"; targetKind: "assignment" | "task"; reason?: string }              // F-12 + F-12b (task)
  | { kind: "task.imported"; source: "github"; ref: string; url: string; type: "issue" | "pr" }; // F-12b NEW
```

**Why `task.imported` and not `task.created`.** F-12b's flow has a distinguishing signal — it's an **import** from an external source, not a fresh-from-thin-air create. `kind: "task.imported"` reads accurately in the F-7 drill-down event log:

- `task.imported` → `"Imported from GitHub: the-metafactory/grove-v2#42 (issue)"`

A future `kind: "task.created"` would distinguish principal-typed-from-scratch tasks (no upstream) from imported ones — useful when someone adds a manual-task affordance in a follow-up PR. F-12b doesn't ship that flow, so reserving `task.imported` for the import case keeps the discriminator semantically clean. If a third source (Linear/Jira) lands, it becomes a new `source` value within `task.imported`, not a new kind. The kind axis is for **action**; the source axis is for **provenance**.

**Where it's inserted.** Inside the `POST /api/tasks` transaction, after the task row, shadow assignment, and shadow session are inserted. Uses the same `createOperatorCurationEvent` helper F-12 introduced in `src/mission-control/db/events.ts`. The event's `session_id` is the shadow session's id.

**WS broadcast.** Same as F-12 — the event flows through `broadcastEvent` (`src/mission-control/notifications.ts:65`). The dashboard's F-7 event log adds one new render block keyed on `payload.kind === "task.imported"`:

```
🔵 Imported from GitHub: the-metafactory/grove-v2#42 (issue)
   the-metafactory/grove-v2 — fix webhook HMAC verification bypass
```

**Why one event and not two (e.g. `task.created` + `task.imported`).** Two events for one principal action would be redundant and would force every consumer (replay tooling, audit export, dashboard render) to dedup. One event with sufficient payload to reconstruct the action is the right shape.

**Principal id on the event.** Same posture as F-12 Decision 9 — `events` table doesn't carry `operator_id`; F-12b inherits the principal implicitly from the shadow assignment's task's `operator_id`. Tier 2 multi-principal wiring for `principal.curation` lands F-12 + F-12b in lock-step.

## Decision 11 — Scope OUT: explicit deferrals so the PR review stays tight

Things F-12b tempts the implementer to add but that ship in separate PRs (or never):

- **Bulk import.** "Add all open issues with label `bug` from `the-metafactory/grove-v2`" is a useful capability and a different design exercise — needs query-shape selection (filter by label / state / assignee), pagination handling, partial-success UX. Out of scope. Principals with ten issues hit `+ Add task` ten times. (Same posture F-12 Decision 10 took for bulk curation.)
- **Scheduled imports.** Cron-style "every hour, sync all open issues from these repos" overlaps with `github-sync.ts`'s existing background sync — but `github-sync.ts` populates the dashboard's read-only repos/issues/PRs cache, not the `tasks` table. Wiring a scheduler to convert issue-cache rows to tasks is a different problem (which issues qualify? when do they get archived?). Out of scope.
- **GitHub project boards.** Importing all issues in a Project view, watching for additions, etc. Out of scope. Project boards are themselves an external task funnel; layering Grove's task funnel on top of GitHub's is double-bookkeeping.
- **GitHub Actions integration.** "Auto-add a task when CI fails" is a webhook-driven flow, not a principal-initiated one. The existing `webhook-proxy/` already validates webhooks; an "auto-task-on-ci-failure" producer could land later as a dedicated capability. Out of scope. (Manual principal decisions are the v2 funnel discipline.)
- **Cross-repo dependency tracking.** "This task depends on grove#43 and meta-factory#22" needs a dependency edge table, propagation rules, auto-wake on resolution — same posture F-12 Decision 10 took (parent spec §10's `blocked_by_task_id` is reserved but unsurfaced). Out of scope.
- **Automatic title-extraction heuristics.** "Strip `[bug]` prefixes from titles", "auto-detect `WIP:` and set priority", etc. The title override field handles this manually. Out of scope.
- **Linear / Jira / Asana / Notion / Trello support.** F-12b's hardcoded `'github'` source is intentional — the parent spec §10 explicitly defers the `TaskSource` interface (Conflict 4) until a second source ships. Out of scope. When the second source arrives, the parser, the dedup query, and the event payload's `source` axis all extend cleanly.
- **GitHub Discussions.** Discussions live at a different REST path and have a different identity space. Out of scope; reuse the same parser-extension story when discussions are wanted.
- **Inbound webhook → auto-add-to-queue.** Webhook says *"new issue opened with label `now`"* → Grove auto-creates a task. This is the inverse direction of F-12b (server-pulled vs server-pushed). Out of scope; would re-introduce the auto-curation question §3.4 deliberately closed (*"the principal decides what enters the queue"*).
- **Editing imported tasks (sync-back to GitHub).** "Principal edits the task title; Grove pushes the rename to the upstream issue." Out of scope. F-12b is one-way (GitHub → Grove); two-way sync is a different capability.
- **Pasting into an arbitrary input field on the dashboard.** A nice power-user shortcut — paste a URL anywhere, get a "Add this as a task?" toast. Discoverability is poor and intercepting paste events globally is a bug-magnet. Out of scope.
- **`#N` shorthand without a configured default repo.** Decision 4 rejects this with a clear message. Configuring the default is a one-line `bot.yaml` edit; not an in-UI configuration flow.
- **The UNIQUE index on `(source_system, source_external_id)`.** Decision 5's escape hatch — application-level enforcement is sufficient at single-principal. The index ships with Tier 2 multi-principal runtime.
- **Discord slash command (`/grove add <url>`).** Same posture F-12 Decision 10 took — slash commands are a new ingestion surface with their own auth-and-component story. Out of scope; post-v2.
- **Toast notifications beyond the post-create one.** "Toast on every state change", "configurable toast preferences", etc. Out of scope; the F-11 Discord notifications already carry the principal-attention burden.

## Acceptance criteria

- [ ] `POST /api/tasks/preview` validates the URL/shorthand, fetches GitHub metadata via `gh` CLI, and returns 200 with title/state/labels/body excerpt or 409 with the existing-task deeplink shape (Decision 6).
- [ ] `POST /api/tasks` creates the task row, the `mc-shadow-agent` assignment row, the `local.observed` shadow session, and the `principal.curation` event with `kind: "task.imported"` — all in one transaction. Returns 201 with `taskId` + `shadowAssignmentId` + `shadowSessionId`.
- [ ] `POST /api/tasks/:taskId/abandon` sets `tasks.status='cancelled'` and inserts an `principal.curation` event with `kind: "abandon"` + `targetKind: "task"` on the shadow session. Returns 404 / 409 / 5xx per Decision 6.
- [ ] The URL parser (`parseGitHubRef`) accepts the five formats from Decision 4 and rejects the three explicitly-listed bad formats with clear messages.
- [ ] Dedup is enforced at preview time via the `source_system='github' AND source_external_id=?` query; principals see the existing-task deeplink before any row is created.
- [ ] The dashboard "+ Add task" button opens a modal with input → preview → submit flow (Decision 2). Keyboard navigation matches Decision 2.
- [ ] During the GitHub fetch, the form blocks with a spinner; the rest of the dashboard remains responsive (Decision 9).
- [ ] The empty-assignment drill-down at `dashboard/index.html:2134` is rewired to open the F-12 curation toolbar against the shadow assignment, with `[Dispatch]` and `[Abandon]` enabled per F-12 Decision 3's "no assignments yet" row.
- [ ] `GET /api/tasks` filters out `mc-shadow-agent` assignments from the assignments roll-up; `aggregate_state` returns `null` for tasks with only the shadow assignment. Adds `shadow_assignment_id` to the projection.
- [ ] F-9 working-grid query filters out `mc-shadow-agent`. The shadow agent never appears as a principal-visible row.
- [ ] The F-7 event log renders `principal.curation` events with `kind: "task.imported"` per Decision 10's one-line summary shape.
- [ ] All existing mission-control tests still pass; new tests for the parser, the preview/create/abandon endpoints, the shadow helper, and the dashboard form ship green.
- [ ] No new schema migrations. No new tables. No changes to `state-machine.ts` or `transitions.ts`. The schema's existing `tasks.source_system='github'` enum value is sufficient.
- [ ] No `@octokit/rest` dependency added; F-12b reuses the existing `gh` CLI shape.

## Where this goes

- New endpoint handlers in `src/mission-control/api/handlers.ts`:
  - `handlePreviewTask(db, deps, rawBody)` — backs `POST /api/tasks/preview`.
  - `handleCreateTask(db, deps, rawBody)` — backs `POST /api/tasks`.
  - `handleAbandonTask(db, deps, taskId, rawBody)` — backs `POST /api/tasks/:taskId/abandon`.
- New helper module `src/mission-control/api/github-ref.ts` — exports `parseGitHubRef(input, defaults)` and `canonicalRef({owner, repo, number})` returning `"owner/repo#number"`. Pure, no I/O, exhaustively tested.
- New helper module `src/mission-control/api/github-fetch.ts` — exports `fetchIssueOrPr({owner, repo, number, kind})` returning `{type, state, title, labels, body}`. Wraps `Bun.spawn(['gh', 'api', `/repos/${owner}/${repo}/issues/${number}`, ...])`. The argv is statically constructed from validated parts; no shell interpolation. Includes the 30s timeout from Decision 9.
- New helper `ensureShadowAgent(db)` and `createShadowAssignmentAndSession(db, taskId)` — sibling helpers in `src/mission-control/db/sessions.ts` (or a new `src/mission-control/db/shadow.ts` if `sessions.ts` should stay narrow). Decision 8's transactional shape.
- Route wiring in `src/mission-control/server.ts` — one branch extension (`/api/tasks` gains a POST handler alongside the existing GET) plus two new pathname branches (`/api/tasks/preview` and `/api/tasks/:taskId/abandon`). Currently `server.ts:306–311` dispatches `/api/tasks` GET-only and 405s on other methods; F-12b widens that branch into a method router. Summary:

  | Route | Method | Body | Success | Errors |
  |---|---|---|---|---|
  | `/api/tasks/preview` | POST | `{ ref: string }` | 200 `PreviewResponse` | 400 / 401 / 403 / 404 / 409 / 5xx (Decision 6) |
  | `/api/tasks` | POST | `{ ref: string, titleOverride?: string, priority: 0..3 }` | 201 `CreateTaskResponse` | 400 / 401 / 403 / 404 / 409 / 5xx (Decision 6) |
  | `/api/tasks/:taskId/abandon` | POST | `{ reason?: string }` | 200 `AbandonResponse` | 404 / 409 / 4xx / 5xx (Decision 6) |
- Type additions in `src/mission-control/api/types.ts` — `PreviewTaskRequest/Response/Conflict`, `CreateTaskRequest/Response`, `AbandonTaskRequest/Response`.
- New `task.imported` payload variant in the `OperatorCurationPayload` union (sibling of F-12's four variants).
- Projection update in `src/mission-control/db/tasks.ts`:
  - `listTasks` SQL adds the `shadow_assignment_id` correlated subquery (`AND a.agent_id = 'mc-shadow-agent'`).
  - The assignments roll-up batch query gains `WHERE a.agent_id != 'mc-shadow-agent'` so shadow rows don't appear in the table's agents column.
  - `TaskListItem` interface gains `shadow_assignment_id: string | null`.
- Projection update in `src/mission-control/db/working-agents.ts` — query gains `WHERE agent.id != 'mc-shadow-agent'` (defense-in-depth — the shadow agent has no real assignments anyway).
- Dashboard edits in `src/mission-control/dashboard/index.html`:
  - New `.add-task-btn` in the `tasks-filters` block.
  - New `.add-task-modal` markup + CSS (input / preview / submitting / conflict states).
  - Modal JS: paste handler, preview fetch, submit fetch, error mapping, conflict deeplink.
  - Rewire `openTaskDrillDown` empty-path (line 2122) to use `shadow_assignment_id` per Decision 7.
  - New render branch for `principal.curation` events with `kind: "task.imported"` (Decision 10).
  - First dashboard spinner CSS, scoped to `.add-task-modal`.
- Config: a new optional `mission_control.default_github_repo: "owner/repo"` key in `bot.yaml`. When present, the parser accepts `#N` shorthand. When absent, `#N` shorthand fails parse with a clear message.
- Tests in `src/mission-control/__tests__/`:
  - `github-ref-parser.test.ts` — Decision 4's parser, every accepted + rejected format.
  - `task-create-endpoints.test.ts` — preview happy path, dedup conflict, GitHub error mapping (404/401/403/5xx), create happy path, create dedup conflict (race-window safety).
  - `task-shadow.test.ts` — Decision 8's helper; covers the six test cases listed in that decision.
  - `task-abandon-endpoint.test.ts` — Decision 6's task-keyed abandon route (sibling of F-12's `assignment-keyed` abandon test).
  - `task-import-event.test.ts` — Decision 10's `principal.curation` payload + render shape.
- Forward-link from `docs/design-mission-control.md` §3.4 (and the §9 Phase E bullet) to this addendum, alongside the existing F-12 forward-link.

Forward-links from `docs/design-mission-control.md` §3.4 and §9 Phase E added in the same PR that lands this addendum. The Phase E iteration-tracker bullet for F-12b is updated to point at this addendum and to confirm the F-12 / F-12b split is fully designed.
