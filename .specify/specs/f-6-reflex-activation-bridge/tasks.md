# Implementation Tasks: F-6 Reflex activation bridge

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-1.2 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-2.3 | ☐ | |
| T-3.1 | ☐ | |
| T-3.2 | ☐ | |
| T-4.1 | ☐ | |

---

## Group 1: Resolve + dedup primitives (pure, testable)

### T-1.1: Target→capability resolution [T]
- **Files:** `src/bus/reflex-activation-listener.ts` (resolve helper), config type
- **Description:** A `resolveTarget(target) → { capability, assistant? } | undefined` backed by a config map (cortex.yaml extension — decide location). Pure.
- **Tests:** known target → mapping; unknown → undefined.

### T-1.2: Fired-envelope parse + dedup key [T]
- **Files:** `src/bus/reflex-activation-listener.ts`
- **Description:** Parse `FiredPayload` (target, payload, correlation_id, classification, reflex Decision id) from the envelope; derive the dedup key (Decision id). Local-principal filter (drop foreign subjects, v1).
- **Tests:** valid envelope parses; missing target → typed error; foreign subject → filtered.

## Group 2: Listener core

### T-2.1: ReflexActivationListener — re-emit path [T]
- **Files:** `src/bus/reflex-activation-listener.ts`
- **Description:** On a parsed fired event: dedup (skip+ack if seen) → resolve target → re-emit via `dispatch-source-publisher` (`directTaskSubject` → `tasks.@{assistant}.{capability}`), preserving classification + correlation + provenance (Decision id, original target). Emit `system.bus.reflex_activation_dispatched` visibility on success.
- **Tests:** fired → asserted re-emit envelope (subject + payload + provenance); visibility emitted; dedup skips a repeat.

### T-2.2: Failure + idempotency semantics [T]
- **Files:** `src/bus/reflex-activation-listener.ts`
- **Description:** Unknown target or publish failure → typed failure (`dispatch.task.failed`-shape) + visibility, then ack (no poison loop). Redelivery (same Decision id) → single dispatch.
- **Tests:** unknown target → failure+ack, no dispatch; redelivery → one dispatch.

### T-2.3: Lifecycle (start/stop) [T]
- **Files:** `src/bus/reflex-activation-listener.ts`
- **Description:** start() binds the durable consumer; stop() drains + unsubscribes (mirror BusDispatchListener stop discipline — no late side effects).
- **Tests:** start/stop idempotent; no handler fires after stop.

## Group 3: Durable consumer + wiring

### T-3.1: REFLEX_ACTIVATION stream + durable pull consumer
- **Files:** `src/bus/jetstream/provision.ts` (extend), listener subscribe
- **Description:** Provision a JetStream stream covering `local.{p}.{s}.reflex.activation.fired.>`; bind a durable pull consumer (ackPolicy explicit, deliverPolicy new). Resolve stream-ownership open question (cortex provisions vs hub).
- **Tests:** provision idempotent; consumer binds + receives.

### T-3.2: Mount in cortex boot
- **Files:** `src/cortex.ts`
- **Description:** Construct + start the listener in boot (alongside the other listeners), config-gated (no map → not mounted, no behavior change). Stop on shutdown.

## Group 4: Verify

### T-4.1: Integration + suite green
- **Description:** Integration test: synthetic fired envelope → re-emit → (mock executor) receives `tasks.{capability}`; restart-durability (ack floor) + redelivery dedup + unknown-target failure. Full `bun test` + `tsc` clean.

---

## Execution Order

```
T-1.1, T-1.2 (pure primitives)
  → T-2.1 (re-emit) → T-2.2 (failure/idempotency) → T-2.3 (lifecycle)
  → T-3.1 (durable consumer) → T-3.2 (mount)
  → T-4.1 (integration + suite)
```

## Open Questions (carry from plan — resolve during impl)
- Stream ownership for REFLEX_ACTIVATION (cortex vs hub).
- Target→capability map location (cortex.yaml).
- Dedup store (reuse vs dedicated).

**Total: 8 tasks.**
