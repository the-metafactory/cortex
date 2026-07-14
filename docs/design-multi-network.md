# Design — F-3: Multi-link / multi-network runtime (one NATS leaf per network)

**Status:** Draft
**Slice:** TC-F3 / F-3 (`docs/iteration-trust-confidentiality.md:16`) · E.1 (`cortex#348`) · `cortex#631`
**Umbrellas:** `cortex#627` (Trust & Confidentiality) · cross-links `cortex#117` (IAW Phase E)
**Builds on:** `docs/design-multi-network-bridge.md` (the broad Phase E design) · `docs/design-trust-confidentiality.md` §5 (Phase F drive order)
**Author:** Luna (design)
**Date:** 2026-06-04

---

## 0. Why a second design doc

`docs/design-multi-network-bridge.md` already specifies the *broad* Phase E vision — link pool,
delegation (E.3), per-network capability announce (E.2), encryption-at-the-bridge (E.7), mesh
varieties (E.4). That doc is the architecture. **This doc is the bounded F-3 implementation contract:**
the single structural slice that turns the single-link `MyelinRuntime` into a link pool, and *nothing
else*. It exists because:

1. **The umbrella moved.** F-3 now lands under the Trust & Confidentiality drive (`cortex#627`),
   federation-FIRST/unsigned (`docs/design-trust-confidentiality.md:200,211`), sequenced after F-1
   (`#648`, merged) and F-2 (`#653`, merged). F-1/F-2 landed in the **gateway** (cross-principal on
   *one* bus); F-3 is the first slice to touch the **runtime link layer** (multiple buses).
2. **The broad design and the issue disagree on the config schema, and the issue cites a file that
   does not exist** (§2 below). That divergence is a blocking decision F-3 must resolve before code.
3. The link-pool refactor touches the runtime singleton wired through `cortex.ts` boot and every
   subscriber path — it is a multi-step change that benefits from a per-slice contract with explicit
   back-compat guarantees and a test matrix.

Scope discipline: **E.2 (capability announce), E.3 (delegation/orchestrator), E.7 (encryption) are OUT.**
F-3 ships the transport substrate they later ride on, with zero behaviour change when no network
declares a per-network leaf.

---

## 1. Current state (single-link, read from source)

The runtime is structurally single-link. One `NatsLink`, one subscriber set, one publish core:

- `startMyelinRuntime(config, options)` opens exactly one link from `config.nats.url`
  (`src/bus/myelin/runtime.ts:506-515`) and builds one `subscribers: MyelinSubscriber[]`
  (`runtime.ts:535`).
- The single `link` is captured at closure-init; `signAndPublishOnSubject(envelope, subject)`
  (`runtime.ts:666-749`) closes over it and calls `link.publish(subject, …)` (`runtime.ts:748`).
