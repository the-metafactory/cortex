/**
 * G-1100.B / IAW Phase A.2: Myelin envelope validator.
 *
 * Validates inbound envelopes against the vendored myelin schema. The
 * schema is copied verbatim from `~/Developer/myelin/schemas/envelope.schema.json`
 * pinned at commit 4578ae1 (myelin main, post-F-021 + MY-400 chain-of-stamps
 * + F-15 economics + F-5 sovereignty policy + F-10 bidding + F-11 capability
 * discovery + F-019/F-020 task subjects).
 *
 * Per docs/design-collaboration-surface.md §9 coupling rules, cortex MUST
 * NOT import from `myelin/` at runtime — the schema travels with us by
 * value. To upgrade the schema: copy the file, update the
 * `SCHEMA_SOURCE_COMMIT` constant, extend the vendored types below, run the
 * tests, ship a PR. There is no auto-sync.
 *
 * **IAW Phase A.2 bump (from commit 96b14ea → 4578ae1):**
 *
 * The vendored Envelope interface now mirrors the post-F-021 wire shape.
 * New optional fields surfaced (NOT consumed for trust decisions in this
 * slice — that's IAW Phase B / cortex#102):
 *
 *   - `signed_by` accepts a single stamp OR a chain (`SignedBy[]`) per
 *     myelin#31. `getSignedByChain()` normalises both shapes into an array.
 *   - `requirements`, `sovereignty_required`, `deadline`,
 *     `distribution_mode`, `target_principal` per F-021.
 *   - `economics` upgraded to F-15 typed shape (`budget` / `actual` /
 *     `wallet` / `billing_ref` / `currency`), still optional and not
 *     security-bearing per myelin architecture.md §5.2.
 *   - Stamps may carry an optional semantic `role` (`origin` / `transit` /
 *     `accountability` / `sovereignty` / `notary`) per myelin#31.
 */

// The myelin schema declares draft 2020-12 ($schema), so use Ajv's
// 2020-12 build rather than the default draft-07 entry point.
import Ajv2020, { type ValidateFunction, type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./vendor/envelope.schema.json" with { type: "json" };

/** Pin so future maintainers know which myelin commit the schema was lifted from. */
export const SCHEMA_SOURCE_COMMIT = "4578ae1e9bc595e667fbb356ea2c12c8c2c3cc8a";

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
  /**
   * F-15 economics block — token budget, actual usage, billing attribution.
   * Mutable annotation field; intermediaries may aggregate. Per myelin
   * `architecture.md` §5.2 this field MUST NOT inform security or trust
   * decisions — surface it for observability and cost accounting only.
   */
  economics?: Economics;
  /** Forward-compatible metadata. Optional. */
  extensions?: Record<string, unknown>;
  /** Arbitrary signal content. */
  payload: Record<string, unknown>;
  /**
   * Identity attestation — proves who sent this envelope. Optional in the
   * schema (envelopes predate MY-400 identity layer).
   *
   * **Wire shapes accepted (myelin#31 chain-of-stamps):**
   *   - Single stamp object (legacy back-compat shim, single signer).
   *   - Array of stamps (canonical post-#31 chain form). Each stamp signs
   *     the canonical bytes of the envelope *including the prior chain* —
   *     tampering with any earlier stamp invalidates every subsequent
   *     stamp's signature.
   *
   * Cortex callers that want a uniform view should use
   * {@link getSignedByChain} to normalise both shapes to `SignedBy[]`.
   *
   * IAW Phase A.2: `signed_by` is **surfaced but not yet consumed for
   * trust decisions** — that wiring lands in IAW Phase B (cortex#102).
   */
  signed_by?: SignedBy | SignedBy[];
  /**
   * F-021 — capability tags the task needs. Matched against AGENT_CAPABILITIES
   * (myelin#11). Empty array = no filter. Pattern parallels DID_RE: no
   * trailing or consecutive hyphens.
   */
  requirements?: string[];
  /**
   * F-021 — minimum agent sovereignty mode required to ack the task.
   *
   * | mode | semantics |
   * |---|---|
   * | `open` | ack all |
   * | `selective` | evaluate-and-may-nak |
   * | `strict` | explicit capability + sovereignty match |
   * | `bidding` | F-10 broadcast bid-request, collect signed responses, select winner |
   */
  sovereignty_required?: SovereigntyRequirement;
  /** F-021 — ISO-8601 absolute soft deadline. Informs nak `not-now` decisions. */
  deadline?: string;
  /**
   * F-021 — operator-facing routing semantics.
   *
   * | mode | semantics |
   * |---|---|
   * | `broadcast` | competing consumers — first ack wins |
   * | `direct` | named recipient — requires `target_principal` |
   * | `delegate` | outcome handoff (multi-step orchestration) — requires `target_principal` |
   */
  distribution_mode?: DistributionMode;
  /**
   * F-021 — required when `distribution_mode` is `direct` or `delegate`.
   * DID of the receiving agent (`did:mf:<name>`).
   */
  target_principal?: string;
}

