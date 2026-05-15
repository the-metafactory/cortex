/**
 * IAW D.4 — Storage interface + in-memory v1 implementation.
 *
 * V1 ships with an in-memory store so the endpoint surface, signing,
 * and tests are exercised end-to-end without provisioning D1. The
 * persistence wiring (D1 or KV) is a follow-up: see README §Roadmap
 * and the cortex#116 D.4 checklist. The store interface is the seam
 * — a D1Store implementation can drop in without touching routes.
 *
 * Concurrency model
 * ─────────────────
 * Cloudflare Workers run each request in an isolate. Module-scoped
 * Map state inside an isolate is per-instance; the InMemoryStore is
 * therefore NOT durable across deploys, restarts, or even across
 * isolates that the colo spins up under load. This is acceptable for
 * a dev/staging surface and for the test suite — production rollout
 * MUST swap in a durable backend. The store is constructed inside
 * the request handler (via `getStore(env)`) so dependency injection
 * is straightforward.
 */

import type {
  Capability,
  CapabilityHit,
  NetworkRoster,
  OperatorRecord,
  StackIdentity,
} from "./types";

// =============================================================================
// Store interface
// =============================================================================

export interface RegistryStore {
  /**
   * Upsert an operator record. Returns the post-write view. The
   * `validate` step at the route layer has already enforced grammar
   * + signature; the store only worries about persistence.
   */
  putOperator(
    operatorId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
  ): Promise<OperatorRecord>;

  getOperator(operatorId: string): Promise<OperatorRecord | undefined>;

  /**
   * List all operators (used by `/networks/{id}/roster` to compute
   * implicit membership and by `/capabilities` for search). Bounded
   * by federation size — hundreds, not millions — so an O(n) scan
   * is fine for v1. A D1 implementation would push the filter into
   * SQL.
   */
  listOperators(): Promise<OperatorRecord[]>;

  /** Test/admin helper. Not exposed via HTTP. */
  reset(): Promise<void>;
}

// =============================================================================
// Nonce cache (replay protection)
// =============================================================================

/**
 * Replay-protection cache. Operators include a `nonce` in every
 * signed registration; the registry refuses any nonce it has seen
 * inside the configured window.
 *
 * The nonce window (10 minutes) is wider than the route-layer skew
 * window (5 minutes) so that the nonce cache is the FIRST line of
 * defense against in-window replays and the skew check is the
 * fallback against delayed/captured-and-replayed claims.
 *
 * Caveat (Echo cortex#225 issue #2): storage is in-memory per isolate.
 * A captured-in-flight registration replayed within the 5-minute skew
 * window CAN succeed against a different isolate / colo whose nonce
 * map is empty for that key. Defense-in-depth only holds for delayed
 * replays here, not in-window ones. The fix is to pull nonce storage
 * into the same durable layer as operators when D1 lands — see the
 * README §Roadmap "Durable nonce cache" follow-up. v1 ships as-is
 * because (a) the operator's private key is still the gate and (b)
 * a successful in-window replay only re-applies the same claim, with
 * no privilege escalation versus the original.
 */
export interface NonceCache {
  /** Returns true if the nonce was fresh (and is now recorded). */
  recordIfFresh(nonce: string, now: number): Promise<boolean>;
  reset(): Promise<void>;
}

export const NONCE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

class InMemoryNonceCache implements NonceCache {
  private readonly seen = new Map<string, number>();

  /** Sweep threshold — only walk the map when it grows past this. */
  private static readonly SWEEP_THRESHOLD = 64;

