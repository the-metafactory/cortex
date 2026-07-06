/**
 * CANONICAL SIGNAL TRANSPORT ENVELOPE FIXTURES — provenance-pinned (cortex#1467).
 *
 * These reproduce the myelin-canonical `system.transport.*` envelope shapes that
 * signal's `SystemTransportPublisher` puts on the wire, derived from signal's OWN
 * builder OUTPUT rather than hand-invented — so cortex's fixtures can never again
 * pin an IMPOSSIBLE shape (the underscore-typed body that every real envelope's
 * AJV validation rejects, which is why the U2.3 overlay + U2.1 attention arms
 * shipped as dead code: cortex#1467 / signal recommendation 8).
 *
 * PROVENANCE (pinned):
 *   - signal `main` @ 81eebaa
 *   - builder:  signal/src/lib/transport-observability/publisher.ts
 *               (buildEnvelope → buildCanonicalSystemEnvelope)
 *   - shared:   signal/src/lib/system-events/envelope.ts
 *               (subjectTailToType maps subject-tail `_`→`-` for the body `type`;
 *                SOURCE_COMPONENT = "signal"; DEFAULT_DATA_RESIDENCY = "NZ")
 *   - oracle:   signal/src/lib/system-events/__tests__/canonical-envelope-schema.test.ts
 *               (transport leaf-connect :200-220; underscore-rejection :309-322)
 *
 * THE WIRE TRUTH (signal U0.4 canonicalisation), test-pinned by the oracle:
 *   - envelope BODY `type`          → HYPHENS      (`system.transport.leaf-connect`)
 *   - NATS SUBJECT                  → underscores  (`...system.transport.leaf_connect`)
 *   - `extensions.namespace.action` → underscores  (the exact subject-leaf action)
 *   - `payload.action`              → underscores  (the `TransportAction` enum)
 *
 * A fixture's top-level `type` MUST be the hyphen form: cortex's vendored myelin
 * schema (`src/bus/myelin/vendor/envelope.schema.json`, `type` pattern
 * `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$`) forbids `_`, so an underscore type
 * is REJECTED — signal pins exactly this at canonical-envelope-schema.test.ts:319.
 * The companion test (`signal-transport-envelopes.test.ts`) routes every fixture
 * through `validateEnvelope`, so a schema-invalid (underscore-typed) fixture FAILS
 * the suite — the anti-drift belt that the old fixtures bypassed by calling the
 * fold/producer directly, never touching AJV.
 */

import type { Envelope } from "../../../../bus/myelin/envelope-validator";

/** Where these shapes came from — cite in review, and when regenerating. */
export const SIGNAL_ENVELOPE_PROVENANCE = {
  repo: "the-metafactory/signal",
  commit: "81eebaa",
  builder: "src/lib/transport-observability/publisher.ts",
  shared: "src/lib/system-events/envelope.ts",
  oracle: "src/lib/system-events/__tests__/canonical-envelope-schema.test.ts",
} as const;

/**
 * The four transport envelope BODY `type` values — hyphen-mapped per the myelin
 * type grammar. THE single source of truth for the spelling across the MC tests;
 * import these rather than hard-coding a string a future edit could drift.
 */
export const TRANSPORT_TYPES = {
  leafConnect: "system.transport.leaf-connect",
  leafDisconnect: "system.transport.leaf-disconnect",
  livenessDrift: "system.transport.liveness-drift",
  rosterSnapshot: "system.transport.roster-snapshot",
} as const;

export type TransportType = (typeof TRANSPORT_TYPES)[keyof typeof TRANSPORT_TYPES];

/**
 * The hub SERVER-vitals body `type` (signal#154) — hyphen-mapped like the four
 * families above, but a DISTINCT category: not a per-peer/leaf observation but
 * the hub's own `/varz` resource vitals (cortex#1469). Kept out of
 * {@link TRANSPORT_TYPES} because that constant is asserted to be exactly the
 * four leaf/roster families the Network-view overlay folds; the vitals strip
 * folds this one instead. Subject stays underscored (`...server_vitals`); the
 * envelope body `type` is the hyphen form — the only spelling the myelin schema
 * (and this fixture) accepts.
 */
