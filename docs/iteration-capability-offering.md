# Iteration plan — Capability Offering & Visibility (the third control-plane leg)

**Epic:** [cortex#939](https://github.com/the-metafactory/cortex/issues/939)
**Design:** [`docs/design-capability-offering.md`](design-capability-offering.md) — **Accepted** (grilled 2026-06-11)
**Decisions:** [ADR-0008](adr/0008-capability-offering-scope.md) (offer-scope) · [ADR-0009](adr/0009-offerings-per-stack-no-shared-layer.md) (per-stack, no shared layer) · [ADR-0010](adr/0010-public-accept-gate-two-stage.md) (two-stage public gate)
**Started:** 2026-06-11

The repo-side iteration artifact for the capability-offering epic. The GitHub
epic (#939) + its CO-1..CO-7 sub-issues are the trackable mirror; this file is
the agent-readable plan. **Sync rule:** a checkbox completed here is also ticked
on its GitHub issue, and vice-versa.

**The model (one line):** a capability is no longer a flat tag — it becomes an
**offering** `(capability, offer-scope, accept-policy)`. Offer-scope = the trust
tier (`local` = the stack only · `federated` = other principals' stacks on a
network · `public` = the open square); accept-policy = who-within-tier (a closed
named set, default-deny). `cortex offer` is the third control-plane leg
(`stack` → `network` → `offer`). The dev-loop is its first internal customer;
the **public PR-review marketplace** is the prize (offer `code-review` publicly so
an external contributor's PR to a public meta-factory repo is reviewed by *my*
assistants).

## Slices

| Slice | What | Issue | State | Depends on |
|---|---|---|---|---|
| **CO-1** | offering policy model + `policy.offerings[]` config (default-local; byte-identical boot) | [#940](https://github.com/the-metafactory/cortex/issues/940) | ✅ (#962) | — |
| **CO-2** | consumer wiring reads offer-scope (binds on admitted scope prefixes) | [#941](https://github.com/the-metafactory/cortex/issues/941) | ✅ (#969) | CO-1 |
| **CO-3** | `cortex offer` CLI (set/list/revoke) + offering→federation-config generation | [#942](https://github.com/the-metafactory/cortex/issues/942) | ✅ (#967) | CO-1 |
| **CO-4** | gate posture per offer-scope (public ⇒ enforce + compliance + rate-limit + bounded accept) | [#943](https://github.com/the-metafactory/cortex/issues/943) | ✅ (#968) | CO-1 |
| **CO-7** | untrusted-content & prompt-injection hardening (M1–M6) — **GATES CO-5** | [#947](https://github.com/the-metafactory/cortex/issues/947) | ✅ (#980) | CO-2, CO-4 |
| **CO-5** | the public PR-review marketplace (the dogfood) — **ships dark, live-activation gated on #978/#971** | [#944](https://github.com/the-metafactory/cortex/issues/944) | 🔄 in-progress | CO-1..4, **CO-7** |
| **CO-6** | dev-loop integration — enable = `cortex offer …--scope local` (re-points W5.1 / [#925](https://github.com/the-metafactory/cortex/issues/925); SOP [`sop-enable-dev-loop.md`](sop-enable-dev-loop.md)) | [#945](https://github.com/the-metafactory/cortex/issues/945) | ✅ (#976) | CO-1..3 |

## Decisions locked (grill, 2026-06-11)

- **DD-CO-1..5** (ADR-0008) — capabilities carry an offer-scope; default-deny local; offering GENERATES the federation config (unify); offer-scope raises the gate floor; public consumers reach offerings via surfaces; `cortex offer` is the third leg.
- **Vocab** — **offering** (provider) ⇄ **Offer mode** (consumer) are two sides of one handshake; **offer-scope = tier / accept-policy = who-within-tier** (closed per-scope named set, not a DSL). `local` = the offering **stack** only (multiple stacks = multiple locals); `federated` = **other principals'** stacks on a network.
- **DD-CO-6** (ADR-0008 §6) — untrusted-content treatment scales with offer-scope; public REQUIRES M1–M6.
- **DD-CO-7** (ADR-0009) — offerings are per-stack runtime config; **no shared `offerings/` layer**; fleet intent is a provisioning-tooling concern (a shared layer ⟺ a co-owned entity like a network; an offering isn't one).
- **DD-CO-8** (ADR-0010) — public admission is a **two-stage gate**: deterministic, metadata-only, pre-LLM at the tap; content-dependent accept-predicates forbidden; public identity = surface-asserted HMAC-validated identity.

## Build order

CO-1 (model) → CO-2 (wiring) + CO-3 (CLI) + CO-4 (gates) in parallel → CO-7 (hardening) → **CO-5** (public marketplace — needs CO-1..4 + CO-7). **CO-6** (dev-loop = `local` offerings) can land any time after CO-1..3 — it needs no public hardening. **CO-6 is doc/re-point only:** CO-1..3 already deliver the whole mechanism (model + consumer wiring + `cortex offer` CLI), so "enable the dev-loop" needs no new runtime code — just the SOP ([`sop-enable-dev-loop.md`](sop-enable-dev-loop.md)) and the W5.1 re-point ([`iteration-dev-loop.md`](iteration-dev-loop.md)).

## Open questions (design §10 — deferred, non-blocking)

1. Public cost/budget — ties to the stubbed `BudgetCheck` building-block gap (a public offering must not drain a principal).
2. Capability versioning + SLAs for public offers; discoverability (a registry-of-public-offerings).
3. `chat` as the second public capability (a public-facing assistant) — shared marketplace plumbing or its own.
