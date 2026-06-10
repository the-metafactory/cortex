# Agent presence protocol (G-1114) — domain, transport, supersession, peer visibility

Status: accepted (2026-06-10, grill-with-docs session reconciling G-1114 against current CONTEXT.md + ADR-0003/0005/0006)

## Context

G-1114 (Agent Network Topology) adds cross-stack agent presence + a Mission Control Network view. Its design (`docs/design-agent-network-topology.md`) predates several settled decisions: the `{org}→{principal}` vocabulary migration, the rule that **network is not a subject segment** (CONTEXT.md; ADR-0001), the now-live in-process Mission Control pane, and ADR-0005/0006 (session-interior locality + the registry-anchored hosted feed). It also overlaps an existing dispatch heartbeat (`system.agent.heartbeat`, cortex#361) and an existing capability-announce envelope (`agents.capabilities.registered`). This ADR reconciles the protocol before any G-1114 code ships.

## Decision

1. **Agent presence rides the `agent` domain, distinct from dispatch liveness.** Presence is `agent.{online|heartbeat|offline|capabilities-changed}` on `local.{principal}.{stack}.agent.…` (the first concrete use of CONTEXT.md's reserved `agent` domain). It means "this agent process is up and consuming, idle or not." It is **separate from `system.agent.heartbeat`** (cortex#361), which stays as **dispatch-scoped** liveness (fires only while a dispatch is in flight, keyed by `correlation_id`). Two differently-scoped heartbeats by design — an idle agent emits `agent.heartbeat`, never `system.agent.heartbeat`. (Rejected: overloading `system.agent.*` for presence — it would leave the `agent` domain contradictory and conflate "agent alive" with "task progressing".)

2. **Cross-stack presence travels by two transports, one envelope.** The same `agent.*` presence envelope feeds two surfaces: (a) the **local** Network view via **bus federation** — a stack subscribes to peers' `federated.{principal}.{stack}.agent.*` over the NATS leaf (real-time, peer-to-peer, gated by the existing federation accept-list); (b) the **hosted** pane (meta-factory.ai) via the **ADR-0006 registry-anchored own-slice NKey-signed push** to the CF Worker/D1. G-1114.E is the bus-federation half; ADR-0006 is the hosted half. They compose. **Network membership groups agents by the registry roster (ADR-0003), never by a wire token** — the design's `public.metafactory.agent.*` / network-as-namespace framing is dropped (CONTEXT.md: a network name never goes on the wire; `federated.` is the scope prefix).

3. **`agent.online` + `agent.capabilities-changed` supersede `agents.capabilities.registered`.** The legacy boot-time capability-announce envelope has **zero routing consumers** — Offer-mode dispatch routes on the `tasks.{capability}` subject via JetStream consumer filters, not a registry lookup. So presence subsumes it (online carries the initial capability set; capabilities-changed carries deltas) with a dual-emit deprecation window, then retire. **Capability dispatch (cortex#237) is untouched** — the umbrella's "dispatch unchanged" and "registration superseded" are consistent precisely because the envelope is observability-only.

4. **Peer agents show presence + dispatch-lifecycle metadata only — never session interiors.** In the Network view, clicking a peer principal's agent reveals identity (`@assistant` on `{stack}`), online/idle/offline state, declared capabilities, and any federated `dispatch.task.*` lifecycle — but **not** tool calls, prompts, or diffs. This is the direct consequence of ADR-0005 (session interiors are `local`-scope and never federate); the boundary is enforced by what is on the wire, not a UI check. Drilling into your OWN agent still opens the full interior (local). (Rejected: a negotiable deeper-view consent model — adds a per-peer sharing-policy axis that doesn't exist yet and erodes the clean "interiors never federate" line; deferred.)

## Consequences

- G-1114's subject grammar is `local|federated.{principal}.{stack}.agent.{action}` throughout — every `{org}` in the design becomes `{principal}`; `public.*` agent presence stays deferred (candidate G-1115).
- The liveness FSM (online while heartbeats arrive within TTL → offline on graceful `offline` or TTL lapse) consumes the new `agent.heartbeat`, not `system.agent.heartbeat`.
- The G-1114 design + plan docs are updated to this reconciliation as part of Phase A (the grounding PR).
- CONTEXT.md gains the **Agent presence** term and the `agent`-domain clarification on the **Domain** entry.
