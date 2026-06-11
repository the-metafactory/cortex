# ADR 0012 — External operators get their own NATS account (isolation)

**Status:** Accepted
**Date:** 2026-06-12
**Context tags:** federation, security, network onboarding
**Supersedes / relates:** ADR-0001 (federated subject grammar), ADR-0002 (federated dispatch addressing), `docs/sop-federation-onboarding.md`, `docs/sop-stack-onboarding.md` §B0–B5

---

## Context

When a **community operator** (a peer principal — e.g. Robert/`northwoods`) joins the
`metafactory-community` network, their cortex stack binds a **NATS leafnode link** to our
operator-mode hub (`tls://nats.meta-factory.dev:7422`, operator `OP_ANDREAS`). The leaf
authenticates with a **user `.creds`** we issue, and that user lives in some **account**.

The account is the **trust/isolation boundary in NATS**: subjects are visible within an
account; cross-account visibility requires explicit export/import. So *which account* an
external operator's leaf binds to decides what their fleet can see and reach.

Three options were on the table:

| Option | What | Isolation |
|---|---|---|
| **(C)** issue the operator a user in `ANDREAS_AGENTS` | our internal agents' working account | **None** — their leaf shares the account our own agents run in. Rejected outright. |
| **(B)** one shared `FEDERATION` account for all external operators | federation traffic isolated from `ANDREAS_AGENTS`, one-time hub setup, then pure `nsc add user` per operator (no hub restart) | Isolated from us, **but not from each other** — operator A could `sub federated.B.>` within the shared account. |
| **(A)** one account **per** external operator under `OP_ANDREAS` | e.g. `NORTHWOODS` for Robert | Full — account-level isolation between us and every operator, and between operators. Cost: a hub `resolver_preload` entry + restart per operator (MEMORY resolver). |

## Decision

**Each external operator gets their own dedicated account under the issuing admin's operator** (Option A) — `OP_ANDREAS` when Andreas onboards them, the issuing admin's own operator when someone else does (e.g. JC issues under his operator on his hub; operator signing keys are never shared). See [`docs/runbook-leaf-cred-issuance.md`](../runbook-leaf-cred-issuance.md) §"Issuing admin".

External operators are **mutually untrusting peers**. The whole point of onboarding them to
a shared bus is cross-principal *dispatch* (Offer/Direct over `federated.{principal}.{stack}.>`),
not shared subject visibility. Account-per-operator is the only option that prevents one
operator's fleet from subscribing to another's federated subjects. Per
[Security-first defaults], we take the isolating option even though it costs a hub
`resolver_preload` edit + restart per onboard.

We accept the operational cost because operator onboarding is **low-frequency** and the
restart is a brief, scheduled blip on the community hub.

## Consequences

- **Issuance** (per operator) creates a new account, not just a user — see
  [`docs/runbook-leaf-cred-issuance.md`](../runbook-leaf-cred-issuance.md). Because the hub
  runs `resolver: MEMORY`, a **new account** must be added to the hub's `resolver_preload`
  and the hub restarted. (A new *user* in an existing account needs no restart — user JWTs
  are self-contained, signed by the account; only accounts are preloaded.)
- **Subject scope.** Combined with each operator's least-privilege `accept_subjects`
  allow-list (`federated.{their-principal}.{their-stack}.>` only), account isolation is the
  second, lower layer of the same boundary.
- **Confidentiality posture.** v1 `federated.` payloads cross cleartext-over-TLS, signing
  off by default. Account isolation does **not** replace the signing/mTLS ramp for external
  parties — it bounds *visibility*, not *authenticity/confidentiality*. For external
  operators, tighten `accept_subjects` and prioritise ramping signing → mTLS sooner than we
  would for fully-trusted internal stacks.
- **Revocability.** Each operator's account + user is independently revocable
  (`nsc revoke-activation` / delete the user / drop the account from `resolver_preload` +
  restart) — onboarding one operator never entangles another.

## Upgrade path (when operator count grows)

The per-account `resolver_preload` + restart is a MEMORY-resolver constraint. If external
operators become numerous, move the hub to a **URL/JWT-server resolver** (an account-JWT
server the hub queries) so new accounts are `nsc push`-ed without a hub restart. That is a
separate infra change; not needed at current scale. Documented here so the constraint is a
known, deliberate trade-off, not a surprise.