export const SERVER_VITALS_TYPE = "system.transport.server-vitals" as const;

/** The subject-leaf action (underscores) that pairs with each hyphen `type`. */
const ACTION_FOR_TYPE: Record<string, string> = {
  [TRANSPORT_TYPES.leafConnect]: "leaf_connect",
  [TRANSPORT_TYPES.leafDisconnect]: "leaf_disconnect",
  [TRANSPORT_TYPES.livenessDrift]: "liveness_drift",
  [TRANSPORT_TYPES.rosterSnapshot]: "roster_snapshot",
  [SERVER_VITALS_TYPE]: "server_vitals",
};

/**
 * The underscore (subject-leaf) form of a hyphen `type` — the IMPOSSIBLE body
 * spelling the myelin schema rejects. Only the trailing action segment carries a
 * hyphen (`system`/`transport` do not), so a global `-`→`_` is exact here.
 * Used by the anti-drift test to prove `validateEnvelope` fails the bad shape.
 */
export function toUnderscoreType(hyphenType: string): string {
  return hyphenType.replace(/-/g, "_");
}

/** One observed NATS leaf — mirrors signal's `ObservedLeaf` (oracle :203-211). */
const OBSERVED_LEAF = {
  principal: "jc",
  stack: "default",
  network: "metafactory-community",
  up_since: "2026-06-10T03:00:00.000Z",
  rtt_ms: 8.4,
  last_seen: null,
  frames: { in_msgs: 16, out_msgs: 4, in_bytes: 2048, out_bytes: 512 },
} as const;

interface BuildOpts {
  payload?: Record<string, unknown>;
  id?: string;
}

/**
 * Build a canonical signal transport envelope for `type` (hyphen form),
 * reproducing `buildCanonicalSystemEnvelope`'s output field-for-field: 3-segment
 * `source` `{principal}.{stack}.signal`, `local` sovereignty with NZ residency,
 * and `extensions.namespace.action` carrying the underscore subject-leaf action.
 * The result passes cortex's vendored myelin schema via `validateEnvelope`.
 */
export function makeTransportEnvelope(type: string, opts: BuildOpts = {}): Envelope {
  const action = ACTION_FOR_TYPE[type] ?? "leaf_connect";
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
    payload: { action, network: "metafactory-community", ...opts.payload },
    extensions: {
      schema_version: "2",
      namespace: { domain: "system", entity: "transport", action },
      stack_id: "andreas/laptop",
    },
  };
  // The vendored myelin `Envelope` type is hand-narrowed; the extra canonical
  // fields (extensions.*) ride along untyped exactly as on the real wire.
  return envelope as unknown as Envelope;
}

/** A ready per-family fixture set with realistic transport bodies. */
export interface TransportFamilyFixture {
  /** The family label (for test names). */
  family: "leaf-connect" | "leaf-disconnect" | "liveness-drift" | "roster-snapshot";
  /** Hyphen-mapped body `type`. */
  type: string;
  /** A canonical, schema-valid envelope of this family. */
  envelope: Envelope;
  /** The transport body (`{ action, network, leaf?/leaves?/attributes? }`). */
  payload: Record<string, unknown>;
  /** The `{principal}/{stack}` this observation resolves to (for overlay asserts). */
  peer: { principal: string; stack: string };
}

