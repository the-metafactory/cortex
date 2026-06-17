/**
 * Thin D1 mock (cortex#682).
 *
 * Implements the `D1Database` surface the registry actually uses —
 * `prepare(sql).bind(...args).run() / .all() / .first()` — backed by two
 * in-memory maps that stand in for the `principals` and `nonces` tables.
 *
 * Why a hand-rolled mock and not miniflare/wrangler local D1:
 *   - `bun test` runs the suite via `app.fetch(req, env)` with no Worker
 *     runtime; spinning up wrangler's local D1 would couple the unit
 *     tests to the wrangler toolchain and a filesystem sqlite. The mock
 *     keeps the suite hermetic and fast.
 *   - The mock recognises the EXACT statements D1RegistryStore /
 *     D1NonceCache issue, so it faithfully exercises the parameterised
 *     query path (every value arrives via `.bind(...)`, never via string
 *     interpolation — that is exactly what the SQLi-safety test asserts:
 *     a quote-laden principal_id round-trips as opaque data).
 *
 * Crucially, ONE `MockD1` instance shared across two `D1RegistryStore`
 * / `D1NonceCache` instances models two Worker isolates talking to the
 * same logical D1 — which is how the nonce-durability test proves a
 * replay is caught across isolates.
 */

import type { D1Like } from "../src/store";

interface PrincipalRow {
  principal_id: string;
  principal_pubkey: string;
  stacks: string;
  capabilities: string;
  updated_at: string;
}

interface NetworkRow {
  network_id: string;
  hub_url: string;
  leaf_port: number;
  updated_at: string;
}

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

/** What D1's `.run()` returns — we only populate `meta.changes`. */
interface RunResult {
  meta: { changes: number };
}

/**
 * Normalise a SQL string to a single-spaced, trimmed form so multi-line
 * template-literal queries match regardless of indentation/newlines.
 */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

class MockStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: MockD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): MockStatement {
    this.args = args;
    return this;
  }

  async run(): Promise<RunResult> {
    return this.db._exec(this.sql, this.args);
  }

  async first<T>(): Promise<T | null> {
    const rows = this.db._query(this.sql, this.args);
    return (rows[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db._query(this.sql, this.args) as T[] };
  }
}

export class MockD1 {
  readonly principals = new Map<string, PrincipalRow>();
  readonly networks = new Map<string, NetworkRow>();
  readonly nonces = new Map<string, number>();
  /** Keyed by request_id */
  readonly issuanceRequests = new Map<string, IssuanceRequestRow>();
  /** Maps (principal_id + "\x00" + peer_pubkey) → request_id for the unique constraint */
  private readonly issuancePeerIndex = new Map<string, string>();

  /** Count of writes, exposed so tests can assert query activity if needed. */
  writeCount = 0;

  prepare(sql: string): MockStatement {
    return new MockStatement(this, sql);
  }

  // --- statement dispatch ---------------------------------------------------

