# Iteration Plan: Blueprint Tech-Tree Visualization (G-700)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-blueprint-visualization.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Design:** `docs/design-blueprint-visualization.md`
**Research:** `docs/research-blueprint-visualization.md`
**Tracking:** #93

## Prerequisites

- [ ] Blueprint Iteration 1 complete (B-100 through B-107)
- [ ] Blueprint CLI produces `--json` output

## Execution Order

Features ordered by dependency. G-700b and G-700c can parallelize after G-700a.

### G-700a: Blueprint API Endpoint
- [ ] Add `GET /api/blueprint` route to `dashboard-api.ts`
- [ ] Implement Blueprint CLI invocation (`blueprint status --json`)
- [ ] Add response caching with configurable TTL
- [ ] Handle Blueprint not installed (503 response)
- [ ] Add types for Blueprint node/edge/stats schema

### G-700b: React Flow Integration
- [ ] Add `@xyflow/react` and `elkjs` to `package.json`
- [ ] Create `BlueprintGraph` component with React Flow provider
- [ ] Implement ELK layout computation (Sugiyama, left-to-right)
- [ ] Add pan, zoom, minimap controls
- [ ] Verify `bun build` produces working static output for CF Pages

### G-700c: Feature Node Component
- [ ] Create `FeatureNode` custom React Flow node component
- [ ] Implement status color scheme (done/in-progress/ready/blocked/planned)
- [ ] Add repo badge, effort indicator, owner display
- [ ] Implement click-to-expand detail panel
- [ ] Style edge connections (status-aware coloring)

### G-700d: Filtering and Navigation
- [ ] Add repo filter (toggle buttons or dropdown)
- [ ] Add status filter (toggle by status)
- [ ] Add iteration filter
- [ ] Implement "Frontier" mode (highlight ready, dim rest)
- [ ] Implement path highlight (click node → show dependency chain)

### G-700e: Dashboard Integration
- [ ] Add "Tech Tree" route/view to dashboard app
- [ ] Add navigation item to dashboard header
- [ ] Implement data fetching via `useGroveApi` hook
- [ ] Add stats summary bar (total, done, in-progress, ready, blocked)
- [ ] Add loading and error states
- [ ] Deploy to CF Pages and verify

## Exit Criteria

- Dashboard "Tech Tree" view renders the full Blueprint dependency graph
- Nodes show status, repo, and metadata with correct colors
- Users can filter by repo, status, and find the "frontier" of available work
- Path highlighting shows what's needed to unlock any feature
- Deployed on CF Pages, accessible at `grove.meta-factory.ai`
