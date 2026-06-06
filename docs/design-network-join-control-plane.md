# Design Spec — Network Join Control Plane

**Status:** Draft (for sign-off)
**Stage:** Design Spec (per `compass/sops/design-process.md`)
**Authoritative detail:** `CONTEXT.md` §Network/§Scope/§Dispatch · `docs/adr/0001-federated-subject-grammar.md` · `docs/adr/0002-federated-dispatch-addressing-and-verdict-back.md` · `compass/sops/federation-wire-protocol.md`
**Motivating evidence:** the manual andreas↔jc federation bring-up (2026-06-06) + the mesh-networking research study (below).

---

## 1. Problem

Connecting a cortex **stack** to a **network** (so two principals' stacks interconnect at the leaf-node layer) is **~10 manual steps across four Myelin layers, two config files, and an out-of-band key exchange.** Recorded firsthand bringing `andreas/meta-factory` onto JC's hub:

| # | Layer | Manual step | Failure mode hit |
|---|-------|-------------|------------------|
| 1 | M1 | Discover hub exposes leaf port (7422), not client (4222) → it's a nats-server leaf, not a cortex direct link | Wrong mental model (path A vs B) |
| 2 | M1 | Leaf config existed in `local.conf` but the running server ran bare `nats-server -js` (plist never loaded it) | Configured-but-dormant |
| 3 | M2 | Flip server to operator-mode auth, wire `credsPath` into `system.yaml` | Fleet lockout risk |
| 4 | M3 | Extract stack pubkey, know nkey-U vs base64 encoding, paste out-of-band | Encoding confusion |
| 5 | M6 | Hand-pin `peers[]` (principal_id/stack_id/pubkey) | Identity drift (`jcfischer/sage-host` → `jc/default`) |
| 6 | config | Find the right split file, learn `leaf_node` rides primary, pick `max_hop`, get `accept_subjects` grammar | Off-contract config risk |
| 7 | coordination | Both sides swap keys + edit + restart over Discord | Slow, error-prone |

**The architecture is not the problem.** CONTEXT.md and the wire-protocol SOP deliberately separate identity addressing (L7, cortex) from topology & routing (L1–L3, myelin); the `federated.` scope is the L3 routing equivalent and the **data plane is well-specified.** What is missing is a **control plane**: a defined way for a stack to *join* a network. That is entirely manual today.

**Goal:** a thin control plane over the existing data plane so joining a network is **one command**, with the registry as the source of truth, framed around the three bus **scopes** — `local`, `federated`, `public` — to make the Internet of Agentic Work easy to opt into without weakening the layer model.

---

## 2. Research grounding

**Study:** *"Simplest, most maintainable way to create internet-spanning mesh networks for federating independent NATS-based services across orgs and NAT — both P2P and hub-and-spoke, with easy peer onboarding."* (106 agents, adversarially verified, 2026-06-06.)

Findings that shape this design:

- **R1 — Two-layer split is the recommended shape.** A WireGuard-style overlay (Headscale / NetBird / Nebula) for P2P data-plane connectivity + NAT traversal, with NATS leaf nodes layered on top for federation. *Map to cortex:* the **registry is our control-plane analog of Headscale's control server** (it only exchanges identity/keys; traffic flows node-to-node over leaf links). We are not adding WireGuard now — JC's public NATS hub already solves reachability (leaf nodes dial **outbound**, NAT-safe). The overlay is a *later* option for the no-public-hub / true-P2P case.
- **R2 — Easy onboarding = a single non-interactive token command.** `tailscale up --auth-key`, `netbird up --setup-key`. *Map to cortex:* `cortex network join <network>` is our equivalent. This is the headline.
- **R3 — Leaf nodes are inherently hub-and-spoke (acyclic tree), NOT a cyclic mesh.** Full mesh needs NATS gateways/superclusters. *Map to cortex:* federated networks are hub-and-spoke today (fine for the review loop + bring-up); the public scope and gateways are the mesh path later.
- **R4 — Decentralized JWT auth (operator→account→user) + account-scoped subject isolation** lets new peers/identities be added without per-server config edits. *Map to cortex:* the registry holds the operator/account trust anchors; joining should *not* require hand-editing the nats-server per peer.
- **R5 — Self-hosted control plane preserves sovereignty across orgs.** *Map to cortex:* the registry is self-hosted (`network.meta-factory.ai`); each principal stays the sole signer of their own envelopes (M3).

**Net:** keep the L1–L7 data plane exactly as specified; add a self-hosted **join/discovery control plane** (the registry, made authoritative) wrapped in one command. This is the same split the research endorses.

---

## 3. The scope model — local / federated / public (IoAW)

The three bus **scopes** (CONTEXT.md §Scope) become three **onboarding tiers** with escalating control-plane involvement:

| Scope | What it is | Reach | Onboarding | Control-plane involvement |
|-------|-----------|-------|------------|---------------------------|
| **local** | A stack's own bus — loopback `nats-server`, the home broadcast domain | Never leaves the principal | **Zero-config** — it's home; the runtime's primary link | None |
| **federated** | A named **network** of peer principals interconnecting at the leaf layer | Crosses to `peers[]` in that network | **`cortex network join <network>`** — registry-mediated | Registry resolves hub + roster + peer pubkeys |
| **public** | The open square — unrestricted, carries **no** principal/stack segment | Anyone on the public layer | **`cortex network join public`** (opt-in) — publish/discover capabilities openly | Registry holds the public capability index |

This is the **Internet of Agentic Work** made concrete: `local` is your machine, `federated` is the trusted networks you join, `public` is the open agentic market. A stack opts into each tier explicitly; the *same* wire grammar (the wire-protocol SOP's 5 checks) governs all three — only the scope prefix and the gate's trust source differ.

**Security ramp is orthogonal to scope** (DD-7): each tier runs at the deployment's current `security.signing` posture (`off` → `permissive` → `enforce`), independently. Joining a network never changes your signing posture; ramping signing never changes who you're joined to.

---

## 4. Design Decisions

> Promote to numbered ADRs (DD-/ADR-) on sign-off; listed here for review.

- **DD-1 — Additive control plane; data plane untouched.** The 5-check `federated.*` wire grammar (ADR-0001/0002, wire-protocol SOP) does **not** change. We add an onboarding/discovery control plane *above* it. Any proposal that puts topology on the wire or identity in myelin is rejected on sight (wire-protocol SOP layer split).
- **DD-2 — The registry is the source of truth for network + peer discovery.** `network.meta-factory.ai` already resolves `principal → pubkey` (registry-signed) and has `/networks/:id/roster`. Joining *pulls* from it; it is never bypassed by hand-pinning in steady state.
- **DD-3 — Three onboarding tiers = the three scopes** (§3). `local` zero-config, `federated` registry-mediated join, `public` opt-in open square.
- **DD-4 — One-command join.** `cortex network join <network>` performs every step in §1's table (idempotent, re-runnable). What was done by hand on 2026-06-06 is the executable spec for this command.
- **DD-5 — Registry-resolved peers; hand-pin is the fallback only.** `peers[]` becomes a list of `principal_id`s; cortex resolves pubkeys from the registry roster (registry-signed) at config-load. The schema already anticipates this (`principal_pubkey` comment: *"for a registry-resolved lookup; until then, principals paste"*). Hand-pinning stays as the §3 offline fallback.
- **DD-6 — The runtime/arc owns the nats-server leaf rendering.** "Join" updates the **actual running server** (renders the leaf remote + ensures the launchd plist loads the config), not a file the server ignores. This closes the single biggest trap from bring-up.
- **DD-7 — Security ramp is orthogonal to join** (§3). Join works at any signing posture; the IoAW security ramp (off→permissive→enforce, mTLS, payload encryption / TC-3) is a separate axis.
- **DD-8 — One canonical pubkey encoding per surface.** Config = nkey-U (`U…`); registry = base64 raw ed25519. The join command translates; humans never hand-convert.
- **DD-9 — Pin + verify the registry (trust anchor).** [decided 2026-06-06] The registry signs its roster/principal responses (`registry:` pubkey + `signature`). Cortex pins the registry pubkey in config and verifies **every** roster/principal response signature before trusting a resolved peer pubkey. A spoofed/compromised registry cannot inject peer keys. *(Resolves the implicit trust gap; shapes S1.)*
- **DD-10 — Registry-down → cached roster + warn.** [decided 2026-06-06] On registry-unreachable at boot, use the last-known-good cached roster and emit a loud `system.error`/warn; federation stays up. Hand-pinned peers always resolve offline. Federation is **not** silently torn down by a transient registry outage. *(Resolves OQ2; shapes S2.)*
- **DD-11 — Resolved-vs-pinned mismatch → fail-closed.** [decided 2026-06-06] If a peer carries both a hand-pinned `principal_pubkey` and a *different* registry-resolved key, refuse to load that peer and alert — a divergence is a drift/attack signal, not a merge. Catches stale config **and** registry tampering. *(Shapes S2; complements DD-5's "pin is fallback" — when both exist they MUST agree.)*
- **DD-12 — Hub via registry-served descriptor.** [decided 2026-06-06] The network's `hub_url` + `leaf_port` come from `GET /networks/:id` (the descriptor), not local config — so the hub can relocate without every peer re-editing config. *(Resolves OQ4; shapes S1 + S3.)*

---

## 5. Architecture

```
                         ┌─────────────────────────────────────────┐
   CONTROL PLANE (new)   │   Registry  (network.meta-factory.ai)    │
   identity + discovery  │   • POST /principals/:id/register         │
   self-hosted, signed   │   • GET  /principals/:id   (pubkey)       │
                         │   • GET  /networks/:id     (descriptor)   │
                         │   • GET  /networks/:id/roster (peers)     │
                         │   • GET  /capabilities     (public index) │
                         └───────────────▲───────────────────────────┘
                                         │ cortex network join <network>
                                         │ (pull descriptor+roster, register,
                                         │  render leaf, write peers, restart)
   ┌─────────────────────────────────────┴─────────────────────────────────┐
   │ DATA PLANE (unchanged — wire-protocol SOP 5 checks)                     │
   │  M1 leaf links (NatsLink/nats-server leaf)  M3 stack signing identity   │
   │  M4 subject namespace  M6 policy/peers gate                              │
   │  scopes: local.{p}.{s}.>  ·  federated.{p}.{s}.>  ·  public.>           │
   └────────────────────────────────────────────────────────────────────────┘
```

**Components:**

1. **`cortex network` CLI** (new command group): `join`, `leave`, `status`, `peers`. `join` orchestrates the full §1 sequence; idempotent.
2. **Registry client extension** — network-descriptor + roster resolution (the registry routes exist; cortex needs the client + load-time resolver).
3. **Config-load peer resolver** — when `peers[]` entries carry only `principal_id`, resolve pubkey + stack from the registry roster (registry-signature-verified), cache, fail-closed if unresolved.
4. **Leaf renderer** — render the nats-server leaf remote + creds for a joined network; ensure the launchd plist loads the config (DD-6). Owned by the runtime/arc lifecycle, consistent with `#700`/`#717` stack-aware upgrade work.
5. **Network descriptor** — registry serves `{ hub_url, leaf_port, network_id, members[] }`; join derives the leaf config from it (no out-of-band port/creds).

**Non-goals (this epic):** WireGuard overlay (R1 later option), NATS gateways/full-mesh (R3 later), payload encryption / TC-3 (DD-7 separate axis), changing the wire grammar (DD-1).

---

## 6. Feature breakdown (acceptance criteria)

- **F1 — Network descriptor + roster in the registry client.** AC: cortex can `GET /networks/:id` (descriptor: `hub_url`/`leaf_port`/`members[]`, DD-12) + `/roster` and parse typed responses; **every** response signature verified against the **pinned registry pubkey** (DD-9) — unverified responses rejected; responses cached to disk for offline reuse (DD-10); unit + integration tests against a stub registry incl. a bad-signature rejection test.
- **F2 — Registry-resolved peers at config-load.** AC: a `peers[]` entry with only `principal_id` resolves pubkey+stack from the (verified) roster; on registry-unreachable, last-known-good **cache + loud warn**, federation stays up (DD-10); a hand-pinned `principal_pubkey` that **differs** from the resolved key → **fail-closed** for that peer + alert (DD-11); a matching pin is honored; clear error if a registry-only peer is unresolvable and uncached; vocab/lint clean.
- **F3 — Leaf renderer + plist loader (DD-6).** AC: rendering a network's leaf remote updates the running nats-server (config loaded, leaf ESTABLISHED); idempotent; does not clobber the config-split layout (#717-aware); survives `arc upgrade`.
- **F4 — `cortex network join/leave/status`.** AC: `join <network>` performs register → pull descriptor → render leaf → write `policy.federated.networks[]` (registry-resolved peers) → restart, idempotently; `status` shows leaf state + peers + counters; `leave` reverses cleanly.
- **F5 — Public scope opt-in.** AC: `join public` wires `public.>` publish/subscribe + registers announced capabilities to the public index; gate correctness for the no-principal-segment scope; documented.
- **F6 — Docs + SOP.** AC: a `network-join` SOP (the §1 sequence, now one command) + CONTEXT.md §Scope/§Network updates + supersede the cloudflared-led peering runbook (#728).

---

## 7. Implementation plan (umbrella + sub-issues + PR plan)

**Umbrella issue:** `cortex#NNN — Network Join Control Plane (epic)` — links this spec; sub-issues below; `feature` + `infrastructure` + `now`/`next` labels.

| Sub-issue | Feature | PR(s) | Depends on |
|-----------|---------|-------|------------|
| S1 | F1 registry descriptor+roster client | PR-1 (client + types + stub tests) | — |
| S2 | F2 registry-resolved peers at load | PR-2 (resolver + fallback + fail-closed) | S1 |
| S3 | F3 leaf renderer + plist loader | PR-3 (renderer, #717-aware) | — |
| S4 | F4 `cortex network` CLI | PR-4 (join/leave/status wiring S1–S3) | S1,S2,S3 |
| S5 | F5 public scope opt-in | PR-5 (public.> wiring + capability index) | S1,S4 |
| S6 | F6 docs + SOP + runbook supersede | PR-6 (docs) | S4 |

**Phasing:** Phase A = S1+S2 (registry-resolved peers — kills the hand-pin, the #1 drift source). Phase B = S3+S4 (the one-command join). Phase C = S5+S6 (public scope + docs). Each PR: pilot-loop dev → sub-agent `/code-review` → address findings → CI green → squash-merge. ADRs promoted from §4 land in PR-1.

---

## 8. Open questions

1. **OQ1** — Public-scope trust: anonymous offer/claim on `public.>` needs a spam/abuse story before enabling beyond an allowlist. Defer enforce to the security ramp? *(Open — Phase C / S5.)*
2. ~~**OQ2** — Registry-down behavior.~~ **Resolved → DD-10** (cached roster + warn; hand-pin works offline).
3. **OQ3** — Multi-network: a stack joining N networks (CONTEXT.md allows it) — confirm the LinkPool (#657/#659) + leaf renderer compose cleanly per network. *(Verify in S3.)*
4. ~~**OQ4** — Hub relocatability.~~ **Resolved → DD-12** (registry-served descriptor; `hub_url`/`leaf_port` from `GET /networks/:id`).

## 9. North star — "feel like TCP/IP"

The success test for this epic: **a principal joins the IoAW the way a machine joins the internet — plug in and it works.** No one configures the IP stack to reach the internet: DHCP autoconfigures, the layers are invisible, the endpoints are well-known, and the standard is the same everywhere. Joining a network should feel the same.

What "feel like TCP/IP" means concretely:

1. **Autoconfiguration (DHCP-style).** `cortex network join <network>` is the whole story — no nats-server config, no creds wrangling, no pubkey copy-paste, no choosing `max_hop`/`accept_subjects`. The registry is the DHCP/DNS-equivalent: hand it a network name, it hands back everything the layers need (descriptor + roster + trust anchor). Every detail in §1's friction table is absorbed by the command + registry.
2. **Invisible layers.** A principal never touches M1–M6 to join, exactly as a user never touches Ethernet/IP/TCP framing to open a socket. The OSI model stays intact *under* the abstraction (DD-1); the principal just sees "joined."
3. **Well-known + uniform.** One verb (`join`), one source of truth (registry), one grammar (the wire-protocol SOP) — identical for `local`, `federated`, and `public`. Like a socket API that's the same whether you talk to localhost, a LAN, or the open internet — only the scope changes, never the interface.
4. **Graceful degradation, like the IP stack.** Transient registry outage ≠ network down (DD-10, cached roster); a bad/tampered response is dropped, not trusted (DD-9/DD-11). The network is robust to partial failure the way routing is.

If any join step still needs NATS/PKI expertise, it's a bug in this design — not the principal's problem.
