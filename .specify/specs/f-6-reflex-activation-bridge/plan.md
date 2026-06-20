---
feature: "F-6 — Reflex activation bridge"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: F-6 — Reflex activation bridge

## Architecture Overview

A new `ReflexActivationListener` consumes reflex Activation Events from a durable
JetStream consumer and re-emits them as the `tasks.{capability}` dispatch
envelopes cortex's existing executor already runs. No new execution engine.

```
reflex-edge ──fired──▶ local.jc.default.reflex.activation.fired.{target}
                              │  (JetStream: REFLEX_ACTIVATION stream)
                              ▼
                  ┌─────────────────────────────┐
                  │ ReflexActivationListener     │  NEW (src/bus/)
                  │  durable pull consumer        │
                  │  1. parse fired payload       │
                  │  2. dedup (Decision id)       │
                  │  3. resolve target→capability │
                  │  4. re-emit dispatch          │──┐
                  │  5. visibility + ack          │  │
                  └─────────────────────────────┘  │
                              │ (unknown target / fail)│ tasks.@{assistant}.{capability}
                              ▼                        ▼
                  system.bus.reflex_activation_*   dispatch-source-publisher
                  (visibility / typed failure)     → EXISTING executor (cortex#484)
                                                     → spawn harness / run pipeline
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun / TS | cortex standard |
| Subscribe | JetStream durable pull consumer | survives Clawbox restart (NFR-2); mirror `dev-consumer-boot` + `bus/jetstream/provision.ts` |
| Re-emit | built directly via `directTaskSubject` + `buildBaseEnvelope` + `runtime.publishOnSubject` | mirrors `dispatch-source-publisher.ts`'s producer but does NOT reuse its chat-coupled entrypoint (`publishInboundChatDispatchEnvelope` needs a chat `InboundMessage` + human-author resolution); a reflex activation has neither. Re-emit lands on the same publish-time PolicyEngine (NFR-1). |
| Visibility | `runtime.publish` `system.bus.*` | parity with `BusDispatchListener` |
| Dedup | Decision-id keyed store | idempotency (FR-4) — store TBD (open question) |

## Constitutional Compliance

- [x] **CLI-First:** no new CLI; operates on the bus. Target→capability map is config (cortex.yaml).
- [x] **Library-First:** the listener is a self-contained module — it mirrors `dispatch-source-publisher`'s producer pattern (without reusing its chat-coupled entrypoint) and reuses the JetStream provisioning helpers + the `common/untrusted-fence` primitives; no duplicated executor.
- [x] **Test-First:** unit (resolve/dedup/failure) + integration (fired envelope → re-emit) authored before wiring; mirror `bus-dispatch-listener` tests.
- [x] **Deterministic:** resolution + re-emit are pure functions of (envelope, config); JetStream provides delivery.
- [x] **Code Before Prompts:** pure plumbing, no prompt surface.

## Data Model

### Inbound (reflex fired envelope — reflex/src/bus/envelopes.ts)

```typescript
// type: "reflex.activation.fired", subject: local.{p}.{s}.reflex.activation.fired.{target}
interface FiredPayload {
  target: string;                 // Execution Blueprint ref, e.g. "@jc/notify-discord"
  payload: Record<string, unknown>; // Activation Payload (e.g. the GitHub issue)
  // envelope carries: correlation_id, classification, source (reflex Decision id)
}
```

### Target → capability map (config)

```typescript
// proposed cortex.yaml extension (open question — see below)
interface ReflexTarget {
  target: string;     // "@jc/notify-discord"
  capability: string; // "notify.discord"  → existing capability routing
  assistant?: string; // DID the dispatch is addressed to (defaults per config)
}
```

### Re-emitted (existing dispatch contract)

`tasks.@{assistant}.{capability}` built directly (subject via `directTaskSubject`, envelope via `buildBaseEnvelope`, published via `runtime.publishOnSubject`) — carries the
Activation Payload, `correlation_id` (preserved from the fired event), and
provenance (reflex Decision id + original target) so the run is traceable back.

### Dedup record

Keyed on the reflex Decision id (stable across JetStream redelivery). Store:
reuse an existing cortex idempotency surface or a small KV/D1 (open question).

## Implementation Strategy

### Phase 1: Provision + subscribe
- [x] **Stream ownership (RESOLVED during build):** do NOT provision a `REFLEX_ACTIVATION` stream. The `REFLEX` stream is owned and provisioned by **reflex-edge** (subjects `local.{p}.{s}.reflex.>`, `ensureReflexStream`); a second cortex-side stream covering the same subjects would be an overlapping-subject conflict. The bridge binds a **durable pull consumer on the existing `REFLEX` stream**, filtered to the exact fired subject `local.{p}.{s}.reflex.activation.fired` (the `target` is opaque — it rides in the payload, NOT as a subject token, correcting the earlier `…fired.{target}` shape). Implemented via `provisionReviewConsumer` (consumer only, no stream add).
- [x] `ReflexActivationListener` class; durable pull consumer (`subscribePull`, ackPolicy explicit, **deliverPolicy New** so a fresh durable doesn't replay the limits-retained REFLEX backlog); start/stop lifecycle (mirror `BusDispatchListener`). `subscribePull` capability is checked BEFORE provisioning so no orphan consumer is created.

### Phase 2: Resolve + re-emit
- [ ] Parse `FiredPayload`; local-principal filter (drop foreign subjects, v1).
- [ ] Dedup on Decision id → skip + ack if seen.
- [ ] Resolve `target` → capability via config; unknown → typed failure + visibility + ack.
- [x] Re-emit built directly (`directTaskSubject` + `buildBaseEnvelope` + `runtime.publishOnSubject`), preserving classification + correlation + provenance. NO re-gate (reflex already applied policy/guards; cortex publish-time PolicyEngine is the egress/sovereignty check, not re-approval).
- [ ] Emit `system.bus.reflex_activation_dispatched` visibility on success; ack.

### Phase 3: Wire + verify
- [ ] Mount in `src/cortex.ts` boot (alongside the other listeners), gated by config presence.
- [ ] Integration test: synthetic fired envelope → asserted `tasks.{capability}` re-emit; restart-durability (ack floor); redelivery dedup; unknown-target failure.

## File Structure

```
src/bus/
├── reflex-activation-listener.ts     # NEW: the listener
├── ../common/untrusted-fence.ts      # NEW: payload-quarantine primitives (shared)
└── jetstream/provision.ts            # extended: REFLEX_ACTIVATION stream
src/cortex.ts                          # MODIFIED: mount the listener
src/bus/__tests__/
└── reflex-activation-listener.test.ts # NEW
```

## API Contracts

### Internal

```typescript
class ReflexActivationListener {
  constructor(opts: {
    runtime: MyelinRuntime;
    resolveTarget: (target: string) => ReflexTarget | undefined;
    publisher: DispatchSourcePublisher;
    dedup: { seen(id: string): Promise<boolean>; mark(id: string): Promise<void> };
  });
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| No REFLEX_ACTIVATION stream → reflex publishes to a subject with no stream (lost) | High | Med | Provision the stream (Phase 1); reflex publishFired needs a stream covering its subjects — coordinate with the reflex hub stream setup |
| Re-emit loops (dispatch → re-fires reflex) | High | Low | Bridge consumes `reflex.activation.fired.*` and emits `tasks.*` — disjoint subjects; no cycle |
| Double-run on redelivery | Med | Med | Dedup on Decision id + explicit ack |
| Publish-time PolicyEngine refuses the re-emit | Med | Low | classification preserved; map only to capabilities valid for the principal |

## Failure Mode Analysis

### How this code can fail

| Failure | Trigger | Detection | Degradation | Recovery |
|---------|---------|-----------|-------------|----------|
| Stream missing | not provisioned | reflex publish has no stream / consumer empty | activations not delivered | provision REFLEX_ACTIVATION |
| Unknown target | no config mapping | resolve returns undefined | that activation not run | typed failure + visibility; ack (no poison loop) |
| Re-emit publish fails | bus/policy refusal | publisher error | that activation not dispatched | dispatch.task.failed reason + ack; reflex can re-fire on next impulse |
| Cortex down at fire time | restart | — | none (durable) | JetStream redelivers from ack floor |
| Redelivery | JetStream at-least-once | dedup store | none | dedup → single dispatch |

### Assumptions that could break

| Assumption | Invalidated by | Detection |
|-----------|----------------|-----------|
| A stream covers `reflex.activation.fired.>` | hub stream config drift | integration test + consumer-empty alarm |
| `dispatch-source-publisher` accepts the re-emit shape | producer contract change | integration test |
| reflex Decision id is stable across redelivery | reflex envelope change | dedup test |

### Blast Radius

- **Files:** ~3 (new listener, provision extension, cortex.ts mount) + tests.
- **Systems:** adds a consumer; does not change existing dispatch/executor behavior. Disjoint subjects (no cycle).
- **Rollback:** don't mount the listener (config-gated) → no behavior change.

## Dependencies

- Internal: `bus/jetstream/provision.ts`, `common/untrusted-fence.ts`, `@the-metafactory/myelin/subjects` (`directTaskSubject`), `MyelinRuntime` (`publishOnSubject`/`subscribePull`/`jetstreamManager`), the existing executor (dispatch-listener/dev-consumer). Mirrors `dispatch-source-publisher.ts` but does not depend on it.
- External: none new.
- Cross-repo: reflex must publish fired events to a subject covered by a JetStream stream (coordinate stream ownership — hub vs cortex-provisioned).

## Estimated Complexity

- **New files:** 2 (listener + test)
- **Modified files:** ~2 (provision, cortex.ts)
- **Estimated tasks:** ~8
- **Debt score:** 2/5 — reuses the executor + publisher; new surface is one consumer + a config map; main unknown is stream ownership.

## Longevity Assessment

### Maintainability

| Indicator | Status | Notes |
|-----------|--------|-------|
| Readable in 6 months? | Yes | one listener mirroring an established sibling |
| Testable without manual runs? | Yes | synthetic envelope → assert re-emit |
| "Why" captured? | Yes | spec + cortex#1177 (reflex fires into the void today) |

### Evolution vectors

| What might change | Preparation | Impact |
|-------------------|-------------|--------|
| Federated activations | local-only filter is the seam | Med |
| Direct Execution-Blueprint run (vs capability re-emit) | resolution isolated behind `resolveTarget` | Med |
| Richer target config | map is config-driven | Low |

### Deletion criteria

- [ ] Superseded if reflex gains a native execution path (won't — reflex is decide-only by design).
- [ ] Removed if cortex stops being the executor.

## Open Questions
- [ ] Stream ownership: who provisions `REFLEX_ACTIVATION` covering `reflex.activation.fired.>` — cortex here, or the hub/reflex side? (reflex's own `publishFired` also needs a stream covering its subjects.)
- [ ] Target→capability map location: cortex.yaml extension vs dedicated config; and whether `target` can encode the capability directly.
- [ ] Dedup store: reuse an existing cortex idempotency surface vs a dedicated KV/D1.
- [ ] Exact re-emit subject/type: `directTaskSubject` `tasks.@{assistant}.{capability}` vs a `dispatch.task.dispatched` — align with how existing producers (sage dispatch) emit.
