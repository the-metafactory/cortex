/**
 * IAW D.4 — Storage interface + in-memory and D1-backed implementations.
 *
 * Two backends share the `RegistryStore` / `NonceCache` seams:
 *
 *   - In-memory (InMemoryRegistryStore / InMemoryNonceCache): used for
 *     `wrangler dev` and `bun test`, where no D1 binding is present.
 *   - D1 (D1RegistryStore / D1NonceCache, cortex#682): the durable
 *     backend wired when `env.DB` is present. Registrations AND the
 *     nonce-replay cache survive Worker-isolate recycling, closing the
 *     documented cross-isolate replay gap (see D1NonceCache below).
 *
 * `getStore(env)` / `getNonceCache(env)` pick the backend per request:
 * D1 when bound, in-memory otherwise. The selection is memoised at
 * module scope so handlers within an isolate share one instance.
 *
 * Concurrency model
 * ─────────────────
 * Cloudflare Workers run each request in an isolate. Module-scoped Map
 * state inside an isolate is per-instance; the in-memory backend is
 * therefore NOT durable across deploys, restarts, or across isolates a
 * colo spins up under load. That is why production binds D1: D1 is a
 * single logical database shared by every isolate/colo, so a principal
 * registered on one isolate is visible to the next, and a nonce seen on
 * one isolate is rejected on every other.
 */

import type {
  Capability,
  CapabilityHit,
  GrantLeafPackage,
  IssuanceRequest,
  IssuanceStatus,
  NetworkRecord,
  NetworkRoster,
  PrincipalRecord,
  StackIdentity,
} from "./types";

/**
 * Minimal binding surface this module reads. We DON'T import `Env` from
 * `./index` to avoid a store↔index import cycle; the only field the
 * storage layer cares about is the optional D1 binding `DB`.
 */
export interface StoreEnv {
  /**
   * D1 binding. Present in deployed environments (wired in wrangler.toml
   * as `[[env.<env>.d1_databases]]` with `binding = "DB"`). Absent under
   * `wrangler dev` / `bun test`, where the in-memory backends are used.
   */
  DB?: D1Like;
  /**
   * Deploy environment (`[env.<env>.vars] ENVIRONMENT`). When this is
   * `"production"`, durable storage is MANDATORY: a missing `DB` binding is
   * a misconfiguration that would silently run the in-memory, non-durable
   * backend in prod — losing registrations on isolate recycle AND dropping
   * cross-isolate replay protection. The store factories fail CLOSED on it.
   */
  ENVIRONMENT?: string;
}

/**
 * Minimal structural slice of Cloudflare's `D1Database` — just the
 * `prepare → bind → run/first/all` surface the registry uses.
 *
 * We deliberately do NOT depend on the `D1Database` global from
 * `@cloudflare/workers-types` here. This module is reachable both from
 * the registry's own tsconfig (which loads workers-types) AND, via
 * cross-service integration tests, from the repo-root tsconfig (which
 * does not). A self-contained structural type type-checks identically
 * under both, and the real D1 binding is structurally assignable to it.
 */
export interface D1Like {
  prepare(query: string): D1PreparedLike;
}

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

// =============================================================================
// Store interface
// =============================================================================

/**
 * Optimistic-concurrency conflict (#825). Thrown by `putPrincipal` when the
 * caller passed `expectedUpdatedAt` and the stored row's `updated_at` no longer
 * matches — i.e. another writer (a second host doing a concurrent register/join)
 * mutated the record between this caller's verified read-merge and its write.
 * The route maps it to `409 stale_record`; the client re-reads, re-merges, retries.
 */
export class StaleRecordError extends Error {
  constructor(public readonly current: PrincipalRecord | undefined) {
    super("stale_record: principal record changed since the expected version");
    this.name = "StaleRecordError";
  }
}

