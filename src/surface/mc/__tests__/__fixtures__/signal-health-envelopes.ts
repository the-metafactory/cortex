/**
 * CANONICAL SIGNAL HEALTH ENVELOPE FIXTURES — provenance-pinned (cortex#1468).
 *
 * Sibling of `signal-transport-envelopes.ts` (cortex#1467), for the OTHER health
 * family the attention producer consumes: signal's SELF-observability events under
 * `system.signal.*` — the collector-degraded / backend-unreachable outages and
 * their recovery edges. Like C1's transport fixtures, these reproduce the
 * myelin-canonical envelope shapes signal's `SystemEventPublisher` puts on the
 * wire, derived from signal's OWN builder OUTPUT — so cortex's fixtures can never
 * pin an impossible shape (the dead-code failure mode that shipped the U2.1
 * attention arms against the phantom transport-backend names — a `transport` ns
 * with `backend` leaves that exist nowhere in signal: cortex#1468).
 *
 * PROVENANCE (pinned):
 *   - signal `main` @ 81eebaa (recovery emitters added by the-metafactory/signal#166)
 *   - publisher: signal/src/lib/system-events/publisher.ts
 *               (FailureMode union :99-104; SYSTEM_SIGNAL_SUBJECT_GRAMMAR :190-191;
 *                header subject list :23-46 — seven closed leaves under system.signal.*)
 *   - shared:   signal/src/lib/system-events/envelope.ts
 *               (buildCanonicalSystemEnvelope; SOURCE_COMPONENT = "signal";
 *                DEFAULT_DATA_RESIDENCY = "NZ")
 *   - oracle:   signal/src/lib/system-events/__tests__/canonical-envelope-schema.test.ts
 *               (backend.reachable :183-198; collector.recovered :166-181)
 *
 * THE WIRE TRUTH (signal U0.4 canonicalisation), test-pinned by the oracle:
 *   - The four health leaves consumed here — `backend.unreachable`,
 *     `backend.reachable`, `collector.degraded`, `collector.recovered` — are
 *     HYPHEN-FREE, so the subject leaf and the envelope BODY `type` are IDENTICAL
 *     (no `_`→`-` mapping applies; contrast C1's `leaf_connect`→`leaf-connect`).
 *   - envelope BODY `type` == subject tail  (`system.signal.backend.unreachable`)
 *   - `payload.failure_mode`               → the two-segment leaf (`backend.unreachable`)
 *   - `payload.reason`                     → free-form human string
 *   - `payload.attributes`                 → caller-supplied fields are NESTED here,
 *     NOT hoisted to the payload top level (signal `buildEnvelope` :499-508). Signal
 *     stamps `exporter_id` under `attributes` (oracle :189) — there is NO fixed id
 *     contract at the payload top level (publisher.ts:115-124).
 *
 *   CONSEQUENCE for the attention producer: its `idKeys` read the payload TOP LEVEL
 *   (`backend`/`backend_id`/`id`; `collector_id`/`collector`/`id`) — none of which
 *   the real wire populates — so production ALWAYS falls back to the namespace id
 *   (`att:adapter:transport:transport`, `att:adapter:collector:collector`). These
 *   fixtures reproduce that faithfully: the id lives under `attributes.exporter_id`,
 *   so the producer-driven tests assert the FALLBACK ids production really delivers.
 *   Per-origin attribution (e.g. `transport:victoria`) would require the producer to
 *   read `payload.attributes.exporter_id` — a FUTURE enhancement, out of #1468 scope.
 *
 * ANTI-DRIFT: the companion test (`signal-health-envelopes.test.ts`) routes every
 * fixture through cortex's vendored myelin `validateEnvelope`, so a schema-invalid
 * fixture FAILS the suite — the belt the old direct-fold fixtures bypassed. Because
 * these leaves carry no underscore, the negative case is a type-grammar violation
 * injected by `toInvalidType` (an underscore in the leaf) rather than a
 * subject-leaf remap.
 */

import type { Envelope } from "../../../../bus/myelin/envelope-validator";

/** Where these shapes came from — cite in review, and when regenerating. */
export const SIGNAL_HEALTH_PROVENANCE = {
  repo: "the-metafactory/signal",
  commit: "81eebaa",
  publisher: "src/lib/system-events/publisher.ts",
  shared: "src/lib/system-events/envelope.ts",
  oracle: "src/lib/system-events/__tests__/canonical-envelope-schema.test.ts",
} as const;

/**
 * The four `system.signal.*` health leaves the attention producer consumes. Both
 * families' outage/recovery pair. THE single source of truth for the spelling
 * across the MC tests; import these rather than hard-coding a string a future edit
 * could drift. (`tap.dropped` / `signing.failed` / `sovereignty.violated` are the
 * other three publisher leaves but are history-only — not health arms — so they
 * are out of scope here.)
 */
export const SIGNAL_HEALTH_TYPES = {
  backendUnreachable: "system.signal.backend.unreachable",
  backendReachable: "system.signal.backend.reachable",
  collectorDegraded: "system.signal.collector.degraded",
  collectorRecovered: "system.signal.collector.recovered",
} as const;

export type SignalHealthType =
  (typeof SIGNAL_HEALTH_TYPES)[keyof typeof SIGNAL_HEALTH_TYPES];

/** The `payload.failure_mode` (two-segment leaf) that signal stamps per type. */
const FAILURE_MODE_FOR_TYPE: Record<string, string> = {
  [SIGNAL_HEALTH_TYPES.backendUnreachable]: "backend.unreachable",
  [SIGNAL_HEALTH_TYPES.backendReachable]: "backend.reachable",
  [SIGNAL_HEALTH_TYPES.collectorDegraded]: "collector.degraded",
  [SIGNAL_HEALTH_TYPES.collectorRecovered]: "collector.recovered",
};

