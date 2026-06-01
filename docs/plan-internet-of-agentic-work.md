# Plan — Internet of Agentic Work implementation

> **Terminology aligned to CONTEXT.md** (the architectural source of truth, post operator→principal refactor). The human who owns and runs stacks is the **principal** (was "operator"); dispatch modes are **Offer / Direct / Delegate** (Offer was "broadcast"); a subject's travel limit is its **scope** (was "reach"); the dotted NATS routing string is a **subject** (was "topic"); the named being is an **assistant**, its stack-local runtime an **agent**, a spawned CC task a **sub-agent** (was overloaded "agent"). Preserved distinct concepts: the NSC/NATS **operator account** (operator NKey / operator JWT), the "Operator vision" reference label, and code identifiers / field names like `home_operator` / `operatorId` (tracked separately as cortex#448 — pending rename, left as-is here).

**Status:** Working document. Single source of truth for the cortex#110 (META) work — the implementation of the Internet of Agentic Work composition model. Every PR cites a phase + checklist item from this doc. **For "what we're building and why" (architecture, OSI layering, composition model, Operator vision), see the static design doc `docs/design-internet-of-agentic-work.md`.** This plan covers only the implementation sequencing: what ships in what phase, in what order, with what entry/exit criteria. When this doc and reality disagree, this doc wins (or is updated, never silently). When this doc and the design doc disagree on architecture, the design doc wins.
**Date opened:** 2026-05-13
**Driver:** Andreas
**Retires when:** Phase E closes (multi-network bridges + delegation patterns operable in production), plus the two new epics under §13 (config split + shared surface gateway) land.

**Related docs (load-bearing):**
- **`docs/design-internet-of-agentic-work.md`** — the static architecture spec. What IAW IS. Reference this for any "how should this be structured" question; only reference *this* doc for implementation mechanics.
- `docs/plan-cortex-migration.md` — the cortex spawn / migration plan from grove-v2. MIG-7 cutover is the moment cortex.yaml's schema flips for the first time; this plan's Phase C is the second (and last) schema flip.
- `cortex#110` (META) — the Operator-vision umbrella ("Internet of Agentic Work"). *("Operator vision" is the preserved North-Star reference label, not the human-actor sense.)*
- `cortex#112` (this PR) — the synthesis design doc.
- `cortex#91` — substrate harness (M6). Pre-existing sibling issue; consumed by Phase A.
- `cortex#102` — bot↔bot via bus envelopes / NKey identity (L3/L4). Pre-existing sibling issue; Phase B.
- `cortex#107` — principal-based AAA at dispatch-handler (M6). Pre-existing sibling issue; Phase C — includes Step H multi-principal cloud dashboard, consumed in Phase D.
- `cortex#109` — envelope-visibility composition + subject-namespace routing (L3/L4). Pre-existing sibling issue; consumed in Phases A and D.
- `~/Developer/myelin/specs/namespace.md` — myelin canonical namespace; Phase A extends to add a `{stack}` segment per Q7 lock-in.
- `~/Developer/myelin/docs/envelope.md` — chain-of-stamps + sovereignty fields. Phase A consumes the post-`96b14ea` envelope; Phase B consumes `signed_by[]`.
- `cortex/docs/architecture.md` §9 — assistant + presence/renderer model (post-MIG-7 cortex.yaml shape; this plan extends it).
- `~/Developer/compass/sops/dev-pipeline.md` + `worktree-discipline.md` + `pr-review.md` — standard dev SOPs.

---

## 1. Overview

