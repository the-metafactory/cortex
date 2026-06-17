# ADR 0012 — External-principal bus isolation: shared `community` account + scoped bot (default), dedicated account (opt-in)

**Status:** Accepted (revised 2026-06-16 per [design-automated-operator-onboarding.md](../design-automated-operator-onboarding.md) §4-D1 / cortex#1049)
**Date:** 2026-06-12 (original) · 2026-06-16 (revision — default flipped)
**Context tags:** federation, security, network onboarding
**Supersedes / relates:** ADR-0001 (federated subject grammar), ADR-0002 (federated dispatch addressing), `docs/sop-federation-onboarding.md`, `docs/sop-stack-onboarding.md` §B0–B5, `docs/runbook-leaf-cred-issuance.md`, the `cortex creds` ↔ `arc nats` contract (`the-metafactory/arc:docs/integrations/cortex-creds.md`)

> **Revision note (2026-06-16).** This ADR keeps its number (0012) and is amended in
> place. The original **decision** was account-per-principal (Option A) as the *default*.
> The automated-onboarding spec (cortex#1049-D1) flips the default to a **shared
> `community` account + per-principal *scoped bot*** because that is the restart-free,
> one-command path through the existing `cortex creds issue` → `arc nats add-bot`
> primitive. **Account-per-principal (Option A) survives as an explicit opt-in** for
> principals needing hard, namespace-level isolation. The full isolation analysis below
> is retained — it is *why* the opt-in exists.

---

## Context

When a **community principal** (a peer principal — e.g. Robert/`northwoods`) joins the
`metafactory-community` network, their cortex stack binds a **NATS leafnode link** to our
operator-mode hub (`tls://nats.meta-factory.dev:7422`, operator `OP_ANDREAS`). The leaf
authenticates with a **user `.creds`** we issue, and that user lives in some **account**.

The account is the **trust/isolation boundary in NATS**: subjects are visible within an
account; cross-account visibility requires explicit export/import. So *which account* an
external principal's leaf binds to decides what their fleet can see and reach.

Three options were on the table:

| Option | What | Isolation | Onboarding cost |
|---|---|---|---|
| **(C)** issue the principal a user in `ANDREAS_AGENTS` | our internal agents' working account | **None** — their leaf shares the account our own agents run in. Rejected outright. | — |
| **(B → now default)** one shared `community` account for all external principals, each with a **per-principal bot scoped via `--pub/--sub federated.<op>.>`** | federation traffic isolated from `ANDREAS_AGENTS`; one-time account bootstrap, then pure `arc nats add-bot` per principal | Isolated from us; **namespace-shared between principals** — principal A *could* attempt `sub federated.B.>` within the shared account, which is why per-bot subject scoping + least-privilege `accept_subjects` is load-bearing. | **One command, restart-free** (add-bot adds a *user*). |
| **(A → now opt-in)** one account **per** external principal, issued under the admin's `nsc` operator account tree | e.g. `NORTHWOODS` for Robert | **Full** — account-level isolation between us and every principal, and between principals. | A hub `resolver_preload` entry + **restart per principal** (MEMORY resolver). |

### The automation forcing-function (why the default moved)

The bus side already ships a one-command issuance primitive:
**`cortex creds issue <bot> -a <account> --pub federated.<op>.> --sub federated.<op>.>`**
shells out to **`arc nats add-bot`** (contract: `arc:docs/integrations/cortex-creds.md`,
schema `arc.nats.v1`). It is **parameterized by the issuing `nsc` operator account** (`-a OP_ANDREAS` / `-a OP_JC` — each
admin issues under their own `nsc` operator account, signing keys never shared) and carries
least-privilege `--pub/--sub` subject scoping built in.

The decisive property: **`add-bot` adds a *user*, not an account.** A user JWT is
self-contained and signed by an account the hub already trusts, so issuing one needs
**no hub restart**. A **new *account*** is the thing that forces a `resolver_preload`
edit + hub restart under the MEMORY resolver. Account-per-principal therefore makes every
onboard a hub-restart event; shared-account-with-scoped-bot makes every onboard a single
restart-free `cortex creds issue` call. For a flow we want to run **frequently and
bot-driven**, the restart cost is the wrong default.

## Decision

**Default: external principals bind a per-principal *bot* in one shared `community`
account, scoped to `federated.<op>.>` via `--pub/--sub`.** Onboarding is one
restart-free `cortex creds issue <bot> -a community --pub federated.<op>.> --sub
federated.<op>.>` (→ `arc nats add-bot`). The **subject-permission scope is the isolation
boundary** in this mode.

**Opt-in: account-per-principal (the original Option A)** for any principal that needs
hard, namespace-level isolation — they get a dedicated account (e.g. `NORTHWOODS`) under
the issuing admin's `nsc` operator account tree. This is the only mode that prevents one principal's fleet
from even *attempting* another's federated subjects at the account layer. It costs the
hub `resolver_preload` edit + restart, taken deliberately for that principal.

External principals remain **mutually untrusting peers**. The point of a shared bus is
cross-principal *dispatch* (Offer/Direct over `federated.{principal}.{stack}.>`), not
shared subject visibility. In the shared-account default we get that isolation from
**tight per-bot `--pub/--sub` scoping + least-privilege `accept_subjects`** rather than
from the account boundary; per [Security-first defaults] we make that scoping mandatory,
not optional, and we keep account-per-principal one flag away for anyone who needs the
stronger boundary.

## Consequences

- **Issuance (default)** is a single restart-free `cortex creds issue … -a community
  --pub/--sub federated.<op>.>` per principal — see
  [`docs/runbook-leaf-cred-issuance.md`](../runbook-leaf-cred-issuance.md). No new account,
  no `resolver_preload` edit, no hub restart. The shared `community` account is
  bootstrapped **once** (the runbook's "one-time account bootstrap" fallback path).
- **Issuance (opt-in dedicated account)** creates a new account, which under the MEMORY
  resolver **must** be added to the hub's `resolver_preload` and the hub restarted. (A new
  *user* in an existing account never needs a restart — only accounts are preloaded.) This
  is the raw-`nsc` path in the runbook, reserved for the hard-isolation opt-in.
- **Isolation honesty.** Shared-account = **namespace-shared** isolation: weaker than
  account-level, because the principals co-habit one NATS account. The mitigation is
  **tight `--pub/--sub` scoping at issuance + least-privilege `accept_subjects`** on the
  link. Document this trade-off to every principal on the shared default; offer the
  dedicated-account opt-in to anyone for whom namespace-shared is insufficient.
- **Subject scope (both modes).** Each principal's least-privilege `accept_subjects`
  allow-list (`federated.{their-principal}.{their-stack}.>` only) is always present. In
  the default mode it is the primary boundary; in the opt-in mode it is the second,
  lower layer beneath account isolation.
- **Confidentiality posture.** v1 `federated.` payloads cross cleartext-over-TLS, signing
  off by default. Neither account nor namespace isolation replaces the signing/mTLS ramp
  for external parties — they bound *visibility*, not *authenticity/confidentiality*. For
  external principals keep `accept_subjects` least-privilege and prioritise ramping signing
  → mTLS sooner than for fully-trusted internal stacks. (This is sharper under the
  shared-account default, where there is no account wall behind the subject scope.)
- **Revocability.** Default mode: revoke is one restart-free `cortex creds revoke <bot>`
  (→ `arc nats remove-bot --delete-creds`, server-side revocation + push). Opt-in mode:
  revoke the user, then drop the account from `resolver_preload` + restart to fully
  offboard. Either way, offboarding one principal never entangles another.

## Upgrade path — clean restart-free revoke/offboard for the dedicated-account opt-in

The dedicated-account opt-in's `resolver_preload` + restart is a MEMORY-resolver
constraint. If hard-isolated principals become numerous, move the hub to a **URL /
account-JWT-server resolver** (a server the hub queries) so new accounts are `nsc push`-ed
and revoked **without a hub restart**. That keeps account-level isolation while removing
the only operational reason the default isn't account-per-principal. It is a separate infra
change; not needed at current scale, and irrelevant to the shared-account default (which
is already restart-free). Documented here so the constraint is a known, deliberate
trade-off, not a surprise.
