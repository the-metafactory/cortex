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
  AdmissionRequest,
  AdmissionStatus,
  Capability,
  CapabilityHit,
  NetworkRecord,
  NetworkRoster,
  PrincipalRecord,
  StackIdentity,
} from "./types";

// Back-compat aliases used in a few existing tests that import by the old names.
/** @deprecated Use AdmissionRequest */
export type IssuanceRequest = AdmissionRequest;
/** @deprecated Use AdmissionStatus */
export type IssuanceStatus = AdmissionStatus;

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
    /** #1321 — per-network admin allowlist (comma-separated base64). Omit to leave unset. */
    adminPubkeys?: string,
    /** #1598 — hub-mode / resolver-mode attestation. Omit to leave unset. */
    attestation?: {
      hubMode?: "operator" | "simple";
      resolverMode?: "nats" | "memory";
    },
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
// ADR-0015 — Network-admission store
// =============================================================================

/**
 * Thrown by `transitionAdmissionRequest` when the request has already been
 * decided (ADMITTED or REJECTED). The route maps this to 409 already_decided.
 */
export class AlreadyDecidedError extends Error {
  constructor(public readonly request: AdmissionRequest) {
    super(`admission request ${request.request_id} is already ${request.status}`);
    this.name = "AlreadyDecidedError";
  }
}

export interface IssuanceRequestStore {
  /**
   * Upsert a PENDING admission request for (principal_id, peer_pubkey).
   *
   * Idempotency rule: if a row already exists for this (principal_id, peer_pubkey)
   * pair — regardless of its current status — return that existing row without
   * inserting a new one. Re-registration of the same peer pubkey never creates a
   * duplicate; it returns the existing row (PENDING, ADMITTED, or REJECTED).
   *
   * This is the side-effect of `POST /principals/:id/register` AFTER PoP
   * verification succeeds.
   */
  upsertPending(
    principalId: string,
    peerPubkey: string,
    requestedScope: string,
    networkId?: string,
  ): Promise<AdmissionRequest>;

  /** Retrieve a single admission request by its request_id. */
  getIssuanceRequest(requestId: string): Promise<AdmissionRequest | undefined>;

  /**
   * List admission requests filtered by status.
   * Returns all rows matching the given status, ordered by created_at ascending.
   */
  listIssuanceRequests(status: AdmissionStatus): Promise<AdmissionRequest[]>;

  /**
   * ADR-0018 Q4 (Gap-C) — list the admission requests belonging to a single
   * member's registered pubkey, across all networks, ordered by created_at
   * ascending. Backs the member PoP-read endpoint: the caller proves possession
   * of `peerPubkey` (the signature IS the authorization) and receives ONLY the
   * rows for that key — never another member's queue.
   */
  listIssuanceRequestsByPeer(peerPubkey: string): Promise<AdmissionRequest[]>;

  /**
   * Transition a PENDING request to ADMITTED or REJECTED.
   *
   * The transition is gated on `status = 'PENDING'` (CAS-ish guard): if the
   * row is already decided, throws `AlreadyDecidedError`.
   * If the request_id doesn't exist, returns `undefined`.
   *
   * Sets `granted_by` to `adminPubkey` and `updated_at` to now.
   * The gate controls roster membership — no credentials are minted.
   */
  transitionIssuanceRequest(
    requestId: string,
    newStatus: "ADMITTED" | "REJECTED",
    adminPubkey: string,
  ): Promise<AdmissionRequest | undefined>;

  /**
   * ADR-0018 Q1 (b′) / PR5b — persist the OPAQUE sealed ciphertext onto an
   * ADMITTED admission row (the hub-admin `add-member` / `rotate` delivery).
   * The store only writes the blob it is handed; it never reads or interprets
   * it. Guarded on `status = 'ADMITTED'`: a not-yet-admitted (or revoked) row
   * cannot carry a sealed secret, so a write against a non-ADMITTED row is a
   * no-op and returns `undefined` (the route maps that to 409). Returns the
   * updated row on success, `undefined` when the row is missing or not ADMITTED.
   * `rotate` calls this again to REPLACE the blob in place (old copy inert).
   */
  setSealedSecret(
    requestId: string,
    sealedSecret: string,
  ): Promise<AdmissionRequest | undefined>;

