/**
 * P3 (cortex#1088, design-roster-driven-federation-wiring §4/§5/§7) — the
 * **runtime federation roster reconciler**.
 *
 * ## The missing wire (design §1/§2)
 *
 * A principal whose stack is a member of a network could not SEE the other
 * stacks' assistants on that network in Mission Control, even with the leaf link
 * up and the peer a known member (`in=0`). Two defects (design §2):
 *
 *   1. **Self-only accept-list** — `network join` recorded peers in `peers[]` but
 *      wrote `accept_subjects` as the OWN subtree only, so inbound
 *      `federated.{peer}.*` presence was gated out. (FIXED at join time by P2.)
 *   2. **One-shot at join** — the roster was resolved ONCE, at `network join`. A
 *      peer that joins the network LATER (the common case) never lands on the
 *      accept-list; there is no reconcile.
 *
 * This module is defect #2's fix: it re-runs P1's roster read + P2's accept-list
 * derivation CONTINUOUSLY, on a refresh interval, and applies the result to the
 * LIVE `policy.federated.networks[]` the federation gate reads — so a
 * later-joining roster peer is admitted within one interval, no manual rejoin.
 *
 * ## How "apply to the live policy + (re)subscribe" actually works (design §4.3)
 *
 * The federated presence subscriber (`federated-subscriber.ts`) binds the
 * principal-WILDCARD firehose `federated.*.*.agent.>` ONCE and decides
 * admissibility at FOLD time via `evaluateFederationGate`, which reads
 * `network.accept_subjects` / `network.peers` off the `PolicyFederatedNetwork`
 * objects held in its `federatedNetworksById` Map. That Map holds OBJECT
 * REFERENCES. So "(re)subscribe to the newly accept-listed subtrees" is NOT a
 * NATS re-bind — the firehose already covers every peer. It is: **mutate the
 * live `PolicyFederatedNetwork` object IN PLACE** (its `peers` + `accept_subjects`
 * arrays). The gate then admits the new peer's presence on the very next
 * envelope, with NO churn of the NATS subscription. {@link reconcileNetwork}
 * therefore mutates the passed network object, never replaces it.
 *
 * ## Trust invariants (design §5 — UNCHANGED, must hold)
 *
 * - **Registry is the authority, the wire is data.** The reconciler ONLY
 *   accept-lists peers the verified registry ROSTER names (P1 reads a
 *   DD-9-verified roster). It never infers membership from an arriving subject.
 * - **Only presence/dispatch SUBTREES are widened.** Each accept entry is a
 *   top-level `federated.{principal}.{stack}.>` wildcard (the P2 derivation); no
 *   interior subtree (a tool/prompt/diff path) is ever accept-listed.
 * - **The gate is unchanged.** Widening the accept-list does NOT bypass
 *   `verifySignedByChain` under `enforce` — the subscriber still chain-verifies
 *   every folded foreign envelope. This module touches accept-list membership
 *   only; the posture ladder (accept-list-only under `off`, chain-verify under
 *   `enforce`) is the subscriber's, untouched.
 * - **Opt-in preserved (OQ1).** Per-network, default OFF. The reconciler only
 *   ever touches a network whose `reconcile.enabled === true`.
 *
 * ## Signal-optional (design §4, hard constraint)
 *
 * The trigger is a cortex-owned self-poll (OQ3). This module reads the registry
 * via cortex's OWN client (the P1 {@link NetworkRosterProvider} slice) and has
 * ZERO dependency on the `signal` package — it works with signal not installed.
 * Piggybacking signal's `roster_snapshot` cadence is an additive follow-up (P4),
 * never a prerequisite. Do NOT add a signal import here.
 *
 * ## Best-effort (design §4, hard constraint)
 *
 * A degraded/unreachable peer or registry must NEVER block boot or perturb the
 * serving stack's own presence. Every failure is contained:
 *   - {@link resolveNetworkRoster} never throws (P1 returns a discriminated
 *     `ok: false`); a `not_found` / `unverified` / `unreachable_uncached` leaves
 *     the live policy UNCHANGED (last-good wins — never wipe the accept-list on a
 *     transient outage).
 *   - {@link reconcileOnce} isolates each network: one network's error never
 *     blocks reconcile of the others.
 *   - {@link startFederationReconciler}'s tick is self-isolating: a throw routes
 *     to `onError`, never escaping the loop (mirrors the cockpit refresh loop).
 */

import type { PolicyFederatedNetwork } from "../../common/types/cortex-config";
import type { NetworkRosterProvider } from "../../common/registry/resolve-federated-peers";
import {
  resolveNetworkRoster,
  type RosterPeer,
} from "./roster-read";
import {
  deriveAcceptSubjects,
  type AcceptSubjectsSelf,
  type FederatedWireIdentity,
} from "./accept-subjects";

