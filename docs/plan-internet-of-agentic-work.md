# Plan — Internet of Agentic Work implementation

**Status:** Working document. Single source of truth for the cortex#110 (META) work — the implementation of the Internet of Agentic Work composition model. Every PR cites a phase + checklist item from this doc. **For "what we're building and why" (architecture, OSI layering, composition model, operator vision), see the static design doc `docs/design-internet-of-agentic-work.md`.** This plan covers only the implementation sequencing: what ships in what phase, in what order, with what entry/exit criteria. When this doc and reality disagree, this doc wins (or is updated, never silently). When this doc and the design doc disagree on architecture, the design doc wins.
**Date opened:** 2026-05-13
**Driver:** Andreas
**Retires when:** Phase E closes (multi-network bridges + delegation patterns operable in production).

**Related docs (load-bearing):**
- **`docs/design-internet-of-agentic-work.md`** — the static architecture spec. What IAW IS. Reference this for any "how should this be structured" question; only reference *this* doc for implementation mechanics.
- `docs/plan-cortex-migration.md` — the cortex spawn / migration plan from grove-v2. MIG-7 cutover is the moment cortex.yaml's schema flips for the first time; this plan's Phase C is the second (and last) schema flip.
- `cortex#110` (META) — the operator-vision umbrella ("Internet of Agentic Work").
- `cortex#112` (this PR) — the synthesis design doc.
- `cortex#91` — substrate harness (M6). Pre-existing sibling issue; consumed by Phase A.
- `cortex#102` — bot↔bot via bus envelopes / NKey identity (L3/L4). Pre-existing sibling issue; Phase B.
- `cortex#107` — principal-based AAA at dispatch-handler (M6). Pre-existing sibling issue; Phase C — includes Step H multi-operator cloud dashboard, consumed in Phase D.
- `cortex#109` — envelope-visibility composition + subject-namespace routing (L3/L4). Pre-existing sibling issue; consumed in Phases A and D.
- `~/Developer/myelin/specs/namespace.md` — myelin canonical namespace; Phase A extends to add a `{stack}` segment per Q7 lock-in.
- `~/Developer/myelin/docs/envelope.md` — chain-of-stamps + sovereignty fields. Phase A consumes the post-`96b14ea` envelope; Phase B consumes `signed_by[]`.
- `cortex/docs/architecture.md` §9 — agent + presence/renderer model (post-MIG-7 cortex.yaml shape; this plan extends it).
- `~/Developer/compass/sops/dev-pipeline.md` + `worktree-discipline.md` + `pr-review.md` — standard dev SOPs.

---

## 1. Overview

The Internet of Agentic Work is the composition model where stacks (`{operator_id}/{stack_id}`) join networks via NATS leaf-node federation; networks compose into the operator's federated graph; agents delegate across stacks and networks via the orchestrator pattern. Five phases sequenced A→E deliver this incrementally.

### 1.1 Phase ladder

| Phase | Scope | Effort | Sibling issues consumed | Schema flip? |
|---|---|---|---|---|
| **A** Foundation | Substrate harness + visibility consumption (4 emit sites parameterised + envelope upgrade + stack: block) | 2–3 weeks | cortex#91 + cortex#109 (§A+B+C) | No (stack: is additive with default) |
| **B** Identity | NKey-signed envelopes for bot↔bot (chain-of-stamps consumption) | 1–2 weeks | cortex#102 | No |
| **C** Policy + schema flip | PolicyEngine at M6 + cortex.yaml flips ONCE (stack block, principal table, role table) | 2–3 weeks | cortex#107 | **Yes — the only one** |
| **D** Federation | Peer registry + accept rules + network membership declaration + cloud-side network registry service | 3–4 weeks | cortex#107 (Step H) + cortex#109 (§E) | No (additive) |
| **E** Multi-network bridges + delegation | A stack participating in N networks; cross-network delegation patterns | 4–6 weeks | new sibling issue (Phase E sub-issue, this plan) | No (additive) |

Total: 12–18 weeks if strictly sequenced. Phases A and B are sequenceable; Phase C is the schema flip; Phase D depends on C; Phase E depends on D.

### 1.2 Locked-in design decisions (verbatim from §5 of the design doc, Andreas 2026-05-13)

- **Q1 — Stack identity:** `{operator_id}/{stack_id}` slash-separated. NATS form `local.{operator}.{stack}.>` / `federated.{operator}.{stack}.>`. Cryptographic chain operator-account-NKey → stack-NKey → agent-NKeys. Operator-id is the network authority root.
- **Q2 — Capabilities:** Two-part — network capabilities aggregated across all member stacks + operator-declared stack-level capabilities in cortex.yaml using a constrained schema (id, description, tags, provided_by, optional rate/cost).
- **Q3 — Network registry:** Centralised; cortex.yaml + cloud-side network registry service alongside cortex#107 Step H dashboard. NOT NATS-gossiped.
- **Q4 — Bridge-stack scoping:** Separate networks, not per-peer scoping. Bridge stack = multiple network memberships.
- **Q5 — Competing-consumers:** NATS queue groups (claim-first-wins at bus layer); no reservation; no auction.
- **Q6 — Cross-network audit:** Chain-of-stamps `signed_by[]` IS the audit trail. Stack-level identity per stamp.
- **Q7 — Stack as protocol primitive:** YES. Namespace grows a stack segment. cortex.yaml gets a `stack:` block. Cortex daemon hosts a stack.

### 1.3 Non-goals of this implementation plan

