# Design — Substrate-tied rate limiting for the cortex/myelin dispatch fabric

**Issue:** AzDO #3169 ("R26: Rate limiting in the cortex/myelin dispatch layer — shared, all surfaces")
**Status:** SIGNED OFF (Andreas, 2026-07-02) — Design B accepted. Phase-1 implementation: cortex#1371; contract spec: myelin#195 (`myelin/specs/admission.md`); phase-3 transport migration tracked as cortex#1369.
**Author:** Fable (distributed-systems design pass, 2026-07-02)

> **§6 open questions — resolved at sign-off:**
> **Q1** degrade to node-local approximate buckets + loud `system.*` event; anonymous/public (`PUBLIC_ORIGINATOR_DID`) FAILS CLOSED.
> **Q2** ship tiers 1–2 only (stack ceiling + per-principal, role-derived with per-principal override); tiers 3–4 deferred.
> **Q3** config lives in `policy.admission` (§4.1 schema), Zod-validated, reusing the `offering.ts` vocabulary; absent block ⇒ limiter fully inert (CO-4).
> **Q4** R26 ships phases 1–2; the JetStream work-queue migration (phase 3a) stays a separate issue — cortex#1369.
> **Q5** the admission contract is a myelin spec NOW (`specs/admission.md`, myelin#195), cortex the first implementation.
> **Q6** reject-fast confirmed: interactive → terminal `not_now` + retry hint with a friendly renderer string; queued → `nak(retry_after_ms)`; never `term` for rate.

---

## 0. Requirements (as stated)

1. Rate limiting **tied to the substrate** — the myelin/NATS dispatch fabric — not a
   per-surface add-on. It must protect *every* surface that dispatches to agents
   (Discord, web:amt, gh-webhook, dashboard, bus peers, future surfaces).
2. Designed against the **spawn mechanism** (how cortex actually launches agent runs),
   with a **future-state outlook**.
3. Must survive **horizontal scale** — multiple cortex nodes/instances. A naive
   per-principal in-memory token bucket does not coordinate across nodes and is
   disqualified.

---

## 1. How dispatch/spawn works today (evidence)

### 1.1 Every surface funnels into one envelope grammar

All dispatch sources — platform adapters (Discord/Mattermost/Slack), the shared surface
gateway (which carries the web surfaces, including `web:amt`), taps, dashboards, and
assistant runtimes — converge on **one canonical publisher**:

- `publishInboundChatDispatchEnvelope` is "the shared envelope/subject construction"
  for every inbound action that becomes a `tasks.@{assistant}.{capability}` envelope
  (`src/bus/dispatch-source-publisher.ts:11-19`; envelope `type: "tasks.chat"` at `:296`).
- The web surface is a gateway binding (`web:` adapter, C-110 —
  `src/gateway/gateway-adapters.ts:213-221`; instance id `web:{binding.instanceId}` at
  `:334`). The gateway's `BusInboundSink` "delegates to
  `publishInboundChatDispatchEnvelope` — the same canonical dispatch-source publisher
  the per-stack dispatch-handler uses" (`src/gateway/bus-inbound-sink.ts:1-16`).
- Subjects come from myelin's grammar: `directTaskSubject(principal, did, stack)` →
  `local.{principal}.{stack}.tasks.@{encoded-did}.>`
  (`myelin/src/subjects.ts:248-256`), e.g. `local.andreas.work.tasks.@did-mf-pylon.chat`.

**Consequence:** the bus subject space *is* the substrate choke point. A limiter that
gates envelope → spawn covers Discord, web:amt, and every future surface with zero
per-surface code. This satisfies requirement 1 structurally.

### 1.2 The spawn path (chat / direct dispatch)

The runner's dispatch listener "consumes inbound dispatchable task envelopes directly
from the MyelinRuntime and **spawns a substrate harness per dispatch**"
(`src/runner/dispatch-listener.ts:1-4`). The pipeline inside `handleDispatchEnvelope`
(`:1344`) is strictly ordered:

1. **Chain verification** — `verifySignedByChain` (`:1445-1541`).
2. **Re-sign on ingest** — gateway-injected envelopes arrive unsigned +
   `originator`-stamped; the stack re-stamps them (`:1543-1594`).
3. **Policy gate** — `PolicyEngine.check(principal, intent)`, "the single authorization
   decision point for cortex" (`src/common/policy/engine.ts:4-13`); deny short-circuits
   with `system.access.denied` + terminal `dispatch.task.failed`
   (`dispatch-listener.ts:1783-1893`). Fail-closed when the engine is uninitialised
   (`:1746-1781`).
4. **Harness spawn** — a fresh `ClaudeCodeHarness` (or `AgentTeamHarness` for
   `distribution_mode === "delegate"`) per dispatch (`:1950-1959`), which ultimately
   runs `Bun.spawn(["claude", ...args])` (`src/runner/cc-session.ts:291`). Lifecycle
   envelopes (`dispatch.task.started/completed/failed/aborted`) are drained back onto
   the bus, at least one terminal envelope guaranteed (`:38-46`, `:1991-2000`).

**There is no rate or admission check anywhere on this path.** The natural hook is
between step 3 and step 4 — exactly where the policy gate already sits and where the
refusal machinery already exists.

### 1.3 The offer/queue paths (code-review, dev.implement, release)

Offered capabilities ride **JetStream**: durable pull consumers bound via
`js.consumers.get(stream, durable)` (`src/bus/myelin/subscriber.ts:402`), streams and
durables provisioned idempotently at boot (`src/bus/jetstream/provision.ts:176-234`,
Interest retention at `:223`, `ack_wait` 20 min at `:169`, `max_deliver` 5 at `:161`).
Notably, "dev + prod instances on the same principal share competing-consumer semantics
and a daemon restart resumes from the same JetStream offset" (`src/cortex.ts:1549-1552`)
— the substrate already exploits shared durables for multi-instance coordination.

These consumers each carry an **in-process concurrency gate**:
`if (this.inFlight.size >= this.maxConcurrent)` → publish `dispatch.task.failed
{kind:"not_now", retry_after_ms}` → `nak(delay)` (`src/runner/dev-consumer.ts:528-553`;
same contract in `release-consumer.ts:57` and the review consumer). The dev consumer's
TOCTOU note even names the missing primitive this design supplies: *"If a future
push-mode or parallel-batch delivery ever makes the race real, BOTH consumers harden
together (**a single shared admit-token primitive**) — they must not drift"*
(`dev-consumer.ts:530-540`).

### 1.4 The substrate already has a rate-limit **slot**, refusal taxonomy, and config vocabulary — just no limiter

- **CO-4 gate floor** (`src/bus/gate-floor.ts`) composes upstream decisions into an
  admission verdict, including `rateOk`: "Whether the rate-limit / cost-cap gate admits
  the request. A `false` is `not_now` (transient backpressure — retry safe)"
  (`gate-floor.ts:128-140`), with `DEFAULT_RATE_RETRY_AFTER_MS = 5000` (`:157`) and the
  public floor's rate check at `:354-358`.
- **Today `rateOk` is hard-coded `true`**: "`rateOk` — passed `true` (no limiter wired
  yet; the §5 rate/cost cap is a CO-4-follow / CO-7 knob)" (`src/cortex.ts:1601-1603`,
  literal `rateOk: true` at `:1663`). **R26 is the limiter that fills this slot.**
