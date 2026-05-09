/**
 * G-1111.A — Payload filter (subset of EventBridge content-filter grammar).
 *
 * Per `/tmp/g-1111-spec.md` §4.3 — surfaces declare client-side payload
 * filters that run AFTER NATS broker-side subject matching. v1 supports a
 * deliberately small operator set; the rest of EventBridge's grammar
 * (numeric, cidr, wildcard, $or) is added only when a real adapter needs it.
 *
 * Operator support (v1):
 *   - exact match (any-of)        ["a", "b"]
 *   - anything-but                [{"anything-but": v}] | [{"anything-but": [v1, v2]}]
 *   - prefix                      [{"prefix": str}]
 *   - exists                      [{"exists": bool}]
 *   - equals-ignore-case          [{"equals-ignore-case": str}]
 *
 * Patterns are JSON-shape: keys nest by JSON structure, leaves are an
 * array of FilterValue (any one of which matches). A field passes iff the
 * actual value matches at least one entry in the leaf array. The whole
 * pattern passes iff every key in the pattern passes (logical AND across
 * keys, OR within a single key's array).
 *
 * Pure function. No side effects. Safe to call from any context.
 */

import type { Envelope } from "./myelin/envelope-validator";

/**
 * One acceptable form for a leaf in a payload-filter pattern. Strings,
 * numbers, and booleans are exact-match literals; the object forms are
 * the EventBridge-style operators.
 */
export type FilterValue =
  | string
  | number
  | boolean
  | { "anything-but": string | number | boolean | Array<string | number | boolean> }
  | { prefix: string }
  | { exists: boolean }
  | { "equals-ignore-case": string };

/**
 * A pattern matches a JSON object. Nesting follows the JSON structure of
 * the value being matched: a key whose value is an array of FilterValue
 * is a leaf; a key whose value is another PayloadFilterPattern descends
 * into that subtree.
 */
export type PayloadFilterPattern = {
  [key: string]: FilterValue[] | PayloadFilterPattern;
};

/**
 * A surface-adapter's full filter. The `envelope` pattern matches the
 * outer envelope context (type, source, correlation_id, etc.); the
 * `payload` pattern matches the envelope's payload object. Both are
 * optional — a filter with neither key matches everything (degenerate but
 * legal).
 */
export interface PayloadFilter {
  envelope?: PayloadFilterPattern;
  payload?: PayloadFilterPattern;
}

/**
 * Test whether `envelope` passes `filter`. `undefined` filter passes
 * (i.e., no filter = match all).
 *
 * Semantics:
 *   - The envelope-pattern (if present) is matched against the envelope
 *     object itself, treating the envelope as a JSON-like record.
 *   - The payload-pattern (if present) is matched against `envelope.payload`.
 *   - Both must pass when both are present.
 *
 * Missing fields:
 *   - For most operators, a missing field fails the leaf (no value to
 *     match) — except `{exists: false}`, which is exactly the "field is
 *     absent" predicate.
 *   - `{anything-but: ...}` on a missing field fails: there's nothing to
 *     compare, so we cannot prove the value is "anything but X". Mirrors
 *     EventBridge semantics — anything-but requires presence.
 */
export function matchesFilter(envelope: Envelope, filter: PayloadFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.envelope && !matchPattern(envelope as unknown as Record<string, unknown>, filter.envelope)) {
    return false;
  }
  if (filter.payload && !matchPattern(envelope.payload, filter.payload)) {
    return false;
  }
  return true;
}

// =============================================================================
// Internal — pattern walking
// =============================================================================

function matchPattern(value: unknown, pattern: PayloadFilterPattern): boolean {
  // Pattern is an object describing required structure of `value`. Every
  // key in the pattern must pass.
  if (!isPlainObject(value)) {
    // The pattern expects nested keys, but value isn't an object — only an
    // {exists: false} leaf can pass against a non-object value, but at the
    // pattern-root level the "object-ness" of value is presumed (we
    // entered matchPattern because the caller had an envelope/payload
    // record). For a nested non-object value reached via descent, the
    // pattern can only be satisfied if every key it requires is itself
    // declared `{exists: false}`. Walk the pattern and check.
    for (const key of Object.keys(pattern)) {
      const sub = pattern[key];
      if (!sub) continue;
      if (Array.isArray(sub)) {
        // Leaf: value at `value[key]` cannot be looked up because value
        // isn't an object — treat as missing.
        if (!matchLeaf(undefined, sub)) return false;
      } else {
        // Nested pattern but no object to descend into — match against
        // `undefined` recursively. Will pass only for fully-{exists:false}
        // subtrees.
        if (!matchPattern(undefined, sub)) return false;
      }
    }
    return true;
  }

  for (const key of Object.keys(pattern)) {
    const sub = pattern[key];
    if (!sub) continue;
    const fieldValue = (value as Record<string, unknown>)[key];
    if (Array.isArray(sub)) {
      if (!matchLeaf(fieldValue, sub)) return false;
    } else {
      if (!matchPattern(fieldValue, sub)) return false;
    }
  }
  return true;
}

function matchLeaf(actual: unknown, candidates: FilterValue[]): boolean {
  // Empty candidate list never matches (would be a useless pattern). EB
  // treats this as a config error; we choose "no match" for total-function
  // safety — a legal but vacuous leaf returns false.
  if (candidates.length === 0) return false;

  for (const candidate of candidates) {
    if (matchOne(actual, candidate)) return true;
  }
  return false;
}

function matchOne(actual: unknown, candidate: FilterValue): boolean {
  // Literal exact-match — strings, numbers, booleans.
  if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
    return actual === candidate;
  }

  // Operator object — exactly one of the supported keys.
  if ("anything-but" in candidate) {
    if (actual === undefined) return false; // see file-level note: anything-but requires presence
    const banned = candidate["anything-but"];
    if (Array.isArray(banned)) {
      return !banned.includes(actual as string | number | boolean);
    }
    return actual !== banned;
  }
  if ("prefix" in candidate) {
    return typeof actual === "string" && actual.startsWith(candidate.prefix);
  }
  if ("exists" in candidate) {
    return candidate.exists ? actual !== undefined : actual === undefined;
  }
  if ("equals-ignore-case" in candidate) {
    return (
      typeof actual === "string" &&
      actual.toLocaleLowerCase() === candidate["equals-ignore-case"].toLocaleLowerCase()
    );
  }

  // Unknown operator — fail closed. New operators must be explicitly
  // added here; silently accepting an unknown shape would mask config
  // typos.
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
