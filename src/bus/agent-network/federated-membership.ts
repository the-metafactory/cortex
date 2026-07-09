/**
 * FS-1 (cortex#1825, epic #1818, design-federation-simplification §3 D-1) — the
 * **federated-membership oracle**: "is principal X an ADMITTED member of a
 * network this stack has joined?"
 *
 * ## Why this exists (D-1 presence-by-membership)
 *
 * Under D-1, admission to a network ⇒ co-members see each other's presence by
 * default; the per-peer `peers[]` offering is no longer the presence trust
 * anchor. The federated-presence subscriber (`federated-subscriber.ts`) folds an
 * admitted member's signed/permissive presence even when the member is NOT
 * hand-listed with a pinned pubkey — **membership IS the accept-list for
 * presence**. To make that decision at fold time the subscriber needs a cheap,
 * synchronous "is this source principal admitted?" check. That is this oracle.
 *
 * ## Membership authority — the ADMISSION ROWS, not the capability roster (Q3)
 *
 * Membership is sourced from the **admission rows** (ADR-0018 Q3), via the SAME
 * {@link AdmissionRowsProvider} the `/api/networks` view uses
 * ({@link resolveAdmittedRoster}). It is NOT the capability-derived
 * `GET /networks/{id}/roster` (`resolveNetworkRoster`): conflating a peer's
 * announced *capabilities* with *membership* is exactly the bug ADR-0018 Q3
 * forbids (cortex.ts §MC-A2). The admission read is PoP-signed by this stack's
 * own registered key and DD-9-verified against the pinned registry pubkey — a
 * single trust source, never the envelope's self-asserted identity.
 *
 * ## Authoritative-only (self-scope reads never establish peer membership)
 *
 * A `resolveAdmittedRoster` read is authoritative ONLY when its scope is
 * `complete` ({@link AdmittedRoster.authoritative}). A `self`-scope read returns
 * only THIS stack's own admission row — it does not enumerate peers — so it can
 * NOT be used to decide a peer's membership. The oracle therefore updates a
 * network's admitted set ONLY from an authoritative read; a non-authoritative or
 * failed read leaves that network's LAST-GOOD set in place (best-effort — never
 * wipe membership on a transient outage / a degraded read).
 *
 * ## Best-effort (never throws, never blocks)
 *
 * The refresh loop mirrors the federation reconciler: a read that fails routes
 * to `onError` and leaves last-good in place; a tick never throws out of the
 * loop. `isAdmittedMember` is a pure synchronous set membership test over the
 * last successfully-resolved snapshot — safe to call on the presence fold hot
 * path with zero I/O.
 */

import {
  resolveAdmittedRoster,
  type AdmissionRowsProvider,
} from "./admission-read";

/** Default refresh cadence — matches the federation reconciler's 60 s self-poll. */
export const DEFAULT_MEMBERSHIP_REFRESH_INTERVAL_MS = 60_000;
/** Floor for the refresh interval (mirrors the reconciler schema `.min(5000)`). */
export const MIN_MEMBERSHIP_REFRESH_INTERVAL_MS = 5_000;

/** Construction options for {@link FederatedMembershipOracle}. */
export interface FederatedMembershipOracleOptions {
  /** The networks this stack has joined (their ids). Refreshed per network. */
  networkIds: readonly string[];
  /**
   * The admission-rows read seam (ADR-0018) — the SAME provider `/api/networks`
   * uses. A `not_configured` provider (no registry pin / no stack signing
   * material) leaves every network's set empty → `isAdmittedMember` is always
   * false → the subscriber falls back to the existing `peers[]` gate (honest
   * degradation, no membership-fold).
   */
  provider: AdmissionRowsProvider;
  /** Refresh interval (ms). Defaults to {@link DEFAULT_MEMBERSHIP_REFRESH_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Injectable scheduler — returns a canceller. Defaults to
   * setInterval/clearInterval. Tests pass a fake to drive ticks deterministically.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Called with any error a refresh throws (defaults to a stderr line). */
  onError?: (err: unknown) => void;
  /** Optional per-refresh sink (for logs / status). */
  onRefresh?: (info: {
    networkId: string;
    admittedCount: number;
    authoritative: boolean;
  }) => void;
  /** Run a refresh immediately on start (default true). */
  runOnStart?: boolean;
}

