# Design — Network-admission gate + leaf-secret distribution (C-1142 R1)

**Status:** DESIGN — HELD for Andreas's review. No implementation, no PR until the load-bearing
secret-distribution decision (§7, Q1) is made.
**Feature:** cortex#1142 R1 — "repurpose O-4a `register→PENDING→grant` as the network-admission gate."
**Authority:** [ADR-0015](adr/0015-two-tier-onboarding-and-admission-gate.md) (admission gate = identity-level
approval, mints nothing) · [ADR-0013](adr/0013-sovereign-federation-model.md) (sovereign federation; leaf =
secret-authenticated pipe) · `CONTEXT.md` §"Network-admission gate" + §"Joining a network".
**Scope:** the two halves of R1 — (1) the admission gate, (2) leaf-secret distribution (the one net-new
cross-party security surface).

---

## 0. TL;DR for the reviewer

- **Half 1 (admission gate) is ~80% already built.** The `register → PENDING → ADMITTED` state machine, the
  admin-signed admit/reject/list routes, the D1 + in-memory stores, migration `0007`, and the `cortex network
  admit` CLI all exist on this branch's base. R1's remaining work is **three small wiring gaps** (§3.2), not a
  new subsystem.
- **Half 2 (leaf-secret distribution) is 100% net-new and undesigned.** Today the leaf shared secret is
  **out-of-band** (ADR-0013 consequence; SOP-federation-onboarding §6). ADR-0015 + `CONTEXT.md` §188 say
  admission "hands you the leaf shared secret" — but **no mechanism exists**. This doc designs it.
- **There is a documented tension to resolve** (§7 Q1): ADR-0013 says the leaf secret is "exchanged
  out-of-band"; ADR-0015/`CONTEXT.md` say it is "handed on admission." These can be reconciled, but the
  reconciliation **changes the registry's security posture** (today it "signs nothing, holds no secret"). That
  is the load-bearing decision and the reason this is HELD.
- **Recommendation (§6):** generate the PSK **hub-side, per-member**, **seal it to the joiner's already-registered
  pubkey** (sealed-box / X25519), and let the registry carry the *opaque ciphertext* only. The registry never
  sees plaintext, so the "registry holds no readable secret" invariant survives, proof-of-possession is
  intrinsic (only the registered private key decrypts), and revoke is per-member. A simpler **concierge
  out-of-band** path is the acceptable v1 fallback if the sealing plumbing is too heavy for the first slice.

---

## 1. What R1 is (and is not)

R1 repurposes the hub-minted-identity `register → PENDING → grant` machinery as an **identity-level admission gate** for a
private network's roster. Per ADR-0015:

> The `register → PENDING → grant` flow is repurposed as the network-admission gate. … It **mints nothing** — it
> gates roster membership, not credentials.

So R1 is two things:

1. **The gate** — *who* is let onto a network's roster. A sovereign joiner registers (proof-of-possession of
   their own key) → raises a PENDING admission request → an admin (or admin-agent, e.g. Luna via FleetAdmit)
   approves → the joiner is a recognized peer on the roster. **Mints no credential, no account.**