/**
 * Make a `type` the vendored myelin schema REJECTS, by injecting an underscore
 * into the final leaf (`backend.unreachable` → `backend.un_reachable`). The myelin
 * type grammar (`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$`) forbids `_`, so this
 * shape can never occur on the wire — the exact class of impossible spelling the
 * old phantom fixtures leaned on. Used by the anti-drift test to prove
 * `validateEnvelope` bites. (These health leaves carry no hyphen, so C1's
 * `-`→`_` remap does not apply; we inject the invalid char directly.)
 */
export function toInvalidType(type: string): string {
  const segments = type.split(".");
  const last = segments[segments.length - 1] ?? "";
  // Splice an underscore into the middle of the final segment.
  const mid = Math.max(1, Math.floor(last.length / 2));
  segments[segments.length - 1] = `${last.slice(0, mid)}_${last.slice(mid)}`;
  return segments.join(".");
}

interface BuildOpts {
  payload?: Record<string, unknown>;
  id?: string;
}

/**
 * Build a canonical signal self-observability envelope for `type` (one of the four
 * health leaves), reproducing `buildCanonicalSystemEnvelope`'s output: 3-segment
 * `source` `{principal}.{stack}.signal`, `local` sovereignty with NZ residency,
 * and a free-form health `payload` carrying `failure_mode` + `reason`. The result
 * passes cortex's vendored myelin schema via `validateEnvelope`.
 */
export function makeSignalHealthEnvelope(type: string, opts: BuildOpts = {}): Envelope {
  const failureMode = FAILURE_MODE_FOR_TYPE[type] ?? "backend.unreachable";
  const envelope = {
    id: opts.id ?? crypto.randomUUID(),
    source: "andreas.laptop.signal",
    type,
    timestamp: "2026-06-12T00:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: { failure_mode: failureMode, reason: `${failureMode} health edge`, ...opts.payload },
    extensions: {
      schema_version: "2",
      namespace: { domain: "system", entity: "signal", action: failureMode },
      stack_id: "andreas/laptop",
    },
  };
  // The vendored myelin `Envelope` type is hand-narrowed; the extra canonical
  // fields (extensions.*) ride along untyped exactly as on the real wire.
  return envelope as unknown as Envelope;
}

/** A ready per-family fixture set with realistic signal-health bodies. */
export interface SignalHealthFixture {
  /** The family label (for test names). */
  family: "backend-unreachable" | "backend-reachable" | "collector-degraded" | "collector-recovered";
  /** Whether this leaf OPENS an outage item or RESOLVES one. */
  opens: boolean;
  /** The `system.signal.*` body `type` (== subject tail; hyphen-free). */
  type: string;
  /** A canonical, schema-valid envelope of this family. */
  envelope: Envelope;
  /** The free-form health body (`{ failure_mode, reason, attributes? }`). */
  payload: Record<string, unknown>;
}

/**
 * The canonical four health leaves — the fixture set the MC attention tests fold.
 *
 * Payloads are WIRE-FAITHFUL: the identifying `exporter_id` is nested under
 * `attributes` exactly as signal's `buildEnvelope` emits it (:499-508, oracle
 * :189) — NOT hoisted to the payload top level. Because the attention producer's
 * `idKeys` only read the top level, these fixtures deterministically drive the
 * NAMESPACE-FALLBACK item ids that production actually delivers.
 */
export const SIGNAL_HEALTH_FIXTURES: readonly SignalHealthFixture[] = [
  {
    family: "backend-unreachable",
    opens: true,
    type: SIGNAL_HEALTH_TYPES.backendUnreachable,
    payload: { failure_mode: "backend.unreachable", reason: 'exporter "victoria" backend unreachable', attributes: { exporter_id: "victoria" } },
    envelope: makeSignalHealthEnvelope(SIGNAL_HEALTH_TYPES.backendUnreachable, {
      payload: { failure_mode: "backend.unreachable", reason: 'exporter "victoria" backend unreachable', attributes: { exporter_id: "victoria" } },
    }),
  },
  {
    family: "backend-reachable",
    opens: false,
    type: SIGNAL_HEALTH_TYPES.backendReachable,
    payload: { failure_mode: "backend.reachable", reason: 'exporter "victoria" backend reachable again', attributes: { exporter_id: "victoria" } },
    envelope: makeSignalHealthEnvelope(SIGNAL_HEALTH_TYPES.backendReachable, {
      payload: { failure_mode: "backend.reachable", reason: 'exporter "victoria" backend reachable again', attributes: { exporter_id: "victoria" } },
    }),
  },
  {
    family: "collector-degraded",
    opens: true,
    type: SIGNAL_HEALTH_TYPES.collectorDegraded,
    payload: { failure_mode: "collector.degraded", reason: "collector falling behind", attributes: { exporter_id: "relay-1" } },
    envelope: makeSignalHealthEnvelope(SIGNAL_HEALTH_TYPES.collectorDegraded, {
      payload: { failure_mode: "collector.degraded", reason: "collector falling behind", attributes: { exporter_id: "relay-1" } },
    }),
  },
  {
    family: "collector-recovered",
    opens: false,
    type: SIGNAL_HEALTH_TYPES.collectorRecovered,
    payload: { failure_mode: "collector.recovered", reason: "collector recovered from degraded state", attributes: { exporter_id: "relay-1" } },
    envelope: makeSignalHealthEnvelope(SIGNAL_HEALTH_TYPES.collectorRecovered, {
      payload: { failure_mode: "collector.recovered", reason: "collector recovered from degraded state", attributes: { exporter_id: "relay-1" } },
    }),
  },
] as const;