export interface RegistryStore {
  /**
   * Upsert a principal record. Returns the post-write view. The
   * `validate` step at the route layer has already enforced grammar
   * + signature; the store only worries about persistence.
   *
   * `expectedUpdatedAt` (#825 — optimistic concurrency): when provided, the
   * write is a compare-and-set — it succeeds only if the stored row's
   * `updated_at` equals this value (or no row exists yet). On mismatch it
   * throws `StaleRecordError`. Omit it for the first register / non-merging
   * writes (unconditional upsert — backward-compatible).
   */
  putPrincipal(
    principalId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
    expectedUpdatedAt?: string,
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

  /**
   * S2.5 (#745) — upsert a network's topology record (`hub_url` /
   * `leaf_port`). Seeded by an admin at the store level (deploy-time seed
   * script / direct D1 write), NOT via a public HTTP route — an unauthenticated
   * write the registry then signs would defeat DD-9 (descriptor poisoning).
   * Returns the post-write view. Callers are responsible for validating
   * `hubUrl` / `leafPort`; the store only persists.
   */
  putNetwork(
    networkId: string,
    hubUrl: string,
    leafPort: number,
  ): Promise<NetworkRecord>;

  /**
   * S2.5 (#745) — fetch a network's topology record, or `undefined` if the
   * network has never been seeded. Backs the 404 on `GET /networks/{id}`.
   */
  getNetwork(networkId: string): Promise<NetworkRecord | undefined>;

  /** Test/admin helper. Not exposed via HTTP. */
  reset(): Promise<void>;
}

// =============================================================================
// O-4a.1 — Issuance-request store
// =============================================================================

/**
 * Thrown by `transitionIssuanceRequest` when the request has already been
 * decided (GRANTED or REJECTED). The route maps this to 409 already_decided.
 */
export class AlreadyDecidedError extends Error {
  constructor(public readonly request: IssuanceRequest) {
    super(`issuance request ${request.request_id} is already ${request.status}`);
    this.name = "AlreadyDecidedError";
  }
}

export interface IssuanceRequestStore {
  /**
   * Upsert a PENDING issuance request for (principal_id, peer_pubkey).
   *
   * Idempotency rule: if a row already exists for this (principal_id, peer_pubkey)
   * pair — regardless of its current status — return that existing row without
   * inserting a new one. Re-registration of the same peer pubkey never creates a
   * duplicate; it returns the existing row (PENDING, GRANTED, or REJECTED).
   *
   * This is the side-effect of `POST /principals/:id/register` AFTER PoP
   * verification succeeds.
   */
  upsertPending(
    principalId: string,
    peerPubkey: string,
    requestedScope: string,
  ): Promise<IssuanceRequest>;

  /** Retrieve a single issuance request by its request_id. */
  getIssuanceRequest(requestId: string): Promise<IssuanceRequest | undefined>;

  /**
   * List issuance requests filtered by status.
   * Returns all rows matching the given status, ordered by created_at ascending.
   */
  listIssuanceRequests(status: IssuanceStatus): Promise<IssuanceRequest[]>;

