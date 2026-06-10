# Iteration plan — Mission Control pane of glass (Iteration 1: light the local pane)

**Status tracker for the umbrella GH issue [#843](https://github.com/the-metafactory/cortex/issues/843).**
Phases 0–2, local only. When a box ticks here, tick it on the umbrella issue too.

Capstone framing + decision record:

- **ADR-0005** — Mission Control integration architecture (in-process, bus-projected, no legacy lift) — [`docs/adr/0005-mission-control-integration-architecture.md`](adr/0005-mission-control-integration-architecture.md) (PR #842).
- **ADR-0006** — network-view feed (registry-anchored; Phase 3, NOT this iteration) — [`docs/adr/0006-mission-control-network-view-feed.md`](adr/0006-mission-control-network-view-feed.md).
- Survey + grilling: `.prd/PRD-20260610-mc-pane-of-glass-plumbing.md` (2026-06-10).

---

## Goal

Bring Mission Control to life as the local pane of glass: the cockpit lit
in-process, agent sessions visible live, and the bus projected onto the glass.

The cockpit UI is complete but dark — `setupDashboard()`'s dead import (#712),
ingestor session drops, an unconsumed renderer buffer, an unfed cloud pane. This
iteration plumbs the local pane end-to-end.

---

## Scope (Iteration 1 = Phases 0–2, local only)

- **Phase 0 — light what's built:** `mc:` config block, in-process embed, retire
  `setupDashboard()`'s dead import (#712); enable on the meta-factory stack.
- **Phase 1 — agents on the glass:** bus-driven session projection
  (`cc_session_id` on `dispatch.task.started`), ingestor orphan auto-register.
- **Phase 2 — bus onto the glass:** MC projection renderer registered with the
  surface-router; attention producers completed.

**Out of scope (future iterations):**
Phase 3 (G-1114 [#355](https://github.com/the-metafactory/cortex/issues/355)
network topology + registry-anchored cloud feed per ADR-0006), Phase 4 (signal
trace deep-link, signal#99).

---

## PR plan

Each slice is a sub-issue of the umbrella; its PR closes it. Tick the box on
merge (here and on the umbrella).

| Slice | PR | Depends on | Files / area | Done |
|---|---|---|---|---|
| **S1** | `mc:` block + embed module + retire setupDashboard | — | `config.ts`, `surface/mc/embed.ts`, `cortex.ts` | [ ] |
| **S2** | enable meta-factory + live verify + config-layout docs | S1 | `docs/config-layout`, deployment | [ ] |
| **S3** | `cc_session_id` on `dispatch.task.started` | — | `runner/cc-session`, bus types | [ ] |
| **S4** | MC session projection from lifecycle envelopes | S1, S3 | `surface/mc` projection | [ ] |
| **S5** | ingestor orphan auto-register (`local.observed`) | S1 | `surface/mc/hooks/ingestor` | [ ] |
| **S6** | MC projection renderer on the surface-router | S1, S4 | `renderers`, `surface/mc` | [ ] |
| **S7** | attention producers: `failed_dispatch` + `stale` | S6 | `surface/mc/db/attention-sources` | [ ] |

---

## S1 — `mc:` config block + in-process embed + retire setupDashboard's dead import

Closes [#712](https://github.com/the-metafactory/cortex/issues/712). Implements
ADR-0005's in-process-embed + retire-the-legacy-lift decision.

- [ ] `mc:` config block on `AgentConfigSchema` (`enabled` / `configPath` /
      `dbPath` / `port`), using the `emptyDefault()` + transform idiom so the
      all-defaults parse path stays populated.
- [ ] `src/surface/mc/embed.ts` — `startMissionControl()` mirrors the standalone
      `index.ts` composition (loadConfig → initDatabase → ProcessManager →
      startServer → HookStreamPoller); embedded mode overrides db + cursor +
      port (ADR-0005 §2), MC yaml governs hooks / ws / log only.
- [ ] `cortex.ts` — boot the embed when `mc.enabled`; per-slug default db at
      `~/.local/share/cortex/mc/<stack>/mission-control.db` with the hook cursor
      beside it; cockpit loop's `baseUrl` reads the embed's actual port.
- [ ] `cortex.ts` — `api.enabled` warns once that the legacy embedded dashboard
      is retired (it never migrated from grove-v2, #712) and directs to `mc:`;
      `setupDashboard` + `runStartupCloudSync` + the dead `as string` import
      deleted. The `api:` schema block stays (back-compat reader); `CloudPublisher`
      instantiation stays (Phase 3 / ADR-0006 re-homes its dead call site).
- [ ] Tests: `mc` defaults parse + explicit values honored; embed boots against a
      tmp dbPath on an OS-assigned port, serves `/health`, lands db + cursor
      beside each other, releases the port on `stop()`.

---

## Notes

- Merge reports post to the MC thread in Discord (control plane); review detail
  stays on the PRs (data plane).
- The iteration doc lands with S1; subsequent slices fill in their own
  acceptance checklists under their headings as they're picked up.
