# ADR 0022 — MC health + RTT: threshold values, null semantics, fold precedence

**Status:** accepted (2026-07-07) · **Refs:** `docs/plan-mc-future-state.md` §4.0 slice FND-4, §7 decision D-3, signal#155 (active RTT probing, DEFERRED)

## Context

Mission Control's tri-state HEALTH lane and edge/aggregate RTT rendering (Track B, `docs/plan-mc-future-state.md` §4.B) need a settled decision record before OBS-2/OBS-4 and FLG-11 can build against it. Today:

- `rtt_ms` is **nullable** and **single-vantage** (one observer's measurement, not a network-wide consensus value). Ad-hoc thresholds invented per call site invite false alarms — a stack that has simply never been measured must not read the same as a stack that failed to respond.
- The tri-state HEALTH fold (collector-health, transport verdict, presence) has no codified precedence. Without an explicit order, different call sites can fold the same three inputs into different displayed statuses for the same stack, which is exactly the kind of ad-hoc drift this mini-ADR exists to close off (plan §4.0 FND-4 rationale).
- There is standing pressure to make the RTT signal more assertive by actively probing for it (signal#155). That pressure must not leak into this decision — this ADR is about *display and fold semantics for an existing passive signal*, not about how the RTT number gets produced.

This ADR is the FND-4 deliverable: the mini-ADR the plan calls for, recording the straw-man decision made in plan §7 row D-3 verbatim so OBS-2/OBS-4 and FLG-11 have a single citable source instead of re-deriving thresholds ad hoc.

## Decision

**RTT thresholds:**

- **amber** ≥ 500 ms
- **red** ≥ 2000 ms

**Null semantics:**

- A **null** `rtt_ms` means the health status is **`unobserved`** — **never** `red`. A missing measurement is not a failure; folding null RTT into `red` would conflate "we haven't measured this" with "this stack is unreachable," which is a false alarm by construction.

**Health-fold precedence** (highest wins):

1. **collector-health**
2. **transport-verdict**
3. **presence**

When more than one of these three inputs disagrees about a stack's health, the fold resolves to whichever is highest in this list. `collector-health` (is the collector itself receiving envelopes) is the strongest signal because it is closest to ground truth; `transport-verdict` (federation-layer reachability) is next; bare `presence` (last-seen heartbeat) is the weakest and most easily stale.

## Non-goal

**Threshold pressure must not back into active RTT probing.** This ADR governs how an existing, passively-observed, single-vantage `rtt_ms` value is displayed and folded — it does not authorize or imply that MC should start actively probing peers to produce more or fresher RTT samples. That capability is signal#155, and it **stays DEFERRED**. If the thresholds above ever feel too coarse because the underlying signal is too sparse, the fix is to revisit signal#155 as its own decision — not to quietly grow active probing underneath this ADR.

## Rationale

- Fixed, documented thresholds (500 ms / 2000 ms) give every call site (cockpit header transport-verdict chip, D5 canvas edges, aggregate rollups) the same amber/red boundary instead of each inventing its own — the exact ad-hoc-thresholds risk the plan's FND-4 rationale calls out.
- Treating null as `unobserved` rather than `red` keeps the HEALTH lane honest: a stack MC has never measured reads differently from a stack MC measured and found unreachable. This is consistent with the plan's wider "honest absence, never a fabricated affordance" discipline (see CK-5, CK-8 in §4.A).
- A codified fold precedence (collector-health > transport-verdict > presence) removes a whole class of "which lane do I trust" bugs where two render sites disagree on the same underlying data.
- Explicitly fencing off signal#155 keeps this ADR's scope to display/fold semantics and prevents a plausible-sounding "we should just probe more" rationalization from silently expanding scope during OBS-2/OBS-4/FLG-11 implementation.

## Consequences

- OBS-2 (RTT threshold policy on edges/aggregates), OBS-4, and FLG-11 all cite this ADR for threshold values and null semantics instead of re-deciding them.
- Any render surface that folds collector-health, transport-verdict, and presence into a single HEALTH status MUST use the precedence order above; a call site that reorders it is a bug against this ADR, not a legitimate variant.
- Any future proposal to make RTT active (signal#155 or a successor) must be raised and decided as its own decision — this ADR is not authority for it, and must not be cited as if it were.
