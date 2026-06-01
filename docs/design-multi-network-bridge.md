# Design — Multi-Network Bridges (IoAW Phase E)

**Status:** Draft
**Refs:** cortex#117 (IAW Phase E: Multi-network bridges + delegation) · cortex#110 (META — Internet of Agentic Work) · `docs/design-internet-of-agentic-work.md` §§3.4–3.6, §5 (Q4/Q7 lock-ins) · `docs/plan-internet-of-agentic-work.md` §6 (Phase E), §9.5 (multi-network runtime refactor)
**Author:** Architect (Serena Blackwood)
**Date:** 2026-06-01

---

## 0. The fundamental constraint

The core Phase E concept, verbatim from the IoAW vision script (`design-internet-of-agentic-work.md` §3.4):

> "Some stacks bridge between networks — your stack participates in two different collaborations, publishing certain capabilities to one network and different capabilities to the other."

The fundamental constraint is **transport multiplicity under a single trust root**. A cortex stack is one signing identity (`stack.nkey_pub`, one principal) but must hold **N independent NATS leaf-node links simultaneously**, each one a separate broadcast/routing domain, each with its own peer roster, accept/deny policy, and announced capability subset — and the boundaries between those links must be airtight. A bridge stack that leaks network A's capabilities or data into network B is not a bug; it is a trust violation that defeats the entire isolation premise of the federation model.

Everything below derives from that constraint. The good news, having read the code: **the config schema for this already exists** (`PolicyFederatedNetworkSchema`, `cortex-config.ts:1429`). Phase E is a *transport refactor of `MyelinRuntime`*, not a schema flip. cortex.yaml flipped exactly once already (Phase C); Phase E adds no flip (`plan-internet-of-agentic-work.md` §11.3 — "Phase E bump: minor — additive").

---

## 1. The model — one stack, N leaf-node links

### 1.1 What a "network" is (and what it is NOT)

Per `CONTEXT.md` (lines 19–23):

> **Network**: A federation of **principals** whose **stacks** interconnect at the NATS leaf-node layer … A network is **not a subject segment**: it is deployment topology. Cross-principal reach is the `federated.` **scope** prefix … A principal may belong to more than one network.

A network is topology, surfaced in policy as one entry in `policy.federated.networks[]`. The wire grammar for cross-principal traffic is `federated.{principal}.{stack}.{domain}.…` (`CONTEXT.md:73–80`). The network *id* DOES appear in cortex's federation subject grammar as `federated.{network_id}.…` — the `accept_subjects[]` cross-validation enforces the `federated.{network_id}.` prefix on every entry (`cortex-config.ts:1412–1417, 1465–1470`). The network is therefore a **policy + transport domain**, addressed on the wire by the `{network_id}` segment and carried by a dedicated leaf-node link.

> **NAME-COLLISION WARNING (load-bearing).** `src/bus/network-resolver.ts` already owns a `config.networks[]` concept — but that is the **legacy grove** sense: Discord guilds and Mattermost channels mapped to *cloud-publish targets* (`buildNetworkLookups`, `network-resolver.ts:25–45`; `NetworkConfig` carries `endpoint`/`apiKey`/`cfAccess*`). **These are NOT IoAW federation networks.** Phase E must not reuse `network-resolver.ts`'s tables for federation. See Open Question 2 — recommend renaming the legacy concept during the CFG split.

### 1.2 The bridge-stack picture (from §3.4)

```
                              ┌──────────────────┐
                              │  Network A       │
                              │  (research mesh) │
                              └────────▲─────────┘
                                       │ leaf-node A  (NatsLink A)
          ┌──────────────────┐        │              network A peer registry + policy slice
          │  bridge stack    │────────┘
          │  principal: andreas
          │  stack: andreas/research
          │  agents: luna, echo, sage
          │                  │────────┐
          └──────────────────┘        │ leaf-node B  (NatsLink B)
                                       │              network B peer registry + policy slice
                              ┌────────▼─────────┐
                              │  Network B       │
                              │  (JV mesh)       │
                              └──────────────────┘
```

One stack, one signing key, two **independent** memberships. The structural separation lives in the `leaf_node` reference (`design-internet-of-agentic-work.md:362`): "**A bridge stack has multiple `NatsLink`s simultaneously open**, one per leaf-node."