  async recordIfFresh(nonce: string, now: number): Promise<boolean> {
    // Threshold-gated sweep (Echo cortex#225 issue #7). At federation
    // scale (hundreds of operators), the per-call O(n) sweep was fine,
    // but gating on size keeps the steady-state cost flat regardless
    // of bursty traffic. We sweep only when the map grows past the
    // threshold; the 10-minute eviction window is unchanged.
    if (this.seen.size > InMemoryNonceCache.SWEEP_THRESHOLD) {
      for (const [key, ts] of this.seen) {
        if (now - ts > NONCE_WINDOW_MS) this.seen.delete(key);
      }
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }

  async reset(): Promise<void> {
    this.seen.clear();
  }
}

// =============================================================================
// In-memory store (v1)
// =============================================================================

export class InMemoryRegistryStore implements RegistryStore {
  private readonly operators = new Map<string, OperatorRecord>();

  async putOperator(
    operatorId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
  ): Promise<OperatorRecord> {
    const record: OperatorRecord = {
      operator_id: operatorId,
      operator_pubkey: pubkey,
      stacks,
      capabilities,
      updated_at: new Date().toISOString(),
    };
    this.operators.set(operatorId, record);
    return record;
  }

  async getOperator(operatorId: string): Promise<OperatorRecord | undefined> {
    return this.operators.get(operatorId);
  }

  async listOperators(): Promise<OperatorRecord[]> {
    return [...this.operators.values()];
  }

  async reset(): Promise<void> {
    this.operators.clear();
  }
}

// =============================================================================
// Singleton accessors per isolate
// =============================================================================

/**
 * The Worker entry point doesn't see the test harness — it just sees
 * `env`. We attach the store to a module-scoped slot so request handlers
 * share state within an isolate. Tests reset between cases via
 * `getStore().reset()`.
 */
let storeSingleton: RegistryStore | undefined;
let nonceSingleton: NonceCache | undefined;

export function getStore(): RegistryStore {
  if (!storeSingleton) storeSingleton = new InMemoryRegistryStore();
  return storeSingleton;
}

export function getNonceCache(): NonceCache {
  if (!nonceSingleton) nonceSingleton = new InMemoryNonceCache();
  return nonceSingleton;
}

/** Test-only — swap stores between cases. Not exported via index.ts. */
export function _setStoreForTest(s: RegistryStore | undefined): void {
  storeSingleton = s;
}

export function _setNonceCacheForTest(c: NonceCache | undefined): void {
  nonceSingleton = c;
}

// =============================================================================
// Derived queries
// =============================================================================

/**
 * Compute a network's roster from the flat operator list. Membership
 * is implicit: an operator is "in" network X if any of their
 * capabilities lists X in `capability.networks[]`. We collapse the
 * matching capabilities back to the per-operator level for the
 * response shape.
 */
export function rosterFromOperators(
  operators: OperatorRecord[],
  networkId: string,
): NetworkRoster {
  const members: NetworkRoster["members"] = [];
  for (const op of operators) {
    const matched = op.capabilities
      .filter((c) => (c.networks ?? []).includes(networkId))
      .map((c) => c.id);
    if (matched.length > 0) {
      members.push({
        operator_id: op.operator_id,
        operator_pubkey: op.operator_pubkey,
        capabilities: matched,
      });
    }
  }
  return { network_id: networkId, members };
}

/**
 * Search capabilities across all operators. The query is a substring
 * match against `capability.id` (lowercase, dotted) and against
 * `description`. v1 returns all hits unsorted — pagination is a
 * follow-up when the registry has enough capabilities to need it.
 */
export function searchCapabilities(
  operators: OperatorRecord[],
  query: string,
): CapabilityHit[] {
  const q = query.toLowerCase();
  const hits: CapabilityHit[] = [];
  for (const op of operators) {
    for (const cap of op.capabilities) {
      const idMatch = cap.id.toLowerCase().includes(q);
      const descMatch = (cap.description ?? "").toLowerCase().includes(q);
      if (idMatch || descMatch) {
        hits.push({
          capability_id: cap.id,
          operator_id: op.operator_id,
          networks: cap.networks ?? [],
          description: cap.description,
        });
      }
    }
  }
  return hits;
}
