# ADR 0001 — Federated subjects carry `{principal}.{stack}`, never the network

**Status:** Accepted (2026-06-05) — supersedes the grammar merged in cortex#661.
**Deciders:** Andreas (principal/architect), Luna.
**Context source:** `CONTEXT.md` §§ Principals/stacks/networks, Subject, Reach.

## Context

cortex#661 changed `deriveNatsSubject` so a **federated** subject's second segment is the **target `network_id`** (read from `extensions.network_id`): `federated.{network_id}[.{stack}].{type}`. `selectLink` routes on that `network_id` segment; the federation gate's default `accept_subjects` is `federated.{network_id}.>`. emit, route, and subscribe were made internally consistent — but **against a grammar `CONTEXT.md` forbids.**

`CONTEXT.md` is unambiguous:
- **Subject** = `{scope}.{principal}.{stack}.{domain}.{entity}.{action}` — "routing lives in the subject."
- **Reach/scope** ∈ `local | federated | public`. Cross-principal dispatch (line 79) = `federated.{principal}.{stack}.tasks.@{assistant}.{capability}` — a **Direct** dispatch.
- **Network** (line 24) = "**deployment topology**. A network is **NOT a subject segment** … Cross-principal reach is the `federated.` **scope** prefix, **never a network name on the wire**. A principal may belong to more than one network." (Reinforced line 153: "`metafactory` is the **network**, not a principal; it must never be a subject segment.")

So #661 leaked a **transport-topology** value (network) into the **L7 identity address** (the subject). It also can't address a target: a network hosts *many* principals, so `network_id` cannot name *which* principal a federated envelope is for.

This drifted in undetected because reviewers checked emit↔route↔subscribe *internal* consistency, not conformance to `CONTEXT.md`. (Fixed separately: the code-review Architecture lens now loads + checks `CONTEXT.md` — arc-skill-code-review #18.)

## Decision

**Federated subjects carry `{principal}.{stack}` — the same identity segments as `local.*`, only the scope prefix differs. The network is resolved from the principal via deployment topology (`policy.federated.networks[].peers[]`), and NEVER appears on the wire.**

- Wire grammar: `federated.{principal}.{stack}.tasks.@{assistant}.{capability}` (Direct), lifecycle `federated.{principal}.{stack}.dispatch.task.{action}`.
- `deriveNatsSubject`: federated segment[1].[2] = target `{principal}.{stack}` (drop the `network_id` source).
- `selectLink`: resolve target principal → network leaf via the `peers[]` topology map; stop reading a `network_id` subject segment.
- `accept_subjects`: `federated.{my-principal}.{my-stack}.>`.

This is the **layering** the system is built on (Cortex = L7 application addresses by identity; myelin/L1 resolves which network/leaf from topology). Identity is on the wire; topology is in config.

## Consequences

**Positive**
- Conforms to `CONTEXT.md`; restores the L7/L1 separation.
- A stack can be **re-homed to a different network without changing its subjects** (topology change ≠ identity change) — the load-bearing property behind isolated multi-network deployments (e.g. halden=B).
- Federated envelopes can name a *specific* peer principal on a multi-principal network.

**Cost / rework (drive next)**
1. `src/bus/myelin/envelope-validator.ts` — `deriveNatsSubject` federated branch → `{principal}.{stack}`; retire `networkIdFromEnvelope` as the subject source (keep `extensions.network_id` only as a routing *hint* for `selectLink`, not a wire segment).
2. `src/bus/myelin/runtime.ts` — `selectLink` maps target-principal → leaf via `policy.federated.networks[].peers[]`; drop segment[1]=network_id routing.
3. `src/common/types/cortex-config.ts` — `accept_subjects` default → `federated.{principal}.{stack}.>`; cross-validation updated.
4. cortex#686 — build the federated review **consumer** on the conformant grammar (subscribe `federated.{me}.{stack}.tasks.@{assistant}.code-review.>`; verdict back on `federated.{requester}.{stack}.dispatch.task.*`).
5. pilot#149 — re-target as a **Direct** dispatch (`@reviewer@{principal}/{stack}`), emit the conformant subject; merge in lockstep with #686.

**Safe because:** nothing is live on the federated path yet (no consumer existed), so there is no production traffic to migrate. **TC-2d verify is unaffected** — it resolves the signer from `principalFromEnvelope(source)`, which is grammar-agnostic; only the *routing* layer reworks, not the crypto.

## Alternatives considered

- **Keep `network_id` on the wire (#661), update `CONTEXT.md` instead.** Rejected: it conflates topology with identity (a layering inversion), can't address a principal within a multi-principal network, and breaks stack re-homing. The contract is the better design, not the stale doc.
