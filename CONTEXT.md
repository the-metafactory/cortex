# Cortex — Context

Cortex is the M7 collaboration surface of the metafactory Myelin layer model: it consumes the bus, runs agents, dispatches work, and presents activity to the principal through Mission Control and chat adapters.

This is the canonical domain glossary for the **cortex** bounded context — one canonical term per concept; aliases are listed under _Avoid_. Boundary terms shared with soma, myelin, and signal are reconciled in `compass/ecosystem/CONTEXT-MAP.md`. Resolved by a `grill-with-docs` session (Q1–Q14).

## Language

### Principals, stacks, networks

**Principal**:
The human who owns and runs Cortex stacks — root of the trust and policy model, and the identity that scopes every subject the principal's stacks emit. One principal runs one or more **stacks** (e.g. `andreas` runs `andreas/meta-factory`, `andreas/work`, `andreas/halden`).
_Avoid_: operator, user, owner, human, org

**Stack**:
One running cortex deployment under a **principal** — its own `cortex.yaml`, signing identity, subject sub-namespace, and JetStream consumers. A principal runs one or more stacks side by side, purpose-named. The second subject segment: `local.{principal}.{stack}.…`.
_Avoid_: deployment, instance, node. Never use `stack` for the M1–M7 architecture — that is the **Myelin layer model**.

**Network**:
A federation of **principals** whose **stacks** interconnect at the NATS leaf-node layer — `metafactory` is the network this ecosystem runs on. A network is **not a subject segment**: it is deployment topology. Cross-principal reach is the `federated.` **scope** prefix, never a network name on the wire. A principal may belong to more than one network.
_Avoid_: federation (that is the relationship, not the thing), mesh, fabric, org, cluster

### Assistants & agents

**Assistant**:
The named being cortex runs — Luna, Echo, Forge, Pilot. Has a persona, a voice, and continuity of identity. An assistant is hosted by an **agent**. The assistant name is what the bus routes to: the `@{assistant}` segment in Direct/Delegate **dispatch** (`@forge`, `@pilot`).
_Avoid_: persona, bot, DA, character

**Agent**:
The stack-local, long-lived runtime identity (daemon) that hosts an **assistant** on the bus — its own NKey signing identity and a JetStream consumer. An agent has **no independent name**: it is reached via the **assistant** it hosts plus the **stack** it runs on. The same assistant may be hosted by different agents on different stacks ("same assistant, different agent surfaces").
_Avoid_: bot, persona, daemon (as the domain term)

**Sub-agent**:
A short-lived task spawned via Claude Code's `Agent` tool — e.g. the Engineer or Explore sub-agents the pilot loop uses. Not an **agent**: no bus identity, no persistence. Always carries the `sub-` qualifier; never bare `agent`.
_Avoid_: agent (bare), worker, helper

### The bus

**Subject**:
The dotted NATS routing string a message is published to or subscribed on — `{scope}.{principal}.{stack}.{domain}.{entity}.{action}`. Routing lives in the subject, not in code. Subscribers match with NATS wildcards (`*`, `>`).
_Avoid_: topic (the Kafka/MQTT word — NATS subjects have different semantics), channel, path

**Scope**:
How far a **subject** may travel, set by its prefix — exactly three values: `local` (never leaves the **principal** boundary), `federated` (crosses to peer principals in a **network**), `public` (unrestricted; carries no principal/stack segment).
_Avoid_: reach, visibility, tier, level

**Domain**:
The functional-domain segment of a **subject** — groups related signals. Values: `tasks`, `agent`, `system`, `code`, `review`, `dispatch`. Always the segment ("the tasks domain").
_Avoid_: channel, category — and never use `domain` for the DDD bounded-context sense (that is always written **bounded context**).

**Envelope**:
The signed wrapper that travels on a **subject** — metadata (`sovereignty`, `signed_by[]`, `correlation_id`, `source`, `type`) around a **payload**. Every bus message is an envelope.
_Avoid_: message (too loose — say envelope for the wrapper, payload for the content), packet

**Payload**:
The inner content body of an **envelope** — the domain data, distinct from the envelope's routing/trust metadata.
_Avoid_: message, body, data

**Capability**:
A declared, bus-routable ability — e.g. `code-review.typescript`. An **assistant** declares the capabilities it offers; the `tasks.{capability}.{subcapability}` **subject** routes on it; an **agent**'s JetStream consumer filters by it. A capability may be *fulfilled by* a soma skill, but the capability is the wire-facing ability, not the implementation.
_Avoid_: skill (that is the SOMA implementation term), ability, function, command, tool