  /**
   * cortex#1498 (epic #1479 follow-up) — persist the hub-owner's authorization
   * stamp onto an ADMITTED admission row (the `cortex network authorize`
   * write). Mirrors {@link setSealedSecret}'s CAS shape exactly: guarded on
   * `status = 'ADMITTED'` — a not-yet-admitted (or revoked/departed) row cannot
   * carry a hub-authorize stamp, so a write against a non-ADMITTED row is a
   * no-op and returns `undefined` (the route maps that to 409). Returns the
   * updated row on success, `undefined` when the row is missing or not
   * ADMITTED. `timestampIso` is the value to persist (the hub-admin's signed
   * claim `issued_at` — the moment THEY authorized, not the registry's receipt
   * time); `updated_at` is independently stamped `now` by the store, same as
   * every other transition.
   */
  markHubAuthorized(
    requestId: string,
    timestampIso: string,
  ): Promise<AdmissionRequest | undefined>;

  /**
   * ADR-0018 Q6 / PR5b — transition an ADMITTED row to REVOKED and CLEAR its
   * sealed blob (the bearer copy is dead once the hub `authorization` user is
   * dropped) AND its hub-authorize stamp (cortex#1498 — a revoked member is no
   * longer authorized). Guarded on `status = 'ADMITTED'`. Returns the updated
   * row; `undefined` when the row is missing. Already-REVOKED is idempotent
   * (returns the REVOKED row); a PENDING/REJECTED row throws
   * {@link AlreadyDecidedError} (you cannot revoke a member that was never
   * admitted).
   */
  revokeAdmission(requestId: string): Promise<AdmissionRequest | undefined>;

  /**
   * C-1350 Slice 1 (#1350) — transition an ADMITTED row to DEPARTED (the member
   * left voluntarily) and CLEAR its sealed blob (a departed member must not
   * retain a fetchable copy — same hygiene as revoke) AND its hub-authorize
   * stamp (cortex#1498 — a departed member is no longer authorized). Guarded on
   * `status = 'ADMITTED'`. Returns the updated row; `undefined` when the row is
   * missing. Already-DEPARTED is idempotent (returns the DEPARTED row); a
   * PENDING/REJECTED/REVOKED row throws {@link AlreadyDecidedError} (you cannot
   * depart a row that is not an active admission). Distinct from
   * {@link revokeAdmission} only in the target status: DEPARTED (voluntary) vs
   * REVOKED (admin-kicked). Roster needs NO change — `rosterFromAdmissions()`
   * filters `status='ADMITTED'`, so DEPARTED auto-drops from `members[]`.
   */
  departAdmission(requestId: string): Promise<AdmissionRequest | undefined>;
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

/**
 * ADR-0018 Gap-A — the idempotency key for an admission request. Includes the
 * target `network_id` so a stack can request admission to TWO networks without
 * the second register colliding with the first. A network-less register (no
 * `network_id`) normalises to the empty string, preserving the pre-ADR-0018
 * `(principal_id, peer_pubkey)` idempotency for that path (mirrors the D1
 * `COALESCE(network_id, '')` unique-index expression).
 */
function admissionPeerKey(principalId: string, peerPubkey: string, networkId?: string): string {
  return `${principalId}\x00${peerPubkey}\x00${networkId ?? ""}`;
}

export class InMemoryIssuanceRequestStore implements IssuanceRequestStore {
  private readonly requests = new Map<string, AdmissionRequest>();
  /** (principal_id + "\x00" + peer_pubkey + "\x00" + network_id) → request_id */
  private readonly byPeer = new Map<string, string>();

  async upsertPending(
    principalId: string,
    peerPubkey: string,
    requestedScope: string,
    networkId?: string,
  ): Promise<AdmissionRequest> {
    const peerKey = admissionPeerKey(principalId, peerPubkey, networkId);
    const existingId = this.byPeer.get(peerKey);
    if (existingId !== undefined) {
      // Idempotent: return the existing row.
      return this.requests.get(existingId)!;
    }
    const now = new Date().toISOString();
    const request: AdmissionRequest = {
      request_id: generateRequestId(),
      principal_id: principalId,
      peer_pubkey: peerPubkey,
      requested_scope: requestedScope,
      network_id: networkId ?? null,
      status: "PENDING",
      created_at: now,
      updated_at: now,
      granted_by: null,
      sealed_secret: null,
      hub_authorized_at: null,
    };
    this.requests.set(request.request_id, request);
    this.byPeer.set(peerKey, request.request_id);
    return request;
  }

