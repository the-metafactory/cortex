/**
 * IAW Phase C.3 (cortex#115) — DID parsing helpers.
 *
 * Single source of truth for stripping `did:mf:<name>` principals
 * into their bare agent-id segment. The bus-side verifier
 * (`src/bus/verify-signed-by-chain.ts`) re-exports `extractAgentIdFromDid`
 * from here; the dispatch-listener's policy gate calls it directly so
 * the two paths can never drift on what counts as a valid DID
 * (Echo cortex#220 round 2 S-1).
 *
 * `did:mf:` is myelin's convention (see `myelin/specs/`). Other DID
 * methods (`did:key:`, `did:web:`) are out of scope until Phase D
 * federation introduces hub-trust paths.
 */

/**
 * Parse a `did:mf:<name>` principal into its agent-id segment.
 * Returns `undefined` for any other DID method or malformed input —
 * the caller surfaces `undefined` as `unknown_principal` rather than
 * throwing, because the inbound-envelope path must never crash on a
 * malformed stamp (an attacker controls the bytes; a thrown
 * exception inside the subscription callback bubbles into nats.js's
 * reconnection logic).
 */
export function extractAgentIdFromDid(principal: string): string | undefined {
  const prefix = "did:mf:";
  if (!principal.startsWith(prefix)) return undefined;
  const tail = principal.slice(prefix.length);
  if (tail.length === 0) return undefined;
  // The myelin convention is `did:mf:<name>` with no further segments;
  // a colon in the tail signals an unsupported DID variant.
  if (tail.includes(":")) return undefined;
  return tail;
}
