/**
 * Wave 0 PR-A.0b — public bus barrel for external consumers (pilot, future
 * sibling M7 apps).
 *
 * Surface contract: `docs/design-pilot-restructure.md` §7.4 enumerates the
 * symbol table pilot imports from `@the-metafactory/cortex/bus`. This file
 * MUST stay exactly that surface — nothing more, nothing less. Adding an
 * export here widens the public contract; removing one breaks consumers.
 * Refs cortex#232, cortex#238.
 *
 * Internal cortex code MUST keep importing from the deep paths
 * (`./nats/connection`, `./myelin/subscriber`, `./myelin/envelope-validator`).
 * This barrel exists for the package-boundary crossing only.
 */

// --- Transport (per §7.4 row 1) ---
export { NatsLink, type NatsLinkOptions } from "./nats/connection";

// --- Envelope subscriber (per §7.4 rows 2 + the EnvelopeHandler type the
//     spec's §7.4 narrative implies consumers wire into onEnvelope) ---
export {
  MyelinSubscriber,
  type MyelinSubscriberOptions,
  type EnvelopeHandler,
  type EnvelopeErrorHandler,
  type InvalidEnvelopeHandler,
  type InvalidEnvelopeReason,
} from "./myelin/subscriber";

// --- Envelope validator (per §7.4 rows 3-4) ---
//
// `Envelope` is the canonical typed shape; `validateEnvelope` is the
// runtime check used by `bus/publish-review-request.ts`. The remaining
// symbols are the ancillary types subscribers / publishers need to type
// their handlers (`SignedBy*`, `Classification`) and to walk the stamp
// chain (`getSignedByChain`) — pilot's verdict subscriber consumes the
// stamp chain to confirm origin per §4.2 of the spec.
export {
  validateEnvelope,
  getSignedByChain,
  type Envelope,
  type SignedBy,
  type SignedByEd25519,
  type SignedByHubStamp,
  type Classification,
  type ValidationResult,
} from "./myelin/envelope-validator";
