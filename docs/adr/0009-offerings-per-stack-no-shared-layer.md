# ADR-0009: Offerings are per-stack runtime policy; no shared `offerings/` config layer

**Status:** Accepted
**Date:** 2026-06-11
**Context refs:** ADR-0008 (capability offering & scope) · ADR-0003 (network-join control plane) · CONTEXT.md §Capability offering / §Scope / §Network · `docs/design-capability-offering.md` · config-split layout (`docs/config-layout/`)

## Context

A **capability offering** (ADR-0008) is the per-stack policy `(capability, offer-scope, accept-policy)`. The config-split already has a **shared** `network/*.yaml` layer (above the per-stack `stacks/*.yaml`). The natural question: should fleet-wide offering intent ("offer `chat` across all my stacks") live in a similar **shared `offerings/` layer** that the boot composer deep-merges?

The `network/` precedent is instructive but **does not transfer**. The `network/` layer is shared because a **network is a co-owned, externally-defined entity**: `cortex network create` stands up the network's topology row in the **network-registry** (the source of truth — ADR-0003 DD-2/DD-12); a stack *joins* by pulling the descriptor + roster from the registry; the local `network/` layer holds only the stack's **membership + registry pin** (`policy.federated.{registry, networks[]}`). A shared layer is the right home for *membership of a co-owned entity* — you want one trusted registry across stacks, not per-stack divergence (DD-11 fail-closes on mismatch).

An **offering is not an entity.** There is no registry row, no roster, nothing co-owned — nobody "joins" your offering. It is purely a per-stack policy: *what this stack exposes*. "Offer `chat` across my stacks" is not membership of a shared thing; it is the same per-stack policy applied to several stacks.

## Decision

1. **Offerings live self-contained in per-stack runtime config** (`stacks/<id>.yaml` → `policy.offerings[]`). Each stack fully describes what *it* offers. The runtime **never composes a fleet-wide offerings layer.**
2. **There is no shared `offerings/` config layer.** The `network/` shared layer is justified by a co-owned entity (the network); offerings have no such entity, so the precedent does not apply.
3. **Fleet-wide offering intent is a provisioning-tooling concern, not a runtime one.** The same control plane that stands up and configures stacks (`cortex stack`) and networks (`cortex network`) — with capability offering as the third leg — **expands** a fleet intent into each stack's own per-stack config when it provisions. The tool is the fleet manager; per-stack config is its output.

**The rule:** a shared config layer ⟺ membership of a co-owned entity. An offering is per-stack policy ⇒ it stays per-stack; the fleet view is tooling, not a config layer.

## Consequences

- No new config-split layer; the boot composer is unchanged. A stack's offerings are knowable from its own config alone (no cross-layer composition needed to answer "what does this stack offer").
- The fleet/IaC concern is handled at provisioning time by the tooling, which writes per-stack config — consistent with `cortex stack create` (scaffolds a stack) and `cortex network join` (writes the membership pin). `cortex offer` is the dry-run-by-default front-end that edits per-stack offerings + reconciles the projections (`announce_capabilities`/`accept_subjects`/registry).
- Per-stack sovereignty (CONTEXT.md §Scope: multiple stacks = multiple locals) is preserved end-to-end: each stack's exposure is its own, not inherited from a shared layer it might forget it's merging.

## Alternatives considered

- **A shared `offerings/` layer (fleet defaults + per-stack overrides), deep-merged at boot.** Rejected: it would make a stack's effective exposure depend on a composed layer (a stack could be widened by a shared default it isn't looking at — the opposite of the default-deny, per-stack-sovereign posture), and it mis-models an offering as a co-owned entity when it is a per-stack policy. The fleet need it was meant to serve is better met at provisioning time by the tooling.