  async getIssuanceRequest(requestId: string): Promise<AdmissionRequest | undefined> {
    return this.requests.get(requestId);
  }

  async listIssuanceRequests(status: AdmissionStatus): Promise<AdmissionRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listIssuanceRequestsByPeer(peerPubkey: string): Promise<AdmissionRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.peer_pubkey === peerPubkey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async transitionIssuanceRequest(
    requestId: string,
    newStatus: "ADMITTED" | "REJECTED",
    adminPubkey: string,
  ): Promise<AdmissionRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status !== "PENDING") {
      throw new AlreadyDecidedError(existing);
    }
    const updated: AdmissionRequest = {
      ...existing,
      status: newStatus,
      granted_by: adminPubkey,
      updated_at: new Date().toISOString(),
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  async setSealedSecret(
    requestId: string,
    sealedSecret: string,
  ): Promise<AdmissionRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status !== "ADMITTED") return undefined; // route → 409 not_admitted
    const updated: AdmissionRequest = {
      ...existing,
      sealed_secret: sealedSecret,
      updated_at: new Date().toISOString(),
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  async markHubAuthorized(
    requestId: string,
    timestampIso: string,
  ): Promise<AdmissionRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status !== "ADMITTED") return undefined; // route → 409 not_admitted
    const updated: AdmissionRequest = {
      ...existing,
      hub_authorized_at: timestampIso,
      updated_at: new Date().toISOString(),
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  async revokeAdmission(requestId: string): Promise<AdmissionRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status === "REVOKED") return existing; // idempotent
    if (existing.status !== "ADMITTED") {
      throw new AlreadyDecidedError(existing);
    }
    const updated: AdmissionRequest = {
      ...existing,
      status: "REVOKED",
      sealed_secret: null,
      hub_authorized_at: null,
      updated_at: new Date().toISOString(),
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  async departAdmission(requestId: string): Promise<AdmissionRequest | undefined> {
    const existing = this.requests.get(requestId);
    if (!existing) return undefined;
    if (existing.status === "DEPARTED") return existing; // idempotent
    if (existing.status !== "ADMITTED") {
      throw new AlreadyDecidedError(existing);
    }
    const updated: AdmissionRequest = {
      ...existing,
      status: "DEPARTED",
      sealed_secret: null,
      hub_authorized_at: null,
      updated_at: new Date().toISOString(),
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
    networkId?: string,
  ): Promise<AdmissionRequest> {
    // M3 — atomic upsert: INSERT ... ON CONFLICT(principal_id, peer_pubkey) DO NOTHING.
    // Mirrors the D1NonceCache atomic insert pattern: the database decides atomically
    // whether the row exists; no SELECT-then-INSERT race window exists. After the
    // insert-or-ignore, we unconditionally SELECT the row and return it.
    // Contract: always returns the PENDING (or already-decided) row for this
    // (principal_id, peer_pubkey) pair; never throws on a concurrent insert;
    // never creates a duplicate.
    // ADR-0018 Gap-A — the idempotency / conflict target is now the TRIPLE
    // `(principal_id, peer_pubkey, COALESCE(network_id, ''))` (migration 0008).
    // The `COALESCE(...,'')` makes a network-less register (NULL network_id)
    // still dedupe — SQLite treats raw NULLs as distinct, which would re-insert
    // a duplicate PENDING row on every plain re-register; normalising NULL→''
    // restores the pre-ADR-0018 `(principal_id, peer_pubkey)` idempotency for
    // that path while keeping two DISTINCT networks as two distinct rows.
    const now = new Date().toISOString();
    const requestId = generateRequestId();
    await this.db
      .prepare(
        `INSERT INTO admission_requests
           (request_id, principal_id, peer_pubkey, requested_scope, network_id, status, created_at, updated_at, granted_by)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL)
         ON CONFLICT(principal_id, peer_pubkey, COALESCE(network_id, '')) DO NOTHING`,
      )
      .bind(requestId, principalId, peerPubkey, requestedScope, networkId ?? null, now, now)
      .run();

    // Unconditional SELECT — retrieves the winner (our insert or the existing
    // row) for THIS network. The `COALESCE` mirrors the conflict target so a
    // NULL network_id matches the empty-string-normalised bind, and two networks
    // never cross-select each other's row.
    const row = await this.db
      .prepare(
        "SELECT * FROM admission_requests WHERE principal_id = ? AND peer_pubkey = ? AND COALESCE(network_id, '') = COALESCE(?, '')",
      )
      .bind(principalId, peerPubkey, networkId ?? null)
      .first<AdmissionRequestRow>();

    // The row MUST exist at this point: either we inserted it or it pre-existed.
    // A missing row here would indicate a D1 write anomaly outside normal operation.
    if (!row) {
      throw new Error(
        `network-registry: upsertPending invariant violated — no row found for (${principalId}, ${peerPubkey}) after atomic insert`,
      );
    }
    return rowToAdmissionRequest(row);
  }

  async getIssuanceRequest(requestId: string): Promise<AdmissionRequest | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM admission_requests WHERE request_id = ?")
      .bind(requestId)
      .first<AdmissionRequestRow>();
    return row ? rowToAdmissionRequest(row) : undefined;
  }

  async listIssuanceRequests(status: AdmissionStatus): Promise<AdmissionRequest[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM admission_requests WHERE status = ? ORDER BY created_at ASC",
      )
      .bind(status)
      .all<AdmissionRequestRow>();
    return (res.results ?? []).map(rowToAdmissionRequest);
  }