- **Not a re-architecture.** Every Phase reuses existing M2–M6 cortex code (substrate harness, surface-router, trust resolver). New code is targeted.
- **Not the operator-vision video script.** The video (cortex#110 body) is the "why"; this plan is the "how".
- **Not myelin changes.** Phase A.5 (stack namespace extension) is filed AS a myelin issue but lands separately; cortex's vendored envelope rides along.
- **Not the cloud dashboard refactor.** cortex#107 Step H is consumed in Phase D; this plan doesn't re-design it.
- **Not the public mesh / capability marketplace.** Out of scope across all five phases; future evolution after Phase E if demand surfaces.

---

## 2. Phase A — Foundation (substrate harness + visibility consumption + stack identity)

**Goal:** Cortex no longer hardcodes `classification: "local"`; emits sovereignty-typed envelopes; supports the substrate harness contract (`SessionHarness`); declares a stack identity via cortex.yaml's new `stack:` block. Phase A's deliverable is the foundation every later phase builds on.

**Issue:** `cortex#? — IAW Phase A: Foundation` (filed as part of this plan, see §7).

**Estimated effort:** 2–3 weeks (parallel sub-phases).

**Entry criteria:**

- Q7 lock-in confirmed (stack-aware namespace) — DONE 2026-05-13.
- Myelin namespace extension issue filed (Phase A.5).
- cortex#92 (substrate harness design PR) merged or its Q5/Q6/Q7 resolved.

### A.1 Substrate harness types + ClaudeCodeHarness refactor (cortex#91 PR-A)

- [ ] **A.1.1** `SessionHarness` interface defined in `src/common/substrates/types.ts`. Methods: `dispatch(req): AsyncIterable<MyelinEnvelope>`, lifecycle hooks (`onStart`, `onStop`).
- [ ] **A.1.2** `ClaudeCodeHarness` implementation refactored out of `src/runner/cc-session.ts`. The spawn-and-stream-json logic moves behind the `SessionHarness.dispatch()` contract.
- [ ] **A.1.3** `BusPeerHarness` stub — connects to NATS via the existing `MyelinRuntime`; publishes a dispatch envelope; subscribes to the reply subject. Pattern matches sage's existing peer behaviour.
- [ ] **A.1.4** Tests: substrate harness unit tests cover both implementations; `cc-session` regression tests pass behind the new interface.
- [ ] **A.1.5** `bunx tsc --noEmit` clean.

### A.2 Envelope upgrade to post-F-021 myelin (cortex#109 sub-task)

- [ ] **A.2.1** Bump `src/bus/myelin/envelope-validator.ts` `SCHEMA_SOURCE_COMMIT` from `96b14ea` to current myelin HEAD (post-#31 chain-of-stamps + F-021 task fields + `signed_by[]` array form).
- [ ] **A.2.2** Update vendored schema at `src/bus/myelin/vendor/envelope.schema.json` to match.
- [ ] **A.2.3** Wire chain-of-stamps consumption — read inbound `signed_by[]` and surface to dispatch-handler. No verification yet (that's Phase B); just structural parsing.
- [ ] **A.2.4** Verify existing tests pass against the new schema; add tests for new fields (`requirements`, `distribution_mode`, `target_principal`, `deadline`, `sovereignty_required`).

### A.3 Parameterise classification at the four emit sites (cortex#109 main work)

- [ ] **A.3.1** `src/bus/dispatch-events.ts:73` — accept `classification` as a constructor arg; default `"local"`.
- [ ] **A.3.2** `src/bus/system-events.ts:102` — same.
- [ ] **A.3.3** `src/bus/github-events.ts:89` — same.
- [ ] **A.3.4** `src/taps/cc-events/cc-events.ts:99` — same.
- [ ] **A.3.5** `src/bus/myelin/runtime.ts:236` — `publish()` derives subject prefix from `envelope.sovereignty.classification` (uses `deriveNatsSubject()` from myelin); rejects misaligned `classification` ↔ subject combinations at publish time.
- [ ] **A.3.6** Tests: each emit site has a regression test that publishing with `classification: "federated"` produces a `federated.*` subject, not `local.*`.

### A.4 Add visibility filter to surface-router (cortex#109 §B)

- [ ] **A.4.1** Extend `RendererSchema` in `src/common/types/cortex-config.ts` with a `visibility:` block:
  - `max_classification: "local" | "federated" | "public"` — renderer refuses higher.
  - `require_residency: string[]` — renderer accepts only matching residency.
  - `require_model_class: string[]` — renderer accepts only matching model class.
- [ ] **A.4.2** Surface-router (`src/bus/surface-router.ts`) applies the visibility filter in `adapterMatches()` before invoking `adapter.render()`. Sovereignty mismatch = quiet skip + (optional) log.
- [ ] **A.4.3** Dashboard renderer (`src/renderers/dashboard.ts`) declares its visibility config — default `max_classification: "local"` for parity with today.
- [ ] **A.4.4** Tests: a `federated.*` envelope is dropped by a `max_classification: local` renderer; same envelope is rendered by a `max_classification: federated` renderer.

### A.5 Add `stack:` block to cortex.yaml schema (Q7 lock-in)

- [ ] **A.5.1** File myelin issue: extend `specs/namespace.md` to allow `local.{operator}.{stack}.>` and `federated.{operator}.{stack}.>` subject grammars. `deriveNatsSubject()` and `validateSubjectEnvelopeAlignment()` extended to accept either form. Backward compatibility: if no stack segment, default-derive as `{operator_id}/default`.
- [ ] **A.5.2** Cortex consumes the myelin extension once it lands — bump vendored envelope as needed.
- [ ] **A.5.3** Extend `CortexConfig` in `src/common/types/cortex-config.ts` with a `stack:` block:
  - `stack.id` — string matching `{operator_id}/{stack_id}` format with regex validation.
  - `stack.nkey_pub` — base32 NKey public key (signed by operator account NKey).
- [ ] **A.5.4** `cortex.ts` entrypoint reads `stack:` at boot; falls back to `${operator.id}/default` if undeclared.
- [ ] **A.5.5** `MyelinRuntime.publish()` includes the stack segment in subject derivation when present.
- [ ] **A.5.6** Tests: cortex.yaml with `stack: { id: andreas/research }` emits envelopes on `local.andreas.research.>` instead of `local.andreas.>`; backward-compat test with no `stack:` block still emits `local.andreas.>` (which now becomes `local.andreas.default.>` once myelin extension lands).

### A.6 Add `capabilities:` block to cortex.yaml schema (Q2 lock-in)

- [ ] **A.6.1** Extend `CortexConfig` with a `capabilities:` block — array of capability declarations conforming to the constrained schema:
  ```yaml
  capabilities:
    - id: code-review.typescript
      description: "TypeScript code review with type-checking analysis"
      tags: [typescript, code-review, ts]
      provided_by: [echo]
      rate: { per_minute: 10 }   # optional
      cost: { cents_per_request: 2 }  # optional
  ```
- [ ] **A.6.2** Schema validator enforces required fields (`id`, `description`, `tags`, `provided_by`); optional `rate` / `cost` validated as structured envelopes.
- [ ] **A.6.3** Per-agent `capabilities[]` annotations within `agents[]` are first-class — the stack-level `capabilities:` block is the union plus any stack-extras.
- [ ] **A.6.4** Tests: invalid capability declarations (free-text, missing `id`) are rejected at config load; valid ones parse into the typed object.

### Phase A acceptance criteria

- `SessionHarness` interface compiles + tested; `ClaudeCodeHarness` passes all current `cc-session.ts` tests behind new interface.
- `BusPeerHarness` connects to local sage daemon and routes a fake review task end-to-end.
- Cortex no longer hardcodes `classification` at any of the four emit sites.
- Surface-router applies `sovereignty.classification` filter in `adapterMatches()`.
- Renderer config supports `visibility:` block (max_classification / require_residency / require_model_class).
- cortex.yaml `stack:` block validates and propagates into outbound envelopes' subject form.
- cortex.yaml `capabilities:` block validates and is queryable from the substrate harness.
- Vendored envelope past `96b14ea`; `signed_by[]` array surfaces structurally (no verification yet).

**Phase A does NOT require Phase B or later.** It unblocks single-stack federation; multi-operator waits for Phase D.

---

## 3. Phase B — Identity (NKey-signed bot↔bot)

**Goal:** Bot↔bot dispatch travels over the bus with NKey-signed envelopes; chain-of-stamps verification on every inbound dispatch; Discord-platform-ID-based trust retires for bot↔bot paths (kept for human-to-bot DMs as Discord-side fallback).

**Issue:** `cortex#? — IAW Phase B: Identity (NKey-signed bot↔bot)`.

**Estimated effort:** 1–2 weeks.

**Entry criteria:**

- Phase A complete (BusPeerHarness exists; envelope schema upgraded; chain-of-stamps parses structurally).
- Q1 lock-in confirmed (`{operator_id}/{stack_id}` identity, 3-tier NKey chain) — DONE 2026-05-13.

### B.1 BusPeerHarness signature verification

- [ ] **B.1.1** `BusPeerHarness.dispatch()` reads inbound `signed_by[]` and verifies each stamp against the local `PrincipalRegistry`.
- [ ] **B.1.2** TrustResolver gains a `trustsByNKey(agentId, signerPubKey) → boolean` method — checks the agent's trust list against the verified stamp.
- [ ] **B.1.3** A failed signature verification rejects the dispatch and emits a `system.access.denied` envelope (cortex#97 audit envelopes, integrated via Phase C's PolicyEngine — at Phase B, log only).
- [ ] **B.1.4** Verification covers the full chain (every stamp, not just `signed_by[0]`).

### B.2 ClaudeCodeHarness uses bus for bot↔bot calls

- [ ] **B.2.1** Replace "post in #cortex with @mention" pattern with `MyelinRuntime.publish()` for bot↔bot dispatch.
- [ ] **B.2.2** Discord adapter `mentionsAgent()` keeps working for human-to-bot DMs; bot↔bot path no longer consults Discord platform IDs.
- [ ] **B.2.3** cortex#98 `trustedAgentBots` stays as Discord-side fallback for human-to-bot DMs (per `cortex/docs/architecture.md` §9.3); bot↔bot path now uses NKey trust.

### B.3 Outbound envelope signing

- [ ] **B.3.1** `MyelinRuntime.publish()` signs every outbound envelope with the stack's NKey (loaded from `cortex.yaml.stack.nkey_pub` + sibling private key path).
- [ ] **B.3.2** Multi-hop envelopes (forwarded across stacks) append a new `signed_by[]` entry per hop, preserving the prior chain.
- [ ] **B.3.3** JCS canonicalization (per `myelin/src/identity/`) used for signature input.

### B.4 Tests

- [ ] **B.4.1** Round-trip test: agent A (operator alpha) emits a dispatch; agent B (operator beta) verifies the signature; B's reply chain stamps both stacks.
- [ ] **B.4.2** Forged-signature test: a tampered envelope is rejected by BusPeerHarness.
- [ ] **B.4.3** Cross-trust test: a stack not in the local trust registry is rejected.

### Phase B acceptance criteria

- BusPeerHarness verifies `signed_by[]` against TrustResolver on every inbound dispatch.
- ClaudeCodeHarness uses MyelinRuntime.publish for bot-bot calls.
- TrustResolver gains `trustsByNKey()` method.
- Round-trip bot↔bot test green with two stacks signing each other's envelopes.

---

## 4. Phase C — Policy + schema flip (PolicyEngine at M6)

**Goal:** PolicyEngine is the single decision point for "what is this principal allowed to do?" — replacing per-surface duplication. cortex.yaml flips ONCE from per-adapter `roles[]` to top-level `policy:{ principals[], roles[] }`. The `stack:` block (Phase A) and the `capabilities:` block (Phase A) live alongside the new `policy:` block. **This is the only phase that flips the operator-facing config schema.**

**Issue:** `cortex#? — IAW Phase C: Policy + schema flip`.

**Estimated effort:** 2–3 weeks.

**Entry criteria:**

- Phase A complete (sovereignty consumable; PolicyEngine reads `envelope.sovereignty` as input).
- Phase B complete (NKey-signed envelopes; `signed_by[].principal` resolves against `policy.principals[]`).
- Q6 lock-in confirmed (audit ownership) — DONE 2026-05-13.
- Q7 lock-in confirmed (stack-aware namespace) — DONE 2026-05-13. Phase C is the last natural moment to absorb the stack-aware namespace into cortex.yaml's principal model without re-flipping later.

### C.1 PolicyEngine module

- [ ] **C.1.1** Create `src/common/policy/` directory.
- [ ] **C.1.2** `PolicyEngine.check(principal, intent) → { allow, capabilities } | { allow: false, reason }` API.
- [ ] **C.1.3** Inputs: a `Principal { id, home_operator, home_stack, role[], trust[] }`; an `Intent { capability, sovereignty, payload_summary }`.
- [ ] **C.1.4** Decision logic: principal's role grants → intersection with required capabilities; sovereignty constraints (max_classification, allowed_residency); per-peer accept/deny lists (Phase D extends).
- [ ] **C.1.5** Audit emission: every check emits `system.access.{allowed,denied}` envelope (cortex#97 audit envelopes) on `local.{operator}.{stack}.system.access.{allowed|denied}`.

### C.2 cortex.yaml schema flip

- [ ] **C.2.1** Schema migration: per-adapter `roles[]` removed; top-level `policy: { principals[], roles[] }` added.
- [ ] **C.2.2** `policy.principals[]` schema:
  ```yaml
  policy:
    principals:
      - id: agent-luna
        home_operator: andreas
        home_stack: andreas/research
        nkey_pub: SAA…
        role: [chat, async]
        trust: [agent-echo, agent-holly]
      - id: agent-echo
        home_operator: andreas
        home_stack: andreas/code
        ...
    roles:
      - id: chat
        capabilities: [...]
        sovereignty:
          max_classification: federated
  ```
- [ ] **C.2.3** Discord/Mattermost adapters thin to ~30 LOC: translate inbound event → `Principal`; call `PolicyEngine.check`; act on result. No role-resolver logic in adapter.
- [ ] **C.2.4** `migrate-config` CLI extension: lift existing per-adapter roles into top-level `policy:` with warnings on inconsistencies between adapters.

### C.3 Integration with substrate harness

- [ ] **C.3.1** Dispatch-handler calls `PolicyEngine.check()` before invoking `SessionHarness.dispatch()`.
- [ ] **C.3.2** Substrate harness receives the `Principal` object as part of the dispatch request (already specified in cortex#91 spec).
- [ ] **C.3.3** Sovereignty fields flow: envelope.sovereignty → PolicyEngine input → harness has visibility for downstream LLM calls (e.g. frontier-ok gates frontier model calls).

### C.4 Audit envelopes (cortex#97 tie-in)

- [ ] **C.4.1** PolicyEngine emits `system.access.allowed` for every accepted dispatch.
- [ ] **C.4.2** PolicyEngine emits `system.access.denied` for every rejected dispatch with a structured reason code (`unknown_principal`, `insufficient_role`, `sovereignty_mismatch`, `peer_deny_list`).
- [ ] **C.4.3** Audit envelopes carry `signed_by[]` from the originating event (so denied envelopes are still cryptographically attributable).

### C.5 Tests + migration

- [ ] **C.5.1** PolicyEngine unit tests cover allow/deny matrix.
- [ ] **C.5.2** Migration test: a representative grove-v2 `bot.yaml` flips to cortex-shaped `cortex.yaml` with the new `policy:` block; round-trip identity (same auth decisions).
- [ ] **C.5.3** Integration test: end-to-end inbound Discord event → adapter → dispatch-handler → PolicyEngine → harness → envelope-emitted reply, with audit envelopes asserted.

### Phase C acceptance criteria

- `src/common/policy/` module exists with `PolicyEngine.check()`.
- Discord/Mattermost adapters reduced to ~30 LOC each.
- cortex.yaml schema has `policy: { principals[], roles[] }` at top level; per-adapter `roles[]` removed.
- `migrate-config` CLI lifts existing per-surface roles into top-level `policy:`.
- `system.access.{allowed,denied}` envelopes emitted by PolicyEngine.
- cortex.yaml schema migration is one-way (post-flip, no rollback in v1).

**Critical insight (from design doc §6):** This is the ONLY phase where the operator-facing config schema changes. Sequencing Phases A and B before Phase C means the flip happens once. Q7 lock-in is absorbed here — the stack-aware namespace already lands at Phase A as a structurally additive `stack:` block; Phase C's `policy.principals[]` carries `home_operator` + `home_stack` so the principal table is stack-aware from the moment the flip happens.

---

## 5. Phase D — Federation (multi-operator + cloud-side registry)

**Goal:** Multi-operator federation operable. `policy.federated.peers[]` (within `policy.federated.networks[]` per Q4 lock-in) declares peer operators + their pubkeys. Surface-router gates inbound `federated.*` envelopes by per-peer policy. Cloud-side network registry service hosts the canonical pubkey directory (per Q3 lock-in). cortex#107 Step H multi-operator dashboard consumes it.

**Issue:** `cortex#? — IAW Phase D: Federation`.

**Estimated effort:** 3–4 weeks.

**Entry criteria:**

- Phase C complete (PolicyEngine exists; principals carry `home_operator` + `home_stack`).
- Q3 lock-in confirmed (centralised registry, NOT gossip) — DONE 2026-05-13.

### D.1 `policy.federated.networks[]` schema

- [ ] **D.1.1** Extend `CortexConfig` with `policy.federated.networks[]`:
  ```yaml
  policy:
    federated:
      networks:
        - id: research-collab
          leaf_node: nats-leaf-research
          peers:
            - operator_id: jcfischer
              stack_id: jcfischer/sage-host
              operator_pubkey: O_JC_…
          accept_subjects: ["federated.research-collab.tasks.code-review.*"]
          deny_subjects: ["federated.research-collab.tasks.*.private.*"]
          announce_capabilities: ["code-review", "security-scan"]
          max_hop: 1
  ```
- [ ] **D.1.2** Schema validator enforces required fields and `{operator_id}/{stack_id}` format.
- [ ] **D.1.3** `leaf_node` reference matches a named NATS connection (Phase E expands to multi-link MyelinRuntime; in Phase D, only one network leaf-node is operable concurrently).

### D.2 Surface-router accept/deny gating

- [ ] **D.2.1** Surface-router extends `adapterMatches()` to gate inbound `federated.*` envelopes against the originating network's `accept_subjects` / `deny_subjects` lists.
- [ ] **D.2.2** Match-failure emits `system.access.denied` with reason `peer_deny_list` or `peer_not_in_accept_list`.
- [ ] **D.2.3** Hop counting: `signed_by[].length` vs. `max_hop` — over-budget envelopes rejected with `max_hop_exceeded`.

### D.3 PolicyEngine extends for per-peer slicing

- [ ] **D.3.1** PolicyEngine takes the source network as part of `Intent`; resolves the principal's home network → applies per-network policy slice.
- [ ] **D.3.2** Audit envelopes include the source network in the structured reason.

### D.4 Cloud-side network registry service

- [ ] **D.4.1** New service alongside `grove-api` (renamed to `cortex-api` post-MIG-7); hosted at `network.meta-factory.ai` or similar. Hono REST API.
- [ ] **D.4.2** Endpoints:
  - `POST /operators/{operator_id}/register` — operator publishes their operator NKey + stack identities + capability declaration (signed assertion).
  - `GET /operators/{operator_id}` — peers query operator's current pubkey + stack list.
  - `GET /networks/{network_id}/roster` — query who's in this network.
  - `GET /capabilities?query=...` — capability search across networks.
- [ ] **D.4.3** Cortex consults the registry at startup + on schedule to refresh peer pubkeys; in-memory cache invalidated on operator-publish events.
- [ ] **D.4.4** Registry signs assertions; cortex verifies before trusting.

### D.5 Cloud dashboard multi-operator slicing (cortex#107 Step H)

- [ ] **D.5.1** The existing dashboard subscribes to `local.{operator}.{stack}.>`; the cloud variant subscribes to `federated.>` cross-operator (within accept-listed networks).
- [ ] **D.5.2** Per-operator slicing keyed off `principal.home_operator` for filtering dashboard cards.
- [ ] **D.5.3** UI surfaces sovereignty + classification on every card (G-1110 work).

### D.6 Tests + cross-operator integration

- [ ] **D.6.1** Two-operator integration test: operator alpha emits `federated.research-collab.tasks.code-review.typescript`; operator beta picks it up via queue-group; beta's stack signs the reply; alpha verifies the chain. Both operators' audits show their respective stamps.
- [ ] **D.6.2** Registry test: operator alpha registers; operator beta queries; beta's cortex refreshes its peer pubkey cache.
- [ ] **D.6.3** Deny-list test: an attempted inbound envelope on a `deny_subjects` pattern is rejected with the correct reason.

### Phase D acceptance criteria

- `policy.federated.networks[]` schema landed.
- Surface-router gates inbound `federated.*` envelopes by per-peer accept rules.
- PolicyEngine supports per-network slicing.
- A second operator (jcfischer or test rig) successfully federates a task; envelope chain verifiable on both sides.
- Cloud dashboard slices per operator using `home_operator`.
- Cloud-side network registry service deployed and integrated.

---

## 6. Phase E — Multi-network bridges + delegation

**Goal:** A single cortex daemon participates in N networks concurrently (multi-link MyelinRuntime). The §3.6 delegation pattern (orchestrator agents) becomes operable in production. Mesh varieties — private / isolated / public — composable per `policy.federated.networks[]`.

**Issue:** `cortex#? — IAW Phase E: Multi-network bridges + delegation`.

**Estimated effort:** 4–6 weeks.

**Entry criteria:**

- Phase D complete (single-network federation working end-to-end).
- Q4 lock-in confirmed (separate networks, not per-peer scoping) — DONE 2026-05-13.

### E.1 Multi-link MyelinRuntime

- [ ] **E.1.1** Refactor `MyelinRuntime` to manage a pool of `NatsLink`s, one per `leaf_node` reference in `policy.federated.networks[]`.
- [ ] **E.1.2** Per-link lifecycle: connect, drain, reconnect; each link has its own subscriber set + publisher.
- [ ] **E.1.3** Subject scoping: a publish to `federated.research-collab.>` routes via the research-collab link; a publish to `federated.jv.>` routes via the JV link.
- [ ] **E.1.4** Inbound envelopes carry their source network reference (which link delivered them).
- [ ] **E.1.5** Tests: a single cortex process opens two leaf-nodes; publishes a `federated.research-collab.*` envelope through link A; receives a `federated.jv.*` envelope through link B; chain-of-stamps preserved across both.

### E.2 Per-network capability announcement

- [ ] **E.2.1** Each `policy.federated.networks[]` entry's `announce_capabilities[]` is the subset of the stack's `capabilities:` published to that network.
- [ ] **E.2.2** Capability registration with the cloud-side network registry (Phase D D.4) carries per-network scope.
- [ ] **E.2.3** Tests: stack declares capabilities `[code-review, deploy]`; announces `code-review` to network A and `deploy` to network B; queries to the registry return the right subset per network.

### E.3 Delegation pattern primitives (§3.6)

- [ ] **E.3.1** Orchestrator agent reference implementation: a persona/runtime that reads the network capability registry, picks a target network/stack for an inbound task, emits a `federated.{network}.tasks.{capability}` envelope.
- [ ] **E.3.2** Reply correlation: the orchestrator waits for the chain-of-stamps reply via the per-link queue group; binds reply to the original inbound request via envelope ID.
- [ ] **E.3.3** Failure handling: if no peer in the target network claims within timeout, fall back to a sibling network or emit `dispatch.task.failed`.
- [ ] **E.3.4** Test rig: orchestrator agent on operator alpha delegates a TypeScript code-review task to operator beta's `code-review.typescript` capability; receives reply; threads through to original sender.

### E.4 Mesh variety scaffolding (private / isolated / public)

- [ ] **E.4.1** Private mesh (`policy.federated.networks: []`) — already operable post-Phase D; document the configuration pattern.
- [ ] **E.4.2** Isolated-private mesh (JV pattern, §3.5) — multi-peer single-network registry with bidirectional accept rules; reference example with 4 peer stacks.
- [ ] **E.4.3** Public mesh stub — `policy.public.announce_capabilities[]` schema reserved; no implementation in Phase E (defer to post-IAW future work).

### E.5 Tests + production readiness

- [ ] **E.5.1** Bridge-stack integration test: one cortex daemon participates in 2 networks, publishes different capabilities to each, receives federated traffic on both links.
- [ ] **E.5.2** Delegation chain test: orchestrator → network → claimer → reply → originator, with full chain-of-stamps verification at each step.
- [ ] **E.5.3** Failure-mode tests: peer goes offline mid-task → dead-letter; network registry unreachable → graceful degradation to last-known cache.

### Phase E acceptance criteria

- `MyelinRuntime` supports multiple NATS links concurrently (one per leaf-node).
- `policy.federated.networks[].leaf_node` references a named NatsLink.
- A test rig demonstrates a single cortex process participating in 2 distinct networks (separate leaf-nodes), publishing different capabilities to each.
- Operator-vision script's "bridge stack" pattern operable.
- Orchestrator agent reference implementation delegates across networks via chain-of-stamps.
- Mesh varieties documented; private + isolated-private operable; public deferred.

---

## 7. Sub-issues + PR conventions

### 7.1 Sub-issue structure

Each phase has one tracking issue in `the-metafactory/cortex`, child of cortex#110:

- `cortex#? — IAW Phase A: Foundation — substrate harness + visibility consumption`
- `cortex#? — IAW Phase B: Identity — NKey-signed bot↔bot`
- `cortex#? — IAW Phase C: Policy + schema flip — PolicyEngine at M6`
- `cortex#? — IAW Phase D: Federation — multi-operator peer registry + cloud registry service`
- `cortex#? — IAW Phase E: Multi-network bridges + delegation`

Issue numbers filed and tracked in §8 cross-references below.

### 7.2 PR title format

```
feat(cortex): I-NNN.X — {one-line scope} (IAW Phase {A|B|C|D|E}.Y)
```

E.g.: `feat(cortex): I-101.3 — parameterise classification at 4 emit sites (IAW Phase A.3)`

### 7.3 Pilot-loop usage

Each PR runs through the standard pilot-review-loop skill with Echo as primary reviewer. Defer big architectural feedback (anything that questions decisions in `design-internet-of-agentic-work.md` §§3–4) back into a discussion on that doc rather than blocking the PR — the design doc is the architecture ground truth; this plan is the implementation ground truth.

### 7.4 Test discipline

- Every new file has at least one test.
- Type-check (`bunx tsc --noEmit`) is green before PR open.
- New protocol semantics (envelope shape, subject grammar, signature flow) have integration tests at the bus boundary.
- Cross-operator scenarios (Phase D+) have at minimum a two-stack integration test in a local test rig.

---

## 8. Cross-references

### 8.1 Issues + PRs

- **cortex#110** — META (operator-facing Internet of Agentic Work umbrella).
- **cortex#112** — design synthesis doc PR (this PR's sibling).
- **cortex#91** — substrate harness (consumed in Phase A; SessionHarness interface).
- **cortex#102** — bot↔bot via bus envelopes (consumed in Phase B; chain-of-stamps verification).
- **cortex#107** — principal-based AAA (consumed in Phase C; PolicyEngine + cortex.yaml flip + Step H multi-operator dashboard in Phase D).
- **cortex#109** — envelope-visibility composition (consumed in Phase A §A.2/§A.3/§A.4 + Phase D §D.1/§D.2).
- **cortex#113** — IAW Phase A: Foundation (I-101).
- **cortex#114** — IAW Phase B: Identity (I-102).
- **cortex#115** — IAW Phase C: Policy + schema flip (I-103).
- **cortex#116** — IAW Phase D: Federation (I-104).
- **cortex#117** — IAW Phase E: Multi-network bridges + delegation (I-105).

### 8.2 Blueprint

- **I-100** — Internet of Agentic Work META (umbrella).
- **I-101** — IAW Phase A: Foundation.
- **I-102** — IAW Phase B: Identity.
- **I-103** — IAW Phase C: Policy + schema flip.
- **I-104** — IAW Phase D: Federation.
- **I-105** — IAW Phase E: Multi-network bridges + delegation.

See `blueprint.yaml` for the dependency graph; `blueprint ready` indicates which phase is unblocked at any given time.

### 8.3 Myelin coordination

- **myelin#? — namespace extension for stack segment** — filed in Phase A.5; required before Phase C cortex.yaml schema flip absorbs the stack-aware namespace.
- **myelin#31 — chain-of-stamps** — already shipped (PR #92); cortex consumes in Phase A.2 (structural) and Phase B (verification).
- **myelin#9 — L5 discovery** — future, post-Phase E; could replace cortex's local capability-registry consumer with a generic myelin one.
- **myelin#11 — sovereignty enforcement protocol** — spec-pending; not blocking IAW phases; tracks ahead.

---

## 9. Working notes / open questions

This section is the daily-driver scratchpad as Phase A implementation proceeds — mirrors `plan-cortex-migration.md` §6 "Decisions deferred / open questions". Add entries as questions surface; tick them when answered.

### 9.1 Phase A entry-criteria open items

- **Myelin namespace extension lead time.** Phase A.5 needs a myelin issue + PR to land before cortex can fully consume the stack-aware namespace. If myelin is in flight on something else, cortex may need to ship A.1–A.4 first and circle back to A.5. Acceptable but flagged.
- **Backward compatibility for existing deployments.** Default `{operator_id}/default` works in theory; need to verify the default-derivation produces identical subjects to today (currently `local.andreas.>` → should become `local.andreas.default.>` after Phase A.5 lands, with rewrite invisible to operators). Test rig.

### 9.2 Phase B reconcile with cortex#92

- **Cross-reference Q5 (queue groups) with cortex#92 Q5.** cortex#91 substrate harness design PR has its own Q5 — verify both Q5s converge on queue groups; if cortex#92 lands a different competing-consumer model for in-process dispatch, flag as inconsistency.

### 9.3 Phase C schema-flip surface area

- **`migrate-config` CLI changes.** cortex.yaml grew a `stack:` block in Phase A and a `capabilities:` block in Phase A; Phase C flips `roles[]` to `policy:`. The CLI needs to handle a multi-stage migration: an operator might be at Phase A schema (stack + capabilities, no policy) or Phase C schema (full flipped). Lean: idempotent re-runs — running migrate-config on already-flipped config is a no-op.
- **Audit-envelope subject form.** Phase C emits `system.access.{allowed,denied}` on the stack-aware subject (`local.{operator}.{stack}.system.access.*`). Verify renderer subscriptions still match (renderer's `subjects:` pattern needs to include the new stack segment).

### 9.4 Phase D registry service ownership

- **Cloud-side network registry — single service or per-network?** Recommendation: single global service (similar to DNS root + zone delegation) — operators register globally; networks are membership lists computed by the registry. Per-network instances could federate but adds complexity. Lean: single global registry alongside the cloud dashboard service; revisit if multi-region or compliance demands surface.
- **Signed assertion format.** Registry assertions need to be verifiable independently of the registry's availability (operator A queries registry, registry returns operator B's pubkey signed by operator B's NKey + countersigned by registry). Use JCS canonicalisation for signature input; reuse the chain-of-stamps signing infrastructure from Phase B where possible.

### 9.5 Phase E multi-network MyelinRuntime refactor

- **Single daemon vs. per-stack daemon.** Q7's "Phase E design decision" — does one cortex daemon host multiple stacks, or does each stack get its own daemon? Tradeoff: single daemon has lower process count + cross-stack visibility but more complex isolation; per-stack daemon has cleaner blast-radius but more process overhead + cross-stack IPC. Lean: single-daemon for v1 (operator typically has one or two stacks), per-stack daemon as a future option if isolation guarantees become load-bearing.
- **Subject namespace within a multi-stack daemon.** If one daemon hosts `andreas/research` + `andreas/production`, do their subjects share a process-wide NatsLink (publish-side namespaced by stack segment) or separate links? Lean: shared link with subject-segment isolation (saves NATS connections); rejected if test rig finds cross-stack subject leakage.

### 9.6 Orchestrator agent pattern (§3.6) design follow-ons

- **Capability matching algorithm.** Orchestrator reads network capability registry; how does it pick between two networks that both offer `code-review.typescript`? Options: (a) operator-declared preference list; (b) cost-aware (Q2 optional `cost` field); (c) load-aware (queue depth as proxy). Lean: (a) for v1 (deterministic), (b)/(c) future.
- **Reply correlation latency.** Chain-of-stamps reply over federation has more latency than in-process. Orchestrator needs configurable timeout per delegation; default ~30s? Open.

### 9.7 Inconsistencies surfaced during this plan write-up

- (Q1–Q7 lock-ins are internally consistent with §§1–4 of the design doc, modulo the §3.4 rewrite to reflect Q4.)
- §3.4's prior framing had `policy.federated.peers[]` as the top-level structure; Q4 lock-in is `policy.federated.networks[]` with `peers[]` nested. The design doc §3.4 has been rewritten; this plan's Phase D §D.1 reflects the new shape. Cortex#109's body may still reference the old framing — flag at Phase D entry.
- Phase A.5 (myelin namespace extension for `{stack}` segment) is filed as a myelin issue, but cortex's vendored envelope upgrade rides along in Phase A.2. The order is: myelin issue → myelin PR merges → cortex bumps `SCHEMA_SOURCE_COMMIT`. If myelin is in flight on something else, cortex may need to land A.1–A.4 (substrate harness + non-stack-aware visibility) first and circle back to A.5.

### 9.8 Operational considerations not yet sized

- **JetStream stream config across networks.** cortex's MIG-1 stream config relies on `local.*.tasks.>` + `federated.*.tasks.>` (per `myelin/specs/namespace.md:216-247`). With the Phase A.5 stack-aware namespace, do we need separate streams per stack (`local.{operator}.{stack}.tasks.>`) or does the existing stream catch them? Lean: existing stream filter pattern `local.*.tasks.>` is single-segment-wildcard, so `local.andreas.research.tasks.>` would NOT match. Need to extend filter to `local.>` or `local.*.*.tasks.>`. Open question for Phase A.
- **Queue group naming.** Phase A queue groups for `local.{operator}.{stack}.tasks.{cap}` — does the queue group name include the stack? Lean: yes, queue group naming follows subject (e.g. `qg:andreas/research:code-review`); otherwise two stacks competing on the same capability share a queue group and steal each other's work.
- **Network registry availability.** Phase D registry is a CF Worker (likely Hono on `network.meta-factory.ai`). What's the SLO? Offline cache TTL? Lean: 7 days local cache TTL; degraded mode where cortex serves last-known-good pubkey directory if registry is unreachable. Refresh on schedule + on receiving an unverifiable signature from a peer.

---

## 10. Acceptance criteria — "Internet of Agentic Work delivered"

The IAW implementation is complete when all of:

- [ ] Phases A through E all closed (sub-issues + blueprint entries marked `done`).
- [ ] At least one bridge stack operable in production — single cortex daemon participating in 2 networks concurrently, with cross-network traffic verified via chain-of-stamps audits on both sides.
- [ ] Orchestrator agent reference implementation operable — delegates a task across networks, receives reply, threads results to original requester with full audit trail.
- [ ] cortex.yaml schema has flipped exactly ONCE (at Phase C). Operator-edit history shows one schema migration, not multiple.
- [ ] Cloud-side network registry service deployed at `network.meta-factory.ai` (or equivalent) — operators register their stacks, peers query the registry, signature chain verified.
- [ ] Mesh varieties documented and at least one example of each operable: private (single stack, no federation), federated (≥2 operators), isolated-private (JV, multi-peer single-network), bridge (one stack in N networks).
- [ ] Substrate harness landed — at least 2 distinct harness implementations (`ClaudeCodeHarness` + `BusPeerHarness`) operate behind the same interface.
- [ ] Chain-of-stamps `signed_by[]` verified on every inbound federated dispatch; forged/tampered envelopes provably rejected.
- [ ] PolicyEngine at M6 is the single AAA decision point; Discord + Mattermost adapters at ~30 LOC each (translate event → Principal; no role-resolver in adapter).
- [ ] All audit traffic remains operator-partitioned per Q6 lock-in; no central audit service exists; chain-of-stamps provides cross-operator correlation.
- [ ] cortex#110 META closes; the operator-facing video story is operable in production.

---

## 11. Process tooling + SOPs

This plan follows the metafactory ecosystem SOPs. Phase-specific notes:

### 11.1 Worktree discipline

Per `compass/sops/worktree-discipline.md`, each phase runs in its own worktree:

- Phase A: `~/Developer/Cortex-iaw-phase-a` on `feat/iaw-phase-a-foundation`
- Phase B: `~/Developer/Cortex-iaw-phase-b` on `feat/iaw-phase-b-identity`
- Phase C: `~/Developer/Cortex-iaw-phase-c` on `feat/iaw-phase-c-policy-flip`
- Phase D: `~/Developer/Cortex-iaw-phase-d` on `feat/iaw-phase-d-federation`
- Phase E: `~/Developer/Cortex-iaw-phase-e` on `feat/iaw-phase-e-multi-network`

Phases A and B may run concurrently if substrate harness lands first (A.1) and B starts on A.1's deliverable; otherwise sequential.

### 11.2 Dev pipeline

Per `compass/sops/dev-pipeline.md`:

- Branch per phase or per sub-checkbox.
- Each sub-checkbox = one PR (or part of a larger PR if trivially related).
- PR title format: `feat(cortex): I-NNN.X — {scope} (IAW Phase {A|B|C|D|E}.Y)`.
- Pilot loop (Echo for code review) drives each PR.

### 11.3 Versioning

Per `compass/sops/versioning.md`:

- Phase A bump: `v1.X.0` (minor — additive features: substrate harness, visibility, stack identity).
- Phase B bump: `v1.X+1.0` (minor — additive: chain-of-stamps verification).
- Phase C bump: `v2.0.0` (MAJOR — cortex.yaml schema flip is a breaking change for operators).
- Phase D bump: `v2.X.0` (minor — additive: federation primitives).
- Phase E bump: `v2.X+1.0` (minor — additive: multi-network + delegation).

Phase C is the one major version bump in the IAW work. Operators get a one-shot `migrate-config` CLI to flip from `v1.X` to `v2.0`.

### 11.4 Retrospective

Per `compass/sops/retrospective-and-process-mining.md`, after each phase merges:

- Write a short retro (~1 page) capturing what shipped, what surprised, what bottlenecks emerged.
- Append to `docs/iteration-internet-of-agentic-work.md` (filed alongside this plan; one section per phase).
- Process-mining patterns (e.g. "Phase A.5 myelin coordination dragged") get extracted into compass.

---

## 12. References

### 12.1 Design ground truth

- `docs/design-internet-of-agentic-work.md` — the static architecture spec. Q1–Q7 lock-ins in §5. Multi-network model in §3.4. Delegation patterns in §3.6.

### 12.2 Sibling issues (cortex)

- cortex#110 — META.
- cortex#112 — design synthesis PR.
- cortex#91 — substrate harness (M6).
- cortex#102 — bot↔bot via bus envelopes / NKey identity.
- cortex#107 — principal-based AAA at dispatch-handler.
- cortex#109 — envelope-visibility + subject-namespace routing.

### 12.3 Myelin source

- `myelin/specs/namespace.md` — canonical subject grammar (Phase A.5 extends).
- `myelin/docs/envelope.md` — chain-of-stamps + sovereignty fields.
- `myelin/src/identity/` — sign/verify/registry (Phase B consumes).
- `myelin/src/sovereignty/` — F-5 engine (Phases A+C consume).

### 12.4 Cortex source (current state — pre-Phase-A)

- `cortex/src/bus/myelin/envelope-validator.ts:22` — vendored schema pinned at myelin `96b14ea` (Phase A.2 bumps).
- `cortex/src/bus/myelin/runtime.ts:30-67` — MyelinRuntime interface (Phase E refactors).
- `cortex/src/bus/myelin/runtime.ts:223-249` — publish (Phase A.3 unhardcodes subject form).
- `cortex/src/bus/dispatch-events.ts:73` — `classification: "local"` hardcoded (Phase A.3 parameterises).
- `cortex/src/bus/system-events.ts:102` — `classification: "local"` hardcoded (Phase A.3).
- `cortex/src/bus/github-events.ts:89` — `classification: "local"` hardcoded (Phase A.3).
- `cortex/src/taps/cc-events/cc-events.ts:99` — `classification: "local"` hardcoded (Phase A.3).
- `cortex/src/bus/surface-router.ts:259-270` — `adapterMatches` (Phase A.4 adds visibility filter; Phase D adds peer accept gating).
- `cortex/src/common/agents/trust-resolver.ts:268-491` — operator-signature verification (Phase B extends with `trustsByNKey`).
- `cortex/src/common/types/cortex-config.ts:85-111` — `OperatorSchema` (Phase A.5 adds `stack:` block).
- `cortex/src/common/types/cortex-config.ts:447-491` — `NatsConfigSchema` (Phase A.5 ties stack NKey to existing credsAuthenticator).

### 12.5 Compass SOPs

- `compass/sops/dev-pipeline.md`
- `compass/sops/worktree-discipline.md`
- `compass/sops/pr-review.md`
- `compass/sops/versioning.md`
- `compass/sops/retrospective-and-process-mining.md`

### 12.6 Operator vision

- "Internet of Agentic Work" video script (2026-05-13, in cortex#110 body) — the operator-facing mental model. Used as North Star; not replicated here.

---

*Originating discussion: Andreas's 2026-05-13 verbatim lock-ins on Q1–Q7 + the "delegation pattern" framing (§3.6 new addition). This plan converts those decisions into a five-phase implementation roadmap with checkbox-driven task lists, mirroring the shape of `plan-cortex-migration.md`. Sequenced to flip the operator-facing schema exactly once (Phase C), with the stack-aware namespace landing structurally additively in Phase A and absorbed into the principal model at Phase C.*