/** Lifecycle + query handle for the membership oracle. */
export interface FederatedMembershipOracleHandle {
  /**
   * True iff `principalId` is an ADMITTED member of ANY joined network per the
   * last authoritative admission-rows read. Pure, synchronous, hot-path-safe.
   *
   * FS-1 SECURITY NOTE (cortex#1825): this FLAT-UNION predicate must NOT be the
   * membership-fold anchor — it can't tell WHICH network a principal is admitted
   * to, so a member of Network B folds on Network A's leaf (cross-network
   * spoof). The presence subscriber uses the network-SCOPED
   * {@link isAdmittedMemberOfNetwork} instead, keyed off the delivering leaf.
   * Retained for status/summary reads that legitimately want "admitted anywhere".
   */
  isAdmittedMember(principalId: string): boolean;
  /**
   * True iff `principalId` is an ADMITTED member of the SPECIFIC network
   * `networkId` per the last authoritative admission-rows read. Pure,
   * synchronous, hot-path-safe.
   *
   * FS-1 (cortex#1825) — this is the membership-fold anchor. The presence
   * subscriber resolves the DELIVERING LEAF → its network(s) and requires the
   * source principal to be an admitted member OF THAT network, so a principal
   * admitted only on Network B can never be membership-folded when its envelope
   * arrives on Network A's leaf.
   */
  isAdmittedMemberOfNetwork(principalId: string, networkId: string): boolean;
  /** Force one refresh pass now (test seam / warm-up). Never throws. */
  refresh(): Promise<void>;
  /** Start the periodic refresh loop (idempotent). */
  start(): void;
  /** Await the in-flight refresh (if any). Test seam for deterministic ticks. */
  settle(): Promise<void>;
  /** Stop the loop (idempotent): cancel the schedule + await any in-flight pass. */
  stop(): Promise<void>;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setInterval(fn, ms);
  return () => {
    clearInterval(id);
  };
};

/**
 * Build the federated-membership oracle. INERT (no schedule, no set) when no
 * networks are joined — a stack with no federation never polls and
 * `isAdmittedMember` is always false.
 */
export function createFederatedMembershipOracle(
  opts: FederatedMembershipOracleOptions,
): FederatedMembershipOracleHandle {
  const networkIds = [...opts.networkIds];
  const onError =
    opts.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[federated-membership] refresh failed: ${err instanceof Error ? err.message : String(err)}\n`,
      ));
  const intervalMs = Math.max(
    MIN_MEMBERSHIP_REFRESH_INTERVAL_MS,
    opts.intervalMs ?? DEFAULT_MEMBERSHIP_REFRESH_INTERVAL_MS,
  );
  const schedule = opts.schedule ?? defaultSchedule;

  // Per-network last-good admitted set (only updated from an AUTHORITATIVE read).
  const perNetwork = new Map<string, ReadonlySet<string>>();
  // Flattened union of every network's admitted set — the hot-path lookup.
  let flattened = new Set<string>();

  const rebuildFlattened = (): void => {
    const next = new Set<string>();
    for (const set of perNetwork.values()) {
      for (const id of set) next.add(id);
    }
    flattened = next;
  };

  const refresh = async (): Promise<void> => {
    for (const networkId of networkIds) {
      // resolveAdmittedRoster never throws (it returns a discriminated result);
      // an unexpected provider fault is still contained per-network so one bad
      // read never blocks the others.
      let result: Awaited<ReturnType<typeof resolveAdmittedRoster>>;
      try {
        result = await resolveAdmittedRoster(networkId, opts.provider);
      } catch (err) {
        onError(err);
        continue;
      }
      if (!result.ok) {
        // Transient / degraded read — keep this network's last-good set. Never
        // wipe membership on an outage (a wipe would drop every co-member off MC
        // until the registry recovers).
        continue;
      }
      if (!result.roster.authoritative) {
        // A self-scope read does not enumerate peers — it cannot establish a
        // peer's membership. Keep last-good; do NOT collapse the set to "just me".
        continue;
      }
      perNetwork.set(networkId, new Set(result.roster.admitted));
      opts.onRefresh?.({
        networkId,
        admittedCount: result.roster.admitted.length,
        authoritative: true,
      });
    }
    rebuildFlattened();
  };

  let inFlight: Promise<void> | null = null;
  let cancel: (() => void) | null = null;
  let started = false;
  let stopped = false;

  const tick = (): void => {
    // Self-isolating: a rejection routes to onError, never escaping the tick.
    const pass = Promise.resolve()
      .then(refresh)
      .then(
        () => undefined,
        (err: unknown) => {
          onError(err);
        },
      )
      .finally(() => {
        if (inFlight === pass) inFlight = null;
      });
    inFlight = pass;
  };

  return {
    isAdmittedMember: (principalId: string): boolean =>
      flattened.has(principalId),
    isAdmittedMemberOfNetwork: (
      principalId: string,
      networkId: string,
    ): boolean => perNetwork.get(networkId)?.has(principalId) ?? false,
    refresh,
    start: (): void => {
      if (started || networkIds.length === 0) return;
      started = true;
      if (opts.runOnStart !== false) tick();
      cancel = schedule(tick, intervalMs);
    },
    settle: async (): Promise<void> => {
      if (inFlight) await inFlight;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (cancel) cancel();
      if (inFlight) await inFlight;
    },
  };
}