- **Refusal taxonomy is settled**: `not_now` + `retry_after_ms` → `nak` (transient);
  `policy_denied` / `compliance_block` → `term` (permanent) (`gate-floor.ts:143-154`,
  `dev-consumer.ts:45-49`). Ordering principle: structural/permanent refusals before
  transient ones (`gate-floor.ts:195-202`).
- **Config vocabulary exists**: `RatePredicateSchema` (`per_minute`/`per_hour`/`per_day`,
  `src/common/types/offering.ts:248-262`) and `PublicLimitsSchema`
  (`max_concurrent`/`per_day`/`cost_cents_per_request`, `:289-310`) — currently only
  attachable to *public offerings*, enforced nowhere.
- **BudgetCheck** (cost caps) is a deliberate fail-closed seam awaiting real accounting
  (cortex#977) (`src/runner/budget-check.ts:34-45`). The rate limiter and the future
  budget accountant should share state machinery (see §6).

### 1.5 The horizontal-scale reality check

- The chat/direct dispatch path is **core NATS pub/sub** (`runtime.onEnvelope`,
  `src/bus/myelin/runtime.ts:102`) — fan-out, at-most-once. **No queue groups are used
  anywhere on the dispatch path** (queue-group support exists in the raw options,
  `src/bus/nats/subscription.ts:40`, but nothing sets one). Two cortex nodes subscribing
  the same `tasks.*` subject would **both spawn the same session**. Multi-node is
  therefore not just a limiter problem — the dispatch plane itself needs
  competing-consumer semantics (§5 Phase 3).
- **Shared state available today: JetStream, and only JetStream.** No Redis, no shared
  DB. NATS KV (a JetStream feature) is architecturally anticipated — architecture §7.2
  specifies a capabilities KV bucket, deferred because "myelin's signed-KV API
  (myelin#31) is the right home for that primitive and hasn't shipped"
  (`src/bus/capability-registry.ts:93-101`). `runtime.jetstreamManager()` is already
  exposed and bound to the primary NATS link (`src/bus/myelin/runtime.ts:1898-1916`).
- Topology: NATS at `nats://localhost:4222` today (`src/bus/nats/connection.ts:29`);
  the documented connection model is "leaf node connecting to a hub"
  (`docs/architecture.md:244`), and "JetStream is **required** for `system.*` events"
  (`docs/architecture.md` §4.2). So every future node — including leaf-node federation —
  shares one JetStream domain per stack. That shared JetStream domain is the
  coordination primitive this design builds on.

### 1.6 Identity to key on

The requester principal is already resolved substrate-side, surface-agnostically:
`resolvePrincipalId`/`getActorPrincipal` "read `originator.identity` FIRST (the gateway
stamps it) and only fall back to `signed_by[0]`" (`dispatch-listener.ts:1560-1563`).
Roles grant capabilities of the form `dispatch.<agentId>`
(`src/common/policy/factory.ts:71`; e.g. `engine.check("public", "dispatch.pier")`,
`src/common/policy/resolve-access.ts:69-70`). Principals/roles live in the
`policy:` block of `cortex.yaml` (`cortex.yaml.example:200-212`). The anonymous
open-onboarding principal (`PUBLIC_ORIGINATOR_DID`, zero-authority) is a first-class
principal too — it needs the *tightest* default limit.

---

## 2. Candidate designs

All three key on **envelope-resolved identity** (requester principal × target agent ×
capability), never on surface session state — that's what makes them substrate-tied.

### Design A — JetStream-native admission (streams + consumer limits as the limiter)

Migrate the direct-dispatch plane onto a per-stack `TASKS` stream (work-queue or
interest retention); each agent gets a shared durable pull consumer; nodes compete.
Concurrency is bounded by JetStream `max_ack_pending` on the durable; overflow queues
in the stream; backpressure = `nak(delay)`; stale work expires via `max_age`.

- **Across N nodes:** correct by construction — JetStream delivers each message to
  exactly one node per shared durable; the in-flight ceiling is enforced server-side.
  This is the same mechanism the review/dev/release consumers already trust
  (`cortex.ts:1549-1552`).
- **Keys on:** the *consumer* — i.e. per (stack, agent). **Cannot key on the
  requester**: the subject carries the *target* (`tasks.@did`), not the sender; JetStream
  limits attach to streams/consumers, not message-key groups. Per-principal fairness
  would require subject-grammar changes (encoding the requester into the subject) plus
  one consumer per principal — O(principals × agents) durables, a provisioning and
  migration burden.
- **Failure modes:** JetStream down ⇒ no dispatch at all (fail-closed by nature).
  Consumer-config drift (the `provision.ts` drift-warning problem) becomes
  limit-config drift.
- **Cost/complexity:** high — migrates the hot chat path from core NATS to JetStream
  pull loops; adds latency (small) and provisioning surface. Delivers *concurrency*
  control and durability, **not request-rate windows** (`rate_limit_bps` on push
  consumers is bytes-based — wrong dimension).

**Verdict:** the right *future transport* for the dispatch plane (and the real fix for
multi-node double-spawn), but not a rate limiter. It cannot express "principal X gets
6 dispatches/min" — the requirement multi-tenant fairness actually needs.

### Design B — Distributed token bucket in NATS KV (the "AdmissionGate" / shared admit-token primitive) — RECOMMENDED

A small, pure-contract module — `checkAdmission(key, limits, now) → {admit} |
{refuse, retry_after_ms}` — backed by a **NATS KV bucket** (JetStream-backed, e.g.
`admission_{principal}_{stack}`), provisioned idempotently at boot exactly like
`provision.ts` provisions streams. Token-bucket (or sliding-window) state per key;
multi-node correctness via KV's **compare-and-swap** (`update(key, value, revision)`):

```
loop (bounded, e.g. 3 attempts):
  entry, rev ← kv.get(key)            # miss ⇒ kv.create(key, fresh bucket)
  bucket ← refill(entry, now)         # tokens += elapsed × rate, capped at burst
  if bucket.tokens < cost: return refuse(retry_after = time_to_next_token)
  bucket.tokens -= cost
  if kv.update(key, bucket, rev) succeeds: return admit
  # CAS lost — another node admitted concurrently; re-read and retry
on retry exhaustion: fall back per configured failure posture (§4.3)
```

- **Across N nodes:** exact and race-free — CAS serialises concurrent admits on the
  same key through the JetStream leader. No node-local state matters; nodes can scale
  out/in freely; a restarted node inherits live counters. The KV bucket replicates with
  the stream (R1 today; R3 when the NATS cluster grows) — the limiter's availability
  is *identical to the dispatch fabric's own availability*.
- **Keys on:** anything derivable from the envelope — recommended lattice in §4.1.
  Same primitive also holds **in-flight concurrency counters** (admit ⇒ increment;
  terminal lifecycle envelope ⇒ decrement — the harness guarantees a terminal envelope
  per dispatch, `dispatch-listener.ts:38-40`), replacing the three divergent in-process
  `maxConcurrent` gates with the "single shared admit-token primitive" the dev consumer
  already anticipates (`dev-consumer.ts:536-540`).
- **Failure modes:** (a) KV unreachable while core NATS is up — rare (same server), but
  must have a declared posture (§4.3, open question 1); (b) CAS contention under hot
  keys — bounded retries, then posture fallback; contention only matters at rates far
  above any sane spawn ceiling (spawns are minutes-long Claude sessions); (c) counter
  orphans (node dies mid-run) — reconciled by a TTL + sweeper listening to the
  `dispatch.task.*` lifecycle (same recovery shape as R6/R14 patterns elsewhere);
  (d) clock skew — refill uses each node's monotonic clock over deltas stored in the
  entry; token buckets tolerate small skew by design.
- **Cost/complexity:** low-moderate. One KV round-trip (sub-ms on localhost, low-ms on
  a LAN cluster) per admission — noise against a spawn that costs minutes and dollars.
  No new infrastructure: KV *is* JetStream, which the stack already requires
  (`architecture.md` §4.2).

### Design C — Node-local buckets with async coordination (limit/N split or usage gossip)

Each node runs an in-memory bucket sized `limit / N`, or nodes broadcast
`admission.usage` events and keep an eventually-consistent shared view.

- **Across N nodes:** approximate only. `N` is dynamic (deploys, crashes, autoscale) so
  effective limits drift; eventual consistency ⇒ over-admission windows exactly when it
  matters (bursts). Worse, on today's fan-out subscription "divide by N" is meaningless
  — all nodes see all envelopes (§1.5).
- **Keys on:** same lattice as B, but each node holds a partial view.
- **Failure modes:** silent limit erosion; no single number anyone can audit.
- **Cost/complexity:** lowest latency (zero I/O), highest correctness debt.

**Verdict:** rejected as the primary mechanism — it is precisely the "naive in-memory
bucket" bottleneck Andreas flagged, dressed up. Retained only as the *degraded-mode
fallback* when the KV store is briefly unreachable (§4.3).

---

## 3. Recommendation

**Design B — a KV-arbitrated AdmissionGate at the spawn gate — with Design A's
JetStream work-queue migration as the phase-3 completion of the multi-node dispatch
plane.** Rationale, point by point against the crux:

1. **Substrate-tied, all surfaces.** The check runs where the envelope becomes a spawn
   (`handleDispatchEnvelope` step 3½, plus the three JetStream consumers' admission
   gates), and it *is* the producer of the gate floor's `rateOk` — replacing the
   hard-coded `true` at `cortex.ts:1663`. Discord, web:amt, gh-webhook, bus peers, and
   any future surface are covered because they all must cross this gate to spawn.
   No surface can opt out; no surface needs code.
2. **Horizontal scale without a bottleneck.** State lives in the fabric's own durable
   layer (NATS KV/JetStream), arbitrated by CAS — exact under N nodes, no per-node
   drift, no new infra, no SPOF beyond the bus itself (without which nothing dispatches
   anyway). This is the direct answer to the in-memory-bucket objection.
3. **Right dimension.** Rate windows (per-minute/hour/day) *and* max-in-flight
   concurrency, keyed per requester — which JetStream-only limits (Design A) cannot
   express.
4. **Future-state aligned.** The KV entry format + key grammar is specified as a myelin
   contract (the substrate owns admission; cortex consumes it) — implemented
   cortex-side first (mirroring `jetstream/provision.ts` pragmatism), migrating into
   `@the-metafactory/myelin` alongside signed-KV (myelin#31). The same KV state
   machinery later hosts the real BudgetCheck accounting (cortex#977) and can price
   admits via the envelope's `economics` field (`myelin/src/envelope.ts:100,272`) —
   rate limiting and cost budgeting become two policies over one admission primitive.
5. **Reuses the settled refusal taxonomy** — no new failure vocabulary for surfaces to
   learn (§4.4).

### 3.1 What to key the limit on (multi-node answer)

Key on **envelope identity, resolved substrate-side**: the requester principal
(`originator.identity` → `signed_by[0]` fallback — the same resolution the policy gate
trusts today). Because the key is derived from the envelope and the state is shared,
*it does not matter which node consumes the envelope* — that is the property that makes
the limit meaningful under horizontal scale. Recommended checking order (first refusal
wins; evaluated cheapest-state-first):

| Tier | Key | Protects against | Default |
|---|---|---|---|
| 1 | `stack` (global spawn ceiling) | total substrate overload / runaway loop | max_concurrent: e.g. 8; per_minute: e.g. 30 |
| 2 | `principal` | one tenant/surface principal starving others (e.g. a looping web:amt) | per_minute + max_concurrent, role-derived |
| 3 | `principal × agent` | one hot agent monopolised by one requester | optional, unset by default |
| 4 | `capability` (e.g. `code-review`) | queue-flood on offered capabilities | optional; supersedes per-consumer maxConcurrent |

The anonymous/public principal (open onboarding, `PUBLIC_ORIGINATOR_DID`) gets a
hard-tight built-in default (e.g. 2/min, 1 in-flight) regardless of config.

---

## 4. Config model, semantics, observability

### 4.1 Where limits live

Extend the existing `policy:` block (already the home of principals/roles —
`cortex.yaml.example:200`), reusing the Zod vocabulary from `offering.ts`:

```yaml
policy:
  admission:
    stack:                      # tier 1 — global ceiling
      max_concurrent: 8
      per_minute: 30
    defaults:                   # tier 2 — every principal unless overridden
      per_minute: 6
      per_hour: 60
      max_concurrent: 3
    roles:                      # role-level overrides (union → most permissive wins,
      principal:                # same union semantics as capability grants)
        per_minute: 20
        max_concurrent: 6
      surface:                  # e.g. the amt-surface principal's role
        per_minute: 10
    principals:                 # tier-2 per-principal override (most specific wins)
      - id: amt-surface
        per_minute: 12
        max_concurrent: 2
    anonymous:                  # the open-onboarding floor — cannot be raised above
      per_minute: 2             # a built-in cap
      max_concurrent: 1
```

Resolution: `principals[id]` > `roles` (most permissive of the principal's roles, like
capability union — `engine.ts` semantics) > `defaults`; `stack` always also applies.
Public offerings keep their existing `accept.limits` (`PublicLimitsSchema`) — the gate
floor composes both; the *tighter* bound wins. Absent `admission:` block ⇒ limiter off
⇒ byte-identical behaviour (the CO-4 pattern: new gates must be provably inert until
configured — `gate-floor.ts:29-37`).

### 4.2 Enforcement points (all call the one primitive)

1. `handleDispatchEnvelope` — after the policy allow, before harness construction
   (`dispatch-listener.ts` between `:1913` and `:1950`). Ordering mirrors the gate
   floor's rule: permanent refusals (policy) before transient ones (rate)
   (`gate-floor.ts:195-202`) — and keeps KV I/O off the path of requests that were
   going to be denied anyway.
2. The offered-capability admission closure — supplies real `rateOk` to
   `gateFloorForScope` (`cortex.ts:1663`).
3. Review/dev/release consumers — their step-4 concurrency gates
   (`dev-consumer.ts:528`) delegate to the shared primitive (in-flight counters in KV
   instead of three process-local `Set`s).

### 4.3 Reject-on-exceed semantics (what the surface sees)

Exactly the existing taxonomy — nothing new on the wire:

- **Interactive (chat/direct, core NATS):** terminal `dispatch.task.failed` with
  `reason: { kind: "not_now", detail: "admission: rate limit (principal=…, window=…)",
  retry_after_ms }` on the dispatch's correlation id. Surfaces already render terminal
  failures (worklog-manager, Discord, MC); web:amt sees it on the reply leg it already
  correlates (AMT-R12). Recommend a friendly renderer string ("busy — try again in
  ~Ns") rather than raw taxonomy.
- **Queued (JetStream consumers):** `nak(retry_after_ms)` + the same
  `dispatch.task.failed not_now` event — JetStream redelivers after the delay, i.e.
  throttled work *defers* instead of dying, up to `max_deliver` (5) attempts
  (`provision.ts:161`).
- **Never `term` for rate** — rate exhaustion is transient by definition; `term` is
  reserved for policy/compliance (permanent) refusals.

### 4.4 Observability

- New audit envelope `system.admission.throttled` (sibling of
  `system.access.denied`, `dispatch-listener.ts:1867-1871`) carrying key, tier,
  window, current count, retry hint — JetStream-backed like all `system.*`.
- Counters on the MC dashboard (Tier-1 card: throttles by principal/tier over time);
  per-key gauges via the existing `transportMetricsSubject` plumbing
  (`myelin/src/subjects.ts:546`).
- Degraded-mode transitions (KV unreachable → fallback posture) MUST emit a loud
  `system.*` event — never silent (the R6 lesson).
- `cortex admission status` CLI: dump live KV buckets for a principal (debuggability —
  the "single number anyone can audit" that Design C can't give).

---

## 5. Phased implementation outline

- **Phase 1 — the primitive + the chat gate (first increment).**
  `src/bus/admission/` module: KV bucket provisioning (idempotent, `provision.ts`
  pattern), CAS token bucket, config schema (`policy.admission`), enforcement point 1
  (dispatch-listener pre-spawn), tiers 1–2 (stack + principal), anonymous floor,
  `system.admission.throttled` + renderer string. Absent config ⇒ inert.
  *Covers Discord + web:amt + gateway surfaces end-to-end; correct under N nodes from
  day one.*
- **Phase 2 — one primitive everywhere.** In-flight concurrency counters w/
  terminal-event decrement + orphan sweeper; migrate review/dev/release
  `maxConcurrent` gates onto it; wire real `rateOk` into the gate-floor closure
  (`cortex.ts:1663`); tiers 3–4 keys; MC dashboard tile.
- **Phase 3 — future state.** (a) Migrate the direct-dispatch plane to a JetStream
  `TASKS` work-queue with shared durables — fixes multi-node double-spawn (§1.5) and
  adds `max_ack_pending` as a transport-level backstop under the KV limiter;
  (b) push the admission contract down into `@the-metafactory/myelin` (with signed-KV,
  myelin#31); (c) real BudgetCheck accounting (cortex#977) over the same KV state,
  pricing admits via envelope `economics`.

---

## 6. Open questions for Andreas

1. **Failure posture** when the KV admission store errors while dispatch still flows:
   fail-closed (refuse spawns) or degrade to node-local approximate buckets with a loud
   `system.*` event? (I lean degraded-local: NATS-down usually means no dispatch at
   all, so the residual window is small — but public/anonymous keys should arguably
   fail closed.)
2. **Default key depth:** ship tiers 1–2 (stack + principal) only, or is
   principal×agent (tier 3) needed from day one for the AMT/pylon seam?
3. **Config home:** `policy.admission` (proposed) vs. limits as fields on
   `RoleDefinition` — any preference for where these limits are tuned?
4. **Phase-3 timing:** is multi-node cortex close enough that the JetStream
   work-queue migration (double-spawn fix) should be pulled into this epic, or does
   R26 ship phases 1–2 and the transport migration stays a separate issue?
5. **Myelin ownership:** define the admission contract as a myelin spec now (with
   cortex as first implementation), or cortex-local until signed-KV (myelin#31) ships?
6. **Interactive semantics:** confirm reject-fast (`not_now` + retry hint rendered to
   the user) for chat, rather than silently queueing throttled chat dispatches.

---

*Evidence base: cortex @ main (2026-07-02), myelin sibling checkout. All file:line
references verified against working trees at `~/Developer/cortex` and
`~/Developer/myelin`.*
