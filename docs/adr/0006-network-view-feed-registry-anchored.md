# Network-view feed — registry-anchored, own-slice, metadata-only

Status: accepted (2026-06-10, grill-with-docs session, Q6/Q7/Q9)

## Context

The hosted network view (Mission Control Worker + D1 at meta-factory.ai) is in-vision: local stacks serve the pane locally; the hosted surface shows the **collaboration layer across a network** — assistants present on peer stacks, capabilities, dispatch/attention activity. Its ingest routes are built but fed by nothing, and the original CloudPublisher design authenticated with per-network API keys. Meanwhile the network-join control plane (ADR-0003) made the registry (`network.meta-factory.ai`) the pinned, signature-verified source of truth for `principal → pubkey` and per-network rosters, and `provision-stack` already implements NKey proof-of-possession claims. CONTEXT.md's "Session interior" rule (2026-06-10) requires that session interiors never leave the stack.

## Decision

- **Own-slice push.** Each member stack pushes only its OWN collaboration metadata to the Worker. Peers' federated envelopes arriving at a stack are not that stack's to upload — sovereignty stays with the originator.
- **Metadata-only, enforced publisher-side.** What may leave is an allow-list (lifecycle/presence metadata); session interiors (signal `trace.>` spans, raw/published session events, tool detail) are structurally excluded at the publisher — a compromised Worker cannot obtain what is never sent. Drilling into your own session from the hosted pane routes back to your local stack's pane.
- **Registry-anchored auth, no API keys.** Ingest batches are signed with the stack's existing NKey; the Worker verifies the signature against the registry-resolved pubkey and checks network membership against the registry roster (the ADR-0003 DD-2/DD-9 pin-and-verify pattern, reusing the `provision-stack` claim shape). The `cloud.apiKey` config field retires. Viewer-side authorization derives from registry roster membership (you see the networks you're on), layered under the Mission Control authorization roles (the RBAC tier defined in CONTEXT.md §Identity & trust).
- **The registry stays control-plane only** (ADR-0003 DD-1): it anchors identity and rosters; it never stores telemetry. The MC Worker's D1 is the view-plane store.

## Considered options

- **Per-stack push with API keys** — the as-built CloudPublisher design. Rejected: a second credential system parallel to the NKey identity the trust track just shipped.
- **Hub-side collector** subscribing `federated.>` and feeding D1 centrally. Rejected: a privileged observer of all federated traffic, with no per-principal opt-out short of leaving the network.
- **Query-on-view fan-out** to member stacks' APIs. Rejected: every stack would need an internet-exposed inbound endpoint; outbound-only push is the smaller attack surface.

## Consequences

- Joining the hosted network view is opt-in per-stack config; a principal who never configures the push simply doesn't appear.
- Phase-3 work: Worker-side NKey signature verification + roster check; CloudPublisher reuses the claim-signing helper instead of bearer keys.
- Roaming drill-down into session interiors is deliberately unsupported; revisit only via sealed-payload encryption (`docs/design-envelope-encryption.md`), never via cleartext replication behind auth.
