# Iteration plan — F-18 Mission Control metrics

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-mc-metrics.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

Mirrors GH issue (`feature` + `now` labels) and is the canonical checklist agents tick as work lands. Spec: `docs/design-mc-f18-metrics.md`.

## F-18 — single-PR scope

- [ ] Spec doc + iteration plan land
- [ ] `db/metrics.ts` — `computeAssignmentMetrics` + `computeFleetMetrics` + tests against synthetic event timelines
- [ ] API types in `api/types.ts` — `AssignmentMetrics`, `FleetMetrics`, `MetricsAssignmentResponse`, `MetricsFleetResponse`
- [ ] Handlers in `api/handlers.ts` — `handleGetAssignmentMetrics`, `handleGetFleetMetrics` + endpoint tests
- [ ] Routes wired in `server.ts` — `/api/metrics/assignment/:id`, `/api/metrics/fleet`
- [ ] `dashboard-v2/hooks/use-metrics.ts` — boot + window-switch refetch + WS-debounced refresh
- [ ] `dashboard-v2/components/metrics-panel.tsx` (+ `.css`) — three sections, no chart library
- [ ] `dashboard-v2/lib/format-duration.ts` — short-form duration helper (`Xs / Xm / Xh / Xd`)
- [ ] Tab wired in `app.tsx` between `Focus / Working / Tasks` and `Iterations`
- [ ] Bundle rebuilds clean; type-check + tests green

## F-19 — follow-ups (file as separate issues post-merge)

- [ ] F-19.1 — wait-for-token (CC `usage` event ingestion + derived metric)
- [ ] F-19.2 — cost / token metrics (USD per assignment, per agent)
- [ ] F-19.3 — windowed query optimisation when N > O(10⁴) per window
- [ ] F-19.4 — sparklines / trend charts (point-in-time → time-series)
- [ ] F-19.5 — alerting thresholds (p90 over X → Discord ping)
- [ ] F-19.6 — drill-from-metric-to-assignment (per-agent click → assignment metrics view)
