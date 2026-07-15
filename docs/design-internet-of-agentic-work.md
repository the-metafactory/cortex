# Internet of Agentic Work — Architectural Synthesis

**Refs:** cortex#110 (META) wrapping cortex#91 + cortex#102 + cortex#107 + cortex#109
**Status:** Design draft. No implementation in this PR — only synthesis grounded in shipped code.
**Scope:** Single design view across four sibling issues that, taken together, describe how cortex composes into networks of stacks.

> **Terminology aligned to CONTEXT.md** (the architectural source of truth, post operator→principal refactor). The HUMAN who owns and runs stacks is the **principal**; "operator" survives only as the NSC/NATS account-level concept (operator account NKey, operator JWT) and as the "Operator vision" reference label. Code identifiers / field names that still read `operator` (e.g. `home_operator`, `operatorId`) are tracked separately under cortex#448 and are left as-is here, flagged where they appear. Dispatch mode "broadcast" → **Offer**; "reach" → **scope**; "topic" → **subject**; overloaded "agent" disambiguated into **assistant** / **agent** / **sub-agent**; "persona" as a domain entity → **assistant** (persona file paths stay).

> **All 7 design questions resolved 2026-05-13 (Andreas).** Implementation plan: [`docs/plan-internet-of-agentic-work.md`](./plan-internet-of-agentic-work.md). Sub-issues track Phase A–E in cortex (filed as part of cortex#110 work). The §5 recommendations are now principal-locked; the plan doc is the working ground truth from here.

---

## TL;DR

Four sibling design issues converge on one architecture. cortex#91 (substrate harness) decouples agent execution from any single LLM vendor; cortex#102 (bot↔bot via bus envelopes) replaces platform-ID trust with cryptographic identity at L3/L4; cortex#107 (principal-based AAA) lifts authorization out of per-surface adapters and into a single PolicyEngine at M6; cortex#109 (envelope-visibility + subject-namespace routing) consumes myelin's `sovereignty.classification` taxonomy and the `local|federated|public` namespace so multi-principal federation becomes mechanically possible. The composition anchor is **stack → network → multi-network**: one principal can run multiple stacks; stacks join networks via NATS leaf-node federation; one stack can participate in multiple networks at once. Three scopes — local / federated / public — are not access control but expressed *intent*; sovereignty metadata carries the policy on every envelope. This doc maps each sibling to a layer in the M1–M7 stack, inventories what ships today vs. what is designed vs. what is open, sequences five implementation phases (A–E), and surfaces seven design questions that need Andreas's call before Phase A can start.

The unit isn't the agent, isn't the stack — it's the network, and networks compose.

---

## §1 — OSI layering of the cortex stack

cortex's canonical layered architecture is the **M1–M7 Myelin layer model** (`cortex/docs/architecture.md:69-105`). This document inherits that naming and refines the boundary between cortex (the M7 application) and myelin (the protocol stack M1–M6). Sibling issues land at specific layers; understanding which layer each one belongs to is the spine of this synthesis.

### M1 — Raw connectivity (NATS + TLS + creds-auth)

Out of scope for myelin per `myelin/docs/architecture.md:81-88` — internet plumbing. Cortex's contract here is "assume authenticated, encrypted, ordered byte streams". Two artefacts at M1 matter for federation:

- **NATS leaf-node topology.** `local.{principal}.>` subjects are not replicated across principal boundaries (`myelin/specs/namespace.md:15-22`); enforcement is at the leaf-node configuration, not in application code. This is the load-bearing structural property — a misconfigured leaf-node breaks the sovereignty model irrespective of envelope content.
- **Creds-auth.** cortex#86 (closed) — NSC operator-account NATS auth via `.creds` files (the NATS "operator" here is the NSC account-tree root — `OP_ANDREAS`, the operator-account NKey / operator JWT — a distinct NATS concept, NOT the human principal). Per `cortex/src/common/types/cortex-config.ts:476` (`nats.credsPath`) and `src/bus/myelin/runtime.ts:148-154`, cortex authenticates connections via `credsAuthenticator(...)` before any envelope flows.

**Module → layer map.** No cortex modules at M1; everything lives in principal-side NATS server configuration and platform-side leaf-node topology.

### M2 — Transport (NatsLink, MyelinRuntime publish/subscribe)

myelin's L2 ships an abstract `TransportPublisher` / `TransportSubscriber` interface with NATS + InMemory implementations (`myelin/docs/architecture.md:90-110`).

Cortex's transport layer:
- `src/bus/nats/connection.ts` — `NatsLink` connect wrapper (creds expansion, chmod-600 enforcement).
- `src/bus/myelin/runtime.ts` — `MyelinRuntime` (G-1100.E). Lifecycle handle for NATS connection + N subscribers + `publish(envelope)` + `onEnvelope(handler)` fan-out (`runtime.ts:30-67`, `runtime.ts:223-249`).
- `src/bus/myelin/subscriber.ts` — `MyelinSubscriber` (one per configured subject pattern).

The runtime is the single in-process owner of the NATS connection. Adapters never speak NATS directly; they go through `runtime.publish()` and receive via the surface-router which is itself registered on `runtime.onEnvelope()`.

### M3 — Envelope (Myelin schema + sovereignty + signed_by chain-of-stamps)

myelin's L3 is the cleanest layer in the stack — closed-contract, transport-independent, "sovereignty travels with the message". The envelope is the unit of sovereignty travel.

Shipped today:
- **Envelope schema.** `myelin/schemas/envelope.schema.json` (draft 2020-12). Cortex vendors this at `src/bus/myelin/vendor/envelope.schema.json` pinned at commit **`96b14ea`** (`src/bus/myelin/envelope-validator.ts:22`).
- **Sovereignty block.** Five required fields — `classification`, `data_residency`, `max_hop`, `frontier_ok`, `model_class` (`myelin/docs/envelope.md:62-79`, `src/bus/myelin/envelope-validator.ts:42-52`).
- **Subject↔classification alignment.** `deriveNatsSubject()` (`myelin/src/envelope.ts:337-345`) and `validateSubjectEnvelopeAlignment()` (`myelin/src/envelope.ts:347-358`) enforce 1:1 alignment between subject prefix and `classification`. Mismatch is a protocol violation.
- **Chain-of-stamps.** myelin#31 shipped post-`96b14ea`; closed by myelin PR #92. Each L4 stamp covers `id`, `source`, `type`, `timestamp`, `sovereignty`, `payload`, the F-021 task fields, and the prior `signed_by` chain (`myelin/docs/envelope.md:82-92`).
- **F-021 task fields.** `requirements`, `sovereignty_required`, `deadline`, `distribution_mode`, `target_principal` (`myelin/docs/envelope.md:26-31`). Shipped upstream; not yet consumed by cortex's vendored schema (still `96b14ea`).

Cortex consumption today:
- Four cortex emit sites all hardcode `sovereignty.classification: "local"` (per cortex#109):
  - `src/bus/dispatch-events.ts:73`
  - `src/bus/system-events.ts:102`
  - `src/bus/github-events.ts:89`
  - `src/taps/cc-events/cc-events.ts:99`
- Cortex's vendored envelope validator (`src/bus/myelin/envelope-validator.ts`) is pinned at `96b14ea` — pre-chain-of-stamps, pre-F-021 task fields, pre-array `signed_by`. A mechanical upgrade is on the table.

### M4 — Subject routing (local / federated / public namespace + tasks domain)

myelin's namespace spec (`myelin/specs/namespace.md`) defines the three subject prefixes and their scope:

| Prefix | Scope | Sovereignty Rule |
|---|---|---|
| `local.{principal}.{domain}.{entity}.{action}` | Principal only | Never leaves principal boundary (M1 leaf-node enforced) |
| `federated.{principal}.{domain}.{entity}.{action}` | Cross-principal | Subject to envelope sovereignty rules |
| `public.{domain}.{entity}.{action}` | Unrestricted | No sovereignty constraints |

The **tasks domain** (`myelin/specs/namespace.md:134-213`) extends the standard `{prefix}.{principal}.{domain}.*` form with three distribution shapes:

- **Offer** — `local.{principal}.tasks.{capability}.{subcapability}` — competing consumers, queue-group exactly-once-per-group semantics. (myelin's `DistributionMode` enum still ships the `'broadcast'` value; cortex maps `'broadcast'` → Offer at the boundary.)
- **Direct/Delegate** — `local.{principal}.tasks.@{assistant}.{capability}` — single-recipient via DID-encoded `@`-segment naming an **assistant**.
- **Dead-letter** — `local.{principal}.tasks.dead-letter.{capability}` — unclaimable-task escalation.

The federated counterpart mirrors all three patterns (`myelin/specs/namespace.md:202-213`); subject routing for cross-principal work is wire-format-ready today.

Cortex consumption today:
- `MyelinRuntime.publish()` (`src/bus/myelin/runtime.ts:236`) emits `local.${principal}.${envelope.type}` — never `federated.*` or `public.*`. Subject prefix is hardcoded to match the hardcoded classification. (Code still reads the local var as `org`; that identifier rename is tracked under cortex#448.)
- Subscribe-side `cortex.yaml.nats.subjects` may include any pattern via `{principal}` substitution (`runtime.ts:126-128`) — but emit-side only produces `local.*`.

### M5 — Stream / consumer (TASKS JetStream, retention, queue-group)

myelin's L5 is named (capability registry) but spec-pending (`myelin/docs/architecture.md:154-162`). What's already specified at the namespace level:

- **TASKS JetStream stream** (`myelin/specs/namespace.md:216-247`): `subjects: ["local.*.tasks.>", "federated.*.tasks.>"]`, `max_age: 7d`, `replicas: 3` (R=1 dev), `retention: Limits`, `discard: Old`.
- **Filtered durable consumers per capability.** `cortex` (M7) is the lifecycle owner of consumer creation/teardown (`myelin/specs/namespace.md:236-249`). NOT specified by myelin itself.
- **Queue groups** drive competing-consumer semantics. `max_deliver: 3` with explicit ack; dead-letter on exhaustion.

Cortex consumption today:
- Cortex does **not** currently provision JetStream consumers for the TASKS stream. The substrate harness work (cortex#91) introduces the `SessionHarness` interface as the runtime contract; the BusPeerHarness implementation is the natural call site for declaring the consumer.

### M6 — Surface-router + dispatch + policy (the application logic core)

myelin's L6 is composition patterns — spec-pending (`myelin/docs/architecture.md:166-174`). Cortex implements its own M6 surface in the meantime:

- **Surface-router** (`src/bus/surface-router.ts`) — G-1111.A. In-process fan-out point. Adapters declare interest via NATS-style subject patterns plus an optional payload filter; the router applies subject matching first, then payload filtering, then invokes `adapter.render(envelope)` with timeout + isolation (`surface-router.ts:259-270`, `surface-router.ts:291-319`).
- **Dispatch-handler** (`src/bus/dispatch-handler.ts`) — orchestrates one inbound surface event through to one runner session. The natural integration point for cortex#107's PolicyEngine.
- **Trust resolver** (`src/common/agents/trust-resolver.ts`) — cortex#76 + cortex#105. Process-wide bidirectional `(platform, platformUserId) ↔ agentId` map, plus NSC operator-account-signing-key signature verification (the operator-account NKey is the NSC trust root, not the human principal).
- **PolicyEngine** (cortex#107) — does not yet exist. The design issue specifies a `src/common/policy/` module with `PolicyEngine.check(principal, intent) → { allow, capabilities } | { allow: false, reason }`.

### M7 — Surface adapters (Discord, Mattermost, dashboard, gh CLI, pilot)

Per `cortex/docs/architecture.md:288-303`, cortex is the L7 capability dashboard; sibling apps live in their own repos (grove for dashboard, pilot for review coordination, signal for observability). On cortex's side:

- **Discord adapter** (`src/adapters/discord/`) — owns the legacy role-resolver loop. cortex#107 thins it to translate-event-to-Principal (~30 LOC).
- **Mattermost adapter** (`src/adapters/mattermost/`) — same shape.
- **Dashboard renderer** (`src/renderers/dashboard.ts`) — subscribes to `local.{principal}.>` and projects to D1; no sovereignty filter today (cortex#109 §3).
- **Taps** — `src/taps/cc-events/` (CC hooks → bus, `cc-events.ts`), `src/taps/gh-webhook-receiver/` (GitHub HMAC → bus, `github-events.ts`).

### Module-to-layer map (cortex repo)

| Layer | Cortex code | Myelin code |
|---|---|---|
| M1 | (principal-side NATS topology + NSC operator account) | (out of scope) |
| M2 | `src/bus/nats/connection.ts`, `src/bus/myelin/runtime.ts`, `src/bus/myelin/subscriber.ts` | `src/transport/` (NATSTransport, InMemoryTransport) |
| M3 | `src/bus/myelin/envelope-validator.ts` (pinned at `96b14ea`), `src/bus/envelope-builder.ts`, `src/bus/dispatch-events.ts`, `src/bus/system-events.ts`, `src/bus/github-events.ts`, `src/taps/cc-events/cc-events.ts` | `src/envelope.ts`, `src/types.ts`, `schemas/envelope.schema.json` |
| M4 | (consumes myelin namespace spec — no cortex-side namespace code) | `src/identity/` (chain-of-stamps), `specs/namespace.md` |
| M5 | (no JetStream consumer provisioning yet) | (TASKS stream spec only; no provisioning code) |
| M6 | `src/bus/surface-router.ts`, `src/bus/dispatch-handler.ts`, `src/common/agents/trust-resolver.ts`, `src/common/agents/registry.ts` | `src/sovereignty/` (F-5 engine — policy store, validators, audit log, transport) |
| M7 | `src/adapters/discord/`, `src/adapters/mattermost/`, `src/renderers/dashboard.ts`, `src/taps/cc-events/`, `src/taps/gh-webhook-receiver/`, `src/runner/`, `src/cli/cortex/` | (other repos: grove, pilot, signal) |

---

## §2 — Current-state inventory by layer

This section is rigorous about three states: **shipped** (running in production), **designed** (issue body or PR draft), **speculative** (idea in this synthesis or in Operator-vision notes). Andreas wants the truth, not optimism. ("Operator vision" is kept as the reference label for the originating video script; everywhere else the human is the **principal**.)

### What myelin ships today (shipped)

- **L3 envelope schema** — `myelin/schemas/envelope.schema.json` with chain-of-stamps `signed_by[]` (post-#31 / PR #92), F-021 task fields (`requirements`, `distribution_mode`, `target_principal`, `deadline`, `sovereignty_required`), and economics block. `validateEnvelope()` is source of truth; schema mirrors.
- **L3 sovereignty block** — five fields enforced as required + `additionalProperties: false` (`myelin/src/envelope.ts:88-113`). `parseSovereignty()` returns derived booleans (`canFederate`, `canReachFrontier`, `isLocalOnly`) without re-implementing rules.
- **L3 namespace** — `myelin/specs/namespace.md` MY-101 closed. `deriveNatsSubject()`, `validateSubjectEnvelopeAlignment()`, tasks-domain Broadcast/Direct/Delegate/dead-letter grammar (myelin's "Broadcast" mode is cortex's **Offer** — cortex maps `'broadcast'` → Offer at the boundary per CONTEXT.md), DID-to-segment encoding with injectivity proof (`namespace.md:160-187`).
- **L4 identity** — `myelin/src/identity/`: `Principal`, `SignedBy` (Ed25519 + hub-stamp), `VerificationResult`. JCS (RFC 8785) canonicalization. `signEnvelope`, `verifyEnvelopeIdentity`, `requireVerifiedIdentity`. `PrincipalRegistry` (file-backed + in-memory). Chain-of-stamps is **shipped** (per `myelin/docs/envelope.md:177`).
- **L2 transport** — `myelin/src/transport/`: `NATSTransport`, `InMemoryTransport`, factory + envelope wrapper.
- **F-5 sovereignty engine** — `myelin/src/sovereignty/`: policy store, validators, audit log, transport. Specified for cross-layer enforcement; transport-level enforcement (sovereign refusal to route across the principal boundary on classification mismatch) is **spec-pending** per myelin#11 (`myelin/docs/architecture.md:190-192`).

### What myelin is designing but not shipping (designed)

- **L2 sovereignty enforcement** — myelin#11. The intended L2 enforcement (transport refusing to route an envelope across a principal boundary unless the sovereignty claim is satisfied) is spec-pending.
- **L5 discovery** — myelin#9. No runtime capability registry.
- **L6 composition** — myelin#10. Pipeline / fan-out / request-reply patterns exist in the wild (pilot review loop, signal flows) but are reinvented per use; no canonical specification.

### What cortex ships today (shipped)

- **M2 — MyelinRuntime** with subscribe (subjects from `cortex.yaml.nats.subjects`) + publish (`local.${principal}.${type}`; the in-code var is still `org`, pending cortex#448) + `onEnvelope` fan-out + graceful drain on shutdown (`src/bus/myelin/runtime.ts`).
- **M3 — Four envelope constructors** (system, dispatch, github, cc). Each hardcodes `classification: "local"`. `data_residency` is parameterised via `dataResidency` on the source struct (defaulting to `"NZ"`); the four other sovereignty fields are hardcoded.
- **M3 — Vendored envelope validator** at `src/bus/myelin/envelope-validator.ts`, pinned at myelin commit `96b14ea` (no chain-of-stamps array form, no F-021 task fields).
- **M6 — Surface-router** with subject + payload filter matching, render isolation, AbortController-based timeout (`src/bus/surface-router.ts:291-319`).
- **M6 — TrustResolver** with platform-ID-to-agent-ID map + operator-account-signature verifier (`src/common/agents/trust-resolver.ts:268-491`). NKey JWT verification chains to the NSC operator-account signing pubkey (NATS account root, not the human principal).
- **M6 — Pass 1 / Pass 2 trust-mesh wiring** (cortex#105) — agent.trust list drives auto-populated allowlists at adapter startup.
- **M7 — Discord + Mattermost adapters** with per-surface role-resolver. Same authorization policy duplicated per surface.
- **M7 — Dashboard renderer** subscribes to `local.{principal}.>` and projects to a ring buffer / D1; no sovereignty filter on the way in (`src/renderers/dashboard.ts:78-100`).
- **CortexConfig schema** (`src/common/types/cortex-config.ts`) — `operator:` (the principal block; field name `operator` pending cortex#448 rename to `principal`), `agents[]`, `renderers[]`, `nats:`. The principal block has `dataResidency` (`OperatorSchema:99-111`, schema identifier pending cortex#448). Agent has `runtime` block (claude-code / codex / pi-dev / custom + in-process / standalone) — the F-2 substrate seam.

### What cortex is designing but not shipping (designed)

- **cortex#91 SessionHarness** — `SessionHarness` interface with `dispatch(req): AsyncIterable<MyelinEnvelope>`. Two implementations: `ClaudeCodeHarness` (wraps existing cc-session.ts spawn logic), `BusPeerHarness` (publish-dispatch + subscribe-reply pattern sage already implements). Cortex#92 PR has Q5/Q6/Q7 awaiting Andreas confirmation.
- **cortex#102 bot↔bot bus envelopes** — replaces Discord-platform-ID-based bot trust with NKey-signed envelopes verified via TrustResolver. Strategic; depends on cortex#91 substrate-harness landing.
- **cortex#107 PolicyEngine** — `src/common/policy/`. `principals[]` + `roles[]` tables; per-event `PolicyEngine.check(principal, intent)`. Discord/Mattermost adapters thin to ~30 LOC. cortex.yaml flips ONCE at the end of this step (`policy:` block replaces per-adapter `roles[]`). (Here `principal` is already the canonical term — a policy actor resolved from a `signed_by[]` stamp.)
- **cortex#109 envelope-visibility consumption** — stops hardcoding `classification: "local"` at the four emit sites; surface-router honors `sovereignty.classification`; vendored envelope upgraded post-`96b14ea`; per-renderer visibility config; federation accept-rules + peer registry.

### What this synthesis adds (speculative)

- **Multi-network bridge pattern.** One stack participates in two networks — what does it look like in cortex.yaml? (See §3.4.)
- **Principal-private tiers within multi-stack** (Q7 below). Three stacks per principal, one of which is private to the other two stacks but federated to the network. Tiers within tiers.
- **Cross-network audit trail ownership** (Q6 below). When a federated task crosses principal boundaries, the audit envelope chain has multiple principals in the `signed_by` chain — who's the source of truth?

### Hardcoded today / placeholdered

| Where | What | Why it matters |
|---|---|---|
| `src/bus/dispatch-events.ts:73` | `classification: "local"` literal | cortex cannot emit a `federated.*` envelope today; federation has no inbound surface |
| `src/bus/system-events.ts:102` | `classification: "local"` literal | Same |
| `src/bus/github-events.ts:89` | `classification: "local"` literal | Same |
| `src/taps/cc-events/cc-events.ts:99` | `classification: "local"` literal | Same |
| `src/bus/myelin/runtime.ts:236` | Subject hardcoded to `local.${org}.${envelope.type}` (var `org` → `principal` pending cortex#448) | publish-side cannot produce `federated.*` or `public.*` subjects |
| `src/bus/myelin/envelope-validator.ts:22` | `SCHEMA_SOURCE_COMMIT = "96b14ea..."` | Pre-chain-of-stamps, pre-F-021 task fields |
| `src/renderers/dashboard.ts:78-100` | No sovereignty filter in projection pipeline | Federated/public envelopes would render on the principal's dashboard regardless of `classification` |
| `src/bus/surface-router.ts:259-270` | `adapterMatches` runs subject + payload filter, no sovereignty check | Same — no application-layer filter to enforce that a dashboard subscribing to `local.>` doesn't render an inbound `federated.peer-principal.*` event delivered by a leaf-node misconfiguration |
| `src/adapters/discord/role-resolver.ts` (and Mattermost equivalent) | Per-surface `roles[]` with `users[]` (platform IDs) | cortex#107 will move to top-level `policy.principals[]` with `home_operator` field (field name retained pending cortex#448); cortex.yaml stays in its current shape until that PR |

---

## §3 — The composition model

### §3.1 Single stack — one principal, one cortex daemon, N agents

The canonical single-principal stack as `cortex/docs/architecture.md:605-686` specifies it (the `operator:` config block is the principal block — field name pending cortex#448):

```
┌─────────────────────────────────────────────────────────────────┐
│  principal: andreas                                             │
│                                                                 │
│  agents (each hosts one assistant):                            │
│    - luna (Discord presence, persona, trust:[echo,holly,ivy])   │
│    - echo (Discord presence, persona, trust:[luna,holly])       │
│    - forge (Discord presence, persona)                          │
│    - sage (bus-peer harness via cortex#91 BusPeerHarness)       │
│                                                                 │
│  renderers:                                                     │
│    - dashboard (subscribes local.andreas.>)                     │
│    - pagerduty (subscribes local.andreas.system.>)              │
│    - cli-tail (developer tool)                                  │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼ (NATS connection, local.andreas.>)
   ┌────────────┐
   │  NATS      │  All subjects: local.andreas.*
   │  server    │  No leaf-node — air-gapped or single-server
   └────────────┘
```

What ships today:
- Multiple agents in one cortex process — `cortex.yaml.agents[]` is canonical. Each **agent** is a stack-local runtime that hosts exactly one **assistant** (luna, echo, forge, sage).
- Each agent owns its `presence.<platform>` block (Discord, Mattermost). Trust is by logical agent id, never platform user id (`cortex-config.ts:268-291`, coupling rule §9.3).
- TrustResolver provides the runtime platform-ID → agent-id map populated at adapter startup (`trust-resolver.ts:702-715`).
- Renderers are non-agent-bound surfaces (dashboard, pagerduty, cli-tail, webhook-out) declared at top-level (`cortex-config.ts:321-403`).

What sibling issues add at this scope:
- cortex#91 — first-class `runtime.harness: bus-peer` for sage etc. (substrate-harness interface lets agents run out-of-process via NATS, not just in-process via Claude Code spawn).
- cortex#102 — bot↔bot dispatch goes over the bus with NKey-signed envelopes; Discord becomes a presentation surface (dispatch source/sink) only.
- cortex#107 — `roles[]` per-adapter collapses into top-level `policy:` block. The principal is what's resolved, not platform IDs.

### §3.2 Multi-stack per principal — one principal, multiple cortex daemons

One principal can run multiple stacks side-by-side. The principal-facing distinction is concrete:

- **Research stack** — frontier-OK, frontier-only on some agents, no production data residency constraint
- **Production stack** — local-only model class, EU residency, no frontier
- **Code stack** — code-review + deploy capabilities, claude-code substrate
- **Data stack** — etl + analysis capabilities, pi-dev substrate

How do they relate? Three plausible models:

| Model | Subject namespacing | Pros | Cons |
|---|---|---|---|
| **A. Distinct principal IDs per stack** | `local.andreas-research.>` vs `local.andreas-production.>` | Mechanical separation; current cortex code supports it trivially | Loses the principal-level identity primitive; one human, three principal IDs |
| **B. Same principal ID, distinct stack IDs as subdomain** | `local.andreas.research.>` vs `local.andreas.production.>` | Preserves single principal identity | Requires extending the namespace grammar — `{principal}.{stack}.{domain}.{entity}.{action}` is one segment deeper than the original spec |
| **C. Same principal ID, same subject space, distinct agent ids** | `local.andreas.>` shared, agents like `luna-research`, `luna-production` | Minimal config change | No structural separation — anything published is visible to anything subscribed; sovereignty has to do all the work |

Model A is the minimum-viable today. Model B is what the Operator vision calls for (one principal, named-substack composition). Model C accepts that "stack" is a deployment unit but not a routing unit.

**Decision resolved by Q7** (see §5) — Andreas locked `local.{principal}.{stack}.>` as protocol status (Model B), making stack a first-class subject segment.

### §3.3 Multi-principal network — peer-to-peer bus federation via NATS leaf-node

Andreas's IP-routing analogy (`cortex#109` Background) maps onto NATS leaf-node federation as (federation is the default for any cross-principal traffic, per CONTEXT.md — `local.` never crosses the principal boundary):

| OSI / IP concept | Cortex equivalent | Where it lives |
|---|---|---|
| AS / network prefix | the principal id + the `{principal}` segment in subjects | `cortex.yaml.operator:` block (principal block; field name pending cortex#448) |
| Routing table | `policy.federated.peers[]` | NEW — proposed in cortex#109 |
| BGP announce | `<principal>.identity` envelope signed by the NSC operator-account NKey, published (Offer/announce) on `public.principal.>` | NEW — proposed (out of scope for cortex#109) |
| IP packet header | NATS subject prefix + envelope `sovereignty.classification` | Existing — myelin namespace + envelope |
| Router (forwarding) | Surface-router + NATS leaf-node federation | Half-wired (surface-router exists; leaf-node config is principal-side infra) |
| Application gateway | Cortex daemon (one per principal's stack) | Existing |
| Firewall (inbound boundary policy) | Surface-router accept-rules per peer | NEW — part of cortex#109 |

```
┌────────────────────────────┐                ┌─────────────────────────────┐
│  principal: andreas        │                │  principal: jcfischer       │
│                            │                │                             │
│  agents: luna, echo, sage  │                │  agents: ivy, holly         │
│                            │                │                             │
│  renderers: dashboard,     │                │  renderers: dashboard,      │
│             pagerduty      │                │             cli-tail        │
└────────────┬───────────────┘                └─────────────────┬───────────┘
             │                                                  │
             ▼                                                  ▼
   ┌──────────────────┐        leaf-node           ┌──────────────────┐
   │  NATS (andreas)  │ ◄─── federation link ────► │ NATS (jcfischer) │
   │                  │                            │                  │
   │  local.andreas.> │       Only `federated.*.>` │ local.jcfischer.>│
   │  federated.>     │       crosses; `local.>`   │ federated.>      │
   │                  │       does not.            │                  │
   └──────────────────┘                            └──────────────────┘
```

What this requires at each layer:

- **M1 — leaf-node configuration.** Andreas's NATS server and JC's NATS server peer; their leaf-node configs whitelist each other and constrain bridged subjects to `federated.>` only. Principal-side infra; no cortex code.
- **M3 — sovereignty enforcement.** Outbound: cortex#109 unhardcodes `classification: "local"` so envelopes destined for `federated.jcfischer.*` carry `classification: "federated"`. Inbound: `validateSubjectEnvelopeAlignment()` rejects a `federated.*` subject with `local`-classified envelope at parse time.
- **M4 — chain-of-stamps verification.** When Andreas's agent emits a federated task, the envelope `signed_by[0]` is the andreas stack's signing NKey. When JC's agent picks it up and produces a result, JC's stack's NKey is appended as `signed_by[1]`. The chain proves the path; receivers verify against their own principal registries.
- **M6 — peer registry + accept rules.** `policy.federated.peers[]` declares `{operator_id, operator_pubkey, accept_subjects, deny_subjects, max_hop}` (the `operator_id`/`operator_pubkey` field names are pending the cortex#448 rename to `principal_id`/`principal_pubkey`). Surface-router consumes these to gate inbound federated envelopes by peer policy.

This is where cortex#107's PolicyEngine becomes load-bearing for multi-principal: each inbound federated envelope is a `Principal{ id: 'agent-X', home_operator: 'jcfischer' }` (the `home_operator` field name is retained pending cortex#448; semantically it is the home principal); the PolicyEngine resolves it via `policy.principals[]` (which now spans multiple home principals) and applies the receiver's per-peer accept/deny rules.

### §3.4 Multi-network — separate networks, not per-peer capability scoping (Q4 LOCKED-IN)

**Q4 lock-in (2026-05-13 Andreas):** *Use separate networks rather than one stack bridging two networks with per-peer capability scoping. Each network is its own subject namespace + policy domain. A "bridge stack" simply participates in network A AND network B (two independent network memberships, two separate cortex.yaml peer-registry entries). Simpler than per-peer capability differentiation within one network.*

A stack joins multiple networks simultaneously by maintaining multiple NATS leaf-node connections, each scoped to a different peer mesh. Each network is structurally independent — distinct subject namespace, distinct policy domain, distinct peer registry. Per the Operator-vision script:

> "Some stacks bridge between networks — your stack participates in two different collaborations, publishing certain capabilities to one network and different capabilities to the other."

The locked-in answer collapses the previous "per-peer capability scoping" question: capability scoping happens at the **network boundary** (one cortex.yaml entry per network membership), not at the **per-peer** boundary inside a shared network. Mechanically:

```
                                           ┌──────────────────┐
                                           │  Network A       │
                                           │  (research mesh) │
                                           └────────▲─────────┘
                                                    │
                                                    │ leaf-node A
                                                    │  (network A's peer registry)
                       ┌──────────────────┐         │
                       │  bridge stack    │─────────┘
                       │  principal: andreas       │
                       │                  │
                       │  agents: luna, echo, sage │
                       │                  │─────────┐
                       └──────────────────┘         │
                                                    │ leaf-node B
                                                    │  (network B's peer registry)
                                           ┌────────▼─────────┐
                                           │  Network B       │
                                           │  (JV mesh)       │
                                           └──────────────────┘
```

What the lock-in changes from the prior framing:

1. **Subjects per network.** Each network is its own namespace; `federated.{principal}.{stack}.>` belongs to one network membership. No per-peer subject filtering within a network is required.
2. **Capability announcements per network.** Q2's stack-level capability schema (constrained `cortex.yaml`) is declared once per network membership, not per peer within a network. Bridge stacks declare two memberships, two capability sets.
3. **Policy slice per network.** `policy.federated.networks[]` (preferred ergonomics, see Phase E plan) replaces `policy.federated.peers[]` as the top-level structure. Each network entry carries its own peer registry, accept rules, and `leaf_node` reference.

A workable cortex.yaml strawman post-Q4 lock-in:

```yaml
# `operator:`, `operator_id`, `operator_pubkey` keys below are the principal block /
# principal id / principal pubkey — config-key renames tracked under cortex#448.
operator: { id: andreas }     # the principal
stack: { id: andreas/research, nkey_pub: SAA… }

policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research
        peers:
          - operator_id: jcfischer        # peer principal id
            stack_id: jcfischer/sage-host
            operator_pubkey: O_JC_…        # peer principal pubkey
        accept_subjects: ["federated.research-collab.tasks.code-review.*"]
        announce_capabilities: ["code-review", "security-scan"]
        max_hop: 1
      - id: jv-acme-bigcorp
        leaf_node: nats-leaf-jv
        peers:
          - operator_id: acme
            stack_id: acme/deploy-host
            operator_pubkey: O_ACME_…
          - operator_id: bigcorp
            stack_id: bigcorp/release-host
            operator_pubkey: O_BIGCORP_…
        accept_subjects: ["federated.jv-acme-bigcorp.tasks.deploy.*"]
        announce_capabilities: ["deploy", "release"]
        max_hop: 0  # JV is fully gated — no further hops
```

The `leaf_node` field references a named NATS connection (principal-side infra config) — this is where the structural separation between networks lives. **A bridge stack has multiple `NatsLink`s simultaneously open**, one per leaf-node. Cortex's current `MyelinRuntime` has a single link (`runtime.ts:142-169`); supporting multi-network requires either multiple runtimes per cortex process or extending the runtime to manage a link pool.

### §3.5 Private / isolated / public mesh varieties

From the Operator-vision script: "Some stacks are private. No connections. ... Others join isolated private networks — four companies working on a joint venture ... And some stacks bridge between networks..."

Mapping to concrete configurations:

| Mesh variety | Principal example | NATS topology | cortex.yaml shape |
|---|---|---|---|
| **Bank private** | Single bank, no federation at all | NATS server with no leaf-nodes; firewalled | `policy.federated.peers: []` — empty registry |
| **JV isolated-private** | 4 companies, mesh between, no external | Each company's NATS server has leaf-nodes to the other 3; no public bridge | Each peer's `policy.federated.peers[]` lists the other 3 with bidirectional accept_subjects; the `{principal}` segment becomes the JV's negotiated namespace |
| **Bridge** | One stack participates in 2 distinct networks | 2 leaf-nodes per cortex process (see §3.4) | `policy.federated.peers[]` has 2 entries with distinct `leaf_node:` references |
| **Public mesh** | "Come find me" capability marketplace | Each stack advertises capabilities on `public.principal.*.capability.>`; matching is by capability tag | `policy.public.announce_capabilities[]` (NEW — out of scope today) |
| **Hybrid** | Principal has private agents + some federated agents | Some agents emit `local.>` only; others emit `federated.>` per task; the principal's policy decides per-agent | Per-agent `default_classification` could parameterise this (NEW) |

The **private mesh case (bank)** is the simplest: it's just §3.1 with explicit confirmation that no `federated.*` subjects ever cross leaf-nodes. The most important property is that this is mechanically enforced at M1 (leaf-node config), not at M6 (application policy) — so cortex.yaml never accidentally federates because no leaf-node exists.

The **isolated-private mesh (JV)** is the interesting middle case. The 4 JV members need:
- A negotiated `{principal}` segment to name the JV (e.g. `acme-bigcorp-jv`).
- Each member's NSC operator-account key as a co-equal trust anchor in the JV's principal registry.
- An off-bus negotiation channel for the leaf-node peering and capability declarations.

The **public mesh** future case is out of scope today — it requires myelin#9 (L5 discovery) and a marketplace economics model neither of which are in flight.

### §3.6 Delegation patterns — networks as composed capability (Phase E)

Andreas surfaced an additional composition pattern in the 2026-05-13 Q1–Q7 lock-in conversation:

> "One network could be a composition of capability, and it might be a delegation. Even so, I can see both networks where you're interacting with an orchestrator. It's like your router that will then delegate out to other networks and stacks to get work done. ... your main digital assistant that will then delegate around and coordinate on your behalf by leaning into these different networks and stacks depending on their capability."

This is the **orchestrator-assistant pattern** — a stack hosts an agent whose role is to delegate, not to do; the assistant it hosts (e.g. luna) is the principal's main digital assistant. The orchestrator sees the network capability registry (Q2), dispatches inbound work (Delegate mode) to whichever network/stack has the matching capability, and threads results back via the chain-of-stamps audit trail (Q6).

Mechanically:

```
                                   ┌────────────────────────────────┐
                                   │  Orchestrator agent (hosts     │
                                   │  assistant luna)               │
                                   │  on stack: andreas/research    │
                                   │                                │
                                   │  - Reads capability registry   │
                                   │  - Picks target network/stack  │
                                   │  - Emits federated.* envelope  │
                                   │  - Waits for chain-of-stamps   │
                                   └─────────────┬──────────────────┘
                                                 │ federated.{network}.tasks.{cap}
                          ┌──────────────────────┼──────────────────────┐
                          ▼                      ▼                      ▼
              ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
              │  Network: research  │ │  Network: code-rev  │ │  Network: deploy    │
              │  (capability:       │ │  (capability:       │ │  (capability:       │
              │   literature-srch)  │ │   typescript-rev)   │ │   k8s-deploy)       │
              └─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

Building blocks (all of which exist or are scheduled in the IAW plan):

| Building block | Source | Phase |
|---|---|---|
| Network capability registry | Q2 lock-in (cortex.yaml schema, aggregated cross-network) | Phase A (schema) + Phase D (network-side aggregation) |
| Outbound federation envelope | cortex#109 §E + cortex#107 multi-principal dashboard | Phase D |
| Chain-of-stamps audit | Q6 lock-in (signed_by[] per envelope) | Phase B (consume) + Phase D (cross-network) |
| Competing-consumer claim | Q5 lock-in (NATS queue groups, claim-first-wins) | Phase A foundation + Phase E multi-network |
| Multi-network MyelinRuntime | §3.4 (one stack, N leaf-nodes) | Phase E |
| Orchestrator decision logic | Per-agent application code (cortex#91 substrate harness contract) | Phase A enables; Phase E productionises |

This is a **Phase E capability**, not Phase A. Phase A only needs to make the capability registry mechanically accessible; the orchestrator agent itself is application logic on top of the substrate (cortex#91) + chain-of-stamps (cortex#102) + per-network policy (Phase D peer registry). The pattern is what justifies the multi-network design over per-peer scoping (§3.4) — orchestration agents need clean network boundaries to reason about delegation.

The orchestrator pattern is what gives principals the "main digital assistant that coordinates on your behalf" mental model — the same primitive that the Phase A substrate harness exposes per-agent now becomes a meta-capability across the principal's full federated graph.

### §3.7 Config split — layering cortex.yaml by blast radius (foundation)

Everything above assumes one config file per stack. Today that file — `~/.config/metafactory/cortex/cortex.yaml` — is **~911 lines** and has quietly grown into the *whole-environment* config. It mixes, in one document:

- **principal + stack identity** (`operator:` block / `stack:` block — names pending cortex#448),
- the **capability catalog** (Q2's `capabilities:` schema),
- a **~470-line policy block** (Q-locked `policy.principals[]` / `roles[]` / `policy.federated.networks[]`),
- **agents + surface bindings** (each agent's `presence.<platform>` with its bot/app token + guild/team),
- **system / substrate** knobs (`claude`, `execution`, `attachments`, `paths`, `nats`, `bus`),
- and the **federation roster** (peer/network registry, Q3/Q4).

These have wildly different **lifecycles and blast radii**. The `nats.subjects` patterns and the surface bindings are the most dangerous lines in the file — get a subject pattern wrong and you arm the **double-delivery landmine** (two subscriptions matching the same subject → every envelope rendered twice); get a surface binding wrong and a stack posts to the wrong guild. Yet they sit inches from routine edits like adding an aphorism capability or tweaking a role. A single fat file means a wrong edit anywhere risks a transport-level fault everywhere. This is exactly the coupling CONTEXT.md warns against — the transport knobs (M2) and the surface gateway bindings (M7) should not share an edit surface with M6 policy.

**Proposal — split by blast radius into layered files composed at boot:**

| File | Owns | Blast radius | Lifecycle |
|---|---|---|---|
| `system.yaml` | substrate: `claude` / `execution` / `attachments` / `paths` / `nats` / `bus` — **the dangerous transport knobs** | Whole stack: a wrong `nats.subjects` here is the double-delivery landmine | Rarely edited; changes are reviewed transport changes |
| `network.yaml` | federation roster + hub leaf-remote (`policy.federated.networks[]`, peer registry, `leaf_node` references) | Cross-principal: a wrong peer pubkey breaks federation trust | Edited when joining/leaving a network |
| `surfaces.yaml` | the shared **surface-gateway bindings** — bot/app token per platform + `{surface-instance → stack}` map (see §3.8) | Cross-stack: one wrong binding mis-routes a whole guild | Edited when a stack joins/leaves a surface instance |
| `stacks/<name>.yaml` | per-deployment: stack identity, capabilities, `policy` (`principals` / `roles` / `access`), agents **without** surface token/guild | One stack only | Edited for routine per-stack work |

The split is the structural expression of the layer model: `system.yaml` is M1/M2, `network.yaml` is M1/M4 federation, `surfaces.yaml` is M7 gateway, `stacks/<name>.yaml` is M6 policy + assistant/capability declaration. **Per-deployment differences stay per-stack** — which is correct: two stacks under one principal legitimately differ in capabilities, policy, and agents, and nothing forces them to share those.

**Backwards-compatible multi-file composer.** A boot-time composer reads the layered files (with `stacks/<name>.yaml` selected by the running stack id) and merges them into the same in-memory `LoadedConfig` cortex builds today. A single monolithic `cortex.yaml` still works transitionally — the composer detects it and treats it as all-layers-in-one. **The composed result is byte-for-byte equivalent to today's `LoadedConfig`**, so no downstream code changes; this is a config-ingestion refactor, not a schema flip. It slots cleanly *before* the Phase C schema flip (it reorganises where keys live, it does not rename them) and gives the Phase C `policy:` flip a smaller, safer file to land in.

### §3.8 Shared surface gateway — one assistant, many deployments

CONTEXT.md states the principle directly: an assistant is *"the same assistant, different agent surfaces"*, and *"surfaces are sources/sinks, not the medium — the bus is the medium."* §3.8 is what that principle forces at the process level once a principal runs multiple stacks (§3.2) that all answer on the same Discord bot.

**The hard platform constraint.** One Discord **bot** is one application, one token, one bot user. Discord allows exactly **one gateway connection per token** (`shardCount=1` for our scale), and that bot is a member of many guilds. So if each per-stack daemon opens its *own* gateway connection with the *same* bot token, the connections **collide** — Discord disconnects them in turn and the bot flaps (the same class of failure as the double-delivery landmine, but at the platform layer instead of the bus layer). Per-stack adapters with a shared token are structurally unsound. (Slack and Mattermost have the analogous one-socket-per-app-token constraint.)

**Build — a shared surface-gateway process, one per platform per bot:**

```
            ┌──────────────────────────────────────────────┐
            │  surface-gateway (discord)                    │
            │  ONE gateway connection (one-per-token)       │
            │  member of all bound guilds                   │
            │  instance→stack resolver (guild → stack)      │
            └───────────┬───────────────────────┬──────────┘
              inbound    │                       │   outbound
   guild msg → publish   │                       │   subscribe bound stacks'
   tasks.@{assistant}.chat                       │   dispatch.task.* (lifecycle/verdict)
                         ▼                       ▲
        ┌────────────────────────────────────────────────────┐
        │                      BUS (medium)                   │
        └───────┬──────────────────┬──────────────────┬──────┘
                ▼                  ▼                  ▼
       stack: andreas/meta   stack: andreas/work  stack: andreas/halden
       (surface-bus-only — no per-stack platform connection)
```

- **One connection.** The surface-gateway holds the single gateway connection for the bot, is a member of all bound instances, and routes `instance ↔ stack` over the bus.
- **Inbound.** A guild message resolves to its target stack and is published as a canonical Direct/chat envelope on `local.{principal}.{stack}.tasks.@{assistant}.chat` (or `federated.…` when the message is peer-addressed — cross-principal traffic stays on `federated.` per CONTEXT.md). Exactly **one** inbound publish per platform message.
- **Outbound.** The gateway subscribes to every bound stack's lifecycle/verdict envelopes (`dispatch.task.{started|completed|failed|aborted}`) and renders each to the right instance. **Response routing** extends from `{surface, channel, thread}` to add an `{instance}` field so the gateway knows *which* guild/workspace/team to deliver into.
- **Surface-agnostic.** Only the **instance→stack resolver** is platform-specific (Discord guild / Slack workspace / Mattermost team); the bus stays platform-neutral. The same gateway shape drops onto any platform by swapping the resolver.
- **Stacks become surface-bus-only.** Per-stack platform adapters retire — a stack no longer opens any Discord/Slack/Mattermost connection; it is a pure dispatch source/sink on the bus. This is what `surfaces.yaml` (§3.7) configures: the bot/app token lives once in the gateway, and the `{instance → stack}` map is the gateway's routing table.

**This structurally eliminates double-posting.** With one connection and exactly one inbound publish per message, there is no second subscription to render a duplicate and no second socket to flap — the failure mode is designed out, not patched around.

**Trade-off vs. separate-bot-per-stack.** The alternative is ready today with no build: give each stack its *own* Discord bot (its own token, its own application). That works immediately — distinct tokens never collide — at the cost of N bot users in the guild (one per stack), N sets of permissions to manage, and a fragmented presence ("which luna do I @ "). The shared surface gateway is the right long-term shape — one assistant, one bot identity, many backing stacks — but it is a real build (the gateway process + the resolver + the response-routing `{instance}` extension + retiring per-stack adapters). Separate-bot-per-stack is the pragmatic interim if a principal needs multi-stack on a shared platform *before* the gateway lands.

---

## §4 — Sibling-issue assembly

For each of cortex#91, #102, #107, #109: which layer it occupies, what it contributes to the composition model, what it depends on, what depends on it.

### cortex#91 — Substrate harness (multi-LLM dispatch)

**Layer:** M6 — application logic core. The `SessionHarness` interface lives at the boundary between cortex's runner and any execution substrate (Claude Code, Codex, Cursor, Mistral, pi.dev, NATS bus-peer).

**Contribution to composition:** Cortex stops being Claude-Code-only. With `BusPeerHarness`, an agent can be ANY out-of-process daemon that speaks the myelin envelope contract on the bus — including sage today and Codex/Cursor/Gemini tomorrow. This is the foundation for multi-stack composition (§3.2) because a "stack" can now compose stateful peer daemons running in their own processes, not just spawn child processes.

**Dependencies:**
- *Depends on:* M2 (MyelinRuntime, shipped) + M3 (envelope schema, shipped).
- *Depended on by:* cortex#102 (BusPeerHarness is where chain-of-stamps verification of inbound dispatch envelopes happens). cortex#107 (the dispatch-handler that calls into `SessionHarness.dispatch()` is where PolicyEngine.check happens).

**Open questions cortex#91 needs answered:** Q5/Q6/Q7 in cortex#92 PR (substrate harness design doc). These are scoped to the substrate interface and are independent of this synthesis.

### cortex#102 — Bot↔bot via bus envelopes (NKey identity)

**Layer:** L3/L4 (envelope + identity). Bot identity moves from Discord-platform-ID gating (M7, surface-layer) to NKey-signed envelopes (L4, cryptographic).

**Contribution to composition:** This is the issue that makes cross-principal trust work at all. Per the Operator vision: "An agent on my stack and an agent on yours can both see the same task" — both agents need verifiable identity, and the trust anchor cannot be Discord (which is principal A's surface only; principal B doesn't see Discord IDs).

The chain-of-stamps `signed_by[]` (shipped in myelin post-#31) is the carrier:
- `signed_by[0]` = originating agent's NKey signature.
- `signed_by[N]` = each forwarding agent appends its own NKey signature.
- Receivers verify each stamp against their principal registry (cortex#107's `policy.principals[]`).

**Dependencies:**
- *Depends on:* cortex#91 (BusPeerHarness is where `signed_by` verification happens on inbound dispatch) + myelin-shipped chain-of-stamps + cortex#76 TrustResolver (operator-account-signature verifier).
- *Depended on by:* cortex#109 phase E (federation accept-rules — peer agents identified by signed envelopes); cortex#107 PolicyEngine (principal resolution from `signed_by[].principal` field).

**Open questions cortex#102 needs:** Q1 (how does a stack declare its OWN identity? — NSC operator-account NKey vs principal id vs both?). This is what makes the `home_operator` field (the home-principal field; name pending cortex#448) in cortex#107's principal table meaningful.

### cortex#107 — Principal-based AAA at dispatch-handler

**Layer:** M6 — application logic core. PolicyEngine is the single decision point for "what is this principal allowed to do?" — replacing per-surface duplication.

**Contribution to composition:** This is the issue that flips cortex.yaml's auth model from per-adapter `roles[]` to top-level `policy:{ principals[], roles[] }`. The `home_operator` field on each principal (field name pending cortex#448; it is the home-principal id) is what makes multi-principal dashboards work (one cloud renderer can serve N principals because it slices events by `home_operator`).

cortex.yaml schema flips ONCE at the end of this step. Per cortex#107 §"Migration scope" steps A-G, the per-adapter `roles[]` go away in step D; `policy:` block is added in step C. This is the only schema flip in the whole roadmap — every other sibling issue is additive, not flipping.

**Dependencies:**
- *Depends on:* cortex#91 (`Principal` object passed to `SessionHarness.dispatch()`); cortex#109 §A+B (sovereignty consumption — PolicyEngine reads `envelope.sovereignty` as part of decision input).
- *Depended on by:* cortex#107 §H (multi-principal cloud dashboard — the cloud renderer reuses the same PolicyEngine the local daemon uses); cortex#109 §E (federation accept-rules consume PolicyEngine for per-peer decisions).

**Open questions cortex#107 needs:** Q5 (competing-consumer semantics — when a federated task arrives, who picks first? PolicyEngine decides on the basis of capability tags and queue-group semantics).

### cortex#109 — Envelope-visibility composition (G-1110 + federation foundation)

**Layer:** L3/L4 routing primitives. Three-tier `sovereignty.classification` consumption (M3) + NATS leaf-node federation (M1) + surface-router accept rules (M6).

**Contribution to composition:** Without cortex#109, cortex literally cannot emit a `federated.*` or `public.*` envelope — the four emit sites hardcode `local`. This issue is the unblocker for multi-principal scenarios. It also wires the dashboard's visibility filter so a principal subscribing to `local.{principal}.>` doesn't accidentally render an inbound federated envelope from a peer.

cortex#109's own phasing:
- A: Stop hardcoding `classification: "local"`.
- B: Surface-router honours `sovereignty.classification` (renderer visibility config).
- C: Upgrade vendored envelope past `96b14ea` (post-F-021 fields).
- D: Per-renderer visibility config in `cortex.yaml`.
- E: Federation accept-rules + peer registry — pairs with cortex#107.
- F: Dashboard surfaces classification + residency on cards (G-1110 UI).

Phases A+B can ship independently (before cortex#91 even lands) per cortex#109 §"Implementation slice".

**Dependencies:**
- *Depends on:* myelin-shipped sovereignty.classification + namespace alignment validators.
- *Depended on by:* cortex#107 phase D+E (PolicyEngine consumes `envelope.sovereignty`; peer registry uses PolicyEngine's per-peer accept rules).

**Open questions cortex#109 needs:** Q2 (per-renderer visibility config vs top-level `policy.visibility`); Q3 (when to upgrade vendored envelope past `96b14ea`); Q4 (sequencing vs cortex#107).

### Dependency graph (ASCII)

```
                       ┌──────────────────────────┐
                       │  myelin-shipped:         │
                       │  - sovereignty schema    │
                       │  - chain-of-stamps       │
                       │  - namespace spec        │
                       │  - F-021 task fields     │
                       └────────────┬─────────────┘
                                    │ consumed by
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
   ┌──────────────────────┐               ┌──────────────────────┐
   │ cortex#109 §A+B+C+D  │               │ cortex#91 (substrate │
   │ (unhardcode classif.,│               │ harness — Session-   │
   │ surface-router       │               │ Harness + bus-peer)  │
   │ visibility filter,   │               └──────────┬───────────┘
   │ vendored upgrade)    │                          │
   │ — Phase A foundation │                          │ enables
   └──────────┬───────────┘                          ▼
              │              ┌───────────────────────────────────┐
              │              │ cortex#102 (bot↔bot via NKey-     │
              │              │ signed envelopes; chain-of-stamps │
              │              │ verification on inbound dispatch) │
              │              │ — Phase B identity                │
              │              └────────────┬──────────────────────┘
              │                           │
              │                           ▼
              │              ┌───────────────────────────────────┐
              └─────────────►│ cortex#107 (PolicyEngine at M6;   │
                             │ cortex.yaml policy: block; per-   │
                             │ principal home_operator field)    │
                             │ — Phase C policy (SCHEMA FLIP)    │
                             └────────────┬──────────────────────┘
                                          │
                                          ▼
                             ┌───────────────────────────────────┐
                             │ cortex#109 §E (federation accept- │
                             │ rules + peer registry) +          │
                             │ cortex#107 §H (multi-principal    │
                             │ cloud dashboard)                  │
                             │ — Phase D federation              │
                             └────────────┬──────────────────────┘
                                          │
                                          ▼
                             ┌───────────────────────────────────┐
                             │ Phase E: multi-network bridges    │
                             │ (per-peer leaf-node + per-network │
                             │ capability announcement)          │
                             └───────────────────────────────────┘
```

---

## §5 — Seven design questions — all locked in 2026-05-13 (Andreas)

All seven questions resolved by Andreas on 2026-05-13. The verbatim answers below are the principal-locked design (preserved verbatim — the quoted answer blocks retain Andreas's original wording, including "operator"); the prior architect recommendations have been replaced. Implementation now follows from these answers — see `docs/plan-internet-of-agentic-work.md`.

### Q1: How does a stack declare its OWN identity? [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Format `{operator_id}/{stack_id}` (slash-separated, like git refs). Examples: `andreas/research`, `andreas/production`, `jcfischer/sage-host`. NATS subject form: `local.{operator}.{stack}.>` and `federated.{operator}.{stack}.>`. Cryptographic chain: operator-account-NKey → stack-NKey → agent-NKeys. Uniqueness: operator-id is the authority root (one per operator, enforced by the network registry); sub-stacks unique within an operator's namespace. Default: `{operator_id}/default` if operator declares only one stack. Like email but without TLD baggage.*

Implications captured into the synthesis (the verbatim answer's `{operator_id}` token is the **principal** id; the literal format string is kept as the locked decision, with the rename to `{principal_id}` tracked under cortex#448):

- **Stack identity = `{operator_id}/{stack_id}`** (i.e. `{principal}/{stack}`) — a single string with git-ref semantics. Replaces the prior "principal id" / NSC operator-account NKey pairing as the canonical surface identifier.
- **NATS subject form grows a stack segment** — `local.{principal}.{stack}.{domain}.{entity}.{action}` and the `federated.{principal}.{stack}.>` counterpart. This is the Q7 lock-in materialised at the wire layer.
- **Cryptographic chain is three-tier** — NSC operator-account NKey signs stack NKey signs agent NKeys. The stack NKey becomes the per-envelope signing key on the outbound side; the operator-account NKey roots trust in the network registry (Q3).
- **Uniqueness:** the principal id is unique network-wide (enforced by the cloud-side network registry, Q3); stack-id is unique within a principal's namespace.
- **Default convention:** a principal with one stack declares it as `{principal}/default`; no manual stack declaration needed.

**Blocks:** cortex#102 (NKey identity carrier on the bus), cortex#107 §H (cloud dashboard `home_operator`/`home_stack` fields — names pending cortex#448), the Phase A cortex.yaml `stack:` block addition.

### Q2: How does a stack announce its CAPABILITIES to a network? [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Two-part: (a) network capabilities = aggregated across all agents in all stacks part of the network; (b) operator can ALSO declare stack-level capabilities (and per-agent capability annotations) in cortex.yaml using a constrained schema — defined interface, NOT free text. "Keep it simple." Schema covers: capability id, description, tags (e.g., language tags), provided_by agent ids, optional rate/cost.*

Implications captured into the synthesis:

- **Two-layer capability model:**
  - **Network capabilities** (top layer) = aggregated view across every agent in every stack in the network. Computed by the network's registry (Q3) from the union of member stacks' declared capabilities.
  - **Stack capabilities** (principal layer) = declared in each principal's `cortex.yaml` under a `capabilities:` block. Per-agent annotations are first-class; the stack-level set is the union of its agents' annotations plus any stack-level extras.
- **Schema is constrained**, not free-text JSON. Required fields:
  - `id` — slug, network-stable (e.g. `code-review.typescript`, `literature-search.medline`).
  - `description` — short human-readable summary.
  - `tags[]` — taxonomic tags including language tags (`typescript`, `python`, etc.), domain tags, modality tags.
  - `provided_by[]` — list of agent ids inside the stack that provide this capability.
  - `rate` *(optional)* — rate envelope (requests per unit time).
  - `cost` *(optional)* — cost envelope (cents per request, or token-class pricing).
- **"Keep it simple"** — no free-text capability declarations. Schema-bounded so the network registry (Q3) can index capabilities deterministically and orchestrator agents (§3.6) can reason about delegation without natural-language disambiguation.

**Blocks:** cortex#109 §E peer registry; Phase A `capabilities:` block in cortex.yaml; future myelin#9 L5 discovery (consumer side).

### Q3: How does a network REGISTRY work? [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Centralised config. NOT gossiped via NATS. Operators declare their peers + the network's roster in cortex.yaml (or a sibling registry config file). Cloud-side network registry service hosts the canonical pubkey directory for cross-operator discovery (sits adjacent to the cloud dashboard, see cortex#107 Step H).*

Implications captured into the synthesis:

- **Centralised, declarative registry.** Principals edit their peer/network membership in `cortex.yaml` (or a sibling config file colocated with cortex.yaml). No NATS gossip path; the registry is config, not protocol traffic.
- **Cloud-side network registry service** hosts the canonical pubkey directory across principals. Sits adjacent to the cloud dashboard (cortex#107 Step H) — same hosting boundary, same trust anchor. Principals read from it (to discover peers) and write to it (to publish their stack identity and capability surface). The "Internet" in *Internet of Agentic Work* is the registry plus the federated NATS mesh; the registry resolves principal id ↔ pubkey across the network.
- **No gossip via NATS.** The IP/BGP analogue was considered and rejected for v1 — the registry is a service, not a protocol. This keeps Phase D scoped to the federation primitive itself; gossip is a future evolution if scale demands it.
- **Identity flow:** principal → cloud-side registry (publish NSC operator-account NKey + stack identities + capability declaration) → other principals' cortex daemons read registry at startup + on schedule → local cortex.yaml peer entries reference the registry-discovered pubkeys by principal id.

**Blocks:** cortex#109 §E peer registry (now config-driven, not gossip-driven); cortex#107 §H (the cloud-side registry service is the natural home alongside the multi-principal dashboard). Phase D scope.

### Q4: Bridge-stack capability scoping — different capabilities per peer-network [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Use separate networks rather than one stack bridging two networks with per-peer capability scoping. Each network is its own subject namespace + policy domain. A "bridge stack" simply participates in network A AND network B (two independent network memberships, two separate cortex.yaml peer-registry entries). Simpler than per-peer capability differentiation within one network.*

Implications captured into the synthesis (full schema in §3.4 above):

- **Bridge stacks are stacks with multiple memberships**, not stacks with per-peer-scoped capabilities. Each network entry is independent; the stack participates in N networks by declaring N entries.
- **`policy.federated.networks[]`** replaces the prior `policy.federated.peers[]` framing. Each network entry carries:
  - `id` — network slug.
  - `leaf_node` — named NATS connection (principal-side infra config).
  - `peers[]` — peer principal/stack list within this network.
  - `accept_subjects[]` / `deny_subjects[]` — per-network policy slice.
  - `announce_capabilities[]` — capability subset this network sees.
  - `max_hop` — per-network hop budget.
- **Multi-link MyelinRuntime is required** (one NatsLink per `leaf_node`) — already a Phase E exit-criterion (§6).
- **Capability scoping becomes per-network**, not per-peer. The Q2 stack-level capability schema declares the full capability surface; each network membership picks a subset to announce. No per-peer-within-network differentiation — networks ARE the granularity.

**Blocks:** Phase E (multi-network bridges); shape of the Phase C `policy.federated.networks[]` schema.

### Q5: Competing-consumers semantics on federated tasks [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Option A — NATS queue groups (claim-first-wins at the bus layer). When multiple stacks subscribe to `federated.*.tasks.code-review.typescript`, one wins per task. No reservation protocol; no auction.*

Implications captured into the synthesis:

- **Claim-first-wins via NATS queue groups.** JetStream queue groups already specified in `myelin/specs/namespace.md:216-247`; the protocol is "first consumer in the group to ack wins per task". No new envelope semantics required.
- **No reservation protocol.** The losing consumers don't see the message at all (queue group delivers to exactly one); no need for a `claim.@principal` envelope to coordinate withdrawals.
- **No auction.** Marketplace dynamics are explicitly out of scope. If a future capability-marketplace evolves, it's a separate protocol layered on top — not a substitute for queue groups.
- **Cross-reference cortex#92** (cortex#91 substrate harness design PR) — Q5 there should reconcile with this lock-in; if cortex#92 lands a different competing-consumer model for in-process dispatch, that's an inconsistency to flag.

**Blocks:** cortex#107 (PolicyEngine's resolution rule consults queue-group membership, not principal scoring); Phase E (multi-network — queue groups are per-subject, naturally per-network).

### Q6: Cross-network audit — who owns the audit trail? [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *Recommendation A — chain-of-stamps via Myelin's `signed_by[]` array. Each stack the envelope passes through adds its signature. Audit trail is the signed chain. Unique ID per envelope; stack identity in the chain answers "where did this go?"*

Implications captured into the synthesis:

- **Chain-of-stamps IS the audit trail.** Each stack the envelope crosses adds its `signed_by[]` entry. Cryptographic provenance is the audit record — no separate audit subject, no centralised audit service.
- **Stack identity** (Q1 — `{operator_id}/{stack_id}`, i.e. `{principal}/{stack}`) is what each stamp carries. Reading `signed_by[]` answers "this envelope passed through stacks A, B, C in that order."
- **Unique envelope ID** combined with the chain provides full traceability across networks. Each principal can grep their local audit (their `signed_by[i]` entry) and reconstruct the cross-network path via stamp ordering.
- **No central authority required** — each principal owns their slice of the audit (per Q3, the cloud-side registry holds identity, not transit traffic). Cross-principal forensics rebuild from the local audits combined.
- **Principal sovereignty preserved.** No federated audit subject leaks across principal boundaries; no central service sees all traffic; each principal's view is bounded by what their stack actually handled.

**Blocks:** Phase D (federation) — the audit story is what gets asked first in any compliance review. The Phase B chain-of-stamps consumption is the prerequisite that makes this audit pattern observable.

### Q7: Stack as protocol primitive [LOCKED-IN — 2026-05-13 Andreas]

**Verbatim answer:** *YES. Extend the subject namespace with a stack segment. The "stack" is a first-class noun in the protocol. NATS subjects become `local.{operator}.{stack}.{domain}.{entity}.{action}` (3-segment authority prefix). cortex.yaml grows a `stack:` block declaring the operator-owned stack identity. Cortex daemon = "I host the stack `andreas/research`." Multiple stacks per operator = multiple cortex daemons OR a single cortex daemon hosting multiple stacks (Phase E design decision).*

Implications captured into the synthesis:

- **Stack is a first-class protocol primitive.** NATS subject grammar grows a stack segment: `local.{principal}.{stack}.{domain}.{entity}.{action}` for local, `federated.{principal}.{stack}.{domain}.{entity}.{action}` for federated. The 3-segment authority prefix replaces the 2-segment `{principal}.{domain}` form.
- **cortex.yaml `stack:` block.** New top-level config field:
  ```yaml
  stack:
    id: andreas/research          # matches Q1 format
    nkey_pub: SAA…                # stack NKey, signed by the NSC operator-account NKey
  ```
- **Cortex daemon = stack host.** A running cortex process declares "I host stack X". The cortex.ts entrypoint registers the stack identity at boot and uses it for every outbound envelope's `signed_by[0]` entry.
- **Multi-stack per principal** — Phase E design decision whether multiple stacks share a cortex daemon (lower process count, more complex isolation) or each stack runs its own daemon (cleaner isolation, more processes). Both wire-compatible.
- **Backward compatibility:** if `cortex.yaml.stack` is not declared, default to `{principal}/default`. Existing deployments migrate without explicit principal action.
- **Myelin namespace coordination** — this changes the wire grammar; requires a myelin issue to update `specs/namespace.md`. File as Phase A blocker (or Phase A.5 if myelin needs lead time). Cortex's vendored envelope upgrade (cortex#109 §C, Phase A.2) is the natural ride-along moment.

**Blocks:** Phase A (cortex.yaml `stack:` block); Phase A.5 (myelin namespace extension); Phase C (cortex.yaml schema flip is the last natural moment to absorb the stack-aware namespace without re-flipping).

### Summary of Q1–Q7 status — all locked in 2026-05-13 (Andreas)

| Q | Lock-in summary | Phase impact |
|---|---|---|
| Q1 | `{operator_id}/{stack_id}` slash-form identity; three-tier NKey chain (account → stack → agents); operator-id authority root | Phase A (`stack:` block in cortex.yaml); Phase B (chain-of-stamps verification); Phase C (`policy.principals[]` carries `home_operator` + `home_stack`) |
| Q2 | Two-layer capabilities: aggregated network capabilities + constrained-schema stack-level declaration in cortex.yaml | Phase A (`capabilities:` schema); Phase D (network aggregation) |
| Q3 | Centralised cortex.yaml declaration + cloud-side network registry service alongside cortex#107 Step H dashboard; NOT NATS-gossiped | Phase D (peer registry + cloud registry service) |
| Q4 | Separate networks, not per-peer-within-network scoping; bridge stack = multiple network memberships | Phase E (multi-link MyelinRuntime + `policy.federated.networks[]`) |
| Q5 | NATS queue groups (claim-first-wins at bus layer); no reservation, no auction | Phase A (queue-group provisioning); Phase E (per-network queue groups) |
| Q6 | Chain-of-stamps IS the audit; each stack stamps the envelope; principal-partitioned with cryptographic correlation | Phase B (chain-of-stamps consume); Phase D (cross-network audit observable) |
| Q7 | Stack is first-class protocol primitive; namespace extends to `local.{principal}.{stack}.>` and `federated.{principal}.{stack}.>` | Phase A (cortex.yaml `stack:` block + myelin namespace extension) |

---

## §6 — Sequenced implementation roadmap

Five phases A–E. The cortex.yaml schema flips exactly ONCE — at the end of Phase C. Every other phase is additive or refactor-without-schema-change.

### Phase A — Foundation (independent works)

**Scope:** cortex#91 substrate harness + cortex#109 §A+B (visibility consumption).

These two are independent. cortex#91 lands the `SessionHarness` interface + `ClaudeCodeHarness` + `BusPeerHarness`; cortex#109 §A+B unhardcodes `classification: "local"` and adds surface-router visibility filtering.

The **config split (§3.7)** is a third, independent foundation candidate for this phase — it is a backwards-compatible config-ingestion refactor (no schema flip) that shrinks the file the Phase C `policy:` flip has to land in and isolates the dangerous `nats`/surface bindings from routine edits. The **shared surface gateway (§3.8)** is a larger build that pairs with multi-stack-per-principal (§3.2); it can follow once §3.7's `surfaces.yaml` exists, with separate-bot-per-stack as the interim until then.

**Estimated effort:** 2–3 weeks parallel. cortex#91 is ~1–2 weeks (per its own estimate). cortex#109 §A+B is ~1 week (4 emit-site changes + visibility filter + per-renderer config).

**Entry criteria:**
- cortex#92 PR's Q5/Q6/Q7 resolved (substrate harness design doc).
- Q3 v1 posture decision (centralized vs gossiped registry).

**Exit criteria:**
- `SessionHarness` interface compiled + tested.
- `ClaudeCodeHarness` passes all current `cc-session.ts` tests behind new interface.
- `BusPeerHarness` connects to local sage daemon and routes a fake review task end-to-end.
- Cortex no longer hardcodes `classification` at the four emit sites; each can be explicitly set by the caller (with `local` as the safe default).
- Surface-router has a `sovereignty.classification` check in `adapterMatches()`.
- Renderer config supports `visibility:` block (hide-residency / require-model-class / max-classification).

**Does not require:** Phase B or any other phase. Phase A unblocks single-principal federation; multi-principal waits for Phase D.

### Phase B — Identity (cortex#102 NKey-signed bot↔bot)

**Scope:** cortex#102 — replace Discord-platform-ID-based bot trust with NKey-signed envelope verification in BusPeerHarness.

**Entry criteria:**
- Phase A complete (BusPeerHarness exists as the integration point).
- Q1 resolved (stack identity = NSC operator-account NKey + principal id pairing).

**Exit criteria:**
- BusPeerHarness verifies `signed_by[]` against TrustResolver.trustsByNKey() on every inbound dispatch.
- ClaudeCodeHarness uses MyelinRuntime.publish for bot-bot calls (instead of "post in #cortex with @mention").
- TrustResolver gains `trustsByNKey(agentId, signerPubKey) → boolean` method.
- cortex#98's `trustedBotIds` stays as Discord-side fallback for human-to-bot DMs, but bot↔bot path no longer consults it.

**Estimated effort:** 1–2 weeks. The plumbing is largely shipped (TrustResolver has `verifyOperatorSignedRequest` per `trust-resolver.ts:362-491`); this is wiring + the BusPeerHarness consumption.

### Phase C — Policy (cortex#107 AAA refactor — THE SCHEMA FLIP)

**Scope:** cortex#107 — PolicyEngine at M6, per-surface adapters thin out, cortex.yaml flips from per-adapter `roles[]` to top-level `policy:` block.

**Entry criteria:**
- Phase A complete (envelope sovereignty consumable; PolicyEngine consumes it).
- Phase B complete (NKey-signed envelopes — `signed_by[].principal` is what PolicyEngine resolves against `policy.principals[]`).
- Q7 resolved if stack-as-protocol-unit decision is needed before the flip (the cleanest moment to introduce a stack-aware namespace; after this flip, doing so requires re-flipping).
- Q6 resolved (audit ownership).

**Exit criteria:**
- `src/common/policy/` module exists with `PolicyEngine.check()`.
- Discord/Mattermost adapters reduced to ~30 LOC each (translate event → Principal; no role-resolver in adapter).
- `cortex.yaml` schema has `policy: { principals[], roles[] }` at top level; per-adapter `roles[]` removed.
- `migrate-config` CLI lifts existing per-surface roles into top-level `policy:` (with warnings on inconsistencies between adapters).
- `system.access.{allowed,denied}` envelopes emitted by PolicyEngine (cortex#97 audit envelopes tie in).
- Existing tests pass; cortex.yaml schema migration is one-way (post-flip, no rollback in v1).

**Estimated effort:** 2–3 weeks. The bulk of the change is the schema flip + migrate-config + adapter thinning. PolicyEngine implementation itself is ~1 week.

**Critical insight:** This is the ONLY phase where the principal-facing config schema changes. Sequencing Phases A and B before Phase C means the flip happens once: the substrate harness work (Phase A) doesn't touch cortex.yaml's auth model; the NKey identity work (Phase B) extends `policy.principals[]` after the block exists. If Phase C were sequenced first, we'd flip the schema, then re-flip when Phase B adds NKey fields.

### Phase D — Federation (multi-principal peer registry + accept rules)

**Scope:** cortex#109 §E (peer registry + accept-rules) + cortex#107 §H (multi-principal cloud dashboard).

**Entry criteria:**
- Phase C complete (PolicyEngine exists; principals carry `home_operator` — field name pending cortex#448).
- Q3 confirmed (principal-edited registry is the v1 posture).

**Exit criteria:**
- `policy.federated.peers[]` schema landed (`{ operator_id, operator_pubkey, accept_subjects, deny_subjects, max_hop }` — `operator_id`/`operator_pubkey` are the peer principal id/pubkey, field names pending cortex#448).
- Surface-router gates inbound `federated.*` envelopes by per-peer accept rules.
- PolicyEngine extends to support per-peer policy slicing.
- A second principal (jcfischer or test rig) successfully federates a task with the first principal's cortex; envelope chain is verifiable on both sides.
- Cloud dashboard (the grove-api Worker today) extends to per-principal slicing using `home_operator` (field name pending cortex#448) from `policy.principals[]`.

**Estimated effort:** 3–4 weeks. The peer registry schema is small; the cloud-dashboard multi-tenancy is the bulk.

### Phase E — Bridges + multi-network

**Scope:** §3.4 multi-network case + §3.5 mesh varieties (private / isolated / public).

**Entry criteria:**
- Phase D complete (single-network federation working).
- Q4 resolved (per-peer capability scoping schema).
- Q7 resolved if stack-as-protocol-unit affects bridge semantics.

**Exit criteria:**
- `MyelinRuntime` supports multiple NATS links concurrently (one per leaf-node).
- `policy.federated.peers[].leaf_node` references a named NatsLink.
- A test rig demonstrates a single cortex process participating in 2 distinct networks (separate leaf-nodes), publishing different capabilities to each.
- Operator-vision script's "bridge stack" pattern is operable (one stack, multiple principal-network memberships).
- (Future, separate issue) Public mesh capability announcement scaffold — out of this phase's scope but possible after.

**Estimated effort:** 4–6 weeks. This is the largest scope; multi-link support in MyelinRuntime + per-network policy slicing + principal-side infra coordination.

### Phase summary

| Phase | Estimated | Critical path | Schema flip? |
|---|---|---|---|
| A — Foundation | 2–3w (parallel) | cortex#91 + cortex#109 §A+B | No |
| B — Identity | 1–2w | cortex#102 (BusPeerHarness verification) | No |
| C — Policy | 2–3w | cortex#107 (PolicyEngine + migrate-config) | **YES (only one)** |
| D — Federation | 3–4w | cortex#109 §E + cortex#107 §H | No (additive) |
| E — Bridges + multi-network | 4–6w | Multi-network MyelinRuntime + per-peer policy | No (additive) |

Total roughly 12–18 weeks if sequenced; A+B+C is the foundation (~6 weeks) and unblocks all single-network work.

---

## §7 — Risks + non-goals

### What this doc does NOT address

- **Principal UX for editing config.** cortex.yaml gets richer; principal-side dashboard support for editing `policy:` and `policy.federated.peers[]` is its own design (cortex#99 dashboard settings page).
- **Runtime observability of cross-network traffic.** Distinct from sovereignty enforcement: how principals *see* the federation flow in real time. Signal-collector territory.
- **Legal/compliance frameworks.** Data residency at the envelope level is necessary but not sufficient for GDPR / SOC2 / HIPAA. Each principal's compliance posture is theirs; this design enables the technical primitive.
- **Pricing / economics for public mesh.** The myelin envelope has an `economics` block reserved for future marketplace integration; this design assumes it stays empty in v1.

### Risks of getting the layering wrong

- **Premature multi-network work without policy** = security surface. If Phase E lands before Phase C, every inbound federated envelope is accepted by anyone subscribing — no decision point. The PolicyEngine is the gate.
- **Policy without substrate** = vendor lock at one harness. If Phase C lands before Phase A, the PolicyEngine bakes in Claude-Code-only assumptions (e.g. `roles[].disallowedTools` listing CC-specific tool names like `NotebookEdit`). The harness interface decouples this.
- **Identity without substrate** = wire mismatch. If Phase B lands before Phase A, NKey verification has no inbound path (BusPeerHarness doesn't exist). cortex#102 is the strategic follow-up to cortex#91, not a replacement.
- **Schema flip more than once.** The roadmap is designed so cortex.yaml flips ONCE (Phase C). If we re-flip later (e.g. to add a stack-aware namespace per Q7), every principal's `cortex.yaml` migration is two-step. Andreas wants one flip.

### Open coupling concerns

- The vendored envelope at `src/bus/myelin/envelope-validator.ts:22` (`SCHEMA_SOURCE_COMMIT = "96b14ea..."`) is pre-chain-of-stamps. Cortex#102 needs post-chain-of-stamps. Cortex#109 §C upgrades this. Sequence the upgrade to land in Phase A (it's mechanical) so Phase B can rely on it.
- `MyelinRuntime` today has a single `NatsLink` (`runtime.ts:142-169`). Phase E requires multi-link support. Either refactor at Phase E or carry the limitation through Phase D and accept that Phase D demonstrates single-network federation only.
- `target_principal` (F-021 task field) requires the post-`96b14ea` envelope. Direct/Delegate task routing per `myelin/specs/namespace.md:152-187` cannot happen without the upgrade. This couples cortex#91 (substrate harness, which may want Direct/Delegate as a dispatch primitive) to cortex#109 §C (envelope upgrade).

---

## §8 — References

### Cortex source

- `cortex/src/bus/myelin/envelope-validator.ts:22` — vendored schema pinned at myelin `96b14ea`
- `cortex/src/bus/myelin/runtime.ts:30-67` — MyelinRuntime interface
- `cortex/src/bus/myelin/runtime.ts:223-249` — publish: hardcoded `local.${org}.${type}` subject
- `cortex/src/bus/dispatch-events.ts:73` — `classification: "local"` hardcoded
- `cortex/src/bus/system-events.ts:102` — `classification: "local"` hardcoded
- `cortex/src/bus/github-events.ts:89` — `classification: "local"` hardcoded
- `cortex/src/taps/cc-events/cc-events.ts:99` — `classification: "local"` hardcoded
- `cortex/src/bus/surface-router.ts:124-160` — `subjectMatches` NATS-style pattern matcher
- `cortex/src/bus/surface-router.ts:259-270` — `adapterMatches` (subject + payload filter; no sovereignty filter)
- `cortex/src/bus/surface-router.ts:291-319` — `renderWithIsolation` (timeout + AbortController)
- `cortex/src/common/agents/trust-resolver.ts:268-491` — NSC operator-account-signature verification
- `cortex/src/common/agents/trust-resolver.ts:702-715` — `trustsByPlatformId` (today's mechanism)
- `cortex/src/common/types/cortex-config.ts:85-111` — `OperatorSchema` (id, dataResidency)
- `cortex/src/common/types/cortex-config.ts:225-253` — `AgentRuntimeSchema` (substrate + capabilities)
- `cortex/src/common/types/cortex-config.ts:257-304` — `AgentSchema` (id, trust, presence)
- `cortex/src/common/types/cortex-config.ts:321-403` — `RendererSchema` (dashboard, pagerduty, cli-tail, webhook-out)
- `cortex/src/common/types/cortex-config.ts:447-491` — `NatsConfigSchema` (credsPath, identity, accountSigningKeyPath)
- `cortex/docs/architecture.md:69-105` — M1–M7 stack model (cortex side)
- `cortex/docs/architecture.md:135-145` — four subject classes
- `cortex/docs/architecture.md:188-198` — namespace reconciliation RESOLVED
- `cortex/docs/architecture.md:599-715` — agent + presence/renderer model (§9)
- `cortex/docs/design-collaboration-surface.md:325` — G-1110 entry (sovereignty render)
- `cortex/docs/design-collaboration-surface.md:374-375` — multi-operator surface + sovereignty surfacing open Qs
- `cortex/docs/plan-cortex-migration.md` — migration plan; MIG-7 is the cortex.yaml schema flip; MIG-8 retires legacy

### Myelin source

- `myelin/docs/architecture.md:21-79` — Myelin layer model (M1–M7) + per-layer summary
- `myelin/docs/architecture.md:188-204` — cross-layer invariants (sovereignty, mutable fields, transport-independence, operator sovereignty)
- `myelin/docs/envelope.md:13-32` — canonical envelope fields
- `myelin/docs/envelope.md:62-92` — sovereignty + inside-vs-outside-signature
- `myelin/docs/envelope.md:174-184` — L3 status snapshot
- `myelin/specs/namespace.md:13-22` — three prefixes (local / federated / public)
- `myelin/specs/namespace.md:134-213` — tasks domain (Broadcast / Direct / Delegate / dead-letter)
- `myelin/specs/namespace.md:216-247` — TASKS JetStream stream spec
- `myelin/specs/namespace.md:275-303` — envelope ↔ subject derivation
- `myelin/src/envelope.ts:337-345` — `deriveNatsSubject`
- `myelin/src/envelope.ts:347-358` — `validateSubjectEnvelopeAlignment`
- `myelin/src/envelope.ts:88-113` — `parseSovereignty`
- `myelin/src/sovereignty/` — F-5 sovereignty engine (policy store, validators, audit log, transport)
- `myelin/src/identity/` — chain-of-stamps + sign + verify + registry

### GitHub issues

- cortex#110 — META (this synthesis)
- cortex#91 — substrate harness design + cortex#92 PR (Q5/Q6/Q7 open)
- cortex#102 — bot↔bot via bus envelopes (NKey identity)
- cortex#107 — Approach 1 AAA at dispatch-handler (PolicyEngine)
- cortex#109 — envelope-visibility composition with subject-namespace routing
- cortex#76 — TrustResolver + operator-verifier
- cortex#86 — creds-auth (closed; M1 foundation)
- cortex#98 — trust-mesh wiring (tactical fix; retires when cortex#102 lands)
- cortex#105 — Pass 1 / Pass 2 trust-mesh wiring
- myelin#7 — Myelin layer model, M1–M7 (myelin canonical)
- myelin#11 — sovereignty enforcement protocol (spec-pending)
- myelin#31 — chain-of-stamps (shipped, PR #92)
- myelin#43 — federation principal mapping (referenced in `namespace.md:212`)
- myelin#44 — namespace review feedback (`namespace.md:181`)

### Operator vision

- "Internet of Agentic Work" video script (2026-05-13, in cortex#110 body) — the principal-facing mental model (the script's own "Operator vision" framing is kept as a reference label). Used as North Star; not replicated here. Three concepts mapped to issues in cortex#110's body table.

---

*Originating discussion: Andreas 2026-05-13 framing of multi-stack / multi-principal / multi-network routing as an OSI-perspective design problem; cortex#110 META issue + CodexResearcher report on cortex#109 confirming myelin already ships the routing primitives cortex needs. This synthesis closes the first acceptance step on cortex#110 — the deep current-state + OSI-layered analysis — and seeds the Phase A entry-criteria discussion.*