  async listIssuanceRequestsByPeer(peerPubkey: string): Promise<AdmissionRequest[]> {
    const res = await this.db
      .prepare(
        "SELECT * FROM admission_requests WHERE peer_pubkey = ? ORDER BY created_at ASC",
      )
      .bind(peerPubkey)
      .all<AdmissionRequestRow>();
    return (res.results ?? []).map(rowToAdmissionRequest);
  }

  async transitionIssuanceRequest(
    requestId: string,
    newStatus: "ADMITTED" | "REJECTED",
    adminPubkey: string,
  ): Promise<AdmissionRequest | undefined> {
    // Re-read current state before mutating — needed for AlreadyDecidedError.
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status !== "PENDING") {
      throw new AlreadyDecidedError(existing);
    }

    const now = new Date().toISOString();

    // CAS-ish: UPDATE only touches the row when status is still PENDING.
    // If a concurrent admit/reject raced us here, the WHERE status='PENDING'
    // is false, changes === 0, and we throw AlreadyDecidedError.
    const res = await this.db
      .prepare(
        `UPDATE admission_requests
         SET status = ?, granted_by = ?, updated_at = ?
         WHERE request_id = ? AND status = 'PENDING'`,
      )
      .bind(newStatus, adminPubkey, now, requestId)
      .run();

