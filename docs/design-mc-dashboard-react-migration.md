# Dashboard React migration — pre-implementation addendum

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-dashboard-react-migration.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §8 (Primary attention focus), §6 (Operator input channel), and all prior F-6…F-10 / image-input addenda.
**External input:** A Claude Design handoff bundle delivered a five-variation React prototype of the mission-control layout.
**Vendored artifact:** The handoff bundle is committed to the repo at `docs/design-artifacts/grove-mission-control/` in the same PR as this addendum. Read `docs/design-artifacts/grove-mission-control/ANNOTATIONS.md` for the mapping from the artifact's five variations onto Grove's existing data model and abstractions — including how tasks remain a first-class abstraction distinct from GitHub issues.
**Date:** 2026-04-25 (revised after operator-feedback course correction).
**Status:** Decided. Resolves the eleven open questions below before migration code lands.

## Taking stock — three sections

### 1. Where we're coming from

Mission Control v2 has shipped Phase A (data foundation + local bot scaffold) and Phase B (dashboard attention core) on the `grove-v2` remote. Seven features live on `main`:

| F-ID | Feature | Merged PR |
|---|---|---|
| F-1…F-5 | Bot scaffold, state machine, endpoint resolver, hook-stream reader, WS server | PR #1 |
| F-13 | Controlled-session stdout dispatcher | PR #5 |
| F-6 | Focus area "who needs me" | PR #8 |
| F-7 | Attention drill-down overlay (event log, D/A/H colouring, virtualisation) | PR #11 |
| F-8 | Task table (filters, sort, hash persistence) | PR #13 |
| F-9 | Working-agent grid | PR #15 |
| F-10 | Drill-down operator text input + queue + inline error banner | PR #17 |
| — | Server-side text cap (50 KB) + upstream 128 KB body cap | PR #18 |
| — | Image paste + drag-drop (extended to 25 MB per-body / 5 MB per-image / PNG-JPEG-WebP-GIF allowlist) | PR #21 |

All of the above are implemented in a single file: `src/mission-control/dashboard/index.html` (~3200 lines of inline HTML + CSS + vanilla JS). Backend has strict TypeScript, 350 tests, an events table, a state machine, controlled + observed endpoint kinds, and a Maestro-derived stream-json framer with both text-overload and content-block-overload paths (rich content for images). Design docs are rich: §4 (notifications), §5 (attention view), §6 (operator input channel), §7 (architecture), §8 (dashboard layout).

Already merged alongside the Phase A/B summary above:

- **PR #20** — F-11 Discord notifications addendum (docs only) — merged 2026-04-24

Open work not yet on `main` (PRs awaiting review / merge):

- **PR #22** — F-12 task curation addendum (docs only) — open
- **PR #23** — F-11 Discord notifications implementation — open
- **PR #24** — THIS PR: React migration addendum + vendored design artifact

### 2. Where we're going

**Target shape, from two overlaid sources:**

1. **The mission-control spec** (`docs/design-mission-control.md`) — operator-first, keyboard-driven cockpit with a focus row, working-agent grid, task table, and drill-down. §6 is explicit: the drill-down is a full operator-input channel, not a read-only view.
2. **The Claude Design handoff** (`docs/design-artifacts/grove-mission-control/`) — five variations exploring the layout, with V4 "Session Context" introducing a **re-orientation stack** (plan/progress, recent agent moves, the current ask, artifacts, pinned conversation, rich reply surface) where approve/deny are *outcomes* of conversation, not entry points.
3. **The operator's own observation (2026-04-25):** when you drop into the dashboard's drill-down, you should feel as if you dropped into the Claude Code CLI session for that agent. Streaming tool calls, expandable outputs, thinking blocks, permission prompts with full context, typed/voice reply, screenshot paste, todo-list visibility. *Each agent is a session; the dashboard is the new CLI.*

These three are not three separate designs — they converge on the same thing. The spec says "drill-down"; the handoff's V4 says "re-orientation"; the operator says "CC session parity." Read together, the target is one surface — a rich session view — wrapping the existing event log + operator input with plan/progress, artifact access, and a conversation-first interaction model.

**What "CC session parity" concretely means** (surfaced by mining this very conversation — the way the operator course-corrects mid-stream, asks for plan visibility, drops references like "can we do React", "where are we at", "did you check the design file", is exactly the pattern the drill-down must support):

- **Streaming event log.** Render stream-json `assistant.text` as soft-wrapped paragraphs; `thinking` blocks collapsible; `tool_use` + `tool_result` pairs expandable; `permission.request` inline with full context; `state.transition` inline markers. Not just "a list of events" — a transcript that reads like terminal output.
- **Plan / progress strip.** If the agent exposes a todo list (via `TodoWrite` tool results or a Grove-side plan table), render the current step + completion state above the event log. Answers "where are we at" without scrolling.
- **Artefact links.** Branch, PR URL, diff summary, issue references — pulled from the agent's activity into a header strip. Lets the operator jump-to-context without leaving the drill-down.
- **Rich reply surface.** Text (done in F-10), image paste/drop (done in image PR), voice dictation (deferred), canned action buttons ("ask for more", "show me the test output", "review PR", "redirect focus").
- **Actionable permission prompts.** Approve/Deny inline on `permission.request` rows, with room for the operator to attach reasoning ("yes, but only if you also update the test") — text passes through as the "deny with instructions" channel until CC's permission-protocol stream-json verification lands (F-7 Decision 6 gate still holds).
- **Single-agent focus mode.** Full-screen the drill-down; keyboard shortcut to cycle between blocked agents.

