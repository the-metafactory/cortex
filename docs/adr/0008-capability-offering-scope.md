# ADR-0008: Capabilities carry an offer-scope; offering is the third control-plane leg

**Status:** Proposed
**Date:** 2026-06-11
**Context refs:** CONTEXT.md §Capability / §Scope · ADR-0003 (network-join control plane) · `docs/design-capability-offering.md`

## Context

A stack declares capabilities as a flat `runtime.capabilities: string[]` — bus-routable ability tags with **no scope dimension.** Whether a capability is reachable cross-principal is decided coarsely and elsewhere: `announce_capabilities` + `accept_subjects` at network-join, the registry's "pubkey + capabilities," and the `local.`/`federated.`/`public.` scope prefix on the wire.

This is all-or-nothing per network and cannot express the real policy a principal needs:

- The dev-loop's capabilities (`dev.implement`, `merge.approve`, `release.cut`) are **internal by nature** — you never let a stranger run dev or merge your repos. "Enable the dev-loop" therefore cannot be a flag flip without answering "…at what scope."
- The inverse is the prize: **`code-review.typescript` is worth offering publicly** — an external contributor's PR to a public meta-factory repo can be reviewed by *my* assistants. A two-sided capability marketplace (the Internet of Agentic Work).

The scope dimension already exists on the *transport* (the subject prefix; ADR-0003's three onboarding tiers). What is missing is the *policy* above it: which scope each capability is offered at, and who may dispatch it.

## Decision

1. **Capabilities carry an offer-scope.** A capability offering is the triple `(capability, offer-scope ⊆ {local, federated, public}, accept-policy)`, declared in a new `policy.offerings[]` config block on the stack layer.
2. **Default-deny, opt-in-widen.** A capability not explicitly offered is reachable at **`local` scope only**. Widening to `federated`/`public` is a deliberate act. The secure default is internal exposure. *(This makes the dev-loop's dormant-by-default the correct default of the model, not a special case.)*
3. **Offering is the single source of truth and GENERATES the existing federation config** (`announce_capabilities`, `accept_subjects`, registry registration) — it does not replace them. Unify, do not duplicate.
4. **Offer-scope raises the gate floor** (orthogonal to, but a minimum on, the signing-posture knob): `public` ⇒ signing-enforce for bus peers + compliance + rate-limit + bounded accept-policy; `federated` ⇒ registry-trust; `local` ⇒ home-bus.
5. **Public consumers reach offered capabilities through surfaces, not stacks.** A public requester (e.g. a GitHub contributor) has no bus identity; the surface (HMAC-validated webhook) is the trust anchor, the Offer's `originator` is the surface identity, and the accept-policy bounds the request to the offered capability.
6. **`cortex offer` is the third control-plane leg** — `stack` (exists) → `network` (federated) → `offer` (exposed).
7. **Untrusted-content treatment scales with offer-scope (DD-CO-6).** Work dispatched to a `federated`/`public` offering carries attacker-controlled content (a PR's diff/description/comments) — handled as **data, never instructions**. A `public` offering MUST ship with all of: untrusted-content boundary (M1), least-privilege session (M2), **sandbox isolation** (M3 — requires a non-local `ExecutionBackend`, i.e. F-5b), output egress/leakage control (M4), persona hardening + `prompt-injection` red-team acceptance gate (M5), rate/cost caps (M6). Signing/scope prove *who*, never *that the content is safe* — injection defense is a separate, mandatory layer. The public marketplace (CO-5) is gated on this hardening (CO-7). *(See `docs/design-capability-offering.md` §6.)*

## Consequences

- A new `policy.offerings[]` schema + default-`local` resolution; the consumer-wiring binds a capability's JetStream consumer on the scope prefixes its offering admits (today: always `local` → byte-identical boot until something is offered wider).
- The federation onboarding config (`announce_capabilities`/`accept_subjects`) and registry registration become projections of the offering policy, computed by `cortex offer`.
- The dev-loop's "stack enablement" (cortex#925 / W5.1) becomes a clean instance: `cortex offer dev.implement --scope local`, etc.
- The public PR-review marketplace becomes expressible + enforceable: `cortex offer code-review.typescript --scope public --accept 'pr-against:the-metafactory/*'`.

## Alternatives considered

- **Keep the flat list + network-level announce (status quo).** Rejected: cannot express per-capability scope; cannot express the offer/withhold asymmetry (offer review publicly, withhold dev/merge) that the marketplace requires.
- **Per-agent rather than per-capability scope.** Rejected: an agent may hold both internal and public capabilities (Echo offers `code-review` publicly but its dev capabilities stay local); the policy unit must be the capability, not the agent.