// =============================================================================
// Defaults
// =============================================================================

/** Floor for the self-poll interval — matches the schema `.min(5000)`. */
export const MIN_RECONCILE_INTERVAL_MS = 5000;
/** Default self-poll interval — matches the schema `.default(60000)`. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60000;

// =============================================================================
// reconcileNetwork — derive desired policy + apply IN PLACE
// =============================================================================

/** The outcome of a single {@link reconcileNetwork} pass. */
export type ReconcileOutcome =
  /** Desired policy differed from live; the network object was mutated. */
  | "applied"
  /** Desired policy already matched live; nothing changed. */
  | "unchanged"
  /** Roster resolved 0 peers but prior hand-pins existed; preserved (#762). */
  | "preserved-handpins"
  /** Roster could not be resolved (not_found/unverified/unreachable-uncached); live policy left untouched. */
  | "skipped-error";

/** The result of {@link reconcileNetwork}. */
export interface ReconcileNetworkResult {
  /** The network reconciled. */
  networkId: string;
  outcome: ReconcileOutcome;
  /** True when the roster came from the DD-10 cache (registry was unreachable). */
  usedCache: boolean;
  /** Human-readable detail for logs (the negative reason, or the applied summary). */
  detail: string;
}

/**
 * Reconcile ONE network's live federation policy against its registry roster.
 *
 * Resolves the roster (P1), applies the #762 hand-pin guard, derives the desired
 * `peers[]` + `accept_subjects` (P2), and — when they differ from the live values
 * — MUTATES `network.peers` / `network.accept_subjects` IN PLACE so the gate's
 * Map (which holds this object by reference) admits the new peers' presence on
 * the next envelope, with no NATS re-subscribe.
 *
 * Never throws (P1 never throws; the derivation is pure). On any roster-resolve
 * negative the live policy is left UNTOUCHED (last-good wins).
 *
 * @param network The LIVE `PolicyFederatedNetwork` (mutated in place on apply).
 * @param self    The local stack's wire identity (own subtree for inbound dispatch).
 * @param client  cortex's OWN registry client (P1 slice — no signal; §4).
 */
export async function reconcileNetwork(
  network: PolicyFederatedNetwork,
  self: AcceptSubjectsSelf,
  client: NetworkRosterProvider,
): Promise<ReconcileNetworkResult> {
  const resolved = await resolveNetworkRoster(network.id, self.principal, client);

  if (!resolved.ok) {
    // not_found / unverified / unreachable_uncached — a definitive negative or a
    // transient outage with no cache. NEVER wipe the live accept-list on this:
    // last-good policy keeps serving until the registry recovers (design §4).
    return {
      networkId: network.id,
      outcome: "skipped-error",
      usedCache: false,
      detail: resolved.detail,
    };
  }

  // #762 — never clobber a working hand-pin with 0 resolved peers. The roster is
  // populated implicitly (a principal is "in" a network only once it announces a
  // capability listing that network), so an empty roster is the COMMON early
  // state, NOT an error. When the roster resolved nobody but the live policy
  // already carries hand-pinned peers, PRESERVE them (and derive the accept-list
  // from THAT preserved set) rather than wiping a peer that is actively carrying
  // federated traffic. When the roster DOES resolve peers, registry is the
  // source of truth (DD-5) and the resolved set wins.
  let preservedHandpins = false;
  let desiredPeers: PolicyFederatedNetwork["peers"];
  let wireIdentities: FederatedWireIdentity[];
  if (resolved.emptyRoster && network.peers.length > 0) {
    preservedHandpins = true;
    desiredPeers = network.peers.map((p) => ({ ...p }));
    wireIdentities = network.peers.map(peerToWireIdentity);
  } else {
    desiredPeers = resolved.peers.map(rosterPeerToConfigPeer);
    wireIdentities = resolved.peers.map(rosterPeerToWireIdentity);
  }

  // P2 — derive `accept_subjects` = OWN ∪ peer subtrees over the FINAL peer set.
  const desiredAccept = deriveAcceptSubjects(self, wireIdentities);

  // Diff against the live values. An idempotent reconcile (roster unchanged) is a
  // no-op so we don't churn the policy object every interval.
  const peersChanged = !configPeersEqual(network.peers, desiredPeers);
  const acceptChanged = !stringArraysEqual(network.accept_subjects, desiredAccept);

  if (!peersChanged && !acceptChanged) {
    return {
      networkId: network.id,
      outcome: preservedHandpins ? "preserved-handpins" : "unchanged",
      usedCache: resolved.usedCache,
      detail: `roster reconcile: no change (${desiredPeers.length} peer(s))`,
    };
  }

  // === APPLY — mutate the live object IN PLACE ===============================
  // The gate's `federatedNetworksById` Map holds THIS object by reference; an
  // in-place array mutation is seen on the next inbound envelope with no NATS
  // re-bind (the presence firehose already covers every peer). We mutate the
  // arrays' CONTENTS (splice) rather than reassign, so even a caller that
  // captured `network.accept_subjects` directly observes the change.
  replaceArrayContents(network.peers, desiredPeers);
  replaceArrayContents(network.accept_subjects, desiredAccept);

  return {
    networkId: network.id,
    outcome: preservedHandpins ? "preserved-handpins" : "applied",
    usedCache: resolved.usedCache,
    detail:
      `roster reconcile: applied ${desiredPeers.length} peer(s), ` +
      `accept ${desiredAccept.join(", ")}` +
      (resolved.usedCache ? " (from DD-10 cache — registry unreachable)" : "") +
      (preservedHandpins ? " (preserved hand-pins — empty roster)" : ""),
  };
}