    if ((res.meta?.changes ?? 0) === 0) {
      // N2 — the pre-UPDATE `existing` row is already in scope and was confirmed
      // PENDING before the UPDATE ran. `changes === 0` means the
      // `WHERE status = 'PENDING'` guard flipped false after our read — a
      // concurrent admit/reject landed between our SELECT and UPDATE. Throw
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
    };
  }

  async setSealedSecret(
    requestId: string,
    sealedSecret: string,
  ): Promise<AdmissionRequest | undefined> {
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status !== "ADMITTED") return undefined; // route → 409 not_admitted
    const now = new Date().toISOString();
    // CAS-ish guard: only an ADMITTED row can carry a sealed secret. A concurrent
    // revoke between our read and this UPDATE flips the guard false → changes 0 →
    // undefined (the route maps it to 409). `rotate` REPLACES the blob in place.
    const res = await this.db
      .prepare(
        `UPDATE admission_requests
         SET sealed_secret = ?, updated_at = ?
         WHERE request_id = ? AND status = 'ADMITTED'`,
      )
      .bind(sealedSecret, now, requestId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return undefined;
    return { ...existing, sealed_secret: sealedSecret, updated_at: now };
  }

  async markHubAuthorized(
    requestId: string,
    timestampIso: string,
  ): Promise<AdmissionRequest | undefined> {
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status !== "ADMITTED") return undefined; // route → 409 not_admitted
    const now = new Date().toISOString();
    // CAS-ish guard: only an ADMITTED row can carry a hub-authorize stamp. A
    // concurrent revoke/depart between our read and this UPDATE flips the guard
    // false → changes 0 → undefined (the route maps it to 409).
    const res = await this.db
      .prepare(
        `UPDATE admission_requests
         SET hub_authorized_at = ?, updated_at = ?
         WHERE request_id = ? AND status = 'ADMITTED'`,
      )
      .bind(timestampIso, now, requestId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return undefined;
    return { ...existing, hub_authorized_at: timestampIso, updated_at: now };
  }

  async revokeAdmission(requestId: string): Promise<AdmissionRequest | undefined> {
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status === "REVOKED") return existing; // idempotent no-op
    if (existing.status !== "ADMITTED") {
      throw new AlreadyDecidedError(existing);
    }
    const now = new Date().toISOString();
    const res = await this.db
      .prepare(
        `UPDATE admission_requests
         SET status = 'REVOKED', sealed_secret = NULL, hub_authorized_at = NULL, updated_at = ?
         WHERE request_id = ? AND status = 'ADMITTED'`,
      )
      .bind(now, requestId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) {
      // A concurrent revoke won the race; the row is already REVOKED.
      const current = await this.getIssuanceRequest(requestId);
      return current;
    }
    return { ...existing, status: "REVOKED", sealed_secret: null, hub_authorized_at: null, updated_at: now };
  }

  async departAdmission(requestId: string): Promise<AdmissionRequest | undefined> {
    const existing = await this.getIssuanceRequest(requestId);
    if (!existing) return undefined;
    if (existing.status === "DEPARTED") return existing; // idempotent no-op
    if (existing.status !== "ADMITTED") {
      throw new AlreadyDecidedError(existing);
    }
    const now = new Date().toISOString();
    const res = await this.db
      .prepare(
        `UPDATE admission_requests
         SET status = 'DEPARTED', sealed_secret = NULL, hub_authorized_at = NULL, updated_at = ?
         WHERE request_id = ? AND status = 'ADMITTED'`,
      )
      .bind(now, requestId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) {
      // The `WHERE status = 'ADMITTED'` guard flipped false between our SELECT
      // and UPDATE — a concurrent transition landed. Re-derive the outcome from
      // the CURRENT row so we never report a bogus success: an already-DEPARTED
      // row is the idempotent case (200); anything else (a REVOKE that beat us,
      // etc.) is a 409 via AlreadyDecidedError; a vanished row is 404.
      const current = await this.getIssuanceRequest(requestId);
      if (!current) return undefined;
      if (current.status === "DEPARTED") return current;
      throw new AlreadyDecidedError(current);
    }
    return { ...existing, status: "DEPARTED", sealed_secret: null, hub_authorized_at: null, updated_at: now };
  }
}

/** Raw column shape for an admission_requests row. */
interface AdmissionRequestRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  requested_scope: string;
  network_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  granted_by: string | null;
  /** ADR-0018 b′ — opaque sealed ciphertext; NULL until add-member delivers it. */
  sealed_secret: string | null;
  /** cortex#1498 — ISO-8601 UTC hub-owner authorization stamp; NULL until `authorize`. */
  hub_authorized_at: string | null;
}

