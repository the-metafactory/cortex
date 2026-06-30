# Design: self-hostable + peerable registry (signed network manifest)

**Status:** design / spec (implementation deferred pending JC/Luna approval; prerequisite #1321 ✓ merged) · **Date:** 2026-06-29
**Issue:** #1322 · **Parent:** #110 · **Depends on:** #1321 (per-network admin in schema)
**Refs:** companion research PR #1319, ADR-0003 (network-join control plane), ADR-0013 (sovereign federation), ADR-0015 (admission mints nothing), ADR-0020 (`docs/adr/0020-per-network-admin-authority.md` / #1321), ADR-0005 (session-interior / cortex↔signal boundary), CONTEXT.md §Joining a network / §boundary-with-signal

> SPECIFY+PLAN artifact for #1322. The design's open questions have since been
> **resolved with JC (2026-06-29)** — see the Decisions section below. #1321 has
> merged; **implementation still waits on JC/Luna approving this design.**

## Problem

Discovery is registry-mediated through a **single hosted service**
(`network.meta-factory.ai`): the principal pubkey directory, the network
descriptor (`hub_url`/`leaf_port`), and the roster. Every principal pins this one
registry (`policy.federated.registry.{url,pubkey}`). The registry's *role* is
correct — it is the **"DNS of the federation"**, the thin trust anchor that
issues no identity and signs no credential (ADR-0013). The problem is only that
it is **the** registry, not **a** registry: there is no way to run your own, and
the checked-in control-plane docs expose registry-mediated discovery plus
hand-pinned fallbacks, not a peer-to-peer discovery mechanism.

The governing premise for this slice is: **keep a thin anchor** (RPKI is rooted
in the RIRs, DNS in the root, CT in root programs) — do **not** chase trustless
P2P. So this is *un-monopolise*, not *abolish*.

## Goal

Anyone can run a registry; others point at it. Registry-as-default-transit, not
registry-as-authority. A principal pins **admin DIDs** (the thin anchor), not a
central URL, and verifies a **portable signed manifest** offline.

## Non-goals

- Abolishing the registry / pure trustless P2P.
- A DHT (at tens of principals it degenerates to a full mesh — pure overhead).
- Agent/peer **presence** + the MC Network view — that's cortex's own `agent`-domain
  lifecycle (`agent.{online|heartbeat|offline|capabilities-changed}`, CONTEXT.md
  §Agent presence), not this registry spec. Session-interior / trace observability
  is signal's domain (CONTEXT.md §boundary-with-signal, ADR-0005). This design is
  cortex control-plane only: a stack's own join/anchor config.
- An admission-credential / offline-roster-proof follow-on (see below) — separate scope.

## Design

### 1. Portable signed network manifest

The registry descriptor is already the control-plane shape a joiner needs:
topology plus roster, consumed through the existing pinned-registry compatibility
path. The registry remains a pubkey directory, not a CA; this design promotes
that descriptor into a self-contained, relocatable **network manifest** that is
verifiable **offline** against pinned admin DIDs:

```
NetworkManifest {
  network_id
  hub_url, leaf_port              // topology (today's descriptor)
  admin_dids[]                    // the network's admins (from #1321 admin_pubkeys, as DIDs)
  roster[] { principal_id, stack_id, stack_signing_pubkey }   // discovery/recognition only (DD-5)
  issued_at, expires_at
  signature                       // by a network admin DID (not a hosted-registry key)
}
```

Key shift from today: the manifest is signed by a **network-admin DID** (the
authority a joiner already trusts via #1321), so it no longer *requires* the
hosted registry's signing key as a trust anchor — that key is transport /
back-compat metadata, never trust. The manifest can be served from
**anywhere**: git, an HTTPS file, a NATS object-store bucket, or the existing
hosted registry. Verification is **offline** against the pinned admin DID set.

The manifest roster is a signed **discovery/recognition cache only**. A roster
entry says "this principal/stack is recognized as admitted by this network's
admin"; it does **not** grant bus access, mint a NATS account, create a leaf
secret, widen `accept_subjects`, install export/import wiring, or authorize
payload decryption. Transport access remains independently gated by ADR-0013's
leaf-secret-authenticated pipe plus each side's local export/import and
acceptance policy. Admission remains ADR-0015-compatible: it mints nothing.

### 2. Pin admin DIDs, not a URL

Generalise the pin (`policy.federated.registry`):

```
policy.federated:
  trust_anchors:                 # NEW — the thin anchor: who may sign a manifest
    - did: did:web:meta-factory.ai:andreas
  manifest_sources:              # NEW — one OR MORE places to fetch the manifest
    - https://network.meta-factory.ai/networks/{id}    # the hosted registry stays a default source
    - https://raw.githubusercontent.com/.../networks/{id}.json
    - nats://object-store/networks/{id}
  registry: { url, pubkey }      # KEPT, deprecated-but-supported (back-compat)
```

For the new manifest path, a manifest is accepted iff its signature verifies
against a pinned `trust_anchor` DID. The legacy hosted-registry path remains a
separate compatibility path: existing `registry: { url, pubkey }` pins continue
to use the hosted-registry response verifier against the pinned registry pubkey
until a stack opts into `trust_anchors[]`. All reachable sources are fetched and
verified; **freshness wins over reachability**: the manifest with the
newest valid `issued_at` is selected, so a reachable source serving an older
(still-unexpired) manifest cannot shadow a newer one. Cache is used only when no
valid source is reachable — DD-10 cached-fallback covers *unreachable*, not
*stale-but-up*. The hosted registry remains a valid (default) source.

### 3. Per-principal endpoint self-publication

Decouple stable identity from physical endpoint (the Matrix `.well-known`
pattern): a principal publishes its current endpoint under its own control —
`https://{principal-domain}/.well-known/metafactory/stack.json` or DNS
`SRV _mf-leaf._tcp` + `TXT`. The manifest pins the **identity/keys**; the
well-known/DNS record updates the **location** unilaterally. Optional and
additive — hand-pinned peers (today's offline fallback) still work.

### 4. No DHT, no gossip (yet)

At tens of principals, a signed manifest + multi-source fetch is sufficient.
Live membership (SWIM-style gossip) is a later option only if real-time
up/down membership is needed; it would run *under* the manifest's trust model.

## Trust model

- **Anchor:** the pinned network-admin DID set (#1321 makes per-network admins
  real; this design lets a manifest be signed by them). Thin, replaceable,
  explicit — exactly the RIR/DNS-root/CT pattern the research endorsed.
- **Verification:** offline signature check against pinned anchors. No hosted
  service must be online or honest for a cached manifest to be trusted.
- **Revocation/freshness:** `expires_at` + re-fetch; short manifest lifetimes
  over online revocation. (Admission credentials, below, sharpen this.)

### Admin-set authority and ADR-0020

There are two authority modes, and the verifier MUST NOT blur them:

1. **Hosted registry mode (ADR-0020 / #1321).** Network create remains a
   hierarchical allocation act: only a global admin may set the initial
   `admin_pubkeys`. A per-network admin may update topology and admit members,
   but may not set/change `admin_pubkeys`; that anti-self-escalation gate fails
   closed with `403 admin_pubkeys_requires_global_admin`.
2. **Self-hosted manifest mode (this design).** There is no global admin above a
   sovereign network. The authority root is the joiner's already-pinned
   `trust_anchors[]`, resolved to Ed25519 verification keys. A manifest may
   rotate or change `admin_dids[]` only if the update is signed by an
   already-pinned anchor, then explicitly persisted as the new pin set. A
   self-declared first manifest cannot bootstrap its own admin set.

That second mode is coherent, but it is a different privilege model from the
hosted registry's global-admin anti-self-escalation rule. Slice 1 must therefore
ship with an ADR-0020 amendment or a new ADR that names this pinned-anchor +
key-continuity model before the offline verifier is treated as the trust model.

### Residual risks to carry into slice 1

- **Revocation latency:** offline pinning has no live revocation channel. The
  24h `expires_at` default is therefore the v1 compromise-recovery bound unless
  an admin performs an out-of-band re-pin sooner.
- **Rollback window:** "freshness wins" only compares reachable valid sources.
  A joiner that can reach only a malicious source can be rolled back to an
  older-but-unexpired manifest inside the lifetime window.
- **Rotation is explicit:** `did:web` names are not implicitly re-resolved for
  trust. Key/DID-document-hash rotation is an out-of-band signed re-pin, not an
  automatic DNS/HTTPS update.
- **1-of-N signing blast radius:** v1 accepts a manifest signed by any one
  pinned admin DID. One compromised admin key can forge the whole manifest and
  roster until expiry/re-pin. M-of-N admin signing is the future hardening path.
- **`network_id` is anchor-relative:** once manifests are self-hosted, two
  networks can both claim `network_id: acme` under different admin anchors. This
  is not a trust break, but config and UX must treat `network_id` as meaningful
  relative to the pinned anchor (or namespace it by anchor) rather than globally
  unique.

## Control-plane / wire-protocol compliance

Control-plane only. No subject shape, no envelope field, no
`selectLink`/`source`/`originator` change — discovery/anchor config never appears
on the wire; the network stays a topology fact resolved from `peers[]`
(federation-wire-protocol SOP check 1). cortex↔signal split honoured: this is a
stack's own anchor/join config, not network-wide observability.

## Dependencies & staging

1. **#1321** (per-network admin) — prerequisite: the manifest is signed by a
   per-network admin DID, which #1321 introduces.
2. Manifest schema + offline verifier (generalise the existing registry response
   verifier to "verify against any pinned anchor DID").
3. `policy.federated.trust_anchors` + `manifest_sources` config (back-compat with
   `registry.{url,pubkey}`).
4. Multi-source fetch with ordered fallback (generalises DD-10 cached-fallback).
5. (Optional, later) per-principal `.well-known`/DNS endpoint publication.

## Follow-on (separate issue, NOT this scope)

**Offline roster proof** — let a peer verify roster membership *offline* from a
signed, cacheable **membership assertion** (the network-admin DID signs "X is on
network Z's roster"), instead of a live roster lookup. Admission still **mints
nothing** (ADR-0015) — this is a verifiable cache of roster state, not an issued
bearer credential.

> **Boundary note (do not silently cross):** turning this into attenuable bearer
> tokens (Biscuit / JWT-VC, object-capability style, with TTLs + a CT-style
> append-only log) would make admission *issue credentials* — which **reverses
> the ADR-0015 "admission mints nothing" boundary**. That is a deliberate
> architecture change requiring its own ADR + a CONTEXT.md update before adoption;
> it is recorded here as a possibility, not a decision. Same Ed25519 primitive the
> nsc nkeys use. File separately when/if pursued.

## Constraint surfaced by the #1321 review (Luna)

Both #1321 gates keep the `REGISTRY_ADMIN_PUBKEYS`-empty → **503 fail-closed
FIRST** ordering: a per-network admin cannot operate on a registry with no
**global** admin configured. That is correct for the hosted `metafactory`
registry — but a **self-hostable registry is exactly the no-global-admin case**.
This design MUST therefore relax that coupling: on a self-hosted manifest/registry,
there is no global super-admin above the network. The fail-closed condition becomes
"no pinned trust anchor configured" rather than "no global admin configured". The
trust anchor is the joiner's pinned per-network admin DID/key set, and changes to
that set follow the key-continuity rule in [Admin-set authority and ADR-0020](#admin-set-authority-and-adr-0020).
Carry this into the manifest-verifier + any self-host registry mode.

## Decisions (resolved with JC, 2026-06-29)

1. **DID method — `did:web` for durable principals/admins; `did:mf` remains the
   stack identity.** Principals get rotatable, domain-anchored
   `did:web:meta-factory.ai:andreas`. Stack signing identities stay aligned with
   CONTEXT.md: `did:mf:{principal}-{stack-leaf}` (derived from `stack.id`, e.g.
   `did:mf:andreas-meta-factory`). #1321 stores raw base64 pubkeys today; a thin
   verifier adapter may internally treat a raw Ed25519 verification key as
   self-certifying, but that does not replace the public stack DID used on the
   wire or in the glossary.
   **Security — pin the key, not just the name:** a pinned `trust_anchor` MUST
   store the resolved Ed25519 verification key (or a hash of the DID document),
   not merely the `did:web` URL — otherwise verification depends on live DNS/HTTPS
   and a domain/CA compromise could swap the manifest-signing key (breaking the
   offline-trust property). Stack `did:mf` resolution remains the existing
   stack-signing-key path; `did:web` **rotation** is therefore an explicit,
   signed update to the pinned anchor set, never an implicit re-resolve.
2. **First alternate manifest source — git / HTTPS file.** A signed manifest JSON
   served from a git repo or any HTTPS host: simplest to stand up + audit (free
   version history). NATS object store + others come later. The hosted registry
   stays a default source throughout (back-compat).
3. **Manifest lifetime (`expires_at`)** — **24h, tunable per network**
   (short enough to bound revocation latency, long enough to avoid churn).
   Revisit alongside the admission-credentials follow-on.
4. **Per-principal `.well-known`/DNS endpoint publication** — **deferred** until a
   principal actually needs to relocate a stack endpoint (not in the first slices).

## Implementation slices (Stage 2)

1. **Manifest schema + offline verifier** — define `NetworkManifest`; generalise
   the existing registry response verifier to "verify against ANY pinned
   trust-anchor DID" (`did:web` principal/admin anchors and canonical stack
   `did:mf` resolution to Ed25519 pubkeys). Tracer bullet.
2. **Pin config** — `policy.federated.trust_anchors[]` (admin DIDs) +
   `manifest_sources[]`, back-compat with `registry.{url,pubkey}`.
3. **git/HTTPS manifest fetcher** — fetch reachable sources, verify offline
   against pinned anchors, select the newest valid `issued_at`, and use cache only
   when no valid source is reachable (generalises DD-10).
4. (later) NATS object-store source; per-principal `.well-known`/DNS.
