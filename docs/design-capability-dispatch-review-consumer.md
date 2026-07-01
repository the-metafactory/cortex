# Capability-Dispatch Review Consumer — cortex#237 Design Specification

**Status:** Draft — design spec for cortex#237's producer-side (the bus consumer that subscribes to `local.{org}.tasks.code-review.>` and emits `review.verdict.*`). Lockstep partner to `docs/design-pilot-restructure.md`'s caller-side spec.
**Date:** 2026-05-16
**Driver:** Serena (architect, cortex#237)
**Path picked:** **Path A — extend cortex's existing dispatch surface with a code-review bus consumer.** Justification in §1.
**Related docs:** `docs/architecture.md` (§3 event architecture, §7 capability-driven dispatch); `docs/design-pi-dev-review-agent.md` (the architectural anchor — §4 bus contracts, §7 review workflow); `docs/design-pilot-restructure.md` (the caller-side contract — §4 envelope shapes, §6.4 Phase C cutover); cortex#248 (verdict envelope payload ratification — `review.verdict.*` shape locked); cortex#249 (`DispatchTaskFailedReason` four-way nak taxonomy extension); cortex#250 (`@the-metafactory/cortex/bus` barrel — public exports for pilot).
**Refs:** cortex#237 (this consumer), cortex#232 (pilot-side restructure umbrella), cortex#238 (the IAW Wave 0 ratification cluster).

---

## §1 — Path choice (A vs B)

cortex#237's acceptance criteria (issue body) admit two implementation paths. Both satisfy the wire contract; they differ in *where the process lives*, *which substrate runs the lens pipeline*, and *what the migration cost looks like*.

### §1.1 The two paths

**Path A — Echo migration (extend the cortex daemon).** Add a code-review-specific `MyelinSubscriber` inside the existing cortex process. Subscribes to `local.{org}.tasks.code-review.>`. On each envelope, spawns a Claude Code session running the existing `CodeReview` skill (`~/.claude/skills/code-review/SKILL.md`), reusing the `ClaudeCodeHarness` substrate that `src/runner/dispatch-listener.ts` already uses for `dispatch.task.received` envelopes. Emits lifecycle + verdict envelopes back onto the runtime via `MyelinRuntime.publish`. The persona-and-skill mapping ("Echo reviews code") stays a cortex.yaml declaration; the consumer process is the cortex daemon.

**Path B — pi.dev standalone agent.** Build a separate `pai-review-agent` per `docs/design-pi-dev-review-agent.md` §5. New process, new repo (or new PAI extension), independent NATS connection, independent gh CLI bridge, independent capability registration. The cortex process does not need to know this consumer exists; both Echo-cortex and Echo-pi-dev would coexist as competing consumers on the same JetStream pull consumer group.

### §1.2 The trade-off matrix

| Axis | Path A | Path B |
|---|---|---|
| **Time to first verdict on the wire** | Days. Reuses `MyelinSubscriber`, `ClaudeCodeHarness`, `createDispatchTask*Event` builders, `MyelinRuntime.publish`. Net new code is the subscriber adapter + verdict envelope builder + PR-ref extraction + correlation-stash logic. | Weeks. New process, new PAI extension, new arc manifest, new launchd plist (or pi.dev runtime). Bus client + envelope validator must be vendored or re-imported. Bridges to gh CLI and the lens pipeline are net new. |
| **Lockstep risk with pilot Phase C** | Low. Same release train as cortex bot upgrades. Principal runs `arc upgrade cortex`, both sides flip together. | Medium. Two release trains. Principal must `arc upgrade cortex` for the bot + install pi.dev review agent independently. Drift window between pilot Phase C and the consumer being available on the principal's machine. |
| **Substrate decoupling** (the §1.1 framing in the anchor doc) | Compromised. Cortex still owns runtime + chat surface + bus consumer. Path B's framing — "presence and substrate are independent axes" — is the right long-term shape; Path A defers it. | Achieved. The anchor doc's intent realised: bus contracts decoupled from chat-surface adapters. Future research-agent / sage-agent slot in as siblings without touching cortex. |
| **Operational footprint** | One process, one launchd plist, one log stream. Principals see the consumer in the existing cortex dashboard (it's an in-process surface). | Two processes minimum. Independent failure mode (pi.dev crashes ≠ cortex crashes — good for fault isolation, bad for "did Echo even claim this?" observability). |
| **Capability-registration mechanics** | Cortex publishes Echo's capabilities to `local.{org}.agents.capabilities` as part of its startup sequence (mechanism §3 below). One registration, one expiry. | pi.dev publishes its own capability assertion. Two simultaneous Echo registrations (cortex-Echo + pi.dev-Echo) on the same `agent_id` could confuse the registry; the spec doesn't yet address tenant disambiguation. Open question for pi.dev path. |
| **Test infrastructure reuse** | High. cortex's `src/runner/__tests__/dispatch-listener.test.ts`, `src/bus/__tests__/dispatch-events.test.ts`, `src/bus/myelin/__tests__/subscriber.test.ts` give us the existing harness pattern. Stub `MyelinRuntime` + stub `CCSessionFactory` and we have integration coverage. | Net new test infrastructure for the pi.dev side; cortex's harness doesn't apply. |
| **Code path Echo's Discord-mention path uses today** | Identical substrate. The Discord-mention review path runs via `DispatchHandler.handleMessage` → `CCSession` with the `code-review` skill enabled. Path A wires a *second ingress* to the *same lens pipeline*. Echo's behaviour for "review PR X" stays byte-identical regardless of whether the request arrived via Discord-mention or capability-dispatch. | Reimplements the lens pipeline in pi.dev. Risk of divergence: pi.dev's gh-bridge subset, skill-execution context, model selection, and bash-guard policy all need to be re-derived to match Echo's existing behaviour. |
| **§9 coexistence story** | Trivially clean — two ingress functions, one shared pipeline. See §9. | Awkward during transition — the same logical agent has two implementations producing the same envelopes. Disambiguation per-cycle (which Echo handled this?) needs explicit observability. |
| **Decoupling debt taken on** | Acknowledged. Path A keeps the bus consumer co-located with the chat surface, which is the conflation `design-pi-dev-review-agent.md` §1 explicitly named as the problem to solve. We pay this debt with intent to discharge it via Path B as a *later* migration once the wire contract is proven. | None — pays the decoupling cost up front. |

### §1.3 The decision

**Path A wins for cortex#237.** Three reasons:

1. **Lockstep tightness.** Pilot Phase C's quantitative cutover gate (`design-pilot-restructure.md` §6.4: "≥5 consecutive cycles across ≥2 PRs over ≥48 hours") requires a producer-side to actually exist on the wire. Path A ships in days; Path B in weeks. Cortex#237's whole reason for being is to close the loop end-to-end — the *fastest correct* path is the right one.
2. **Substrate parity.** Echo's Discord-mention review path runs the `CodeReview` skill inside a `CCSession` inside a `ClaudeCodeHarness`. Path A produces verdicts via the *same substrate* — principals get byte-identical review behaviour regardless of ingress. Path B would re-derive the lens pipeline in pi.dev's runtime and inherits divergence risk (different model defaults, different bash policy, different attachment handling, etc.) that we'd then have to chase down across two implementations.
3. **Decoupling is not blocked.** Path A does not foreclose Path B. The wire contract is the abstraction layer (§4 below). Once Path A is operational and the contract is proven by ≥30 days of real review traffic, a pi.dev review agent slots in alongside as a *competing consumer* on the same JetStream pull consumer group. Path A is the bridge, not the destination.

The decoupling debt we take on with Path A is real, and we discharge it explicitly as a follow-up issue (§13 open question 2).

### §1.4 What "Echo" means in Path A

Echo is **not a separate process or code module** in cortex today. Survey result (cortex source as of 2026-05-16):

- `grep -rn "Echo" src/` returns only string-literal references (config docs, dispatch-listener docstrings, test fixtures, federated subject examples in surface-router tests). There is no `src/runner/echo.ts`, no `src/adapters/echo.ts`, no `EchoAgent` class.
- Echo's review behaviour is configuration: cortex.yaml declares an agent named `echo` with persona file, roles, trust, and a Discord presence. When a principal @-mentions Echo in Discord, `DispatchHandler.handleMessage` runs the standard pipeline (parse → access-control → context-fetch → prompt-build → spawn CC session). The CC session has the `CodeReview` skill on its allowlist (per the agent's `roles` config), and Echo's persona file tells the model "you are Echo, a TypeScript-focused code reviewer."
- The "Echo-ness" of a review is therefore the *combination* of (a) the persona file + (b) the skill-allowlist on the spawned CCSession + (c) the prompt-builder injecting Echo's persona prefix. Nothing in cortex distinguishes "Echo reviews" from "any other agent runs the CodeReview skill" at the runtime level.

This matters for Path A's design: **the new consumer is not "wire Echo to NATS."** It is "wire a new subscriber that, on each capability-dispatch envelope, spawns a CC session configured as Echo." The configuration mapping (`code-review.<flavor>` → "spawn agent `echo` with persona + skill") happens in the new subscriber, not in any pre-existing Echo module.

The implication: the new consumer is generic. It is a *capability-dispatch consumer for `tasks.code-review.*`*, not "the Echo bot." Future capabilities (`tasks.security-review.*`, `tasks.architecture-review.*`) wire as siblings, each pointing at a different agent persona + skill combination.

---

## §2 — Subscriber lifecycle

### §2.1 Where the subscriber lives

Path A adds a new file: **`src/runner/review-consumer.ts`**. Sibling to `src/runner/dispatch-listener.ts` (which handles the generic `dispatch.task.received` ingress). The naming reflects what it does, not which agent it serves — see §1.4.

Wired in `src/cortex.ts` alongside the existing `busDispatchListener` (which today subscribes to `dispatch.task.dispatched` for inbound peer visibility per IAW Phase B.2a). The new consumer subscribes to `local.{org}.tasks.code-review.>`. Same `MyelinRuntime`, same `SystemEventSource`, same lifecycle hooks.

### §2.2 Subscription primitive

**Use `MyelinSubscriber` directly** (from `src/bus/myelin/subscriber.ts`), not the surface-router. Rationale:

- The surface-router's `SurfaceAdapter` shape is built around "this envelope is being rendered to a platform/substrate"; the dispatch-listener uses it because cortex#114's invariant said the runner is *also* a surface (the substrate-harness call is the render). For code-review, we're not rendering — we're consuming a task on behalf of a *different* logical agent (`echo`, not `cortex-runner`), and the lens pipeline + GH-side side effects don't fit the surface-router's render-timeout-with-`AbortSignal` lifecycle.
- The router fans every envelope through visibility filters, federation policy gates, and `system.access.filtered` emission. The code-review subscriber wants a clean inbound stream without the router's policy machinery (the policy gate runs *inside* the consumer at the per-envelope step — see §7 nak handling).
- `MyelinSubscriber.start(link, opts)` is the right level: takes a subject pattern, hands typed envelopes to `onEnvelope`, routes invalid envelopes to `onInvalidEnvelope`, and exposes a `stop()` that drains the underlying NATS subscription. Identical shape to what pilot's `bus/subscribe-verdict.ts` will use on the caller side (`design-pilot-restructure.md` §5.2).

### §2.3 Subscription details (NATS-side)

| Property | Value | Why |
|---|---|---|
| **Subject pattern** | `local.{org}.tasks.code-review.>` | `>` matches `generic` / `typescript` / `python` / `rust` / `go` / `sql` / `docs` / `security` / etc. per `design-pilot-restructure.md` §4.1's `KNOWN_SPECIALIZATIONS`. The consumer filters in-handler by capability segment (see §4). |
| **Consumer mode** | **Pull consumer** (JetStream) | Architecture §7.2 specifies pull-consumer groups for capability dispatch. Push delivery has no flow-control; pull lets the consumer pace work (lens pipeline takes 30s–5min per review). |
| **Queue group / consumer name** | `cortex-review-consumer-{instance-id}` where `instance-id` is the cortex daemon's `{operator}-cortex` triple. | Multiple cortex instances (e.g. dev + prod on the same operator account, or future fleet) all subscribe to the same JetStream durable. JetStream's competing-consumer semantics guarantee at-most-one delivery per envelope. Names tie consumer state to operator+instance so a daemon restart resumes from the same position. |
| **Durable** | Yes, named per above | We want the principal's pending review queue to survive a cortex restart. A non-durable consumer would silently drop tasks during the restart window. |
| **Ack policy** | `explicit` | We ack only after the lens pipeline produces a terminal lifecycle envelope. A crash mid-review re-delivers the task to a competing consumer. |
| **Ack wait** | `5 minutes` | Longest realistic review is 3–4 minutes of lens work + GH-API roundtrip. 5min gives ~30-50% safety margin before JetStream re-queues. Echo cortex#253 R1 (Major-3) flagged the original 15min as creating a 45min worst-case dead-letter window that would have exceeded pilot's `--wait` default (600s per `design-pilot-restructure.md` §5.2); 5min ack + 3 max-delivery = 15min worst case, which fits inside pilot's wait budget AND gives pilot a chance to re-publish on its own if needed. |
| **Max delivery** | `3` | After 3 redeliveries (crash, re-delivery, crash again) the task moves to `local.{org}.tasks.dead-letter.code-review` per architecture §7.2. Principals investigate dead-letters out of band. **Co-emission of `dispatch.task.aborted` on redelivery > 1:** when the consumer detects it's processing an envelope for the second+ time (JetStream redelivery counter on the delivery metadata), emit `dispatch.task.aborted` with `reason: "redelivery"` to give pilot a structured "this task is in trouble" signal BEFORE the max-delivery threshold is reached. Operationally kinder than letting pilot's `--wait` time out on a struggling consumer. |
| **Filter** | None (subscribed pattern IS the filter) | NATS's subject filter is the only matching layer we need; in-handler filtering (e.g. by `<flavor>` segment) happens after the envelope is parsed. |

**Caveat — pull-consumer support in `MyelinSubscriber`.** The current `MyelinSubscriber` wraps `NatsSubscription`, which from a quick survey of `src/bus/nats/subscription.ts` is the **push** subscription primitive. We have two options:

- **Extend `MyelinSubscriber` / `NatsSubscription` with a `mode: "pull"` option** that swaps to JetStream's `pullSubscribe` under the hood. Single primitive, two modes. Preferred — keeps the surface narrow and the type signature uniform for consumers. PR scope per §10.
- **Add a sibling `MyelinPullSubscriber`** that wraps JetStream pull-consumer semantics independently. Lower refactor risk but doubles the surface.

Decision: extend. The mode flag is internal; consumers see the same `onEnvelope(envelope, subject)` callback regardless. The pull-mode branch carries a small extra `ackWaitMs` / `maxDeliver` option block.

This is the only net-new bus primitive needed — everything else in §3–§8 composes on top of existing helpers.

### §2.4 Clean shutdown

The consumer is wired into cortex's existing shutdown sequence (`src/cortex.ts:1244` is where `busDispatchListener.stop()` is called today). The new consumer's `stop()` MUST:

1. **Stop accepting new envelopes.** Detach the `MyelinSubscriber` registration so the pull-consumer's request loop drains the in-flight batch but pulls no more.
2. **Drain in-flight reviews.** Each in-flight review is a `Promise<void>` tracked on an internal `inFlight: Set<Promise<void>>` (same pattern as `BusDispatchListener`'s in-flight set, per `src/bus/bus-dispatch-listener.ts:115`). On shutdown, `await Promise.allSettled(Array.from(this.inFlight))` so partially-emitted lifecycle sequences finish their terminal envelope before the runtime closes.
3. **Honour a shutdown grace window.** If a review is still mid-lens-pipeline when shutdown is requested (e.g. principal-cancel during a 5min review), the consumer awaits up to `30s` before emitting `dispatch.task.aborted` with `reason: "shutdown"` and force-killing the CC session. Mirrors `TaskTracker.shutdown()`'s existing pattern in `src/runner/task-tracker.ts`.
4. **Idempotent.** `stop()` called twice resolves on both calls (same as `BusDispatchListener.stop`).

Without (3), a graceful cortex restart could leave a JetStream message un-acked with no terminal envelope on the wire — pilot's `wait-for-verdict` would time out (124) rather than seeing the `dispatch.task.aborted` envelope that explains *why* the review never completed.

### §2.5 Multi-consumer story

The consumer is **not per-agent**. cortex.yaml may declare multiple agents (e.g. `echo` + `holly`); the review-consumer is **one process-wide subscriber** that delegates the per-envelope agent selection to the in-handler routing logic (§4). Rationale:

- Two `MyelinSubscriber` instances against the same JetStream pull consumer would race; one would win each envelope, defeating the per-agent routing intent.
- The right shape is *one bus consumer, N agent personae*. The capability registration (§3) tells the registry "Echo claims `code-review.typescript`, `code-review.bun`, `code-review.generic`; Holly claims `code-review.python`, `code-review.security`." On envelope receipt, the consumer reads the capability suffix and routes to the matching agent within the cortex process.

This is a **deliberate simplification** vs the anchor doc's framing ("each agent runs its own bus connection"). Path A's "one consumer, many personae" matches cortex's existing single-process model. Path B (pi.dev) restores the per-agent-process model.

---

## §3 — Capability registration

Per architecture §7.2, agents self-register their capabilities into a NATS KV bucket at `local.{org}.agents.capabilities`. The registry is the M5 Discovery seed; consumer routing (`code-review.<flavor>` → which agent) ultimately rides on it.

### §3.1 What exists today

Survey result (cortex source as of 2026-05-16, corrected after Echo round 1 — original survey understated Phase A.6's substrate):

**Schema substrate — ALREADY IN PLACE** (Phase A.6, refs cortex#113):

- **`AgentRuntimeSchema.capabilities`** at `src/common/types/cortex-config.ts:433` — declared on `agents[].runtime.capabilities[]` in cortex.yaml. Each entry is a capability-id string (e.g. `code-review.typescript`).
- **`CortexConfigSchema.capabilities`** (top-level) at `src/common/types/cortex-config.ts:1574` — the typed catalog. Per `src/common/types/capability.ts`, each `CapabilitySchema` entry has `id`, `description`, `tags`, `provided_by`, `rate`, `cost`.
- **Cross-validation at parse time** (`cortex-config.ts:1545-1574`) — every id in `agents[].runtime.capabilities[]` MUST resolve to a top-level `capabilities[]` catalog entry. Dangling refs fail at config-load. This is the schema discipline the consumer routes against.
- **`PolicyFederatedNetworkSchema.announce_capabilities`** at `cortex-config.ts:1249` — same `<domain>.<entity>` id grammar (`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/`) consistent across the policy surface.

**Runtime gap — NET NEW work for cortex#237:**

- **No publication site.** The schema declarations exist, but nothing in `src/cortex.ts` publishes the runtime form of these capabilities to `local.{org}.agents.capabilities.{agent_id}` per architecture §7.2. The cortex.yaml declarations are parsed and validated but never reach the bus.
- **No KV-bucket primitive in `src/bus/`.** Architecture §7.2 specifies the bucket; cortex does not yet write to it. The closest existing primitive is the federation registry client (`src/common/registry/client.ts`) for federation pubkeys — different registry, different purpose.
- **No bucket reader** — pilot's pre-publish "is anyone listening?" check (`design-pilot-restructure.md` §8.2) has nothing to read against. Reading is deferred (see §13).
- **No `agents.capabilities.*` subject in any test fixture.** `grep -rn "agents.capabilities" src/` returns zero hits.

So cortex#237's PR cluster does **runtime publication** (read the in-place schema, publish at boot, signed envelopes via the Phase B.3 signer) plus the **registration primitive**. The schema work itself is done — we consume it, we don't duplicate it.

### §3.2 What the registration payload looks like

Per the anchor doc's `pi.settings.json` example (§3.2) and architecture §7.2:

**Subject:** `local.{org}.agents.capabilities.{agent_id}`

**Payload:**

```json
{
  "agent_id": "echo",
  "capabilities": ["code-review.typescript", "code-review.bun", "code-review.generic"],
  "sovereignty": "selective",
  "max_concurrent": 3,
  "load": 0,
  "registered_at": "2026-05-16T09:42:11Z",
  "instance": "andreas.cortex.local"
}
```

The envelope around it is a normal `MyelinEnvelope` of `type: "agents.capabilities.registered"` (or `.updated` on re-register) with `sovereignty.classification: "local"`. The bucket *value* is the payload above; the *write* is via myelin's signed-KV API (myelin#31). Cortex's registration is signed by the cortex daemon's nkey per IAW Phase B.1c — already wired for envelope signing.

### §3.3 The new helper

**New file: `src/bus/capability-registry.ts`** — a thin client that:

1. **`register(opts: { agentId, capabilities, sovereignty, maxConcurrent, source })`** — publishes the registration envelope and writes the KV value. Returns a `Registration` handle.
2. **`Registration.heartbeat(load: number)`** — periodic update of the agent's current load (count of in-flight reviews). Lets future load-balancing routing favour idle agents. Optional in v1; helpful in v2.
3. **`Registration.unregister()`** — emits `agents.capabilities.unregistered` and deletes the KV entry. Called from cortex's shutdown sequence.

The helper is **agent-agnostic** — Echo's registration calls it with Echo's capabilities; Holly's with Holly's; future capabilities slot in as additional `register()` calls.

### §3.4 When the consumer registers

In `src/cortex.ts`, immediately after `mergedAgents` is built and before the review-consumer's `start()`:

```
for each agent in mergedAgents:
  if agent.runtime?.capabilities?.length > 0:
    capabilityRegistry.register({ agentId: agent.id, capabilities: agent.runtime.capabilities, ... })
```

The "which capabilities does each agent claim?" data lives in **cortex.yaml** under `agents[].runtime.capabilities[]` — the field already shipped at Phase A.6 (`src/common/types/cortex-config.ts:433`). cortex#237 consumes this schema; it does NOT propose a new one. Echo round 1 (cortex#253) correctly flagged that an earlier draft of this spec proposed a sibling `agents[].capabilities` field which would have created schema drift against the existing `agents[].runtime.capabilities` + top-level `capabilities[]` catalog.

**The cortex.yaml shape is therefore the existing Phase A.6 shape, NOT a new shape:**

```yaml
capabilities:
  # top-level catalog (existing, Phase A.6)
  - id: code-review.typescript
    description: TypeScript code review
    provided_by: echo
  - id: code-review.bun
    description: Bun-specific code review
    provided_by: echo
  - id: code-review.generic
    description: Generic code review
    provided_by: echo

agents:
  - id: echo
    persona: ./personas/echo.md
    roles: [agent-restricted]
    trust: [luna, holly, ivy]
    runtime:
      # existing Phase A.6 field — capability ids the agent claims
      capabilities:
        - code-review.typescript
        - code-review.bun
        - code-review.generic
      # NEW fields proposed by this spec (additions to AgentRuntimeSchema, siblings to capabilities/substrate/mode)
      sovereignty: selective
      maxConcurrent: 3
    presence:
      discord: { ... }
```

**What's net new on the schema:** only `agents[].runtime.sovereignty` (enum) and `agents[].runtime.maxConcurrent` (positive int). Both are additive sibling fields on `AgentRuntimeSchema`, not a new top-level surface. Cross-validation (Phase A.6.3, `cortex-config.ts:1545-1574`) already enforces that every id in `agents[].runtime.capabilities[]` resolves to a top-level `capabilities[]` catalog entry — cortex#237 inherits that discipline.

The persona file stays the same; the skill restriction stays role-based (per the existing `access.allowedSkills` logic in `dispatch-handler.ts`); the bus subscription is gated on at least one agent declaring at least one capability via the existing `runtime.capabilities[]` field.

### §3.5 v1 minimal-viable registration

For cortex#237's first PR cluster, we ship registration in a **publish-only form**: the consumer publishes the registration envelope on startup; it does NOT yet read the bucket from other principals or peers. Reading is for §13 open question 3 (multi-network / federated capability discovery), which is deferred to a Phase D follow-up.

This means pilot's pre-publish "is anyone listening?" check (`design-pilot-restructure.md` §8.2) won't yet have a populated bucket to read against in Phase B. That's fine — pilot's Phase B explicitly accepts that the consumer's existence is implicit (publish-and-wait-for-timeout). The bucket reader ships when both the producer side (this consumer) and the consumer side (pilot's pre-publish check) are ready for it. Tracked in §13.

---

## §4 — Envelope handling — per-envelope flow

This is the meat of the consumer. Each inbound `tasks.code-review.<flavor>` envelope runs the following pipeline.

### §4.1 The pipeline at a glance

```
1. MyelinSubscriber receives valid envelope on `local.{org}.tasks.code-review.<flavor>`
2. Extract { repo, pr, reviewer, feature, cycle, note } from payload — validate
3. Stash `envelope.id` as the correlation_id for downstream emissions
4. Choose target agent for this capability (look up cortex.yaml capability table)
5. Run preconditions (capability match, sovereignty, compliance, load) — see §7 nak handling
6. Emit `dispatch.task.started` lifecycle envelope (correlation_id = request envelope.id)
7. Construct a CC session prompt:
   - Persona prefix (Echo's persona.md)
   - Skill invocation: "use the code-review skill to review owner/repo#N"
   - Optional: feature / cycle / note context appended
8. Spawn ClaudeCodeHarness.dispatch(req)
   - Substrate runs the CodeReview skill end-to-end (5 lenses + GH posting)
   - Per-lens emission: `dispatch.task.progress` envelope after each lens completes
   - Skill posts the GitHub review via `gh pr review` (existing behaviour)
   - Skill returns a structured verdict object (parsed from CC session output)
9. Construct `review.verdict.{kind}` envelope per cortex#248 payload contract
   - Subject suffix matches verdict.kind ("approved" / "changes-requested" / "commented")
   - correlation_id = stashed request envelope.id (from step 3)
   - Payload: { repo, pr, reviewer, verdict, summary, github_review_id, github_review_url, submitted_at, commit_id, findings, inline_comments }
10. Emit `review.verdict.*` envelope
11. Emit `dispatch.task.completed` co-emitted with the verdict (architecture §7.3 lifecycle)
12. Ack the JetStream message (only after publish of both 10 and 11 returns)
```

### §4.2 Concrete file references — what changes, what's new

**Net new files:**

| File | Responsibility | Approx LoC |
|---|---|---|
| `src/runner/review-consumer.ts` | Top-level subscriber. Owns the `MyelinSubscriber`, the per-envelope pipeline, the in-flight tracking, and the shutdown lifecycle. | ~400 |
| `src/bus/review-events.ts` | Envelope constructors: `createReviewVerdictEvent({ kind, repo, pr, reviewer, ... })` per cortex#248. Mirrors the shape of `bus/dispatch-events.ts`. | ~150 |
| `src/bus/capability-registry.ts` | KV-backed capability advertisement (§3.3). | ~200 |
| `src/runner/review-pipeline.ts` | Glue between `review-consumer.ts` and `ClaudeCodeHarness`: builds the CC prompt, parses the structured verdict from skill output, normalises findings counts. | ~250 |
| `src/runner/__tests__/review-consumer.test.ts` | Stub-based integration tests (§11). | ~500 |
| `src/bus/__tests__/review-events.test.ts` | Envelope-shape conformance tests. | ~150 |

**Existing files modified:**

| File | What changes | Why |
|---|---|---|
| `src/cortex.ts` | Wire up `ReviewConsumer.start()` and `CapabilityRegistry.register()` after `mergedAgents` is built; add to shutdown sequence | Single entrypoint discipline (per CLAUDE.md "no ProcessManager" rule). |
| `src/bus/myelin/subscriber.ts` | Add `mode: "push" \| "pull"` option (default `"push"` for backwards compat); pull-mode branch swaps to JetStream `pullSubscribe` | §2.3 caveat — pull-consumer support. |
| `src/bus/nats/subscription.ts` | Sibling refactor to support both modes underneath | Same. |
| `src/common/types/cortex-config.ts` | Extend `AgentRuntimeSchema` (line 421) with two NEW sibling fields: `sovereignty` (enum) + `maxConcurrent` (positive int). **The capability data itself uses the existing `agents[].runtime.capabilities[]` field (Phase A.6, line 433) — NOT a new field.** Echo cortex#253 R1 caught the original draft's schema-drift proposal. | §3.4 — cortex.yaml's agent→capability mapping already exists; cortex#237 adds only the two runtime knobs. |
| `src/bus/index.ts` | Export the new `createReviewVerdictEvent` + `MyelinPullSubscriberOptions` types so pilot can read the contracts | Per `design-pilot-restructure.md` §7.4 — the public bus barrel needs to stay aligned. |

**What does NOT change:**

- `src/runner/dispatch-listener.ts` — unchanged. The generic `dispatch.task.received` path stays as-is. Code-review is a *parallel* ingress on a *different subject*.
- `src/bus/dispatch-handler.ts` — unchanged. Discord-mention path keeps working (§9 coexistence).
- `src/runner/cc-session.ts`, `src/runner/session-manager.ts`, `src/runner/prompt-builder.ts`, `src/runner/agent-team.ts` — unchanged. The CC session machinery is reused via `ClaudeCodeHarness` exactly as `dispatch-listener.ts` uses it.
- `src/runner/security-preamble.ts`, `src/runner/bash-guard.hook.ts` — unchanged. The security envelope around CC sessions stays identical.
- Surface-router, system-events helpers, federation policy gate — unchanged.

### §4.3 PR-ref extraction

The request envelope's payload (per `design-pilot-restructure.md` §4.1) carries `repo` (string `owner/repo`) and `pr` (integer). Validation in `review-consumer.ts`:

```
- payload.repo: string, matches /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
- payload.pr: integer, > 0
- payload.reviewer: string (optional; informational only — capability-dispatch routes by capability, not reviewer)
- payload.feature, payload.cycle, payload.note: optional, free-form
```

Malformed payload → emit `dispatch.task.failed` with `reason: { kind: "cant_do", detail: "payload validation failed: <which field>" }` and ack the JetStream message (don't re-deliver — bad payload is permanent). The `parsePayload` helper in `src/runner/dispatch-listener.ts:296` is the pattern to mirror; same shape.

### §4.4 Capability-to-agent routing

The `<flavor>` segment of the subject (`local.{org}.tasks.code-review.typescript` → `typescript`) determines which cortex.yaml agent handles this envelope. Routing table is built at consumer-start time from the merged-agents list:

```
capabilityToAgent: Map<string, Agent>
  "code-review.typescript" → agents.find(a => a.capabilities.includes("code-review.typescript"))
  "code-review.bun"        → ...
  "code-review.generic"    → ...
```

Multiple agents claiming the same capability → routing picks the first registered (deterministic; v1 simplification). Future v2 can do round-robin or load-aware routing using the `Registration.heartbeat(load)` data.

No matching agent → nak `cant_do` with `detail: "no agent registered for code-review.<flavor>"` (the pattern is already in cortex's test fixtures: `src/bus/__tests__/dispatch-events.test.ts:194` literally tests this string).

### §4.5 GH-side posting — reuse the skill's existing behaviour

The `CodeReview` skill already posts inline review comments and submits a GH review via `gh pr review`. This is part of the skill's contract (see `~/.claude/skills/code-review/SKILL.md`). The consumer does NOT re-implement GH posting; the consumer's role is bus orchestration around an unchanged skill invocation.

This is a load-bearing simplification: **the consumer treats the skill as a black box.** The skill produces a verdict object on stdout (or as the last assistant message in the CC stream); the consumer parses that into the verdict envelope payload. If we change how GH-side artefacts are produced (e.g. inline-comment formatting, summary line), we change the skill markdown — not the consumer code.

The parsing contract between skill and consumer is:

- Last assistant message in the CC stream contains a fenced JSON block:
  ```
  ```json
  {
    "verdict": "changes-requested",
    "summary": "verdict: blockers=0 majors=2 nits=3 — recommend: request-changes",
    "github_review_id": 2459183744,
    "github_review_url": "https://github.com/the-metafactory/cortex/pull/229#pullrequestreview-2459183744",
    "submitted_at": "2026-05-16T09:51:30Z",
    "commit_id": "a1b2c3d4...",
    "findings": { "blockers": 0, "majors": 2, "nits": 3 },
    "inline_comments": 5
  }
  ```
  ```

- The consumer's `review-pipeline.ts` extracts this block from the CC stream. Missing or malformed JSON → emit `dispatch.task.failed` with `reason: { kind: "cant_do", detail: "skill did not return parseable verdict block" }`. The Discord-mention path is unaffected because nobody parses CC stream output for Discord — Discord renders the prose.

This parsing contract is the only new coupling between consumer and skill. Documented as a skill-side update in §10 PR cluster (the existing skill markdown needs a "structured output" section telling the model to emit the JSON block).

### §4.6 Per-lens progress envelopes

Per anchor doc §7 (review workflow step 4) + architecture §7.3 lifecycle, the consumer emits `dispatch.task.progress` after each lens completes. Mechanism:

- The CC stream emits structured `tool_use` / `assistant_message` events as the model works (this is the existing CC streaming format, parsed by `src/runner/stream-parser.ts`).
- The skill marks lens transitions in its output. The simplest signal is: when the model writes a line matching `/^## Lens \d+:/`, the consumer emits a `dispatch.task.progress` envelope with `payload: { phase: "lens-{N}", lens_name: "<name>" }`.
- This is a heuristic, not a contract. Missed progress envelopes are not fatal — pilot's primary signal is the terminal `review.verdict.*` envelope. Progress is a Tier-2 visibility nicety per `architecture.md` §3.6.

Cleaner v2: the skill writes a synchronous side-channel JSON line per lens (e.g. `__cortex_progress__ { "lens": "CodeQuality", "status": "complete" }`) that the consumer picks up reliably. Echo cortex#253 R1 Minor-2 flagged that the regex `/^## Lens \d+:/` will silently miss lens transitions if the model formats them as `### Lens 1 — CodeQuality` or other variants — we'll only notice via pilot's dashboard showing nothing for long stretches. **Filing the structured side-channel JSON contract as a dedicated cortex follow-up issue (NOT leaving in §13 open-questions)** so it surfaces in PR-8's skill update planning rather than slipping. Until that lands, v1 progress envelopes are best-effort, not contract.

### §4.7 Visibility of the consumer in cortex's existing dashboards

The consumer's lifecycle envelopes (`dispatch.task.started/progress/completed/failed`) flow through the existing surface-router fan-out (cortex.ts wires it). The dashboard renderer, worklog-manager, and any subscribed Discord adapter renders them without modification — `dispatch.task.*` is already a renderer-known type. Principals see review activity on the dashboard without any new UI work for cortex#237.

---

## §5 — Correlation_id contract

This is **the single load-bearing contract** between cortex#237 and pilot. Without it, pilot's `wait-for-verdict --correlation-id <uuid>` cannot filter across N concurrent reviews on the same `review.verdict.>` subject.

### §5.1 The contract (per cortex#248 §4.2.1)

The verdict envelope's `correlation_id` field MUST equal the **request envelope's `id`** (the envelope that asked for the review, i.e. the inbound `tasks.code-review.<flavor>` envelope). This is the canonical contract per the cortex#248 ratification.

Same correlation_id MUST be set on:
- `dispatch.task.started` (emitted at pipeline start)
- Every `dispatch.task.progress` (emitted per lens)
- `dispatch.task.completed` (emitted at terminal)
- `review.verdict.{kind}` (emitted at terminal)
- `dispatch.task.failed` if the pipeline naks or crashes

### §5.2 The mechanism

The consumer stashes the request envelope's `id` in a per-task closure when the envelope arrives. All subsequent emissions for this task close over the stashed id. The stash lifecycle is: born on envelope receipt, dies when the terminal envelope (completed / failed / aborted) is acked.

Concretely, the per-envelope handler in `review-consumer.ts` looks like:

```
async handleEnvelope(envelope: Envelope, subject: string): Promise<void> {
  const requestEnvelopeId = envelope.id;
  const payload = parseReviewRequestPayload(envelope);
  if (payload === null) {
    await this.emitNak(envelope, "cant_do", "payload validation failed");
    return;
  }

  const taskId = crypto.randomUUID();  // new UUID for the dispatch.task lifecycle
  const correlationId = requestEnvelopeId;  // load-bearing: not the taskId, the request envelope id

  // started, progress, completed all use correlationId
  await this.runtime.publish(createDispatchTaskStartedEvent({
    source: this.source,
    taskId,
    agentId: this.routeToAgent(payload).id,
    correlationId,
    startedAt: new Date(),
  }));

  // ... run pipeline ...

  await this.runtime.publish(createReviewVerdictEvent({
    source: this.source,
    correlationId,        // ← THE CONTRACT
    verdict: pipelineResult.verdict,
    payload: pipelineResult,
  }));

  await this.runtime.publish(createDispatchTaskCompletedEvent({
    source: this.source,
    taskId,
    agentId,
    correlationId,
    startedAt,
    completedAt: new Date(),
    resultSummary: pipelineResult.summary,
  }));
}
```

**Note on the dual id space.** `dispatch.task.*` envelopes today use `taskId` as their correlation key (per `bus/dispatch-events.ts`'s `correlation_id ?? taskId` invariant — line 160). For the code-review pipeline, we override that default: the lifecycle envelopes use the *request envelope's* id, not a fresh task UUID. This is the right call because pilot is correlating against the request envelope it published — pilot has no knowledge of the cortex-side `taskId`. The two id spaces are reconciled in the consumer by always passing `correlationId: requestEnvelopeId` explicitly.

The `taskId` field still exists on the envelope payload (per the existing `DispatchTaskCommonOpts` shape) — it's the cortex-internal task UUID for stitching the lifecycle within cortex. Surfaces that already join on `taskId` (worklog-manager, agent-team) keep working; surfaces that join on `correlation_id` (pilot's verdict subscriber) get the right key.

### §5.3 The contract MUST hold across crashes

If the consumer crashes between emitting `dispatch.task.started` (with the right correlation_id) and emitting the terminal envelope, JetStream's redelivery semantics will re-deliver the request envelope to a competing consumer. The new consumer's pipeline must use the *same* request envelope id as the correlation_id — i.e. correlation_id is derived from the *received envelope*, never persisted out-of-band.

This is naturally satisfied by §5.2's "born on envelope receipt" stash lifecycle. There is no risk of "the crashed consumer's task A becomes the survivor's task B with a different correlation_id" — the JetStream redelivery hands the same envelope (same `id`) to the survivor, and §5.2 picks the correlation_id deterministically from `envelope.id`.

The only edge case is **the crashed consumer emitted `dispatch.task.started` and the survivor also emits one** — pilot sees two `started` envelopes for the same correlation_id. This is fine: pilot's spec (`design-pilot-restructure.md` §4.6) says "first matching verdict wins"; the lifecycle envelopes are advisory. Pilot's subscriber only terminates on a verdict envelope or `dispatch.task.completed/failed`; duplicate `started` is benign.

### §5.4 Witness in test

`src/runner/__tests__/review-consumer.test.ts` covers the contract explicitly:

- **Test 1:** Publish a `tasks.code-review.typescript` envelope with `id = X`. Capture all emissions. Assert every emitted envelope has `correlation_id == X`.
- **Test 2:** Two parallel requests with `id = A` and `id = B`. Capture emissions. Assert all `A`-derived emissions carry `correlation_id = A` and all `B`-derived carry `B`. No cross-talk.
- **Test 3:** Simulate consumer crash after `started`-emit but before `completed`-emit (cancel the in-flight promise). Manually re-deliver the same envelope. Assert the survivor's emissions all carry the same `correlation_id = X`.

---

## §6 — Verdict envelope construction

### §6.1 Use a new dedicated builder, not `createGithubEventEnvelope`

`src/bus/github-events.ts:createGithubEventEnvelope` is for envelopes derived from raw GitHub webhook events (PR opened, issue commented, etc.) emitted by the `gh-webhook` tap. It carries a `github_event` field, an `event_id` from GitHub's `X-GitHub-Delivery` header, and a sovereignty default optimised for webhook ingress.

The `review.verdict.*` envelope is a different beast:
- It is emitted by the *review consumer*, not by a webhook tap. The source is `{principal}.cortex.local` (cortex's `SystemEventSource` triple), not `{principal}.gh-webhook.relay`.
- Its payload is the structured review verdict per cortex#248 §4.2.1, not a GitHub webhook event.
- Its correlation_id is the request envelope id (the load-bearing pilot contract per §5), not the GitHub delivery id.

A shared builder would conflate two different envelope domains. **We add a new domain helper: `src/bus/review-events.ts`** mirroring the shape of `dispatch-events.ts`. The skeleton uses `bus/envelope-builder.ts:buildBaseEnvelope` underneath (same as dispatch-events, system-events, github-events all do).

### §6.2 The builder signature

```ts
// src/bus/review-events.ts

export type ReviewVerdictKind = "approved" | "changes-requested" | "commented";

export interface ReviewVerdictPayload {
  repo: string;
  pr: number;
  reviewer: string;
  verdict: ReviewVerdictKind;
  summary: string;
  github_review_id: number;
  github_review_url: string;
  submitted_at: string;  // ISO 8601
  commit_id: string;
  findings: {
    blockers: number;
    majors: number;
    nits: number;
  };
  inline_comments: number;
}

export interface CreateReviewVerdictEventOpts {
  source: SystemEventSource;
  correlationId: string;  // request envelope's id, per §5
  classification?: Classification;  // defaults to "local"
  payload: ReviewVerdictPayload;
}

export function createReviewVerdictEvent(opts: CreateReviewVerdictEventOpts): Envelope;
```

### §6.3 Subject derivation

The envelope's `type` field is `review.verdict.{kind}` where `kind` matches `opts.payload.verdict`. The wire subject is `local.{org}.review.verdict.{kind}` — the operator+org segment comes from the publishing side's NATS subject derivation (already handled by `MyelinRuntime.publish` via the namespace-derivation logic landed in IAW Phase A.3, per cortex#129).

The builder validates that `type` and `payload.verdict` match (defensive against the caller building an envelope of type `review.verdict.approved` with `payload.verdict: "commented"` — the discriminator MUST match the subject suffix per cortex#248).

### §6.4 Sovereignty default

Same posture as `dispatch.task.*` (per `bus/dispatch-events.ts` `defaultDispatchSovereignty`): `classification: "local"`, `data_residency: source.dataResidency ?? "NZ"`, `max_hop: 0`, `frontier_ok: false`, `model_class: "local-only"`. Review verdicts reveal PR metadata and reviewer findings; default keeps them principal-local. Federated reviews (cross-principal capability dispatch) can opt into `classification: "federated"` via the optional `classification` field; mirrors the IAW Phase A.3 parameterisation pattern.

### §6.5 Tests for envelope construction

`src/bus/__tests__/review-events.test.ts` covers:

- Each of the three verdict kinds builds an envelope with the right `type` and subject-suffix-equivalent payload discriminator.
- `correlation_id` is set on the envelope iff `correlationId` is provided.
- The cortex#248 payload contract is enforced field-by-field (required vs optional, types, semantic constraints like `verdict ∈ enum`).
- Builder throws (or returns a validation error) when `type` and `payload.verdict` disagree.

---

## §7 — Nak handling — emit `dispatch.task.failed` with structured reasons

Per cortex#249 (just merged), `DispatchTaskFailedReason` has five discriminator kinds: `policy_denied` (existing), `cant_do`, `wont_do`, `not_now`, `compliance_block` (the four nak kinds named in architecture §7.3, surfaced to pilot per `design-pilot-restructure.md` §4.4).

The consumer's preconditions decide which nak kind to emit. Concrete preconditions per kind:

### §7.1 `cant_do` — capability mismatch

**Preconditions** (any of):

- `<flavor>` segment of the subject is not in any agent's `capabilities` list in cortex.yaml. (E.g. `tasks.code-review.elm` arrives; no agent claims `code-review.elm`.)
- Payload validation fails (malformed `repo`, missing `pr`, etc.). Permanent — principal must fix the request, not retry.
- The named `agent_id` in payload (if specified for Direct mode per architecture §7.1) doesn't exist in cortex.yaml.
- The skill is not on the agent's `allowedSkills` list (principal misconfigured cortex.yaml — granted the capability but didn't grant the skill).

**Emit:** `dispatch.task.failed` with `reason: { kind: "cant_do", detail: "<which precondition>" }`. Ack the JetStream message (don't re-deliver — capability mismatch is permanent until cortex.yaml changes and cortex restarts).

### §7.2 `wont_do` — sovereignty refuses

**Preconditions:**

- The request envelope's sovereignty (`envelope.sovereignty`) requires `model_class: "frontier"` but the agent's declared sovereignty is `selective` and the agent's persona forbids frontier models.
- The request's `classification: "federated"` arrives on a `local.*` subject (subject/envelope mismatch per IAW Phase A.3 validateSubjectEnvelopeAlignment).
- The request's `data_residency` doesn't match the agent's declared residency.

**Emit:** `dispatch.task.failed` with `reason: { kind: "wont_do", detail: "<sovereignty mismatch detail>" }`. Ack — sovereignty refusal is permanent for this request (principal action needed; retrying the same envelope won't help).

### §7.3 `not_now` — backpressure

**Preconditions:**

- The agent's in-flight review count is at or above `maxConcurrent` (from cortex.yaml).
- The cortex daemon is in shutdown mode (`SIGTERM` received; new envelopes are nakked rather than admitted to a draining queue).
- A transient infrastructure failure (NATS publish failure on the lifecycle envelope; CC binary not found; etc.). Principal-recoverable.

**Emit:** `dispatch.task.failed` with `reason: { kind: "not_now", detail: "<reason>", retry_after_ms: <hint> }`. **Nak** the JetStream message (not ack) so it redelivers after the redelivery backoff. The `retry_after_ms` is advisory only; JetStream's redelivery schedule wins.

### §7.4 `compliance_block` — compliance attestation forbids

**Preconditions:**

- The agent's `compliance` block in cortex.yaml (per a customer Gen-AI compliance-standard pattern, anchor doc §1 stratification §7.5) declares the request's classification / model-class / data-residency combination as forbidden.
- The request's `extensions.actor.id` is on a compliance deny-list for this agent.

**Emit:** `dispatch.task.failed` with `reason: { kind: "compliance_block", detail: "<compliance rule>" }`. Ack — compliance refusal is permanent for this request.

This kind is the most aspirational of the four — cortex does not yet have a compliance-attestation block in cortex.yaml (architecture §7.5 says "the slot exists" but the schema isn't there). **Implementation decision (Echo cortex#253 R1 Minor-5):** v1 does NOT ship the dead `compliance_block` branch. The `switch` statement in the consumer's nak handler omits the `compliance_block` case entirely; when §13.5's compliance-attestation schema lands, we add the branch in the same PR that introduces the trigger conditions. This avoids the dead-branch-rot anti-pattern while keeping the taxonomy upstream (cortex#249) ready for the eventual extension. The discriminator kind stays declared in `DispatchTaskFailedReason` — only the consumer-side handling omits it for v1.

### §7.5 The nak emission point

Naks happen **at the very start of the per-envelope pipeline**, BEFORE emitting `dispatch.task.started`. The consumer's pipeline:

```
parse payload → fail? → emit dispatch.task.failed(cant_do)
check capability match → fail? → emit dispatch.task.failed(cant_do)
check sovereignty → fail? → emit dispatch.task.failed(wont_do)
check load → over max? → emit dispatch.task.failed(not_now)
check compliance → forbid? → emit dispatch.task.failed(compliance_block)
all preconditions OK → emit dispatch.task.started → run pipeline
```

This means a nakked task **does not** emit `dispatch.task.started`. Pilot's `wait-for-verdict` subscribes to `local.{org}.review.verdict.>` AND `local.{org}.dispatch.task.completed` AND `local.{org}.dispatch.task.failed` (per `design-pilot-restructure.md` §5.1 step 4a). A `failed`-only sequence is the correct nak signal; pilot exits 3 or 4 per the reason kind.

### §7.6 The CC-session-side failure case

What if the preconditions all pass, `dispatch.task.started` emits, the CC session spawns, and the model crashes / times out / produces unparseable output? This is **not a nak** — it's an honest pipeline failure. We emit `dispatch.task.failed` with `reason: { kind: "not_now", detail: "review pipeline failed: <error>", retry_after_ms: 0 }` and ack. The model-side failure isn't truly capability-mismatch (the agent COULD do it; the substrate broke), and `cant_do` would tell pilot to exit 3 (permanent — don't retry) which is the wrong operational signal for a transient CC crash. `not_now` is the closest match in cortex#249's taxonomy — "transient, retry safe" — and pilot's `design-pilot-restructure.md` §4.4 maps it to exit 4 (transient), which is the right operational shape. The `retry_after_ms: 0` hint says "no enforced cooldown; retry whenever you want."

Echo cortex#253 R1 (Major-2) correctly flagged the original `cant_do` choice. Filing a follow-up issue to extend `DispatchTaskFailedReason` with a dedicated `substrate_failed` discriminator (cortex#249's anticipated `substrate_unavailable` already namechecked in `dispatch-events.ts:260-264`) — once that lands, this section flips from `not_now` to `substrate_failed` for semantic precision. Tracked in §13 open question 4.

In all cases, a `dispatch.task.failed` MUST follow any emitted `dispatch.task.started` — never leave pilot waiting on a phantom in-flight task.

---

## §8 — Lifecycle envelopes — co-emission and timing

Per architecture §7.3 + anchor doc §4.2, the consumer emits the full `dispatch.task.*` lifecycle around each review.

### §8.1 The lifecycle sequence

| Envelope | When | Payload extras (beyond `task_id`, `agent_id`, `correlation_id`) |
|---|---|---|
| `dispatch.task.started` | Right after preconditions pass; before CC session spawn | `started_at: <ISO8601>` |
| `dispatch.task.progress` | After each lens completes (heuristic per §4.6 v1) | `phase: "lens-{N}"`, `lens_name: "<name>"`, `at: <ISO8601>` |
| `dispatch.task.completed` | Co-emitted with `review.verdict.*` (terminal success) | `started_at`, `completed_at`, `result_summary: <verdict.summary>` |
| `dispatch.task.failed` | Nak path (§7) OR substrate failure (§7.6) | `started_at`, `failed_at`, `error_summary`, `reason: <DispatchTaskFailedReason>` |
| `dispatch.task.aborted` | Principal cancel OR shutdown timeout (§2.4) | `started_at`, `aborted_at`, `reason: "shutdown" \| "principal-cancel" \| "timeout"` |

### §8.2 Emission ordering — verdict and `dispatch.task.completed`

The success path co-emits two terminal envelopes:
- `review.verdict.{kind}` on `local.{org}.review.verdict.{kind}`
- `dispatch.task.completed` on `local.{org}.dispatch.task.completed`

**Order on the wire:** `review.verdict.*` FIRST, then `dispatch.task.completed`. Rationale: the pilot subscriber's "first matching event wins" logic (`design-pilot-restructure.md` §4.6) treats the verdict as the primary signal and `dispatch.task.completed` as the crash-resilience signal ("if `completed` arrives without preceding `verdict`, infer `commented` with a warning"). Emitting verdict first means the happy-path race always resolves on the verdict envelope; the `completed` envelope is just the lifecycle's structural close.

Mechanism: `await runtime.publish(verdictEnvelope); await runtime.publish(completedEnvelope);`. Both awaits are required — `MyelinRuntime.publish`'s contract is the publish completes (or errors) when awaited. Sequential awaits guarantee verdict lands before completed on the wire.

If the verdict publish fails (e.g. transient NATS hiccup) but the `completed` publish would succeed, we still want pilot to see *something* terminal. Failure handling:

- Verdict publish error → log, then emit `dispatch.task.failed` with `reason: { kind: "cant_do", detail: "verdict publish failed: <err>" }`. Skip the `completed` publish. Pilot sees `failed` → exits 3.
- Completed publish error after successful verdict → log, ack the JetStream message anyway (we already emitted the verdict; pilot will see it). The missing `completed` envelope is a Tier-2 visibility loss, not a correctness break.

### §8.3 Lifecycle envelopes' `correlation_id` matches the verdict's

All five lifecycle envelopes carry the SAME `correlation_id` (the request envelope's id, per §5). Pilot's subscription pattern is `local.{org}.review.verdict.>` ∪ `local.{org}.dispatch.task.completed` ∪ `local.{org}.dispatch.task.failed`; the correlation_id filter is the join key across both subject domains.

### §8.4 The `dispatch.task.completed` payload's `result_summary`

Per anchor doc §4.2 + cortex#248, `dispatch.task.completed` carries an optional `result_summary` (human-readable). The consumer populates this with the verdict's `summary` field (e.g. `"verdict: blockers=0 majors=2 nits=3 — recommend: request-changes"`). Surfaces (dashboard, worklog-manager) can render either envelope's payload to show the same outcome; redundant by design for crash-resilience.

---

## §9 — Coexistence with Echo's Discord-mention path

Per cortex#237 acceptance criteria: "Existing Discord-mention path stays operational during the transition (parallel paths, not a hard cutover)."

### §9.1 The two ingress paths

| Path | Trigger | Code path | Effect |
|---|---|---|---|
| **Discord-mention (existing)** | Principal types `@Echo review the-metafactory/cortex#229` in Discord | `DiscordAdapter.messageCreate` → `DispatchHandler.handleMessage` → `CCSession` with `code-review` skill | CC session runs CodeReview skill → posts GH review → posts prose response to Discord |
| **Capability-dispatch (new)** | Pilot publishes `tasks.code-review.typescript` envelope | `ReviewConsumer.handleEnvelope` → `ClaudeCodeHarness.dispatch` → CC session with `code-review` skill | CC session runs CodeReview skill → posts GH review → emits `review.verdict.*` envelope (no Discord render) |

The two paths converge at "CC session running the CodeReview skill on a PR." The only differences are (a) what triggered the session and (b) what happens to the output.

### §9.2 How they share the skill pipeline without collision

The CodeReview skill is stateless from the pipeline's perspective — each invocation is a fresh CC session with a fresh PR-context fetch and a fresh lens pass. The skill doesn't maintain any global state that could collide between concurrent invocations from different ingress paths.

The two paths share:
- The skill markdown (`~/.claude/skills/code-review/SKILL.md`).
- The lens implementations (CodeQuality, Security, Architecture, EcosystemCompliance, Performance — referenced from the skill).
- The `gh` CLI binary and its auth.

The two paths do NOT share:
- The CC session itself (each invocation spawns its own subprocess).
- The CC session's working directory (each invocation gets its own dir per `effectiveDirs` resolution in `dispatch-handler.ts`).
- The CC session's session-id / conversation history.

So if a principal @-mentions Echo to review PR #229 at 09:42 and pilot publishes a `tasks.code-review.typescript` envelope for PR #229 at 09:42:30, you get **two parallel CC sessions both running the CodeReview skill on PR #229**. Both will post GH reviews. Both will produce a verdict. This is OK in v1 — duplicate reviews are noisy but not broken (GitHub permits multiple reviews on the same PR).

### §9.3 Race-condition mitigation (v2, not v1)

The duplicate-review scenario above is undesirable but rare in practice — the Discord-mention path is used interactively (a principal typing), while the capability-dispatch path is automated (pilot's review loop). They typically don't fire in the same window. For v1 we ship without race mitigation and accept the rare duplicate.

For v2, we add a **per-PR in-flight lock** at the skill level: the skill checks a "is there already an active review session for {repo}#{N}?" registry before running the lens pipeline; if yes, the new session degrades to "post a comment saying 'a review is already in flight, see prior'" rather than running its own pass. Tracked in §13.

### §9.4 What happens when both paths post to GitHub

GitHub's review API permits multiple reviews per PR per reviewer. If both paths submit a review under the same `github_user` (the `echo` bot), you get two `pullrequestreview` records on the PR. Pilot's `wait-for-verdict` correlation_id filter cleanly disambiguates which verdict belongs to which pilot request (the Discord-mention path doesn't emit a `review.verdict.*` envelope — see §9.5); the GH-side artefacts may look noisy but are not broken.

### §9.5 The Discord-mention path does NOT emit `review.verdict.*`

Critical for clean coexistence: the Discord-mention path stays exactly as it is today. It does NOT learn to emit `review.verdict.*` envelopes. Rationale:

- The Discord-mention path doesn't have a `correlation_id` to bind to (no request envelope was published).
- Pilot is the only consumer of `review.verdict.*` today; pilot only cares about verdicts that match its requests.
- Emitting orphan verdicts (no correlation_id) onto the bus would pollute pilot's subscription with un-matchable envelopes.

If a future feature wants "every Echo review, regardless of ingress, emits a bus envelope for dashboard visibility," that's a separate envelope domain (e.g. `system.review.posted` per the earlier cortex#232 design proposal). The verdict envelope is specifically the capability-dispatch reply; do not overload it.

### §9.6 Coexistence retires when pilot Phase D lands

Per `design-pilot-restructure.md` §6.5 (Phase D), pilot retires the Discord-mention review path once Phase C is operationally proven (≥5 cycles over 48h). At that point cortex#237's consumer is the *only* path that pilot uses. The Discord-mention path remains in cortex for **principal-initiated** reviews (a principal typing into Discord) — that workflow is unrelated to pilot and continues indefinitely.

---

## §10 — Phased implementation plan

The PR cluster ships in order. Each PR is independently mergeable + CI-green per the implementation workflow rules in CLAUDE.md.

### §10.1 PR cluster

| PR | Scope | Depends on | Approx LoC | Tests | CI gates |
|---|---|---|---|---|---|
| **PR-1** | `src/bus/myelin/subscriber.ts` + `src/bus/nats/subscription.ts` learn `mode: "pull"`. JetStream pull-consumer wiring. Unit tests on the mode flag and the pull-vs-push behavioural parity. No new consumers wired yet. | None (cortex#249, cortex#250 already merged) | ~150 net new | Subscriber tests for both modes; behavioural parity test | tsc, bun test, ESLint |
| **PR-2** | `src/bus/review-events.ts` — `createReviewVerdictEvent` helper per §6. Pure code + unit tests; nothing imports it yet. | None | ~150 + 150 tests | Envelope-shape tests per §6.5 | tsc, bun test |
| **PR-3** | `src/bus/capability-registry.ts` — `CapabilityRegistry` primitive per §3.3. Publish-only mode (no bucket reader). Unit tests on the registration envelope shape; integration test against a stub `MyelinRuntime`. | None | ~200 + 250 tests | Registration shape tests; happy-path integration | tsc, bun test |
| **PR-4** | Schema update: extend `AgentRuntimeSchema` with two NEW sibling fields — `sovereignty` (enum) + `maxConcurrent` (positive int). **NO new capability field — `agents[].runtime.capabilities[]` already exists from Phase A.6** (cortex-config.ts:433), and the top-level `capabilities[]` catalog already exists (line 1574) with Phase A.6.3 cross-validation. PR-4 only adds the two runtime knobs. Schema validation tests for the new fields. Backwards-compat (existing cortex.yaml without these two fields stays valid). Echo cortex#253 R2 carry-over fix. | None | ~50 + 100 tests | Config-loader tests; round-trip parse | tsc, bun test |
| **PR-5** | `src/runner/review-pipeline.ts` — prompt builder + verdict parser per §4.5. Pure code + unit tests on the parsing contract; uses stub CC stream output. No actual subscriber wiring yet. | PR-2 | ~250 + 300 tests | Verdict-parser tests for valid + malformed skill output | tsc, bun test |
| **PR-6** | `src/runner/review-consumer.ts` — top-level subscriber per §2 + §4 + §5 + §7 + §8. Wires the `MyelinPullSubscriber` (PR-1), the verdict builder (PR-2), the capability registry (PR-3), the config schema (PR-4), and the pipeline (PR-5). Wired into `src/cortex.ts`. Integration tests per §11. | PRs 1, 2, 3, 4, 5 | ~400 + 500 tests | Full pipeline integration via stub bus + stub CC | tsc, bun test |
| **PR-7** | `src/bus/index.ts` exports: `createReviewVerdictEvent`, `ReviewVerdictKind`, `ReviewVerdictPayload`, pull-subscriber types. Mechanical addition to the public bus barrel. | PRs 1, 2 | ~30 + 0 tests | Barrel export shape test (already in cortex's existing pattern) | tsc |
| **PR-8** | `~/.claude/skills/code-review/SKILL.md` learns to emit the structured-verdict JSON block at the end of its output. Markdown-only PR. Doesn't break the Discord-mention path (the prose response still goes to Discord; the JSON block is appended). | None (independent) | ~30 markdown lines | Skill markdown stays renderable | None (markdown) |
| **PR-9** | End-to-end integration test: spawn cortex with a stub NATS, publish a `tasks.code-review.typescript` envelope, assert the full lifecycle + verdict envelope sequence arrives correctly correlated. The test is real cortex + stub bus + stub CC factory. | PR-6, PR-8 | ~400 lines | Full E2E correlation test | tsc, bun test |

Total ~1,260 LoC of new source + ~1,500 LoC of tests. ~30 markdown lines for the skill update. Spread across 9 PRs over an estimated 1–2 weeks of work, each PR reviewable in < 30 minutes.

### §10.2 PR sequencing rationale

- PR-1 first because the pull-subscriber is the foundational primitive used by PR-6.
- PR-2 and PR-3 can land in parallel after PR-1 — both pure-code with no consumer.
- PR-4 is independent of bus changes — schema update is its own concern.
- PR-5 depends on PR-2 (uses the verdict-builder shape in its parser tests).
- PR-6 is the integration PR — most reviewable last when all its dependencies are stable.
- PR-7 lands alongside PR-6 (technically the barrel export could land anytime after PR-2, but we delay until the consumer exists so the public surface and the in-cortex consumer are sane together).
- PR-8 is independent — the skill change doesn't break the Discord-mention path's prose output (the JSON block is purely additive). Lands before PR-6 so PR-6's tests can use a real skill update, but reviewable in isolation.
- PR-9 is the closing acceptance test — proves the producer-side is operationally complete and ready for pilot Phase C.

### §10.3 Each PR's "what stays compatible vs what breaks"

- PRs 1, 2, 3, 4, 5, 7, 8: zero behavioural change to existing cortex. Pure additions or backwards-compat schema updates. Discord-mention path entirely unaffected.
- PR-6: cortex daemon now connects to one additional NATS subject (`local.{org}.tasks.code-review.>`) and writes capability advertisement on startup. If no agent has `capabilities` in cortex.yaml, the consumer and registry are dormant (zero observable behaviour). If at least one agent has `capabilities`, cortex starts publishing capabilities AND accepting code-review envelopes. The Discord-mention path is unaffected (it runs alongside).
- PR-9: test-only; no production change.

### §10.4 Rollback

Each PR is revertable individually. The terminal state (PR-6 merged + at least one agent has `capabilities`) is the only state with a behaviour change. Reverting PR-6 stops the consumer from claiming tasks; pilot's `wait-for-verdict` then times out — pilot's spec already handles this case (fall through to `wait-for-review` GitHub fallback per §4.5). Rollback is operationally safe.

---

## §11 — Tests and integration story

### §11.1 Test layering

**Layer 1 — unit tests (per PR, fast, deterministic).**

- PR-1: `subscriber.test.ts` covers both modes; pull-mode acks correctly; push-mode unchanged.
- PR-2: `review-events.test.ts` per §6.5.
- PR-3: `capability-registry.test.ts` covers registration envelope shape + KV write call.
- PR-4: `config-loader.test.ts` extended for new fields.
- PR-5: `review-pipeline.test.ts` covers prompt assembly + verdict parsing (valid block, malformed block, no block, multiple blocks).

**Layer 2 — integration tests (PR-6, stub-based, fast).**

- Full envelope lifecycle: publish a task → assert started → assert progress (≥1) → assert verdict + completed.
- Correlation-id contract (§5.4): single-task and parallel-task tests.
- Each of the 5 nak preconditions (§7) emits the right `DispatchTaskFailedReason`.
- Crash + redelivery: simulate consumer crash after `started`-emit; verify the redelivered envelope produces a complete lifecycle.
- Shutdown drain (§2.4): start a review, request shutdown, verify `dispatch.task.aborted` emits before the cortex daemon exits.
- Capability-routing: two agents claiming different `<flavor>`s; envelopes route to the right agent based on subject suffix.
- Coexistence (§9.2): Discord-mention path and capability-dispatch path can run concurrently against the same PR without runtime collision.
- **Negative coexistence (Echo cortex#253 R1 Minor-4):** Discord-mention path does NOT emit `review.verdict.*` envelopes. Send a `@Echo review the-metafactory/cortex#229` Discord message → assert ZERO `review.verdict.*` envelopes emitted on the bus during the review's full lifecycle. Protects against future drift where someone tries to unify the two paths and accidentally emits orphan verdicts onto pilot's subscription.

**Layer 3 — end-to-end test (PR-9, stub bus + real cortex + stub CC).**

- Real `MyelinRuntime` against a stub NATS connection (the existing pattern in `src/bus/__tests__/`).
- Real `ReviewConsumer` wired into a real cortex bootstrap.
- Stub `CCSessionFactory` that produces a fake CC stream containing the verdict JSON block.
- Publish a `tasks.code-review.typescript` envelope via the stub NATS; capture all emissions; assert the cortex#248 contract end-to-end.
- This is the test that, when green, signals cortex#237 is ready for pilot Phase C.

### §11.2 What we deliberately do NOT test

- **Real NATS server.** The integration tests stub the runtime; we don't spawn a `nats-server` in CI. Pattern matches cortex#234 (per `design-pilot-restructure.md` §8.7 recommendation: "stub-based primary; one or two live-server smoke tests in CI to catch obvious wiring regressions"). A nice-to-have follow-up is a CI-hosted live-NATS smoke test gated behind a `--integration` flag, but not for the first PR.
- **Real CC subprocess.** The CC binary is too expensive to invoke in CI. Stub factory pattern from `dispatch-listener.test.ts` is the precedent.
- **Real GitHub PR.** The skill posts to GitHub via `gh pr review`; the test stubs the `gh` invocation. A live-GH smoke test against a sacrificial test repo is an aspirational follow-up.

### §11.3 Test fixtures

- `src/runner/__tests__/fixtures/review-request-envelope.json` — a valid request envelope per `design-pilot-restructure.md` §4.1.
- `src/runner/__tests__/fixtures/verdict-block-approved.txt`, `verdict-block-changes-requested.txt`, `verdict-block-commented.txt` — sample CC stream outputs with embedded verdict JSON.
- `src/runner/__tests__/fixtures/cortex.yaml-with-capabilities.yaml` — minimal cortex.yaml with at least one agent declaring `capabilities: ["code-review.typescript"]`.

### §11.4 Acceptance: how we know cortex#237 is "done"

The acceptance criteria from cortex#237's issue body plus pilot Phase C's quantitative cutover gate (`design-pilot-restructure.md` §6.4):

- [ ] PR-1 through PR-9 merged, all CI green.
- [ ] PR-9's E2E test demonstrates the full lifecycle end-to-end against a stub bus.
- [ ] In production: a real `pilot request-review --pr X --capability code-review.typescript --wait` invocation receives a `review.verdict.*` envelope correlated on the request envelope's id, with the full cortex#248 payload, within the timeout window.
- [ ] ≥5 consecutive real review cycles across ≥2 PRs over ≥48 hours, with all five satisfying pilot Phase C's quantitative gate (correlation_id matches, `dispatch.task.completed` arrives within 60s of `review.verdict.*`, zero github.* fallback usage).

When the last bullet ticks, cortex#237 is operationally proven and pilot can flip to Phase D (Discord-mention retirement).

---

## §12 — Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pull-consumer refactor (PR-1) breaks the existing push-mode subscribers | Medium | High — every cortex subscriber lives downstream | Behavioural-parity test in PR-1 covering every existing subscriber's expected behaviour. Default `mode: "push"` keeps all existing call sites unchanged. |
| The CodeReview skill output isn't reliably parseable (free-form prose creeps into the JSON block) | High | High — verdict envelope can't be constructed | Skill markdown update in PR-8 with explicit "ALWAYS emit the JSON block at the end, fenced, exactly once" guidance. Verdict parser is forgiving — extracts the last fenced JSON block matching the schema; permissive about surrounding prose. Defensive nak (`cant_do: skill did not return parseable verdict block`) when parsing fails. |
| Capability registry's KV-bucket primitive (PR-3) is new code with no operational precedent | Medium | Medium — registration may silently fail | Publish-only v1 (§3.5) means the registration is fire-and-forget; consumer behaviour is unaffected by registration failure. Heartbeat path is opt-in. Principal visibility via the `system.*` envelopes the registry emits on register/unregister. |
| Pilot publishes envelopes faster than the consumer can process (backpressure) | Low (today's review tempo is human-paced) | Medium — `not_now` naks cause pilot to retry | `maxConcurrent` per agent in cortex.yaml gives principals a knob. JetStream's pull-consumer semantics naturally pace work. `not_now` nak with `retry_after_ms` hints lets pilot retry intelligently. |
| Crash mid-pipeline leaves orphan `dispatch.task.started` without a terminal envelope | Low | High — pilot waits forever (until timeout) | §2.4 shutdown drain emits `dispatch.task.aborted` for in-flight reviews. JetStream redelivery ensures the survivor consumer picks up the same envelope and emits a fresh `started` + terminal. Pilot's correlation-id filter accepts the survivor's `completed` regardless of how many `started`s preceded. |
| The skill's GH-posting fails (rate-limit, transient network) | Medium | Medium — skill produces a verdict block but the GH-side review isn't posted | Skill returns the failure in the JSON block (`verdict: "commented"` with a summary noting GH post failed). Consumer emits a `commented` verdict regardless. Principal sees the failure in the summary; pilot retries on next cycle. v2 improvement: skill emits `dispatch.task.failed` with `not_now` for GH rate-limit per anchor doc §12 ("GitHub rate limit → `dispatch.task.failed` with `not_now`"); v1 ships the simpler "commented" fallback. |
| Two consumers (cortex-Echo + a future pi.dev-Echo) on the same JetStream pull consumer group race for the same envelope | Low (Path B is not yet built) | Low — JetStream's at-most-one delivery is by design | Acknowledge that the wire contract supports the case (§1.3 — Path A doesn't foreclose Path B). When Path B ships, the principal decides which instance is authoritative (e.g. disable cortex-Echo via cortex.yaml). |
| An agent's `runtime.capabilities[]` entry on cortex.yaml is misconfigured (e.g. typo `code-revew.typescript`) and silently no one claims the typo capability | High (config typos are common) | Low — pilot times out, principal notices | v1 ships a startup log line listing all registered capabilities. v2 adds a JSON Schema validator on the catalog-side capability ids (regex `code-review\.[a-z]+`); Phase A.6.3 cross-validation already catches typos that don't resolve to a top-level catalog entry. Tracked in §13. |
| Echo's persona declarations are spread across cortex.yaml (capability + skill grants + presence) and persona.md; a principal changing one without the other produces silent capability drift | Medium | Low — principal-visible (review quality changes; observable in dashboards) | Document the persona-file ↔ cortex.yaml coupling in cortex.yaml's schema docstring. v2: emit a `system.config.warning` envelope at startup when an agent declares a capability but doesn't have the matching skill on its allowlist. Tracked in §13. |

---

## §13 — Open questions

These are genuine ambiguities not resolved by the existing design-doc set or the cortex#237 issue body. Surface for resolution before PR-6 (the integration PR) lands.

### §13.1 — Capability registry bucket reader (§3.5 deferral) — **BLOCKS PILOT PHASE B.4**

v1 ships publish-only registration. **Pilot Phase B.4's "capability-aware pre-publish gate" depends on this** — without the bucket reader, pilot can't honour `design-pilot-restructure.md` §8.2's "warn if registry has zero consumers for this capability" check. The wire contract is one-way today: cortex publishes, no one reads. Two open questions:

- Does the reader live in cortex (`src/bus/capability-registry.ts` grows a `lookup(capability)` method) or in myelin (a generic primitive sibling to the federation registry client)?
- Does pilot read it directly via NATS KV, or via a cortex-side HTTP endpoint that proxies the lookup?

Recommendation: cortex-side reader in `capability-registry.ts`, exported via the bus barrel; pilot reads it via NATS KV directly using the same myelin KV primitive cortex publishes through. Defers the M5 Discovery formalisation (myelin#9) to a separate effort. **Filing as a dedicated cortex issue rather than leaving in open-questions** so it surfaces in pilot Phase B planning (Echo cortex#253 R1 Minor-1).

### §13.2 — Substrate decoupling follow-up (Path B as future migration)

The §1.3 decision takes on decoupling debt. We need an explicit follow-up issue: "Once cortex#237 has operated for 30 days, evaluate building Path B as a pi.dev review agent that runs as a competing consumer on the same JetStream pull consumer group; deprecate the in-cortex consumer if Path B proves more reliable / operationally cleaner."

Owner: TBD post-cutover. The evaluation criteria are operational (reliability over 30 days), not architectural (Path B is architecturally cleaner regardless; the question is whether the operational cost of two processes is worth the cleanliness gain).

### §13.3 — Multi-network / federated capability discovery

Architecture §7.2 specifies one capability bucket per principal (`local.{org}.agents.capabilities`). When the IAW federation work ships full multi-network routing (cortex#116 Phase D landed but federated capability discovery is downstream), a request published on `federated.{network}.tasks.code-review.typescript` needs to discover federated consumers' capabilities.

Open: does cortex#237's consumer also subscribe to `federated.*.tasks.code-review.>` and treat federated requests symmetrically? Or is federated dispatch a separate consumer with its own sovereignty checks?

Recommendation: v1 ships local-only (`local.*` subjects only). Federated review-consumer is a Phase E follow-up after the federation discovery primitive ships. Track in §13.

### §13.4 — `substrate_failed` nak kind

The cortex#249 `DispatchTaskFailedReason` taxonomy has four nak kinds (`cant_do`, `wont_do`, `not_now`, `compliance_block`) — none of which cleanly represents "the substrate (CC session) crashed mid-review through no fault of the agent's intent." §7.6 uses `not_now` (with `retry_after_ms: 0`) as the closest non-permanent match — this maps to pilot's exit-4 (transient, retry-safe) per `design-pilot-restructure.md` §4.4, which is the right operational shape for a transient CC crash. The architectural ideal is a dedicated `substrate_failed` discriminator.

Open: extend the taxonomy in cortex#237's PR cluster, or file separately?

**Recommendation: separate issue.** cortex#249 just merged; reopening the taxonomy in this consumer's PR cluster expands scope. v1 uses `not_now` per §7.6; file a follow-up issue for `substrate_failed`; consumer flips from `not_now` to `substrate_failed` once the extension ships. (Echo cortex#253 R2 carry-over fix — original draft narrated `cant_do` which contradicted §7.6's `not_now` choice.)

### §13.5 — Compliance attestation schema (§7.4 dependency)

The `compliance_block` nak kind is wired in code but has no cortex.yaml schema for compliance attestations. Architecture §7.5 says "the slot exists"; the schema does not. What does an agent's compliance attestation look like in cortex.yaml? STD-EXAMPLE-AI-001 is the cited example but its schema isn't anywhere in the repo.

Recommendation: out of scope for cortex#237. The `compliance_block` branch is structurally wired but operationally never fires until compliance attestation is specified in a separate issue. Track in §13.

### §13.6 — Skill-side structured-verdict contract (§4.5 + PR-8)

PR-8 updates the CodeReview skill to emit a structured JSON verdict block. The skill is checked into cortex (well, into ~/.claude/skills/, which is principal-side, not cortex-repo). Two open questions:

- Does the skill ship as part of cortex, or stays as a principal-managed skill that principals install separately? Today it's the latter (per the `~/.claude/skills/` location).
- If the latter, how do we version-pin the skill so cortex#237's verdict-parser knows what schema to expect?

Recommendation: skill stays principal-side; cortex#237's parser is permissive about minor schema drift (extracts the verdict block by JSON-schema match on the required fields, ignores extras). Document the contract in PR-8's skill markdown so principals updating the skill don't break it. The verdict parser's tests cover the "permissive matching" behaviour. Track schema versioning as a future concern.

### §13.7 — Per-PR in-flight review lock (§9.3)

The §9.3 scenario (Discord-mention path and capability-dispatch path running concurrent reviews of the same PR) is benign in v1 but noisy. v2 should add a per-PR lock. Where does the lock live?

- In the skill (the skill consults a local "in-flight reviews" registry before running)? Couples skill to consumer.
- In the consumer (the consumer queries the dispatch-handler's task-tracker for "is the skill already running on this PR")? Couples bus consumer to dispatch-handler.
- In a shared `src/common/review-locks.ts` primitive? Cleanest.

Recommendation: shared primitive (option 3) when v2 ships. v1 accepts the duplicate-review noise. Track in §13.

### §13.8 — How long does the principal wait for shutdown drain?

§2.4 picks a 30s grace window before force-aborting in-flight reviews on shutdown. This is a guess — typical lens pipelines run 30s–5min. 30s is aggressive (force-aborts most reviews); 5min is principal-frustrating.

Recommendation: ship 30s in v1; make it configurable in cortex.yaml (`reviewConsumer.shutdownGraceMs` defaulting to 30000) so principals can tune. Track the operational data: if principals routinely raise it to 300000, the default is wrong.

---

## §14 — References

- `docs/architecture.md` §3, §7.2, §7.3, §7.5 — capability-driven dispatch model, four-way nak taxonomy, stratification rules.
- `docs/design-pi-dev-review-agent.md` §4, §7 — bus contracts, review workflow, capability registration.
- `docs/design-pilot-restructure.md` §4 (caller-side contract), §5 (CLI contracts), §6.4 (Phase C cutover gate), §7.4 (the bus barrel surface), §8 (open questions table).
- cortex#237 — this consumer's issue, acceptance criteria.
- cortex#232 — pilot-side restructure umbrella.
- cortex#238 — IAW Wave 0 ratification cluster (the PR cluster these specs are anchored in).
- cortex#248 — `review.verdict.*` envelope payload contract (the canonical contract this consumer emits).
- cortex#249 — `DispatchTaskFailedReason` four-way nak taxonomy extension (the structured naks this consumer emits).
- cortex#250 — `@the-metafactory/cortex/bus` barrel (the public exports map this consumer extends).
- `src/runner/dispatch-listener.ts` — the existing dispatch-listener pattern this consumer mirrors.
- `src/bus/bus-dispatch-listener.ts` — the existing in-flight-tracking + drain-on-stop pattern this consumer mirrors.
- `src/bus/dispatch-events.ts` — the lifecycle envelope helpers this consumer composes.
- `src/bus/myelin/subscriber.ts` — the subscriber primitive this consumer extends with pull-mode.
- `src/bus/envelope-builder.ts` — the shared envelope skeleton this consumer's verdict builder composes on.
- `src/bus/index.ts` — the public bus barrel this consumer extends with new exports.
- `~/.claude/skills/code-review/SKILL.md` — the existing lens pipeline this consumer reuses; PR-8 updates this with the structured-verdict contract.

---

*This document is the producer-side design specification for cortex#237. Implementation follows the PR cluster in §10. The wire contract with pilot is fixed by cortex#248 + cortex#249; this spec is the cortex-side realisation of that contract.*
