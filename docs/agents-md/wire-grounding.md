### Wire-contract grounding (RFC routing)

cortex's bus client (`src/bus/**`) implements the **client side** of the myelin wire
contracts. The contracts themselves are **normative** and live in myelin, not here — so
wire-touching work is routed to the governing RFC **on demand** rather than always-loaded.
Before you touch a row's surface, **Read the RFC** it points at, then proceed grounded (same
"trigger → Read the governing document → proceed" shape as the SOP activation table below).

The RFCs are addressed **cross-repo** — they live in `the-metafactory/myelin` `specs/rfc/`,
never a local cortex path. The routing table is a copy of a list myelin owns; a CI no-drift
check (`scripts/check-wire-vocab.ts`) asserts every path below resolves to a real file in the
myelin pack.

| Trigger — you are touching… | Governing RFC (`the-metafactory/myelin specs/rfc/`) |
|---|---|
| `did:mf` identifiers, actor/agent id, `signed_by` chain construction (`verify-signed-by-chain.ts`, `envelope-builder.ts`) | `rfc-0001-identifiers.md` |
| subjects, `deriveNatsSubject`, subject namespace/grammar, `nats.subjects` (`surface-router.ts`, `network-resolver.ts`, `nats/`) | `rfc-0002-subject-namespace.md` |
| envelope format, headers, payload, the envelope validator (`myelin/envelope-validator.ts`, `envelope-builder.ts`) | `rfc-0003-envelope.md` |
| envelope signing, signature verification, key material (`verify-signed-by-chain.ts`, `verifier-self-check.ts`) | `rfc-0004-envelope-signing.md` |
| sovereignty, boundary crossing, `federated.*`, `source`/`originator`, `selectLink`, cross-principal routing (`sovereignty-gate.ts`, `network-resolver.ts`) | `rfc-0005-sovereignty-and-boundary-crossing.md` |
| membership, admission, join/leave, admit request (`admission/`, `admit-offered-dispatch.ts`, `stack-provisioning.ts`) | `rfc-0006-membership-and-admission.md` |
| transport, delivery modes, backoff, request-reply, reliability (`nats/`, `jetstream/`) | `rfc-0007-transport-and-reliability.md` |
| capability discovery, signed capability advertisements (`capability-registry.ts`, `probe-responder.ts`) | `rfc-0008-capability-discovery.md` |
| rate-limit / refusal / access-denied taxonomy (`gate-floor.ts`, `access-denied-dedup.ts`, `emit-system-access-denied.ts`) | `rfc-0010-rate-limit-and-refusal-taxonomy.md` |

When work touches the economics or wire-change-control surfaces, add the matching rows
(`rfc-0009-economics.md`, `rfc-bcp-0001-wire-change-control-and-versioning.md`). The RFC
grammar is normative for `src/bus/**`: code conforms to the spec; a spec change is a wire
change (governed by `rfc-bcp-0001`), a code change that diverges from the spec is a bug. See
`compass/standards/domain-grounding.md` and `src/bus/CLAUDE.md`.
