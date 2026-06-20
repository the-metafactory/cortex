# ADR 0013 — Sovereign federation: own-operator + per-side export/import (Model B), not hub-minted guest accounts (Model A)

**Status:** accepted (2026-06-18, grilled with Andreas) · **Refs:** cortex#1116, cortex#1117 (G1), ADR-0001 (federated subject grammar), ADR-0003 (network-join control plane), ADR-0012 (external-NSC-account isolation), `docs/sop-federation-onboarding.md`, `docs/design-g1-account-topology.md`

## Context

cortex's G1 work (account-topology tooling, cortex#1117) forced an unavoidable
question: *when principal A's stack federates into a network, what NATS account
does its leaf authenticate as, and whose NSC operator roots that account?* Two
models were on the table:

- **Model A — hub-minted guest account.** The network hub's admin mints the
  joiner a NATS account **inside the hub's own NSC operator** and hands them a
  `.creds`. The joiner's federation identity lives in someone else's operator.
  This is what was *partially* running (the leaf-creds-from-hub flow; a debugged
  link showed `andreas`'s leaf authenticating to JC's hub as an account under
  `OP_JC`).
- **Model B — sovereign own-operator.** Each principal roots their federation
  identity in **their own NSC operator** and federates outward into one or more
  networks. Nobody's identity is hosted in anybody else's operator.

The decision is hard to reverse (it shapes identity, the registry's role, the
onboarding SOP, and the G1 tooling), surprising without context (Model A is the
*simpler* NATS path, so a future reader will ask why it was dropped), and a real
trade-off (sovereignty + multi-network scale vs. setup simplicity). Hence this ADR.

## Decision

**Adopt Model B as the one and only federation model. A principal MUST run their
own NSC operator to federate; there are no hub-minted guest accounts.** Four
resolved points (grilled 2026-06-18):

1. **The leaf link is a secret-authenticated transport pipe, not a cross-operator
   JWT-trust handshake.** The hub's `leafnodes{}` block authenticates the remote
   with `authorization { user, password: <shared-secret> }`; each side binds the
   link to a **local NATS account in its own NSC operator**. No operator trusts
   another operator's JWTs. **Sovereignty is structural** — it falls out of the
   pipe + per-side control, not from a trust protocol.

2. **What crosses `federated.>` is governed by export/import each side runs in its
   OWN store.** Because each side binds the leaf to a local account, the
   export/import that bridges `federated.>` between that account and the stack's
   agents account is **purely local — single-store, single-operator**. Each
   principal wires their own half; neither side ever needs the peer's account.

3. **One dedicated federation account per stack; networks isolated by subject
   scope, not by separate accounts.** A stack gets ONE NSC account dedicated to
   federation (distinct from its internal-agents account, so federation traffic
   is blast-radius-isolated from internal agents — consistent with ADR-0012). All
   networks a stack joins bind to that one account; **per-network isolation is by
   `federated.{principal}.>` subject scope + per-network `accept_subjects`**, never
   by minting an account per network (that is the config-sprawl Model B exists to
   avoid).

4. **Model A is dropped entirely.** No guest accounts. The cost — a newcomer with
   no NSC operator yet cannot federate until they stand one up — is paid down by
   investing in making *"stand up your own NSC operator"* trivial (arc tooling),
   not by hosting their identity in a hub's operator.

## Consequences

- **G1c (cortex orchestration)** = `cortex network join` runs the **local side's**
  export/import (federation-account ↔ agents-account) on each side's own store via
  the arc primitive (`arc nats add-federation-export`, cortex#243). Each principal
  wires their own half on their own join. This resolves the earlier "join can't run
  nsc" worry — it operates on the *local* store, which the joiner owns.
- **G1a is reverted.** The `hub_account`-on-the-signed-descriptor field (cortex#1130)
  was built on a Model-A assumption (joiner needs the hub's account). Model B never
  references a peer's account, so the field is vestigial; revert it to keep the
  descriptor honest.
- **G1b (arc `nats add-federation-export`, single-store)** is exactly the right
  primitive — it runs once per side, each in its own operator. No two-machine
  atomic surgery; two independent single-store ops.
- **The registry's federation role stays identity-only** (ADR-0003 / SOP layer (b)):
  it is the pubkey directory + network descriptor (`hub_url`/`leaf_port`/roster). It
  carries **no account-topology material** — there is nothing cross-operator to
  broker, because each side wires its own.
- **The onboarding SOP** must teach the sovereign path (stand up your own operator →
  dedicated federation account → join = local export/import + leaf link) and drop the
  guest-account path. (Tracked under G5, cortex#1121.)
- **The leaf secret** remains the one mutual, two-party artifact (per
  `docs/sop-federation-onboarding.md` §6) — exchanged out-of-band when two sides
  agree to link, like the hub topology itself.

## Alternatives considered

- **Model A (hub-minted guest account)** — simpler NATS (the hub does all nsc
  wiring; the joiner just gets a `.creds`), but the joiner's federation identity is
  on loan from the hub, the hub can unilaterally revoke it, and joining N networks
  means N guest accounts in N foreign operators (the config nightmare). Rejected as
  default and as a bootstrap.
- **True cross-operator JWT trust** (the hub's resolver preloads/trusts the peer's
  account JWT signed by the peer's operator) — would let the leaf authenticate as the
  peer's own-operator account directly, but a nats-server has a single operator root;
  this needs a real trust protocol and is unnecessary given the secret-auth pipe +
  per-side export/import already deliver sovereignty. Rejected as over-engineering.
- **Per-network dedicated accounts** — account-level isolation between networks, but
  N accounts per stack + per-network nsc wiring on every join. Rejected for sprawl;
  subject-scope isolation is sufficient.