### 1.3 Q4 lock-in — capability scoping at the network boundary

Per Q4 (`design-internet-of-agentic-work.md:609–626`, locked 2026-05-13):

> *Use separate networks rather than one stack bridging two networks with per-peer capability scoping. Each network is its own subject namespace + policy domain. A "bridge stack" simply participates in network A AND network B (two independent network memberships, two separate cortex.yaml peer-registry entries).*

The granularity decision is **per-network, never per-peer**:

- Scoping happens at the **network boundary** — one `cortex.yaml` (→ `network.yaml` post-CFG) entry per network membership.
- Each network membership's `announce_capabilities[]` is *the subset of the stack's full `capabilities:` surface* published to that network (`design-internet-of-agentic-work.md:624` — "The Q2 stack-level capability schema declares the full capability surface; each network membership picks a subset to announce. No per-peer-within-network differentiation — networks ARE the granularity.").
- This is what makes the multi-link runtime *simpler* than the rejected per-peer model: there is no per-peer subject filtering inside a network; a whole network is one link, one policy slice.

---

## 2. The MyelinRuntime refactor — single-link → link pool

### 2.1 What exists today (read from `src/bus/myelin/runtime.ts`)

The current runtime is **structurally single-link**:

- `startMyelinRuntime(config, options)` opens exactly one `NatsLink` from `config.nats.url` (`runtime.ts:441–470`) and builds one `subscribers: MyelinSubscriber[]` array (`runtime.ts:472`).
- Publish is link-bound at closure-init: `signAndPublishOnSubject(envelope, subject)` (`runtime.ts:559–642`) captures the single `link`, signs via myelin's chain-aware `signEnvelope` (`runtime.ts:602`, import `@the-metafactory/myelin/identity` at `runtime.ts:32`), and calls `link.publish(subject, …)` (`runtime.ts:641`).
- `publishEnabled` (`runtime.ts:644`) derives the subject from `envelope.sovereignty.classification` via `deriveNatsSubject(envelope, stack)` — the A.3/A.5 work already supports `classification: "federated"` → `federated.{principal}.{stack}.{type}` (docblock `runtime.ts:62–84`). **So a single link already CAN emit `federated.*`** — what it cannot do is route different `federated.*` traffic out of *different physical links*.
- `publishOnSubjectEnabled` (`runtime.ts:693`) is the explicit-subject escape hatch (Direction A, cortex#409) used for `tasks.@{assistant}.{capability}`.
- `subscribePullEnabled` (`runtime.ts:707`) and `jetstreamManagerEnabled` (`runtime.ts:748`) are all bound to the single captured `link`.

The single `link` variable is the whole problem. Federated emission already works *to one link*; Phase E makes the link selectable per network.

### 2.2 The refactor — `Map<network_id, NatsLink>` link pool

Per `plan-internet-of-agentic-work.md` §E.1 (lines 426–433) and Phase E acceptance (461–466):

**Shape:**

- Keep the existing **local link** (`config.nats.url`) as today — the `local.{principal}.{stack}.>` domain is unchanged.
- For each *distinct* `leaf_node` in `policy.federated.networks[]`, open a dedicated `NatsLink` keyed by `network_id` (the `leaf_node` is the resolver key; the `network_id` is the routing key — see §3 on how a `leaf_node` name resolves to connection params).
- Each link owns **its own** `subscribers[]` set, its own JetStream manager cache, and its own publish/sign core. The existing `signAndPublishOnSubject` factory is reparameterised to close over a *specific* link rather than the module-singleton `link`.

**Link selection on publish:**

- `publish(envelope)` / `publishOnSubject(envelope, subject)` select the target link by reading the **scope + network segment** of the resolved subject:
  - `local.…` → the local link (the always-present base link).
  - `federated.{network_id}.…` → the pool link for `{network_id}`. Per §E.1.3 (`plan:430`): "a publish to `federated.research-collab.>` routes via the research-collab link; a publish to `federated.jv.>` routes via the JV link."
  - `public.…` → deferred (public mesh is out of scope, §3.5 / E.4.3).
- Selection is a pure function of the subject — no global mutable routing state, no per-message Map rebuild (mirror the `network-resolver.ts:48–77` cached-lookup discipline).

**Inbound source-network attribution (§E.1.4, `plan:431`):**

- Each link's subscriber tags delivered envelopes with the *delivering network_id*. The `EnvelopeHandler` signature is `(envelope, subject)` today (`runtime.ts:40`); Phase E extends it (additively) to `(envelope, subject, sourceNetwork?)` so the surface-router gates against the correct network's `accept_subjects` / `deny_subjects` slice. Defence-in-depth: assert the subject's `{network_id}` segment equals the delivering link's `network_id` (anti-spoofing — see Open Question 5).

**Lifecycle (§E.1.2, `plan:429`):**

- Per-link connect / drain / reconnect. `NatsLink` already defers reconnect to nats.js (`connection.ts:118` `reconnect: true`). `stop()` drains every link's subscribers then closes every link (extend the existing `Promise.allSettled` drain at `runtime.ts:765`).
- **Boot degradation:** the current runtime treats "all push subscribers failed" as a hard disabled-return (`runtime.ts:513–525`). With N links this becomes per-link: one network's leaf-node being down at boot must NOT take the whole daemon down — boot degraded, emit a `system.error` per dead link, retry in background. (Confirm — Open Question 4; this changes the boot contract.)

### 2.3 Interface impact

`MyelinRuntime` (`runtime.ts:43–172`) stays the single public handle. The pool is *internal*; callers still see `publish` / `publishOnSubject` / `subscribePull` / `jetstreamManager` / `onEnvelope` / `stop`. The additive, optional-property discipline already established for `publishOnSubject?` / `subscribePull?` / `jetstreamManager?` (so fake-runtime test stubs stay byte-identical, per the cortex#290 additivity constraint, `runtime.ts:121,147,169`) is preserved — Phase E adds no *required* surface, only widens internal routing and the optional `sourceNetwork` handler arg.

---

## 3. Config shape — `policy.federated.networks[].leaf_node`

### 3.1 The schema already ships (read from `src/common/types/cortex-config.ts`)

`PolicyFederatedNetworkSchema` (`cortex-config.ts:1429–1514`) already carries every field Phase E consumes:

| Field | Type / constraint | Phase E role |
|---|---|---|
| `id` | letter-prefix id (`:1436`) | `{network_id}` subject segment + pool key |
| `leaf_node` | letter-prefix id (`:1447`) — a **named reference**, NOT a URL | resolves to a `NatsLink` connection |
| `peers[]` | `PolicyFederatedPeerSchema[]` (`:1457`) | per-network trust closure (`{operator_id, stack_id, operator_pubkey}`) |
| `accept_subjects[]` | NATS subject patterns, `federated.{id}.` prefix enforced (`:1465`) | per-network inbound gate |
| `deny_subjects[]` | NATS subject patterns (`:1477`) | per-network deny override |
| `announce_capabilities[]` | `<domain>.<entity>` ids (`:1491`) | the per-network capability subset (Q4) |
| `max_hop` | int ≥ 0, **required, no default** (`:1513`) | per-network hop budget |

`PolicyFederatedSchema` (`cortex-config.ts:1582`) wraps `networks: PolicyFederatedNetworkSchema[]` + optional `registry`. The Phase D registry block (`PolicyFederatedRegistrySchema`, `:1543`) and per-peer schema (`PolicyFederatedPeerSchema`, `:1359`) are already in place. **Conclusion: Phase E adds no new config schema** — the schema docblocks even pre-announce this (`:1422–1427` — "Multi-link transport (one MyelinRuntime per network) lands in Phase E; Phase D operates one network's leaf-node at a time, named via `leaf_node`").

### 3.2 The one missing piece — `leaf_node` → connection resolution

`leaf_node` is a *named* reference (`cortex-config.ts:1441–1450`: "Reference to a named NATS leaf-node connection … In Phase D only one leaf-node is operable concurrently; the field exists for forward compat with Phase E's multi-link MyelinRuntime"). There is **no schema today** mapping that name to a URL / creds / token. Phase E must add a *connection table*:

```yaml
# network.yaml (CFG layered config — see §3.3)
leaf_nodes:
  nats-leaf-research:
    url: nats://research-mesh.example:4222
    creds_path: ~/.config/cortex/creds/research.creds   # chmod 600, NatsLink loader (connection.ts)
  nats-leaf-jv:
    url: nats://jv-mesh.example:4222
    creds_path: ~/.config/cortex/creds/jv.creds

policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research          # → resolves to leaf_nodes[nats-leaf-research]
        peers:
          - principal_id: jcfischer
            stack_id: jcfischer/sage-host
            operator_pubkey: U_JC_…
        accept_subjects: ["federated.research-collab.tasks.code-review.*"]
        announce_capabilities: ["code-review", "security-scan"]
        max_hop: 1
      - id: jv-acme-bigcorp
        leaf_node: nats-leaf-jv
        peers:
          - { operator_id: acme,    stack_id: acme/deploy-host,     operator_pubkey: U_ACME_… }
          - { operator_id: bigcorp, stack_id: bigcorp/release-host, operator_pubkey: U_BIGCORP_… }
        accept_subjects: ["federated.jv-acme-bigcorp.tasks.deploy.*"]
        announce_capabilities: ["deploy", "release"]
        max_hop: 0
```

This strawman matches §3.4's worked example (`design-internet-of-agentic-work.md:330–360`) verbatim except for the new `leaf_nodes:` resolution block, which is the genuinely new schema (Open Question 1 — exact block name + home layer needs principal sign-off). `NatsLink.connect` already accepts `{url, token?, credsPath?, name}` (`connection.ts:103`, `27–44`), so the resolution target maps 1:1 onto an existing API — no new connection primitive needed.

### 3.3 How it lands in the CFG layered config (`network.yaml`)

The CFG epic (cortex#83 — "config split: cortex.yaml → layered composer") splits the monolithic `cortex.yaml` into composed layers. **Federation topology is the cleanest candidate for its own layer** because it is: (a) the slice most likely to differ per deployment/environment, (b) the slice with the strongest "edit this together" cohesion (a `leaf_node` definition and the `networks[]` entry that references it must move as one), and (c) security-sensitive (creds paths). Recommendation: a `network.yaml` layer owning both `leaf_nodes:` and `policy.federated`, composed into the runtime config by the CFG composer. This keeps the federation membership editable as one unit and keeps creds-path references out of the general `cortex.yaml`. (Resolve the legacy-`networks[]` name collision at the same time — Open Question 2.)

---

## 4. Single-daemon vs per-stack-daemon (Q7)

Q7 lock-in (`design-internet-of-agentic-work.md:655–673`) makes the stack a first-class protocol primitive and explicitly leaves the daemon-multiplicity choice to "Phase E design decision": "Multiple stacks per principal = multiple cortex daemons OR a single cortex daemon hosting multiple stacks."

§9.5 of the plan (`plan-internet-of-agentic-work.md:564–567`) records the lean:

> **Single daemon vs. per-stack daemon.** … Lean: **single-daemon for v1** (a principal typically has one or two stacks), per-stack daemon as a future option if isolation guarantees become load-bearing.
> **Subject namespace within a multi-stack daemon.** … Lean: **shared link with subject-segment isolation** (saves NATS connections); rejected if test rig finds cross-stack subject leakage.

**Decision for Phase E v1:**

- **One daemon, lean.** The bridge stack is *one* cortex process. Lower process count, simpler ops, cross-network visibility for the orchestrator agent (§5).
- **Two different "shared vs separate link" answers, by scope:**
  - *Multi-stack within `local.`*: shared link with subject-segment isolation (the §9.5 lean — `local.{principal}.{stack₁}` and `local.{principal}.{stack₂}` ride one local link, isolated by the `{stack}` segment).
  - *Multi-network across `federated.`*: **one dedicated `NatsLink` per network membership** (the §3.4 / E.1 requirement — physically separate links are the isolation mechanism *between networks*, not just a subject-segment convention).
- The distinction matters: subject-segment isolation is sufficient inside a single trust domain (`local.`, one principal); it is **not** sufficient across federation networks, where the whole point is that network B's NATS server never even *sees* network A's subjects. Physical link separation is the structural guarantee.

This is the architecturally defensible split: isolate by subject segment where the trust root is shared; isolate by physical link where the trust domains differ.

---

## 5. Subject isolation across networks (no cross-network leakage)

Three independent layers enforce no-cross-network-leakage; the design relies on all three (defence-in-depth):

1. **Physical (M1, leaf-node).** Each network's NATS server peers only with that network's members; leaf-node configs constrain bridged subjects to `federated.>` only (`design-internet-of-agentic-work.md:284`). A subject published on network A's link physically cannot reach network B's server. This is the load-bearing layer — it is enforced *below* cortex, in the leaf-node infra.

2. **Routing (M2, runtime link selection).** The §2.2 link-pool routes a `federated.{network_id}.…` publish *only* to the `{network_id}` link. There is no code path that publishes one network's subject onto another network's link — link selection is a pure function of the subject's `{network_id}` segment. Inbound, each subscriber is bound to exactly one link and tags envelopes with the delivering network (§E.1.4), so a misrouted subject cannot be silently accepted under the wrong network's policy.

3. **Policy (M6, surface-router accept/deny).** Phase D already landed the surface-router gate: `adapterMatches()` gates inbound `federated.*` against the originating network's `accept_subjects` / `deny_subjects`, emitting `system.access.denied` with `peer_deny_list` / `peer_not_in_accept_list` on miss, and `max_hop_exceeded` on over-budget chains (`plan-internet-of-agentic-work.md:370–372`, D.2.1–D.2.3). Phase E feeds the delivering network's id into this gate so the *correct* network's slice is applied.

The `accept_subjects[]` schema's refusal of a bare `>` (`cortex-config.ts:1409–1417`) is a deliberate anti-leakage guard: the maximal valid accept pattern is `federated.{network_id}.>`, so a network can never accidentally accept-all across the `{network_id}` boundary.

---

## 6. Trust — a bridge stack must not leak A's capabilities/data to B

The bridge stack is the single highest-value target in the whole topology: it sits in two trust domains at once. The trust model rests on four invariants, all grounded in existing primitives:

1. **Capabilities are network-scoped (Q4).** `announce_capabilities[]` is per-network membership (`cortex-config.ts:1491`; §3.4 `:624`). Network A's announced subset is published only on network A's link (`system.capability.announced.{network_id}`, `:1485`) / registered with network scope at the registry (E.2.2). Network B never learns network A's announced capabilities because the announcement never crosses A's link. **Capability leakage is structurally prevented by the same link-isolation that prevents data leakage.**

2. **Peers are network-scoped trust closures.** Each network's `peers[]` is "the trust closure for the network: a `signed_by[].principal` not in this list fails verification on the inbound side" (`cortex-config.ts:1453–1456`). Network A's peer pubkeys are not valid trust anchors for network B's link. A signature valid in A is meaningless in B.

3. **Chain-of-stamps is the audit, principal-partitioned (Q6).** `signed_by[]` (the chain-aware `signEnvelope`, `runtime.ts:602`) records every stack an envelope crossed. There is no central audit service; each principal owns their slice (`design-internet-of-agentic-work.md:641–653`). A bridge stack's own stamp appears on both networks' traffic *it handled*, but A's audit and B's audit never merge on the wire — the bridge sees both because it *is* the bridge, by design, not by leakage.

4. **No implicit cross-network forwarding.** A bridge stack relays A→B only when an agent *explicitly* re-emits (the delegation/orchestrator pattern, §7). There is no automatic subject bridging inside cortex; `max_hop` bounds even explicit relay (`cortex-config.ts:1497–1513`). A `max_hop: 0` network (the JV example, `design-internet-of-agentic-work.md:359`) accepts only directly-signed envelopes — no relay at all.

The remaining trust question is encryption across the bridge (§7.2, Open Question 6): if a bridge re-emits, must it decrypt? That is a deliberate trust-model decision, not an accident — and it gates both E.3 and E.7.

---

## 7. Interaction with delegation (E.3) and encryption (E.7)

### 7.1 Delegation / orchestrator pattern (§3.6, E.3)

The orchestrator-agent pattern (`design-internet-of-agentic-work.md:387–430`) is *the* application that justifies multi-network: an assistant (e.g. Luna) whose role is to **delegate, not do** — it reads the cross-network capability registry, picks the target network/stack for an inbound task, emits a `federated.{network}.tasks.{capability}` envelope, and threads the chain-of-stamps reply back to the original requester.

Multi-network is the *substrate* the orchestrator runs on:

- The orchestrator needs the link pool (§2.2) to *reach* multiple networks. "Multi-network MyelinRuntime (one stack, N leaf-nodes) … Phase E" is listed as a building block of the orchestrator (`design-internet-of-agentic-work.md:425`).
- Delegation is an **Offer** dispatch in most cases (capability-routed, claim-first-wins via NATS queue groups — Q5, `design:628–639`; `CONTEXT.md:68–73`). The orchestrator publishes to `federated.{network}.tasks.{capability}.{subcapability}`; one capable peer claims it per queue group. Per-network queue-group naming (`qg:{network_id}:{capability}`) keeps two networks from stealing each other's work (§9.8, Open Question 7).
- Reply correlation binds via `correlation_id` + envelope id over the per-network queue group (E.3.2); failure (no claimant within timeout) falls back to a sibling network or emits `dispatch.task.failed` (E.3.3). This is event-driven, not blocking-wait — consistent with the dispatch lifecycle on `dispatch.task.{started|completed|failed|aborted}` (`CONTEXT.md:80`).
- Q4's clean network boundaries are *what makes the orchestrator tractable*: "orchestration agents need clean network boundaries to reason about delegation" (`design:428`). Per-peer scoping (the rejected model) would have forced the orchestrator to reason about peer-level capability fragments inside a network.

The orchestrator agent itself is *application logic* on the substrate harness (M6, `agent-team` / `bus-peer` harness per `CONTEXT.md:87–88`); Phase E *productionises* it (`design:428` — "Phase A enables; Phase E productionises"). This doc specifies the transport it needs, not the orchestrator's decision algorithm (capability-matching is its own follow-on, §9.6 of the plan / Open Question 8 territory).

### 7.2 Encryption across the bridge (E.7)

E.7 (envelope encryption / federation payload confidentiality — cortex#84, in flight) and Phase E intersect precisely at the bridge re-emit point:

- If payloads are **network-scoped encrypted** (only network A's peers hold A's key), then a bridge/orchestrator that re-emits a task from network A *into* network B must **decrypt-then-re-encrypt** at the boundary — which means the bridge stack sees plaintext. That makes the bridge a *trusted decryption intermediary*.
- The alternative — **end-to-end payload encryption that survives the bridge** — makes cross-network delegation of encrypted payloads *structurally impossible* (the originator in network A would have to hold network B's key, which violates network isolation).

These are mutually exclusive. The decision is a trust-model choice (Open Question 6) that must be made *before* E.3 (delegation) and E.7 (encryption) can both ship. The recommendation embedded here: a bridge stack that performs delegation IS a trusted intermediary for the payloads it re-emits (it already sees them to route them); E.7 should therefore target **hop-by-hop confidentiality with per-network keys**, accepting that the bridge is a decryption point, rather than chasing end-to-end-across-bridges (which the topology forbids). The chain-of-stamps already records that the bridge handled the payload, so the trust is *attestable* (`signed_by[]`), which is the metafactory audit posture (Q6).

The envelope metadata — `sovereignty`, `signed_by[]`, `correlation_id`, routing — stays cleartext in all cases (the bus routes on it; `CONTEXT.md:53–55`). Only the `payload` is a candidate for encryption. The link-pool refactor is encryption-agnostic: it routes on subject, never on payload, so §2.2 needs no change for E.7.

---

## 8. Implementation phasing (maps to plan §6 E.1–E.5)

| Slice | Scope | Acceptance (plan §6) |
|---|---|---|
| **E.1** Multi-link MyelinRuntime | Link pool keyed by network_id; per-link lifecycle; subject-based link selection; inbound source-network tagging | `plan:426–433`, accept `:461–464` |
| **E.1′** `leaf_node` resolution (new) | `leaf_nodes:` connection table + resolver; lands in CFG `network.yaml` | Open Question 1; `cortex-config.ts:1441` |
| **E.2** Per-network capability announcement | `announce_capabilities[]` subset published per network; registry registration carries network scope | `plan:434–438` |
| **E.3** Delegation primitives | Orchestrator reference impl on the link pool; reply correlation; failure fallback | `plan:440–445`; design §3.6 |
| **E.4** Mesh variety scaffolding | Document private / isolated-private (JV) configs; public stub reserved (`policy.public.announce_capabilities[]`), no impl | `plan:447–451`; design §3.5 |
| **E.5** Tests + production readiness | Bridge-stack 2-network integration test; delegation chain test; failure-mode tests | `plan:453–457`; META accept `plan:593` |

**Versioning:** Phase E is a minor bump (additive — multi-network + delegation), per `plan:639`. No cortex.yaml schema flip.

---

## 9. Testing strategy

The architecture is designed to be verifiable — designs that are hard to test can't hill-climb. Concrete, observable criteria:

1. **Two-link single-process test (E.1.5 / E.5.1, `plan:432,455`).** One cortex process opens two leaf-nodes (fake `connectImpl` per `MyelinRuntimeOptions.connectImpl`, `runtime.ts:224`, so no real `nats-server`); publishes `federated.research-collab.*` through link A; receives `federated.jv.*` through link B; assert chain-of-stamps preserved across both, and assert **no** `federated.jv.*` ever appears on link A's wire (the leakage negative test — this is the test §9.5 says would *reject* the shared-link approach for networks).
2. **Link-selection unit test.** Pure-function assertion: subject → link key. `local.*` → local; `federated.{n}.*` → pool[n]; unknown network → error (not silent drop).
3. **Per-network capability test (E.2.3, `plan:438`).** Stack declares `[code-review, deploy]`; announces `code-review` to A and `deploy` to B; registry query per network returns the right subset; assert B's roster never shows `code-review`.
4. **Boot-degradation test (Open Question 4).** Network B's leaf-node unreachable at boot → daemon boots, network A live, `system.error` emitted for B, B retried in background.
5. **Delegation chain test (E.5.2, `plan:456`).** orchestrator → network → claimer → reply → originator; full chain-of-stamps verification at each hop; `max_hop` over-budget rejected.
6. **Symmetry regression.** Extend the existing `runtime-org-symmetry` / `runtime-principal-symmetry` pattern (referenced `runtime.ts:400–407`) to assert per-link subscribe-`{network_id}` === publish-`{network_id}`.

---

## 10. Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cross-network subject leakage (the cardinal failure) | Med | Three-layer defence (§5); explicit negative test (§9.1); physical M1 leaf-node constraint is the backstop |
| Name collision with legacy grove `networks[]` (`network-resolver.ts`) causes a wiring bug | High | Rename legacy concept during CFG split (Open Question 2); until then, never import `network-resolver.ts` tables into federation code |
| One dead leaf-node crashes the whole daemon (current hard-fail boot contract, `runtime.ts:513`) | Med | Per-link degrade-not-crash (§2.2; Open Question 4) |
| Bridge becomes a confused deputy (re-emits A's data into B) | Med | No implicit forwarding; `max_hop`; explicit-only re-emit via orchestrator; encryption decision (§7.2) |
| E.7 encryption + E.3 delegation ship with incompatible trust assumptions | High | Resolve Open Question 6 *before* either ships; this doc flags the mutual exclusivity |
| Per-network queue groups collide → networks steal each other's offered work | Med | `qg:{network_id}:{capability}` naming (§7.1; Open Question 7; plan §9.8) |

---

## 11. Recommendation (decision-quality summary)

Refactor `MyelinRuntime` to own a **`Map<network_id, NatsLink>` link pool** — the always-present local link plus one dedicated `NatsLink` per distinct `policy.federated.networks[].leaf_node` — reparameterising the existing link-bound `signAndPublishOnSubject` sign+publish core (`runtime.ts:559`) to close over a *selected* link instead of the module singleton. Select the link by the subject's scope + `{network_id}` segment; never share a link across federation networks (physical separation is the inter-network isolation guarantee, where subject-segment isolation suffices only *within* the shared-trust `local.` scope). Run **one lean daemon for v1** (Q7 lock-in). The federation **config schema already exists** (`PolicyFederatedNetworkSchema`, `cortex-config.ts:1429`) — Phase E adds *no* schema flip; the only new config is a `leaf_node` → connection-params resolution table, which belongs in the CFG-layered `network.yaml`. Capability scoping, accept/deny gating, peer trust closure, and chain-of-stamps audit are all already per-network in the schema, so a bridge stack is **structurally** unable to leak network A's capabilities or data into network B — provided the three isolation layers (M1 leaf-node, M2 link selection, M6 surface-router gate) all hold and the negative-leakage test (§9.1) is green. Delegation (E.3) rides on top of this link pool; encryption (E.7) intersects it only at the bridge re-emit point, where a trust-model decision (Open Question 6) must precede shipping either.
