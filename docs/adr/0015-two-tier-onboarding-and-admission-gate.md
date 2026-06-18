# ADR 0015 — Two-tier community onboarding + the network-admission gate

**Status:** accepted (2026-06-18, re-grilled with Andreas) · **Refines:** ADR-0013 (sovereign federation) · **Supersedes:** ADR-0012 (external-NSC-account isolation) · **Refs:** cortex#1050, cortex#1116, ADR-0001/0003, `docs/sop-onboard-peer-principal.md`, `docs/runbook-leaf-cred-issuance.md`

## Context

ADR-0013 adopted sovereign federation (Model B) and "dropped Model A." A second
grill (2026-06-18) surfaced that this was under-specified for **community onboarding**
— the whole #assistant-fleet vision (helping a newcomer's fleet participate) was built
on Model A (a hub minting the newcomer a scoped guest credential). Dropping Model A
without a replacement left the docs internally contradictory (the G5 runbook said
"Model A unsupported" in one section while still carrying a `cortex creds issue
--account community` step; ADR-0012 and `runbook-leaf-cred-issuance.md` remained
active-Model-A; the pinned Discord onboarding messages were pure Model A).

The grill resolved how a member participates, and what becomes of the Model-A
machinery we had already built (O-4a issuance-request broker, G2 `cortex creds grant`,
O-4b `--from-package`).

## Decision

**1. Two tiers of community participation — no guest-bus tier.**
- **Tier 1 — Chat.** A member brings their **own Discord bot**, authorized into
  `#assistant-fleet` only. No NATS, no credentials issued. (The valid pinned
  instruction.)
- **Tier 2 — Sovereign.** A member runs their **own NSC operator + stack + dedicated
  federation account** and joins the bus the Model-B way (register + leaf-secret pipe +
  local-side export/import). **The hub issues no account or credential to them.**
- There is **no middle "guest bus" tier** (the Model-A hub-minted-guest-cred path). A
  newcomer who wants bus participation stands up their own operator; we pay that cost
  down by **investing in making sovereign setup trivial**, not by hosting their identity
  in a hub's operator.

**2. The `register → PENDING → grant` flow is repurposed as the network-admission gate.**
A private network still needs a gate on *who* is admitted to its roster. The O-4a state
machine (built for Model-A credential issuance) is salvaged as **identity-level admission**:
a sovereign newcomer registers + requests to join a network → an admin (or an admin-agent)
**approves** them onto the network roster → they are a recognized peer. It **mints
nothing** — it gates roster membership, not credentials.

**3. The Model-A credential machinery is retired (but preserved).**
Retire from main: G2's credential-minting + leaf-package posting, O-4b `--from-package`,
`docs/runbook-leaf-cred-issuance.md`, and ADR-0012 (superseded here). The full Model-A
state is **preserved** at tag `model-a-hub-minted-creds` + branch
`archive/model-a-hub-minted-creds` — recoverable if Model B proves too cumbersome for
community onboarding.

**4. The onboarding concierge — "Pier".**
An arc-installable assistant in the metafactory guild (`#assistant-fleet-onboarding`)
that **admits and guides, issues nothing**: (a) authorizes a newcomer's Discord bot into
`#assistant-fleet` (Tier 1, the O-5 `community-fleet` role), (b) drives the
network-admission gate (Tier 2), and (c) guides a newcomer through sovereign setup.

## Consequences

- **Reconciliation work** (tracked as an epic): repurpose O-4a as the admission gate;
  retire G2-minting / O-4b / the leaf-cred runbook; remove the Model-A step from the G5
  runbook; rewrite the pinned Discord onboarding messages (chat pin stays; the
  bus-federation pin → sovereign path); mark ADR-0012 superseded.
- **Survivors (Model-B-compatible):** `cortex creds issue` (local bot-minting for one's
  own agents), O-3 (operator-mode auto-convert), O-5 (Discord-role admit), G1 (sovereign
  federation), G3/G4, the audit, ADR-0013.
- **The trivial-sovereign-setup investment** becomes load-bearing: with no guest tier, the
  bus on-ramp is only as good as how easy "stand up your own operator + federation account"
  is (the audit's hotspots #2/#3 + G1d). Pier guides it; tooling must shrink it.
- **Reversibility:** Model A is one `git` ref away (`model-a-hub-minted-creds`).

## Alternatives considered

- **Three tiers (keep a guest-bus on-ramp, Model A as graduable training-wheels)** —
  lower friction for newcomers now, but re-introduces the sovereignty cost (hub controls
  the guest, accounts sprawl across hubs) ADR-0013 rejected. Rejected: instead invest in
  trivial sovereign setup. Preserved on the archive ref in case the friction proves
  unacceptable.
- **Delete the Model-A machinery outright** — clean, but throws away the reusable
  `register→PENDING→grant` state machine that the network-admission gate needs. Rejected
  in favour of repurposing.