The Internet of Agentic Work is the composition model where stacks (`{operator_id}/{stack_id}` — the slash-form id literal is tracked for rename under cortex#448; semantically the first segment is the **principal**) join networks via NATS leaf-node federation; networks compose into the principal's federated graph; assistants delegate across stacks and networks via the orchestrator pattern. Five phases sequenced A→E deliver this incrementally.

### 1.1 Phase ladder

| Phase | Scope | Effort | Sibling issues consumed | Schema flip? |
|---|---|---|---|---|
| **A** Foundation | Substrate harness + visibility consumption (4 emit sites parameterised + envelope upgrade + stack: block) | 2–3 weeks | cortex#91 + cortex#109 (§A+B+C) | No (stack: is additive with default) |
| **B** Identity | NKey-signed envelopes for bot↔bot (chain-of-stamps consumption) | 1–2 weeks | cortex#102 | No |
| **C** Policy + schema flip | PolicyEngine at M6 + cortex.yaml flips ONCE (stack block, principal table, role table) | 2–3 weeks | cortex#107 | **Yes — the only one** |
| **D** Federation | Peer registry + accept rules + network membership declaration + cloud-side network registry service | 3–4 weeks | cortex#107 (Step H) + cortex#109 (§E) | No (additive) |
| **CFG** Config split (FOUNDATION) | Multi-file config composer + system.yaml extraction + surface bindings out of per-stack presence | 1–2 weeks | new sibling issue (§13) | No (additive; transitional single-file fallback) |
| **GW** Shared surface gateway | One assistant, many deployments — gateway process + per-platform resolvers + per-stack adapter retirement | 3–4 weeks | new sibling issue (§13); depends on CFG | No (additive; `response_routing.instance` bump) |
| **E** Multi-network bridges + delegation | A stack participating in N networks; cross-network delegation patterns | 4–6 weeks | new sibling issue (Phase E sub-issue, this plan) | No (additive) |

Total: 12–18 weeks if strictly sequenced. Phases A and B are sequenceable; Phase C is the schema flip; Phase D depends on C; Phase E depends on D. The two new epics (§13) sit outside the A→E federation ladder: **CFG** (config split) is a low-risk foundation that should land before/with **GW** (shared surface gateway); GW builds on CFG's `surfaces.yaml`.

### 1.2 Locked-in design decisions (verbatim from §5 of the design doc, Andreas 2026-05-13)

> These Q1–Q7 lock-ins are quoted verbatim and unchanged. Where they say "operator", note the vocabulary mapping: the human is the **principal** (subject segment `{principal}`); the cryptographic root named "operator-account-NKey" / "operator JWT" is the genuine **NSC/NATS operator account** and is preserved as-is. The `{operator_id}` id literal is tracked for rename under cortex#448.

- **Q1 — Stack identity:** `{operator_id}/{stack_id}` slash-separated. NATS form `local.{operator}.{stack}.>` / `federated.{operator}.{stack}.>`. Cryptographic chain operator-account-NKey → stack-NKey → agent-NKeys. Operator-id is the network authority root.
- **Q2 — Capabilities:** Two-part — network capabilities aggregated across all member stacks + principal-declared stack-level capabilities in cortex.yaml using a constrained schema (id, description, tags, provided_by, optional rate/cost).
- **Q3 — Network registry:** Centralised; cortex.yaml + cloud-side network registry service alongside cortex#107 Step H dashboard. NOT NATS-gossiped.
- **Q4 — Bridge-stack scoping:** Separate networks, not per-peer scoping. Bridge stack = multiple network memberships.
- **Q5 — Competing-consumers:** NATS queue groups (claim-first-wins at bus layer); no reservation; no auction.
- **Q6 — Cross-network audit:** Chain-of-stamps `signed_by[]` IS the audit trail. Stack-level identity per stamp.
- **Q7 — Stack as protocol primitive:** YES. Namespace grows a stack segment. cortex.yaml gets a `stack:` block. Cortex daemon hosts a stack.

### 1.3 Non-goals of this implementation plan

- **Not a re-architecture.** Every Phase reuses existing M2–M6 cortex code (substrate harness, surface-router, trust resolver). New code is targeted.
- **Not the Operator-vision video script.** The video (cortex#110 body) is the "why"; this plan is the "how".
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

### A.1 Substrate harness types + ClaudeCodeHarness refactor (cortex#91 PR-A) — ✅ done excluding A.1.3 (PR #125, #126)

- [x] **A.1.1** `SessionHarness` interface defined in `src/common/substrates/types.ts`. Methods: `dispatch(req): AsyncIterable<MyelinEnvelope>`, lifecycle hooks (`onStart`, `onStop`). — PR #125
- [x] **A.1.2** `ClaudeCodeHarness` implementation refactored out of `src/runner/cc-session.ts`. The spawn-and-stream-json logic moves behind the `SessionHarness.dispatch()` contract. — PR #125
- [ ] **A.1.3** `BusPeerHarness` stub — connects to NATS via the existing `MyelinRuntime`; publishes a dispatch envelope; subscribes to the reply subject. Pattern matches sage's existing peer behaviour. **NOT YET SHIPPED** — PR #192 (Phase-A-finish doc sync) ticked this in error. The class doesn't exist in the tree; only a `// future BusPeerHarness slots in` comment in `src/runner/dispatch-listener.ts:33`. Carry-over: lands as part of Phase B (B.1b — see §3 below).
- [x] **A.1.4** Tests: substrate harness unit tests cover both implementations; `cc-session` regression tests pass behind the new interface. — PR #125, #126 (covers `ClaudeCodeHarness` only — `BusPeerHarness` tests follow B.1b).
- [x] **A.1.5** `bunx tsc --noEmit` clean. — verified at PR #126 merge

### A.2 Envelope upgrade to post-F-021 myelin (cortex#109 sub-task) — ✅ done (PR #128, follow-up #151)

- [x] **A.2.1** Bump `src/bus/myelin/envelope-validator.ts` `SCHEMA_SOURCE_COMMIT` from `96b14ea` to current myelin HEAD (post-#31 chain-of-stamps + F-021 task fields + `signed_by[]` array form). — PR #128 (→ `4578ae1`), then PR #151 (→ `b69c877`).
- [x] **A.2.2** Update vendored schema at `src/bus/myelin/vendor/envelope.schema.json` to match. — PR #128, refreshed at PR #151
- [x] **A.2.3** Wire chain-of-stamps consumption — read inbound `signed_by[]` and surface to dispatch-handler. No verification yet (that's Phase B); just structural parsing. — PR #128
- [x] **A.2.4** Verify existing tests pass against the new schema; add tests for new fields (`requirements`, `distribution_mode`, `target_principal`, `deadline`, `sovereignty_required`). — PR #128

### A.3 Parameterise classification at the four emit sites (cortex#109 main work) — ✅ done (PR #129)

- [x] **A.3.1** `src/bus/dispatch-events.ts:73` — accept `classification` as a constructor arg; default `"local"`. — PR #129
- [x] **A.3.2** `src/bus/system-events.ts:102` — same. — PR #129
- [x] **A.3.3** `src/bus/github-events.ts:89` — same. — PR #129
- [x] **A.3.4** `src/taps/cc-events/cc-events.ts:99` — same. — PR #129
- [x] **A.3.5** `src/bus/myelin/runtime.ts:236` — `publish()` derives subject prefix from `envelope.sovereignty.classification` (uses `deriveNatsSubject()` from myelin); rejects misaligned `classification` ↔ subject combinations at publish time. — PR #129
- [x] **A.3.6** Tests: each emit site has a regression test that publishing with `classification: "federated"` produces a `federated.*` subject, not `local.*`. — PR #129

### A.4 Add visibility filter to surface-router (cortex#109 §B) — ✅ done (PR #134)

- [x] **A.4.1** Extend `RendererSchema` in `src/common/types/cortex-config.ts` with a `visibility:` block: — PR #134
  - `max_classification: "local" | "federated" | "public"` — renderer refuses higher.
  - `require_residency: string[]` — renderer accepts only matching residency.
  - `require_model_class: string[]` — renderer accepts only matching model class.
- [x] **A.4.2** Surface-router (`src/bus/surface-router.ts`) applies the visibility filter in `adapterMatches()` before invoking `adapter.render()`. Sovereignty mismatch = quiet skip + (optional) log. — PR #134
- [x] **A.4.3** Dashboard renderer (`src/renderers/dashboard.ts`) declares its visibility config — default `max_classification: "local"` for parity with today. — PR #134
- [x] **A.4.4** Tests: a `federated.*` envelope is dropped by a `max_classification: local` renderer; same envelope is rendered by a `max_classification: federated` renderer. — PR #134

### A.5 Add `stack:` block to cortex.yaml schema (Q7 lock-in) — ✅ done (PR #140, #151; myelin#113 closed)

- [x] **A.5.1** File myelin issue: extend `specs/namespace.md` to allow `local.{operator}.{stack}.>` and `federated.{operator}.{stack}.>` subject grammars. `deriveNatsSubject()` and `validateSubjectEnvelopeAlignment()` extended to accept either form. Backward compatibility: if no stack segment, default-derive as `{operator_id}/default`. — myelin#113 filed + merged 2026-05-13 (myelin PR #114, squash `91bf2b42`)
- [x] **A.5.2** Cortex consumes the myelin extension once it lands — bump vendored envelope as needed. — PR #151 (vendored bump `4578ae1` → `b69c877` + stack-aware `deriveNatsSubject(opts)` adoption)
- [x] **A.5.3** Extend `CortexConfig` in `src/common/types/cortex-config.ts` with a `stack:` block: — PR #140
  - `stack.id` — string matching `{operator_id}/{stack_id}` format with regex validation.
  - `stack.nkey_pub` — base32 NKey public key (signed by operator account NKey).
- [x] **A.5.4** `cortex.ts` entrypoint reads `stack:` at boot; falls back to `${operator.id}/default` if undeclared. — PR #140
- [x] **A.5.5** `MyelinRuntime.publish()` includes the stack segment in subject derivation when present. — PR #151
- [x] **A.5.6** Tests: cortex.yaml with `stack: { id: andreas/research }` emits envelopes on `local.andreas.research.>` instead of `local.andreas.>`; backward-compat test with no `stack:` block still emits `local.andreas.>` (which now becomes `local.andreas.default.>` once myelin extension lands). — PR #140 + #151

### A.6 Add `capabilities:` block to cortex.yaml schema (Q2 lock-in) — ✅ done (PR #146)

- [x] **A.6.1** Extend `CortexConfig` with a `capabilities:` block — array of capability declarations conforming to the constrained schema: — PR #146
  ```yaml
  capabilities:
    - id: code-review.typescript
      description: "TypeScript code review with type-checking analysis"
      tags: [typescript, code-review, ts]
      provided_by: [echo]
      rate: { per_minute: 10 }   # optional
      cost: { cents_per_request: 2 }  # optional
  ```
- [x] **A.6.2** Schema validator enforces required fields (`id`, `description`, `tags`, `provided_by`); optional `rate` / `cost` validated as structured envelopes. — PR #146
- [x] **A.6.3** Per-agent `capabilities[]` annotations within `agents[]` are first-class — the stack-level `capabilities:` block is the union plus any stack-extras. — PR #146
- [x] **A.6.4** Tests: invalid capability declarations (free-text, missing `id`) are rejected at config load; valid ones parse into the typed object. — PR #146

### Schema-grammar hardening (entry criterion for A.5.5) — ✅ done (PR #144, #149)

The `{operator_id}` and `{stack_id}` segments are embedded in NATS subjects after A.5.5. To keep them safe boundaries for downstream pattern-matchers, all three identifier schemas were tightened to the letter-prefix grammar `/^[a-z][a-z0-9-]*$/`:

- [x] `OperatorSchema.id` — PR #144 (closes cortex#141)
- [x] `StackConfigSchema.id` segments — PR #144 (closes cortex#141)
- [x] `AgentSchema.id`, `trust[]` entry, `CapabilityProviderIdSchema` — PR #149 (closes cortex#145)

### Phase A acceptance criteria — ✅ all met (2026-05-15)

- [x] `SessionHarness` interface compiles + tested; `ClaudeCodeHarness` passes all current `cc-session.ts` tests behind new interface. — PR #125, #126
- [ ] `BusPeerHarness` connects to local sage daemon and routes a fake review task end-to-end. **NOT YET SHIPPED** — carry-over to Phase B (B.1b). PR #192 ticked this in error.
- [x] Cortex no longer hardcodes `classification` at any of the four emit sites. — PR #129
- [x] Surface-router applies `sovereignty.classification` filter in `adapterMatches()`. — PR #134
- [x] Renderer config supports `visibility:` block (max_classification / require_residency / require_model_class). — PR #134
- [x] cortex.yaml `stack:` block validates and propagates into outbound envelopes' subject form. — PR #140 + #151
- [x] cortex.yaml `capabilities:` block validates and is queryable from the substrate harness. — PR #146
- [x] Vendored envelope past `96b14ea`; `signed_by[]` array surfaces structurally (no verification yet). — PR #128 (→ `4578ae1`), refreshed at PR #151 (→ `b69c877`)

**Phase A does NOT require Phase B or later.** It unblocks single-stack federation; multi-principal waits for Phase D.

**Carry-over to Phase B (or future ops cycle):**
- **cortex#138** — JetStream `TASKS` stream filter shape (`local.*.tasks.>` → `local.*.*.tasks.>`). Cortex publishes stack-aware subjects today (PR #151), but cortex has no in-tree TASKS-stream consumer to break; the filter cutover is a principal-side NATS-server action (cortex.yaml ships no stream config). Reframed as a forward gate that lands when cortex grows a TASKS-stream consumer in Phase B/C.
- **cortex#139** — parallel-checkpoint proposal closed as moot. The myelin-lead-time risk it hedged against did not materialise: myelin#113 (the upstream namespace PR) merged 2026-05-13 at 16:01, three hours after cortex#139 was filed.

---

## 3. Phase B — Identity (NKey-signed bot↔bot)

**Goal:** Bot↔bot dispatch travels over the bus with NKey-signed envelopes; chain-of-stamps verification on every inbound dispatch; Discord-platform-ID-based trust retires for bot↔bot paths (kept for human-to-bot DMs as Discord-side fallback).

**Issue:** `cortex#? — IAW Phase B: Identity (NKey-signed bot↔bot)`.

**Estimated effort:** 1–2 weeks.

**Entry criteria:**

- Phase A complete EXCLUDING A.1.3 (envelope schema upgraded; chain-of-stamps parses structurally; substrate harness interface + `ClaudeCodeHarness` exist; classification parameterised at all 4 emit sites; visibility filter on surface-router; stack-aware namespace cutover shipped; capabilities schema landed). A.1.3 (`BusPeerHarness` scaffold) is rolled into B.1b below — it was speculatively ticked in PR #192 but never shipped.
- Q1 lock-in confirmed (`{operator_id}/{stack_id}` identity, 3-tier NKey chain) — DONE 2026-05-13.

### B.1a Verification primitives (no bus integration yet)

Standalone, testable in isolation. Lands ahead of `BusPeerHarness` so the verification helpers are reusable by any caller (CLI tooling, tests, future harnesses).

- [ ] **B.1a.1** `AgentSchema.nkey_pub` (optional, 56-char U-prefixed base32) so agents can declare their stack's signing key inline. Mirrors `StackConfigSchema.nkey_pub`. Phase C migrates this onto `policy.principals[]`.
- [ ] **B.1a.2** `AgentRegistry.tryGetByNkeyPub(pubkey) → Agent | undefined` — reverse lookup, returns `undefined` for unknown or ambiguous (two agents claiming the same key).
- [ ] **B.1a.3** `TrustResolver.trustsByNKey(receivingAgentId, signerPubKey) → boolean` — composes `tryGetByNkeyPub` + `AgentRegistry.trusts`. Mirrors the existing `trustsByPlatformId` pattern.
- [ ] **B.1a.4** `verifySignedByChain(envelope, opts) → { valid: boolean; rejectedAt?: number; reason?: string }` — walks `getSignedByChain(envelope)`; for each ed25519 stamp, extracts `did:mf:<name>` → `trustsByNKey` lookup; rejects on first failure with index + reason. Hub-stamp variants pass through structurally (Phase D wires hub verification).
- [ ] **B.1a.5** Tests: valid single-hop chain, valid multi-hop chain, unknown-signer stamp (rejected), wrong-key-for-known-signer (rejected), tampered chain (rejected). Ed25519 *cryptographic* verification is stubbed at this slice — the helper validates structural trust (principal exists, claims this NKey, we trust them). B.1c adds the bytes check.

### B.1b `BusPeerHarness` scaffold + wiring (was A.1.3)

Carries over from A.1.3 — the class that should have shipped in Phase A.

- [ ] **B.1b.1** `BusPeerHarness` implementing `SessionHarness` — publishes the inbound dispatch envelope onto the local bus, subscribes to the reply subject, streams replies back as `AsyncIterable<MyelinEnvelope>`. Pattern matches sage's existing peer behaviour.
- [ ] **B.1b.2** On every inbound envelope, calls `verifySignedByChain` (from B.1a) BEFORE handing to the consumer. Failed verification logs to stderr + rejects dispatch with structured reason; no dispatch event emitted to the application path.
- [ ] **B.1b.3** Tests: scaffold round-trips a valid envelope; invalid chain is rejected at the boundary; sage-pattern parity test.

### B.1c Ed25519 signature verification

- [ ] **B.1c.1** JCS canonicalization helper (per `myelin/src/identity/`) — input bytes for verification (and Phase B.3 signing).
- [ ] **B.1c.2** `verifySignedByChain` extended to do the ed25519 verify step (was stubbed at B.1a).
- [ ] **B.1c.3** Forged-signature regression test (tampered byte → fails crypto check, not just structural).

### B.2 ClaudeCodeHarness uses bus for bot↔bot calls

- [ ] **B.2.1** Replace "post in #cortex with @mention" pattern with `MyelinRuntime.publish()` for bot↔bot dispatch.
- [ ] **B.2.2** Discord adapter `mentionsAgent()` keeps working for human-to-bot DMs; bot↔bot path no longer consults Discord platform IDs.
- [ ] **B.2.3** cortex#98 `trustedAgentBots` stays as Discord-side fallback for human-to-bot DMs (per `cortex/docs/architecture.md` §9.3); bot↔bot path now uses NKey trust.

### B.3 Outbound envelope signing

- [ ] **B.3.1** `MyelinRuntime.publish()` signs every outbound envelope with the stack's NKey (loaded from `cortex.yaml.stack.nkey_pub` + sibling private key path).
- [ ] **B.3.2** Multi-hop envelopes (forwarded across stacks) append a new `signed_by[]` entry per hop, preserving the prior chain.
- [ ] **B.3.3** JCS canonicalization (per `myelin/src/identity/`) used for signature input.

### B.4 Tests

- [ ] **B.4.1** Round-trip test: agent A (principal alpha) emits a dispatch; agent B (principal beta) verifies the signature; B's reply chain stamps both stacks.
- [ ] **B.4.2** Forged-signature test: a tampered envelope is rejected by BusPeerHarness.
- [ ] **B.4.3** Cross-trust test: a stack not in the local trust registry is rejected.

### Phase B acceptance criteria

- BusPeerHarness verifies `signed_by[]` against TrustResolver on every inbound dispatch.
- ClaudeCodeHarness uses MyelinRuntime.publish for bot-bot calls.
- TrustResolver gains `trustsByNKey()` method.
- Round-trip bot↔bot test green with two stacks signing each other's envelopes.

### Phase B parallelism map

| Slice | Depends on | Can parallel with |
|---|---|---|
| **B.1a** verification primitives | Phase A (envelope chain parse) | Phase C design (paper-only RFCs); Phase A tail issues (#142, #143, #147, #148); cortex#97 observability |
| **B.1b** BusPeerHarness scaffold | B.1a primitives merged | B.3 outbound signing (B.3 only writes the publish side; doesn't touch the new harness file); Phase C design work |
| **B.1c** ed25519 + JCS verification | B.1a primitives merged | B.1b (different file surfaces — runtime vs registry); B.3 (shared JCS helper — coordinate one of them lands it first); Phase C design work |
| **B.2** ClaudeCodeHarness uses bus | B.1b scaffold merged | B.3 (different files); Phase C design work |
| **B.3** outbound signing | B.1a (Agent.nkey_pub) merged | B.1b, B.1c, B.2 (all touch different surfaces); Phase C design work |
| **B.4** round-trip + adversarial tests | B.1b + B.1c + B.2 + B.3 all merged | Phase C implementation kick-off if the principal-model RFC has landed |

**Single-developer ordering** (one PR in flight at a time): B.1a → B.1b → B.1c (or B.3 first if you want signing before crypto verify) → B.2 → B.3 (whichever didn't go first) → B.4.

**Two-developer ordering**: developer-A does B.1a → B.1b → B.2 → B.4; developer-B does B.3 → B.1c (joint JCS helper merge gate). Both wait on B.1a.

### Cross-phase parallelism during Phase B

Most of Phase C is paper until B.4 ships, but the paper can be drafted now:

| Activity | Surface | Independent of B implementation? |
|---|---|---|
| Phase C design — principal model spec | `docs/design-internet-of-agentic-work.md` §3.4 update | Yes — pure design |
| Phase C design — schema flip RFC | new design doc under `docs/` | Yes |
| Phase C design — PolicyEngine API contract | sketch in `docs/` | Yes |
| Phase C C.4 — audit envelope shape | piggybacks on cortex#97 (labelled `now`) | Yes — feeds C.4 when phase opens |
| Phase D — cloud-side network registry skeleton | separate repo (TBD: `network-registry`?) | Yes — fully external |
| Phase E — multi-link MyelinRuntime sketch | RFC + ADR | Yes |
| cortex#102 design PR finalisation | open design PR | Yes |
| cortex#107 design PR finalisation | open design PR | Yes — feeds Phase C |
| cortex#91 substrate harness design PR #92 | open | Yes — closes A.1's design track |
| Phase A tail follow-ups (#142, #143, #147, #148, #137, #136, #135, #150) | scattered small PRs | Yes |
| cortex#97 observability envelopes | independent feature | Yes — feeds Phase C.4 |

**Practical implication for a solo/small-team principal:** keep one Phase B PR in flight at a time (review cycle dominates), and use the wait windows to land Phase A tail PRs + draft Phase C design docs. Don't start Phase C implementation until B.4 is green — the principal model materially changes once `signed_by[].principal` is verifiable.

---

## 4. Phase C — Policy + schema flip (PolicyEngine at M6)

**Goal:** PolicyEngine is the single decision point for "what is this principal allowed to do?" — replacing per-surface duplication. cortex.yaml flips ONCE from per-adapter `roles[]` to top-level `policy:{ principals[], roles[] }`. The `stack:` block (Phase A) and the `capabilities:` block (Phase A) live alongside the new `policy:` block. **This is the only phase that flips the principal-facing config schema.**

**Issue:** `cortex#? — IAW Phase C: Policy + schema flip`.

**Estimated effort:** 2–3 weeks.

**Entry criteria:**

- Phase A complete (sovereignty consumable; PolicyEngine reads `envelope.sovereignty` as input).
- Phase B complete (NKey-signed envelopes; `signed_by[].principal` resolves against `policy.principals[]`).
- Q6 lock-in confirmed (audit ownership) — DONE 2026-05-13.
- Q7 lock-in confirmed (stack-aware namespace) — DONE 2026-05-13. Phase C is the last natural moment to absorb the stack-aware namespace into cortex.yaml's principal model without re-flipping later.

### C.1 PolicyEngine module — DONE (cortex#218)

- [x] **C.1.1** Create `src/common/policy/` directory. — cortex#218
- [x] **C.1.2** `PolicyEngine.check(principalId, intent) → { allow, capabilities } | { allow: false, reason }` API. (Note: takes `principalId: string`, not a Principal object — Echo cortex#218 round 1 closed the spoofing footgun.) — cortex#218
- [x] **C.1.3** Inputs: a `Principal { id, home_operator, home_stack, role[], trust[] }`; an `Intent { capability, sovereignty, payload_summary }`. — cortex#218
- [x] **C.1.4** Decision logic: principal's role grants → effective capabilities; sovereignty fields surfaced on `intent` for C.4 carry-through (sovereignty enforcement deferred to Phase D per design). — cortex#218
- [x] **C.1.5** Audit emission: implemented in C.4 (cortex#221), not C.1 — engine is pure, audit envelopes emitted by the dispatch-listener with the engine's structured decision.

### C.2 cortex.yaml schema flip — C.2a DONE (cortex#219); C.2b/C.2c ratified, execution NEXT

**Status as of 2026-05-16:** Design ratified in [PR #291](https://github.com/the-metafactory/cortex/pull/291). See [`docs/design-policy-cutover.md`](./design-policy-cutover.md) for the locked schema + 5-PR sequence and [`docs/iteration-policy-cutover.md`](./iteration-policy-cutover.md) for the principal-facing iteration checklist.

- [x] **C.2.1 (additive — C.2a)** Top-level `policy: { principals[], roles[] }` added; schema cross-refines uniqueness + role/trust referential integrity. Legacy per-adapter `roles[]` retained for backward compatibility. — cortex#219
- [ ] **C.2.1.b (breaking — C.2b)** Per-adapter `roles[]` removed from `DiscordPresenceSchema` + `MattermostPresenceSchema` + `SlackPresenceSchema`; adapter role-resolver retired; v2.0.0 bump. — cortex#242 umbrella (split into 242a parallel-mode + 242b breaking removal per design §9).
- [ ] **C.2.2** `policy.principals[]` schema extended — adds `platform_ids` (open record), `session_config: {default, dm?}`, multi-stack `(id, home_stack)` uniqueness scoping. Capability namespace adopted: `keyword.{chat,async,team}`, `tool.<name>`, `dispatch.<agent>`, `operator`, `<domain>.<entity>`. — cortex#243a (schema extension)
- [ ] **C.2.3** Discord/Mattermost/Slack adapters call `PolicyEngine.check()` directly; role-resolver retired. Wired in parallel mode first (most-restrictive intersection), then exclusive at v2.0.0. — cortex#242a → cortex#242b
- [ ] **C.2.4 (C.2c)** `migrate-config` CLI extension: lift legacy per-adapter `roles[]` into top-level `policy:`. Idempotent, with `--check` mode for the 242a principal pre-flight. Canonical tool inventory via cortex#243b. SOP + migration examples. — cortex#243c

### C.3 Integration with substrate harness — DONE (cortex#220)

- [x] **C.3.1** Dispatch-listener calls `PolicyEngine.check()` before invoking `SessionHarness.dispatch()`. Gated behind `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK=1` env var (Echo cortex#220 round 1 — pre-Phase-B authorization-without-authentication acknowledgement). — cortex#220
- [x] **C.3.2** `DispatchRequest.principal?: Principal` added to substrate contract. Forwarded as `undefined` today; C.3b will thread the resolved Principal through. — cortex#220
- [x] **C.3.3** Sovereignty fields flow envelope → Intent.sovereignty → engine.check verbatim. — cortex#220

### C.4 Audit envelopes (cortex#97 tie-in) — DONE (cortex#221)

- [x] **C.4.1** Dispatch-listener emits `system.access.allowed` for every accepted dispatch with principal_id, capability, capabilities, intent_sovereignty, envelope_id/subject, signed_by[]. — cortex#221
- [x] **C.4.2** Dispatch-listener emits `system.access.denied` for every rejected dispatch with structured `SystemAccessDeniedReason` ({ kind, ...variant_fields }). — cortex#221
- [x] **C.4.3** Audit envelopes carry `signed_by[]` from the originating event verbatim (multi-stamp chain preserved — ed25519 + hub-stamp). — cortex#221

### C.5 Tests + migration

- [x] **C.5.1** PolicyEngine unit tests cover allow/deny matrix (engine.test.ts + factory.test.ts in C.1/C.2a). — cortex#218, cortex#219
- [ ] **C.5.2** Migration-fidelity test: a representative `cortex.yaml` flips to `policy:`-only with `migrate-config`; round-trip identity (same auth decisions). — lands with cortex#243c.
- [x] **C.5.3** Integration test: end-to-end inbound `dispatch.task.received` → dispatch-listener → PolicyEngine → harness → lifecycle envelopes + audit envelopes asserted. Implemented as 29 listener tests in `src/runner/__tests__/dispatch-listener.test.ts` exercising allow/deny paths, signed_by single + multi-stamp, sovereignty flow, audit payload shape, double-emit ordering on deny. (Note: Discord adapter still uses the legacy role-resolver path; full adapter→engine wiring lands with C.2b.) — cortex#220, cortex#221

### Phase C acceptance criteria

- [x] `src/common/policy/` module exists with `PolicyEngine.check()`. — cortex#218
- [ ] Discord/Mattermost/Slack adapters call `PolicyEngine.check()` directly; role-resolver retired. — cortex#242a (parallel) → cortex#242b (exclusive)
- [x] cortex.yaml schema has `policy: { principals[], roles[] }` at top level (additive). — cortex#219
- [ ] Per-adapter `roles[]` removed. — cortex#242b
- [ ] `migrate-config` CLI lifts existing per-surface roles into top-level `policy:`. — cortex#243c
- [x] `system.access.{allowed,denied}` envelopes emitted by dispatch-listener (with engine decision). — cortex#221
- cortex.yaml schema migration is one-way (post-flip, no rollback in v1). — C.2b breaking change pending.

**Phase C closeout status (2026-05-15):**

Phase C primary objective — *PolicyEngine as the single AAA decision point with audit envelopes* — is **DONE** (C.1 + C.2a + C.3 + C.4 + C.5.1 + C.5.3 all merged). What ships as Phase C of IAW closes cortex#115.

**v2.0.0 cleanup (C.2b/C.2c/C.5.2) — ratified, execution NEXT.** The breaking removal of per-adapter `roles[]`, adapter role-resolver retirement, `migrate-config` CLI extension, and migration-fidelity round-trip test have a ratified design in [PR #291](https://github.com/the-metafactory/cortex/pull/291) and a 5-PR iteration plan in [`docs/iteration-policy-cutover.md`](./iteration-policy-cutover.md). The 5 sub-issues (cortex#243a/b/c, cortex#242a/b) execute in the dependency order documented there.

Pre-Phase-B caveat (Echo cortex#220 round 1): the dispatch-listener policy gate authorises on an unverified `signed_by[0].principal` claim until cortex#114 (Phase B verification) wires the verifier into the envelope-validator. The gate is `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK=1` opt-in until that closes.

**Critical insight (from design doc §6):** This is the ONLY phase where the principal-facing config schema changes. Sequencing Phases A and B before Phase C means the flip happens once. Q7 lock-in is absorbed here — the stack-aware namespace already lands at Phase A as a structurally additive `stack:` block; Phase C's `policy.principals[]` carries `home_operator` + `home_stack` (field names tracked for rename under cortex#448) so the principal table is stack-aware from the moment the flip happens.

---

## 5. Phase D — Federation (multi-principal + cloud-side registry)

**Goal:** Multi-principal federation operable. `policy.federated.peers[]` (within `policy.federated.networks[]` per Q4 lock-in) declares peer principals + their pubkeys. Surface-router gates inbound `federated.*` envelopes by per-peer policy. Cloud-side network registry service hosts the canonical pubkey directory (per Q3 lock-in). cortex#107 Step H multi-principal dashboard consumes it.

**Issue:** `cortex#? — IAW Phase D: Federation`.

**Estimated effort:** 3–4 weeks.

**Entry criteria:**

- Phase C complete (PolicyEngine exists; principals carry `home_operator` + `home_stack` — field names tracked for rename under cortex#448).
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

- [x] **D.2.1** Surface-router extends `adapterMatches()` to gate inbound `federated.*` envelopes against the originating network's `accept_subjects` / `deny_subjects` lists.
- [x] **D.2.2** Match-failure emits `system.access.denied` with reason `peer_deny_list` or `peer_not_in_accept_list`.
- [x] **D.2.3** Hop counting: `signed_by[].length` vs. `max_hop` — over-budget envelopes rejected with `max_hop_exceeded`.

### D.3 PolicyEngine extends for per-peer slicing

- [ ] **D.3.1** PolicyEngine takes the source network as part of `Intent`; resolves the principal's home network → applies per-network policy slice.
- [ ] **D.3.2** Audit envelopes include the source network in the structured reason.

### D.4 Cloud-side network registry service

- [x] **D.4.1** New service alongside `grove-api` (renamed to `cortex-api` post-MIG-7); hosted at `network.meta-factory.ai` or similar. Hono REST API. — `src/services/network-registry/` (this PR).
- [x] **D.4.2** Endpoints (route literals `/operators/{operator_id}` carry the API path; tracked for rename under cortex#448):
  - `POST /operators/{operator_id}/register` — the principal publishes their operator-account NKey + stack identities + capability declaration (signed assertion).
  - `GET /operators/{operator_id}` — peers query the principal's current pubkey + stack list.
  - `GET /networks/{network_id}/roster` — query who's in this network.
  - `GET /capabilities?query=...` — capability search across networks.
- [ ] **D.4.3** Cortex consults the registry at startup + on schedule to refresh peer pubkeys; in-memory cache invalidated on principal-publish events. — consumer side (cortex-side `RegistryClient`) is a separate follow-up; this PR ships the producer surface.
- [x] **D.4.4** Registry signs assertions; cortex verifies before trusting. — registry-side signing landed; cortex-side verification lands with D.4.3 consumer.

### D.5 Cloud dashboard multi-principal slicing (cortex#107 Step H)

- [ ] **D.5.1** The existing dashboard subscribes to `local.{operator}.{stack}.>` (subject literal); the cloud variant subscribes to `federated.>` cross-principal (within accept-listed networks).
- [ ] **D.5.2** Per-principal slicing keyed off `principal.home_operator` (field name tracked for rename under cortex#448) for filtering dashboard cards.
- [ ] **D.5.3** UI surfaces sovereignty + classification on every card (G-1110 work).

### D.6 Tests + cross-principal integration

- [ ] **D.6.1** Two-principal integration test: principal alpha emits `federated.research-collab.tasks.code-review.typescript`; principal beta picks it up via queue-group; beta's stack signs the reply; alpha verifies the chain. Both principals' audits show their respective stamps.
- [ ] **D.6.2** Registry test: principal alpha registers; principal beta queries; beta's cortex refreshes its peer pubkey cache.
- [ ] **D.6.3** Deny-list test: an attempted inbound envelope on a `deny_subjects` pattern is rejected with the correct reason.

### Phase D acceptance criteria

- `policy.federated.networks[]` schema landed.
- Surface-router gates inbound `federated.*` envelopes by per-peer accept rules.
- PolicyEngine supports per-network slicing.
- A second principal (jcfischer or test rig) successfully federates a task; envelope chain verifiable on both sides.
- Cloud dashboard slices per principal using `home_operator` (field name tracked for rename under cortex#448).
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

- [ ] **E.3.1** Orchestrator agent reference implementation: an assistant + its hosting agent runtime that reads the network capability registry, picks a target network/stack for an inbound task, emits a `federated.{network}.tasks.{capability}` envelope.
- [ ] **E.3.2** Reply correlation: the orchestrator waits for the chain-of-stamps reply via the per-link queue group; binds reply to the original inbound request via envelope ID.
- [ ] **E.3.3** Failure handling: if no peer in the target network claims within timeout, fall back to a sibling network or emit `dispatch.task.failed`.
- [ ] **E.3.4** Test rig: orchestrator agent on principal alpha delegates a TypeScript code-review task to principal beta's `code-review.typescript` capability; receives reply; threads through to original sender.

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
- Operator-vision script's "bridge stack" pattern operable. *(Operator vision = the reference label for the cortex#110 North-Star narrative; preserved, not the human-actor sense.)*
- Orchestrator agent reference implementation delegates across networks via chain-of-stamps.
- Mesh varieties documented; private + isolated-private operable; public deferred.

---

## 7. Sub-issues + PR conventions

### 7.1 Sub-issue structure

Each phase has one tracking issue in `the-metafactory/cortex`, child of cortex#110:

- `cortex#? — IAW Phase A: Foundation — substrate harness + visibility consumption`
- `cortex#? — IAW Phase B: Identity — NKey-signed bot↔bot`
- `cortex#? — IAW Phase C: Policy + schema flip — PolicyEngine at M6`
- `cortex#? — IAW Phase D: Federation — multi-principal peer registry + cloud registry service`
- `cortex#? — IAW Phase E: Multi-network bridges + delegation`
- `cortex#? — IAW Config split (CFG) — multi-file config composer + system.yaml + surfaces.yaml` *(new, §13; under cortex#110)*
- `cortex#? — IAW Shared surface gateway (GW) — one assistant, many deployments` *(new, §13; under cortex#110)*

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
- Cross-principal scenarios (Phase D+) have at minimum a two-stack integration test in a local test rig.

---

## 8. Cross-references

### 8.1 Issues + PRs

- **cortex#110** — META (principal-facing Internet of Agentic Work umbrella).
- **cortex#112** — design synthesis doc PR (this PR's sibling).
- **cortex#91** — substrate harness (consumed in Phase A; SessionHarness interface).
- **cortex#102** — bot↔bot via bus envelopes (consumed in Phase B; chain-of-stamps verification).
- **cortex#107** — principal-based AAA (consumed in Phase C; PolicyEngine + cortex.yaml flip + Step H multi-principal dashboard in Phase D).
- **cortex#109** — envelope-visibility composition (consumed in Phase A §A.2/§A.3/§A.4 + Phase D §D.1/§D.2).
- **cortex#113** — IAW Phase A: Foundation (I-101).
- **cortex#114** — IAW Phase B: Identity (I-102).
- **cortex#115** — IAW Phase C: Policy + schema flip (I-103).
- **cortex#116** — IAW Phase D: Federation (I-104).
- **cortex#117** — IAW Phase E: Multi-network bridges + delegation (I-105).
- **cortex#? — IAW CFG: Config split (I-106)** — new epic, §13.1; child of cortex#110. FOUNDATION; lands before/with GW.
- **cortex#? — IAW GW: Shared surface gateway (I-107)** — new epic, §13.2; child of cortex#110. Depends on CFG.c (`surfaces.yaml`).

### 8.2 Blueprint

- **I-100** — Internet of Agentic Work META (umbrella).
- **I-101** — IAW Phase A: Foundation.
- **I-102** — IAW Phase B: Identity.
- **I-103** — IAW Phase C: Policy + schema flip.
- **I-104** — IAW Phase D: Federation.
- **I-105** — IAW Phase E: Multi-network bridges + delegation.
- **I-106** — IAW CFG: Config split (FOUNDATION; §13.1).
- **I-107** — IAW GW: Shared surface gateway (depends on I-106 CFG.c; §13.2).

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
- **Backward compatibility for existing deployments.** Default `{operator_id}/default` works in theory; need to verify the default-derivation produces identical subjects to today (currently `local.andreas.>` → should become `local.andreas.default.>` after Phase A.5 lands, with rewrite invisible to principals). Test rig.

### 9.2 Phase B reconcile with cortex#92

- **Cross-reference Q5 (queue groups) with cortex#92 Q5.** cortex#91 substrate harness design PR has its own Q5 — verify both Q5s converge on queue groups; if cortex#92 lands a different competing-consumer model for in-process dispatch, flag as inconsistency.

### 9.3 Phase C schema-flip surface area

- **`migrate-config` CLI changes.** cortex.yaml grew a `stack:` block in Phase A and a `capabilities:` block in Phase A; Phase C flips `roles[]` to `policy:`. The CLI needs to handle a multi-stage migration: a principal might be at Phase A schema (stack + capabilities, no policy) or Phase C schema (full flipped). Lean: idempotent re-runs — running migrate-config on already-flipped config is a no-op.
- **Audit-envelope subject form.** Phase C emits `system.access.{allowed,denied}` on the stack-aware subject (`local.{operator}.{stack}.system.access.*`). Verify renderer subscriptions still match (renderer's `subjects:` pattern needs to include the new stack segment).

### 9.4 Phase D registry service ownership

- **Cloud-side network registry — single service or per-network?** Recommendation: single global service (similar to DNS root + zone delegation) — principals register globally; networks are membership lists computed by the registry. Per-network instances could federate but adds complexity. Lean: single global registry alongside the cloud dashboard service; revisit if multi-region or compliance demands surface.
- **Signed assertion format.** Registry assertions need to be verifiable independently of the registry's availability (principal A queries registry, registry returns principal B's pubkey signed by principal B's operator-account NKey + countersigned by registry). Use JCS canonicalisation for signature input; reuse the chain-of-stamps signing infrastructure from Phase B where possible.

### 9.5 Phase E multi-network MyelinRuntime refactor

- **Single daemon vs. per-stack daemon.** Q7's "Phase E design decision" — does one cortex daemon host multiple stacks, or does each stack get its own daemon? Tradeoff: single daemon has lower process count + cross-stack visibility but more complex isolation; per-stack daemon has cleaner blast-radius but more process overhead + cross-stack IPC. Lean: single-daemon for v1 (a principal typically has one or two stacks), per-stack daemon as a future option if isolation guarantees become load-bearing.
- **Subject namespace within a multi-stack daemon.** If one daemon hosts `andreas/research` + `andreas/production`, do their subjects share a process-wide NatsLink (publish-side namespaced by stack segment) or separate links? Lean: shared link with subject-segment isolation (saves NATS connections); rejected if test rig finds cross-stack subject leakage.

### 9.6 Orchestrator agent pattern (§3.6) design follow-ons

- **Capability matching algorithm.** Orchestrator reads network capability registry; how does it pick between two networks that both offer `code-review.typescript`? Options: (a) principal-declared preference list; (b) cost-aware (Q2 optional `cost` field); (c) load-aware (queue depth as proxy). Lean: (a) for v1 (deterministic), (b)/(c) future.
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
- [ ] cortex.yaml schema has flipped exactly ONCE (at Phase C). Principal-edit history shows one schema migration, not multiple.
- [ ] Cloud-side network registry service deployed at `network.meta-factory.ai` (or equivalent) — principals register their stacks, peers query the registry, signature chain verified.
- [ ] Mesh varieties documented and at least one example of each operable: private (single stack, no federation), federated (≥2 principals), isolated-private (JV, multi-peer single-network), bridge (one stack in N networks).
- [ ] Substrate harness landed — at least 2 distinct harness implementations (`ClaudeCodeHarness` + `BusPeerHarness`) operate behind the same interface.
- [ ] Chain-of-stamps `signed_by[]` verified on every inbound federated dispatch; forged/tampered envelopes provably rejected.
- [ ] PolicyEngine at M6 is the single AAA decision point; Discord + Mattermost adapters at ~30 LOC each (translate event → Principal; no role-resolver in adapter).
- [ ] All audit traffic remains principal-partitioned per Q6 lock-in; no central audit service exists; chain-of-stamps provides cross-principal correlation.
- [ ] cortex#110 META closes; the Operator-vision video story is operable in production.

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
- Phase C bump: `v2.0.0` (MAJOR — cortex.yaml schema flip is a breaking change for principals).
- Phase D bump: `v2.X.0` (minor — additive: federation primitives).
- Phase E bump: `v2.X+1.0` (minor — additive: multi-network + delegation).

Phase C is the one major version bump in the IAW work. Principals get a one-shot `migrate-config` CLI to flip from `v1.X` to `v2.0`.

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
- `cortex/src/common/agents/trust-resolver.ts:268-491` — principal-signature verification (Phase B extends with `trustsByNKey`). *(Code symbol still named for "operator"; rename tracked under cortex#448.)*
- `cortex/src/common/types/cortex-config.ts:85-111` — `OperatorSchema` (code type name; rename tracked under cortex#448; Phase A.5 adds `stack:` block).
- `cortex/src/common/types/cortex-config.ts:447-491` — `NatsConfigSchema` (Phase A.5 ties stack NKey to existing credsAuthenticator).

### 12.5 Compass SOPs

- `compass/sops/dev-pipeline.md`
- `compass/sops/worktree-discipline.md`
- `compass/sops/pr-review.md`
- `compass/sops/versioning.md`
- `compass/sops/retrospective-and-process-mining.md`

### 12.6 Operator vision

*("Operator vision" is the preserved North-Star reference label for the cortex#110 narrative — not the human-actor sense; the human is the **principal**.)*

- "Internet of Agentic Work" video script (2026-05-13, in cortex#110 body) — the principal-facing mental model. Used as North Star; not replicated here.

---

## 13. New epics — config split + shared surface gateway

Two epics added under the cortex#110 META umbrella, alongside the A→E federation ladder. They are **not** federation phases; they are surface/config foundations the federation work and day-to-day multi-deployment operation both lean on. They follow the same §7 sub-issue + PR conventions (one sub-issue = one PR-sized slice; PR title `feat(cortex): I-NNN.X — {scope} (IAW {CFG|GW}.Y)`; pilot-loop with Echo as primary reviewer; test discipline per §7.4).

**Sequencing:** **CFG (config split) is the foundation and lands first** — it is the lowest-risk slice and directly de-risks the double-message problem by isolating the `nats.subjects` landmine and pulling per-platform surface bindings out of per-stack config. **GW (shared surface gateway) builds on CFG** — specifically on the `surfaces.yaml` file CFG introduces. CFG should land before or alongside the gateway; GW.a depends on CFG.c.

Neither epic flips the principal-facing schema in a breaking way: CFG ships a transitional single-file fallback so existing single-file `cortex.yaml` deployments keep loading unchanged, and `LoadedConfig` (the in-memory shape the rest of cortex consumes) is unchanged across CFG. GW is additive plus one envelope field bump (`response_routing.instance`).

### 13.1 EPIC CFG — Config split (FOUNDATION)

**Goal:** Decompose the monolithic single-file `cortex.yaml` into a composed multi-file layout (`system/`, `network/`, `surfaces/`, `stacks/*`) without changing `LoadedConfig` or any consumer. Isolating `system.yaml` (and the `nats.subjects` block in particular) removes the largest footgun behind the double-message problem, and moving surface bindings into `surfaces.yaml` is the precondition for the shared surface gateway.

**Issue:** `cortex#? — IAW CFG: Config split (multi-file composer + system.yaml + surfaces.yaml)` (child of cortex#110).

**Estimated effort:** 1–2 weeks.

**Entry criteria:**
- No federation-phase dependency: CFG can land in parallel with Phase A/B.
- Current single-file `cortex.yaml` schema is the baseline; CFG preserves it as the transitional fallback.

#### CFG.a Multi-file config composer + transitional single-file fallback

- [ ] **CFG.a.1** Config loader composes a `LoadedConfig` from a directory layout (`system/`, `network/`, `surfaces/`, `stacks/*`) — deep-merge with documented precedence; `LoadedConfig` shape is **unchanged** (consumers untouched).
- [ ] **CFG.a.2** Transitional single-file fallback: if the directory layout is absent, load the existing single-file `cortex.yaml` and produce the identical `LoadedConfig`. No principal-facing break.
- [ ] **CFG.a.3** Composition is deterministic and idempotent; a documented file-not-found / both-present resolution order (directory layout wins; single-file fallback only when no layout present).
- [ ] **CFG.a.4** Tests: directory layout composes to the same `LoadedConfig` as the equivalent single file (round-trip identity); single-file fallback path produces an identical `LoadedConfig`; precedence/merge-order tests.

#### CFG.b Extract `system.yaml` (isolate the `nats.subjects` landmine)

- [x] **CFG.b.1** Move the cross-cutting machine config — `claude`, `execution`, `attachments`, `paths`, `nats`, `bus` — into `system/system.yaml`. The composer folds it into the same `LoadedConfig` slots. — #523: composer base layer already merges these slots (CFG.a); CFG.b adds the documented reference layout `docs/config-layout/system/system.yaml` (+ `stacks/research.yaml` + README) proving the substrate blocks fold in unchanged. `LoadedConfig` shape untouched.
- [x] **CFG.b.2** `nats.subjects` is isolated in `system.yaml` as its own clearly-commented block — the single place subject overrides live, removing the per-stack duplication that drives the double-message problem. — #523: prominently documented in the reference `system.yaml` + `docs/config-layout/README.md`.
- [x] **CFG.b.3** Tests: a config with `system.yaml` present resolves `nats`/`bus`/`paths` identically to the pre-split single file; a malformed `nats.subjects` block fails loudly at load (not silently double-publishing). — #523: `src/common/types/nats-subjects.ts` (shared `NatsSubjectsSchema` — rejects malformed patterns AND duplicate entries loudly; mirrored onto both `NatsConfigSchema` and legacy `AgentConfigSchema`); tests in `src/common/config/__tests__/system-layer.test.ts` + `src/common/types/__tests__/nats-subjects.test.ts`.

#### CFG.c Move surface bindings out of per-stack `agents.presence` into `surfaces.yaml`

- [ ] **CFG.c.1** Surface bindings (Discord/Mattermost/Slack `token`, `guild`, channel/instance bindings) move from each stack's `agents.presence` block into a top-level `surfaces.yaml`.
- [ ] **CFG.c.2** `LoadedConfig` still exposes the same effective presence/binding view to today's consumers (per-stack adapters keep working); the move is a source-layout change, not a runtime-shape change.
- [ ] **CFG.c.3** `surfaces.yaml` is the file the shared surface gateway (GW) consumes — this slice is the GW precondition.
- [ ] **CFG.c.4** Tests: per-stack adapter behaviour unchanged after the move (same tokens/guilds resolved); `surfaces.yaml` schema validates required binding fields.

#### EPIC CFG acceptance criteria

- [ ] Multi-file directory layout composes to a `LoadedConfig` identical to the equivalent single file.
- [ ] Single-file `cortex.yaml` still loads via the transitional fallback (no principal-facing break).
- [ ] `system.yaml` exists with `claude`/`execution`/`attachments`/`paths`/`nats`/`bus`; `nats.subjects` isolated in one place.
- [ ] Surface bindings live in `surfaces.yaml`, out of per-stack `agents.presence`; per-stack adapters unchanged at runtime.
- [ ] `LoadedConfig` shape unchanged across the whole epic; no consumer edits required.

### 13.2 EPIC GW — Shared surface gateway (one assistant, many deployments)

**Goal:** One platform connection per bot, shared across many stack deployments. A gateway process holds the single Discord/Slack/Mattermost connection, routes inbound platform messages to the right stack (`{instance → stack}`), and renders each stack's outbound lifecycle envelopes back to the right platform instance. Stacks stop owning per-platform adapters and become **surface-bus-only**: they publish/consume dispatch + lifecycle envelopes on the bus, and the gateway is the sole dispatch source/sink at the platform edge.

**Issue:** `cortex#? — IAW GW: Shared surface gateway (one assistant, many deployments)` (child of cortex#110).

**Estimated effort:** 3–4 weeks.

**Entry criteria:**
- **CFG.c complete** — `surfaces.yaml` is the binding source the gateway reads. GW.a depends on it.
- Phase A complete (sovereignty-typed envelopes; surface-router visibility filter) — the gateway is a dispatch source/sink and signs/consumes per the same envelope contract.

#### GW.a Gateway process: one connection per bot + `{instance → stack}` routing + inbound publish per stack

- [ ] **GW.a.1** Gateway process holds exactly **one** platform connection per bot identity (reads bindings from `surfaces.yaml`), replacing N per-stack connections.
- [ ] **GW.a.2** `{instance → stack}` routing table: an inbound platform message on a bound instance resolves to its target stack; the gateway publishes a canonical inbound dispatch envelope **on that stack's subject namespace** (per the stack's `{principal}.{stack}` segment), as a dispatch source.
- [ ] **GW.a.3** Inbound attribution: gateway populates `originator.identity` (resolved DID) + `originator.attribution = "adapter-resolved"`; the target stack signs via `runtime.publish` (stack is the cryptographic signer — per CONTEXT.md own-stack trust model).
- [ ] **GW.a.4** Tests: two stacks bound to one bot; a message on instance A publishes on stack A's subject only (no cross-stack leak); inbound envelope carries the right `originator` + scope.

#### GW.b Outbound render to the right instance + `response_routing.instance` schema bump

- [ ] **GW.b.1** Gateway is a dispatch sink: subscribes to `dispatch.task.{started|completed|failed|aborted}` across bound stacks and renders each to the correct platform instance.
- [ ] **GW.b.2** `response_routing` payload field gains an `instance` member so a stack's outbound lifecycle envelope tells the gateway which platform instance to deliver to (echoed by the runner onto every lifecycle envelope per CONTEXT.md response-routing model). Additive schema bump; backward-compatible default for un-bumped envelopes.
- [ ] **GW.b.3** Tests: a `completed` envelope with `response_routing.instance = A` renders to instance A only; missing `instance` falls back to the legacy single-instance behaviour.

#### GW.c Discord resolver

- [ ] **GW.c.1** Discord resolver: maps the gateway's single Discord connection ↔ `{instance → stack}` bindings from `surfaces.yaml`; resolves channel/thread/guild to a stack and back.
- [ ] **GW.c.2** Tests: inbound Discord message resolves to the right stack; outbound renders to the right channel/thread.

#### GW.d Slack resolver

- [ ] **GW.d.1** Slack resolver: same contract as the Discord resolver against Slack's connection model (workspace/channel ↔ stack).
- [ ] **GW.d.2** Tests: inbound/outbound round-trip for two stacks bound to one Slack app.

#### GW.e Mattermost resolver

- [ ] **GW.e.1** Mattermost resolver: same contract against Mattermost's connection model (team/channel ↔ stack).
- [ ] **GW.e.2** Tests: inbound/outbound round-trip for two stacks bound to one Mattermost bot.

#### GW.f Retire per-stack Discord adapters (stacks go surface-bus-only)

- [ ] **GW.f.1** Remove the per-stack Discord adapter wiring; stacks no longer open platform connections — they publish/consume dispatch + lifecycle envelopes on the bus only.
- [ ] **GW.f.2** The gateway is the sole platform-edge dispatch source/sink; surface-router visibility filtering (Phase A.4) still applies at the gateway.
- [ ] **GW.f.3** Tests: a stack with no per-platform adapter still completes an end-to-end chat dispatch through the gateway; regression test that no stack opens a direct platform connection.

#### EPIC GW acceptance criteria

- [ ] One platform connection per bot, shared across ≥2 stacks (Discord proven; Slack + Mattermost resolvers landed).
- [ ] Inbound platform messages route to the correct stack via `{instance → stack}`; no cross-stack leakage.
- [ ] Outbound lifecycle envelopes render to the correct instance via `response_routing.instance`.
- [ ] Per-stack Discord adapters retired; stacks are surface-bus-only.
- [ ] Gateway honours Phase A.4 visibility filtering and the CONTEXT.md dispatch-source/sink + own-stack-trust model.
- [ ] Built on CFG `surfaces.yaml`; no regression to single-file fallback deployments.

---

*Originating discussion: Andreas's 2026-05-13 verbatim lock-ins on Q1–Q7 + the "delegation pattern" framing (§3.6 new addition). This plan converts those decisions into a five-phase implementation roadmap with checkbox-driven task lists, mirroring the shape of `plan-cortex-migration.md`. Sequenced to flip the principal-facing schema exactly once (Phase C), with the stack-aware namespace landing structurally additively in Phase A and absorbed into the principal model at Phase C.*
