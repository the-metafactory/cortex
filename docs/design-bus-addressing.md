# Design — Bus Addressing & Routing Model

**Status:** canonical reference — draft for review
**Owners:** Andreas + Soma
**Audience:** anyone building or operating a tool that publishes to or subscribes on the metafactory NATS bus — cortex, pilot, arc, signal, future L7 surfaces
**Grammar authority:** [`myelin/specs/namespace.md`](https://github.com/the-metafactory/myelin/blob/main/specs/namespace.md) defines the wire grammar.
**Vocabulary authority:** every term here is defined canonically in [`cortex/CONTEXT.md`](../CONTEXT.md), [`myelin/CONTEXT.md`](https://github.com/the-metafactory/myelin/blob/main/CONTEXT.md), and `soma/CONTEXT.md`, reconciled in `compass/ecosystem/CONTEXT-MAP.md`. This document *uses* those terms; it does not redefine them.

---

## 1. Why this document exists

The same class of bug keeps recurring:

- **cortex#262** — stack-aware subject grammar landed
- **cortex#317** — `NatsLink.close()` drain
- **cortex#318** — pilot published 6-segment subjects, cortex subscribed 4-segment
- **2026-05-20** — `pilot request-review` times out: pilot publishes review tasks to `local.metafactory.meta-factory.tasks.code-review.*` but the cortex bot consumes `local.andreas.meta-factory.tasks.code-review.*`. The tasks land in a JetStream consumer no bot polls.

Every instance is the same underlying defect: **tools disagreed on what the segments of a NATS subject mean, because the meaning was never written down canonically.** A `grill-with-docs` session (2026-05) resolved the vocabulary into three `CONTEXT.md` glossaries; this document is the addressing/routing spec built on them. When a tool's behaviour disagrees with this doc, the tool is wrong.

## 2. The verified root cause (2026-05-20 investigation)

The first segment after the scope prefix is the **principal** — the human who owns the stack. Three tools derived it three ways (field names below are the pre-grill names; `operator.id` is being renamed `principal.id`):

| Tool | How it derived the first segment | Result for this deployment |
|---|---|---|
| **cortex** | from `operator.id` in `cortex.yaml` — the principal identity. Review-consumer subscribes `local.{principal}.{stack}.tasks.code-review.>`. | `local.andreas.meta-factory.…` |
| **pilot** | **hardcoded.** `publish-review-request.ts` sets envelope `source: "metafactory.pilot.{network}"`; myelin's `deriveNatsSubject()` takes `source.split('.')[0]` → `metafactory`. pilot never reads the principal. | `local.metafactory.meta-factory.…` |
| **arc** | `arc nats provision-streams --network <X>` mints the consumer filter with the first segment = `<X>`. `--network metafactory` → `local.metafactory.…` | `cortex-review-consumer-metafactory-echo` |

**The mismatch:** cortex says the first segment is `andreas` (the **principal**). pilot and arc say `metafactory` (a **network**). pilot's publish lands in the network-named consumer; the cortex bot polls the principal-named consumer. They never meet.

Not a grammar bug (cortex#318 fixed the segment *count*). A **semantic bug**: the first segment's meaning was contested — pilot/arc treated it as the network, cortex as the principal. The grill settled it: **the first segment is the principal. A network is never a subject segment.**

## 3. Vocabulary

This document does not redefine terms — the three `CONTEXT.md` glossaries do. Quick reference for the addressing terms, and which glossary owns each:

| Term | One-line meaning | Owner glossary |
|---|---|---|
| **principal** | the human who owns and runs stacks — the `{principal}` subject segment | soma / cortex / myelin (aligned) |
| **identity** | any authenticatable entity (DID + keypair) — principals, agents, services, hubs | myelin |
| **network** | a federation of principals at the NATS leaf-node layer (`metafactory`) — **never a subject segment** | cortex / myelin |
| **hub** | a network's trust-anchor identity | myelin |
| **stack** | one running cortex deployment under a principal — the `{stack}` subject segment | cortex |
| **assistant** | the named being (Luna, Echo, Forge, Pilot) — the `@{assistant}` routing segment | soma / cortex |
| **agent** | the stack-local runtime daemon hosting an assistant — no wire name; resolved from `(stack, assistant)` | cortex |
| **scope** | how far a subject travels — `local` / `federated` / `public` (the prefix) | cortex |
| **subject / domain / envelope / capability / dispatch** | the wire grammar + message + work-routing vocabulary | myelin (grammar), cortex (dispatch) |

The single most important rule, stated once: **the principal is the first subject segment; the network is deployment topology and never appears on the wire.**

## 4. The canonical subject grammar

Per `myelin/specs/namespace.md`, with the grill's segment-meaning resolutions applied:

```
local.{principal}.{stack}.{domain}.{entity}.{action}
federated.{principal}.{stack}.{domain}.{entity}.{action}
public.{domain}.{entity}.{action}
```

- `{principal}` — the principal slug. **Derived from one source of truth per stack** (§10). Never hardcoded, never a network name.
- `{stack}` — the stack slug (second half of `{principal}/{stack}`). `default` for single-stack principals.
- `{domain}` — the functional-domain segment: `tasks`, `agent`, `system`, `code`, `review`, `dispatch`.
- `{entity}.{action}` — the signal; or the capability / routing grammar below for the `tasks` and `agent` domains.
- `public.` carries **no principal/stack** — public signals are not principal-scoped.

### 4.1 The `tasks` domain — dispatched work

```
local.{principal}.{stack}.tasks.{capability}.{subcapability}     ← Offer
local.{principal}.{stack}.tasks.@{assistant}.{capability}        ← Direct / Delegate
local.{principal}.{stack}.tasks.dead-letter.{capability}         ← unclaimable escalation
```

### 4.2 The `agent` domain — presence + lifecycle (G-1114)

```
local.{principal}.{stack}.agent.{action}.@{assistant}
federated.{principal}.{stack}.agent.{action}.@{assistant}
```

where `{action}` ∈ `online | heartbeat | offline | capabilities-changed`. The `@{assistant}` segment names the assistant whose hosting agent the lifecycle event is about.

## 5. Worked example — principal `andreas`, network `metafactory`, three stacks

Principal `andreas` belongs to the `metafactory` network and runs three stacks:

| Stack | FQSI | `local.` prefix | `federated.` prefix |
|---|---|---|---|
| meta-factory | `andreas/meta-factory` | `local.andreas.meta-factory.>` | `federated.andreas.meta-factory.>` |
| work | `andreas/work` | `local.andreas.work.>` | `federated.andreas.work.>` |
| halden | `andreas/halden` | `local.andreas.halden.>` | `federated.andreas.halden.>` |

What is **absent**: `metafactory` appears in no subject. It is the network — the leaf-node federation `andreas` participates in. Config, not wire-form.

A code-review task **Offered** to any qualified assistant from the meta-factory stack:

```
local.andreas.meta-factory.tasks.code-review.typescript
```

The same task **Directed** point-to-point to the assistant Echo:

```
local.andreas.meta-factory.tasks.@echo.code-review.typescript
```

Echo's agent announcing the assistant online (G-1114):

```
local.andreas.meta-factory.agent.online.@echo
```

The envelope `source` for that announcement is `andreas.meta-factory.echo` — `{principal}.{stack}.{assistant}` (myelin grill-Q3).

## 6. Scopes in practice

- **`local.`** — the default. Everything within one principal's stacks. Cross-*stack* but same-*principal* traffic is still `local.` — the meta-factory stack observing the work stack uses `local.andreas.work.>`, a wildcard the principal owns end-to-end. Leaf-node config prevents `local.>` from replicating off the principal's cluster.
- **`federated.`** — cross-*principal*, same network. When `andreas` and another principal both peer into `metafactory`, a task `andreas` is willing to send to an external assistant goes on `federated.andreas.meta-factory.tasks.code-review.typescript`. The receiving principal's leaf node validates the envelope `sovereignty` block before accepting.
- **`public.`** — unrestricted, no principal scoping. Registry announcements, network heartbeats. Deferred for cortex's own use (G-1114 §4.3).

## 7. Dispatch & routing

**Dispatch** is the act of routing a unit of work to an **assistant** over the bus. Three modes, by how the recipient is chosen:

| Mode | Subject shape | Semantics |
|---|---|---|
| **Offer** | `…tasks.{capability}.{sub}` | Published to a **capability**; any assistant whose agent declared it may **claim** it. JetStream queue-group → exactly-one delivery. The dispatcher does not pick the worker; the qualified pool competes. *Not a broadcast — exactly one claims it.* |
| **Direct** | `…tasks.@{assistant}.{capability}` | Routed to one named assistant, one-shot. "Forge, cut a release." Broker-side filter on `@{assistant}` — no payload inspection. |
| **Delegate** | `…tasks.@{assistant}.{capability}` | Same wire shape as Direct; the recipient orchestrates a multi-step outcome and emits a `dispatch.*` lifecycle stream. "Pilot, drive PR #32 to merge." |
| **dead-letter** | `…tasks.dead-letter.{capability}` | A task that exhausted `max_deliver` without a claim, or hit a compliance block, escalates here. Capability segment preserved for per-capability monitoring. |

The mode is the **publisher's** choice: Offer when any qualified assistant will do; Direct/Delegate when a specific one is wanted.

## 8. Multi-stack (one principal, many stacks)

`andreas` runs three stacks. Consequences:

- **`{principal}` is constant** across all three (`andreas`); `{stack}` varies. One principal, one sovereignty boundary, one `local.andreas.>` namespace.
- **Cross-stack visibility is cheap and internal.** A Mission Control instance on the meta-factory stack subscribes `local.andreas.>` to see all three — same principal, no federation needed.
- **Each stack has its own signing identity** and JetStream consumers, named `(principal, stack, assistant)` — e.g. `cortex-review-consumer-andreas-meta-factory-echo`. The consumer name MUST encode principal + stack, never a network.

## 9. Multi-network (one principal, many networks)

A principal may peer into more than one network — `andreas` in `metafactory` and also in a client network `acme-clients`.

- The network is **still not on the wire.** Both networks see `andreas`'s subjects as `local.andreas.{stack}.>` / `federated.andreas.{stack}.>`.
- Networks are kept apart at the **NATS leaf-node layer** — which leaf nodes peer with which cluster. A `federated.` subject reaches only the principals whose leaf nodes peer into the *same* network.
- If the same principal slug must mean different things in two networks, that is a **principal-slug collision** — resolve by globally-unique principal slugs (`andreas-mf`, `andreas-acme`), never by adding a network segment (§13.1).

## 10. Conformance rules — binding on every tool

1. **The first subject segment ::= principal id. Always.** Every tool that builds a subject sets the first post-scope segment to the principal identity. No hardcoded literals. No network names.
2. **One source of truth per stack.** A stack's principal + stack + network are declared once, in `cortex.{stack}.yaml`. Tools READ that source — never re-derive the principal from their own config, an env var, or a literal.
3. **A subject is derivable from a single stack's config.** Building a subject needs only: scope + that stack's principal + that stack's stack-slug + the domain/action. It never needs knowledge of the whole network — federation reach is the `federated.` prefix's job.
4. **Network is provisioning input, never wire-form.** `arc nats` and leaf-node config consume a network name; the bus never sees it. An `arc nats` flag that places a value in the first subject segment must take the *principal*, not the *network*.
5. **Consumer names encode `(principal, stack, assistant)`.** Never `(network, …)`. A consumer named `cortex-review-consumer-metafactory-echo` is malformed — `metafactory` is a network.

## 11. The per-stack descriptor

A convenience artefact (not the source of truth — `cortex.{stack}.yaml` is): a rendered, human- and agent-readable card declaring a stack's bus-addressing identity — "where am I, what subjects do I own." One per stack, at `~/.config/cortex/stack-{name}.md`.

> **Distinct from `CONTEXT.md`.** `CONTEXT.md` (repo root, uppercase) is the bounded-context *glossary*. The per-stack descriptor is a *runtime identity card* for one deployment. Different artefacts; do not conflate.

```markdown
# Stack — andreas/meta-factory

| Field | Value |
|---|---|
| principal | andreas |
| stack | meta-factory |
| network(s) | metafactory |
| signing identity (NKey pub) | UD7OGEV…L4QV |

## Subject namespace this stack owns
- local:      `local.andreas.meta-factory.>`
- federated:  `federated.andreas.meta-factory.>`

## Assistants on this stack
- `@echo` — Echo · capabilities: code-review.{typescript,documentation,security,…}
- `@luna` — Luna
- `@forge` — Forge

## Dispatching into this stack
- Offer:  `local.andreas.meta-factory.tasks.code-review.typescript`
- Direct: `local.andreas.meta-factory.tasks.@echo.code-review.typescript`
```

Rendered from `cortex.{stack}.yaml`; any tool publishing toward a stack sets the principal segment from here or from `cortex.{stack}.yaml` — never a hardcode, never a network name.

## 12. Remediation — the concrete defects this model exposes

| # | Defect | Fix | Owner |
|---|---|---|---|
| R1 | **pilot hardcodes `source: "metafactory.pilot.{network}"`** → every published subject's first segment is `metafactory`. | pilot derives the envelope `source` from the target stack's `cortex.{stack}.yaml` — `source` = `{principal}.{stack}.{assistant}` (myelin grill-Q3). Verify pilot#133 ("derive envelope source from the principal, no more `metafactory.*` hardcode") actually landed for the `request-review` path; the repo still shows the hardcode. | pilot |
| R2 | **`arc nats provision-streams --network <X>`** places `<X>` in the consumer's first-segment filter. | The flag that determines the first segment must be the **principal**, not the network. Re-provision the malformed `cortex-review-consumer-metafactory-*` consumers as `…-andreas-{stack}-…`. | arc |
| R3 | **myelin `namespace.md` grammar** uses the pre-grill vocabulary. | Apply the grill resolutions to `namespace.md`: rename the `{org}` token → `{principal}`; relabel the `@`-segment an *assistant address* (`@{assistant}`); "Reach" → "Scope". Filed as a myelin grammar issue. | myelin |
| R4 | **`operator` / `Principal` / `source` rename** across myelin + cortex. | myelin: `Principal` interface → `Identity`, `signed_by[].principal` → `.identity`, `Identity.operator` → `.network`, `source` grammar → `{principal}.{stack}.{assistant}`. cortex: `operator.id` → `principal.id` in `cortex.yaml` schema + subject derivation + Mission Control copy. Tracked features. | myelin, cortex |

Until R1 lands, the pilot review loop cannot deliver verdicts on this deployment (arc#182, compass#65 are blocked on exactly this). Interim path: in-session sub-agent review.

## 13. Open questions

1. **Principal-slug collisions across networks.** If `andreas` peers into two networks and a *different* `andreas` exists in the second, the slug collides. Globally-unique principal slugs, or a network-scoped principal registry? (§9.)
2. **Per-stack descriptor generation + drift.** Should `arc` render `stack-{name}.md` on `arc upgrade Cortex`? A drift check in CI? (Mirrors the compass `CLAUDE.md` generation question — arc#181.)
3. **Federation identity mapping.** When a `federated.` task is claimed by an agent from another principal, whose policy scope does it carry? (myelin#43 territory — cross-ref, don't re-solve here.)
4. **Should the network ever be observable?** A diagnostic case for "which network did this reach" — but per §3 it must never be a subject segment. An envelope metadata field, perhaps. Deferred.

---

## Relationship to other docs

- **`cortex/CONTEXT.md`, `myelin/CONTEXT.md`, `soma/CONTEXT.md`** — the bounded-context glossaries. This doc uses their terms; `compass/ecosystem/CONTEXT-MAP.md` reconciles the boundaries.
- **`myelin/specs/namespace.md`** — the wire-grammar authority. R3 aligns it with the grilled vocabulary.
- **`docs/architecture.md` §3.5** — the existing namespace-reconciliation note; this doc supersedes it.
- **`docs/design-agent-network-topology.md` (G-1114)** — consumes this model for the `agent` domain.
- **`docs/design-mission-control-cortex-cockpit.md` (G-1113)** — the Network view renders the topology this model defines.