// =============================================================================
// reconcileOnce — one pass over all opted-in networks
// =============================================================================

/** Options for {@link reconcileOnce}. */
export interface ReconcileOnceOptions {
  /** The LIVE `policy.federated.networks[]` (mutated in place per opted-in net). */
  networks: PolicyFederatedNetwork[];
  /** The local stack's wire identity. */
  self: AcceptSubjectsSelf;
  /** cortex's OWN registry client (P1 slice — no signal). */
  client: NetworkRosterProvider;
  /** Optional per-network result sink (for logs / status). */
  onResult?: (result: ReconcileNetworkResult) => void;
}

/** A summary of one {@link reconcileOnce} pass. */
export interface ReconcileSummary {
  /** Networks whose live policy was mutated this pass. */
  applied: number;
  /** Networks whose desired policy already matched live. */
  unchanged: number;
  /** Networks that hit a roster-resolve negative (live policy left untouched). */
  errors: number;
}

/**
 * Run ONE reconcile pass over every OPTED-IN network (OQ1: `reconcile.enabled`).
 * A network with no `reconcile` block, or `enabled: false`, is SKIPPED entirely —
 * zero registry I/O, zero policy mutation (byte-identical to pre-P3 behaviour).
 *
 * Each network is reconciled independently and best-effort: one network's
 * roster-resolve negative never blocks the others (each `reconcileNetwork` call
 * is awaited in isolation; it never throws).
 */
export async function reconcileOnce(
  opts: ReconcileOnceOptions,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { applied: 0, unchanged: 0, errors: 0 };

  for (const network of opts.networks) {
    if (network.reconcile?.enabled !== true) continue; // OQ1 — opt-in only

    const result = await reconcileNetwork(network, opts.self, opts.client);
    opts.onResult?.(result);

    switch (result.outcome) {
      case "applied":
      case "preserved-handpins":
        summary.applied += 1;
        break;
      case "unchanged":
        summary.unchanged += 1;
        break;
      case "skipped-error":
        summary.errors += 1;
        break;
    }
  }

  return summary;
}

// =============================================================================
// startFederationReconciler — the scheduled self-poll loop
// =============================================================================

