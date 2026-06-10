# Mission Control integration architecture — in-process, bus-projected, no legacy lift

Status: accepted (2026-06-10, grill-with-docs session, Q1/Q2/Q4/Q5)

## Context

Mission Control's surface (G-1113 cockpit, phases A–E) is complete, but every integration between the cortex runtime and MC was dead: `cortex.ts`'s `setupDashboard()` dynamically imports `./surface/mc/api/index` — the never-lifted grove-v2 `DashboardApi` (#712) — behind an `as string` cast and a non-fatal catch. The cockpit refresh loop (ML.5) gates on that import's `mcDb`, which would in any case have been a wrong-schema handle (`refreshCockpit` expects the MC v3 `mission-control.db`, the legacy class opens `dashboard.db`). Nothing started the MC server in any stack; dispatch-spawned agent sessions were invisible (the ingestor hard-drops events for unregistered `cc_session_id`s); and the DashboardRenderer ring buffer had no consumer ("MIG-7.13" was a checkpoint, never a contract).

## Decision

1. **No grove-v2 lift.** The cortex-built MC v3 (`src/surface/mc/`) is the only platform. `setupDashboard()`'s dead import is retired; the legacy class's residual capabilities (usage snapshots, activity state) port individually onto MC v3 if and when wanted. #712 is re-scoped accordingly.
2. **MC runs in-process.** The cortex runtime starts the MC server as a module behind a new `mc:` config block (the legacy `api.*` block retires with a deprecation warning). The hosting process owns `mission-control.db` — cockpit loop, hook ingestor, and API share one handle; no cross-process SQLite contention. One designated stack hosts the pane first (meta-factory); DB paths derive from the stack slug so other stacks can enable later without collision.
3. **Session rows are projected from the bus.** The runner stamps `cc_session_id` onto `dispatch.task.started`; MC — playing the dispatch-sink role CONTEXT.md already assigns it — projects lifecycle envelopes into session/assignment rows. The ingestor additionally auto-registers unknown `cc_session_id`s as orphan `local.observed` sessions (catches instrumented non-dispatch sessions, e.g. `cldyo-live`). This works unchanged for peer-stack sessions arriving on `federated.` lifecycle envelopes.
4. **The bus→MC seam is a registered renderer.** MC's projection registers with the surface-router like every other dispatch sink — push-based `project(envelope)`. The DashboardRenderer ring buffer is no longer a planned IPC mechanism; it survives (if at all) only as the drill-down's recent-raw-envelopes feed.

## Considered options

- **Lift + adapt grove-v2 (two servers)** — preserves the migration plan's original wording, but ships 75KB of legacy schema whose frontend was retired at MIG-6, and still requires fixing the `mcDb` seam. Rejected: grove-v2 contributes nothing (migration plan §2.2 spirit).
- **Poll `DashboardRenderer.getRecent()`** — the stub's anticipated shape. Rejected: polling latency, dedup bookkeeping, and a 1000-envelope bound that drops bursts.
- **Direct in-process registration from dispatch-listener** — simplest session join. Rejected: couples runner→MC module-to-module, covers only dispatch spawns, and doesn't extend to peer-stack sessions.

## Consequences

- `api.enabled` / the embedded `:8766` server concept disappear; config migration needs a deprecation path.
- MIG-7.13's renderer-buffer language in `src/renderers/dashboard.ts` is superseded by the renderer seam.
- The drill-down's deep view is explicitly NOT cortex-captured: session-interior detail rides signal's trace spans (see CONTEXT.md "Session interior" and the signal boundary entry); cortex's cc-events pipeline stays the thin, policy-filtered Tier-2 stream — the planned "thicken capture" work is dropped.
