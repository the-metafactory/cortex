# ADR 0021 — Outbound sink shape: the DispatchSink / ReviewSink twins stand

**Status:** accepted (2026-07-05) · **Refs:** epic #1514 (architecture-deepening, candidate 8 "Speculative"), plan slice S10 (`docs/plan-architecture-deepening.md`), issue #1524, `src/adapters/dispatch-sink.ts`, `src/adapters/review-sink.ts`, `src/adapters/response-routing-delivery.ts`

## Context

cortex has two bus-side outbound sinks with **structurally identical** public interfaces — both expose `readonly subjects: readonly string[]`, `start(): Promise<void>`, and `stop(): Promise<void>`. Both subscribe to `classification: "local"` subjects, enforce the single-delivery invariant (exactly one `onEnvelope` handler; the `adapter_instance` filter is the sole delivery gate), and render envelopes to a surface. They diverge only in two places:

- **Subjects.** `DispatchSink` subscribes `local.{principal}[.{stack}].dispatch.task.>` (lifecycle only). `ReviewSink` subscribes that **plus** `…review.verdict.>` and `…system.attention.>`.
- **Rendering.** Dispatch renders `formatDispatchLifecycle`; review renders `formatReviewVerdict` (+ a requester ping); attention items render their deterministic `presentation` verbatim.

Crucially, the **routing-resolution layer is already shared**: `response-routing-delivery.ts` exports the wire routing shapes (`WireResponseRouting` — the snowflake `adapter_instance` + `channel_id`/`thread_id`; `WireLogicalRouting` — the logical triple) and the read helpers `readResponseRouting` / `readLogicalRouting` / `dispatchCorrelationKey`, imported by BOTH sinks. That is the meaningful, error-prone logic (staying in lock-step with the publish side's subject derivation and the response-routing contract) — and it is **not** duplicated.

The 2026-07-04 architecture review flagged the twins (candidate 8) and proposed collapsing them onto one `OutboundSink` + a pluggable **target-resolver** (snowflake routing vs logical triple). The review itself rated this **Speculative**.

## Decision

**Do not collapse. The two sinks stand as separate types.**

Collapse onto a single `OutboundSink` + pluggable target-resolver **only when a third sink variant is actually planned** — at which point the third variant reveals the real axis of variation and the resolver seam can be designed against three data points instead of two.

## Rationale

- The **shared logic is already factored out** (`response-routing-delivery.ts`). What remains duplicated is a ~15-line interface plus a thin subscribe/`onEnvelope`/drain lifecycle shell — low-cost, low-risk duplication.
- The two sinks differ precisely in the two dimensions a premature `OutboundSink` abstraction would have to parameterise anyway (subject set + rendering). Unifying them now would trade two small honest concrete types for one type carrying two branches behind a resolver — more indirection, not less.
- **Two is not enough signal to design the right seam.** A "pluggable target-resolver" designed against exactly the snowflake and logical-triple cases risks fitting today's two shapes rather than the general one. A concrete third variant is the earliest point where the abstraction pays for itself.

## Consequences

- The `DispatchSink` / `ReviewSink` twin interfaces remain duplicated by design. This is accepted.
- **This ADR is the standing answer to the "collapse the sinks" proposal.** Future architecture reviews should not re-raise candidate 8 absent a concrete, planned third sink variant — cite this ADR instead.
- **When a third variant does appear:** model the collapse on the lib/ports/adapters discipline used for the CLI subcommands (see slice S5, `network-*-{lib,ports,adapters}.ts`). The routing-resolution step (snowflake `adapter_instance` vs logical triple) is the natural adapter/target-resolver seam; the already-shared `response-routing-delivery.ts` is where that resolver would live.