function rowToAdmissionRequest(row: AdmissionRequestRow): AdmissionRequest {
  return {
    request_id: row.request_id,
    principal_id: row.principal_id,
    peer_pubkey: row.peer_pubkey,
    requested_scope: row.requested_scope,
    network_id: row.network_id,
    status: row.status as AdmissionStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    granted_by: row.granted_by,
    // A row read from a pre-0010 isolate (column absent) coalesces to null.
    sealed_secret: row.sealed_secret ?? null,
    // A row read from a pre-0013 isolate (column absent) coalesces to null.
    hub_authorized_at: row.hub_authorized_at ?? null,
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
    adminPubkeys?: string,
    attestation?: { hubMode?: "operator" | "simple"; resolverMode?: "nats" | "memory" },
  ): Promise<NetworkRecord> {
    const record: NetworkRecord = {
      network_id: networkId,
      hub_url: hubUrl,
      leaf_port: leafPort,
      updated_at: new Date().toISOString(),
      ...(adminPubkeys !== undefined && { admin_pubkeys: adminPubkeys }),
      ...(attestation?.hubMode !== undefined && { hub_mode: attestation.hubMode }),
      ...(attestation?.resolverMode !== undefined && { resolver_mode: attestation.resolverMode }),
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
    adminPubkeys?: string,
    attestation?: { hubMode?: "operator" | "simple"; resolverMode?: "nats" | "memory" },
  ): Promise<NetworkRecord> {
    const record: NetworkRecord = {
      network_id: networkId,
      hub_url: hubUrl,
      leaf_port: leafPort,
      updated_at: new Date().toISOString(),
      ...(adminPubkeys !== undefined && { admin_pubkeys: adminPubkeys }),
      ...(attestation?.hubMode !== undefined && { hub_mode: attestation.hubMode }),
      ...(attestation?.resolverMode !== undefined && { resolver_mode: attestation.resolverMode }),
    };
    // UPSERT: re-seeding a network replaces the topology row in place.
    // Parameterised — no value is string-interpolated into SQL.
    await this.db
      .prepare(
        `INSERT INTO networks (network_id, hub_url, leaf_port, updated_at, admin_pubkeys, hub_mode, resolver_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(network_id) DO UPDATE SET
           hub_url       = excluded.hub_url,
           leaf_port     = excluded.leaf_port,
           updated_at    = excluded.updated_at,
           admin_pubkeys = excluded.admin_pubkeys,
           hub_mode      = excluded.hub_mode,
           resolver_mode = excluded.resolver_mode`,
      )
      .bind(
        networkId,
        hubUrl,
        leafPort,
        record.updated_at,
        adminPubkeys ?? null,
        attestation?.hubMode ?? null,
        attestation?.resolverMode ?? null,
      )
      .run();
    return record;
  }

  async getNetwork(networkId: string): Promise<NetworkRecord | undefined> {
    const row = await this.db
      .prepare(
        "SELECT network_id, hub_url, leaf_port, updated_at, admin_pubkeys, hub_mode, resolver_mode FROM networks WHERE network_id = ?",
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
  /** #1321 — nullable per-network admin allowlist (TEXT column, migration 0011). */
  admin_pubkeys?: string | null;
  /** #1598 — nullable hub-mode attestation (TEXT column, migration 0014). */
  hub_mode?: string | null;
  /** #1598 — nullable resolver-mode attestation (TEXT column, migration 0014). */
  resolver_mode?: string | null;
}

function rowToNetworkRecord(row: NetworkRow): NetworkRecord {
  return {
    network_id: row.network_id,
    hub_url: row.hub_url,
    leaf_port: row.leaf_port,
    updated_at: row.updated_at,
    // Normalise SQL NULL → undefined so the record shape matches the InMemory store.
    ...(row.admin_pubkeys != null && { admin_pubkeys: row.admin_pubkeys }),
    // #1598 — the validator is the only writer, so the stored value is inside the
    // enum; narrow it back on read (a hand-edited junk value degrades to unset).
    ...((row.hub_mode === "operator" || row.hub_mode === "simple") && { hub_mode: row.hub_mode }),
    ...((row.resolver_mode === "nats" || row.resolver_mode === "memory") && {
      resolver_mode: row.resolver_mode,
    }),
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
 * ADR-0018 Q3/Gap-B — compute a network's roster from ADMITTED admission rows.
 *
 * Admission is the SOURCE OF TRUTH for membership: a principal is "in" network
 * X iff they hold an ADMITTED admission row for X. Announced capabilities NO
 * LONGER confer membership — they are an orthogonal facet ("what an admitted
 * member offers"), joined on top of membership (possibly empty). This is the
 * resolution of the bug class ADR-0015 warns against (conflating membership
 * with capability).
 *
 * For each distinct ADMITTED principal in the network we join their principal
 * record for `principal_pubkey` and the capabilities they announced into THIS
 * network (the facet). An admitted principal with no record (should not happen
 * — the register hook creates the record before the admission row) is skipped
 * defensively rather than emitted with an empty pubkey. Sorted by principal_id
 * for a stable, canonical-friendly response.
 */
export function rosterFromAdmissions(
  admitted: AdmissionRequest[],
  principals: PrincipalRecord[],
  networkId: string,
): NetworkRoster {
  const byId = new Map(principals.map((p) => [p.principal_id, p]));
  const seen = new Set<string>();
  const members: NetworkRoster["members"] = [];
  for (const row of admitted) {
    if (row.status !== "ADMITTED" || row.network_id !== networkId) continue;
    if (seen.has(row.principal_id)) continue;
    seen.add(row.principal_id);
    const record = byId.get(row.principal_id);
    if (!record) continue; // defensive: admitted principal must have registered.
    const capabilities = record.capabilities
      .filter((cap) => (cap.networks ?? []).includes(networkId))
      .map((cap) => cap.id);
    // cortex#1852 — project the member's DERIVED `stack_id` (same read-time join
    // the admission reads use, cortex#1723). `undefined` ⇒ underivable (no live
    // stack matches `peer_pubkey`, or more than one does): OMIT the key entirely.
    // Never `null`, never a guessed `{principal}/default` — the client's silent
    // fabrication of that default is precisely the defect this closes.
    const stackId = deriveAdmissionStackId(row, principals);
    members.push({
      principal_id: record.principal_id,
      principal_pubkey: record.principal_pubkey,
      capabilities,
      // FLG-4 — ADDITIVE roster lifecycle facets (cortex MC roster glass). This
      // read is the ADMITTED roster, so `admission_state` is ADMITTED; `sealed`
      // is a boolean DELIVERY signal (`sealed_secret !== null` — NEVER the
      // ciphertext); `hub_authorized_at` is the cortex#1498 authorize timestamp.
      admission_state: "ADMITTED",
      sealed: row.sealed_secret !== null,
      hub_authorized_at: row.hub_authorized_at,
      ...(stackId !== undefined && { stack_id: stackId }),
    });
  }
  members.sort((a, b) => a.principal_id.localeCompare(b.principal_id));
  return { network_id: networkId, members };
}

/**
 * ADR-0018 Q3/Gap-B — derive a network's lightweight membership list (principal
 * ids) for the descriptor from ADMITTED admission rows. Mirrors
 * {@link membersFromPrincipals} (the retired capability-derived view) but is
 * sourced from admission, so the descriptor's `members[]` can never disagree
 * with the admission-sourced `/roster`. Unique + sorted for a stable response.
 */
export function membersFromAdmissions(
  admitted: AdmissionRequest[],
  principals: PrincipalRecord[],
  networkId: string,
): string[] {
  return rosterFromAdmissions(admitted, principals, networkId).members.map((m) => m.principal_id);
}

/**
 * cortex#1723 — derive an admission row's `stack_id` at READ time by joining
 * `peer_pubkey` against the principal record's LIVE stacks (same
 * derived-not-stored posture as roster membership). Admission rows never stored
 * a stack segment, so the custodian seal tooling defaulted the scoped-user name
 * to `<principal>.default` — minting a SUB scope the member's real stack can
 * never receive on (the live jc↔andreas mis-seal). Returns undefined when the
 * pubkey matches no live stack or MORE than one (ambiguous — never guess; the
 * seal side fails loud and asks for --leaf-user).
 */
export function deriveAdmissionStackId(
  row: Pick<AdmissionRequest, "principal_id" | "peer_pubkey">,
  principals: PrincipalRecord[],
): string | undefined {
  const record = principals.find((p) => p.principal_id === row.principal_id);
  if (!record) return undefined;
  const live = record.stacks.filter((s) => s.retired_at === undefined && s.stack_pubkey === row.peer_pubkey);
  return live.length === 1 ? live[0]?.stack_id : undefined;
}

/** cortex#1723 — an admission row enriched with the derived `stack_id` (absent when underivable). */
export function withDerivedStackId(
  row: AdmissionRequest,
  principals: PrincipalRecord[],
): AdmissionRequest & { stack_id?: string } {
  const stackId = deriveAdmissionStackId(row, principals);
  return stackId !== undefined ? { ...row, stack_id: stackId } : row;
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
