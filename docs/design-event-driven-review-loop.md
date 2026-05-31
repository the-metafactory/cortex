# Design: Event-Driven Review Loop

**Status:** Draft
**Stage:** spec
**Author:** Andreas + Luna
**Date:** 2026-05-29
**Refs:** `design-capability-dispatch-review-consumer.md` (cortex#237), `iteration-hitl-pr-review.md`, `sop-bus-review.md`, CONTEXT.md §The bus / §Surfaces / §Dispatch. Builds on v3.1.0 (review reply loop).

---

## 1. Problem

The pilot review loop — *develop → ping a reviewer → reviewer reviews → act on the verdict → merge/fix → repeat* — is what previously turbocharged delivery. v3.1.0 restored the hard half: Luna↔Echo dispatch over the bus, Echo reviewing and **posting to GitHub** + replying in-thread (authored by Echo, deterministic `presentation`, no double-replies).

But the **closing half** still rides a blocking primitive: `pilot request-review --wait --timeout 30m`. That has three faults:

1. **It times out.** A long review or a long dev task that outlasts `--timeout` loses the answer — the waiter gives up before the verdict lands.
2. **It's less responsive / holds a connection.** A session is pinned waiting instead of free to do other work.
3. **It puts orchestration in the wrong layer.** The "wait + decide + drive the next step" logic sits in a CLI call (or a CC session babysitting with `ScheduleWakeup`), not in the bus layer where the lifecycle events already flow.

## 2. Principles (the target shape)

- **Event-driven, not blocking-wait.** The requester fires the review request and *returns*. A persistent **reactor** wakes on the completion event — `review.verdict.<kind>` / `dispatch.task.{completed,failed}` — **whenever it arrives**, minutes or hours later. No held wait, no timeout.
- **Orchestration lives below the surface.** Pinging, reacting, fetch→triage→fix→re-request→merge is a **bus consumer** in M2–M6 / runner territory — not the M7 surface.
- **Cortex (M7) only notifies.** It renders "Echo is reviewing #N…" → "review done: changes-requested" as the events flow. A window onto the process, never the driver. *(The review-sink shipped in v3.1.0 already does this rendering.)*
- **The verdict rides the event.** In an event-driven loop the completion *event* IS the decision input — the reactor acts on `verdict.kind`. So the cortex#237 **verdict block is load-bearing**, not optional. Polling GitHub (`pilot fetch`) is the *fallback*, not the design.

These are the same layering principles as *dispatch-not-dictate* (capability/intent at the center, competence at the edge) and *deterministic-surface-formatting* (bots read structure off the bus; surfaces render), applied to *time*: the surface renders events, it does not wait.

## 3. Current state (what exists vs what's missing)

| Piece | State |
|---|---|
| `tasks.code-review.*` request envelope + `response_routing` | ✅ v3.1.0 |
| review-consumer: spawns reviewer, emits `dispatch.task.*` + `review.verdict.*` | ✅ v3.1.0 (verdict block **not yet emitted** by the dispatched session) |
| review-sink: renders lifecycle/verdict to the originating thread (notification surface) | ✅ v3.1.0 |
| Reviewer posts the review to GitHub | ✅ v3.1.0 (dispatch-intent fix, #507) |
| `pilot request-review --wait` (blocking, timeout-bounded) | ⚠️ works, but the anti-pattern this design replaces |
| **Verdict block on the event** (structured `verdict.kind` on `review.verdict.*`) | ❌ missing — reviewer posts to GitHub but doesn't emit the cortex#237 block, so the event resolves `commented` |
| **Event-driven loop reactor** (persistent consumer that drives the cycle) | ❌ missing — this design |

## 4. Design

### 4.1 The event model (already on the bus)

The reactor subscribes to the existing lifecycle/verdict subjects (correlation_id-joined to the originating request):

- `local.{principal}.{stack}.review.verdict.{approved|changes-requested|commented}` — the decision event.
- `local.{principal}.{stack}.dispatch.task.{started|completed|failed|aborted}` — progress + terminal lifecycle.

No new subjects. The reactor keys every event by `correlation_id` (≡ the originating review-request envelope id).

### 4.2 The reactor

A **persistent bus consumer** (durable JetStream consumer, so it survives restarts and replays unacked events — never a blocking in-memory wait):

```
on review.verdict.<kind> (correlation = C):
  approved          → merge PR (CI-gated) → file follow-ups → close errand C
  changes-requested → fetch findings → triage → apply small / defer big
                      → re-push → re-request review → errand C stays open (next cycle)
  commented         → no autonomous gate: render to surface, await the principal
on dispatch.task.failed (correlation = C):
  surface the typed reason (cant_do / not_now / policy_denied …) → escalate or retry per kind
on dispatch.task.started:
  (surface only — review-sink already renders "reviewing…")
```

Key properties:
- **No timeout.** A review that takes hours just means the `verdict` event arrives hours later; the durable consumer is still subscribed. Errand state (per `correlation_id`) persists in the reactor's store between events.
- **Idempotent per (correlation_id, event.id).** Replays/duplicate deliveries don't double-act (mirrors the review-sink's `seenIds` guard).
- **Bounded cycles.** Errand state tracks cycle count; cap re-request loops (e.g. 3) then escalate, per the existing pilot-review-loop discipline.

### 4.3 Where it lives — decision

The orchestration must be **below the M7 surface**. Two candidate homes:

- **(A) pilot as an event-driven daemon.** pilot already owns the loop verbs (`fetch`/`triage`/`apply`/`request-review`) and the verdict subscription (`subscribe-verdict.ts`). Make it a long-lived consumer rather than a one-shot blocking CLI: `pilot watch` subscribes to `review.verdict.*` and drives the cycle. **Recommended** — least new surface, keeps the loop logic where it already is.
- **(B) a cortex-side reactor.** A new consumer in cortex/runner. Rejected for v1: it would pull pilot's loop logic (triage/apply) into cortex, blurring the surface/orchestrator split and duplicating pilot.

**Recommendation: (A).** pilot becomes the event-driven loop reactor (a daemon/`watch` mode); cortex stays the M7 surface (review-sink renders); the bus carries the events. `pilot request-review --wait` is retained only as a thin convenience for one-shot/interactive use — the autonomous loop never uses it.

### 4.4 Verdict block on the event (prerequisite)

The reactor decides on `verdict.kind`. Today the dispatched reviewer (Echo) posts to GitHub but does **not** emit the cortex#237 fenced JSON verdict block, so `review.verdict.*` resolves `commented` and the autonomous gate can't fire. This design **depends on** closing that: the reviewing agent, when run in a cortex capability-dispatch (non-interactive), must emit the verdict block as the final fenced block — **after** the `gh pr review` submission (per the CodeReview skill's cortex#237 section). This is an **edge/Echo-side** change (persona/skill ensuring the block is emitted non-interactively), not a cortex prompt change — consistent with *dispatch-not-dictate*.

Fallback (degraded, non-autonomous): if no block is present, the reactor MAY read the GitHub review state via `pilot fetch` (reviewDecision) to recover the decision — but that is the fallback, not the path.

### 4.5 State ownership — who holds the loop state (decision)

**State ownership follows the driver, and the durable state-of-record is always pilot's errand store — never the M7 surface (cortex) and never the bus.**

- **The bus is stateless.** Events are joined only by `correlation_id`; `subscribe-completed.ts` is explicit — *"No persistence."* The bus carries the decision, it does not remember it.
- **cortex (M7) is stateless w.r.t. the loop.** The review-sink renders lifecycle/verdict events to the originating thread and forgets them. `response_routing` rides the envelope (wire-level, per CONTEXT.md §Response routing), so the surface holds no in-memory cycle state.
- **pilot owns the durable errand.** pilot already has the persistence layer this design needs: `src/persistence/db.ts` (`errandId`, `findErrandsByPr`, `getErrand`) + `AgentStateStore` (`src/persistence/agent-state.ts`) persist a per-PR **errand** — cycle count, findings, status (`paused`/`blocked`), last-ping — across runs, resolvable from a verdict event by `correlation_id`/PR. `resume <FEATURE_ID>` + `replay` give crash-recovery. **No new store is required.**

This yields two driver modes, and the *driver* determines who is responsible:

| Driver | State-of-record | Lifetime | Use |
|---|---|---|---|
| **In-session (free-flowy)** — a CC session running the loop verbs ad-hoc | the **session's context** holds the working/orchestration state; pilot's errand DB is a durable *side-record* | ephemeral — when the session ends the loop stops (errand frozen, resumable) | one-shot / interactive ("review this PR now") |
| **pilot agent (persistent reactor)** — `pilot watch` per §4.3(A) | the **errand store** (`AgentStateStore`) is authoritative, keyed by `correlation_id`; the agent reacts to events and updates it | durable — survives long tasks, restarts, replay (`resume`/`replay`) | the autonomous event-driven loop |

The event-driven loop **requires the persistent-agent mode**: because there is no blocking wait, state must persist *between* events — a verdict arriving hours later means the pilot agent loads the errand by `correlation_id` and reacts. A transient session cannot hold state across a process exit, so it is the lighter alternative for one-shots, not the autonomous path. This is *dispatch-not-dictate* applied to **state**: the responsible agent holds its own state at its own layer; the surface above and the bus below stay stateless.

## 5. End-to-end flow

```
Luna (CC dev session) → publish tasks.code-review.<flavor> {response_routing} → returns immediately
   review-consumer → spawn Echo (non-interactive) → dispatch.task.started ──→ review-sink renders "Echo reviewing #N…"
   Echo → gh pr review (posts to GitHub) → emit verdict block
   review-consumer → review.verdict.<kind> {presentation, response_routing} ──→ review-sink renders the outcome
        └──────────────→ pilot reactor wakes on review.verdict.<kind> (correlation C)
                          ├─ approved → merge (CI-gated) → next feature
                          ├─ changes-requested → fetch → triage → fix → re-push → re-request (cycle)
                          └─ commented → surface, await the principal
```
No step blocks. Each arrow is an event. The surface (review-sink) renders at every lifecycle transition.

## 6. Open questions / decisions

1. ~~**Errand-state store for the reactor**~~ — **RESOLVED (§4.5).** The reactor uses pilot's existing errand store (`persistence/db.ts` + `AgentStateStore`), keyed by `correlation_id`/PR, with `resume`/`replay` for crash-recovery — no new store. State ownership follows the driver: session-transient (context-held) vs agent-persistent (errand-store-held); the autonomous loop is the persistent-agent mode.
2. **Trigger for the *next* PR** — when a feature merges, what enqueues the next? (blueprint-driven `pilot tick` already exists; wire it to the reactor.)
3. **Cross-stack / federation** — the reactor subscribes per stack; multi-stack (work/halden) each run their own reactor or one reactor filters by stack segment.
4. **Backpressure / `not_now`** — honor the typed `dispatch.task.failed` retry hints.
5. **Verdict-block emission** — exact mechanism for guaranteeing Echo emits the block non-interactively (persona line vs skill-enforced vs a dispatch flag).

## 7. Phasing

1. **P1 — verdict block on the event.** Echo emits the cortex#237 block non-interactively; `review.verdict.<kind>` carries a real `kind`. (Unblocks everything; testable against `skill-verdict-block.contract.test.ts`.)
2. **P2 — pilot `watch` reactor.** Durable consumer on `review.verdict.*` + `dispatch.task.{completed,failed}`; drives approved→merge / changes-requested→fix-cycle / commented→surface; idempotent + bounded cycles. Retire `--wait` from the autonomous path.
3. **P3 — next-PR trigger.** Wire blueprint/`tick` so a merge enqueues the next feature; the loop runs unattended.
4. **P4 — multi-stack + federation hardening.**

## 8. Acceptance

- A review request returns immediately; no `--wait`/timeout in the autonomous path.
- A review that takes >30m still closes the loop (no lost verdict).
- On `changes-requested`, the reactor fixes/defers + re-requests with no human in the loop; on `approved`, it merges (CI-gated).
- cortex renders only notifications (reviewing → outcome); all orchestration is in pilot/the bus.
- Reactor is idempotent under event replay and bounded in cycles.
