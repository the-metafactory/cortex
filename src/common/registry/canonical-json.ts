/**
 * Canonical JSON — the SINGLE shared source of truth (#1416).
 *
 * Both the network-registry Worker (`src/services/network-registry/src/signing.ts`)
 * and the cortex-side client (`src/common/registry/signing.ts`) MUST agree
 * byte-for-byte on what was signed. This was previously two hand-maintained
 * mirrors kept identical by discipline + round-trip tests; any drift (a rule
 * added to one, not the other) silently re-opened a signature-bytes mismatch —
 * a self-inflicted 401 on one path. This module is that one canonicaliser; both
 * `signing.ts` files import + re-export from here, so they cannot diverge.
 *
 * BUILD BOUNDARY (why this file is deliberately minimal). The registry is a
 * separate deployable package (own package.json / tsconfig / wrangler.toml) that
 * bundles for Cloudflare Workers; the client builds for bun/node. This module is
 * therefore PURE TypeScript with ZERO imports and uses ONLY universal built-ins
 * (`JSON.stringify`, `Object.keys`, `Array.isArray`) — no `atob`/`crypto`/node
 * or worker-only APIs. That is precisely why only `canonicalJSON` (+ its guards)
 * lives here and the base64/Ed25519 primitives — which need `atob`/`crypto.subtle`
 * and differ by target — stay in each side's `signing.ts`. A pure leaf module
 * bundles cleanly into the Worker (one extra file, no transitive deps) and
 * tsc-checks under both tsconfigs.
 *
 * Scheme: recursive sort-keys canonicalisation (RFC 8785 / JCS for the primitive
 * cases the registry actually signs — strings + small integer timestamps). Object
 * keys emitted in lexicographic order, arrays preserve order, no whitespace,
 * `undefined`-valued object keys skipped (to match `JSON.stringify` after a
 * parse/stringify round-trip).
 */

// =============================================================================
// Limits — the pre-auth DoS guards (#832 depth, #1418 width/size)
// =============================================================================

/**
 * Hard cap on nesting depth (#832). The register route canonicalizes the claim
 * AS RECEIVED — unauthenticated, attacker-controlled: verify runs BEFORE the
 * signature is proven — so this recursion can be driven by hostile input. A
 * legitimate claim nests ~3 levels (claim → stacks[] → metadata map); 64 is far
 * beyond any real claim yet shallow enough a deeply-nested body cannot exhaust
 * the stack.
 */
export const MAX_CANONICAL_DEPTH = 64;

/**
 * Max keys in a SINGLE object (#1418). The headline pre-auth amplification is a
 * body with ~1e6 flat top-level keys: canonicalJSON would `Object.keys(...).sort()`
 * all of them BEFORE the signature is checked. We bound the per-object key count
 * and throw BEFORE the sort. A real claim object carries ~dozens of keys; 4096 is
 * ~40× the largest plausible signing input, so it never fires for legit traffic.
 */
export const MAX_CANONICAL_KEYS = 4096;

/**
 * Max elements in a SINGLE array (#1418). Bounds a hostile `stacks[]` /
 * `capabilities[]` (or any array) the same way as object width. Real arrays hold
 * a handful of entries; 4096 is generous headroom.
 */
export const MAX_CANONICAL_ARRAY_LEN = 4096;

/**
 * Aggregate ceiling on TOTAL container entries visited across the whole structure
 * (#1418). The per-object / per-array caps stop the single-wide-node attack; this
 * bounds a DISTRIBUTED one (e.g. 4000 objects × 4000 keys) that stays under each
 * per-node cap but sums to millions. A legit claim visits a few dozen entries;
 * 200k is an enormous safety margin yet a hard bound on total pre-auth work.
 */
export const MAX_CANONICAL_NODES = 200_000;

/** Thrown by {@link canonicalJSON} when nesting exceeds {@link MAX_CANONICAL_DEPTH}. */
export class CanonicalDepthError extends Error {
  constructor() {
    super(`canonical JSON nesting exceeded ${MAX_CANONICAL_DEPTH} levels`);
    this.name = "CanonicalDepthError";
  }
}

/**
 * Thrown by {@link canonicalJSON} when a single object's key count, a single
 * array's length, or the total container-entry budget is exceeded (#1418). The
 * register verify path catches every canonicalJSON throw and fails closed
 * (`signature_invalid`, 401) — an over-wide body can never match a legitimate
 * signature, so it is shed exactly like an over-deep one, never a 500.
 */
export class CanonicalWidthError extends Error {
  constructor(detail: string) {
    super(`canonical JSON width/size limit exceeded: ${detail}`);
    this.name = "CanonicalWidthError";
  }
}

// =============================================================================
// canonicalJSON
// =============================================================================

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, arrays in
 * order, `undefined`-valued keys skipped. Throws on cycles (JSON.stringify
 * behaviour), on nesting past {@link MAX_CANONICAL_DEPTH}, and on width/size past
 * the {@link MAX_CANONICAL_KEYS} / {@link MAX_CANONICAL_ARRAY_LEN} /
 * {@link MAX_CANONICAL_NODES} caps.
 *
 * The width/size guards NEVER change the emitted bytes for any input that stays
 * under the caps — they only throw — so every legitimate claim canonicalizes to
 * the exact same string the pre-#1418 canonicaliser produced (round-trip
 * identity is preserved; the drift/round-trip tests lock this).
 */
export function canonicalJSON(value: unknown): string {
  return canonicalize(value, 0, { nodes: 0 });
}

/** Mutable, per-top-level-call budget threaded through the recursion. */
interface CanonicalBudget {
  /** Running total of container entries (object keys + array elements) visited. */
  nodes: number;
}

function canonicalize(value: unknown, depth: number, budget: CanonicalBudget): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalDepthError();
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // Fail fast: bound this array's length BEFORE mapping over it.
    if (value.length > MAX_CANONICAL_ARRAY_LEN) {
      throw new CanonicalWidthError(
        `array length ${value.length} exceeds ${MAX_CANONICAL_ARRAY_LEN}`,
      );
    }
    budget.nodes += value.length;
    if (budget.nodes > MAX_CANONICAL_NODES) {
      throw new CanonicalWidthError(
        `total node budget exceeded ${MAX_CANONICAL_NODES}`,
      );
    }
    return "[" + value.map((v) => canonicalize(v, depth + 1, budget)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  // Fail fast: bound the RAW key count BEFORE the O(n log n) sort — the sort is
  // the exact pre-auth amplification #1418 calls out.
  const rawKeys = Object.keys(obj);
  if (rawKeys.length > MAX_CANONICAL_KEYS) {
    throw new CanonicalWidthError(
      `object key count ${rawKeys.length} exceeds ${MAX_CANONICAL_KEYS}`,
    );
  }
  budget.nodes += rawKeys.length;
  if (budget.nodes > MAX_CANONICAL_NODES) {
    throw new CanonicalWidthError(
      `total node budget exceeded ${MAX_CANONICAL_NODES}`,
    );
  }
  // Mirror JSON.stringify: skip `undefined`-valued keys so a claim built by
  // spread-with-optionals (`{ ...base, metadata: undefined }`) canonicalizes the
  // same as after a JSON.parse(JSON.stringify(...)) round-trip.
  const keys = rawKeys.filter((k) => obj[k] !== undefined).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k], depth + 1, budget));
  return "{" + parts.join(",") + "}";
}