**Operator's primary surface is the dashboard, not the CLI.** The CLI remains valid for exploratory work and `cldyo-live` observation, but the operator who drops into the mission-control page at `/` is doing their real work there. The drill-down UX must not be a strictly-worse proxy for a CC terminal.

### 3. Where we are now (2026-04-25)

- Phase B is complete on `main`.
- PR #24 (this addendum) is live.
- PR #22 (F-12 task curation addendum) is open, unmerged.
- PR #23 (F-11 implementation) is open, unmerged — needs review/sweep.
- No React scaffold exists yet. MIG-1 has not started.
- Operator has explicitly reframed the drill-down: V4-flavoured session-context is the primary drill-down, not a deferred variation. This addendum's Decision 7 and the MIG-3 scope are revised accordingly below.

### 4. What's next (immediate)

1. Merge PR #22 (F-12 task curation addendum) — docs-only, no surprises.
2. Review + sweep + merge PR #23 (F-11 implementation) — has full addendum backing.
3. Land this addendum (PR #24) with the course-corrected plan below.
4. Begin MIG-1 — the scaffold PR. Matches the six-PR sequence in Decision 9 with the revised MIG-3 scope.

## Why this addendum

Three forces converge:

1. **The monolith is unsustainable.** `dashboard/index.html` carries global state, five render functions, a WS handler, multiple keyboard layers, HTTP clients for five endpoints, and inline CSS for every feature. Reviewers flagged duplication concerns in PR #15 (two `hashchange` handlers; two `priorityClass` definitions) and PR #17 (parallel dashboard blocks stepping on each other). The review gap is structural — without component boundaries there is no seam that enforces no-duplication.
2. **The design artifact + operator feedback are aligned.** The Claude Design handoff ships a five-variation prototype with a shared visual vocabulary (keycaps, pills, event rows, focus cards, command palette). The operator's 2026-04-25 reframing made V4 Session Context the primary drill-down rather than a sibling variation. Re-implementing any of this in vanilla JS compounds the monolith problem.
3. **New work (F-11/F-12) will need to surface in the dashboard.** F-11 notifications need a settings pane; F-12 task-curation needs a toolbar attached to the drill-down. Both would add another ~500 lines to the monolith each if we stay the course.

F-6…F-10 plus image-input each landed with an addendum; this migration is structural so it gets one too. The eleven decisions below make the shape commit-reviewable.

## Decision 1 — React 18 + TypeScript + JSX

Language stack:

- **React 18.3.x**, function components + hooks only. No class components, no Redux.
- **TypeScript** matching the backend's existing `strict: true` config. No new config file — reuse `tsconfig.json` at repo root with a per-directory `include` / `jsx` adjustment.
- **JSX** (`.tsx` files) — the design artifact's format.

**Rationale.** Backend is already TypeScript + Bun. The mission-control module has strict type rigour across 26 test files. A dashboard port in TS keeps the same bar and closes the "frontend is untyped" gap.

**Not chosen.**
- **Preact.** Smaller bundle, but the design prototype is React — direct porting is faster. We can drop to Preact later if bundle size becomes a concern (it is not today: dashboard is served loopback).
- **Vue / Svelte.** Would mean translating the design prototype rather than porting — wasted work.
- **Vanilla JS with modules.** Solves the monolith problem but not the visual-system problem. Design tokens live better in a typed component system than in classed DOM.

## Decision 2 — Bun bundler is the primary build; no Vite

Tooling:

- **Build:** `bun build src/mission-control/dashboard/main.tsx --outdir dist/dashboard --target browser`. Single command, no extra dev dependencies.
- **Dev:** Bun's `--watch` mode rebuilds on save. Manual browser reload. Acceptable given the dashboard is used loopback by one operator at a time — HMR is not load-bearing.
- **Fonts:** Inter + JetBrains Mono via the standard Google Fonts `<link>` in the HTML shell. No font-hosting, no preload cheese.
- **CSS:** plain `.css` files imported from TSX (Bun's bundler inlines them). No CSS-in-JS, no Tailwind, no PostCSS. Matches current CSS-custom-property style.

**Rationale.** Bun is the ecosystem — adding Vite pulls in another build system, another config, another lockfile section, another CI step. The dashboard does not need HMR badly enough to justify the footprint.

**Accepted cost.** Bun bundler's React Fast Refresh support is less mature than Vite's. Full reload on save is a minor DX regression for 1 operator.

## Decision 3 — Directory layout

```
src/mission-control/dashboard/
  index.html              — static shell (loads bundled main.js)
  main.tsx                — React root mount
  app.tsx                 — <App/> (theme, palette state, layout)
  styles/
    tokens.css            — design-token CSS custom properties (oklch palette)
    global.css            — font-face, reset, keyframes, base selectors
  components/
    focus-area.tsx        — F-6 (blocked assignments row)
    working-grid.tsx      — F-9 (non-blocked agents grid)
    task-table.tsx        — F-8 (task list with filters, hash persistence)
    drill-down.tsx        — F-7 overlay (header, summary, event log)
    drill-input.tsx       — F-10 textarea + send + paste/drag-drop chips
    command-palette.tsx   — new (⌘K)
    keycap.tsx            — shared
    pill.tsx              — shared (state / priority / generic)
    event-row.tsx         — shared (used by drill-log + audit views)
    toast.tsx             — replaces the legacy showError() pill
    image-lightbox.tsx    — shared modal for image previews
  hooks/
    use-assignments.ts    — GET /api/assignments + WS merge
    use-focus-area.ts     — GET /api/focus-area + WS debounced refetch
    use-tasks.ts          — GET /api/tasks + hash-persisted filters
    use-working-agents.ts — GET /api/working-agents
    use-drill-events.ts   — GET /api/assignments/:id/events + WS merge
    use-websocket.ts      — single WS client, re-connect, broadcast context
    use-hash-state.ts     — generic location.hash (de)serializer
    use-theme.ts          — light/dark + localStorage
  lib/
    api.ts                — typed fetch wrappers + error shape
    classify-events.ts    — D/A/H color classification (pure)
    state-ranks.ts        — mirrored from db/tasks.ts (single source of truth is DB)
  __tests__/
    ... optional component smoke tests (see Decision 8)
```

**Rationale.** Matches the handoff bundle's organisation (`components.jsx`, `data.jsx`, per-variation files). Names are boring on purpose — grep lands you where you expect.

**Old file removal.** The existing monolithic `dashboard/index.html` is deleted in the migration PR; there is no transition period (see Decision 9).

## Decision 4 — State shape: local component state + React Context for cross-cutting concerns

- **Local per-component state** for UI affordances (filter chip expanded, hover state, selected-row index).
- **One React Context** for the shared-across-components data: `DashboardContext` exposing `{ assignments, focusItems, tasks, workingAgents, ws, theme, toast, drill: { open, assignmentId, events } }`.
- **Fetching via custom hooks** that subscribe to the context — `useAssignments()`, `useDrillEvents(assignmentId)`, etc. The hooks own the fetch+WS-merge lifecycle and expose read-only data.
- **Mutations** (open/close drill, set filters, open palette) are actions exposed on the context. No separate reducer.

**Not chosen.** Redux, Zustand, Jotai, Valtio — all add a library for state the dashboard can handle with React primitives. At the dashboard's size (5 features, single operator) a store library is ceremony. Revisit if the app grows past ~10 features or we need time-travel debugging.

## Decision 5 — WebSocket handling: one client, context-exposed

Today the dashboard opens the WebSocket in the boot function and each feature attaches its own handler. Migration:

- `use-websocket.ts` owns `new WebSocket(...)`, reconnect, ping/pong, and a `dispatch` on every incoming frame.
- The WS client exposes a pub/sub: components subscribe via `useWsEvent('state.transition', handler)`.
- Each feature hook (`use-focus-area`, `use-tasks`, etc.) subscribes to the specific frame types it cares about. Debounce logic stays inside each hook — the F-8 task table keeps its 100 ms debounce, F-6 keeps 150 ms.

**Asymmetry preserved.** F-6's `blocked`-only trigger filter and F-8/F-9's every-transition filter (called out as invariants in their respective addenda) survive the port. Hooks are the place where those filter decisions live.

## Decision 6 — Styling: CSS custom properties + oklch palette, light/dark via `data-theme`

- **Tokens** (`styles/tokens.css`): CSS custom properties for colours (`--bg`, `--panel`, `--line`, `--fg`, `--fg-dim`, `--accent`, `--d`, `--a`, `--h`, `--p0`, `--p1`, `--p2`), typography (`--mono`, `--sans`), and spacing. Values are **oklch** so theme switching is a single `data-theme` attribute on the document root.
- **Light theme** is the design artifact's light palette (off-white backgrounds, dark text, same hue families). Default is whichever matches the operator's OS preference; explicit toggle persists to `localStorage.theme`.
- **Fonts:** Inter (UI) + JetBrains Mono (mono, keycaps, event IDs, timestamps).
- **No Tailwind, no CSS-in-JS.** Per-component CSS files imported from the TSX. Reusable class names in `global.css`.
- **Accent hue** stays a slider in an off-by-default "Tweaks" debug affordance — spec'd in the design but not load-bearing.

## Decision 7 — Feature parity first; V4-flavoured drill-down is the primary drill-down (ships with MIG-3)

**This decision was revised on 2026-04-25 after operator feedback.** The earlier version deferred V4 Session Context to a post-migration follow-up. That was wrong: V4 is not a sibling variation of the drill-down — it *is* the drill-down. Porting the current F-7 drill-down to React and re-porting to V4 later means the same screen is written twice. MIG-3 ports the V4-flavoured drill-down directly.

### Parity bar — non-drill-down features (ship as-is)

- **Focus area row** (F-6): blocked-only, priority-ordered, `1`–`9` + arrow keys, empty-state with most-active-agent line.
- **Working-agent grid** (F-9): tiles with agent/task/state/priority border, `+N` badge, arrow-key navigation, hide-when-focus-nonempty.
- **Task table** (F-8): columns + sort + four filters + hash persistence + row click drill-down.
- **WebSocket**: all existing merges and debounces.

### MIG-3 drill-down — V4-flavoured from day one

The drill-down ports F-7 + F-10 + image input **and** adds the V4 capabilities that make it feel like a CC session:

**Must ship with MIG-3:**
- Event log rendered as a streaming-transcript (not a flat row list). Sub-decisions per event type per Decision 11 below.
- Plan / progress strip at the top of the drill-down. If `TodoWrite` tool-result events exist in the session, render the most recent todo list as a collapsible pane. (No new table; drive off existing events.)
- Artefact strip in the header: branch name, PR URL, GitHub issue link, diff summary — extracted from the session's events when present.
- Reply surface at feature parity with F-10 (text + image paste/drop + queue UX + inline error banner).
- Canned action buttons below the reply surface: "Ask for more", "Show test output", "Review PR", "Redirect focus". Each is a pre-filled text that the operator can edit before sending (buttons are shortcuts, not commitments).
- `Permission.request` rows render with inline Approve/Deny *layout* (per F-7 Decision 6 they stay disabled until the CC stream-json permission-protocol verification lands; text-based deny-with-instructions flows through the reply surface).
- Single-agent focus mode: keyboard shortcut to full-screen the drill-down; `] / [` cycle through blocked agents without returning to the focus row.

**Deferred from the MIG-3 V4 set** (later PRs, not blocking migration):
- Voice dictation input — requires mic permission UX + a transcription service decision.
- Cross-agent "conversation" history threading across multiple sessions for the same agent.
- Live diff-summary rendering (needs a PR-diff fetcher service).
- Canned-button customisation / operator-defined shortcuts.

### New capabilities bundled with the migration (not drill-down-specific)

- **⌘K command palette** — global, fuzzy filter, keyboard nav, runs commands (jump to agent, toggle theme, show help, jump to drill-down).
- **Keyboard shortcuts expanded** — `?` help modal, `Shift+T` theme toggle, `j/k` as alternatives to arrow keys.
- **Light/dark toggle** — default OS-preference, persisted to localStorage.
- **Keycap UI** — small monospace chip for shortcut display (inline help, palette rows).
- **Toast** — replaces the legacy `showError` inline pill with a transient top-of-viewport toast.

### Deferred from the design artifact

- **V5 Project Lens** — repos grid with agents overlaid. Own addendum + implementation.
- **V2 Triage / V3 Canvas** layouts — alternate dashboard shapes; not on the near-term roadmap.
- **Density toggle** (compact/regular/comfy) — one-line follow-up after migration lands.
- **Accent-hue slider** — debug affordance, not operator-facing.

## Decision 8 — Testing: port existing logic tests; add optional component smoke tests post-migration

- **Backend tests (`src/mission-control/__tests__/*`)** — untouched by the migration. 350+ tests pass as they do today.
- **Pure-function tests** — any logic extracted out of the monolith into `lib/*` (e.g. `classify-events`, `state-ranks`, base64 helpers) gets unit tests with `bun test`.
- **Component smoke tests** — deferred to a follow-up. Bun test doesn't ship a DOM adapter out of the box; the cost-benefit of wiring `happy-dom` + `@testing-library/react` is low for a single-operator app where manual testing is already the QA method. Revisit if component regressions become a pattern.
- **E2E tests** — not in scope for this migration or as a follow-up. Manual UI testing continues per the F-7/F-8/F-9/F-10 precedent.

## Decision 9 — Incremental migration across six PRs; `/` serves the old dashboard until cutover

Two migration strategies considered:

1. **Big-bang:** the migration PR deletes `dashboard/index.html` and replaces it with the React app. All features ship at parity in one review.
2. **Incremental:** keep the monolith alongside a new `/v2` route; port features one at a time; switch routes at the end.

**Chosen: incremental.** Rationale:

- A ~3000-line diff is unreviewable in practice. Reviewers skim; bugs land. The two parallel runs in this project already surfaced one critical bug (the 128 KB upstream cap vs 25 MB image cap) where interaction between two features wasn't checked — a single-PR rewrite would compound that risk across every feature at once.
- Each feature port (F-6, F-7, F-8, F-9, F-10, image) is already reviewer-sized (300-800 lines in the monolith). A per-feature PR is a like-for-like lift: the reviewer sees "here's the F-6 React component + its hook + its tests" against the existing F-6 monolith slice for comparison.
- Operator-visible risk is zero: the monolith at `/` keeps working while the port progresses at `/v2`. If a port regresses, the operator still has `/`.
- The accepted cost — "two sources of truth for WS merges for ~5 PRs" — is actually manageable because each feature port is the same logic refactored into hooks; the monolith doesn't need to change.

**Accepted cost.** The `/v2` route runs alongside `/` for the duration of the migration (6–8 PRs). The operator can A/B compare. At cutover, the monolith is deleted and `/v2` becomes `/`.

### Migration sequence — the six-PR plan (revised 2026-04-25)

Each PR is independently mergeable, reviewable, and reversible. The existing monolith at `/` keeps working throughout. Dependencies form a clean chain.

**PR 1 — Scaffold + shared primitives + `/v2` route.** (Depends on: none.)

- New `src/mission-control/dashboard/` directory with React + TS scaffold (Decisions 1–3).
- `package.json` adds `react`, `react-dom`, `@types/react*`, plus a `build:dashboard` script (Decision 2).
- `.gitignore` adds `dist/dashboard/`.
- Server (`server.ts`) adds a new `/v2` route that serves the bundled output. `/` still serves the monolithic `dashboard/index.html` unchanged.
- Shell `index.html` + `main.tsx` + `app.tsx` render a placeholder page with theme toggle + Inter/JetBrains Mono fonts + oklch tokens loaded (Decision 6).
- Shared component primitives (no features yet): `Keycap`, `KeySeq`, `Pill`, `PriorityPill`, `StatePill`, `EventRow`, `Toast`, `ImageLightbox`, `CommandPalette`. Tests: unit tests for pure pieces (keycap renders right, pill class mapping, EventRow color coding per D/A/H).
- `use-theme` + `use-hash-state` + `use-websocket` hooks.
- `⌘K` palette works globally in `/v2` with one demo command ("Toggle theme"); real commands added in later PRs.
- **Operator impact:** zero. `/v2` shows the shell-only app; `/` is unchanged.

**PR 2 — Port F-6 focus area to `/v2`.** (Depends on: PR 1.)

- `components/focus-area.tsx` + `hooks/use-focus-area.ts` (fetch + WS-merge with 150 ms debounce on blocked transitions only).
- `1`–`9` numeric select, arrow keys, empty-state with most-active-agent line.
- `Enter` opens a stub drill-down (placeholder until PR 3).
- Tests: unit tests on the pure focus-area sort order + empty-state text.
- **Operator impact:** `/v2` now shows the focus row. Backward-compat at `/` unchanged.

**PR 3 — V4-flavoured drill-down on `/v2`.** (Depends on: PR 2.) **Revised 2026-04-25 to include V4 Session Context.**

This is the largest MIG PR by line count because it folds F-7 + F-10 + image-input + V4 into a single V4-flavoured drill-down. Splitting it would mean porting the drill-down to a thin F-7-only shape and re-writing it a PR later — wasted work.

> **Reviewability budget — known exception to the "~800 lines net" bar.** MIG-3 is the only PR in this sequence that is allowed to exceed the per-PR reviewability bar set in the test plan. Source PRs being ported total ~2500 raw additions in the monolith (F-7 PR #11: +1087, F-10 PR #17: +431, image PR #21: +994); a React port compresses this (hooks split logic, JSX is more compact than imperative DOM) but adds V4 net-new pieces (todo pane, artefact chips, canned actions, focus mode). **Target: ~1500–2000 lines net.** Reviewers should approach MIG-3 as five sequential file reads, in order: (1) `drill-down.tsx` shell + keyboard, (2) `drill-header.tsx` + `use-todo-state.ts` + `use-artefacts.ts` (V4 additions), (3) `drill-log.tsx` against the Decision 11 table, (4) `drill-input.tsx` against F-10 parity, (5) `drill-image-chips.tsx` against image-input parity. Each segment maps 1:1 to a previously-merged source PR (or a small V4 addition), so reviewer effort is comparable to reviewing the source PRs back-to-back rather than reviewing 2000 lines from scratch.
>
> **Fallback split if MIG-3 exceeds 2500 lines net at PR-open time.** Cleave at the V4 seam: **MIG-3a** = F-7 + F-10 + image port (the parity work, ~1200–1500 lines net); **MIG-3b** = V4 additions on top (todo pane, artefact chips, canned actions, focus mode, ~500–800 lines net). MIG-3b lands behind MIG-3a in the same review window so the V4-flavoured drill-down still arrives in one feature-cycle, just split for the reviewer's sake. This fallback is recorded here so the decision doesn't have to be re-litigated at PR-open time.

Components shipped:
- `components/drill-down.tsx` — overlay shell + keyboard (Esc, `]`/`[`, focus-mode toggle).
- `components/drill-header.tsx` — agent × task + state pill + plan/progress strip + artefact chips (branch, PR, issue links extracted from events).
- `components/drill-log.tsx` — streaming-transcript renderer; sub-decisions per event type per Decision 11.
- `components/drill-input.tsx` — full F-10 parity (text + queue + inline error banner) plus canned action buttons row.
- `components/drill-image-chips.tsx` — full image-input parity (paste + drop + allowlist + lightbox).
- `hooks/use-drill-events.ts` — fetch + WS merge + dispatch-cycle counter + pagination.
- `hooks/use-todo-state.ts` — derive current todo list from `TodoWrite` tool-result events, if present.
- `hooks/use-artefacts.ts` — scan event history for branch/PR/issue references.

Parity carried over from F-7 / F-10 / image:
- D/A/H color coding at content-block granularity (F-7 Decision 4).
- Race guard on fetch-vs-WS (F-7 Decision 6's PR #17 sweep).
- Queue semantics, 50 KB client cap, byte-trim on paste, observed/ended gates (F-10).
- Image caps (5 MB/image, 8 images/message, 25 MB/body, allowlist).
- Inline error banner with `{400, 404, 409, 410, 413, 5xx}` copy.

New capabilities (V4 additions, MIG-3-scope):
- Plan/progress pane (collapsible, above the event log).
- Artefact chips (below the header, above the event log).
- Canned action buttons (below the reply surface).
- `]` / `[` cycle between blocked-at-focus agents.
- Full-screen focus mode (keyboard + button).

Deferred from MIG-3 (Decision 7):
- Voice dictation (mic + transcription infra).
- Live diff-summary rendering.
- Cross-session conversation threading.
- Canned-button customisation.
- Approve/Deny wire-up (still gated on CC stream-json permission-protocol verification per F-7 Decision 6).

**Operator impact:** `/v2` has a full V4-flavoured drill-down that feels like the CC terminal for that agent. Input + image + queue work. `/` unchanged.

**PR 4 — Port F-8 task table to `/v2`.** (Depends on: PR 3.)

- `components/task-table.tsx` + `hooks/use-tasks.ts`.
- Priority multi-select, age threshold, title search, closed-toggle, all with hash persistence.
- Row click opens the drill-down (ported in PR 3).
- Column-header sort + tie-breaks per F-8 Decision 4.
- WS re-fetch on every `state.transition` with 100 ms debounce (F-8's intentional asymmetry with F-6).
- **Operator impact:** `/v2` has focus row + table + drill-down (read-only). Usable for monitoring.

**PR 5 — Port F-9 working-agent grid to `/v2`.** (Depends on: PR 4 — positioning between focus row and tasks table.)

- `components/working-grid.tsx` + `hooks/use-working-agents.ts`.
- Tile layout, `+N` badge, hide-when-focus-nonempty rule.
- Arrow-key navigation, tile click → drill-down.
- **Operator impact:** `/v2` now has full monitor-mode parity with `/`.

**PR 6 — Cutover: delete monolith + swap routes.** (Depends on: PR 5.) *Renumbered 2026-04-25: MIG-6 was formerly "port F-10 + image"; that work now lives in MIG-3 which ports the V4-flavoured drill-down whole.*

- `server.ts`: `/` now serves the React bundle; `/v2` redirects to `/` for bookmark compatibility.
- Delete `src/mission-control/dashboard/index.html` (the monolith).
- Delete any monolith-only helpers (`startSession`, `renderList`, `renderDetail`, `showError`).
- Update `CLAUDE.md` / `docs/design-mission-control.md` forward-links.
- **Operator impact:** `/` is the new dashboard. Rollback is a single revert.

**Later (out of this sequence):**

- **PR 7 — ⌘K real commands.** Populate the palette with the proper "Open Luna", "Toggle theme", "Show help", "Jump to focus card N", "Approve current", etc. Each binds to actions that already exist in the hooks.
- **PR 8+ — V5 Project Lens** — own addendum.
- **PR 9+ — V4 extensions**: voice dictation, live diff-summary, cross-session conversation threading, canned-button customisation.
- **PR 10+ — Density toggle, accent-hue slider** — polish.
- **PR 11+ — V2 Triage + V3 Canvas layouts** if operator demand appears.

### Cross-PR invariants

- `/` keeps working from PR 1 through PR 5 inclusive. Manual UI test at `/` stays green.
- Each PR adds only a bounded set of files to `src/mission-control/dashboard/`; the monolith `index.html` is untouched except by PR 6.
- Hooks follow the F-6/F-7/F-8/F-9 WS-filter discipline — each hook subscribes only to frame types it cares about.
- Bundle size is monitored but not gated. If it exceeds 500 KB uncompressed, the Preact swap (Decision 1 deferred) is revisited.

## Decision 10 — Server changes: serve the built bundle; build runs on dev + CI

Server changes in the same PR:

- `server.ts` swaps from `Bun.file(DASHBOARD_HTML_PATH)` serving the source HTML to serving `dist/dashboard/index.html` + the bundled JS/CSS assets.
- A `bun run build:dashboard` script in `package.json`: `bun build src/mission-control/dashboard/main.tsx --outdir dist/dashboard/...`
- `package.json` `dev` script: `bun --watch build:dashboard & bun --watch src/mission-control/server.ts` (parallel: watcher rebuilds, server reloads).
- `.gitignore` adds `dist/dashboard/`.

Static file serving pattern in `server.ts`:

```ts
const DASHBOARD_DIST = dirname(fileURLToPath(import.meta.url)) + "/../../dist/dashboard";
if (url.pathname === "/" || url.pathname === "/index.html") {
  return new Response(Bun.file(`${DASHBOARD_DIST}/index.html`), { headers: { "content-type": "text/html" } });
}
if (url.pathname.startsWith("/assets/")) {
  return new Response(Bun.file(`${DASHBOARD_DIST}${url.pathname}`));
}
```

**Deployment note.** The existing `arc upgrade Grove` path already runs `bun install`; adding a `bun run build:dashboard` step to the release pipeline is a one-line change to the arc manifest.

## Decision 11 — CC session parity: concrete rendering rules per event type

Added 2026-04-25 to resolve what "feels like a CC session" means *concretely* — turning the operator's observation into buildable criteria for MIG-3. Mined from the actual CC-session interaction pattern this design conversation has been running on.

### Rendering rules (MIG-3 drill-log must implement)

| Event / content-block | Primary render | Expandable | Color |
|---|---|---|---|
| `stream-json.assistant` → `text` block | Soft-wrapped paragraph, markdown rendered (headings, code, lists, bold). Font: Inter 13px. Markdown code blocks use JetBrains Mono. | — | A (amber) |
| `stream-json.assistant` → `thinking` block | Collapsible by default, one-line truncated preview; click expands. | Default collapsed. | A, muted (italic). |
| `stream-json.assistant` → `tool_use` block | One-line: tool name + brief args. Rendered as a secondary-weight row with a ▸ expand caret. | Expands to: full args (JSON pretty-printed, JetBrains Mono), any follow-up `tool_result` paired visually. | D (green). |
| `stream-json.user` → `tool_result` block | Paired visually with its `tool_use`; collapsed by default. Preview shows first 2 lines + byte count. | Expands to full output (rendered as code, monospace, truncated at 10 KB with "load more"). | D (green). |
| `stream-json.user` → `text` block | **Suppressed.** `operator.input` is the authoritative H-source (F-7 Decision 4). |  — | — |
| `operator.input` | Primary-weight row with operator's text rendered as markdown. If images attached, rendered inline below the text (see image-input Decision 7). | — | H (rose). |
| `permission.request` | Primary-weight row with structured render: action | target | context | risk. Approve / Deny buttons render inline but stay disabled (F-7 Decision 6). | — | H (rose). |
| `state.transition` (blocking) | Primary-weight row. "Transitioned to blocked: {block_reason.one_liner}". | Expands to full block_reason payload. | D (green). |
| `state.transition` (non-blocking) | Tertiary-weight one-line marker. "queued → dispatched", "dispatched → running", "running → completed", etc. | — | D, muted. |
| `stream-json.result` | Tertiary-weight footer chip for terminal turn: "turn complete · 14.2s · 3,421 in / 812 out tokens". | — | D, muted. |
| `stream-json.system`, `stream-json.unknown` | Tertiary-weight chip only. | — | — |

> **Scope note.** The drill-log only renders event types actually emitted on `grove-v2/main` today (verified by grepping `src/mission-control/`). Error surfacing currently lands as `state.transition` to `blocked` with a `BlockReason` of kind `tool.error` — already covered by the blocking-transition row above. A dedicated top-level `system.error` event type does not exist yet; if/when one is introduced (separate addendum + emitter wiring), extend this table at that point.

### Todo list pane (collapsible, above event log)

Derived from the most recent `TodoWrite` tool-result block in the session. If the session has never seen a `TodoWrite` call, the pane is absent (not an empty pane — just nothing). Renders the todo list with checkbox state matching the agent's latest claim; updates live on new `TodoWrite` events.

When an item transitions `pending → in_progress → completed`, the pane briefly highlights that row for ~800ms so the operator catches which step just landed.

### Artefact strip (header)

Scans the session's events for:
- **Branch name**: first match of `git checkout -b <name>` or `git switch -c <name>` in tool_use args, or a `state.transition` with branch metadata.
- **PR URL**: `github.com/<org>/<repo>/pull/<n>` anywhere in tool_use args or tool_result output.
- **Issue reference**: `<repo>#<n>` or `github.com/<org>/<repo>/issues/<n>`.

Rendered as chips with click-to-open (opens in a new tab). If the same session accumulates multiple (e.g. the PR changes number mid-session), show the most recent.

### Canned action buttons (below the reply surface)

Fixed v1 set (all pre-fill the textarea; operator edits before sending):
- **Ask for more** → "Can you say more about what you're seeing?"
- **Show test output** → "Run the tests and show me the output."
- **Review PR** → "Link me to the PR and summarise the diff."
- **Redirect focus** → "Park this and switch to [ ]." (operator fills the blank)

These are shortcuts, not commitments — they never submit on click. Shortcut chord: `.` (period) focuses the button row for keyboard pick.

### Single-agent focus mode

- Keyboard: `f` (when drill-down is open and textarea not focused) full-screens the drill-down; `f` again restores.
- In focus mode, the focus row, working grid, and task table are hidden behind the overlay (not unmounted — state preserved).
- `]` / `[` cycle between *blocked* assignments in the current focus-row order. Operator never leaves the drill-down while unblocking work.

### Interaction model — why this matters

The live CC CLI session gives the operator: transcript, tool-call visibility, plan state, permission prompts with context, rich reply, paste, voice (via desktop OS), Ctrl+C / Esc escape hatches, history scrollback. The dashboard drill-down today gives: flat event log with D/A/H colour, disabled Approve/Deny, textarea, paste images.

Decision 11 closes that gap per row above. MIG-3 ships this; the migration is not "done" (or even reviewable as a drill-down port) without it. V4 from the design artifact was the operator's reach toward this target; the operator's explicit 2026-04-25 feedback confirmed it.

## Scope summary — what the migration PR SHIPS

- New `src/mission-control/dashboard/` React app at feature parity with the current monolith
- Bun bundler build (`bun run build:dashboard`)
- Server change to serve the bundle
- Light/dark theme toggle + oklch palette
- ⌘K command palette + expanded keyboard shortcuts
- Inter + JetBrains Mono fonts
- Keycap UI + Toast + Image lightbox as shared components
- Deletion of the monolithic `dashboard/index.html`
- `package.json` scripts + `.gitignore` update

## Scope summary — what this DEFERS

- **V5 Project Lens** (design variation) — follow-up addendum + implementation
- **V4 extensions** past MIG-3's must-ship set: voice dictation, live diff-summary rendering, cross-session conversation threading, canned-button customisation
- **V2 Triage / V3 Canvas** layouts — alternate dashboard shapes; not on roadmap
- **Approve/Deny wire-up** on `permission.request` rows — still gated on CC stream-json permission-protocol verification (F-7 Decision 6)
- Density toggle (compact/regular/comfy)
- Accent-hue slider (debug tweak)
- Component smoke tests (`happy-dom` + `@testing-library/react`)
- Preact swap if bundle size becomes a concern

## Acceptance criteria (by MIG PR)

**MIG-1 (scaffold):**
- [ ] `bun run build:dashboard` produces `dist/dashboard/index.html` + bundled JS/CSS with no errors.
- [ ] Server serves the bundle at `/v2` and static assets from `/v2/assets/*`. `/` still serves the monolith unchanged.
- [ ] `⌘K` opens the palette; contains at least one demo command.
- [ ] `Shift+T` toggles theme; preference persists to localStorage.
- [ ] Shared primitives (Keycap, Pill, Toast, EventRow, ImageLightbox, CommandPalette) render with basic tests.
- [ ] Fonts load (Inter, JetBrains Mono); oklch tokens applied.

**MIG-2 (F-6 focus area):**
- [ ] Blocked row shows priority-ordered cards with `1`–`9` select + arrow keys.
- [ ] Empty-state includes the most-active-agent line.

**MIG-3 (V4-flavoured drill-down):**
- [ ] Drill-down opens from focus row; `Esc` closes; `]`/`[` cycle blocked agents; `f` focus-mode toggle.
- [ ] Event log renders per Decision 11's per-event-type rules; tool_use/tool_result pair correctly; thinking collapsed by default.
- [ ] Todo list pane appears when the session has `TodoWrite` activity; updates live.
- [ ] Artefact chips extract branch / PR / issue references from the session's events.
- [ ] Reply surface at F-10 parity: Enter submit, Shift+Enter newline, 50 KB cap, queue UX, observed/ended gates, inline error banner.
- [ ] Image paste + drag-drop at feature parity: chip row, caps, lightbox, media-type allowlist.
- [ ] Canned action buttons pre-fill the textarea and never auto-send; `.` focuses the button row.
- [ ] Approve/Deny buttons render but stay disabled (F-7 Decision 6 gate).

**MIG-4 (F-8 task table):**
- [ ] Columns + sort + four filters + hash persistence work identically.
- [ ] Row click opens MIG-3 drill-down.

**MIG-5 (F-9 working-agent grid):**
- [ ] Tiles, `+N` badge, hide-when-focus-nonempty rule, arrow-key nav.
- [ ] Tile click opens MIG-3 drill-down.

**MIG-6 (cutover):**
- [ ] `/` serves the React bundle; `/v2` redirects to `/`.
- [ ] Monolithic `dashboard/index.html` deleted.
- [ ] All backend tests still pass (350+).
- [ ] `tsc --noEmit` passes across the dashboard TypeScript.
- [ ] Manual UI test covers F-6/F-7/F-8/F-9/F-10/image paths — matches F-7/F-8/F-9/F-10 precedent where manual is the QA.

## Where this goes

- New directory: `src/mission-control/dashboard/` (replacing the current single file).
- New build script: `package.json` → `"build:dashboard"`.
- Updated server: `src/mission-control/server.ts` serves the bundle + assets.
- Updated ignores: `.gitignore` → `dist/dashboard/`.
- Updated docs: `docs/design-mission-control.md` §8 gets a forward-link to this addendum.
- Iteration tracker: the Phase B layout bullets still point to F-6…F-9 as shipped; this migration does not re-tick them — it is an architectural port, not a new feature.

Forward-link from the main spec §8 added in the same PR that lands this addendum.
