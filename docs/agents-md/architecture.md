## Architecture

cortex is the **M7 application** of the metafactory Myelin stack — the operator's collaboration surface that consumes the bus (M2–M6) and presents activity to humans. It replaces both `the-metafactory/grove` (legacy v0.29.0) and `the-metafactory/grove-v2` (v0.22.1) as the canonical home for Discord/Mattermost adapters, Mission Control dashboard, workflow runner, and bus-side taps.

cortex is layer 7 in the OSI-style **M1–M7 Myelin stack**:

```
M7 SURFACES (cortex, pilot, signal-collector, future apps) ← cortex lives HERE
M6 COMPOSITION (myelin)
M5 DISCOVERY   (myelin)
M4 IDENTITY    (myelin)
M3 ENVELOPE    (myelin — schema + namespace)
M2 TRANSPORT   (myelin abstraction over NATS)
M1 CONNECTIVITY (NATS leaf nodes / federation)
```

cortex consumes contracts from M2–M6, owns no part of M1–M6 itself, and shares M7 with sibling apps (pilot for review-loop coordination, signal-collector for telemetry, future apps).

Internal componentisation (per `docs/architecture.md` §8):

- `src/cortex.ts` — Top-level entrypoint (MIG-7.1). Wires bus + adapters + runner + taps + renderers.
- `src/bus/` — M2–M6 client code: NATS connection, envelope validator, surface-router, dispatch-handler, system-events. The G-1100 ladder lifted from grove-v2 plus the surface-router (G-1111.A).
- `src/bus/myelin/` — Vendored myelin schema + envelope + subscription primitives.
- `src/bus/nats/` — NATS client wrapping.
- `src/surface/mc/` — Mission Control v3 (149 files lifted from grove-v2 `src/mission-control/`). API, state, DB, dashboard-v2 React tree, worker (CF Worker REST API + WebSocket), notifications.
- `src/adapters/` — Platform adapters (Discord, Mattermost) that register with the surface-router rather than subscribing to NATS directly. `mock.ts` for tests.
- `src/runner/` — CC orchestration: cc-session (streaming `claude --print --output-format stream-json`), session-manager (per-thread CC session for `--resume`), stream-parser, agent-team (multi-agent moderator + participants), dispatch-listener, security-preamble, prompt-builder, worklog-manager, task-tracker, bash-guard hook.
- `src/taps/` — Publishers onto the bus: `cc-events/` (CC hooks + EventLogger + relay + cloud-publisher), `gh-webhook/` (CF Worker at `hooks.meta-factory.ai` validating GitHub HMAC and forwarding).
- `src/cli/` — Operator CLIs: `discord/` (post messages, read channels, list threads from terminal), `cldyo-live` (instrumented Opus session wrapper), `cortex/` (top-level CLI).
- `src/renderers/` — Renderer interface + dashboard renderer + pagerduty renderer (the G-1111 §4.6 fail-safe pair).
- `src/common/` — Shared types + utilities: agent-detection, event-processor, event-utils, github-events, agents/, config/, timeout, types/, usage.
- `src/services/` — launchd plists: `ai.meta-factory.cortex.meta-factory.plist` (metafactory dev stack), `ai.meta-factory.cortex.work.plist` (parallel work stack — cortex#244), `ai.meta-factory.cortex.relay.plist` (shared relay).
- `src/settings/` — `cortex-hooks.json` (CC hook registration).
- Config: `~/.config/cortex/cortex.yaml` (post-MIG-7.9 — migrated from grove-v2 `~/.config/grove/bot.yaml` via `migrate-config`).

Read `docs/architecture.md` for the full layered model + agent + presence/renderer model + event architecture + agent task routing pattern. Read `docs/plan-cortex-migration.md` for the per-phase migration plan (MIG-0..MIG-8) that drives all current work.

## Migration provenance

cortex inherits source from `the-metafactory/grove-v2`. Legacy `the-metafactory/grove` (v0.29.0) is in maintenance-mode for security work and contributes nothing to cortex (per migration plan §2.2 — ~6,500 LOC of legacy-only agent/persona/AAA + parallel NATS work that does not migrate).

The migration is phased MIG-0 (bootstrap) through MIG-8 (legacy retirement). Per-phase work is tracked as GitHub issues `cortex#1` umbrella (C-100) + `cortex#2..#10` for each phase.