  /**
   * Transition a PENDING request to GRANTED or REJECTED.
   *
   * The transition is gated on `status = 'PENDING'` (CAS-ish guard): if the
   * row is already decided, throws `AlreadyDecidedError`.
   * If the request_id doesn't exist, returns `undefined`.
   *
   * Sets `granted_by` to `adminPubkey` and `updated_at` to now.
   * O-4a.2: when `newStatus === "GRANTED"` and `leafPackage` is provided,
   * stores it in the `leaf_package` column atomically. On REJECTED the
   * `leafPackage` argument is ignored (package only flows with grants).
   */
  transitionIssuanceRequest(
    requestId: string,
    newStatus: "GRANTED" | "REJECTED",
    adminPubkey: string,
    leafPackage?: GrantLeafPackage,
  ): Promise<IssuanceRequest | undefined>;
}

// =============================================================================
// In-memory IssuanceRequestStore
// =============================================================================

/** Hex UUID generator — URL-safe, collision-resistant for test-scale traffic. */
function generateRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class InMemoryIssuanceRequestStore implements IssuanceRequestStore {
  private readonly requests = new Map<string, IssuanceRequest>();
  /** (principal_id + "\x00" + peer_pubkey) → request_id */
  private readonly byPeer = new Map<string, string>();

  async upsertPending(
    principalId: string,
    peerPubkey: string,
    requestedScope: string,
  ): Promise<IssuanceRequest> {
    const peerKey = `${principalId}\x00${peerPubkey}`;
    const existingId = this.byPeer.get(peerKey);
    if (existingId !== undefined) {
      // Idempotent: return the existing row.
      return this.requests.get(existingId)!;
    }
    const now = new Date().toISOString();
    const request: IssuanceRequest = {
      request_id: generateRequestId(),
      principal_id: principalId,
      peer_pubkey: peerPubkey,
      requested_scope: requestedScope,
      status: "PENDING",
      created_at: now,
      updated_at: now,
      granted_by: null,
      leaf_package: null,
    };
    this.requests.set(request.request_id, request);
    this.byPeer.set(peerKey, request.request_id);
    return request;
  }

  async getIssuanceRequest(requestId: string): Promise<IssuanceRequest | undefined> {
    return this.requests.get(requestId);
  }

  async listIssuanceRequests(status: IssuanceStatus): Promise<IssuanceRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async transitionIssuanceRequest(
    requestId: string,
    newStatus: "GRANTED" | "REJECTED",
    adminPubkey: string,
    leafPackage?: GrantLeafPackage,
  ): Promise<IssuanceRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status !== "PENDING") {
      throw new AlreadyDecidedError(existing);
    }
    const updated: IssuanceRequest = {
      ...existing,
      status: newStatus,
      granted_by: adminPubkey,
      updated_at: new Date().toISOString(),
      // O-4a.2: store the package only when granting and a package was supplied.
      leaf_package:
        newStatus === "GRANTED" && leafPackage !== undefined
          ? JSON.stringify(leafPackage)
          : null,
    };
    this.requests.set(requestId, updated);
    return updated;
  }
}

// =============================================================================
// D1-backed IssuanceRequestStore
// =============================================================================

export class D1IssuanceRequestStore implements IssuanceRequestStore {
  constructor(private readonly db: D1Like) {}

  async upsertPending(
    principalId: string,
    peerPubkey: string,
    requestedScope: string,
  ): Promise<IssuanceRequest> {
    // M3 — atomic upsert: INSERT ... ON CONFLICT(principal_id, peer_pubkey) DO NOTHING.
    // Mirrors the D1NonceCache atomic insert pattern (~line 536): the database
    // decides atomically whether the row exists; no SELECT-then-INSERT race window
    // exists where two concurrent registrations could both see "no row" and
    // attempt a double-insert. After the insert-or-ignore, we unconditionally
    // SELECT the row (either the one we just inserted or the pre-existing one)
    // and return it.  Contract: always returns the PENDING (or already-decided)
    // row for this (principal_id, peer_pubkey) pair; never throws on a concurrent
    // insert; never creates a duplicate.
    const now = new Date().toISOString();
    const requestId = generateRequestId();
    await this.db
      .prepare(
        `INSERT INTO issuance_requests
           (request_id, principal_id, peer_pubkey, requested_scope, status, created_at, updated_at, granted_by, leaf_package)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, NULL, NULL)
         ON CONFLICT(principal_id, peer_pubkey) DO NOTHING`,
      )
      .bind(requestId, principalId, peerPubkey, requestedScope, now, now)
      .run();

    // Unconditional SELECT — retrieves the winner (our insert or the existing row).
    const row = await this.db
      .prepare(
        "SELECT * FROM issuance_requests WHERE principal_id = ? AND peer_pubkey = ?",
      )
      .bind(principalId, peerPubkey)
      .first<IssuanceRequestRow>();

    // The row MUST exist at this point: either we inserted it or it pre-existed.
    // A missing row here would indicate a D1 write anomaly outside normal operation.
    if (!row) {
      throw new Error(
        `network-registry: upsertPending invariant violated — no row found for (${principalId}, ${peerPubkey}) after atomic insert`,
      );
    }
    return rowToIssuanceRequest(row);
  }