- `publishEnabled` derives the subject via `deriveNatsSubject(envelope, stack)` (`runtime.ts:771`).
  Post-cortex#661 a federated envelope emits `federated.{network_id}.{stack}.{type}` — segment[1] is
  the TARGET `network_id`, read from `extensions.network_id` (the routing-hint a federated emit site
  stamps), aligning the emit site with §3.2 routing. (Pre-#661 it emitted `federated.{principal}.…`,
  which matched no leaf's network id and was dropped at the unknown-network skip — see #661.) What a
  single link still **cannot** do is route different `federated.*` traffic out of different *physical*
  links; that is what the link pool below provides.
- `subscribePull` (`runtime.ts:816`), `subscribe` (push, `runtime.ts:869`), `jetstreamManager`
  (`runtime.ts:895`), and `stop` (`runtime.ts:908`) are all bound to the one captured `link`.
- Boot degradation today is all-or-nothing: a connect failure returns a fully-disabled runtime
  (`runtime.ts:519-533`); "push subscribers configured but none came up" closes the link and returns
  disabled (`runtime.ts:619-632`).

`cortex.ts` wires exactly one runtime: `runtime = await startMyelinRuntime(config, { signer, stack,
principal, signFailureMode })` (`src/cortex.ts:646-660`). Nothing downstream knows there could be more
than one link.

The config schema that F-3 consumes **already ships** (Phase D, `cortex#116`):

- `PolicyFederatedNetworkSchema` (`src/common/types/cortex-config.ts:1444-1529`) carries `id`,
  `leaf_node` (a *named reference*, not a URL — `:1462`), `peers[]`, `accept_subjects[]`,
  `deny_subjects[]`, `announce_capabilities[]`, `max_hop`.
- The schema docblock pre-announces F-3: *"Multi-link transport (one MyelinRuntime per network) lands
  in Phase E; Phase D operates one network's leaf-node at a time, named via `leaf_node`"*
  (`cortex-config.ts:1440-1442`).
- The surface-router federated gate already exists: it keys networks by `id`
  (`src/bus/surface-router.ts:272-274`), gates inbound `federated.*` against `accept_subjects` /
  `deny_subjects` / `max_hop` (`surface-router.ts:350-366`), and the render contract already passes the
  matched `subject` so adapters can derive `source_network` from `federated.{network_id}.>`
  (`surface-router.ts:98-111`).

So F-3 is a **transport refactor**, not a schema flip — confirming the broad design's §0 claim.

---

## 2. BLOCKING DECISION — the leaf-node connection schema (OD-F3-1)

The broad design and the issue **disagree**, and the issue points at a non-existent file. This must be
resolved before any code lands.

**Option A — separate `leaf_nodes:` table** (`docs/design-multi-network-bridge.md:141-173`, §3.2):

```yaml
leaf_nodes:
  nats-leaf-research: { url: nats://research:4222, creds_path: ~/.config/metafactory/cortex/creds/research.creds }
policy:
  federated:
    networks:
      - { id: research-collab, leaf_node: nats-leaf-research, … }
```

`leaf_node` (already in the schema) stays a *named reference*; a new top-level `leaf_nodes:` map
resolves name → `{url, creds_path?, name?}`. Two leaf-node-names can be shared by N networks.

**Option B — inline `nats:` block on the network entry** (`cortex#348` acceptance, citing
*"design §4.3 Option B `{url, credsPath?, name?}`"* — **but `docs/design-phase-e-multinetwork.md`
§4.3 does not exist in this repo; the actual design is `design-multi-network-bridge.md`, which has no
§4.3 and proposes Option A**):

```yaml
policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research      # retained as the routing label / pool key
        nats: { url: nats://research:4222, credsPath: ~/.config/metafactory/cortex/creds/research.creds }
```

The `nats:` block sits directly on each network; `leaf_node` survives purely as the pool key /
de-dup label.

### Recommendation: **Option B for F-3, with `leaf_node` as the de-dup key.**

Rationale (grounded):

- **Mirrors the existing top-level `nats:` schema 1:1.** `NatsConfigSchema`
  (`cortex-config.ts:870-918`) already defines `{url, token?, name, credsPath?, …}`, and `NatsLink.connect`
  already accepts `{url, token?, credsPath?, name, connectImpl?}` (`connection.ts:27-47, 103`). A
  per-network `nats:` reusing a *subset* of that exact shape means **zero new connection primitive** and
  a schema the validator/loader already knows how to handle. Option A's `leaf_nodes:` table is a wholly
  new top-level config section + a new resolver + a new cross-validation (dangling-reference check).
- **It is what `cortex#348` accepted.** The issue's checklist is the contract the slice will be reviewed
  against. Honouring it (while *fixing the broken citation*) is less surprising than overriding it.
- **`leaf_node` is still load-bearing** as the **pool key**: two networks sharing one physical leaf
  (same `url`+creds) declare the same `leaf_node` name and share one `NatsLink` (one socket, two policy
  slices). This preserves the broad design's "N networks, M ≤ N links" economy *without* a separate
  table — the `nats:` block on the *first* network with a given `leaf_node` defines the connection; a
  later network reusing that `leaf_node` MUST either omit `nats:` or declare a byte-identical one
  (cross-validated — §4 rule 3).
- **Back-compat is trivial:** a network with **no `nats:` block** falls back to the **primary link**
  (`config.nats`), exactly preserving Phase D's "one leaf at a time" behaviour. Zero per-network `nats:`
  blocks ⇒ today's single-link runtime, byte-for-byte.

**This recommendation overrides `design-multi-network-bridge.md` §3.2 on the schema-home question only.**
Per CLAUDE.md ("when the plan and reality disagree … update the plan first, then the code"), F-3
updates the broad design's §3.2 with a back-reference to this doc when it lands. The `leaf_nodes:`
table can still arrive later as a *CFG-layer ergonomic* (`network.yaml`, `cortex#83`) without changing
runtime semantics — both options resolve to the same `{url, creds, name}` connection params.

> **Andreas decides OD-F3-1.** If you prefer Option A (separate table — cleaner when many networks
> share few leaves, and keeps creds-paths in one security-reviewable block), say so and the slice
> swaps the schema half; the runtime link-pool half is identical either way.

---

## 3. Target state — the `LinkPool`

### 3.1 Shape

Introduce an **internal** `LinkPool` inside `startMyelinRuntime`. The public `MyelinRuntime` interface
(`runtime.ts:43-212`) is **unchanged** — the pool is private; callers still see `publish` /
`publishOnSubject` / `subscribePull` / `subscribe` / `jetstreamManager` / `onEnvelope` / `stop`.

- **`linkId` keying.** `linkId === 'primary'` for the `config.nats` connection (the existing local
  link). `linkId === network.leaf_node` for each *distinct* per-network connection. Distinct = unique
  `leaf_node` name; two networks naming the same `leaf_node` share one `NatsLink`.
- Each link owns its own subscriber set + its own `jsmCache`. The existing `signAndPublishOnSubject`
  factory (`runtime.ts:666`) is reparameterised to close over a **selected** link rather than the
  module-singleton `link`.
- The `boundByPattern` dedupe map (`runtime.ts:560`, `cortex#491`) becomes per-link (a double-bind is
  per-link, not global).

### 3.2 Publish routing (pure function of the resolved subject)

`publish(envelope)` / `publishOnSubject(envelope, subject)` select the target link from the subject's
scope + network segment:

| Resolved subject | Target link |
|---|---|
| `local.…` | `primary` |
| `public.…` | `primary` (public mesh transport deferred — `design-multi-network-bridge.md` §3.5) |
| `federated.{network_id}.…` | the pool link whose owning network has `id === {network_id}` |
| `federated.{unknown}.…` | **no link** — emit `system.error` reason `unknown_network_in_publish_subject`, skip (per `#348` acceptance) |

Selection is a pure function — no global mutable routing state, no per-message Map rebuild (mirrors the
`network-resolver.ts:48-77` cached-lookup discipline). Map: `network_id → linkId` built once at boot
from `policy.federated.networks[]`; `linkId → NatsLink` is the pool.

> **NAME-COLLISION (load-bearing, from the broad design §1.1).** `src/bus/network-resolver.ts` owns a
> *different* `config.networks[]` (legacy grove: Discord guilds / Mattermost channels →
> cloud-publish targets — `network-resolver.ts:22-44`). **F-3 must never import those tables into
> federation routing.** The pool keys off `policy.federated.networks[]`, never `config.networks[]`.

### 3.3 Inbound source-link attribution

Each link's subscriber tags delivered envelopes with the **delivering `linkId`**. The
`EnvelopeHandler` signature is `(envelope, subject)` today (`runtime.ts:40`). F-3 extends it
**additively** to `(envelope, subject, sourceLink?)` — existing handlers ignore the third arg (per
`#348` acceptance). Defence-in-depth (§5): the per-link subscriber asserts the subject's `{network_id}`
segment maps to a network whose `leaf_node === sourceLink`; a mismatch is a spoof and is dropped +
logged (`system.error`).

### 3.4 Per-link lifecycle + boot degradation (contract change — OD-F3-2)

- **Connect / drain / reconnect per link.** `NatsLink` already defers reconnect to nats.js
  (`connection.ts:119` `reconnect: true`).
- **`stop()` drains ALL links** via `Promise.allSettled` (extend `runtime.ts:908-921`); one link's
  drain failure does not block another's (per `#348` acceptance).
- **Boot degradation flips from all-or-nothing to per-link.** Today a single connect failure disables
  the *whole* runtime (`runtime.ts:519-533`). With N links, **one network's leaf being down at boot
  must NOT take the daemon down**: the primary link governs `enabled`; a dead per-network link logs a
  `system.error`, marks that link disabled (publishes to it skip + log), and is retried by nats.js in
  the background. This is a deliberate boot-contract change.

> **Andreas decides OD-F3-2.** Confirm the degraded-boot contract: *primary link down ⇒ runtime
> disabled (as today); a per-network link down ⇒ boot continues, that network dark, retried in
> background.* The alternative (any leaf down ⇒ refuse boot) is safer-by-default but breaks the
> "one dead peer can't take me down" availability goal of a bridge stack. Recommendation: **degrade,
> don't crash** — it is the whole point of multi-network resilience, and a dark network already fails
> closed (nothing routes to it).

### 3.5 What does NOT change in F-3

- **`subscribePull` stays bound to the `primary` link** — no per-network JetStream durables in F-3
  (deferred, `design-multi-network-bridge.md` §11.3 / `#348` out-of-scope). Capability consumers
  (ReviewConsumer) are unaffected.
- **No per-link signing keys** — one stack identity signs all links (deferred; `#348` out-of-scope).
  The single `signer` (`runtime.ts:641`) is threaded into every link's publish core unchanged.
- **The additive optional-property discipline** for `publishOnSubject?` / `subscribePull?` /
  `subscribe?` / `jetstreamManager?` (`runtime.ts:122,148,187,209`) is preserved — fake-runtime test
  stubs stay byte-identical (`cortex#290` constraint).

---

## 4. Schema + cross-validation work

Per Option B (§2):

1. **Add optional `nats:` to `PolicyFederatedNetworkSchema`** (`cortex-config.ts:1444`) — a subset of
   `NatsConfigSchema`: `{ url, credsPath?, name? }` (drop `token` and `subjects`/`identity`/
   `accountSigningKeyPath` — per-network subscribe patterns derive from `accept_subjects`, not a
   subjects list; token-auth is discouraged for federated leaves — surface as a follow-up if needed).
2. **Cross-validator: `leaf_node` uniqueness/consistency** (`design-multi-network-bridge.md` §12 rule 3,
   restated): within `policy.federated.networks[]`, all entries sharing a `leaf_node` name MUST resolve
   to the same connection params — either exactly one declares `nats:` and the rest omit it, or all
   declarations are byte-identical. Conflicting `nats:` under one `leaf_node` fails load loudly (mirror
   the `superRefine` per-offender `ctx.addIssue` pattern at `cortex-config.ts:1611`).
3. **Cross-validator: a network with `nats:` whose `accept_subjects` is empty** is a silent no-op
   participant — allowed (consume-only), but emit an info-level note (matches the existing "empty =
   announce nothing" posture, `cortex-config.ts:1505-1511`).

---

## 5. Isolation — no cross-network leakage (defence-in-depth)

Three layers, unchanged in intent from the broad design §5, restated for the F-3 contract:

1. **Physical (M1, leaf-node).** Network B's NATS server never sees network A's subjects — enforced
   below cortex in leaf-node infra. The load-bearing backstop.
2. **Routing (M2, F-3 link selection).** §3.2 routes `federated.{network_id}.…` *only* to that
   network's link; inbound, each subscriber binds to exactly one link and tags `sourceLink` (§3.3), so
   a misrouted subject can't be silently accepted under the wrong network's policy.
3. **Policy (M6, surface-router).** The Phase D gate (`surface-router.ts:350-366`) already applies the
   *correct* network's `accept_subjects` / `deny_subjects` / `max_hop` keyed by `id`. F-3's `sourceLink`
   attribution feeds it the delivering network so the right slice applies. The `accept_subjects`
   bare-`>` refusal (`cortex-config.ts:1424-1432`) caps the maximal accept at `federated.{network_id}.>`.

The cardinal failure (cross-network subject leakage) gets an explicit **negative test** (§7) — a
`federated.{B}.*` publish must never appear on link A's wire.

---

## 6. Trust across leaves (ties to TC-2a/2b/2d + signing)

F-3 ships **unsigned** (federation-FIRST drive — `design-trust-confidentiality.md:211`). The trust
story is *structural*, not cryptographic, in this slice, and composes forward:

- **One stack identity, N links.** The single boot `signer` (`runtime.ts:641`) stamps every link's
  outbound envelopes identically. Per-link signing keys are deferred (§3.5).
- **Peers are network-scoped trust closures** — each network's `peers[]`
  (`cortex-config.ts:1466-1472`) is already the per-network trust roster. When signing/verify lands
  (TC-2d, `#635`), the federated verify gate keys the peer-pubkey lookup off the **delivering network**
  (the `sourceLink` → network the F-3 attribution provides), so a signature valid in A is meaningless
  in B. F-3's `sourceLink` plumbing is the hook TC-2d consumes — **F-3 is a prerequisite for
  per-network federated verify.**
- **Registry resolution (TC-2a `#633` / TC-2b `#634`)** is per-principal and orthogonal to link count;
  the multi-principal `IdentityRegistry` resolves peer pubkeys regardless of which link delivered the
  envelope — F-3 just hands it the correct network context.

> **Andreas decides OD-F3-3 (forward-looking, non-blocking for F-3):** when per-network signing keys
> *do* land, is the key **per-leaf** (one identity per network membership — stronger isolation, more
> key custody) or **per-stack shared across leaves** (today's model — simpler, the bridge is openly one
> identity in both networks)? F-3 builds the per-stack-shared path; the choice gates a later harden
> slice, not this one.

---

## 7. Test matrix

Using the existing `MyelinRuntimeOptions.connectImpl` fake-link seam (`runtime.ts:264`) — **no real
`nats-server`**. A per-link fake is keyed so the test can assert which link saw which publish.

1. **Two-link single-process (the headline acceptance, `#348`/E.1.5).** One runtime opens `primary` +
   two per-network links; publish `federated.research-collab.*` → asserts it hits only the
   research-collab link; publish `federated.jv.*` → only the jv link; chain-of-stamps preserved.
2. **Negative leakage test (§5, cardinal).** Assert `federated.jv.*` **never** appears on the
   research-collab link's wire. This is the test that rejects any accidental shared-link regression.
3. **Link-selection unit test (pure function).** `local.*` → primary; `public.*` → primary;
   `federated.{n}.*` → pool[n]; `federated.{unknown}.*` → `system.error`
   `unknown_network_in_publish_subject` + skip (not silent drop).
4. **Back-compat (`#348` acceptance).** A network with **no `nats:` block** routes via the primary
   link; zero per-network `nats:` ⇒ behaviour identical to Phase D / today. Assert against a snapshot of
   current single-link publish subjects.
5. **Boot-degradation (OD-F3-2).** Per-network link B's `connectImpl` throws → runtime `enabled` (primary
   up), `system.error` emitted for B, publishes to B's network skip+log, primary traffic unaffected.
6. **`stop()` drains all links** via `Promise.allSettled`; one link's drain throwing doesn't block the
   others (assert all `stop()` called).
7. **`sourceLink` attribution + anti-spoof (§3.3).** Inbound on link B tagged `sourceLink: <B leaf>`;
   a subject naming network A delivered on link B is dropped + logged.
8. **Symmetry regression.** Extend `src/bus/myelin/__tests__/runtime-principal-symmetry.test.ts` to a
   per-link assertion: subscribe-`{network_id}` === publish-`{network_id}` per link.

---

## 8. Slice breakdown (see `docs/iteration-multi-network.md`)

F-3 decomposes into four bounded, independently-reviewable sub-slices:

| Sub-slice | Scope | Gated/additive |
|---|---|---|
| **F-3a** Schema | Optional `nats:` on `PolicyFederatedNetworkSchema` + `leaf_node`-consistency cross-validator | additive; no `nats:` ⇒ unchanged |
| **F-3b** LinkPool core | Internal `LinkPool`; reparameterise `signAndPublishOnSubject` over a selected link; pure-function link selection; per-link `boundByPattern` | no per-network `nats:` ⇒ one link = today |
| **F-3c** Lifecycle + degraded boot | Per-link connect/drain/reconnect; `stop()` drains all; degrade-don't-crash boot (OD-F3-2) | primary-only path identical to today |
| **F-3d** Inbound attribution | `sourceLink?` additive handler arg; anti-spoof assert; surface-router fed gate fed the delivering network | existing handlers ignore the arg |

Each sub-slice is shippable behind the "zero per-network `nats:` ⇒ zero behaviour change" invariant, so
F-3 can merge incrementally without ever putting main into a half-built multi-network state.

---

## 9. Open decisions for Andreas

| ID | Decision | Recommendation | Blocking? |
|----|----------|----------------|-----------|
| **OD-F3-1** | Leaf-node connection schema: Option A (`leaf_nodes:` table) vs Option B (inline `nats:` per network) | **Option B** — mirrors existing `nats:`/`NatsLink` 1:1, matches `#348`, `leaf_node` as de-dup key; A can arrive later as a CFG ergonomic | **Yes — before F-3a code** |
| **OD-F3-2** | Degraded-boot contract: per-network leaf down ⇒ degrade vs refuse-boot | **Degrade, don't crash** — dark network fails closed; resilience is the point | Yes — before F-3c |
| **OD-F3-3** | Per-network signing keys (forward-looking): per-leaf vs per-stack-shared | **Per-stack-shared** for now (today's model); per-leaf is a later harden slice | No — F-3 builds shared |
| **OD-F3-4** | The broken citation in `#348` (`design-phase-e-multinetwork.md §4.3`) | Fix the issue body to cite this doc + `design-multi-network-bridge.md`; no such file/section exists | Housekeeping |

---

## 10. Recommendation (decision-quality summary)

Refactor `MyelinRuntime` to own an internal **`LinkPool`** — the always-present `primary` link plus one
`NatsLink` per distinct `policy.federated.networks[].leaf_node` — reparameterising the existing
link-bound `signAndPublishOnSubject` core (`runtime.ts:666`) to close over a *selected* link. Select the
link by a pure function of the resolved subject's scope + `{network_id}` segment; never share a link
across federation networks. Add an **optional `nats:` block** to `PolicyFederatedNetworkSchema`
(**Option B**, pending OD-F3-1) — reusing the existing `NatsLink` connection shape, so no new connection
primitive and a back-compat default (no `nats:` ⇒ primary link ⇒ today's behaviour byte-for-byte).
Boot **degrades, not crashes**, on a dead per-network leaf (OD-F3-2). Ship **unsigned** per the
federation-FIRST drive; the additive `sourceLink` attribution is the exact hook TC-2d (`#635`) consumes
for per-network federated verify — **F-3 is the structural prerequisite** for cross-leaf signed
federation. E.2 (capability announce), E.3 (delegation), E.7 (encryption) stay out; F-3 is the
transport substrate they ride on. Four bounded sub-slices (F-3a–d), each shippable behind the
zero-network no-op invariant.
