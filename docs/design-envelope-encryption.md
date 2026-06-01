# Design — Envelope Encryption Strategy (Federation Payload Confidentiality)

**Status:** Draft
**Feature:** IAW E.7 — federation payload confidentiality
**Refs:** cortex#369 (this work item), cortex#117 (IAW Phase E umbrella), `docs/design-internet-of-agentic-work.md` (federation model §3.x), `docs/plan-internet-of-agentic-work.md` (Phase D + Phase E)
**Author:** Architect (design session pending: principal + JC)
**Type:** Design-only — no implementation. Decision document.

---

## §0 — TL;DR

Cortex signs every envelope (stack NKey / ed25519 over the JCS-canonical `SIGNABLE_FIELDS`). That gives **integrity + authenticity**, not **confidentiality** — payloads are plaintext on the NATS bus and at rest in JetStream. That is fine today (single-principal meshes where the bus *is* the principal's own network). It stops being fine in Phase E: multi-network bridges and cross-principal federation push payloads onto subjects a **peer principal** can subscribe to and a network hub can read.

This doc recommends:

1. **Two layers, two jobs.** Wire-layer confidentiality (`tls://` leaf-nodes) protects bytes in transit; **payload-layer confidentiality** (sealed payload) protects content *from the peer principals and hubs that are legitimately on the bus*. TLS does not solve the federation threat because the peer is an authorized bus participant. Both layers are needed; they are independent.
2. **Sealed-payload pattern.** Encrypt `payload` (and only `payload`) to the recipient stack's public key with X25519 + an AEAD (NaCl `crypto_box` / libsodium sealed box semantics). Derive the X25519 keypair *deterministically from the existing ed25519 stack identity* — **no new long-term key material, no certs**. All envelope metadata (`sovereignty`, `source`, `type`, `correlation_id`, `target_assistant`, `signed_by[]`, `originator`, `distribution_mode`, `requirements`) stays cleartext so the bus routes and verifies exactly as today.
3. **Encrypt-then-sign: the existing `signed_by` chain signs the envelope *as it goes on the wire* — i.e. over the ciphertext.** The recipient verifies the signature on the sealed form, then decrypts. Recommendation + justification in §4.
4. **Scope-gated.** `local.` (intra-principal) needs **no** payload encryption — the bus is the principal's own trust domain. `federated.` / `public.` are the encryption surface. Encryption is a function of `sovereignty.classification`.
5. **Opt-in, never default.** Signing-only stays the out-of-box posture (ratified in cortex#369). Cortex must stay trivially deployable with zero cert/key ceremony. Encryption is enabled per network, with a transition window that accepts both cleartext and sealed payloads, and a loud-but-not-fatal warning when a stack federates without it.

The single most consequential decision in this doc is **#2 — sealed-payload keyed off the existing identity, not a per-network shared key, as the v1 mechanism.** Per-network shared keys are a documented later option for Offer-mode fan-out (§3.3, §5) but are not the v1 default because they reintroduce key-distribution ceremony and weaken the per-recipient confidentiality story.

---

## §1 — Threat model: what changes at the principal boundary

### §1.1 What ships today

- Every envelope is signed: the **stack** signs via `runtime.publish` using the stack NKey (ed25519 seed) over the JCS-canonical `SIGNABLE_FIELDS` (`signEnvelope` in `@the-metafactory/myelin/identity`; chain normalised by `getSignedByChain` in `src/bus/myelin/envelope-validator.ts`).
- `signed_by[]` is a **chain of stamps** — each stamp covers the prior chain, so tampering with an earlier stamp invalidates every later one.
- `originator` (myelin#161) is *inside* the signature — policy attribution is attestable.
- `sovereignty.classification ∈ {local, federated, public}` gates **routing** (which subjects an envelope may travel on, M1 leaf-node enforced) — it does **not** gate readability. A `federated` envelope is fully readable to any peer on that network.

The security property today is: **anyone with subscribe access to a subject reads the full payload.** Within one principal's private mesh that set is exactly "the principal's own stacks" — acceptable. The signature stops forgery, not reading.

### §1.2 What changes when a payload crosses the public internet (NZ ↔ Switzerland)

In Phase E, principal `andreas` (NZ) and principal `jcfischer` (Switzerland) peer their NATS servers via leaf-nodes (`docs/design-internet-of-agentic-work.md` §3.3). A dispatch from `andreas` to `jcfischer`'s `code-review.typescript` capability travels `federated.{principal}.{stack}.tasks.…` across that leaf-node link. The new adversaries are:

| Adversary | Position | Can they read the payload today? | What stops them |
|---|---|---|---|
| **Network path** (transit ISPs, internet between NZ and CH) | On the wire between leaf-nodes | Yes, if the link is plain `nats://` | **Wire layer:** `tls://` leaf-node — §2 |
| **NATS hub / relay host** | Runs a shared hub all peers connect through (hub-and-spoke network topology) | Yes — TLS terminates at the hub; the hub sees plaintext | **Payload layer:** sealed payload — TLS does NOT help; the hub is an authorized TLS peer |
| **Peer principal** (`jcfischer`'s stacks, beyond the one addressed) | Authorized subscriber on `federated.>` for the network | Yes — sovereignty gates routing, not reading; any peer on the network can subscribe to `federated.*.tasks.>` | **Payload layer:** sealed-to-recipient payload — §3 |
| **At-rest reader** (JetStream files on disk, on any stack that retains the stream) | Filesystem on the retaining node | Yes — JetStream persists payloads on disk | Out of scope for the *bus*: filesystem encryption (LUKS/FileVault) is principal infra. Sealed payload *also* protects at-rest for non-recipient stacks as a side effect — §6 |

The load-bearing insight: **the peer principal and the hub host are not outside attackers — they are legitimate, authorized participants on the federated bus.** TLS authenticates and encrypts the *link*; it cannot keep content from a party that is supposed to be on the link. Only payload-layer encryption, sealed to the intended recipient, removes a peer principal's and a hub's ability to read content they were never the addressee of.

### §1.3 What MUST stay cleartext (routing + trust invariants)

The bus routes and verifies on envelope metadata *before any application code runs*. These fields are encryption-exempt by construction:

| Field | Why it must stay cleartext |
|---|---|
| **subject** (`{scope}.{principal}.{stack}.{domain}.…`) | NATS routes on the subject string; leaf-nodes filter on it. Not part of the envelope body — it is the transport addressing. |
| `sovereignty` (`classification`, `data_residency`, `max_hop`, `frontier_ok`, `model_class`) | `validateSubjectEnvelopeAlignment` checks `classification` vs subject prefix at parse time; leaf-node hop budgets read `max_hop`; data-residency policy reads `data_residency`. All pre-decryption. |
| `signed_by[]` | Chain-of-stamps verification (`verifySignedByChain`, Phase B) runs on inbound *before* the recipient is even known to want the payload. Hop counting (`signed_by[].length` vs `max_hop`, Plan D.2.3) reads it. |
| `originator` | PolicyEngine resolves the policy actor (`getActorPrincipal`) pre-dispatch. Must be readable + signed. |
| `target_assistant` / `target_principal` | Direct/Delegate routing reads it to pick the recipient (and, for sealed payload, to pick the *encryption recipient* — §3). |
| `correlation_id`, `id`, `source`, `type`, `timestamp` | Correlation, dedup, audit, dispatch-sink reply routing all read these without the payload. |
| `distribution_mode`, `requirements`, `deadline`, `sovereignty_required` | Offer/Direct/Delegate selection + capability filtering happen at the JetStream consumer, pre-decryption. |
| `economics` | Already explicitly a *mutable, non-security* annotation (myelin architecture.md §5.2) — hubs aggregate cost; cannot be sealed. |

**What gets encrypted is exactly one field: `payload`** — the task content, the chat text, the dispatch body. Everything the bus needs to route, verify, gate, and account stays in the clear and stays signed.

---

## §2 — Wire layer: when to mandate `tls://`

Wire-layer TLS is **principal infrastructure**, not cortex code (M1 in the stack — `docs/design-internet-of-agentic-work.md` §1: "assume authenticated, encrypted, ordered byte streams"). The design position:

- **Single-stack / private mesh (`policy.federated.networks: []`):** `tls://` optional. The bus never leaves the host (or a firewalled LAN). Mandating TLS here is exactly the cert ceremony cortex#369 forbids out of the box.
- **Any federated leaf-node link:** `tls://` **strongly recommended and warned-on if absent.** A plain `nats://` leaf-node carrying `federated.>` across the public internet exposes payload *and* metadata to the network path. Cortex should emit a startup `system.error`-class warning (loud, non-fatal) when a `policy.federated.networks[].leaf_node` resolves to a non-TLS connection. This mirrors the §6 "federating without encryption" warning and uses the same warning channel.
- **Composition with leaf-node federation:** TLS is per-link, terminated at each leaf-node (and at any intermediary hub). It protects the hop, not the multi-hop path through a hub. This is *precisely* why §3 payload encryption is independent of and additive to TLS: TLS protects against the network path; sealed payload protects against the hub and the peer principal.

**Decision:** TLS is an operational mandate documented in the federation setup SOP and warned-on at runtime; it is not enforced in code (cortex does not own M1). It is **necessary but not sufficient** for the federation threat — §3 is the part cortex owns.

---

## §3 — Payload layer: the sealed-payload pattern

### §3.1 Mechanism

Encrypt the `payload` field to the **recipient stack's public key**, leave all metadata cleartext, sign as today.

**Key derivation — no new key material.** Each stack already holds an ed25519 NKey seed (its signing identity; `did:mf:{principal}-{stack}`) and publishes the corresponding ed25519 public key to the network registry as `principal_pubkey` (`src/services/network-registry/src/routes/principals.ts`, IAW D.4.2). ed25519 keys convert deterministically to X25519 (Curve25519) keys for Diffie–Hellman (the standard `crypto_sign_ed25519_*_to_curve25519` transform in libsodium). So:

- **No certs.** The X25519 keypair is derived from the same seed that already signs.
- **No new registry surface.** The recipient's encryption pubkey is a deterministic function of the `principal_pubkey` already in the registry. (A registry convenience field publishing the pre-converted X25519 pubkey is an *optional* optimisation, not a requirement — §5 / open questions.)
- **No new distribution channel.** Key distribution = the existing Phase D registry (§5).

**Sealed envelope shape.** The encrypted form replaces the cleartext `payload` body with a sealed container and marks it via an `extensions` flag (the schema already carries `extensions?: Record<string, unknown>` for exactly this kind of forward-compatible metadata):

```jsonc
{
  // ... all cleartext metadata unchanged: id, source, type, sovereignty,
  //     correlation_id, target_assistant, distribution_mode, originator, ...
  "extensions": {
    "enc": {
      "alg": "x25519-xchacha20poly1305",   // AEAD scheme id (versioned)
      "recipients": [                        // ≥1; see §3.3 for multi-recipient
        { "kid": "did:mf:jcfischer-sage-host", "epk": "<base64 ephemeral X25519 pubkey>" }
      ]
    }
  },
  "payload": {
    "ciphertext": "<base64 AEAD ciphertext>",
    "nonce": "<base64 nonce>"
  }
}
```

- `payload` stays a JSON object (schema-valid: `payload: Record<string, unknown>`), now carrying ciphertext instead of cleartext domain data — no schema change required to ship the *transitional* form.
- `extensions.enc` declares the scheme + recipient key-ids so the recipient knows which key to decrypt with and a non-recipient knows to skip. `alg` is versioned so the scheme can evolve.
- The AEAD's associated-data binds the ciphertext to the cleartext metadata (at minimum `id` + `type` + `sovereignty.classification`) so a hub cannot lift one ciphertext onto a different envelope header.

### §3.2 Why sealed-to-recipient (per-recipient) over per-network shared key as the v1 default

| | **Sealed-to-recipient (X25519 to stack pubkey)** ← recommended v1 | Per-network shared key |
|---|---|---|
| Key material | None new — derived from existing ed25519 identity | New symmetric key per network, generated + distributed out of band |
| Distribution | Existing registry (`principal_pubkey` already there) | New ceremony: generate, share, store the shared secret on every member stack |
| Who can read | Exactly the addressed recipient stack | Every member of the network |
| Compromise blast radius | One stack's key | The whole network's traffic, retroactively (if key is logged/persisted) |
| Rotation | Per-stack, via the existing key-rotation path (§4 / §5) | Network-wide re-key; coordinate all members |
| Fits Direct/Delegate | Natively (single named recipient) | Works but over-shares |
| Fits Offer (no named recipient) | **Awkward** — see §3.3 | Natively (anyone in the group decrypts) |

Sealed-to-recipient gives the strongest confidentiality (per-addressee), the least ceremony (no new keys), and reuses the registry. Its one rough edge is Offer mode, addressed next. Per-network shared key is retained as a **documented, opt-in, later option** specifically for high-fan-out Offer traffic where per-recipient sealing is impractical (§5, open question Q4).

### §3.3 Multi-recipient: Offer mode (capability fan-out) — who can decrypt?

The hard case. In **Offer** mode the envelope is published to a *capability* (`tasks.{capability}.{subcapability}`), and **any** capable assistant on the network may claim it via the JetStream queue group (competing consumers, exactly-once delivery). At publish time the publisher does **not know which stack will claim** — so it cannot seal to a single recipient pubkey.

Three candidate resolutions, in preference order:

1. **Per-network key for Offer traffic only (recommended for v1 Offer).** Offer envelopes on an encryption-enabled network are sealed with that network's shared key; Direct/Delegate stay sealed-to-recipient. This confines the weaker per-network model to exactly the case that needs it (no single recipient), keeps the strong per-recipient model for addressed traffic, and is a clean, explainable rule: *"Offer → network key; Direct/Delegate → recipient key."* The network key lives in `policy.federated.networks[]` config (one field), distributed once per network.
2. **Seal-to-all-candidates (multi-recipient box).** The publisher seals the payload to the X25519 pubkeys of *every* stack on the network that declares the capability (the registry knows capability→stack from the D.4 capability registration). The sealed container carries N per-recipient wrapped keys (`recipients[]` already plural in §3.1). Pro: no shared key; only declared-capable stacks can read. Con: publisher must enumerate candidates at publish time (registry lookup on the hot path), envelope grows with N, a stack that *joins* the capability after publish can't read a replayed envelope. Viable but heavier.
3. **Don't encrypt Offer payloads in v1; require Direct/Delegate for confidential cross-principal work.** Simplest, and arguably correct: confidential work usually *has* a known recipient. Offer is for "anyone competent, claim this" — often less sensitive. Document that confidential federated work uses Direct dispatch.

**Recommendation:** ship **option 3 as the v1 floor** (encryption requires a named recipient; Offer payloads stay cleartext-but-signed, gated by the same `federated.` warning), and offer **option 1 (per-network Offer key)** as the opt-in for networks that need confidential fan-out. Option 2 is recorded as a future enhancement if seal-to-all becomes necessary. This keeps v1 small and the strong per-recipient story intact, while giving a clear upgrade path. (Open question Q1/Q4 puts this in front of the principal + JC.)

---

## §4 — Interaction with signing: sign-then-encrypt vs encrypt-then-sign

The existing `signed_by` chain signs the **envelope as it goes on the wire**. The question is *what bytes the wire-going signature covers* once `payload` is sealed: the plaintext payload, or the ciphertext?

**Recommendation: encrypt-then-sign — the stack seals `payload`, then `signEnvelope` signs the SIGNABLE_FIELDS over the *sealed* envelope (ciphertext in `payload`, `extensions.enc` present).** I.e. the wire signature covers the ciphertext, not the plaintext.

Justification:

1. **Verify-before-decrypt is the safe order.** The recipient (and every hub / forwarding stack in the chain) must verify the chain-of-stamps and the sovereignty alignment *before* doing any work — including before decrypting. If the signature covered plaintext, a forwarder could not verify what it forwards (it can't decrypt — it's not the recipient), and the recipient would have to decrypt untrusted bytes before checking the signature. Signing the ciphertext lets every party verify integrity + authenticity + hop budget on exactly the bytes they hold, with no decryption capability required. This matches the cryptographic-doom-principle guidance: authenticate the ciphertext, then decrypt.
2. **The chain stays meaningful across hops.** Forwarding stacks append stamps (`signed_by[N]`) without ever seeing plaintext. The chain proves the *path* of the sealed object; the recipient additionally proves *content authenticity* via the AEAD tag (the AEAD's associated-data binds ciphertext to the envelope header, so the sender's authorship of *this* plaintext-for-this-header is established once the recipient decrypts and the tag verifies). Authorship is thus attested at two complementary layers: the chain (who handled it) and the AEAD (who sealed this content for this recipient).
3. **`signed_by` semantics don't change.** SIGNABLE_FIELDS already includes `payload` — by sealing `payload` *before* signing, the existing canonicalize + `signEnvelope` path needs **no change to what it signs**; it just happens to be signing ciphertext. `extensions` is the one field to confirm is inside SIGNABLE_FIELDS (so `extensions.enc` is tamper-evident); if it is not today, adding it is the single myelin-side change this composition needs (filed as a myelin primitive — §7).
4. **`originator` stays signed + cleartext.** Policy attribution is unaffected: `originator` is metadata, encrypted-exempt (§1.3), and already in SIGNABLE_FIELDS.

The rejected alternative, sign-then-encrypt (sign plaintext, then encrypt the signed blob), breaks hop-verification and the chain-of-stamps model: intermediaries could not verify, and the cleartext routing fields would either be encrypted (breaking routing) or live *outside* the signature (breaking tamper-evidence). Encrypt-then-sign is the only option compatible with cortex's existing cleartext-metadata + chain-of-stamps architecture.

**Net:** the stack's publish path becomes `seal(payload) → signEnvelope(sealed) → publish`. The recipient path becomes `verifyChain(sealed) → checkSovereignty(sealed) → decrypt(payload) → dispatch`. Verification is unchanged in *mechanism*; it simply runs against ciphertext.

---

## §5 — Key distribution: leverage the existing registry

No new distribution channel. The Phase D network registry (`src/services/network-registry/`, D.4) already does the hard part:

- Principals **register** a signed claim carrying `principal_pubkey` (ed25519), their `stacks`, and `capabilities` (IAW D.4.2, `principals.ts`). The registry verifies the principal's self-signature, enforces clock-skew + nonce replay protection, and stores the record.
- Peers **GET `/principals/{id}`** and receive a `SignedAssertion` — the registry signs the response so a caller verifies provenance before caching (`signAssertion`).
- Cortex consumes the registry at startup + on a refresh schedule (D.4.3 `RegistryClient`, the consumer follow-up).

**For encryption this means:**

- The recipient's **encryption pubkey is derived from the `principal_pubkey` already in the registry** (ed25519 → X25519, §3.1). Zero new fields strictly required.
- **Optional optimisation:** the registry record could publish a pre-converted `principal_encpubkey` (X25519) alongside `principal_pubkey`, so consumers skip the conversion and the registry attests the encryption key explicitly. This is a one-field additive change to `PrincipalRecord` / the registration claim, fully back-compatible (open question Q3).
- **Per-network key (the Offer option, §3.3 option 1)** is **not** a registry artifact — it is a shared secret and must never transit the registry in clear. It lives in `policy.federated.networks[]` config, distributed out of band (the same off-bus negotiation channel that establishes leaf-node peering, `docs/design-internet-of-agentic-work.md` §3.5). The registry is for *public* keys only.

### §5.1 Per-network vs per-assistant keys

The encryption recipient is the **stack** (`did:mf:{principal}-{stack}`), not the individual assistant. Rationale: the stack is the cryptographic signer (CONTEXT.md "Adapter signs as agent → stack signs"); it already holds the seed; it is the unit the registry tracks (`claim.stacks`). Sealing to the stack means the receiving cortex process decrypts once, then routes the plaintext to the right local assistant on its own (intra-principal = `local.`, no further encryption needed — §6). Per-assistant encryption keys would multiply key material and registry entries for no confidentiality gain over the principal boundary (the threat is *cross-principal*, and within a principal everything is already trusted). **Decision: seal to the stack key; assistants do not hold separate encryption keys.**

### §5.2 Rotation SOP

Rotation reuses and extends the registry's existing model. The registry **already declares its rotation stance**: v1 refuses silent pubkey swaps (`pubkey_rotation_not_supported`, 409) and pins rotation to a "transition claim co-signed by the previous key" as a documented v2 follow-up (`principals.ts` ~lines 109–126). Encryption keys ride that same transition mechanism because they are *derived from* the signing key:

| Step | Action |
|---|---|
| **Who rotates** | The principal who owns the stack. Rotation is initiated stack-side, never by a peer or the registry. |
| **How** | The stack generates a new ed25519 seed, then publishes a **transition claim** to the registry co-signed by the *previous* key (the registry's documented v2 rotation path). Because the X25519 enc-key is derived from the ed25519 key, rotating the signing key rotates the encryption key in lockstep — one ceremony, both keys. |
| **How peers re-key** | Peers refresh on the registry schedule (D.4.3) or on a registry publish event; the `SignedAssertion` carries the new `principal_pubkey`; consumers re-derive the X25519 key. Cached old keys expire on TTL. |
| **In-flight envelopes** | An envelope sealed to the *old* key remains decryptable only with the old key. The rotating stack **retains the previous seed for a grace window** (≥ the registry refresh interval + JetStream `max_age`, default 7d) to decrypt in-flight + replayed envelopes, then destroys it. Senders that have refreshed seal to the new key; the grace window covers the propagation gap. |
| **Per-network key rotation** (Offer option) | Network-wide re-key: the network coordinator distributes a new shared key out of band; members accept both old + new for a transition window (same dual-accept pattern as §6); old key retired after `max_age`. This is the heaviest rotation and is a reason to prefer per-recipient sealing. |
| **Compromise** | A compromised stack seed compromises both signing and decryption for that stack. Response: immediate rotation (above) + the network coordinator narrows that stack's `accept_subjects` until rotation completes. Per-recipient sealing confines the blast radius to one stack; per-network keys do not (another reason they are opt-in). |

The rotation SOP is documented in the federation setup SOP (companion to the §2 TLS guidance); the registry-side transition-claim verification is the registry's own v2 follow-up, which this design now has a second consumer for (signing **and** encryption).

---

## §6 — Scope-gating: encryption as a function of `sovereignty.classification`

Encryption is driven by the field that already exists for exactly this kind of scope decision:

| `sovereignty.classification` | Subject prefix | Encrypt payload? | Rationale |
|---|---|---|---|
| `local` | `local.{principal}.{stack}.…` | **No** | Never leaves the principal boundary (M1 leaf-node enforced). The bus is the principal's own trust domain; sealing intra-principal traffic adds cost + key ops for zero threat reduction. This is also what keeps the out-of-box single-stack deployment encryption-free. |
| `federated` | `federated.{principal}.{stack}.…` | **Yes, when the network has encryption enabled** | Crosses to peer principals; peer + hub are the threat (§1.2). |
| `public` | `public.…` | **N/A in v1 / case-by-case** | Public is unrestricted by definition. Public-mesh is out of scope across IAW phases (`plan` §Phase E E.4.3 is a reserved stub). If a public envelope carries confidential content sealed to a specific recipient, the sealed-payload mechanism still applies — but the default public posture is cleartext. |

The decision predicate is mechanical and lives next to the existing alignment check: `validateSubjectEnvelopeAlignment` already proves `classification` matches the subject prefix; the encryption gate is "if `classification === 'federated'` **and** the resolved network has `encryption: required|enabled` **and** the dispatch has a named recipient (or a per-network key), then seal." Everything keys off fields already on the envelope and config already in `policy.federated.networks[]`.

**Interaction with heartbeat (cortex#361) + originator (myelin#161):** both are **metadata, not payload**. Heartbeat / liveness envelopes and the `originator` field stay **cleartext and signed** — they must remain readable to the bus, hubs, and the dashboard for liveness + attribution + audit. They are encryption-exempt by the §1.3 rule. Nothing in this design touches them beyond confirming they stay in the clear.

---

## §7 — Phased rollout

Encryption is an **additive Phase E slice (E.7)** layered on top of Phase D federation. It does not block any earlier phase and does not change the wire for non-encrypting deployments.

### Decision (ratified posture, cortex#369)

- **Signing-only is the v1 / out-of-box default.** Confirmed.
- **Encryption is opt-in, per network.** A stack with `policy.federated.networks: []` or no `encryption:` key never touches encryption code.
- **Sealed-payload (per-recipient, X25519-from-identity) is the v1 mechanism.** Per-network shared key is the documented opt-in for Offer fan-out (§3.3).
- **Key rotation** rides the registry's existing transition-claim mechanism (§5.2).

### Config surface (one additive field)

```yaml
policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research
        encryption: required        # off (default) | enabled | required
        # off      — never seal (today's behavior; warn when federating)
        # enabled  — seal Direct/Delegate to recipient; cleartext fallback accepted on read
        # required — seal all eligible federated.* payloads; reject inbound cleartext federated payloads
        # offer_key_ref: <out-of-band key handle>   # optional; enables per-network Offer sealing (§3.3 opt-1)
        peers: [ ... ]              # existing D.1.1 schema
```

### Transition window (accept both)

During rollout a network member must **accept both** cleartext-but-signed and sealed payloads on inbound (`encryption: enabled` mode), keyed off the presence of `extensions.enc`. Once all members confirm, the coordinator flips the network to `encryption: required` (reject inbound cleartext `federated` payloads). Mirrors the dual-read transition windows already pervasive in the envelope (R2/R11/R13 vocab migrations, `target_assistant`/`target_principal`, `offer`/`broadcast`).

### Loud-but-not-fatal warning

When a stack opens a `federated` leaf-node link with `encryption: off` (or a non-TLS link, §2), cortex emits a startup warning via the **system event channel** (`system.error`-class, non-fatal — same channel as the §2 TLS warning). It does not refuse to start (that would break the out-of-box ergonomic) but it is visible in the dashboard + logs. "You are federating in the clear" is a posture the principal should *choose*, not stumble into.

### v1 vs later

| | v1 (this slice, E.7) | Later |
|---|---|---|
| Wire TLS | Documented mandate + runtime warning (§2) | — |
| Sealed payload, Direct/Delegate, per-recipient | ✅ | — |
| Scope-gating (`federated` only) | ✅ | — |
| Rotation (signing+enc lockstep, grace window) | ✅ (rides registry v2 transition claim) | — |
| Offer-mode confidentiality | Cleartext-but-signed (named-recipient required for confidential) | Per-network key (§3.3 opt-1); seal-to-all-candidates (opt-2) |
| Registry `principal_encpubkey` field | Optional; ed25519→X25519 derivation suffices | Registry-attested enc key |
| Public-mesh encryption | Out of scope | Post-IAW |

### myelin primitives to file upstream (§7 → myelin#NN)

Encryption touches the identity/crypto layer that myelin owns. File as a separate myelin issue once this design lands (per cortex#369 process):

1. **ed25519 → X25519 derivation helper** in `@the-metafactory/myelin/identity` (`deriveCurve25519FromEd25519(seed)` / `…FromPubkey(pub)`) — so cortex and peers derive identically.
2. **`sealPayload(envelope, recipientEncPubkeys[]) → sealedEnvelope`** and **`openPayload(sealedEnvelope, ownSeed) → envelope`** — AEAD seal/open producing the §3.1 shape, with associated-data binding to envelope header fields.
3. **Confirm `extensions` is inside SIGNABLE_FIELDS** (so `extensions.enc` is tamper-evident under the existing signature). If not, add it — this is the one change the encrypt-then-sign composition (§4) depends on.
4. **Registry transition-claim rotation** (already a myelin/registry v2 follow-up) — confirm it covers the derived enc key implicitly (it does, since the enc key derives from the rotated signing key).

---

## §8 — Open questions for the principal (+ JC)

1. **Q1 — Offer-mode confidentiality floor.** Accept §3.3 option 3 as the v1 floor (confidential federated work requires a *named* recipient via Direct/Delegate; Offer payloads stay cleartext-but-signed)? Or is confidential fan-out a v1 requirement, forcing per-network keys (option 1) into v1?
2. **Q2 — Stack-key reuse for encryption.** Confirm deriving the X25519 encryption key from the existing ed25519 stack seed (no new key material) is acceptable, vs. a separate dedicated encryption keypair. Reuse = zero new ceremony (the cortex#369 priority); a separate key = cleaner key-hygiene separation (signing vs encryption) at the cost of a second registry field + a second rotation. **Recommendation: reuse — it is what makes "no certs out of the box" true.**
3. **Q3 — Registry enc-key field.** Publish a pre-converted `principal_encpubkey` (X25519) in the registry record (registry-attested, saves a derivation), or derive client-side from `principal_pubkey` (zero registry change)? **Recommendation: derive client-side for v1; add the field later if a non-cortex peer can't do the conversion.**
4. **Q4 — Per-network key as opt-in.** Approve the per-network shared key strictly as an opt-in for Offer fan-out, never as the default mechanism — confining its weaker confidentiality + heavier rotation to exactly the case that needs it?
5. **Q5 — Rotation grace window.** Is "previous seed retained for ≥ JetStream `max_age` (7d default) + registry refresh interval" the right grace window for decrypting in-flight + replayed sealed envelopes? Does it need to be configurable per network?
6. **Q6 — `required` strictness.** When a network is `encryption: required`, should an inbound *cleartext* `federated` payload be **rejected** (emit `system.access.denied`, reason `payload_not_sealed`) or **quarantined + warned**? Rejection is the secure default; quarantine eases debugging during cutover.
7. **Q7 — At-rest scope.** Confirm at-rest JetStream confidentiality stays **principal infrastructure** (filesystem encryption), out of bus scope — with sealed payload providing incidental at-rest protection on non-recipient stacks as a bonus, not a guarantee.
8. **Q8 — Session prerequisite.** cortex#369 calls for a 30-min design session with JC (encryption touches myelin primitives §7). Schedule before filing the myelin issue, or file the myelin issue as a strawman to anchor the session?

---

## §9 — Summary of decisions

| # | Decision | Status |
|---|---|---|
| D1 | Signing-only is the out-of-box default; encryption opt-in per network | Ratified (cortex#369) |
| D2 | Sealed-payload, per-recipient, X25519 derived from existing ed25519 stack identity, is the v1 mechanism | **Recommended** |
| D3 | Encrypt `payload` only; all routing/trust/sovereignty metadata stays cleartext + signed | **Recommended** (firm — required by routing) |
| D4 | Encrypt-then-sign — wire signature covers ciphertext; verify-before-decrypt | **Recommended** |
| D5 | Seal to the **stack** key, not per-assistant | **Recommended** |
| D6 | Encryption gated on `sovereignty.classification === 'federated'` + network `encryption` flag; `local` never encrypts | **Recommended** |
| D7 | Per-network shared key is opt-in for Offer fan-out only | **Recommended** (Q1/Q4) |
| D8 | Rotation rides the registry transition-claim mechanism; signing+enc keys rotate in lockstep; grace window for in-flight | **Recommended** (Q5) |
| D9 | TLS leaf-nodes are a documented mandate + runtime warning, not code-enforced (M1 = principal infra) | **Recommended** |
| D10 | myelin primitives (derivation, seal/open, SIGNABLE_FIELDS `extensions`) filed upstream as a separate myelin issue | Action (§7) |