/**
 * Discriminated stamp shape — one entry in an envelope's `signed_by` chain.
 * `method` selects which fields are present:
 *   - `"ed25519"` — bare per-bot signature; intra-org trust.
 *   - `"hub-stamp"` — federation hub re-signature for cross-org trust.
 *
 * Optional `role` (myelin#31) is the semantic position of the stamp in the
 * chain (`origin` / `transit` / `accountability` / `sovereignty` / `notary`).
 * Consumers that need role-aware predicates MUST handle the undefined case
 * — pre-#31 stamps and the legacy shim do not carry a role.
 */
export type SignedBy = SignedByEd25519 | SignedByHubStamp;

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
  /** Optional semantic role of this stamp in the chain (myelin#31). */
  role?: StampRole;
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
  /** Optional semantic role of this stamp in the chain (myelin#31). */
  role?: StampRole;
}

/**
 * Semantic position of a stamp inside a chain (myelin#31). Roles describe
 * what the stamp ATTESTS, not what the principal IS. Optional for
 * back-compat — pre-#31 stamps do not carry a role.
 */
export type StampRole =
  | "origin"
  | "transit"
  | "accountability"
  | "sovereignty"
  | "notary";

/**
 * F-021 — `sovereignty_required` enum. Determines how aggressively
 * candidates may decline a task before nakking.
 */
export type SovereigntyRequirement =
  | "open"
  | "selective"
  | "strict"
  | "bidding";

/** F-021 — `distribution_mode` enum. */
export type DistributionMode = "broadcast" | "direct" | "delegate";

/**
 * F-15 economics — token budget, actual usage, billing attribution.
 *
 * Per myelin `architecture.md` §5.2, this is a **mutable annotation field**
 * sitting intentionally outside the L4 signature so intermediaries can
 * accumulate cost without invalidating attestations. It MUST NOT inform
 * security or trust decisions — surface it for observability only.
 */
export interface Economics {
  /** Publisher-set constraints on resource usage. */
  budget?: EconomicsBudget;
  /** Actual usage populated by executor; aggregated by hubs in delegate chains. */
  actual?: EconomicsActual;
  /** DID of principal receiving/paying for this work. */
  wallet?: string;
  /** External invoice or tracking reference. */
  billing_ref?: string;
  /** ISO 4217 currency code when not USD. */
  currency?: string;
  /** Forward-compatible — schema allows additional properties. */
  [key: string]: unknown;
}

export interface EconomicsBudget {
  /** Maximum total tokens (input + output) permitted. */
  max_tokens?: number;
  /** Maximum cost in USD. */
  max_cost_usd?: number;
  [key: string]: unknown;
}

export interface EconomicsActual {
  /** LLM input tokens consumed. */
  input_tokens?: number;
  /** LLM output tokens generated. */
  output_tokens?: number;
  /** Convenience total — may equal input + output, may not (delegate aggregation). */
  total_tokens?: number;
  /** Lowercase model identifier (e.g. `claude-sonnet-4`, `gpt-4o`). */
  model?: string;
  /** Execution duration in milliseconds. */
  duration_ms?: number;
  /** Computed cost in USD. */
  cost_usd?: number;
  [key: string]: unknown;
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

/**
 * Normalise `envelope.signed_by` into a stamp chain (myelin#31).
 *
 * The wire format accepts two shapes — a single stamp object (legacy
 * back-compat shim) or an array of stamps (canonical post-#31 form). This
 * helper coerces both into `SignedBy[]` without mutating the input. An
 * unsigned envelope returns `[]`.
 *
 * IAW Phase A.2: this is the **surfacing** primitive. Trust-decision
 * wiring (verify signatures, walk roles, enforce sovereignty against the
 * chain) is IAW Phase B (cortex#102). Today, the chain is exposed so
 * downstream consumers can log it, count hops, and start building Phase B
 * fixtures against real shapes.
 *
 * Pure function. No side effects. Safe to call from any context.
 */
export function getSignedByChain(envelope: Envelope): SignedBy[] {
  const value = envelope.signed_by;
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  return [];
}

/**
 * Return the principal of the LAST stamp in the chain, or `undefined` for
 * unsigned envelopes. The last stamp is the most recent attestor — the
 * entity that actually published the envelope on this hop.
 *
 * Surfacing primitive — paired with {@link getSignedByChain}. Not yet
 * consumed for trust decisions in cortex (Phase B / cortex#102 territory).
 */
export function getLastStampPrincipal(envelope: Envelope): string | undefined {
  const chain = getSignedByChain(envelope);
  if (chain.length === 0) return undefined;
  return chain[chain.length - 1]!.principal;
}
