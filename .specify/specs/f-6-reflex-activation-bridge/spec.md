# Specification: F-6 — Reflex activation bridge

> Tracked in the-metafactory/cortex#1177. Interview folded onto the open design forks; problem/context carried from the reflex→pulse bridge discovery (no consumer of `reflex.activation.fired` exists today).

## Problem Statement

**Core problem.** Reflex (the activation runtime) decides *when* declared work should start and publishes an **Activation Event** on `local.{principal}.{stack}.reflex.activation.fired` (type `reflex.activation.fired`; payload carries the `target` Execution Blueprint ref + the Activation Payload; the `target` is opaque payload data, not a subject token). **Nothing consumes it** — Reflex fires into the void: an Activation Event never becomes a run.

> Negative-discovery evidence (reproducible, run at commit `b4e9cbd` on this branch; the only hit is this PR's own new code):
> ```
> $ grep -rnE "reflex\.activation\.fired|reflex\.activation\.>" src | grep -viE "reflex-activation-listener|__tests__|\.test\."
> src/bus/system-events.ts:576:  * reflex `reflex.activation.fired` event and re-emits it as a `tasks.*`
> $ grep -rnE "reflex\.activation\.fired|reflex\.activation" ~/work/mf/pulse/src   # (no output → zero subscribers)
> ```

**Urgency.** This blocks every reflex→execution path. Concrete driver: a reflex `github-issue-opened` blueprint (the-metafactory/reflex#23, merged) fires on a new GitHub issue, but no run results. Reflex is pure decide-only by design; cortex is the always-on executor (Clawbox).

**Impact if unsolved.** Reflex activations are inert end-to-end; the laptop-free GitHub→Discord goal (and any future reflex-driven automation) cannot work.

## Users & Stakeholders

**Primary user.** The principal (jc) declaring reflex Activation Blueprints whose `target` should actually run.
**Operators.** Whoever runs cortex on Clawbox. Technical level: expert; internal ecosystem plumbing.

## Current State

- **Reflex** publishes `reflex.activation.fired` after applying its full pipeline — policy (auto/approval), guards (cooldown, run-lock, idempotency). A `fired` event means *cleared to run* (`reflex/src/bus/envelopes.ts`, R-104).
- **Cortex** is the executor (cortex#484 "Option D"): it subscribes to bus subjects via `runtime.onEnvelope` + `subjectMatches` (`src/bus/bus-dispatch-listener.ts`, `src/runner/dispatch-listener.ts`) and dispatches `tasks.*` envelopes to agents/pipelines (capability-keyed; `cortex.yaml` `capabilities[].provided_by[]`), spawning a harness / running a pipeline per envelope. Runs always-on on Clawbox.
- **Gap:** no listener maps `reflex.activation.fired` into that dispatch path.

## Solution Overview

A `ReflexActivationListener` (sibling of `BusDispatchListener`) that bridges reflex Activation Events into cortex's existing dispatch executor:

1. **Subscribe** to `local.{principal}.{stack}.reflex.activation.fired` via a **durable JetStream consumer** (survives a Clawbox restart; at-least-once + dedup).
2. **Resolve** the envelope's `target` (Execution Blueprint ref, e.g. `@jc/notify-discord`) to a **capability** via a target→capability map.
3. **Re-emit** the work as the `tasks.{capability}` / `dispatch.task.*` envelope cortex's existing executor already consumes — carrying the Activation Payload, correlation id, and provenance — so the proven dispatch/execute path runs it unchanged.

The bridge does **not** re-gate: reflex already applied policy + guards, so a fired event is executed, not re-evaluated. The Discord-notify capability (per-repo webhook config) is a separate downstream piece registered like any other capability.

## Requirements

### Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | A `ReflexActivationListener` subscribes to `local.{principal}.{stack}.reflex.activation.fired` via a durable JetStream consumer and handles each fired envelope. | Durability decision |
| FR-2 | For each fired envelope, resolve `target` → a capability via a configured target→capability map; re-emit a `tasks.{capability}` / `dispatch.task.*` envelope that cortex's existing executor consumes, carrying the Activation Payload + correlation id + provenance (originating reflex Decision id, target). | Target-resolution decision |
| FR-3 | The bridge does NOT re-apply policy/approval/guards — reflex already cleared the activation. A `fired` event = execute. | Current state (reflex semantics) |
| FR-4 | Idempotent: a redelivered fired envelope (same Decision id / envelope id) does not double-dispatch (durable-consumer ack + dedup). | Idempotency |
| FR-5 | Honor the fired envelope's `classification` (sovereignty): a `local` activation must dispatch only within the principal boundary; the re-emitted envelope preserves classification + sovereignty metadata. | Sovereignty |
| FR-6 | An unresolvable `target` (no capability mapping) or a dispatch failure emits a typed failure + a visibility event (reuse the `dispatch.task.failed` shape), and acks (does not poison-loop the consumer). | Failure semantics |
| FR-7 | A successful bridge emits a visibility event (e.g. `system.bus.reflex_activation_dispatched`) so the principal sees "reflex activation X → dispatched as capability Y". | Observability (BusDispatchListener parity) |

### Non-Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| NFR-1 | Reuse cortex's existing executor + dispatch envelope contract — no parallel execution engine. | Reuse decision |
| NFR-2 | Durable across Clawbox restart: a fired event arriving while cortex is briefly down is delivered on resubscribe (JetStream ack floor). | Durability |
| NFR-3 | Local principal only for v1; federated activations out of scope. | Scope |
| NFR-4 | A single malformed/failed activation never stalls the consumer (ack + typed failure, like BusDispatchListener dropping invalid envelopes). | Robustness |

## User Experience

- **Setup:** operator registers a target→capability mapping (config) and ensures the capability is provided (`cortex.yaml`). Reflex blueprint's `target` names the Execution Blueprint ref.
- **Happy path:** reflex fires → bridge resolves target → re-emits `tasks.{capability}` → existing executor runs it → visibility event. All on Clawbox; laptop offline.
- **Errors:** unknown target → typed failure + dashboard visibility, consumer keeps going.

## Edge Cases & Failure Modes

| Scenario | Expected behavior |
|----------|-------------------|
| Cortex down when reflex fires | Durable consumer redelivers on restart (no lost activation) |
| Redelivered fired envelope | Dedup on Decision/envelope id → single dispatch |
| `target` has no capability mapping | Typed failure + visibility event; ack; consumer continues |
| Capability dispatch itself fails | `dispatch.task.failed` reason surfaced; ack |
| `classification: local` activation | Dispatched only within principal boundary; classification preserved |
| Federated/foreign-principal fired subject | Ignored in v1 (local-only filter) |
| Malformed envelope (no target) | Dropped with structured stderr log + ack (BusDispatchListener parity) |

## Success Criteria

**Definition of done.** A reflex `fired` Activation Event on `local.jc.default.reflex.activation.fired` is consumed by cortex on Clawbox, resolved to a capability, and re-emitted as a dispatch the existing executor runs — verified end to end (a test target capability runs from a real fired event); restart-durable; idempotent on redelivery; honors classification; typed failure on unknown target.

**MVP.** The listener + durable consumer + target→capability resolution + re-emit + idempotency + failure/visibility events, with unit/integration tests. A concrete capability (Discord-notify) is downstream, separate work.

## Scope

### In scope
- `ReflexActivationListener` (subscribe, resolve, re-emit, dedup, classification, failure/visibility).
- Target→capability mapping mechanism (config).
- Tests (unit + integration against the in-memory/bus transport).
- Wiring into cortex boot alongside the other listeners.

### Explicitly out of scope
- The Discord-notify capability / Execution Blueprint (downstream).
- The reflex `github-issue-opened` blueprint (reflex side; trivial KV add).
- Federated / cross-principal activations.
- Running the Pulse pipeline engine on CF (separate, large).
- Re-gating policy/approval (reflex owns that).

## Open Questions
- [ ] Where the target→capability map lives (cortex.yaml extension vs a dedicated config) and its shape.
- [ ] Exact re-emitted envelope type/subject (`dispatch.task.dispatched` vs a direct `tasks.{capability}` publish) — align with how `sage dispatch` / existing producers emit.
- [ ] Dedup store: reuse an existing cortex idempotency surface, or a dedicated KV/D1 keyed on Decision id?

## Assumptions
- Cortex's existing executor will run a re-emitted `tasks.{capability}` envelope unchanged (the bridge produces the same shape existing producers do).
- The reflex fired envelope carries enough (target, Activation Payload, classification, correlation id) to construct the dispatch.
- Cortex/Pulse run always-on on Clawbox (operator-provided).

---
*Interview: target resolution (re-emit as tasks.{capability}) + durability (durable JetStream consumer). Problem/context carried from cortex#1177 + the reflex→pulse bridge discovery.*
