# The issue is the slice-grouping key for dev-loop activity convergence

Status: accepted (2026-06-19, slice-activity-thread grilling Q1)

## Context

The autonomous **dev-loop** runs several capability-workers per unit of work — the
**orchestrator** (the loop-driver role; instance-named per stack — `vega` on Andreas's stack,
named differently elsewhere) dispatches `dev.implement`; a worker claiming that capability
builds and opens a PR; a worker claiming `code-review` reviews; a worker claiming
`merge.approve` merges; with fix-iterations in between. The workers are **mutually anonymous**
— each responds purely to a capability and never names the orchestrator or each other; only
the orchestrator knows the slice and addresses the work. A principal watching the work wants
**all of that activity for one unit of work gathered in one place** (one Discord thread, one
Mission Control card) — the "watch it unfold" surface — rather than scattered across a
`#worklog` channel (today keyed by `session_id`), a separate review thread, and the MC
dashboard.

To gather a unit's activity we need a **grouping key**. The obvious candidate — `correlation_id` —
turns out to be the **wrong grain**:

- In `src/runner/dev-consumer.ts` every lifecycle emission sets `correlationId: envelope.id`
  (the inbound *request's* id — lines 365, 457, 652, 698, 726). So `correlation_id` joins
  **one dispatch's** lifecycle (the implement run, *or* the review run, *or* the merge run).
- A unit of work spans **multiple** dispatches — implement → review → merge, plus fixes —
  **each with its own `correlation_id`**. `correlation_id` therefore cannot group the whole
  unit.
- The `correlationChainId` in `src/runner/dev-session-store.ts` is *not* a unit id either — it is
  the implement-request correlation reused only to find the **warm CC session** for resume.

The unit that spans all those dispatches is the GitHub **issue** (the dev-loop "slice"): it
exists from the first dispatch, it is already in the `dev.implement` request payload
(`issue?: number`), and it is the natural logical thread address (`{repo}/issue/N`). See the
**Slice** entry in `CONTEXT.md`.

## Decision

**The GitHub issue is the slice-grouping key.** Every dispatch belonging to a slice
(implement, review, merge, fixes) carries the same logical **response routing**
`{ surface, channel, thread: "{repo}/issue/N" }`, and surfaces group a slice's activity by
that address. `correlation_id` is retained as the **per-dispatch (exchange) join** — it groups
one round-trip *within* a slice, so a renderer can show "the review run" as a coherent block
inside the slice thread.

Specifically:

- The **issue** is the slice anchor and the human-readable thread name (`{repo}/issue/N`),
  resolved to a real Discord thread by the adapter's existing `findOrCreateThreadByName` /
  `resolveLogicalTarget` path.
- The **PR** a slice produces is an *artifact reference*, not the anchor. When the
  implementing worker opens it, its number is linked into the slice thread; the full GitHub review stays
  PR-scoped (data plane), while the review **one-liner** routes to the slice's issue thread
  (control plane) — consistent with the existing control/data-plane rule.
- We do **not** introduce a new bus-native slice/errand id (the rejected alternative below).

## Consequences

**Positive**

- Reuses the logical-routing primitive that already exists (`WireLogicalRouting`,
  `review-sink`'s `resolveLogicalTarget`) — no new wire concept.
- The slice thread exists from the **first** dispatch, so the build phase has a home (a
  PR-anchored thread would be homeless until the PR is opened mid-slice).
- The key is human-meaningful and already present in the request payload.

**Negative / cost**

- Requires **propagating `response_routing` across the implement → review → merge dispatches**
  — `dev-consumer.ts` carries no `response_routing` today, and the orchestrator must stamp the
  issue address when it dispatches. This is additive work, specced separately.
- Leans on "the slice has a backing issue." **Trip-wire:** if slices without a backing issue
  become common (ad-hoc PRs with no issue), revisit the rejected alternative (a bus-native
  slice id). Chosen "for now" deliberately (2026-06-19).

## Alternatives considered

- **A bus-native slice / "errand" id**, minted by the orchestrator when it picks the slice and
  propagated as a new envelope field on every dispatch. A single surface-neutral machine key
  independent of GitHub. **Rejected for now** — heavier (new wire field, propagation contract,
  MC join changes) for no benefit while every slice has a backing issue; kept as the trip-wire
  escape hatch.
- **Anchor on the PR** (the original "thread per PR" instinct). **Rejected** — the PR does not
  exist until the implementing worker opens it mid-slice, so the dispatch + build phase (the densest
  "watch it unfold" activity) would have no thread until then.

## References

- `CONTEXT.md` → **Slice**, **Dispatch**, **Dispatch sink**
- `docs/design-slice-activity-thread.md` (the convergence spec)
- `src/runner/dev-consumer.ts`, `src/runner/dev-session-store.ts` (per-dispatch correlation)
- `src/adapters/response-routing-delivery.ts` (`WireLogicalRouting`), `src/adapters/review-sink.ts`