2. **The one thing that DOES cross the principal boundary on admission** — the **leaf shared secret** (the NATS
   leafnode `authorization { user, password }` PSK). This is *not* an identity credential (ADR-0013: "the only
   thing crossing the principal boundary is the leaf shared secret … never an identity credential"), but it IS a
   secret that must travel from the hub admin to the admitted joiner. Designing that hand-over safely is the
   substance of R1.

R1 is **not**: minting accounts, issuing `.creds`, or any hub-minted-identity machinery (retired under R2). It is **not** the
NATS-server-side leaf topology config (that is hub-local, provisioned by the hub admin on their own infra) —
except insofar as the secret the joiner receives must match what the hub's `authorization` block accepts (§5.3).

---

## 2. Two trust layers (why a leaked PSK is bounded)

The whole design rests on ADR-0013's structural-sovereignty point: **the leaf secret is a transport PSK, not an
identity.** Trust is two-layered (`CONTEXT.md` §188):

| Layer | Artifact | What it grants | What it does NOT grant |
|---|---|---|---|
| **Transport** | leaf shared secret (PSK) | attach a leaf link to the hub; carry `federated.>` frames | any identity; any peer's acceptance |
| **Identity / acceptance** | per-principal `signed_by[]` chain + per-principal accept-policy (`network:<id>` or `principals:[…]`) | being *accepted* by a peer who pinned you / your network | nothing transport-level |

Consequence for the threat model: **a compromised leaf secret lets an attacker attach to the medium and
publish/subscribe on `federated.>` — but they still cannot forge a signed envelope (no signing key) and cannot be
*accepted* by any peer who pins principals.** The realistic blast radius of a leaked PSK is therefore:
**(a) DoS / traffic injection on `federated.>`, and (b) passive observation of federated payloads** — and (b) is
real because **federation is cleartext-over-TLS in v1** (M3 sealed-payload encryption is designed but deferred,
`CONTEXT.md` §"Federation confidentiality (v1)"). This is what raises the stakes on the PSK and what makes
**per-member scope + rotation** worth the cost.

---

## 3. Half 1 — the admission gate

### 3.1 What already exists (composes — file paths)

All on this branch's base (lifted from the hub-minted-identity O-4a machinery, transformed by migration `0007`):

| Concern | Where | State |
|---|---|---|
| `register` raises a PENDING request | `src/services/network-registry/src/routes/principals.ts` §"O-4a.1 issuance-request hook" (~L206-232) | EXISTS — non-fatal upsert after a successful register |
| PENDING upsert (idempotent on `principal_id,peer_pubkey`) | `src/services/network-registry/src/store.ts` — `IssuanceRequestStore.upsertPending`, both `InMemoryIssuanceRequestStore` + `D1IssuanceRequestStore` | EXISTS |
| `PENDING → ADMITTED / REJECTED` admin-signed transition | `src/services/network-registry/src/routes/admission-requests.ts` (`POST …/admit`, `POST …/reject`) | EXISTS |
| Admin gate (503 not-configured → 401 sig-invalid → 403 not-authorized → nonce-replay → clock-skew) | `admission-requests.ts` `applyAdminGate` + `verifyAdminReadHeader`; reuses `parseAdminPubkeys` / `verifyEd25519` / `canonicalJSON` verbatim from network-create (#747) | EXISTS |
| Admin-gated list/get (`GET /admission-requests?status=`, `GET /admission-requests/{id}`) | `admission-requests.ts` | EXISTS — admin-only (signed `x-admin-signed` header) |
| Schema | `migrations/0007_admission_requests.sql` — `admission_requests(request_id, principal_id, peer_pubkey, requested_scope, network_id?, status, created_at, updated_at, granted_by)` | EXISTS |
| CLI | `src/cli/cortex/commands/network.ts` — `cortex network admit` (signs an admit decision claim; explicitly **no `leaf_package`** — hub-minted-identity retired) | EXISTS |
| Tests | `__tests__/admission-requests.test.ts`, `commands/__tests__/network-admit.test.ts` | EXISTS |

The state machine, the admin gate, and the CLI verb are **done**. R1 does not rebuild them.

### 3.2 What is net-new (the three wiring gaps)

These are the gaps that stop the existing machinery from actually gating *network roster membership*:

**Gap A — the request carries no network.** `register`'s hook calls `upsertPending(principalId, peerPubkey,
requestedScope)` with **no `network_id`** (the column is nullable and left `NULL`). So a PENDING request is "this
principal wants in" with no answer to "*into which network?*". R1 must:
- Let the joiner name the target network at register/request time (`cortex provision-stack register
  --network <id>` → claim carries `network_id`).
- Persist it (`upsertPending(principalId, peerPubkey, requestedScope, networkId)`); the column already exists.
- Make idempotency `(principal_id, peer_pubkey, network_id)` so the same stack can request two networks.

**Gap B — ADMITTED is disconnected from the served roster.** `GET /networks/{id}` builds `members[]` via
`membersFromPrincipals(...)` in `routes/networks.ts` (~L199) — derived from *announced capabilities listing the
network*, **not** from ADMITTED status. So today admission "mints nothing" **and gates nothing the descriptor
serves**. R1 must make the served roster filter on (or be sourced from) ADMITTED admission rows for that
network. Decision point — see §7 Q3 (filter the derived view vs. make admission the source of truth for
membership).

**Gap C — the joiner cannot learn they were admitted.** The list/get routes are **admin-only**. A joiner has no
authenticated way to poll "am I ADMITTED yet?" without an admin key. R1 needs *either* a member proof-of-possession
read path (`GET /admission-requests/mine` signed by the registered key) *or* an out-of-band notify (Pier DMs
"you're in") — and this choice is **coupled to the secret-delivery choice** (§6), because the natural place to
hand the secret is the same place the joiner learns they're admitted.

> None of Gap A/B/C is a new subsystem; each is a few lines + a test. The genuinely hard, net-new, security-bearing
> work is Half 2.

---

## 4. Half 2 — leaf-secret distribution (the new security surface)

### 4.1 The artifact

The **leaf shared secret** is the NATS leafnode `authorization` password. Two copies exist, functionally:

- **Verifier copy** — in the hub's `nats-server` `leafnodes{ authorization{ user, password } }` block. Hub-local;
  the hub admin provisions it on their own infra (SOP §6). **Not cross-party.**
- **Bearer copy** — in the admitted joiner's leaf *remote* (`policy.federated.networks[].nats` / the rendered
  `leafnodes` remote `password`). The joiner needs this in cleartext to render their leaf. **This is the one copy
  that must cross the principal boundary.**

"Leaf-secret distribution" = getting the **bearer copy** from the hub admin to the admitted joiner safely, and
keeping the **verifier copy** in sync (add/rotate/revoke).

### 4.2 Who generates it

The **hub admin** — the principal hosting the leaf hub for that network (for `metafactory`, Andreas). Generation is
a hub-local act (`cortex network create` already owns hub topology; a `cortex network secret …` verb is the
natural home). The **registry admin** and the **hub admin** *may* be the same identity but are conceptually
distinct (§7 Q5).

### 4.3 Scope — per-network vs per-member

| | Per-network (one PSK for the whole roster) | Per-member (one PSK per admitted stack) |
|---|---|---|
| Hub config | one `authorization` user | one `authorization` user per member; reload on each admit |
| Revoke one member | **rotate-all** (every member re-fetches + reloads) | drop that member's user; others untouched |
| Blast radius of a leak | the whole network's transport | one member's link |
| Sharing attribution | none (any member's copy is identical) | scoped to the leaking member |
| v1 cost | trivial | needs hub-side per-admit reload automation |

**Security-first → per-member.** It is the only option with targeted revoke and leak attribution. For a v1 roster
of 2–3 stacks, **per-network is an acceptable bootstrap** if the per-admit hub reload is judged too heavy for the
first slice — but the recommendation is to build toward per-member (§7 Q2).

### 4.4 The three delivery options

**(a) In-band via the admitted record** — the secret is embedded in the admission row the joiner reads back on
approval.
- Requires Gap-C's member-readable path. If the secret is plaintext in the row, **the registry holds a readable
  cross-party secret** — it becomes a honeypot, and breaks the `CONTEXT.md` §194 invariant ("the registry … signs
  nothing", "carries no account-topology material").
- Replay/exposure window: as long as the row exists at rest.
- Verdict: only acceptable if the embedded blob is **sealed** (→ becomes option b′).

**(b) Fetched from the registry post-approval (proof-of-possession read)** — a dedicated
`GET /networks/{id}/leaf-secret` endpoint, released only to an ADMITTED member who signs a PoP claim with their
registered key.
- Clean UX; enables Pier to fully automate. But **plaintext at rest in the registry** unless sealed → same
  honeypot problem as (a). Registry compromise leaks every member's PSK for every network.
- **(b′) — the strong variant: sealed-secret.** The hub admin, at admit time, **seals** the per-member PSK to the
  joiner's *already-registered* Ed25519 pubkey (convert to X25519, libsodium `crypto_box_seal` / `age`). The
  registry stores/serves only the **opaque ciphertext**. Only the holder of the registered private key can
  decrypt → **proof-of-possession is intrinsic** (no extra auth needed to release the blob; it is useless to
  anyone else). The registry **never sees plaintext** → the "holds no readable secret" invariant survives (it
  holds a blob it cannot read, the way it already holds opaque pubkeys). Rotation makes a stale ciphertext inert.

**(c) Out-of-band, via the concierge** — the secret never touches the registry; the hub admin / Pier delivers it
over the admission channel (e.g. the `#assistant-fleet-onboarding` DM, or a more secure channel named in the DM).
- Preserves ADR-0013 ("exchanged out-of-band") and the registry-holds-nothing invariant verbatim. Lightest to
  build (no crypto, no new endpoint).
- Cost: the PSK transits a third-party platform (Discord DMs are **not** end-to-end encrypted — Discord can read
  them) unless the concierge deliberately routes it elsewhere; manual-ish; rotation/revoke is a human runbook.
- The concierge (Pier/Luna) automates the *human* step, so it still "feels" handed-on-admission per ADR-0015.

### 4.5 Side-by-side

| | (a) admitted-record plaintext | (b) registry fetch plaintext | (b′) sealed-to-pubkey | (c) concierge OOB |
|---|---|---|---|---|
| Registry holds plaintext secret? | **yes** ❌ | **yes** ❌ | no (ciphertext only) ✅ | no ✅ |
| PoP enforced? | needs added auth | needs added auth | **intrinsic** ✅ | n/a (human) |
| Unapproved party can obtain? | if read leaks | if read leaks | no (can't decrypt) ✅ | only via admin misdelivery |
| Registry compromise leaks secret? | **yes** ❌ | **yes** ❌ | no (only ciphertexts) ✅ | no ✅ |
| Build cost | low | low | **medium** (sealing) | **lowest** |
| Preserves ADR-0013 OOB / registry-holds-nothing | no | no | mostly (opaque blob) | **yes** |
| Pier full-auto delivery | yes | yes | yes | partial (human-in-loop) |

---

## 5. Recommended design

### 5.1 Recommendation

**Adopt (b′) sealed-secret for the target design; ship (c) concierge-OOB as the v1 bootstrap if (b′)'s sealing is
deferred. Use per-member PSK scope (per-network acceptable only as a 2–3-stack bootstrap).**

Rationale, weighed against Andreas's standing principles:
- **Security-first:** (b′) keeps the registry out of the readable-secret business (no honeypot), makes PoP
  intrinsic, and bounds a leak to one member with targeted revoke. The remaining exposure (a member can still
  hand their own decrypted PSK to a third party) is bounded by the §2 second trust layer and by rotation.
- **Lightweight / no new infra:** (b′) adds no service — it reuses the registry as an opaque-blob carrier (which
  is exactly how it already carries pubkeys) and a stdlib sealed-box. (c) adds literally nothing to the registry.
- **Sovereignty (ADR-0013):** neither (b′) nor (c) puts an identity credential on the wire or in a hub's operator;
  the PSK stays a transport artifact, the joiner's identity stays in their own NSC operator.

### 5.2 Sequence (register → PENDING → admit → secret-delivery → join)

```
JOINER (sovereign newcomer)        REGISTRY (network.meta-factory.ai)        HUB ADMIN (Pier / Luna, hub-side)
──────────────────────────         ─────────────────────────────────        ──────────────────────────────────
1. provision-stack generate
   (own NSC operator; own seed)
2. provision-stack register
   --network <id>  ───────────────▶ verify proof-of-possession (sig by
   (pubkey + caps + network_id)      registered key) → store principal
                                     → upsertPending(principal, peer_pubkey,
                                       scope, network_id)   [Gap A]
                                     ◀── 201 signed assertion
                                                                      (admin polls / Pier notified)
                                                                      3. GET /admission-requests?status=PENDING
                                                                         (admin-signed) ──────────────────────▶
                                     ◀──────────────────────────────────  reviews the request
4. ADMIT decision:
   - admin signs admit claim ──────▶ PENDING → ADMITTED, granted_by=admin
     (network admit)                  [existing route]
                                                                      5. HUB-LOCAL (the secret half):
                                                                         - generate/lookup per-member PSK
                                                                         - add member's `authorization` user to
                                                                           hub nats-server + reload  [verifier copy]
                                                                         - SEAL psk to joiner's registered pubkey
                                          ◀── store sealed blob on the    (b′)  OR  DM the psk OOB (c)
                                              ADMITTED row / secret endpoint
6. learn admitted [Gap C] +
   fetch sealed blob ──────────────▶ release opaque ciphertext (b′:
                                     no extra auth needed) ──────────▶
   decrypt with own seed → psk
7. network join <id> --apply
   renders leaf remote with
   password=<psk>, binds to OWN
   local account, wires export/
   import, restarts  [existing]
8. network status → leaf established; peers resolved from roster (now ADMITTED-gated, Gap B)
```

### 5.3 The hub-side half is local (don't forget it)

Steps 5's "add member `authorization` user + reload" is **hub-local** and is NOT cross-party — it touches the
hub admin's own `nats-server`. For per-member scope this couples *the registry admit* to *a hub reload*, both
performed by the same admin-agent (Pier/Luna runs FleetAdmit: signs the registry admit AND updates the hub
`authorization` + reload). Net-new tooling: a `cortex network secret add-member <network> <member-pubkey>` (mint
PSK + write the hub `authorization` user + emit the sealed/OOB bearer copy) and `… revoke-member` / `… rotate`.

### 5.4 Composes vs net-new (summary)

**Composes (exists):** the whole `register→PENDING→ADMITTED` state machine + admin gate + admit/reject/list CLI
(§3.1); `cortex network create` (hub topology); `cortex network join` leaf rendering (already consumes a
password it has locally); `NetworkRecord`/`NetworkDescriptor`; the registered-pubkey directory (the seal target).

**Net-new:**
- Gap A: `network_id` on the request (CLI flag + claim field + `upsertPending` signature + idempotency key).
- Gap B: ADMITTED → served roster (filter `membersFromPrincipals` on ADMITTED, or source membership from
  admission rows).
- Gap C: member-readable admitted status (PoP read) and/or Pier OOB notify.
- Secret generation + hub `authorization` sync: `cortex network secret {add-member,revoke-member,rotate}`.
- Delivery: (b′) sealed-box seal/unseal (Ed25519→X25519, `crypto_box_seal`/`age`) + a ciphertext-carrying
  field/endpoint, **or** (c) the concierge OOB runbook (no registry change).
- Rotation/revoke runbook + the `archive/model-a-hub-minted-creds` reversibility note stays intact.

---

## 6. Security model & threat analysis (secret distribution)

**Assets:** the leaf PSK (bearer + verifier copies). **Adversaries:** an unapproved outsider; an admitted-then-
malicious member; a registry compromise; a passive network observer.

| Threat | (b′) sealed | (c) concierge OOB |
|---|---|---|
| **Unapproved party obtains the secret** | Cannot: the blob is sealed to the registered pubkey; only that private key decrypts. Registering a *different* key yields a blob sealed to a *different* key. PoP is intrinsic. | Cannot, unless the admin misdelivers (human-channel discipline; address in the runbook). |
| **Registry compromise** | Leaks only **ciphertexts** — useless without member seeds. Invariant "registry holds no readable secret" preserved. | Registry never holds it. |
| **Approved member replays / shares the secret** | Possible (they hold the plaintext PSK) **but bounded**: per-member scope ⇒ targeted revoke + leak attribution; §2 second layer ⇒ a third party on the pipe still cannot forge a signed envelope or be *accepted* by principal-pinning peers. Residual: passive read of cleartext-over-TLS `federated.>` payloads until rotation (M3 encryption deferred). | Same residual; per-member scope still gives targeted revoke. |
| **Replay of a stale/rotated secret** | Inert after `rotate`/`revoke-member` (hub drops the `authorization` user); the old sealed blob no longer authenticates. | Same after rotation. |
| **Man-in-the-middle on delivery** | TLS to the registry + the seal: even a TLS break yields only the ciphertext. | Depends on the OOB channel — **Discord DMs are not E2E**; prefer a named secure channel for the PSK, or move to (b′). |
| **Exposure window at rest** | Ciphertext at rest indefinitely is fine (opaque). Plaintext exists only transiently on hub + joiner. | No registry at-rest; transient in the DM channel's history (a real residual — Discord retains DM history). |

**Net security posture:** (b′) is strictly stronger on the at-rest and MITM axes; (c) is strictly simpler and
keeps the registry untouched but pushes the secret through a non-E2E human channel. Both rely on the §2 second
trust layer to bound a *shared* secret, and both want **per-member scope** + **rotation** to make revoke real and
to cap the cleartext-payload-observation residual that exists until M3 payload encryption ships.

---

## 7. Open questions / decisions for Andreas (prioritized)

**Q1 — [LOAD-BEARING] Where does the leaf secret live in transit: sealed-through-the-registry (b′) or
out-of-band-via-concierge (c)?** This is the decision that gates the build. It reconciles the documented tension
between **ADR-0013** ("the leaf secret … exchanged out-of-band") and **ADR-0015 / CONTEXT.md §188** ("admission …
hands you the leaf shared secret"). It also decides whether the **registry's posture changes** from
"identity-only, holds no secret" to "carries an opaque per-member ciphertext." Recommendation: **(b′) as target,
(c) as v1 bootstrap.** If you pick (b′), we should add a one-line amendment to ADR-0013's "out-of-band" consequence
noting the sealed-blob carrier is still not a cross-operator trust act.

**Q2 — Per-member or per-network PSK scope?** Recommendation: **per-member** (targeted revoke + attribution),
with per-network tolerated only as a 2–3-stack bootstrap. Per-member costs a hub `authorization`-reload on each
admit (Pier automates it). Confirm you want the per-admit hub-reload coupling.

**Q3 — How does ADMITTED become roster membership (Gap B)?** Two sub-options: (i) keep the derived
`membersFromPrincipals` view but **filter it to ADMITTED** rows for that network, or (ii) make the admission table
the **source of truth** for `members[]`. (i) is smaller; (ii) is cleaner but reworks the descriptor's
membership source. Recommendation: **(i) for R1**, revisit (ii) if the derived view proves confusing.

**Q4 — How does a joiner learn they're admitted (Gap C)?** A member PoP read endpoint (`GET
/admission-requests/mine`, signed by the registered key) vs. **Pier OOB notify**. Couples to Q1: if (b′), the same
PoP read naturally also serves the sealed blob; if (c), Pier already DMs them, so no new endpoint. Recommendation:
**follow Q1** (b′ ⇒ add the PoP read; c ⇒ no endpoint).

**Q5 — Is the hub admin the same identity as the registry admin?** Today `REGISTRY_ADMIN_PUBKEYS` gates the admit
decision; the hub admin generates the PSK + edits the hub nats config. For `metafactory` both are Andreas/Luna, so
they collapse — but the design should not *assume* it. Confirm whether R1 may assume "admit authority ⊇ hub-secret
authority," or must keep them separable (matters if a future network's registry admin ≠ its hub host).

**Q6 — Rotation cadence + revoke trigger.** No rotation policy exists. Minimum: `rotate` on suspected leak and on
`network leave`/revoke. Recommendation: ship `secret rotate` + `revoke-member` in R1 (revoke is meaningless
without them); a *scheduled* rotation cadence can be a follow-up.

**Q7 — Does the cleartext-over-TLS `federated.>` residual (M3 deferred) change the priority of payload
encryption?** A leaked-but-revoked PSK still permitted passive payload reads while it was live. If that residual
is unacceptable for the community/3rd-party case, it pulls M3 sealed-payload (`docs/design-envelope-encryption.md`)
forward. Flagging, not proposing — out of R1 scope, but the threat model surfaces it.

---

## 8. Build order (once Q1 is decided — NOT yet authorized)

1. Gap A (`network_id` on the request) — unblocks "join *which* network."
2. Gap B (ADMITTED → roster) — makes the gate actually gate.
3. Secret tooling: `cortex network secret {add-member,revoke-member,rotate}` (hub-local verifier copy).
4. Delivery per Q1: (b′) seal + ciphertext field + member PoP read (also closes Gap C), **or** (c) concierge OOB
   runbook + Pier notify (closes Gap C without an endpoint).
5. Wire into Pier (P1) so admit + secret-delivery is one concierge action (FleetAdmit Tier-2).

Each slice is small and independently testable. **Held until Q1.**
