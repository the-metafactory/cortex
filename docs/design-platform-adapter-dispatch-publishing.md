# Platform Adapter Dispatch Publishing — Design Spec

**Status:** Direction A locked. Skeleton surfaced from `/improve-codebase-architecture` grilling on the dispatch-handler / dispatch-listener seam (2026-05-22). Q1, Q2, signing model, and all four §10 questions corrected via [`docs/design-myelin-osi-scenarios.md`](./design-myelin-osi-scenarios.md) §11 (Andreas, 2026-05-23). See §11 of that doc for the locked answers; this doc has been edited inline to reflect them.
**Date:** 2026-05-22 (original); 2026-05-23 (OSI corrections + Scenario 4)
**Driver:** Jens-Christian (original); Andreas (OSI corrections)
**Scope:** Cortex `src/adapters/*`, `src/bus/dispatch-handler.ts`, `src/runner/dispatch-listener.ts`, `src/substrates/*`, `src/renderers/*`. Touches MIG-7.2 (agent identity model) as pre-requisite.
**Related:**
- `CONTEXT.md` — dispatch source / dispatch sink / substrate harness / response routing
- `src/common/substrates/types.ts` — `SessionHarness` interface (already in place)
- `docs/architecture.md` — M1–M7 stack model
- `docs/plan-cortex-migration.md` — migration phase plan
- `docs/design-internet-of-agentic-work.md` + `docs/plan-internet-of-agentic-work.md` — **federation baseline** (cortex#110 META; cortex#117 Phase E). Direction A's `federated.` publishing depends on the IoAW peer-registry + leaf-node primitives; channel-topology config (Stage 4 model B) is the cortex-side UX that decides when an adapter publishes federated vs local.

---

## 1. Why this exists

Today two parallel code paths drive Claude Code dispatches:

- `src/bus/dispatch-handler.ts` (F-007, pre-substrate-seam) — platform-message in, CC orchestration inline, platform-response out. Used by Discord / Mattermost / Slack adapters.
- `src/runner/dispatch-listener.ts` (MIG-4.5 / cortex#113 Phase A.1b) — bus-envelope in, substrate harness drives, lifecycle envelopes out.

Same word ("dispatch") in both files, different roles, different generation. The listener already lives behind the substrate-harness seam (`SessionHarness`). The handler does not — it still spawns `CCSession` directly and owns `AgentTeam` / `SessionManager` / `TaskTracker` / heartbeat inline.

This spec proposes **Direction A**: platform adapters become **dispatch sources** that publish inbound dispatch envelopes onto the bus. The existing `dispatch-listener` consumes all dispatches regardless of origin. `dispatch-handler.ts` retires.

**Framing note (per OSI §4.2):** "platform adapter" is one class of dispatch source — the one this spec is named after — but it is not the only one. Five source classes coexist on the bus: (1) platform adapters (human→bot, Discord/Mattermost/Slack/etc.), (2) other assistants' runtimes (bot→bot autonomous; OSI Scenario 5 is the canonical case), (3) other assistants via delegation chain (bot→bot re-issued), (4) MC dashboard "send task" actions, (5) taps/webhooks (e.g. `gh-webhook`). The bus is the medium; surfaces are pluggable sources and/or sinks. Direction A retires the adapter-specific legacy in-process path (`dispatch-handler.ts`) and makes the bus-native path canonical for ALL source classes — including the ones that don't involve a platform surface at all.

---

## 2. Direction A in one diagram

```
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Dispatch source (any of):                                                │
   │   • Platform adapter — Discord / Mattermost / Slack message (human→bot)  │
   │   • Another assistant's runtime — bot→bot direct (OSI Scenario 5)        │
   │   • Delegation re-issue — bot→bot with preserved originator              │
   │   • MC dashboard "send task" action                                      │
   │   • Tap / webhook (e.g. gh-webhook for GitHub events)                    │
   └────────────────────────────────┬────────────────────────────────────────┘
                                    │ stack signs;
                                    │ source populates originator (or omits)
                                    ▼
       local.{principal}.{stack}.tasks.@{did-encoded-assistant}.{capability}
            (or federated.{principal}.{stack}.tasks.@…
             for cross-principal — see OSI Scenarios 3, 4, 5)
                                    │
                                    ▼
              ┌─────────────────────┐
              │ dispatch-listener   │  ◄── existing
              │ (policy + trust)    │
              └──────────┬──────────┘
                         │ harness.dispatch(req)
                         ▼
              ┌─────────────────────┐
              │ Substrate harness   │  ◄── CC / agent-team / bus-peer / …
              └──────────┬──────────┘
                         │ yields lifecycle envelopes
                         ▼
       local.{principal}.{stack}.dispatch.task.{started|completed|failed|aborted}
                                    │
                                    │ NATS pub/sub fan-out — N subscribers
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Dispatch sinks (any subset of):                                          │
   │   • Originating platform adapter — filtered by response_routing.adapter  │
   │     _instance + correlation_id → renders reply to originating channel    │
   │   • Originating runtime — for bot-originated chats, consumes reply by    │
   │     correlation_id to continue its session                               │
   │   • MC dashboard — observer; always renders                              │
   │   • Logging tap, audit tap, PagerDuty (on failed) — observers            │
   │   • Cross-principal mirror — federation bridge fans envelopes out        │
   └─────────────────────────────────────────────────────────────────────────┘
```

**Routed sinks** filter by `response_routing` (only react when targeted); **observer sinks** subscribe broadly (always render). The same envelope can have N of each. See OSI §14 for the multi-subscriber model. A platform adapter typically plays both source (inbound) and routed-sink (outbound) roles; bus-native bot sources subscribe to lifecycle envelopes by `correlation_id` rather than `response_routing`.

---

## 3. The pre/middle/post split

### 3.1 Pre-envelope (adapter, dispatch-source side)

Adapter receives raw platform message and produces a signed envelope. Steps that move out of `dispatch-handler.ts` and into the adapter:

1. Coarse access check (Q5c — adapter still owns "may this user speak at all")
2. Keyword parsing → dispatch mode (`async:` / `team:` / none)
3. Channel-context resolution (repo, entity, network)
4. Conversation history fetch
5. Attachment download (Q4a — adapter has auth context; payload carries base64)
6. Build a canonical Direct/Delegate task envelope with `target_assistant`, `originator.identity`, and a dispatch payload
7. Publish on `local.{principal}.{stack}.tasks.@{did-encoded-assistant}.{capability}`; the stack/runtime owns signing and the listener emits `dispatch.task.*` lifecycle events after acceptance

### 3.2 Bus middle (dispatch-listener)

No change from today's flow:

1. signed_by chain verify
2. Policy gate (Q5c — listener owns fine-grained authorization)
3. Intent resolution
4. Harness selection (claude-code / agent-team / …)
5. `for await (env of harness.dispatch(req))` → `runtime.publish(env)`

### 3.3 Post-envelope (adapter, dispatch-sink side)

Adapter registers a SurfaceAdapter on `dispatch.task.{started|completed|failed|aborted}` filtered by `response_routing.adapter_instance` + `correlation_id`:

1. `started` → `sendProgress(target, "thinking…")`
2. progress events → edit progress message
3. `completed` → `postResponse(target, text, files)`
4. `failed` / `aborted` → post error message
5. `clearProgress` after terminal

---

## 4. Pinned design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **Q1 (corrected)** | **Stack signs the envelope via `runtime.publish` (using stack NKey). Adapter populates `originator.identity` with the resolved human/agent DID and `originator.attribution = "adapter-resolved"`.** | Per myelin#160 (CLOSED) and OSI Scenario 1. Cryptographic signer (stack) and policy actor (originator) are cleanly separated — both attestable, both inside the signature. Supersedes the original Q1a "adapter signs as hosted agent" decision. |
| **Q2 (corrected)** | **Myelin owns the subject grammar at every layer M1–M6, including the Tasks-domain subgrammar (`tasks.@{assistant}.{capability}` for Direct/Delegate; `tasks.{capability}.{subcapability}` for Offer). Cortex owns the VALUES it populates (capability tokens, dispatch mode choice per workload, persona) and the SEMANTICS of cortex-specific application events (`dispatch.task.{action}` lifecycle envelopes).** | Per `myelin/specs/namespace.md` §Tasks Domain. cortex's prior `dispatch.task.received` inbound subject was pre-spec; canonical is `tasks.@{did-encoded-assistant}.{capability}`. Supersedes the original Q2 "cortex owns M7 dispatch subject grammar" decision. |
| Q3a | Stateless response routing on the wire | Inbound envelope payload carries `response_routing`. Listener echoes onto all lifecycle envelopes. Dispatch sink reads routing → posts. No in-memory `correlation_id → ResponseTarget` map. |
| Q4a | Inline base64 attachments in envelope payload | Federation-friendly (info flows back across stacks). Accepted cost: envelope bloat. Q4b (federated CAS) deferred. |
| Q5c | Two-pass access: adapter coarse + listener fine-grained | Adapter retains "may this principal speak at all" guard. Listener's policy-engine owns "what tools may this dispatch use". Q5b (policy-engine sole authority) is the long-term destination — filed as follow-up. |
| Q6c | AgentTeam-as-harness (`HarnessId = "agent-team"`) | Delegate dispatch mode maps onto a meta-harness that composes single-agent harnesses. Listener stays substrate-agnostic. Mode routing reads `envelope.distribution_mode === 'delegate'` (top-level field, already in myelin shipped enum) — see OSI §11 Q4. |
| Q7a + Q7c | Phased: Discord first, then source parity | Build a reusable dispatch-source publisher; Discord/chat adopts the canonical path first; mattermost + slack follow once the shared helper is stable. |
| **Federation default (new — OSI Scenario 4)** | **Stage 4 ships with model A default (Discord-as-bridge for cross-principal channels); per-channel opt-in to model B (federation-by-default) for principal pairs whose NATS leaf nodes are federated.** | Per OSI Scenario 4 §8.3 / §8.5. `local.` is per-deployment; cross-principal traffic MUST use `federated.` to route. Channel-topology config in adapter resolves which channels publish federated. Filed as separate cortex issue (precondition for full Stage 4 rollout). |

---

## 5. Subject grammar

Per myelin canonical grammar (`myelin/specs/namespace.md` §Tasks Domain) and `CONTEXT.md`:

| Mode | Inbound subject | Lifecycle subject |
|------|-----------------|--------------------|
| Direct (intra-principal) | `local.{principal}.{stack}.tasks.@{did-encoded-assistant}.{capability}` | `local.{principal}.{stack}.dispatch.task.{started\|completed\|failed\|aborted}` |
| Direct (cross-principal — OSI Scenario 4 model B) | `federated.{principal}.{stack}.tasks.@{did-encoded-assistant}.{capability}` | `federated.{principal}.{stack}.dispatch.task.{started\|completed\|failed\|aborted}` |
| Delegate | Same subject as Direct (`tasks.@{did-encoded-assistant}.{capability}`); mode bit lives in top-level `envelope.distribution_mode === 'delegate'` field — myelin spec doesn't separate Direct/Delegate at the wire | same |
| Offer | `local.{principal}.{stack}.tasks.{capability}.{subcapability}` (no `@{assistant}` segment; JetStream consumer group claims exactly-once) | same |

Lifecycle envelopes joined to inbound by `correlation_id`. **Free-form Discord/Mattermost/Slack `@assistant <message>` interactions publish with `capability = chat` — a first-class capability in myelin's seed taxonomy as of the C-405 corrections (see myelin issue for the taxonomy extension).**

**Legacy:** the old `dispatch.task.received` subscription in `src/runner/dispatch-listener.ts` is pre-spec. Stage 4-B makes the listener default canonical (`tasks.*.>`; whole-token wildcard matching the `@{did}` assistant token). Explicit legacy subject overrides may exist in tests/principal config until #412 deletes `dispatch-handler.ts` and updates the remaining integration surfaces.

`response_routing` field on the inbound envelope payload — shape TBD; sketch:

```ts
type ResponseRouting = {
  surface: "discord" | "mattermost" | "slack" | "mc" | "pagerduty";
  adapter_instance: string;        // matches PlatformAdapter.instanceId
  channel_id: string;              // platform-native
  thread_id?: string;              // platform-native; optional
  message_id?: string;             // platform-native; for reply correlation
  _native?: unknown;               // escape hatch
};
```

Listener echoes this onto every `dispatch.task.{action}` lifecycle envelope.

---

## 6. signed_by chain examples

### 6.1 Discord-originated Direct dispatch (corrected per OSI Scenario 1)

Adapter sees `@luna hello` from Discord user resolved as `did:mf:jc`. Stack-signing model:

```
subject: local.andreas.meta-factory.tasks.@did-mf-luna.chat
envelope:
  type: tasks.chat
  target_principal: did:mf:luna       # myelin spec calls this target_principal; cortex CONTEXT.md routes-to-an-assistant
  distribution_mode: direct           # top-level enum; bridges to cortex "Direct" mode
  originator:
    principal: did:mf:jc              # resolved by adapter from Discord user id
    attribution: adapter-resolved
  signed_by:
    - principal: did:mf:andreas-stack # stack key signs; covers originator
      method: ed25519
      signature: "…"
      at: "2026-05-23T…"
```

Listener verifies the chain against `TrustResolver`. `getActorPrincipal(envelope)` returns `originator.principal` (`did:mf:jc`) for policy attribution. The adapter does NOT hold an agent NKey — it only resolves the Discord user to a DID and fills `originator`.

### 6.2 Cross-principal Direct (OSI Scenarios 3 & 4)

Same envelope shape, with `classification: federated` and the `federated.…` subject prefix. Stack on the sending principal signs; chain verify on the receiving principal runs against trust roots that span the network. The originator is preserved end-to-end; intermediaries that need to override attribution MUST re-sign (cannot mutate `originator` silently — myelin spec §Originator).

### 6.3 Delegate dispatch (AgentTeam harness)

Inbound subject identical to Direct (`tasks.@{did-encoded-assistant}.{capability}`); the mode bit lives in `envelope.distribution_mode === 'delegate'` (top-level field, myelin spec). Listener routes to `agent-team` harness via the `distribution_mode` field after the subject + assistant-DID filter matches. Sub-dispatches the team initiates re-sign with the team-harness's stack key as their first signer.

---

## 7. Migration sequence

| Stage | Work | Pre-requisite |
|-------|------|----------------|
| 0 | This design doc + OSI corrections doc; ADR equivalent recorded | — |
| 1 | Finish MIG-7.2 — adapter holds an `agent` not legacy `AgentConfig.agent.discord[]` | — |
| 2 | **Implement against existing myelin spec (no negotiation needed).** Wire up `encodeDidSegment` helper from `@the-metafactory/myelin/subjects`; confirm `verifySignedByChain` reads `originator.principal` via `getActorPrincipal` for policy attribution. Land myelin taxonomy extension adding `chat` as a first-class capability. | Stage 1 |
| 3 | Build `EnvelopePublishingAdapterBase` — shared dispatch-source helpers. Subject derivation uses `tasks.@{did-encoded-assistant}.{capability}`. Adapter populates `originator.identity` from `resolveAccess` output + sets `attribution = "adapter-resolved"`. Hand to `runtime.publish` for stack-signing. Add `AgentTeamHarness` (Q6c). Listener selects on `envelope.distribution_mode === 'delegate'` for AgentTeam routing. | Stages 1–2 |
| 4 | Dispatch sources publish canonical envelopes by default. Discord/chat publishes onto `tasks.@{did-encoded-assistant}.chat` via the shared dispatch-source publisher; the listener default is `tasks.*.>` because router wildcards match whole tokens (`*` matches the full `@{did}` segment). **Defaults to model A (Discord-as-bridge for cross-principal channels)**; per-channel opt-in for model B (federation-by-default) once peer-principal NATS federation + trust roots are configured for that pair. **Stage 4-B lands the default chat path and retires the feature flag. Async/direct + team/delegate remain outstanding.** | Stage 3 + cortex federation-as-default issue |
| 5 | Discord adapter dispatch-sink — subscribe to `dispatch.task.{started\|completed\|failed\|aborted}` filtered by `response_routing.adapter_instance` + `correlation_id`; render via existing `postResponse` / `sendProgress`. Verify parity with handler path. | Stage 4 |
| 6 | Mattermost + Slack flip. (The `CORTEX_ADAPTER_ENVELOPE_MODE` flag was already retired at Stage 4-B — per the "don't optimise for long backwards compatibility; adapter envelope mode is a migration phase" direction — so Stage 6 is a straight source-side port of the Stage 4 pattern, not a flag flip. Legacy `dispatch.task.received` remains available via explicit `subjects` config until the Stage 7 cutover.) | Stage 5 |
| 7 | **Cutover.** Delete `src/bus/dispatch-handler.ts`. Remove legacy `dispatch.task.received` subscription from `dispatch-listener.ts`. **Update IAW Phase D integration test (`src/__tests__/iaw-phase-d-integration.test.ts`) + `src/__tests__/cortex.test.ts`** to use canonical `tasks.@{did}.{capability}` subjects. Rename `dispatch-listener.ts` if a better name surfaces (likely `dispatch-runtime.ts`). Update `docs/architecture.md`. | Stage 6 |

---

## 8. Open seams

- **Channel-topology config for OSI Scenario 4 (model B).** Adapter needs to know which Discord/Mattermost/Slack channels span principals. Two viable shapes: (i) explicit `cortex.yaml` per-channel config; (ii) Discord guild/role lookup that resolves to a peer-principal mapping. Filed as a separate cortex issue ("Federation as default for multi-principal collaboration"); pre-condition for full Stage 4 rollout.
- **NATS leaf-node federation between principal pairs.** Pre-condition for Scenario 4 model B; out of cortex's scope, covered by network operations work.
- **myelin `DistributionMode` rename (`'broadcast'` → `'offer'`).** cortex CONTEXT.md (Flagged Ambiguities) canonicalised the Offer mode and rejects `broadcast`. myelin's shipped enum still uses `'broadcast'`. Filed as a separate myelin issue; cortex wraps the legacy spelling at the boundary in the meantime.
- **Q5b — policy-engine sole access authority.** Adapter retains coarse-access today (Q5c). Long-term: adapter holds only identity; listener's policy-engine computes everything. Filed as separate issue.
- **Q4b — federated CAS for attachments.** Inline base64 works v1; will blow up envelope size for video / large dumps. Replace with hash-addressed blob store keyed by `correlation_id`. Filed as separate issue.
- **Where AgentTeam lives during migration.** Today inside `dispatch-handler.ts` as a direct import. Stage 3 lifts it into a harness. The pre-harness path (handler's `team:` keyword) must be cut over with the rest in Stages 4–6.

**Resolved by the OSI corrections batch (formerly listed here):**
- ~~Delegate inbound subject grammar undefined~~ → OSI §11 Q4: `envelope.distribution_mode === 'delegate'` (top-level field); subject shape identical to Direct.
- ~~Adapter-originated Direct to `tasks.@{assistant}.chat` is a future seam~~ → Direction A Stage 4 IS the landing; `chat` capability added to myelin seed taxonomy via cortex.

---

## 9. Vocabulary additions to CONTEXT.md (already landed)

This grilling added four terms to `CONTEXT.md`:

- **Substrate harness** — M6 runtime executing one dispatch on one substrate
- **Dispatch source** — anything signing + publishing inbound dispatch envelopes
- **Dispatch sink** — anything consuming lifecycle envelopes and rendering to a surface
- **Response routing** — payload field with originating surface address; echoed on lifecycle envelopes

Plus reconciliation: `tasks` and `dispatch` are distinct, coexisting domains. Not a rename in flight.

---

## 10. Out of scope

- Any change to `myelin/` envelope schema (the `originator` field is already shipped via myelin#160)
- Mission Control dashboard changes (dashboard remains a dispatch sink; only the consumer side may need a render-completion subscriber update)
- Renaming `src/renderers/` to `src/dispatch-sinks/` (code-name is `Renderer`; design term is `dispatch sink` — both stay)
- Channel-topology mechanism design (Scenario 4 model B) — handled in the federation-as-default cortex issue, not this spec