  async getIssuanceRequest(requestId: string): Promise<IssuanceRequest | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM issuance_requests WHERE request_id = ?")
      .bind(requestId)
      .first<IssuanceRequestRow>();
    return row ? rowToIssuanceRequest(row) : undefined;
  }

  async listIssuanceRequests(status: IssuanceStatus): Promise<IssuanceRequest[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM issuance_requests WHERE status = ? ORDER BY created_at ASC",
      )
      .bind(status)
      .all<IssuanceRequestRow>();
    return (res.results ?? []).map(rowToIssuanceRequest);
  }

  async transitionIssuanceRequest(
    requestId: string,
    newStatus: "GRANTED" | "REJECTED",
    adminPubkey: string,
    leafPackage?: GrantLeafPackage,
  ): Promise<IssuanceRequest | undefined> {
    // Re-read current state before mutating — needed for AlreadyDecidedError.
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status !== "PENDING") {
      throw new AlreadyDecidedError(existing);
    }

    const now = new Date().toISOString();
    // O-4a.2: include leaf_package in the SET clause when granting with a package.
    const leafPackageJson =
      newStatus === "GRANTED" && leafPackage !== undefined
        ? JSON.stringify(leafPackage)
        : null;

    // CAS-ish: UPDATE only touches the row when status is still PENDING.
    // If a concurrent grant/reject raced us here, the WHERE status='PENDING'
    // is false, changes === 0, and we read back the decided row to throw.
    const res = await this.db
      .prepare(
        `UPDATE issuance_requests
         SET status = ?, granted_by = ?, updated_at = ?, leaf_package = ?
         WHERE request_id = ? AND status = 'PENDING'`,
      )
      .bind(newStatus, adminPubkey, now, leafPackageJson, requestId)
      .run();

    if ((res.meta?.changes ?? 0) === 0) {
      // N2 — the pre-UPDATE `existing` row is already in scope and was confirmed
      // PENDING before the UPDATE ran. `changes === 0` means the
      // `WHERE status = 'PENDING'` guard flipped false after our read — a
      // concurrent grant/reject landed between our SELECT and UPDATE. Throw
      // directly with the row we already have rather than issuing a second
      // SELECT (which could 404 under a transient D1 error even though the row
      // exists, causing a spurious 404 vs the correct 409).
      throw new AlreadyDecidedError(existing);
    }

    return {
      ...existing,
      status: newStatus,
      granted_by: adminPubkey,
      updated_at: now,
      leaf_package: leafPackageJson,
    };
  }
}

/** Raw column shape for an issuance_requests row. */
interface IssuanceRequestRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  requested_scope: string;
  status: string;
  created_at: string;
  updated_at: string;
  granted_by: string | null;
  leaf_package: string | null;
}

function rowToIssuanceRequest(row: IssuanceRequestRow): IssuanceRequest {
  return {
    request_id: row.request_id,
    principal_id: row.principal_id,
    peer_pubkey: row.peer_pubkey,
    requested_scope: row.requested_scope,
    status: row.status as IssuanceStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    granted_by: row.granted_by,
    leaf_package: row.leaf_package,
  };
}

// =============================================================================
// Singleton accessor
// =============================================================================

let issuanceStoreSingleton: IssuanceRequestStore | undefined;

export function getIssuanceStore(env: StoreEnv): IssuanceRequestStore {
  if (!issuanceStoreSingleton) {
    assertDurableBackendInProd(env);
    issuanceStoreSingleton = env.DB
      ? new D1IssuanceRequestStore(env.DB)
      : new InMemoryIssuanceRequestStore();
  }
  return issuanceStoreSingleton;
}