/** The canonical four transport families — the fixture set the MC tests fold. */
export const TRANSPORT_FAMILY_FIXTURES: readonly TransportFamilyFixture[] = [
  {
    family: "leaf-connect",
    type: TRANSPORT_TYPES.leafConnect,
    payload: { leaf: { ...OBSERVED_LEAF } },
    envelope: makeTransportEnvelope(TRANSPORT_TYPES.leafConnect, {
      payload: { leaf: { ...OBSERVED_LEAF } },
    }),
    peer: { principal: "jc", stack: "default" },
  },
  {
    family: "leaf-disconnect",
    type: TRANSPORT_TYPES.leafDisconnect,
    payload: {
      leaf: { ...OBSERVED_LEAF, rtt_ms: null, last_seen: "2026-06-12T00:00:00.000Z" },
    },
    envelope: makeTransportEnvelope(TRANSPORT_TYPES.leafDisconnect, {
      payload: {
        leaf: { ...OBSERVED_LEAF, rtt_ms: null, last_seen: "2026-06-12T00:00:00.000Z" },
      },
    }),
    peer: { principal: "jc", stack: "default" },
  },
  {
    family: "liveness-drift",
    type: TRANSPORT_TYPES.livenessDrift,
    payload: {
      reason: "peer jc/default → connected",
      attributes: { peer: "jc/default", principal: "jc", stack: "default", from: null, to: "connected" },
    },
    envelope: makeTransportEnvelope(TRANSPORT_TYPES.livenessDrift, {
      payload: {
        reason: "peer jc/default → connected",
        attributes: { peer: "jc/default", principal: "jc", stack: "default", from: null, to: "connected" },
      },
    }),
    peer: { principal: "jc", stack: "default" },
  },
  {
    family: "roster-snapshot",
    type: TRANSPORT_TYPES.rosterSnapshot,
    payload: { leaves: [{ ...OBSERVED_LEAF }] },
    envelope: makeTransportEnvelope(TRANSPORT_TYPES.rosterSnapshot, {
      payload: { leaves: [{ ...OBSERVED_LEAF }] },
    }),
    peer: { principal: "jc", stack: "default" },
  },
] as const;

// ---------------------------------------------------------------------------
// Hub SERVER-vitals (signal#154 / cortex#1469) — a distinct transport body:
// the hub's own `/varz` resource vitals, not a per-leaf observation. Reproduced
// field-for-field from the pinned oracle
// (signal canonical-envelope-schema.test.ts "server_vitals" case, signal @
// 81eebaa) so the vitals strip folds the SAME shape production emits.
// ---------------------------------------------------------------------------

/**
 * The canonical `ServerVitals` body — verbatim from the signal oracle. Field
 * names are signal's `ServerVitals` interface
 * (`src/lib/transport-observability/leafz-parser.ts`); numeric fields are
 * concrete, string fields are non-null here (the strip tolerates null strings
 * and a missing `vitals` separately — exercised in the fold unit tests).
 */
export const CANONICAL_SERVER_VITALS = {
  server_id: "ND5XYZHUBSERVER000000000000000000000000000000000000",
  server_name: "metafactory-hub",
  version: "2.10.18",
  uptime: "3d4h5m6s",
  connections: 5,
  leafnodes: 2,
  routes: 0,
  subscriptions: 87,
  slow_consumers: 1,
  mem: 134217728,
  cpu: 12.5,
  frames: { in_msgs: 100, out_msgs: 200, in_bytes: 300, out_bytes: 400 },
} as const;

/**
 * A canonical, schema-valid `system.transport.server-vitals` envelope carrying
 * {@link CANONICAL_SERVER_VITALS}. Built through {@link makeTransportEnvelope}
 * (same builder as the four families) so it clears cortex's vendored myelin
 * schema via `validateEnvelope` — the vitals-strip tests assert validity BEFORE
 * folding, closing the same anti-drift hole cortex#1467 named.
 */
export const SERVER_VITALS_FIXTURE = {
  type: SERVER_VITALS_TYPE,
  network: "metafactory-community",
  vitals: CANONICAL_SERVER_VITALS,
  envelope: makeTransportEnvelope(SERVER_VITALS_TYPE, {
    payload: { network: "metafactory-community", vitals: CANONICAL_SERVER_VITALS },
  }),
} as const;

/**
 * Build a `system.transport.server-vitals` envelope for `network`, optionally
 * overriding individual `vitals` fields (e.g. a null string or a different
 * `cpu`). Used by the fold tests to seed newest-per-network + tolerance cases
 * without hand-writing envelope scaffolding.
 */
export function makeServerVitalsEnvelope(
  network: string,
  vitalsOverrides: Record<string, unknown> = {},
  opts: { id?: string } = {},
): Envelope {
  return makeTransportEnvelope(SERVER_VITALS_TYPE, {
    id: opts.id,
    payload: {
      network,
      vitals: { ...CANONICAL_SERVER_VITALS, ...vitalsOverrides },
    },
  });
}
