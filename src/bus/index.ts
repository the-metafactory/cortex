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

// --- Review-pipeline envelope builders (cortex#237 PR-2) ---
//
// Producer-side helpers for the capability-dispatch review pipeline per
// `docs/design-capability-dispatch-review-consumer.md` §6 and
// `docs/design-pilot-restructure.md` §4.1–§4.2. Re-exported on the public
// surface so pilot's caller-side (request publisher) and any external
// review consumer share one symbol table. The builders themselves are
// pure — no NATS, no I/O — so this barrel addition is safe to consume
// from any context.
export {
  createReviewRequestEvent,
  createReviewVerdictEvent,
  createReviewTaskFailedEvent,
  type ReviewEventSource,
  type ReviewFlavor,
  type ReviewVerdictKind,
  type ReviewRequestPayload,
  type ReviewVerdictPayload,
  type CreateReviewRequestEventOpts,
  type CreateReviewVerdictEventOpts,
  type CreateReviewTaskFailedEventOpts,
  type ReviewTaskFailedReason,
} from "./review-events";

// --- Capability registry publisher (cortex#237 PR-3) ---
//
// Per `docs/design-capability-dispatch-review-consumer.md` §3 + §10.1
// PR-3. Re-exported here so PR-7's boot wiring (in `src/cortex.ts`) and
// pilot's deferred bucket reader (§13.1) consume the publisher + its
// constant from one place. The event-type constant
// (`CAPABILITY_REGISTERED_EVENT_TYPE`) is the load-bearing string both
// the publisher and any future subscriber filter against.
//
// PR-7 will additionally export the verdict + pull-subscriber types
// alongside these; until then the capability-registry surface lands
// here on its own per PR-3's brief.
export {
  CAPABILITY_REGISTERED_EVENT_TYPE,
  buildCapabilityRegisteredEnvelope,
  publishCapabilityRegistry,
  type BuildCapabilityRegisteredEnvelopeOpts,
  type CapabilityRegistryEntry,
  type CapabilityRegistrySource,
  type PublishCapabilityRegistryOptions,
  type PublishFn,
} from "./capability-registry";
