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
  PrincipalRecord,
  StackIdentity,
} from "./types";

// =============================================================================
// Store interface
// =============================================================================

export interface RegistryStore {
  /**
   * Upsert a principal record. Returns the post-write view. The
   * `validate` step at the route layer has already enforced grammar
   * + signature; the store only worries about persistence.
   */
  putPrincipal(
    principalId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
  ): Promise<PrincipalRecord>;

  getPrincipal(principalId: string): Promise<PrincipalRecord | undefined>;

  /**
   * List all principals (used by `/networks/{id}/roster` to compute
   * implicit membership and by `/capabilities` for search). Bounded
   * by federation size — hundreds, not millions — so an O(n) scan
   * is fine for v1. A D1 implementation would push the filter into
   * SQL.
   */
  listPrincipals(): Promise<PrincipalRecord[]>;

  /** Test/admin helper. Not exposed via HTTP. */
  reset(): Promise<void>;
}

// =============================================================================
// Nonce cache (replay protection)
// =============================================================================

/**
 * Replay-protection cache. Principals include a `nonce` in every
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
 * into the same durable layer as principals when D1 lands — see the
 * README §Roadmap "Durable nonce cache" follow-up. v1 ships as-is
 * because (a) the principal's private key is still the gate and (b)
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
    // scale (hundreds of principals), the per-call O(n) sweep was fine,
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
  private readonly principals = new Map<string, PrincipalRecord>();

  async putPrincipal(
    principalId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
  ): Promise<PrincipalRecord> {
    const record: PrincipalRecord = {
      principal_id: principalId,
      principal_pubkey: pubkey,
      stacks,
      capabilities,
      updated_at: new Date().toISOString(),
    };
    this.principals.set(principalId, record);
    return record;
  }

  async getPrincipal(principalId: string): Promise<PrincipalRecord | undefined> {
    return this.principals.get(principalId);
  }

  async listPrincipals(): Promise<PrincipalRecord[]> {
    return [...this.principals.values()];
  }

  async reset(): Promise<void> {
    this.principals.clear();
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
 * Compute a network's roster from the flat principal list. Membership
 * is implicit: a principal is "in" network X if any of their
 * capabilities lists X in `capability.networks[]`. We collapse the
 * matching capabilities back to the per-principal level for the
 * response shape.
 */
export function rosterFromPrincipals(
  principals: PrincipalRecord[],
  networkId: string,
): NetworkRoster {
  const members: NetworkRoster["members"] = [];
  for (const p of principals) {
    const matched = p.capabilities
      .filter((c) => (c.networks ?? []).includes(networkId))
      .map((c) => c.id);
    if (matched.length > 0) {
      members.push({
        principal_id: p.principal_id,
        principal_pubkey: p.principal_pubkey,
        capabilities: matched,
      });
    }
  }
  return { network_id: networkId, members };
}

/**
 * Search capabilities across all principals. The query is a substring
 * match against `capability.id` (lowercase, dotted) and against
 * `description`. v1 returns all hits unsorted — pagination is a
 * follow-up when the registry has enough capabilities to need it.
 */
export function searchCapabilities(
  principals: PrincipalRecord[],
  query: string,
): CapabilityHit[] {
  const q = query.toLowerCase();
  const hits: CapabilityHit[] = [];
  for (const p of principals) {
    for (const cap of p.capabilities) {
      const idMatch = cap.id.toLowerCase().includes(q);
      const descMatch = (cap.description ?? "").toLowerCase().includes(q);
      if (idMatch || descMatch) {
        hits.push({
          capability_id: cap.id,
          principal_id: p.principal_id,
          networks: cap.networks ?? [],
          description: cap.description,
        });
      }
    }
  }
  return hits;
}