/** Test-only — swap issuance store between cases. */
export function _setIssuanceStoreForTest(s: IssuanceRequestStore | undefined): void {
  issuanceStoreSingleton = s;
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

export class InMemoryNonceCache implements NonceCache {
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

/**
 * Durable nonce cache backed by D1 (cortex#682). This closes the
 * cross-isolate replay gap the in-memory cache documents: because D1 is
 * a single logical database shared by every isolate/colo, a nonce
 * recorded by one request is visible to every other.
 *
 * Freshness is decided ATOMICALLY by the database, not by a read-then-
 * write in the Worker. `recordIfFresh` issues a single
 * `INSERT ... ON CONFLICT(nonce) DO NOTHING`; D1 reports `meta.changes`,
 * the number of rows the statement created. A fresh nonce inserts one
 * row (`changes === 1`); a replay conflicts on the PRIMARY KEY and
 * inserts nothing (`changes === 0`). No window exists between a SELECT
 * and an INSERT in which two concurrent replays could both see "fresh",
 * so the check is replay-safe even under concurrent posts of the same
 * nonce.
 */
export class D1NonceCache implements NonceCache {
  constructor(private readonly db: D1Like) {}

  async recordIfFresh(nonce: string, now: number): Promise<boolean> {
    // Opportunistic prune of expired entries. Bounded by the seen_at
    // index; runs before the insert so the table stays near the
    // NONCE_WINDOW_MS horizon. Parameterised — no string interpolation.
    await this.db
      .prepare("DELETE FROM nonces WHERE seen_at < ?")
      .bind(now - NONCE_WINDOW_MS)
      .run();

    // Atomic insert-or-ignore. Fresh iff THIS statement created the row.
    const res = await this.db
      .prepare("INSERT INTO nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING")
      .bind(nonce, now)
      .run();

    // `meta.changes` is the row count the write affected. 1 → we won the
    // insert (fresh); 0 → the PK already existed (replay).
    return (res.meta?.changes ?? 0) > 0;
  }

  async reset(): Promise<void> {
    await this.db.prepare("DELETE FROM nonces").run();
  }
}

// =============================================================================
// In-memory store (v1)
// =============================================================================

export class InMemoryRegistryStore implements RegistryStore {
  private readonly principals = new Map<string, PrincipalRecord>();
  private readonly networks = new Map<string, NetworkRecord>();

  async putNetwork(
    networkId: string,
    hubUrl: string,
    leafPort: number,
  ): Promise<NetworkRecord> {
    const record: NetworkRecord = {
      network_id: networkId,
      hub_url: hubUrl,
      leaf_port: leafPort,
      updated_at: new Date().toISOString(),
    };
    this.networks.set(networkId, record);
    return record;
  }

  async getNetwork(networkId: string): Promise<NetworkRecord | undefined> {
    return this.networks.get(networkId);
  }

  async putPrincipal(
    principalId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
    expectedUpdatedAt?: string,
  ): Promise<PrincipalRecord> {
    if (expectedUpdatedAt !== undefined) {
      const current = this.principals.get(principalId);
      // CAS: only enforce against an existing row. If the record is gone, the
      // merge had nothing to preserve, so a fresh write loses nothing.
      if (current && current.updated_at !== expectedUpdatedAt) {
        throw new StaleRecordError(current);
      }
    }
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
    this.networks.clear();
  }
}

// =============================================================================
// D1-backed store (cortex#682)
// =============================================================================

/**
 * Durable principal directory backed by D1. The variable-length `stacks`
 * and `capabilities` lists are stored as JSON text columns (see
 * migrations/0001_init.sql for why): the registry only ever reads/writes
 * a principal as a whole record, so `putPrincipal` is a single atomic
 * UPSERT.
 *
 * SQLi-safety: EVERY query uses `.bind(...)` parameter placeholders — no
 * value (principal_id, pubkey, JSON blob) is ever string-interpolated
 * into SQL. A principal_id containing quotes or SQL metacharacters is
 * passed as an opaque bound parameter and cannot alter the query. (The
 * route layer also constrains principal_id grammar via isValidPrincipalId,
 * but the store does not rely on that for injection safety — defence in
 * depth.)
 */
export class D1RegistryStore implements RegistryStore {
  constructor(private readonly db: D1Like) {}

  async putPrincipal(
    principalId: string,
    pubkey: string,
    stacks: StackIdentity[],
    capabilities: Capability[],
    expectedUpdatedAt?: string,
  ): Promise<PrincipalRecord> {
    const record: PrincipalRecord = {
      principal_id: principalId,
      principal_pubkey: pubkey,
      stacks,
      capabilities,
      updated_at: new Date().toISOString(),
    };

    // UPSERT. Without `expectedUpdatedAt` it is an unconditional overwrite (the
    // new stacks/capabilities fully replace the old — matches InMemory; this is
    // the first-register / non-merging path). WITH it (#825), the conflict-update
    // carries an upsert `WHERE updated_at = ?` guard: a concurrent host that
    // mutated the row since this caller's verified read leaves `updated_at`
    // mismatched, the WHERE is false, the UPDATE is a no-op (changes === 0), and
    // we raise StaleRecordError so the loser re-reads + re-merges instead of
    // silently clobbering the winner. No false-conflict risk: SQLite counts the
    // conflict-target match, not a value delta, so a matched CAS reports
    // changes === 1 even for a byte-identical update (verified vs sqlite3 3.41).
    const sql = expectedUpdatedAt === undefined
      ? `INSERT INTO principals (principal_id, principal_pubkey, stacks, capabilities, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET
           principal_pubkey = excluded.principal_pubkey,
           stacks           = excluded.stacks,
           capabilities     = excluded.capabilities,
           updated_at       = excluded.updated_at`
      : `INSERT INTO principals (principal_id, principal_pubkey, stacks, capabilities, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET
           principal_pubkey = excluded.principal_pubkey,
           stacks           = excluded.stacks,
           capabilities     = excluded.capabilities,
           updated_at       = excluded.updated_at
         WHERE principals.updated_at = ?`;

    const binds = expectedUpdatedAt === undefined
      ? [principalId, pubkey, JSON.stringify(stacks), JSON.stringify(capabilities), record.updated_at]
      : [principalId, pubkey, JSON.stringify(stacks), JSON.stringify(capabilities), record.updated_at, expectedUpdatedAt];

    const res = await this.db.prepare(sql).bind(...binds).run();

    if (expectedUpdatedAt !== undefined && (res.meta?.changes ?? 0) === 0) {
      // CAS failed: a row existed whose updated_at != expected (a fresh INSERT
      // would have reported changes === 1). Re-read the current row for the 409
      // body — best-effort + non-atomic (a third writer could change it again),
      // so `current_updated_at` is advisory, not an authoritative retry token.
      const current = await this.getPrincipal(principalId);
      throw new StaleRecordError(current);
    }
    return record;
  }

  async getPrincipal(principalId: string): Promise<PrincipalRecord | undefined> {
    const row = await this.db
      .prepare(
        "SELECT principal_id, principal_pubkey, stacks, capabilities, updated_at FROM principals WHERE principal_id = ?",
      )
      .bind(principalId)
      .first<PrincipalRow>();
    return row ? rowToRecord(row) : undefined;
  }

  async putNetwork(
    networkId: string,
    hubUrl: string,
    leafPort: number,
  ): Promise<NetworkRecord> {
    const record: NetworkRecord = {
      network_id: networkId,
      hub_url: hubUrl,
      leaf_port: leafPort,
      updated_at: new Date().toISOString(),
    };
    // UPSERT: re-seeding a network replaces the topology row in place.
    // Parameterised — no value is string-interpolated into SQL.
    await this.db
      .prepare(
        `INSERT INTO networks (network_id, hub_url, leaf_port, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(network_id) DO UPDATE SET
           hub_url    = excluded.hub_url,
           leaf_port  = excluded.leaf_port,
           updated_at = excluded.updated_at`,
      )
      .bind(networkId, hubUrl, leafPort, record.updated_at)
      .run();
    return record;
  }

  async getNetwork(networkId: string): Promise<NetworkRecord | undefined> {
    const row = await this.db
      .prepare(
        "SELECT network_id, hub_url, leaf_port, updated_at FROM networks WHERE network_id = ?",
      )
      .bind(networkId)
      .first<NetworkRow>();
    return row ? rowToNetworkRecord(row) : undefined;
  }

  async listPrincipals(): Promise<PrincipalRecord[]> {
    const res = await this.db
      .prepare(
        "SELECT principal_id, principal_pubkey, stacks, capabilities, updated_at FROM principals",
      )
      .all<PrincipalRow>();
    return (res.results ?? []).map(rowToRecord);
  }

  async reset(): Promise<void> {
    await this.db.prepare("DELETE FROM principals").run();
    await this.db.prepare("DELETE FROM networks").run();
  }
}

/** Raw column shape for a `principals` row. JSON columns are TEXT. */
interface PrincipalRow {
  principal_id: string;
  principal_pubkey: string;
  stacks: string;
  capabilities: string;
  updated_at: string;
}

/** Raw column shape for a `networks` row. */
interface NetworkRow {
  network_id: string;
  hub_url: string;
  /** SQLite stores the INTEGER column; D1 returns it as a JS number. */
  leaf_port: number;
  updated_at: string;
}

function rowToNetworkRecord(row: NetworkRow): NetworkRecord {
  return {
    network_id: row.network_id,
    hub_url: row.hub_url,
    leaf_port: row.leaf_port,
    updated_at: row.updated_at,
  };
}

/**
 * Decode a D1 row into a PrincipalRecord, parsing the JSON list columns.
 * A malformed JSON column (should never happen — only this store writes
 * them) degrades to an empty list rather than throwing, so one bad row
 * can't take down a roster/capability scan over the whole table.
 */
function rowToRecord(row: PrincipalRow): PrincipalRecord {
  return {
    principal_id: row.principal_id,
    principal_pubkey: row.principal_pubkey,
    stacks: parseJsonArray<StackIdentity>(row.stacks),
    capabilities: parseJsonArray<Capability>(row.capabilities),
    updated_at: row.updated_at,
  };
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (_err) {
    // Defensive: a non-JSON value in a column this store solely owns is a
    // data-integrity bug, not a request error. Return empty so the scan
    // continues; the row is still listed with its other fields intact.
    return [];
  }
}

// =============================================================================
// Singleton accessors per isolate
// =============================================================================

/**
 * The Worker entry point doesn't see the test harness — it just sees
 * `env`. We memoise the chosen backend in a module-scoped slot so request
 * handlers share one instance within an isolate. Tests reset between
 * cases via `_setStoreForTest(undefined)` (and the per-test `env` lacks a
 * `DB` binding, so they get the in-memory backend).
 *
 * Backend selection (cortex#682): when `env.DB` is bound (deployed envs
 * via wrangler.toml) we use the D1-backed durable implementations; with
 * no binding (`wrangler dev` / `bun test`) we fall back to the in-memory
 * implementations. The D1 instances are stateless wrappers over the
 * shared database, so memoising one per isolate is safe — all isolates
 * read/write the same underlying D1.
 */
let storeSingleton: RegistryStore | undefined;
let nonceSingleton: NonceCache | undefined;

/**
 * Fail CLOSED if durable storage is required but absent. In `production`
 * (per `env.ENVIRONMENT`) a missing `DB` binding must NOT silently fall back
 * to the in-memory backend — that would run the trust directory non-durable
 * and without cross-isolate replay protection. Throwing here surfaces the
 * misconfiguration loudly at first use rather than degrading in silence.
 */
function assertDurableBackendInProd(env: StoreEnv): void {
  if (!env.DB && env.ENVIRONMENT === "production") {
    throw new Error(
      "network-registry: ENVIRONMENT=production but no D1 `DB` binding is " +
        "configured — refusing to fall back to the in-memory (non-durable, " +
        "no cross-isolate replay protection) backend in production. Wire " +
        "`[[env.production.d1_databases]]` (binding = \"DB\") in wrangler.toml.",
    );
  }
}

export function getStore(env: StoreEnv): RegistryStore {
  if (!storeSingleton) {
    assertDurableBackendInProd(env);
    storeSingleton = env.DB
      ? new D1RegistryStore(env.DB)
      : new InMemoryRegistryStore();
  }
  return storeSingleton;
}

export function getNonceCache(env: StoreEnv): NonceCache {
  if (!nonceSingleton) {
    assertDurableBackendInProd(env);
    nonceSingleton = env.DB ? new D1NonceCache(env.DB) : new InMemoryNonceCache();
  }
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
 * S2.5 (#745) — derive a network's lightweight membership list (principal ids)
 * for the descriptor. Reuses the SAME implicit-membership rule as
 * {@link rosterFromPrincipals} (a principal is "in" network X if any announced
 * capability lists X) so the descriptor's `members[]` can never disagree with
 * `/roster`. The roster already yields at most one entry per principal, so the
 * ids are inherently unique; we sort them for a stable, canonical-friendly
 * response.
 */
export function membersFromPrincipals(
  principals: PrincipalRecord[],
  networkId: string,
): string[] {
  return rosterFromPrincipals(principals, networkId)
    .members.map((m) => m.principal_id)
    .sort();
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
