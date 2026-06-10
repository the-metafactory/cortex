# Agent Network Topology

**Status:** grounded — reconciled to [ADR-0007](adr/0007-agent-presence-protocol.md)
**Umbrella:** G-1114 (issue #355)
**Owners:** Andreas + Soma
**Scope:** Bus-driven agent **presence** (announce / heartbeat / offline /
capabilities-changed) on the reserved `agent` domain, a consumer-side runtime
registry, two-transport cross-stack propagation, and the Mission Control
"Network" view that renders the resulting topology.

> **Reconciliation note.** This design predates several settled decisions and
> was reconciled to [ADR-0007](adr/0007-agent-presence-protocol.md) during the
> G-1114 grilling session (2026-06-10). The pre-grill draft used `{org}`,
> `system.agent.*` envelope types, a `public.metafactory.agent.*` /
> network-as-namespace framing, and treated presence and dispatch liveness as
> one thing. **ADR-0007 is authoritative; this document is the reconciled
> design.** Where this doc and ADR-0007 disagree, ADR-0007 wins.

## 1. Purpose

A cortex stack today knows which agents are *configured* (from the stack
config) and which capabilities they declared at boot (one-shot
`agents.capabilities.registered` envelopes). It does **not** know:

- which configured agents are actually running right now,
- when an agent joined or left the network,
- which agents exist on *other* stacks reachable via NATS leaf federation,
- whether a "supposed to be there" agent has gone quiet.

This document specifies the **agent-presence protocol** + the consumer-side
runtime registry + the Mission Control surface that makes the network of agents
observable and reasoned-about as a first-class concept.

The principal should be able to open Mission Control, see the agents present
across the network they are part of, click an agent, see its capabilities, and
see whether it is reachable — **without** ever seeing a peer's session interior.

## 2. Core concept — agent presence

**Agent presence** (CONTEXT.md term, resolved 2026-06-10) is *whether an agent
process is up and consuming the bus — independent of any dispatch*. An idle
agent has presence; it is not running a dispatch.

Presence is carried on the reserved **`agent` domain** — the first concrete use
of CONTEXT.md's reserved domain segment. Four actions:

| Action | Meaning |
|---|---|
| `agent.online` | Emitted once on agent boot. Carries the full presence descriptor (identity, scope, **initial capability set**, started-at). |
| `agent.heartbeat` | Emitted on a fixed interval while the agent is up (idle or not). Liveness only. |
| `agent.offline` | Emitted on graceful shutdown / restart / announced error. |
| `agent.capabilities-changed` | Emitted when the advertised capability set changes mid-life. Carries the full new steady state. |

### 2.1 Presence is NOT dispatch liveness (ADR-0007 §1)

Presence is **distinct from `system.agent.heartbeat`** (cortex#361), which is
**dispatch-scoped** liveness — fired only *while a dispatch is in flight*, keyed
by `correlation_id` ("this task is still progressing"). Two differently-scoped
heartbeats by design:

- `agent.heartbeat` answers *is this agent alive?*
- `system.agent.heartbeat` answers *is this task progressing?*

An idle agent emits the former, **never** the latter. The two never merge; the
`agent`-domain presence heartbeat carries no `correlation_id`/`phase`, and the
dispatch heartbeat stays exactly as cortex#361 shipped it.

## 3. Subject grammar

All subjects follow the canonical
`{scope}.{principal}.{stack}.{domain}.{entity}.{action}` grammar (CONTEXT.md;
[ADR-0001](adr/0001-federated-subject-grammar.md)). For presence, `{domain}` is
`agent`. The domain segment is the leading segment of `envelope.type`, so
myelin's `deriveSubject` (cortex's `deriveNatsSubject`) builds the subject from
the type with no new helper.

### 3.1 Stack-local subjects

```
local.{principal}.{stack}.agent.online
local.{principal}.{stack}.agent.heartbeat
local.{principal}.{stack}.agent.offline
local.{principal}.{stack}.agent.capabilities-changed
```

The second segment is the **principal**, not an org — CONTEXT.md is authoritative
(the `{org}→{principal}` vocabulary migration). The agent's own logical id
(`luna`, `echo`, …) and NKey ride the **payload**, not a subject segment.

### 3.2 Federation subjects

```
federated.{principal}.{stack}.agent.online
federated.{principal}.{stack}.agent.heartbeat
federated.{principal}.{stack}.agent.offline
federated.{principal}.{stack}.agent.capabilities-changed
```

**Identical identity segments — only the scope prefix differs**
([ADR-0001](adr/0001-federated-subject-grammar.md)). The federated subject
carries `{principal}.{stack}`, preserving provenance
(`federated.andreas.work.agent.online` is unambiguously from `andreas/work`).
The **network is NEVER a subject segment**: a stack can be re-homed to a
different network without changing its subjects. The target network is resolved
from the principal via deployment topology (`policy.federated.networks[].peers[]`),
not read off the wire.

### 3.3 Network membership = registry roster, not a wire token (ADR-0007 §2)

The pre-grill draft framed "network" as a subject namespace
(`public.metafactory.agent.*`). **That framing is dropped.** Network membership
is grouped by the **registry roster** ([ADR-0003](adr/0003-network-join-control-plane.md)):
the registry (`network.meta-factory.ai`) is the pinned, signature-verified
source of truth for `principal → pubkey` and per-network rosters. The Network
view groups peer agents by which network's roster they appear in — resolved from
identity + topology, never from a network name on a subject.

### 3.4 Public scope — deferred

`public.*` agent presence (ecosystem-wide discovery) is **out of scope for
G-1114** and deferred to a candidate **G-1115** umbrella. G-1114 ships
stack-local + federated only.

## 4. Two transports, one envelope (ADR-0007 §2)

The same `agent.*` presence envelope feeds two surfaces:

1. **Local Network view via bus federation (G-1114.E).** A stack subscribes to
   peers' `federated.{principal}.{stack}.agent.*` over the NATS leaf —
   real-time, peer-to-peer, gated by the existing federation accept-list
   (`accept_subjects: federated.{my-principal}.{my-stack}.>`). This feeds the
   stack's own locally-served Network pane.
2. **Hosted pane via registry-anchored push
   ([ADR-0006](adr/0006-network-view-feed-registry-anchored.md)).** Each member
   stack pushes only its **own-slice** presence metadata to the Mission Control
   Worker/D1 (meta-factory.ai), NKey-signed, verified against the registry
   roster. Peers' federated envelopes arriving at a stack are not that stack's
   to upload — sovereignty stays with the originator.

These compose: bus federation is the local half, ADR-0006 is the hosted half.
Both carry the identical `agent.*` envelope; they differ only in transport and
in who is allowed to relay what.

## 5. Capability model (ADR-0007 §3)

`agent.online` carries the **initial** capability set; `agent.capabilities-changed`
carries the **full new steady state** on each change (not a diff — a subscriber
that missed an earlier delta still converges). Together they **supersede** the
observability-only boot-time `agents.capabilities.registered` envelope, via a
**dual-emit deprecation window** then retirement.

**Capability dispatch (cortex#237) is untouched.** Offer-mode dispatch routes on
the `tasks.{capability}` subject via JetStream consumer filters — it does **not**
do a registry lookup. So folding the capability-announce envelope into presence
changes nothing about routing; the registered envelope was observability-only.

## 6. Envelope payloads

The cortex-side payload shapes are defined as **inert types** in
`src/bus/agent-network/envelopes.ts` (G-1114.A — defined, exported, unit-tested,
but no producer/subscriber yet). Each payload rides `envelope.payload`, which the
myelin envelope schema leaves unconstrained ("Structure is domain-specific");
the cortex schemas are the domain-specific contract.

Each payload carries an `identity` block (`nkey_public_key`, `agent_id`,
`assistant_name | null`) and a `scope` block (`principal`, `stack`):

- **`agent.online`** — `identity`, `scope`, `capabilities[]` (initial), `started_at`.
- **`agent.heartbeat`** — `identity`, `scope`, `sent_at`. Liveness only.
- **`agent.offline`** — `identity`, `scope`, `reason` (`shutdown|restart|error`),
  optional `detail`, `sent_at`.
- **`agent.capabilities-changed`** — `identity`, `scope`, `capabilities[]`
  (full new set), `sent_at`.

All envelopes are signed through the normal stack-signing path; identity is
attested by the envelope's `signed_by[]` chain.

## 7. Liveness FSM

A consumer-side registry runs a small state machine per observed agent:

```
              online ──(graceful agent.offline, OR no heartbeat within TTL)──▶ offline
                 ▲                                                                │
                 └────────────────(agent.heartbeat / agent.online again)─────────┘
```

- **TTL = 5 minutes.** A record is `online` while `agent.heartbeat` (or
  `agent.online`) arrives within the TTL; it transitions to `offline` on a
  graceful `agent.offline` **or** on TTL lapse.
- The FSM consumes the **new `agent.heartbeat`**, NOT `system.agent.heartbeat`
  (ADR-0007 — the dispatch heartbeat is not a presence signal).
- Offline agents stay in the registry rendered as muted with a last-seen
  timestamp; they don't vanish.

## 8. Peer visibility — presence + dispatch lifecycle, never interiors (ADR-0007 §4)

In the Network view, clicking a **peer principal's** agent reveals:

- identity (`@assistant` on `{stack}`),
- online / idle / offline state,
- declared capabilities,
- any federated `dispatch.task.*` lifecycle (received / dispatched / started /
  completed / failed / aborted).

It does **NOT** reveal tool calls, prompts, or diffs. This is the direct
consequence of [ADR-0005](adr/0005-mission-control-integration-architecture.md):
session interiors are `local`-scope and never federate. The boundary is enforced
by **what is on the wire** — not a UI check. Drilling into your **own** agent
still opens the full interior (local).

## 9. Runtime registry

A cortex-side subscriber maintains a single observable store keyed by NKey:

- Subscribes to `local.{principal}.{stack}.agent.>` (always; G-1114.B).
- Subscribes to `federated.{principal}.{stack}.agent.>` per federation policy
  (G-1114.E).
- For each envelope: `online` upserts + sets `online`; `heartbeat` refreshes
  last-seen; `capabilities-changed` replaces the capability set; `offline` sets
  `offline`. A reaper applies the 5-min TTL lapse.

The registry is the source of truth for the Network view and (later) for
principal-driven direct dispatch affordances. It does **not** change the
capability-dispatch path.

## 10. UI — Mission Control "Network" view

A "Network" tab in `src/surface/mc/dashboard-v2/`. G-1114.A lands an inert
**"Network (preview)"** placeholder; G-1114.B replaces it with the real
stack-local agents panel; G-1114.D replaces that with the graph render (React
Flow + ELK, lifting Strata's UI primitives). Detail panel, filters, and
spotlight search land with the graph.

## 11. Relation to existing cortex / myelin

- **Adds** the `agent` domain's presence subjects + payload types. The
  agent-lifecycle subjects are cortex M7 territory per `myelin/specs/namespace.md`;
  a follow-up myelin PR may codify the `agent` domain in the namespace spec for
  ecosystem consistency (not blocking).
- **Supersedes** the boot-time `agents.capabilities.registered` per-pair emission
  (dual-emit window, then retire).
- **Does not change** the cortex#237 capability-dispatch path, nor the cortex#361
  dispatch heartbeat.

## 12. Phases

| Phase | What the principal sees |
|---|---|
| A — Grounding (this slice) | Design + plan reconciled on `main`; inert `agent.*` payload types in the codebase; a "Network (preview)" placeholder tab. **Zero runtime change.** |
| B — Local producer + subscriber | The preview tab becomes a real stack-local agents panel; agents pop up on boot, drop off after 5 min of silence (or instantly on graceful offline). |
| C — Capabilities delta + liveness FSM | Live capability badges; offline agents render muted with last-seen. |
| D — Network view (stack-local) | The graph render (React Flow + ELK); click for a detail panel; filters + spotlight. |
| E — Federation | The view extends to federated peer stacks via the bus-federation transport; foreign agents render with `{principal}/{stack}` provenance. The hosted half is ADR-0006. |
| F — Capability-routing UX | Hover a task → matching agents highlight; right-click an agent → "dispatch direct." |

Public scope (`public.*` presence) is deferred to candidate G-1115.

## 13. Open questions (resolved decisions are in the ADRs)

Settled by ADR-0007: domain (`agent`, distinct from dispatch), subject grammar
(`{principal}`, never `{org}`/network), supersession of
`agents.capabilities.registered`, peer-visibility boundary, the 5-min TTL FSM,
public-scope deferral. Remaining, deferred to the phase that needs each:

1. Federation default — opt-in (safe) vs opt-out. → resolved at E.
2. Subject re-publish mechanism — cortex republisher vs NATS leaf-node policy. → E.
3. `AgentDescriptor` payload size limits. → B.
4. Recent-work edge source for the graph — bounded tail vs dedicated envelope. → D.
5. Principal annotations (pin / mute) persistence — local MC DB. → D.
6. Soma assistant grouping in the graph (one assistant, many hosting agents). → D.
