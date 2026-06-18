# ADR-0014: Agents are capability-authorized — workers carry `trust:[]`, coordinators self-name

**Status:** Accepted
**Date:** 2026-06-18
**Context refs:** ADR-0008 (capability offering & scope) · ADR-0009 (offerings per-stack) · CONTEXT.md §Identity&trust / §Capability offering / §Dispatch · compass `sops/federation-wire-protocol.md` · cortex#1133 (`docs/design-agent-bundle-distribution.md`) · cortex#1071 (offer folds `agents.d`) · pilot#173 (`PILOT_AGENT_NAME`) · dev-loop#4 · the-metafactory/yarrow (reference bot-pack)

## Context

To distribute a multi-agent bundle (the dev-loop: a coordinator + capability workers) via `arc install` onto **any** principal's stack, the agent configs must be **principal-agnostic** — the same fragments deploy unchanged for Andreas, JC, anyone.

The dev-loop bundle's worker fragments instead shipped `trust:[pilot,echo,luna]` / `trust:[pilot]` — hardcoding the **loop-driver's name**. This caused two failures:

1. **Boot FATAL.** `AgentRegistry.fromAgents` validates the trust closure: every `trust` id must be a registered agent. On a stack where `pilot` isn't registered (e.g. one renamed `vega`), boot aborts.
2. **A fake per-principal-naming problem.** It looked like the bundle had to be re-parameterized per principal (rename `pilot→vega` everywhere), when in fact the workers should never name the coordinator at all.

The root error is a **category confusion**: the agent `trust:[]` field is for Discord **peer-bot attribution** (which bot user-ids an agent-with-presence trusts in a channel). It was being used as **capability authorization** — which it is not.

The protocol already provides authorization, three layers, none of them a per-agent name list (CONTEXT.md §Identity&trust / §Capability offering; federation-wire-protocol SOP):

- **capability** — the consumer claims `tasks.{capability}` (Offer mode);
- **signed `originator`** — the requester's principal DID rides the envelope, the **stack** signs (M3); local dispatch is covered by **own-stack implicit trust**, federated by `peers[]` membership + the `signed_by` chain under `signing: enforce`;
- **capability offering** — `(capability, offer-scope, accept-policy)` (ADR-0008), default-deny ⇒ `local`-only, generating `accept_subjects` — *this* is "who may invoke."

The reference bot-pack, **yarrow**, ships `trust:[]` and is authorized purely by its capability. The dev-consumer authorizes on the **capability gate** and never reads `trust[]`.

## Decision

1. **Capability-worker agents carry `trust:[]`.** A worker declares a capability (and, per ADR-0008/0009, an offering in its stack config) and nothing else about who may invoke it. Authorization is the capability gate + signed `originator` + offering accept-policy + own-stack implicit trust. A non-empty `trust:[]` is reserved for agents with **Discord presence** that must attribute peer bots — never for capability authorization, and never to name a coordinator.

2. **The coordinator self-names; workers never reference it.** A loop-driver/orchestrator's identity is **per-principal configurable** (`PILOT_AGENT_NAME`, default preserving the engine name) and rides dispatches as `originator`. Because the workers don't name it, the same bundle deploys for every principal unchanged — Andreas's coordinator is `vega`, JC's is `pilot`, disambiguated on the wire by the principal segment, not by forking the bundle.

3. **The offering is the authorization layer for cross-principal exposure**, not a per-agent allow-list. Widening a worker's capability to `federated`/`public` is done by an offering (ADR-0008), surfaced to the offer control plane via `agents.d` folding (cortex#1071) — not by adding names to `trust:[]`.

## Consequences

- **Bundles are cleanly arc-distributable:** generic capability-workers + a self-naming coordinator, zero per-principal wiring.
- **No boot trust-closure FATAL** from coordinator renames — there is no coordinator name in worker config to resolve.
- **Authorization stays in the right layer** (capability + offering + wire identity), consistent with ADR-0008/0009 and the federation-wire-protocol SOP — not duplicated as a hand-maintained name list that drifts.
- **Migration:** dev-loop#4 set the dev-loop workers to `trust:[]`; the meta-factory deployment was cleaned the same way (the inert coordinator-attribution fragment removed). Any future bot-pack must follow yarrow's `trust:[]` shape unless it has Discord presence with real peer-bots to attribute.