/** Options for {@link startFederationReconciler}. */
export interface StartFederationReconcilerOptions {
  /**
   * The LIVE `policy.federated.networks[]` (the SAME array the gate reads).
   * `undefined` ⇒ no federation declared ⇒ the reconciler is INERT (signal-
   * optional: a stack with no federation never starts a poller).
   */
  networks: PolicyFederatedNetwork[] | undefined;
  /** The local stack's wire identity. */
  self: AcceptSubjectsSelf;
  /** cortex's OWN registry client (P1 slice — no signal). */
  client: NetworkRosterProvider;
  /** Per-network result sink (for logs / status). */
  onResult?: (result: ReconcileNetworkResult) => void;
  /** Called with any error a pass throws (defaults to a stderr line). */
  onError?: (err: unknown) => void;
  /** Run a pass immediately on start (default true) so the first reconcile isn't a full interval away. */
  runOnStart?: boolean;
  /**
   * Injectable scheduler — returns a canceller. Defaults to
   * setInterval/clearInterval. Tests pass a fake to drive ticks deterministically.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Lifecycle handle for the federation reconciler loop. */
export interface FederationReconcilerHandle {
  /**
   * True when the loop is actually running (at least one network opted in AND
   * federation declared). False ⇒ inert (no schedule, no I/O).
   */
  active: boolean;
  /** Await the in-flight pass (if any). Test seam for deterministic ticks. */
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
 * Start the continuous federation roster reconciler (the OQ3 cortex-owned
 * self-poll). INERT — no schedule, no registry I/O — when federation is not
 * declared (`networks === undefined`) OR no network is opted in
 * (`reconcile.enabled`). When active, runs {@link reconcileOnce} every
 * `interval_ms` (the MINIMUM opted-in interval across networks, so a fast
 * network isn't starved by a slow one).
 *
 * Best-effort, mirroring every other capability-side boot feature + the cockpit
 * refresh loop: a pass that throws routes to `onError` and never escapes the
 * tick, so one bad reconcile can't kill the loop or perturb the serving stack.
 */
export function startFederationReconciler(
  opts: StartFederationReconcilerOptions,
): FederationReconcilerHandle {
  const networks = opts.networks ?? [];
  const optedIn = networks.filter((n) => n.reconcile?.enabled === true);

  // INERT when nothing to reconcile — no schedule armed, no client touched.
  if (optedIn.length === 0) {
    return {
      active: false,
      settle: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  }

  const schedule = opts.schedule ?? defaultSchedule;
  const onError =
    opts.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[federation-reconciler] reconcile pass failed: ${err instanceof Error ? err.message : String(err)}\n`,
      ));

  // Loop cadence = the MINIMUM opted-in interval, floored at the schema min. A
  // fast network must not be starved by a slow one sharing the loop.
  const intervalMs = Math.max(
    MIN_RECONCILE_INTERVAL_MS,
    Math.min(
      ...optedIn.map(
        (n) => n.reconcile?.interval_ms ?? DEFAULT_RECONCILE_INTERVAL_MS,
      ),
    ),
  );

  // The in-flight pass, tracked so settle()/stop() can join it.
  let inFlight: Promise<void> | null = null;

  const tick = (): void => {
    // Each pass is self-isolating: a synchronous throw (e.g. a client that
    // throws inside fetchAndCache) OR a rejection routes to onError, never
    // escaping the tick. The isolated promise is tracked + cleared on settle.
    const pass = Promise.resolve()
      .then(() =>
        reconcileOnce({
          networks,
          self: opts.self,
          client: opts.client,
          ...(opts.onResult !== undefined && { onResult: opts.onResult }),
        }),
      )
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

  if (opts.runOnStart !== false) tick();
  const cancel = schedule(tick, intervalMs);

  let stopped = false;
  return {
    active: true,
    settle: async (): Promise<void> => {
      if (inFlight) await inFlight;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      cancel();
      if (inFlight) await inFlight;
    },
  };
}

// =============================================================================
// Internal projections + array helpers
// =============================================================================

/** Project a P1 {@link RosterPeer} → the config-peer shape written to `peers[]`. */
function rosterPeerToConfigPeer(
  peer: RosterPeer,
): PolicyFederatedNetwork["peers"][number] {
  return {
    principal_id: peer.principal_id,
    stack_id: peer.stack_id,
    ...(peer.principal_pubkey !== undefined && {
      principal_pubkey: peer.principal_pubkey,
    }),
  };
}

/**
 * Project a P1 {@link RosterPeer} → the `{principal, stack}` wire view
 * {@link deriveAcceptSubjects} consumes. The `RosterPeer` already carries the
 * wire-segment view, so this is a direct read.
 */
function rosterPeerToWireIdentity(peer: RosterPeer): FederatedWireIdentity {
  return { principal: peer.principal, stack: peer.stack };
}

/**
 * Project a written config peer → the `{principal, stack}` wire view (for the
 * #762 hand-pin-preservation path, where the peers come from the live policy,
 * not a fresh roster). The `stack` segment is the part AFTER the `/` in
 * `stack_id` (`{principal}/{stack}`); a malformed id with no usable slash falls
 * back to `default` (mirrors `roster-read`'s `stackSlugOf` and the CLI's
 * `peerToWireIdentity`, so the accept-list segment matches the peer view).
 */
function peerToWireIdentity(
  peer: PolicyFederatedNetwork["peers"][number],
): FederatedWireIdentity {
  const slash = peer.stack_id.indexOf("/");
  const stack =
    slash >= 0 && slash < peer.stack_id.length - 1
      ? peer.stack_id.slice(slash + 1)
      : "default";
  return { principal: peer.principal_id, stack };
}

/** Order-sensitive string-array equality (accept-lists have a stable order). */
function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Config-peer equality keyed on the fields the gate + accept-list derivation
 * read (`principal_id`, `stack_id`, `principal_pubkey`). Order-sensitive
 * (registry roster order is stable; the projection preserves it).
 */
function configPeersEqual(
  a: readonly PolicyFederatedNetwork["peers"][number][],
  b: readonly PolicyFederatedNetwork["peers"][number][],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x?.principal_id !== y?.principal_id ||
      x?.stack_id !== y?.stack_id ||
      x?.principal_pubkey !== y?.principal_pubkey
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Replace an array's CONTENTS in place (splice-all + push) rather than
 * reassigning the binding — so a holder that captured the array reference (e.g.
 * the gate reading `network.accept_subjects` directly) observes the new values.
 */
function replaceArrayContents<T>(target: T[], next: readonly T[]): void {
  target.length = 0;
  target.push(...next);
}