**Dispatch**:
The act of routing a unit of work to an **assistant** over the bus. Three modes, by how the recipient is chosen — **Offer**: published to a **capability**, any capable assistant *claims* it (competing consumers, exactly-one delivery); **Direct**: sent to one named assistant (`@{assistant}`), one-shot; **Delegate**: sent to one named assistant that orchestrates a multi-step outcome. Unclaimed work escalates to **dead-letter**.
_Avoid_: routing, assignment, hand-off. Never call the Offer mode "broadcast" — exactly one assistant claims an offered task, not all.

## Relationships

- A **principal** runs one or more **stacks**, and belongs to one or more **networks**.
- A **stack** hosts one or more **agents**.
- An **agent** hosts exactly one **assistant**; the same assistant may be hosted by different agents on different stacks.
- An **agent** may spawn zero or more **sub-agents**.
- An **assistant** declares one or more **capabilities**.
- Work is **dispatched** to an **assistant** as an **envelope** published on a **subject**.
- A **subject** = `{scope}.{principal}.{stack}.{domain}.…`; its **scope** sets how far it travels.

## Example dialogue

> **Dev:** Pilot timed out asking for a code review. Where did it go?
> **Domain expert:** Pilot is an **assistant** — it ran an **Offer** **dispatch**: published a review task to a **capability**, `code-review.typescript`, on the **subject** `local.andreas.meta-factory.tasks.code-review.typescript`.
> **Dev:** So any reviewer could claim it?
> **Expert:** Right — Offer mode. Any **agent** whose **assistant** declares that **capability** can claim the **envelope**. Echo's agent on the `andreas/meta-factory` **stack** should have.
> **Dev:** It didn't. The subject said `local.metafactory.meta-factory.…`.
> **Expert:** There's the bug. The second segment is the **principal** — `andreas`. `metafactory` is the **network**, not a principal; it must never be a subject segment. Pilot built the subject with the wrong **principal**, so Echo's agent never saw the envelope.
> **Dev:** And if I want *only* Echo to review it?
> **Expert:** Then it's a **Direct** dispatch — `local.andreas.meta-factory.tasks.@echo.code-review.typescript`. `@echo` is the **assistant**. If Echo had to drive it to merge across several steps, that'd be **Delegate**.

## Flagged ambiguities

- **`operator` → `principal`.** cortex historically said `operator` (`operator.id`, "operator cockpit", the `{org}` segment). Resolved: **`principal`** ecosystem-wide, matching `soma:principal`. Carries into `cortex.yaml` schema, subject derivation, Mission Control copy.
- **`agent` was overloaded** — the named being, the runtime identity, *and* a Claude Code spawned task. Resolved into **assistant** / **agent** / **sub-agent**.
- **`persona` → `assistant`.** `persona` is not a domain entity. `personas/luna.md` stays a valid filename ("the assistant's persona file").
- **The `@`-segment names an `assistant`** — `@{assistant}`. myelin's `namespace.md` calls it a "principal address"; its examples ("Forge", "Pilot") are assistants. The hosting **agent** is resolved from `(stack, assistant)`; it carries no wire name.
- **`stack` meant two things** — the M1–M7 layering *and* a deployment unit. Resolved: `stack` is the **deployment unit**; the M1–M7 layering is the **Myelin layer model**.
- **`domain` meant two things** — the `{domain}` subject segment *and* the DDD sense. Resolved: bare `domain` is only the segment; the DDD concept is always **bounded context**.
- **`topic` → `subject`.** "Topic" is the Kafka/MQTT word; NATS uses **subject**.
- **`reach` → `scope`.** myelin's `namespace.md` heads the prefix column "Reach"; canonical is **scope**.
- **`broadcast` → `Offer`.** A broadcast reaches everyone; that dispatch mode is claimed by exactly one assistant. The modes are **Offer / Direct / Delegate**.

## Boundary with adjacent contexts

Reconciled in full in `compass/ecosystem/CONTEXT-MAP.md`:

- `cortex:principal` **≡** `soma:principal` — identical concept, identical term (Q2).
- `cortex:assistant` **≡** `soma:assistant` — the named being.
- `cortex:agent` **≡** `soma:"Cortex agent"` — SOMA always qualifies `agent`; within cortex's own bounded context bare `agent` is canonical.
- `cortex:sub-agent` **≡** `soma:"Claude Code sub-agent"`.
- `cortex:capability` is **distinct from** `soma:skill` — a capability is the bus-routable ability tag; a skill is the packaged implementation that may fulfil it.
- **myelin** owns the **subject** grammar (a published language cortex consumes). Pending myelin alignment, filed as a namespace.md issue: `{org}` → `{principal}`, the `@`-segment relabelled an *assistant address*, "Reach" → "Scope".
