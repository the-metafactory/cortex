# Design: Blueprint Tech-Tree Visualization (G-700)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-blueprint-visualization.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** Draft
**Research:** `docs/research-blueprint-visualization.md`
**Iteration:** `docs/iteration-blueprint-visualization.md`
**Tracking:** #93

## Problem

The Grove dashboard shows what agents are doing now (sessions) and what they've done (GitHub activity), but not what work is **available next** or what's **blocking progress**. The Blueprint project models cross-repo feature dependencies as a DAG, but has no visual rendering yet. Combining these fills a critical gap: a single dashboard for past, present, and future work.

## Solution

Add a "Tech Tree" view to the Grove dashboard that renders the Blueprint dependency graph using React Flow + ELK, with status-colored nodes, repo grouping, and interactive exploration.

## Architecture

```
Blueprint CLI (--json)  -->  Grove Bot API  -->  Dashboard React Flow
                             /api/blueprint      (ELK layout engine)
```

Grove calls Blueprint CLI for data, serves it via REST, and renders with React Flow.

## Features

### G-700a: Blueprint API Endpoint

Grove bot exposes `GET /api/blueprint` that:
1. Calls `blueprint status --json` (or reads cached result)
2. Returns `{ nodes, edges, stats }` JSON
3. Caches for configurable TTL (default 5 min)
4. Returns 503 if Blueprint CLI not installed

**Acceptance criteria:**
- [ ] `GET /api/blueprint` returns valid node/edge JSON
- [ ] Response includes computed status (ready/blocked)
- [ ] Cache prevents repeated CLI calls within TTL
- [ ] 503 with helpful message if Blueprint not available

### G-700b: React Flow Integration

Add React Flow (`@xyflow/react`) and ELK (`elkjs`) to dashboard dependencies. Create base graph component.

**Acceptance criteria:**
- [ ] React Flow renders a graph with nodes and edges
- [ ] ELK computes Sugiyama layered layout (left-to-right)
- [ ] Graph is pannable, zoomable, with minimap
- [ ] Builds successfully with `bun build` for CF Pages

### G-700c: Feature Node Component

Custom React Flow node component showing feature details:
- Feature ID and name
- Status indicator (color-coded: green/yellow/blue/gray)
- Repo badge, effort size, owner
- Click to expand details (description, linked issue/PR, blocking deps)

**Acceptance criteria:**
- [ ] Nodes display ID, name, status, repo, effort, owner
- [ ] Color scheme: done=green, in-progress=yellow, ready=blue, blocked/planned=gray
- [ ] Click expands detail panel with description and links
- [ ] Nodes visually grouped or color-coded by repo

### G-700d: Filtering and Navigation

- Filter by repo (show only grove features, only arc, etc.)
- Filter by status (show only ready, only blocked)
- Filter by iteration
- "Frontier" mode: highlight only `ready` features
- Path highlight: click a feature → highlight all dependencies leading to it

**Acceptance criteria:**
- [ ] Repo filter works (toggle repos on/off)
- [ ] Status filter works (toggle statuses on/off)
- [ ] Frontier mode highlights ready features, dims others
- [ ] Path highlight shows dependency chain for selected node

### G-700e: Dashboard Integration

Add "Tech Tree" as a new view/tab on the Grove dashboard alongside Home, Repos, and Agent views.

**Acceptance criteria:**
- [ ] "Tech Tree" navigation item in dashboard header
- [ ] View loads Blueprint data on mount
- [ ] Stats summary bar: total features, done, in-progress, ready, blocked
- [ ] Responsive layout works on desktop and tablet
- [ ] Loading/error states handled gracefully

## Tech Stack

| Component | Library | Bundle (gzip) |
|-----------|---------|---------------|
| Graph rendering | `@xyflow/react` v12 | ~170 kB |
| Layout engine | `elkjs` | ~150 kB |
| Node components | Custom React | minimal |
| **Total addition** | | **~320 kB** |

## Dependencies

**Hard dependency:** Blueprint Iteration 1 (B-100 through B-107) must be complete — specifically the YAML parser, ecosystem sync, DAG builder, and status resolver.

**Soft dependency:** Blueprint `--json` output flag (could be added as part of this work if not already present).

## Non-Goals

- Editing features from the dashboard (read-only visualization)
- Real-time updates (periodic polling is sufficient)
- Standalone Blueprint dashboard (this integrates into Grove's existing dashboard)
- Mobile-optimized graph rendering (desktop/tablet primary)
