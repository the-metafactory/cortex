# SOP — Cross-principal federation onboarding (peer principal)

**Status:** active (TC-2 / Trust & Confidentiality track) — but see [§7 Current status](#7-current-status--be-honest) before assuming the dispatch path works
**Owner:** principal
**Audience:** a principal onboarding a **peer principal** (a different human running their own cortex stack and assistant) into cross-principal federation with `andreas` / the `metafactory` network — and the peer principal doing the mirror-image steps on their side
**Worked example:** onboarding **JC** (principal `jcfischer`), who runs the assistant **Holly**, into federation with **Andreas** (principal `andreas`, network `metafactory`)

---

## 1. The model — three layers, three different things

Onboarding a peer principal is **not one step**. It is three independent layers, and conflating them is the usual source of confusion. Per `CONTEXT.md` §§ Principals/stacks/networks and `docs/adr/0001-federated-subject-grammar.md`:

| Layer | What it is | What you configure | Mutual? |
|---|---|---|---|
| **(a) Network** | A federation of principals whose stacks interconnect **at the NATS leaf-node layer** — one bus, joined by a **leafnode link**. | One mutual, manual NATS-config step (the leaf link). | Yes — both sides + agreement on a hub. |
| **(b) Identity / trust** | Who-signs-what. The **network-registry** is the cross-principal pubkey directory: each peer registers its pubkey + capabilities; the other side pins **only the registry**. | `policy.federated.registry.{url,pubkey}` — pin the registry, **never** each peer assistant. | Each side registers; each side pins the same registry. |
| **(c) Dispatch** | How work reaches a peer assistant once (a) and (b) exist. **Offer** (publish to a capability, any capable registered assistant claims it) or **Direct** (`@assistant`). | `accept_subjects` + `announce_capabilities` on the network. | Capability announcements are mutual. |

### (a) Network = a NATS leafnode link, not a subject segment

A **network** is *deployment topology*, not an address. Per `CONTEXT.md` §Network:

> A federation of **principals** whose **stacks** interconnect at the NATS leaf-node layer — `metafactory` is the network this ecosystem runs on. A network is **not a subject segment**: it is deployment topology. Cross-principal reach is the `federated.` **scope** prefix, never a network name on the wire. A principal may belong to more than one network.

So joining a network means **standing up a NATS leafnode link** that joins the two buses into one network. The network name (`metafactory`) never appears on the wire — see ADR-0001. This link is the one genuinely mutual, manual topology step ([§6](#6-the-leaf-link-topology)).

### (b) Identity / trust = the registry (pin the registry, not the peer)

This is the load-bearing simplification. The **network-registry** (`src/services/network-registry/`, deployed at **`network.meta-factory.ai`**) is the shared pubkey directory. Each peer principal **registers** its principal_id + stack + pubkey + capabilities there (proof-of-possession). The *other* side pins **only the registry's** URL + pubkey:

```yaml
policy:
  federated:
    registry:
      url: https://network.meta-factory.ai
      pubkey: ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk=
```

**You do NOT hardcode each peer assistant in your config.** When a `federated.{peer}.{stack}` envelope arrives, cortex resolves the peer's pubkey from the registry (`GET /principals/{id}`, verified against the pinned registry anchor), caches it, and feeds it to the chain verifier. Add a peer to the federation = that peer registers once; nobody else edits config. This is what the registry **replaces** — the manual `peers[]` triples in [§3](#3-the-manual-fallback-no-registry).

Full registry contract, deploy, threat model: [`docs/sop-network-registry.md`](./sop-network-registry.md).

### (c) Dispatch = Offer or Direct

Per `CONTEXT.md` §Dispatch, work reaches a peer assistant two ways:

- **Offer** — publish to a **capability** (`tasks.{capability}.{subcapability}`); any capable, registered assistant *claims* it (competing consumers, exactly-once). You don't name the assistant; you name the ability. Cross-principal Offer rides `federated.{principal}.{stack}.tasks.{capability}.…`.
- **Direct** — sent to one named assistant: `federated.{principal}.{stack}.tasks.@{assistant}.{capability}`. You name the assistant (`@holly`).

Both are **scoped `federated.`** when they cross the principal boundary — `local.` never crosses it (`CONTEXT.md` §Network: "Federation is the default for multi-principal collaboration").

---

## 2. Peer onboarding steps (mutual)

Both principals do the same five steps. Below is Andreas's side; JC mirrors it with his own ids. Each step cites the tool/contract that performs it.

### Step (i) — provision the stack identity

Mint the stack's Ed25519 signing NKey (the key that signs every envelope the stack publishes). Per [`docs/sop-network-registry.md` §Register a principal](./sop-network-registry.md) and `src/cli/cortex/commands/provision-stack.ts`:

```bash
cortex provision-stack generate andreas \
  --seed-path ~/.config/nats/cortex.nk \
  --stack-id andreas/meta-factory
```

`generate` writes a fresh `SU…` seed **chmod 600** (kernel-enforced `O_EXCL` no-clobber; `--force` to rotate) and prints the public material + a ready-to-paste `stack:` block for `cortex.yaml`. The seed is the same key the stack signs bus envelopes with — one root of secret material per stack. JC runs the mirror: `cortex provision-stack generate jcfischer --stack-id jcfischer/{stack}`.

### Step (ii) — register principal_id + stack + pubkey + capabilities at the registry

Publish the **public** half into the registry, as proof-of-possession (the claim is signed by the very key it declares). The registration contract (`src/services/network-registry/src/routes/principals.ts`, `POST /principals/{id}/register`) carries `principal_id`, `principal_pubkey`, `stacks[]`, `capabilities[]`:

```bash
cortex provision-stack register andreas \
  --seed-path ~/.config/nats/cortex.nk \
  --registry-url https://network.meta-factory.ai \
  --stack-id andreas/meta-factory
```

`register` is the only subcommand that does network I/O. You can also fold it into `generate` with `--register --registry-url <url>`, or use `cortex provision-stack claim …` to print the signed body for an air-gapped / review-before-post flow. The registry verifies (in order): unconfigured→503, shape→400, ±5-min clock skew→400, nonce replay→409, Ed25519 signature→401, silent-key-swap rotation guard→409, then upserts and returns a signed `201`. (Full verification ladder: `docs/sop-network-registry.md` §"What the registry verifies".)

> **Adding a SECOND+ stack to an already-registered principal (#791).** The registry keeps one record per principal carrying ALL their stacks, and register is a root-authorized full-overwrite — so a 2nd-stack register signed by the *new* stack's own key is unauthorized (historically a `409`). To add a stack, pass `--principal-seed <root-seed>` (the principal's FIRST stack's seed) **plus the pinned `--registry-pubkey`**: the add-stack claim is root-signed, the existing stacks are signature-verified (against the pin) and fetch-merged so they survive, and the operation is idempotent. The same flag flows through `cortex network join <net> --principal-seed <root>`. See [`sop-network-join.md` § Multi-stack join](./sop-network-join.md#multi-stack-join-a-principals-2nd-stack-791).

> ✓ The production registry store is **D1-backed and durable** (cortex#694) — registrations *and* the nonce-replay cache survive Worker-isolate recycling and are shared across every isolate/colo, so a nonce seen anywhere is rejected everywhere. (`bun test` and a bare `wrangler dev` without a local DB fall back to the in-memory backend; prod **fails closed** if the `DB` binding is absent — `assertDurableBackendInProd`, `src/services/network-registry/src/store.ts`.)

### Step (iii) — pin the registry (NOT each peer)

In `cortex.yaml`, pin `policy.federated.registry` — production values:

```yaml
policy:
  federated:
    registry:
      url: https://network.meta-factory.ai            # https required in prod
      pubkey: ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk=   # PIN — 44 chars incl. '='
```

Schema: `PolicyFederatedRegistrySchema` in `src/common/types/cortex-config.ts`. `pubkey` is optional in the schema but **set it in production** — when set, cortex refuses any registry assertion whose `registry` field disagrees; when absent, cortex TOFUs at first boot (the Phase-B caveat — a first-boot MITM can substitute its own anchor). Obtain the pubkey out-of-band or from `GET /registry/pubkey`. **This is the entire peer-trust config — you pin the registry once and never list Holly (or any peer assistant) by name.**

(Dev registry: `network-dev.meta-factory.ai` — same parity posture, distinct anchor.)

### Step (iv) — agree on, and stand up, the NATS leafnode link

This is the one mutual topology step. Both principals **agree on which side hosts the leaf hub**, then wire the leafnode link that joins the two buses into the `metafactory` network. This is a NATS-server config concern, **separate from the registry** ([§6](#6-the-leaf-link-topology)). The registry resolves *identity*; it does **not** create the bus link.

> **Standing up a brand-new network.** For `metafactory` the network descriptor (its `hub_url` / `leaf_port`) already exists in the registry. When you bring up a *new* network, a network admin first creates its topology row with one command — `cortex network create <network> --hub <tls-url> --leaf-port <port> --admin-seed <seed> --apply` (#747, v5.2.0; signed-admin claim, no raw SQL). See [`sop-stack-onboarding.md` §B1](./sop-stack-onboarding.md) for the full flow + the one-time `REGISTRY_ADMIN_PUBKEYS` prerequisite.

### Step (v) — set `accept_subjects` + announce capabilities

On the network entry in `policy.federated.networks[]` (`PolicyFederatedNetworkSchema`, `src/common/types/cortex-config.ts`), declare what inbound federated traffic you accept and what you offer:

```yaml
policy:
  federated:
    registry: { url: https://network.meta-factory.ai, pubkey: ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk= }
    networks:
      - id: metafactory
        leaf_node: nats-leaf-metafactory          # → the leaf link from step (iv)
        accept_subjects:
          - federated.andreas.meta-factory.>      # accept inbound federated traffic addressed to me
        announce_capabilities:
          - code-review.typescript
        max_hop: 1                                 # required field — no default; a conscious choice
```

- `accept_subjects[]` is an explicit allow-list (empty = accept nothing). `deny_subjects[]` overrides it. `max_hop` is **required** (no default — a hop budget must be a conscious choice; `cortex-config.ts` rejects a missing `max_hop`).
- `announce_capabilities[]` are published on `system.capability.announced.<network_id>` so peers can route by capability (Offer mode) without knowing your agent inventory.

> ⚠️ **Grammar note (read [§7](#7-current-status--be-honest)).** The *current schema* default and cross-validation key `accept_subjects` on `federated.{network_id}.>`. ADR-0001 (**Accepted**) reworks this to `federated.{principal}.{stack}.>` — the network name comes **off the wire** entirely. That rework is cortex#691, in progress. Stage the network entry now; expect the accept-pattern segment to change from `{network_id}` → `{principal}.{stack}` when #691 lands.

---

## 3. The manual fallback (no registry)

Before the registry, each side hand-pinned every peer. The fallback still exists: `policy.federated.networks[].peers[]` — a list of `{principal_id, stack_id, principal_pubkey}` triples (`PolicyFederatedPeerSchema`, `src/common/types/cortex-config.ts`):

```yaml
policy:
  federated:
    networks:
      - id: metafactory
        leaf_node: nats-leaf-metafactory
        peers:
          - principal_id: jcfischer
            stack_id: jcfischer/sage-host
            principal_pubkey: U…                  # 56-char U-prefixed NKey, pasted by hand
        accept_subjects: [federated.andreas.meta-factory.>]
        max_hop: 1
```

**This is exactly the thing the registry replaces.** With `peers[]`, every principal hand-maintains every other principal's pubkey, and adding a peer means every side edits config. With the registry ([§2 step iii](#step-iii--pin-the-registry-not-each-peer)), each peer registers once and everyone else pins only the registry. Use `peers[]` only when you have no registry (e.g. an isolated test mesh, or a network the registry doesn't serve). The two are not mutually exclusive — a `peers[]` entry is a static pin; the registry is the dynamic directory.

> Schema detail: `PolicyFederatedPeerSchema` is `.strict()` and the canonical keys are `principal_id` / `principal_pubkey`. The legacy `operator_id` / `operator_pubkey` aliases were removed at v4.0.0 (R2.G breaking cut) and are now rejected as unknown keys.

---

## 4. Capability announcement & how a dispatch lands

Once (a)+(b)+(c) exist, a cross-principal dispatch works like this:

- **Offer:** Andreas's stack publishes a review task to a capability on `federated.andreas.meta-factory.tasks.code-review.typescript`. Any registered assistant whose agent declares `code-review.typescript` and consumes that network can claim it (exactly-once). Andreas does not name Holly.
- **Direct:** Andreas addresses Holly by assistant name: `federated.andreas.meta-factory.tasks.@holly.code-review.typescript`. `distribution_mode = direct` in the envelope; `@holly` is the assistant, resolved to JC's hosting agent via `(stack, assistant)`.

Lifecycle events flow back on `federated.{requester}.{stack}.dispatch.task.{started|completed|failed|aborted}`, joined by `correlation_id`, mirroring the inbound scope (`CONTEXT.md` §Dispatch).

---

## 5. Verify (staging-only today)

What you *can* verify now (config + identity layers):

1. **Registry up + signed:** `GET https://network.meta-factory.ai/api/health` → `{ "status": "ok" }`; `GET /registry/pubkey` → `{ "algorithm": "Ed25519", "public_key": "ErrjF…" }` (not 503, not `"unconfigured"`).
2. **Peer resolves:** `GET https://network.meta-factory.ai/principals/jcfischer` returns a `SignedAssertion` whose `registry` equals your pinned pubkey and whose `payload.principal_pubkey` is JC's registered key. A 404 means JC hasn't registered yet.
3. **Your own identity round-trips:** under `security.signing: enforce`, the boot `verifier-self-check` (`src/bus/verifier-self-check.ts`) logs `cortex: verifier-self-check OK …`. (Note: enforce is **not** today's default — see [§7](#7-current-status--be-honest).)

What you **cannot** verify yet: an actual cross-principal *dispatch* landing on the peer — the consumer doesn't exist yet ([§7](#7-current-status--be-honest)).

---

## 6. The leaf-link topology

**The registry resolves identity; it does NOT create the bus link.** These are two separate facts of life:

- The **registry** (`network.meta-factory.ai`) answers "what is principal X's pubkey, and what capabilities does it announce?" It is an HTTPS pubkey directory. It carries no bus traffic.
- The **leafnode link** is what physically joins JC's NATS bus to Andreas's NATS bus into one `metafactory` network. It is a standalone **NATS-server config** step — the `leafnodes{}` block on the NATS servers, where one side runs the leaf **hub** and the other connects to it as a remote. Per `docs/design-multi-network-bridge.md` §"Physical (M1, leaf-node)": leaf-node configs constrain bridged subjects to `federated.>` only — a subject published on one network's link physically cannot reach a server that isn't peered. Physical link separation is the load-bearing isolation guarantee, enforced *below* cortex.

In cortex.yaml the link is named by `policy.federated.networks[].leaf_node` and (optionally, per F-3a / `PolicyFederatedNetworkNatsSchema`) carries an inline `nats: { url, credsPath?, name? }` block. The CFG-layered home for the `leaf_nodes:` resolution table is `network.yaml` (`docs/design-multi-network-bridge.md` §3.3) — but the **NATS-server-side `leafnodes{}` config (whose hub, what URL, what creds) is provisioned by the principals on their NATS infrastructure, not generated by cortex.**

**Counter-example — `andreas/halden` is deliberately UNbridged.** `halden` is one of Andreas's own stacks (`andreas/halden`, per `CONTEXT.md` §Principal and `docs/design-bus-addressing.md`). It runs `local.andreas.halden.>` and is reachable on `federated.andreas.halden.>` **only if a leaf link is stood up for it** — by default it isn't. It shows that *having an identity / being in the config* is not the same as *being on the wire*: a stack with no leaf link is unreachable cross-network no matter what the registry says about it. Identity (registry) and reachability (leaf link) are orthogonal.

> **The leaf hub is operator-mode, so the leaf side must be too (#794).** The `halden` / `community` pattern stands a stack up on a **hard-isolated, anonymous** bus (no NSC operator, no accounts). Such a bus **cannot bind a leaf** to an operator-mode hub — the rendered remote names an account the anonymous server doesn't know and `nats-server` crashes (`cannot find local account`). `cortex network join` fails fast on this rather than crashing the bus; to federate a hard-isolated stack, convert its bus to operator-mode first. Full procedure: [`sop-stack-onboarding.md` §B0.1](./sop-stack-onboarding.md#b01--the-bus-must-be-operator-mode-the-794-lesson).

---

## 7. Current status — be honest

**Nothing is live on the federated DISPATCH path yet.** You can *stage* the onboarding config (identity, registry pin, network entry) today, but bus dispatch to a peer **will not fire** until the in-flight work lands:

| Item | What it is | State |
|---|---|---|
| **cortex#691** | ADR-0001 federated subject-grammar rework — `federated.{principal}.{stack}` on the wire, network off-wire; `accept_subjects` default moves `{network_id}` → `{principal}.{stack}`. | **OPEN / in progress** |
| **cortex#686** | The federated review **consumer** — the cortex receiver that subscribes to inbound cross-principal review-requests on the conformant grammar and emits the verdict back. | **OPEN / in progress** |
| **pilot#149** | Re-target the pilot review request as a **Direct** dispatch (`@reviewer@{principal}/{stack}`) emitting the conformant subject; merges in lockstep with #686. | in progress |

Per ADR-0001 §Consequences: *"nothing is live on the federated path yet (no consumer existed), so there is no production traffic to migrate."*

**Signing and encryption are OFF (IoAW end-to-end first).** Per `docs/design-trust-confidentiality.md` §Phase 0, the out-of-box default posture is `security.signing: off` — "get it working off, ramp later." The cross-principal verify seam (TC-2d) only engages under `security.signing: enforce`; under `off`/`permissive` there is **zero registry I/O** and federated envelopes verify local-only. Payload encryption is designed (`docs/design-envelope-encryption.md`) but **deferred** — `federated.` payloads cross cleartext-over-TLS in v1 (`CONTEXT.md` §"Federation confidentiality (v1)": "you + JC + a trusted hub"). The strategy is to get the Internet-of-Agentic-Work path working end-to-end first, then ramp the security posture `off → permissive → enforce`.

**Net:** onboarding config can be **staged now** (identity provisioned, registry pinned, network entry written) so the moment #691/#686 land the path is ready — but a real dispatch to a peer assistant won't reach it until those merge. Don't promise JC a working dispatch today; promise a staged onboarding and a path that lights up when the consumer ships.

---

## 8. Cross-references

- [`docs/sop-network-registry.md`](./sop-network-registry.md) — registry contract, deploy, proof-of-possession registration, threat model, the production pubkey + URL.
- [`docs/sop-stack-identity.md`](./sop-stack-identity.md) — the per-stack signing NKey (provision + rotate).
- [`docs/adr/0001-federated-subject-grammar.md`](./adr/0001-federated-subject-grammar.md) — `federated.{principal}.{stack}` grammar; network resolved from topology, off-wire.
- [`docs/design-trust-confidentiality.md`](./design-trust-confidentiality.md) — posture ramp `off → permissive → enforce`; signing/encryption deferral.
- [`docs/design-multi-network-bridge.md`](./design-multi-network-bridge.md) — leaf-node link pool, `leaf_nodes:` table, physical isolation.
- `src/common/types/cortex-config.ts` — `PolicyFederatedRegistrySchema`, `PolicyFederatedNetworkSchema`, `PolicyFederatedPeerSchema`.
- `src/services/network-registry/src/routes/principals.ts` — the registration contract.
- `src/cli/cortex/commands/provision-stack.ts` — `generate` / `claim` / `register`.
- **Issues:** cortex#686 (federated review consumer), cortex#691 (ADR-0001 grammar rework), pilot#149.

---

## 9. Ready-to-send message to JC

```
Subject: Federating Holly with metafactory — what I need from you

Hi JC,

I want to wire Holly into cross-principal federation with my metafactory
stack so we can dispatch work across our two buses. The model is three
separate layers — a NATS leaf link (topology), the network registry
(identity/trust), and dispatch (Offer/Direct). To set it up I need three
things from you:

1. Your principal/stack for Holly.
   What's the {principal}/{stack} pair Holly runs on? (Mine is
   andreas/meta-factory.) I just need the identity string — e.g.
   "jcfischer/sage-host" — so the federated subjects address the right
   stack.

2. Agreement on a NATS leaf link between your bus and mine.
   This is the one mutual, manual topology step: a NATS leafnode link
   that joins our two buses into the one "metafactory" network. The
   network name never goes on the wire — it's pure leaf-node topology.
   The open question is *whose side hosts the leaf hub* — happy to run
   the hub on my side and have you connect in as a remote, or the
   reverse. Your call; let me know which you'd prefer and I'll send the
   leafnodes{} config to match.

3. Register your stack pubkey + Holly's capabilities at the registry.
   The registry at network.meta-factory.ai is the shared pubkey
   directory. Once you've provisioned Holly's stack identity
   (cortex provision-stack generate jcfischer --stack-id <your-stack>),
   register it:

     cortex provision-stack register jcfischer \
       --seed-path <your-seed> \
       --registry-url https://network.meta-factory.ai \
       --stack-id <your-stack>

   That publishes your principal_id + stack + pubkey + the capabilities
   Holly offers (e.g. code-review.typescript). Hold this step until
   cortex#686 (the federated review consumer) lands — there's no live
   dispatch path to receive traffic before then, so registering earlier
   just stages it.

One thing worth stressing: my config will only ever pin the *registry*
(its URL + pubkey) — I never hardcode Holly, or your stack key, in my
cortex.yaml. That's the whole point of the registry: you register once,
and I resolve your pubkey from the directory at dispatch time. Add a peer
to the federation = that peer registers; nobody else touches config.

Honest status: nothing is live on the federated dispatch path yet —
the subject-grammar rework (#691) and the federated review consumer
(#686) are still in flight, and signing/encryption are deliberately OFF
for now (we're getting the Internet-of-Agentic-Work path working
end-to-end first, then ramping security). So we can stage all the
onboarding config now and it'll light up the moment #686 ships.

Send me your {principal}/{stack} and your preference on the leaf hub and
I'll get the link side ready.

Cheers,
Andreas
```
