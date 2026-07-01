# Research: should cortex federation decentralise? (registry / hub / admin)

> **Re-landed post-hoc (2026-07-02, C-1353).** This document was reviewed **APPROVE** for claim-accuracy on 2026-06-30 (PR #1319), then closed **unmerged** by a history-rewrite auto-close — not a review rejection. It is re-landed here **verbatim** because `docs/adr/0020-per-network-admin-authority.md` cites it as the canonical rationale and it remains the narrative source for the staged issues (#1320 and #1322 open; #1321 shipped). Since the research was written, its recommendations have moved into implementation: **Stage 1** (#1321) has shipped via **PR #1323 + ADR-0020**; **Stage 0** is tracked in **#1320**; **Stage 2** in **#1322**. The staging table in §5 preserves the original research framing unchanged.

**Status:** research + recommendation · **Date:** 2026-06-29 · **Author:** JC (with Ivy + 4 parallel research agents)
**Prompted by:** Luna's onboarding-surfaced architecture question — "if this is TCP/IP for agentic work, why does one node run the whole thing?"
**Refs:** ADR-0001 (subject grammar), ADR-0003 (network-join control plane), ADR-0013 (sovereign federation / Model B), ADR-0015 (two-tier onboarding + admission gate), ADR-0018 (admission gate + leaf-secret distribution), `docs/sop-federation-onboarding.md`, `docs/sop-network-registry.md`

---

## TL;DR

cortex is **already ~80% decentralised** — and Luna's framing, while pointing at three real problems, over-states the centralisation by conflating three independent axes.

The leaf-secret-authenticated pipe + per-side export/import that ADR-0013 ("Model B") already shipped **is literally BGP peering**: bilateral, each side wires its own half, a shared secret authenticates the transport, and *no operator account trusts another operator account's root.* Each principal runs their own nsc operator — that is genuine, structural sovereignty at the identity + transport layer. That part is done and right; do not touch it.

What remains central is **three meta-layer artifacts, and they decentralise independently — with different answers each:**

| Axis | Today (central) | The internet's verdict | Recommendation |
|---|---|---|---|
| **Transport topology** | metafactory + metafactory-community share ONE hub (`nats.meta-factory.dev:7422`) | Don't let one node monopolise reach (XMPP collapse) | **Split the hub** — cheap, do first |
| **Admission** | ONE registry-wide allowlist (`REGISTRY_ADMIN_PUBKEYS`), **no per-network admin in schema** | Peering/admission is bilateral & self-governed (BGP, Mastodon) | **Per-network admin DID** — the real fix |
| **Discovery / trust anchor** | ONE registry (`network.meta-factory.ai`) | Keep a *thin, replaceable* hierarchical anchor (RIR/RPKI/DNS-root) | **Self-hostable, peerable, signed manifest** — keep but un-monopolise |

**The decision is NOT "rewrite as pure P2P."** The internet itself never did that: every layer (RPKI, DNS, Certificate Transparency) keeps a thin hierarchical trust anchor, and almost nobody runs their own Autonomous System — most buy transit. Copy the *split*, not the slogan. Each cortex network keeps exactly one irreducible root — its admin DID — and that's not centralisation, it's the network defining "who is us."

This is **evolutionary, not revolutionary**: it's the natural completion of ADR-0013 (which already made the registry "identity-only") and ADR-0015 (which already built `register → PENDING → grant` as an admission gate). The gap is just that the gate is still registry-wide-admin and the registry is still a single hosted service.

---

## 1. What cortex already decentralises (ground truth, cited)

Per ADR-0013 (accepted 2026-06-18) and the code:

- **Each principal runs their own NSC operator** (`OP_JC`, `OP_ANDREAS`). Nobody's identity is hosted in anyone else's operator. NSC is a self-sovereign trust root — a server needs only its own operator key to validate its own JWTs. (`docs/adr/0013` §Decision-1..4)
- **The leaf link is a secret-authenticated transport pipe, not a cross-operator JWT-trust handshake.** Each side binds the link to a **local** account in its **own** operator. "Sovereignty is structural — it falls out of the pipe + per-side control, not from a trust protocol." (ADR-0013 §Decision-1)
- **Export/import that bridges `federated.>` is purely local** — single-store, single nsc operator, each principal wires their own half via `arc nats add-federation-export`. (ADR-0013 §Decision-2; `src/cli/cortex/commands/network-federation-wiring.ts`)
- **Per-stack signing keys are self-sovereign** — minted locally (`cortex provision-stack generate`), registered to the registry but never issued *by* it. (`src/cli/cortex/commands/network.ts`; registry stores `StackIdentity.stack_pubkey` only as a directory entry)
- **The registry is already "DNS, not CA"** — a pubkey directory + network descriptor, carrying no account-topology material and issuing no credential/trust. Its GET directory reads are returned as `SignedAssertion`s for *transport integrity* (clients pin `policy.federated.registry.pubkey` and verify the bytes; error/404/503/rate-limit bodies are unsigned) — a response-integrity signature, **not** a trust authority. (ADR-0013 §Consequences; `src/services/network-registry/src/signing.ts`)

**This maps one-to-one onto how the internet is decentralised**: sovereign identity per principal (≈ your own keys), bilateral secret-authenticated peering (≈ BGP sessions with MD5/TCP-AO), each side configuring its own filters (≈ per-AS route policy). cortex got the hard part right.

## 2. What is still central, and exactly where

1. **The registry** — `src/services/network-registry/` (CF Worker at `network.meta-factory.ai`). Single hosted service for: principal pubkey directory (`GET /principals/{id}`), network descriptors (`GET /networks/{id}` → `hub_url`, `leaf_port`), roster, capability search. All discovery is registry-mediated or hand-pinned; **no peer-to-peer discovery exists.**
2. **The admission authority** — `REGISTRY_ADMIN_PUBKEYS` (env, `src/services/network-registry/src/index.ts:71-77`). A **registry-wide** allowlist gating `POST /networks/{id}` (`routes/networks.ts:77-87`). **There is no per-network admin field in the schema** (`NetworkRecord` in `types.ts` carries topology + `updated_at`, no admin field). One global authority can create/admit for every network. *This is the actual bug Luna found.*
3. **The shared hub** — both `metafactory` and `metafactory-community` resolve to the same hub (`tls://nats.meta-factory.dev:7422`, per the onboarding-SOP topology examples + #1261; verify against the live registry descriptors before acting). One physical hub carries two networks whose trust postures differ (one is public-facing). Coupling, not architecture.

## 3. What the internet actually teaches (anti-naive-P2P)

The honest lesson from four research streams (BGP/RIR/RPKI, DNS, email, Matrix, ActivityPub, XMPP, Nostr, SSB, Certificate Transparency):

- **The internet is decentralised in *peering*, hierarchical in *identity allocation + trust-rooting*.** ASNs come from a strict IANA→RIR hierarchy (global uniqueness), but *connectivity* is bilateral and self-governed. RPKI — the cryptographic "trustless-looking" fix for BGP hijacks — **is rooted in the five RIRs.** You always end up with a trust anchor; the design choice is where you put it and how thin you keep it.
- **Almost nobody runs their own AS.** Running one needs an ASN, IP space, BGP gear, expertise. Most orgs *buy transit*. "Every principal runs their own registry + hub + admin" is the "everyone runs their own Tier-1" fantasy. Make self-hosting *possible* (no lock-in), make *consuming a default* (transit-by-default).
- **Keep the waist narrow** (hourglass model). Standardise the *minimum* — envelope schema, addressing, identity-proof format (cortex's M3 envelope is exactly a candidate waist). Let policy/adapters/federation agreements vary freely. The more you push into the shared standard, the more central agreement you force.
- **Recentralisation comes through admission, abuse-defense, and defaults — never the wire protocol.** Email stayed "open" and recentralised into Gmail/Spamhaus because open admission made spam free and the inevitable reputation gatekeeping concentrated power covertly. XMPP collapsed because one dominant node could revoke federation unilaterally (Google, 2013). Matrix/Nostr/Mastodon nominally decentralised but reconcentrated onto convenient default nodes. **Certificate Transparency is the positive model**: decentralised issuance stays honest via a public append-only verifiable log + credible eviction — detection beats gatekeeping.

## 4. Recommendation

### 4.1 Transport — split the shared hub *(do first, cheap)*
metafactory and metafactory-community must not share `nats.meta-factory.dev:7422`. Give each network its own hub endpoint (the descriptor already supports per-network `hub_url`). A public-facing network sharing a hub with an internal one is the XMPP dominant-node / blast-radius risk in miniature. A hub itself is fine to share (it's an IXP / transit point); coupling two *trust domains* onto one is not.

### 4.2 Admission — per-network admin DID *(the real fix)*
Add a per-network admin to the schema and check it instead of the global allowlist:
- `NetworkRecord` gains `admin_dids: string[]` (or admin pubkeys). (`src/services/network-registry/src/types.ts`)
- `POST /networks/{id}` and the ADR-0015 admission-grant path verify the signer against **that network's** admin set, not `REGISTRY_ADMIN_PUBKEYS`. (`routes/networks.ts`, `routes/admission-requests.ts`)
- `REGISTRY_ADMIN_PUBKEYS` is retained only as the bootstrap admin for the `metafactory` network — backward compatible.
- Each network becomes sovereign over its own roster — AS autonomy / Mastodon per-instance peering. This is the completion ADR-0015 implied but didn't reach.

### 4.3 Discovery / trust anchor — self-hostable, peerable, signed manifest *(keep, un-monopolise)*
Do **not** abolish the registry — that's the load-bearing RIR/DNS-root anchor. Instead make it not-the-only-one:
- The network descriptor + roster is already a `SignedAssertion`. Make it a **portable signed manifest** (list of members, admin DIDs, endpoints) that can be served from anywhere — git, HTTPS, NATS object store — and verified offline against pinned admin DIDs. (Tailscale "tailnet lock" / Matrix `.well-known` pattern.)
- Principals **pin admin DIDs, not a central URL.** Anyone can run a registry; others point at it. Registry-as-default-transit, not registry-as-authority.
- Per-principal endpoint location via self-published `.well-known` / DNS SRV+TXT (decouple stable identity from physical endpoint). Optional seed+gossip (SWIM) only if/when live membership is needed. **No DHT** — at tens of principals it degenerates to a full mesh anyway.

### 4.4 Trust model — admission credentials over allowlists *(later, optional)*
"Principal X admitted stack Y to network Z" becomes an **admission credential** — an attenuable, offline-verifiable token in the object-capability style (Biscuit — public-key-verifiable, offline-attenuable — or a signed JWT-VC if attenuation isn't needed) issued by the network-admin DID, held by Y, verified locally by any peer against X's pubkey. (Note: "admission credential" here is a *trust token*, distinct from cortex's canonical **Capability** = a bus-routable ability.) The central member-table collapses to **a small set of trusted admin DIDs**. Prefer **short-TTL admission credentials** (expire-and-re-issue) over online revocation; borrow CT's posture — an append-only log of admission events every principal can monitor. Only pursue this once §4.2 lands and P2P attenuation is actually needed; keys are Ed25519, the *same primitive NSC nkeys already use*.

## 5. Staging & reversibility

| Stage | Change | Effort | Reversible? |
|---|---|---|---|
| 0 | Split metafactory / community hubs | low | yes (descriptor flip) |
| 1 | Per-network `admin_dids` in schema + checks; global allowlist → metafactory bootstrap only | medium | yes (allowlist retained) |
| 2 | Registry → self-hostable signed manifest; pin admin DIDs not URL; per-principal `.well-known` | medium-high | yes (central registry stays a default) |
| 3 | Admission credentials (Biscuit/VC, object-capability style) + transparency log | high | additive |

Each stage is independently shippable and respects ADR-0013/0015. Stage 0+1 already answer Luna's question in practice (per-network sovereignty + no single dominant transport). Stage 2+3 complete the "run-your-own-registry, peer P2P" vision without ever chasing trustless purity.

## 6. The one irreducible residual

You can decentralise *admission* fully. You **cannot** eliminate *some* agreed-upon root of authority per network without also eliminating the ability to say "this principal is not one of us." Each network keeps exactly one root — its admin DID. Mitigate its blast radius with did:web (rotatable) + HSM or M-of-N threshold signing, and short admission-credential TTLs. That residual is a feature, not a failure: it's precisely what BGP's RPKI, DNS's root, and CT's root programs all kept — and what email's refusal to have it cost it its decentralisation.