  _exec(sqlRaw: string, args: unknown[]): RunResult {
    const sql = norm(sqlRaw);
    this.writeCount++;

    // nonces: opportunistic prune
    if (sql.startsWith("DELETE FROM nonces WHERE seen_at <")) {
      const cutoff = args[0] as number;
      for (const [k, ts] of this.nonces) {
        if (ts < cutoff) this.nonces.delete(k);
      }
      return { meta: { changes: 0 } };
    }

    // nonces: atomic insert-or-ignore
    if (sql.startsWith("INSERT INTO nonces")) {
      const [nonce, seenAt] = args as [string, number];
      if (this.nonces.has(nonce)) return { meta: { changes: 0 } };
      this.nonces.set(nonce, seenAt);
      return { meta: { changes: 1 } };
    }

    // nonces: reset
    if (sql === "DELETE FROM nonces") {
      const n = this.nonces.size;
      this.nonces.clear();
      return { meta: { changes: n } };
    }

    // principals: UPSERT
    if (sql.startsWith("INSERT INTO principals")) {
      const [principalId, pubkey, stacks, capabilities, updatedAt, expectedUpdatedAt] = args as [
        string,
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      // #825 — when the SQL carries the optimistic-concurrency upsert guard
      // (`... ON CONFLICT DO UPDATE SET ... WHERE principals.updated_at = ?`),
      // honour it: an existing row whose updated_at != the expected (last bind)
      // means the conflict-update's WHERE is false → no-op → changes === 0.
      const existing = this.principals.get(principalId);
      if (sql.includes("WHERE principals.updated_at = ?") && existing && existing.updated_at !== expectedUpdatedAt) {
        return { meta: { changes: 0 } };
      }
      this.principals.set(principalId, {
        principal_id: principalId,
        principal_pubkey: pubkey,
        stacks,
        capabilities,
        updated_at: updatedAt,
      });
      // An UPSERT always touches exactly one row (insert or update).
      return { meta: { changes: 1 } };
    }

    // principals: reset
    if (sql === "DELETE FROM principals") {
      const n = this.principals.size;
      this.principals.clear();
      return { meta: { changes: n } };
    }

    // networks: UPSERT (S2.5)
    if (sql.startsWith("INSERT INTO networks")) {
      const [networkId, hubUrl, leafPort, updatedAt] = args as [
        string,
        string,
        number,
        string,
      ];
      this.networks.set(networkId, {
        network_id: networkId,
        hub_url: hubUrl,
        leaf_port: leafPort,
        updated_at: updatedAt,
      });
      // An UPSERT always touches exactly one row (insert or update).
      return { meta: { changes: 1 } };
    }

    // networks: reset (S2.5)
    if (sql === "DELETE FROM networks") {
      const n = this.networks.size;
      this.networks.clear();
      return { meta: { changes: n } };
    }

    // issuance_requests: INSERT ... ON CONFLICT(principal_id, peer_pubkey) DO NOTHING
    // (M3 atomic upsert — D1IssuanceRequestStore.upsertPending)
    if (sql.startsWith("INSERT INTO issuance_requests")) {
      const [requestId, principalId, peerPubkey, requestedScope, createdAt, updatedAt] = args as [
        string, string, string, string, string, string,
      ];
      const peerKey = `${principalId}\x00${peerPubkey}`;
      // ON CONFLICT(principal_id, peer_pubkey) DO NOTHING — idempotent.
      if (this.issuancePeerIndex.has(peerKey)) {
        return { meta: { changes: 0 } }; // existing row wins, no-op
      }
      const row: IssuanceRequestRow = {
        request_id: requestId,
        principal_id: principalId,
        peer_pubkey: peerPubkey,
        requested_scope: requestedScope,
        status: "PENDING",
        created_at: createdAt,
        updated_at: updatedAt,
        granted_by: null,
        leaf_package: null,
      };
      this.issuanceRequests.set(requestId, row);
      this.issuancePeerIndex.set(peerKey, requestId);
      return { meta: { changes: 1 } };
    }

    // issuance_requests: UPDATE (transitionIssuanceRequest — CAS on status='PENDING')
    if (sql.startsWith("UPDATE issuance_requests SET status")) {
      const [newStatus, grantedBy, updatedAt, requestId] = args as [string, string, string, string];
      const existing = this.issuanceRequests.get(requestId);
      if (!existing || existing.status !== "PENDING") {
        return { meta: { changes: 0 } };
      }
      const updated: IssuanceRequestRow = { ...existing, status: newStatus, granted_by: grantedBy, updated_at: updatedAt };
      this.issuanceRequests.set(requestId, updated);
      return { meta: { changes: 1 } };
    }

    // issuance_requests: reset
    if (sql === "DELETE FROM issuance_requests") {
      const n = this.issuanceRequests.size;
      this.issuanceRequests.clear();
      this.issuancePeerIndex.clear();
      return { meta: { changes: n } };
    }

    throw new Error(`MockD1: unhandled write statement: ${sql}`);
  }

  _query(sqlRaw: string, args: unknown[]): unknown[] {
    const sql = norm(sqlRaw);

    // principals: SELECT one by id
    if (sql.includes("FROM principals WHERE principal_id =")) {
      const id = args[0] as string;
      const row = this.principals.get(id);
      return row ? [row] : [];
    }

    // principals: SELECT all
    if (sql.startsWith("SELECT") && sql.includes("FROM principals")) {
      return [...this.principals.values()];
    }

    // networks: SELECT one by id (S2.5)
    if (sql.includes("FROM networks WHERE network_id =")) {
      const id = args[0] as string;
      const row = this.networks.get(id);
      return row ? [row] : [];
    }

    // issuance_requests: SELECT by request_id
    if (sql.includes("FROM issuance_requests WHERE request_id =")) {
      const id = args[0] as string;
      const row = this.issuanceRequests.get(id);
      return row ? [row] : [];
    }

    // issuance_requests: SELECT by (principal_id, peer_pubkey)
    if (sql.includes("FROM issuance_requests WHERE principal_id = ? AND peer_pubkey =")) {
      const [principalId, peerPubkey] = args as [string, string];
      const key = `${principalId}\x00${peerPubkey}`;
      const requestId = this.issuancePeerIndex.get(key);
      if (!requestId) return [];
      const row = this.issuanceRequests.get(requestId);
      return row ? [row] : [];
    }

    // issuance_requests: SELECT by status ORDER BY created_at
    if (sql.includes("FROM issuance_requests WHERE status =")) {
      const status = args[0] as string;
      return [...this.issuanceRequests.values()]
        .filter((r) => r.status === status)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    throw new Error(`MockD1: unhandled read statement: ${sql}`);
  }
}

/**
 * Hand the mock to code expecting the `D1Like` surface the stores accept.
 * The mock implements that structural shape directly, so this is just a
 * typed pass-through (no real D1Database global is touched).
 */
export function asD1(mock: MockD1): D1Like {
  return mock;
}
