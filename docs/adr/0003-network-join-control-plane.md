# ADR 0003 — Network join control plane

**Status:** Accepted (2026-06-07)
**Relates:** [`docs/design-network-join-control-plane.md`](../design-network-join-control-plane.md) (the spec these decisions are promoted from), [ADR-0001](./0001-federated-subject-grammar.md) (federated subject grammar), [ADR-0002](./0002-federated-dispatch-addressing-and-verdict-back.md) (dispatch addressing + verdict-back), `CONTEXT.md` §Network/§Scope, [`compass/sops/federation-wire-protocol.md`](https://github.com/the-metafactory/compass/blob/main/sops/federation-wire-protocol.md), [`docs/sop-network-join.md`](../sop-network-join.md) (the one-command join SOP).
**Supersedes operationally:** the manual, cloudflared-led peering procedure in [`docs/runbook-federation-peering.md`](../runbook-federation-peering.md) (#728), which is retained as the offline / hand-pin fallback only.

## Context

Connecting a cortex **stack** to a **network** — so two principals' stacks interconnect at the NATS leaf-node layer — was ~10 manual steps across four Myelin layers, two config files, and an out-of-band key exchange (recorded firsthand bringing `andreas/meta-factory` onto JC's hub, 2026-06-06; see the spec §1 friction table). The L1–L7 **data plane** was already well-specified — ADR-0001 put `federated.{principal}.{stack}.…` on the wire and took topology off it; ADR-0002 settled dispatch addressing and verdict-back. What was missing was a **control plane**: a defined way for a stack to *join* a network.

The Network Join Control Plane epic (#733) added that control plane as a thin layer over the unchanged data plane, framed around the three bus **scopes** — `local` / `federated` / `public` — and delivered as one command (`cortex network join <network>`, S4 #738). The design spec's §4 enumerated twelve design decisions (DD-1…DD-12). This ADR promotes the load-bearing subset to binding status. The remainder stay descriptive in the spec.

## Decision

The following design decisions are **binding** for any code, config, or operations touching the join control plane:

- **DD-1 — Additive control plane; the data plane is untouched.** The 5-check `federated.*` wire grammar (ADR-0001/0002, the federation-wire-protocol SOP) does not change. The join/discovery control plane sits *above* it. Any proposal that puts topology on the wire or identity in myelin is rejected on sight (the wire-protocol layer split: L7 owns identity addressing, L1–L3 own topology & routing). The control plane only exchanges identity, descriptors, and rosters; traffic still flows leaf-to-leaf on the unchanged bus.

- **DD-2 — The registry is the source of truth for network + peer discovery.** The network-registry (`network.meta-factory.ai`, `src/services/network-registry/`) resolves `principal → pubkey`, serves the per-network descriptor (`GET /networks/:id`) and roster (`GET /networks/:id/roster`). Joining *pulls* from it; in steady state it is never bypassed by hand-pinning. The registry is the self-hosted control-plane analog of a mesh-overlay control server (Headscale/NetBird): it exchanges identity and keys, never the data-plane traffic.

- **DD-9 — Pin + verify the registry (trust anchor).** The registry signs its roster/principal/descriptor responses (`registry:` pubkey + `signature`). Cortex pins the registry pubkey in config and verifies **every** response signature before trusting a resolved peer pubkey. An unverified response is rejected, not trusted. A spoofed or compromised registry cannot inject peer keys.

- **DD-10 — Registry-down → cached roster + warn.** On registry-unreachable at boot, cortex uses the last-known-good cached roster and emits a loud `system.error`/warn; federation stays up. Hand-pinned peers always resolve offline. A transient registry outage never silently tears federation down — graceful degradation, like the IP stack staying routable through a partial DNS outage.

- **DD-11 — Resolved-vs-pinned mismatch → fail-closed.** If a peer carries both a hand-pinned `principal_pubkey` and a *different* registry-resolved key, cortex refuses to load that peer and alerts. A divergence is a drift or attack signal, not a value to merge. A matching pin is honored. (Complements DD-5's "pin is the fallback" — when both exist, they MUST agree.)

- **DD-12 — Hub via registry-served descriptor.** The network's `hub_url` + `leaf_port` come from `GET /networks/:id` (the descriptor), not from local config — so the hub can relocate without every peer re-editing config. The join command derives the leaf remote from the descriptor; no out-of-band port/creds wrangling.

## Consequences

- **Joining a network is one command.** `cortex network join <network> --apply` performs the whole §1 sequence idempotently — the "feel like TCP/IP" north star (spec §9): hand the registry a network name, it hands back everything the layers need (descriptor + roster + trust anchor). The procedure documented in [`docs/sop-network-join.md`](../sop-network-join.md) is the binding operational form.
- **Hand-pinning becomes a fallback, not the path** (DD-5, descriptive in the spec; the operational consequence of DD-2). The manual cloudflared-led runbook (#728) is superseded for the steady-state case and retained only as the offline / no-public-hub fallback.
- **Security is a separate axis** (DD-7, descriptive). Join works at any signing posture (`off → permissive → enforce`); ramping signing never changes who you are joined to, and joining never changes your signing posture. DD-9/DD-11 protect the *control plane's* trust anchor regardless of the *data plane's* signing posture.
- **The public scope is the opt-in tier.** `local` is zero-config (home), `federated` is the registry-mediated join above, `public` is the open square — opted into explicitly (the Internet of Agentic Work; see S5/#739). The same wire grammar governs all three; only the scope prefix and the gate's trust source differ.

## Status of the non-promoted DDs

DD-3 (three tiers = three scopes), DD-4 (one-command join), DD-5 (registry-resolved peers; hand-pin is fallback), DD-6 (runtime owns leaf rendering), DD-7 (security ramp orthogonal), and DD-8 (one canonical pubkey encoding per surface) remain documented in the spec §4 and are realized by the shipped S1–S4 code; they are not promoted to binding ADR status here because they are implementation shape rather than cross-cutting contract. They may be promoted later if a future change pressures them.
