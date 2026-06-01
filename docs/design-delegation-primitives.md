# Design — Delegation primitives (orchestrator + sub-task dispatch)

**Status:** Draft
**Feature:** IAW E.3 — orchestrator + delegation primitives
**Refs:** cortex#350 (E.3), cortex#117 (Phase E umbrella), `docs/design-internet-of-agentic-work.md` §3.6
**Author track:** parallel to the CFG config-split build — this doc is design-only and touches nothing under `src/common/config/` or `src/runner/`.
**Vocabulary:** principal / stack / network / assistant / agent / sub-agent / capability / dispatch / harness, per `CONTEXT.md`

---

## §0 — TL;DR

cortex already has an **in-process** delegation primitive: the `agent-team` substrate harness (`src/runner/agent-team.ts`) — a moderator assistant decomposes a goal, `@`-mentions participants, collects their results, and synthesizes a final answer. Phase B.2b already extended one participant kind to be a **bus-peer** (a participant whose work is dispatched to a *remote* cortex over the bus via `BusPeerHarness`).

Phase E.3 needs to generalize that single building block into a first-class **delegation model**: an orchestrating assistant that decomposes a goal into sub-tasks, **dispatches each sub-task as its own bus envelope** (Direct/Delegate mode) to the best assistant for the job — *across stacks and across networks* — tracks them by `correlation_id`, and synthesizes the fan-in. The orchestrator owns the delegation-tree state (an errand-store, per the pilot loop's state-ownership pattern); the surface only renders.

**Recommended model:** keep `agent-team` as the *in-stack* delegation harness (Delegate mode → `agent-team` harness, unchanged). Add a thin **DelegationDispatcher + ReplyCorrelator + delegation-tree store** layer that turns each sub-task into a real bus dispatch (Direct to a named assistant, or Offer to a capability), reuses the `dispatch.task.*` lifecycle + `correlation_id` threading that already exists, and applies the **dispatch-not-dictate** boundary rule: the delegator picks *what* and *who*, never *how* — the delegatee's stack sovereignty governs method.

---

## §1 — What "delegation primitives" Phase E needs

The existing `agent-team` solves *one* shape of delegation: a single moderator process spawning child Claude-Code sessions (and, since B.2b, one bus-peer). That is **fan-out within one dispatch**. Phase E's §3.6 orchestrator pattern is a different, larger shape:

> "your main digital assistant that will then delegate around and coordinate on your behalf by leaning into these different networks and stacks depending on their capability."
> — `docs/design-internet-of-agentic-work.md` §3.6

Concretely, an orchestrator must:

1. **Decompose** a goal into N sub-tasks (each with its own capability requirement).
2. **Resolve a target** per sub-task — a named assistant (Direct) or a capability (Offer), possibly on a *different stack* or a *different network*.
3. **Dispatch each sub-task as its own bus envelope** — not as an in-process CC session. Each sub-task is independently routable, signable, policy-checked, and observable on the bus.
4. **Correlate replies** — thread each sub-task's `dispatch.task.{completed|failed|aborted}` back to its slot in the delegation tree via `correlation_id`.
5. **Synthesize** the fan-in into a single result, and emit the orchestrating dispatch's own terminal lifecycle envelope.
6. Do all of this **across stacks and across networks**, with bounded depth, idempotency, and partial-failure tolerance.

The gap vs `agent-team`: `agent-team` participants are process-local CC sessions (or a single bus-peer); their "dispatch" is a function call + an `EventEmitter`, not a bus envelope per sub-task. Phase E needs **every sub-task to be a bus dispatch in its own right** so it can cross the stack and network boundary, be policy-gated at the boundary, and be claimed by a sovereign peer.

---

## §2 — Build on what exists

### §2.1 The existing layers

| Layer | What it is | File | Reuse in E.3 |
|---|---|---|---|
| **Delegate dispatch mode** | Envelope `distribution_mode === 'delegate'`; subject identical to Direct (`tasks.@{assistant}.{capability}`); listener routes to `agent-team` harness | `CONTEXT.md` §Dispatch; `dispatch-listener.ts` | **Reused as-is.** Delegate stays the wire mode that selects the orchestration harness. |
| **`agent-team` substrate harness** | `AgentTeamHarness implements SessionHarness` — wraps moderator+participant orchestration behind the standard `SessionHarness.dispatch()` lifecycle | `agent-team.ts:193` | **Reused as the in-stack harness.** E.3 does not replace it; E.3 adds a sibling orchestration mode for *cross-bus* sub-tasks. |
| **`BusPeerHarness` participant kind** | A team participant with `kind: "bus-peer"` dispatches its prompt to a remote cortex; terminal envelope's `payload.result_summary` becomes the member result | `agent-team.ts:66`, `:748` (`spawnBusPeerParticipant`) | **Generalized.** B.2b proved one bus-peer participant; E.3 makes "every sub-task is a bus dispatch" the default for the orchestrator. |
| **`dispatch.task.*` lifecycle helpers** | `createDispatchTaskStarted/Completed/Failed/Aborted` — emit signed lifecycle envelopes joined by `correlation_id` | `src/bus/dispatch-events.ts` | **Reused unchanged.** Each sub-task's lifecycle rides these. |
| **`correlation_id` override** | `DispatchTaskCommonOpts.correlationId` — "when a task is part of a larger workflow whose correlation_id was assigned upstream" | `dispatch-events.ts:101-103` | **This is the load-bearing hook.** The orchestrator assigns each sub-task its own `task_id` *and* an explicit `correlation_id` linking it to the parent delegation. |
| **`response_routing`** | Inbound payload field echoed onto every lifecycle envelope so a dispatch sink finds its target without state | `CONTEXT.md` §Response routing | **Reused.** A sub-task's `response_routing` points back at the orchestrator's reply consumer, not at a human surface. |

### §2.2 Mapping agent-team → bus-native delegation

The `agent-team` moderator loop is the **conceptual template** for the orchestrator:

| `agent-team` (in-process) | Bus-native orchestrator (E.3) |
|---|---|
| `buildModeratorPrompt` → moderator decides `@mentions` (`agent-team.ts:455`) | Orchestrator assistant decides target *assistant/capability + network* per sub-task |
| `spawnParticipant` → local `CCSession` (`agent-team.ts:646`) | `DelegationDispatcher.dispatch()` → bus envelope (Direct/Offer) on `federated.` or `local.` |
| `spawnBusPeerParticipant` (`agent-team.ts:748`) | The **default** path, generalized to N sub-tasks + network selection |
| `pendingParticipants` Set + `EventEmitter` (`agent-team.ts:525`) | `ReplyCorrelator` in-memory map keyed by sub-task `id`, joined on `correlation_id` |
| `triggerSynthesis` → synthesis `CCSession` (`agent-team.ts:826`) | Orchestrator synthesis step (a CC turn) over the collected reply payloads |
| `AgentTeam.abort()` kills all sessions (`agent-team.ts:612`) | Abort propagates `dispatch.task.aborted` to every outstanding sub-task `correlation_id` |

**Reused vs new:**

- **Reused:** Delegate dispatch mode + `agent-team` harness for the *in-stack* fan-out; the entire `dispatch.task.*` lifecycle; `correlation_id` threading; `response_routing`; `BusPeerHarness` as the per-sub-task transport; chain-of-stamps `signed_by[]`.
- **New (the E.3 module, `src/agents/orchestrator/` per #350):**
  - `DelegationDispatcher` — turns one sub-task into a bus dispatch with target/network selection.
  - `ReplyCorrelator` — maps outbound sub-task id → reply, joined on `correlation_id`, with timeout + sibling-network retry.
  - **Delegation-tree store** — the errand-store that holds the sub-task tree (see §4).
  - `RegistryClient.findCapability()` — capability→network resolution (Phase D cache).
  - `OrchestratorAgent` persona + `cortex.yaml` `agents[].runtime.orchestrator` config.

> **Boundary note (parallel-track):** the `cortex.yaml` schema extension under `agents[].runtime.orchestrator` is owned by the CFG config-split track and #350's own implementation. This doc specifies the *shape and semantics* of that config but does not author the schema.

---

## §3 — Cross-network delegation

### §3.1 The wire path

A stack delegating a sub-task to a **peer principal's** assistant uses the `federated.` scope — never `local.`. Per `CONTEXT.md`, federation is the default for multi-principal collaboration; `local.` is one broadcast domain, `federated.` is cross-network routing.

```
Orchestrator (assistant: luna) on stack andreas/research
  decomposes goal → sub-task "security-review of PR #54"
  RegistryClient.findCapability("security-review.typescript")
    → match: network "code-rev", capability fulfilled by jc/secops
  DelegationDispatcher.dispatch():
    publish  federated.jc.secops.tasks.@echo.security-review.typescript
             distribution_mode: "direct"   (named assistant)   ── OR ──
             federated.code-rev.tasks.security-review.typescript
             Offer dispatch (any capable peer claims via the JetStream consumer group)
    envelope.correlation_id = <parent-delegation-id>
    envelope.response_routing = { reply_qg: "qg:andreas/research:replies:security-review" }
  ── peer's stack signs, runs, emits ──
    federated.jc.secops.dispatch.task.completed
             correlation_id = <parent-delegation-id>
             payload.result_summary = <the review>
  ReplyCorrelator matches correlation_id → resolves the sub-task slot
```

The sub-task's inbound scope and its lifecycle scope mirror each other (`CONTEXT.md`: "Lifecycle envelopes mirror the inbound scope"). Cross-principal sub-task ⇒ `federated.…dispatch.task.*`.

### §3.2 Trust + policy at the delegation boundary

Three independent attestations, all inside the signature (per `CONTEXT.md` + IoAW §4 cortex#102/#107):

1. **The delegator's stack signs** the outbound sub-task envelope with its stack NKey (`runtime.publish`). The `signed_by[]` chain-of-stamps grows by one stamp at each forwarding hop — a multi-level delegation tree produces a verifiable chain.
2. **The delegatee's PolicyEngine** (cortex#107) is the decision point on the *receiving* side. The delegator cannot pre-authorize itself; the peer's stack decides whether to accept, using `envelope.sovereignty` + its `policy.principals[]` registry. An unknown delegator is denied at the boundary, not at the orchestrator.
3. **`originator` vs signer separation** (C-405): the policy actor (originator identity) and the cryptographic signer (stack) are distinct — both attestable, both inside the signature.

### §3.3 Dispatch-not-dictate at the boundary

This is the load-bearing principle for cross-network delegation. Per `CONTEXT.md` and the project memory "dispatch, don't dictate":

> The center orchestrates by **capability/intent**; competence (the "how") lives at the specialized edge.

Operationally, the delegator's sub-task envelope MAY carry:

- **WHAT** — the capability + the goal/payload (the intent).
- **WHERE-TO-REPLY** — `response_routing` (the reply queue group) + `correlation_id`.
- **CONSTRAINTS THAT ARE CONTRACTS** — deadline (`timeout`), scope of data shared, expected result shape.

The delegator MUST NOT carry:

- **HOW** — tool lists, model choice, sub-agent decomposition, internal session config. Those are the delegatee's stack-local concern. A `federated.` sub-task that tries to set `tools.allow` for the *peer's* session is dictating method; the peer's harness ignores delegator-supplied execution config and applies its own (its sovereignty applies). Contrast in-stack `agent-team`, where the moderator legitimately sets participant `allowedTools`/`dirs` because they are the *same* stack's sessions.

This is why the bus-peer `DispatchRequest` built in `defaultBusPeerHandleFactory` (`agent-team.ts:372`) sends `tools: { allow: [], deny: [] }` — the peer fills in its own. E.3 formalizes this as a rule: **cross-stack/cross-network sub-tasks carry intent + constraints, never execution method.**

### §3.4 How the result returns

The peer emits `dispatch.task.completed` with `payload.result_summary` on the federated scope, `correlation_id` = the parent delegation id. The orchestrator's `ReplyCorrelator` subscribes to the reply queue group on the source link (per #350: `qg:{principal}/{stack}:replies:{capability}`), filters inbound by `correlation_id`, and resolves the matching sub-task slot. The `BusPeerHarness` drain loop (`agent-team.ts:405-441`) is the existing precedent for "pull lifecycle envelopes until terminal, extract `result_summary`, fire callback."

---

## §4 — Orchestration state

### §4.1 Who owns the delegation tree

**The orchestrating agent owns the delegation-tree state — the surface does not.** This mirrors the pilot loop's state-ownership pattern: pilot owns its `errands.sqlite` (`docs/design-pilot-restructure.md` §`db.ts`; `docs/design-collaboration-surface.md` G-1101 "Pilot already maintains its own state — we add a projection"). The surface (Mission Control / Discord) is a **dispatch sink** that *projects* state; it never holds the authoritative tree.

The orchestrator's store (the **delegation-tree / errand-store**, conceptually `~/.metafactory/agents/{assistant}/delegations.sqlite` or in-memory for v1 per #350's "in-memory map") holds, per active delegation:

```
delegation (root):
  id                 = parent dispatch correlation_id
  goal               = original prompt
  status             = pending | partial | synthesizing | done | failed | aborted
  depth              = current tree depth (bounded)
  sub_tasks[]:
    id               = sub-task task_id (own UUID)
    correlation_id   = parent delegation id  (the join key)
    capability       = e.g. security-review.typescript
    target           = { mode: direct|offer, assistant?, network, stack? }
    status           = dispatched | claimed | completed | failed | aborted | timed_out
    attempted_networks = Set<network>   (for sibling-network retry)
    result_summary?  = filled on terminal
```

### §4.2 Idempotency

- Each sub-task carries a stable `id` (UUID). Re-delivery of a lifecycle envelope for an already-terminal sub-task is a **no-op** (the correlator checks the slot status before resolving). This is the same `correlation_id`-keyed dedup the surface already relies on.
- A redelivered *inbound* sub-task on the peer side is the peer's idempotency concern (its own dispatch-listener), not the delegator's — dispatch-not-dictate.
- Synthesis is fired exactly once, when `pending` sub-tasks reach zero (the `agent-team.ts:708` `pendingParticipants.size === 0` precedent), guarded by the root `status` transition `partial → synthesizing` being a single-shot CAS.

### §4.3 Partial failure

Per the existing `agent-team` philosophy (`agent-team.ts:421` comment: "a missing payload is a peer-side bug … not a reason to fail the whole team"):

- A sub-task `failed` or `timed_out` does **not** abort siblings. Its slot records the error; synthesis still runs over the successful results plus failure markers.
- The orchestrator decides at synthesis whether the partial set is sufficient. If a *required* sub-task failed, the orchestrator MAY: (a) retry on a sibling network (§4.4), (b) emit the root `dispatch.task.failed` with a summary of which sub-tasks failed, or (c) synthesize a degraded result. This is application logic in the `OrchestratorAgent` persona, not harness logic.

### §4.4 Fan-in synthesis + sibling-network retry

- **Fan-in:** when all sub-tasks reach terminal, the orchestrator runs a synthesis turn (the `buildSynthesisPrompt` template, `agent-team.ts:482`, generalized to bus results) and emits the root `dispatch.task.completed`.
- **Sibling-network retry:** per #350, on a sub-task timeout the correlator tries the *next* network from the capability's preference list (`attempted_networks` guards against re-trying the same one). Exhaustion ⇒ `timeout_no_peer_claim` (no peer ever claimed) vs `timeout_after_claim` (a peer claimed but never finished) — the distinction is observable because `dispatch.task.started` arrives on claim.

### §4.5 Bounded depth

A delegatee may itself be an orchestrator → unbounded recursion risk. Bound it:

- The envelope carries a **delegation depth** counter (a payload field, incremented per hop). Each orchestrator checks depth against a configured `max_delegation_depth` (default small, e.g. 3) and **refuses to re-delegate** past the bound — it must do the work itself or fail. The chain-of-stamps `signed_by[].length` is a corroborating signal but depth is the explicit control (stamps grow for non-orchestration forwards too).
- Cycle detection: an orchestrator declines a sub-task whose `correlation_id` chain already contains its own stack (would be a delegation cycle). v1 may rely on depth-bounding alone and defer true cycle detection (open question Q3).

---

## §5 — Lifecycle + correlation

### §5.1 Correlation threading

The single most important mechanism. From `dispatch-events.ts:101-103`:

> "Optional explicit `correlationId` to override (e.g., when a task is part of a larger workflow whose correlation_id was assigned upstream)."

The orchestrator uses this exactly as designed:

```
root dispatch:            task_id = R,  correlation_id = R   (default)
  sub-task A:             task_id = A,  correlation_id = R   (explicit override)
  sub-task B:             task_id = B,  correlation_id = R   (explicit override)
    (B is itself orchestrated)
      sub-task B1:        task_id = B1, correlation_id = B   (override = B's task_id)
```

Two valid threading models — **decide in Q1**:

- **(a) Flat — all sub-tasks share the root `correlation_id` R.** Simplest; one query (`correlation_id = R`) returns the whole flat history. Loses the tree shape (can't tell A's children from B's children without the depth/parent field).
- **(b) Parent-chained — each sub-task's `correlation_id` = its parent's `task_id`.** Preserves the tree; reconstruct the tree by walking `correlation_id` → `task_id` edges. The orchestrator's own store holds the authoritative parent pointers regardless; the wire `correlation_id` is for sink-side correlation.

**Recommendation: (b) parent-chained on the wire, with the orchestrator's store holding the full tree.** The correlator joins on the *immediate* parent; the surface can still group by walking the chain. This matches `ReplyCorrelator`'s per-dispatch reply filter (it only ever cares about *its own* outbound sub-tasks' replies).

### §5.2 `dispatch.task.*` aggregation

- Each sub-task emits its own `started/completed/failed/aborted` on its scope. The orchestrator consumes these as a dispatch sink for its sub-tasks (reply queue group), and as a *source* re-emits the **root** dispatch's lifecycle for the original caller (the human surface or the parent orchestrator).
- The root `dispatch.task.started` fires when decomposition begins; root `completed`/`failed` fires after synthesis.

### §5.3 Timeout / abort propagation

- **Timeout:** per-sub-task soft timeout (the `BusPeerHandle` timeout precedent, `agent-team.ts:389`) + per-dispatch principal-settable timeout (#350). Timeout triggers sibling retry or terminal-fail (§4.4).
- **Abort:** aborting the root delegation MUST propagate. The orchestrator emits `dispatch.task.aborted` (with the root `correlation_id`) for every still-outstanding sub-task and breaks each reply iterator (the `abort()` → `iterator.return()` cleanup pattern, `agent-team.ts:444`). Cross-network: the abort envelope is published on the sub-task's federated scope; the peer's listener is expected to honor it, but **cannot be forced to** (dispatch-not-dictate — the peer's stack decides; the delegator only stops waiting and stops counting the result). This is an honest limitation, not a bug.

---

## §6 — Relationship to the pilot review-loop

The pilot loop is **already a 2-party delegation**: dev assistant → reviewer assistant. It is the existing, in-production instance of the general pattern this doc abstracts:

| Pilot loop concept | Generalized delegation primitive |
|---|---|
| dev requests review (Offer to `code-review.typescript`) | a sub-task dispatch (Offer mode) |
| pilot's `errands.sqlite` owns review state | the orchestrator's delegation-tree store owns sub-task state |
| reviewer's verdict envelope returns | sub-task `dispatch.task.completed` with `result_summary` |
| event-driven reactor (no blocking wait; reacts to bus events) | `ReplyCorrelator` reacting to inbound lifecycle envelopes |
| surface renders errand cards, doesn't own state | dispatch sink projects the tree, doesn't own it |

The generalization: pilot is a **fixed 2-node, 1-capability** delegation. The orchestrator is **N-node, M-capability, multi-network**. The pilot loop should eventually be expressible *as* an orchestrator with a single sub-task — but v1 keeps pilot's bespoke loop and treats it as the proof-of-pattern, not a thing to refactor (consistent with the project memory "event-driven orchestration below the surface": the loop reacts to bus events, no blocking wait; cortex M7 only notifies).

**Key inherited rule:** the verdict/result block is load-bearing and deterministic — rendered in code, not LLM tokens (project memory "deterministic surface formatting"). The orchestrator's *synthesis* is LLM-authored (it's reasoning over results), but the *lifecycle envelopes* and the *delegation-tree projection* are deterministic structure read off the bus.

---

## §7 — Open questions (for the principal)

- **Q1 — Correlation threading model.** Flat (all sub-tasks share root `correlation_id`) vs parent-chained (each sub-task `correlation_id` = parent `task_id`)? §5.1 recommends parent-chained. *Decision affects every lifecycle query and the surface projection.*
- **Q2 — Sub-task target mode default.** When a capability has multiple capable peers, does the orchestrator prefer **Offer** (let any capable peer claim — load-balances, but less predictable) or **Direct** to a preferred assistant (predictable, but no failover without the retry list)? #350 leans on a preference list + first-match; confirm Offer-vs-Direct as the *default*.
- **Q3 — Max delegation depth + cycle policy.** Default `max_delegation_depth`? Is depth-bounding alone sufficient for v1, or is explicit cycle detection (stack-in-chain) required before any cross-network delegation ships? §4.5.
- **Q4 — Abort honesty across networks.** Confirm the design stance: a cross-network abort is **best-effort** — the delegator stops waiting/counting; the peer's stack decides whether to actually stop. Acceptable for v1? (Alternative: require peers to ack aborts as a federation contract — heavier.)
- **Q5 — Where the delegation-tree store lives.** In-memory only for v1 (per #350 "in-memory map"), or persisted (`delegations.sqlite`) so an orchestrator restart can resume in-flight trees? In-memory means a crash orphans outstanding sub-tasks (their replies hit a dead correlator). §4.1.
- **Q6 — Does pilot become an orchestrator?** Refactor the pilot loop onto the general primitive (one elegant model) or keep it bespoke (proven, don't-touch)? §6 recommends keep-bespoke for v1.
- **Q7 — Constraints-as-contracts vocabulary.** Which fields are legitimate cross-network constraints (deadline, data-scope, result-shape) vs forbidden method-dictation (tools, model, sub-agents)? §3.3 proposes a split; the principal should ratify the exact allowlist before it becomes a policy rule.

---

## §8 — Phased rollout

Aligned to the IoAW phase ladder (`docs/plan-internet-of-agentic-work.md` §6) and #350's acceptance criteria.

| Stage | Scope | Builds on | Exit signal |
|---|---|---|---|
| **E.3-a — In-stack delegation (formalize)** | Confirm `agent-team` Delegate-mode harness is the in-stack primitive; document the moderator→participant model as the conceptual template. No new bus traffic. | `agent-team.ts` as-is | Delegate dispatch routes to `agent-team`; in-stack fan-out + synthesis works (already true). |
| **E.3-b — Cross-stack delegation** | `DelegationDispatcher` + `ReplyCorrelator` + delegation-tree store; sub-tasks become real bus dispatches (Direct/Offer) to *same-principal, other-stack* assistants on `local.`. Single network. | B.2b `BusPeerHarness`; `dispatch.task.*`; `correlation_id` override | In-process integration test: mocked runtime, orchestrator dispatches 2 sub-tasks, correlator resolves, synthesis threads back (#350 integration test). |
| **E.3-c — Cross-network delegation** | `federated.` scope; `RegistryClient.findCapability()` network resolution; sibling-network retry; boundary policy (PolicyEngine on receiver); dispatch-not-dictate constraint rule. | Phase D federation + cortex#107 PolicyEngine + #348 multi-link runtime | Two-network rig: orchestrator on network A delegates a sub-task to a peer on network B; reply threads back; an unauthorized delegator is denied at the boundary. |

**Dependency note:** E.3-c is gated on Phase D (federation) and #348 (E.1 multi-link runtime) being complete — the orchestrator cannot publish on a second `federated.` link until the runtime manages multiple `NatsLink`s. E.3-a and E.3-b are unblocked today.

---

## §9 — References

**Source (read, not modified):**
- `src/runner/agent-team.ts` — `AgentTeamHarness` (`:193`), `AgentTeam` moderator loop (`:519`), `spawnBusPeerParticipant` (`:748`), `defaultBusPeerHandleFactory` (`:362`).
- `src/bus/dispatch-events.ts` — lifecycle helpers + `correlationId` override (`:101-103`).
- `src/runner/dispatch-listener.ts` — canonical `tasks.*.>` subscription + Delegate-mode routing.

**Design + plan:**
- `CONTEXT.md` — Dispatch (Offer/Direct/Delegate), substrate harness, response routing, scopes, vocabulary.
- `docs/design-internet-of-agentic-work.md` §3.6 (orchestrator pattern), §4 (cortex#91/#102/#107 assembly), Phase E (§770).
- `docs/plan-internet-of-agentic-work.md` §6 (Phase E work items E.1–E.5).
- `docs/design-pilot-restructure.md` + `docs/design-collaboration-surface.md` (G-1101) — pilot errand-store state-ownership pattern.

**Issues:** cortex#350 (E.3), cortex#117 (Phase E umbrella), cortex#110 (IAW META).
