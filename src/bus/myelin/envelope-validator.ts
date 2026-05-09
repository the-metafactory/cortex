/**
 * G-1100.B: Myelin envelope validator.
 *
 * Validates inbound envelopes against the vendored myelin schema. The
 * schema is copied verbatim from `~/Developer/myelin/schemas/envelope.schema.json`
 * pinned at commit 96b14ea (myelin#22 — MY-400 Group 1: identity types).
 * Per docs/design-collaboration-surface.md §9 coupling rules, grove
 * MUST NOT import from `myelin/` at runtime — the schema travels with us
 * by value.
 *
 * To upgrade the schema: copy the file, update the `SCHEMA_SOURCE_COMMIT`
 * constant, run the tests, ship a PR. There is no auto-sync.
 */

// The myelin schema declares draft 2020-12 ($schema), so use Ajv's
// 2020-12 build rather than the default draft-07 entry point.
import Ajv2020, { type ValidateFunction, type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./vendor/envelope.schema.json" with { type: "json" };

/** Pin so future maintainers know which myelin commit the schema was lifted from. */
export const SCHEMA_SOURCE_COMMIT = "96b14ea6f0adfdface89d326e4e6cb36856a073f";

/**
 * Hand-typed Envelope shape matching the JSON Schema. We hand-write rather
 * than codegen because (a) the schema is small and stable, (b) the manual
 * type doubles as documentation for callers, (c) avoiding a build step keeps
 * the import-safe / zero-side-effect property of this module.
 */
export interface Envelope {
  /** UUID v4 — unique per envelope. */
  id: string;
  /** `org.agent.instance` — 2-5 dotted segments. */
  source: string;
  /** `domain.entity.action` — what kind of signal this is. */
  type: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** UUID v4 — links related envelopes across a workflow. Optional. */
  correlation_id?: string;
  /** The message's passport. Sovereignty travels with the envelope. */
  sovereignty: {
    classification: "local" | "federated" | "public";
    /** ISO 3166-1 alpha-2 country code (e.g. "NZ", "DE"). */
    data_residency: string;
    /** Maximum number of hops the envelope may traverse. ≥ 0. */
    max_hop: number;
    /** Whether the envelope's payload may be processed by frontier models. */
    frontier_ok: boolean;
    /** Constraint on which model class may process the payload. */
    model_class: "local-only" | "frontier" | "any";
  };
  /** Reserved for future marketplace integration. Empty object today. */
  economics?: Record<string, unknown>;
  /** Forward-compatible metadata. Optional. */
  extensions?: Record<string, unknown>;
  /** Arbitrary signal content. */
  payload: Record<string, unknown>;
  /**
   * Identity attestation — proves who sent this envelope. Optional in the
   * schema (envelope predates MY-400 identity layer). Discriminated on
   * `method`: `ed25519` is the bare per-bot signature; `hub-stamp` adds a
   * federation-hub re-signature for cross-org trust. Both shapes are
   * defined upstream — see `envelope.schema.json` `signed_by.oneOf`.
   */
  signed_by?: SignedByEd25519 | SignedByHubStamp;
}

/**
 * Bare ed25519 signature — the principal signs the envelope directly.
 * Used for intra-org traffic where every bot's `did:mf:*` principal is
 * trusted and key material is held locally.
 */
export interface SignedByEd25519 {
  method: "ed25519";
  /** Principal DID — `did:mf:<name>` per myelin convention. */
  principal: string;
  /** Base64-encoded ed25519 signature (88+ chars). */
  signature: string;
  /** ISO-8601 timestamp the signature was produced. */
  at: string;
}

/**
 * Hub-stamped signature — a federation hub re-signs after verifying the
 * principal's bare signature. Used for cross-org traffic where the
 * receiver trusts the hub but not necessarily the originating bot.
 */
export interface SignedByHubStamp {
  method: "hub-stamp";
  /** Originating principal — `did:mf:<name>`. */
  principal: string;
  /** Hub principal that re-signed — `did:mf:<hub-name>`. */
  stamped_by: string;
  /** Base64-encoded ed25519 signature from the hub. */
  signature: string;
  /** ISO-8601 timestamp the hub signed. */
  at: string;
}

export type ValidationResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; errors: ErrorObject[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled: ValidateFunction = ajv.compile(schema as object);

/**
 * Validate an unknown value against the myelin envelope schema. On success,
 * returns the value typed as `Envelope` (no defensive copy — the value
 * is the same reference). On failure, returns the Ajv error array.
 *
 * Pure function. Safe to call from any context. Compiled validator is
 * created once at module load.
 */
export function validateEnvelope(value: unknown): ValidationResult {
  if (compiled(value)) {
    return { ok: true, envelope: value as Envelope };
  }
  return { ok: false, errors: compiled.errors ?? [] };
}

/**
 * Convenience for callers that just want a typed envelope or `null` (and
 * are willing to swallow the error detail). For loggable callers, prefer
 * `validateEnvelope` so you can surface the specific failure path.
 */
export function tryParseEnvelope(value: unknown): Envelope | null {
  const result = validateEnvelope(value);
  return result.ok ? result.envelope : null;
}
