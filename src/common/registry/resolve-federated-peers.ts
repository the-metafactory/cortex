/**
 * S2 (Network Join Control Plane, #736 · epic #733 · spec
 * `docs/design-network-join-control-plane.md` §6 F2) — config-load
 * federated-peer resolver.
 *
 * This is the F2 seam: it sits between config parse and the surface-router /
 * crypto-verify federation gate, and fills in each `policy.federated.
 * networks[].peers[].principal_pubkey` that the principal did NOT hand-pin —
 * resolving it from the registry-signed roster (DD-5).
 *
 * ## What this seam actually ENFORCES (PR #818 review MAJOR-2 — scope honestly)
 *
 * The load-bearing enforcement this seam delivers is the **fail-closed DROP** of
 * a peer that cannot be trusted: a registry-only peer whose key is unresolvable
 * (DD-5 `unresolved`) or a hand-pin that disagrees with the roster (DD-11
 * `pin_mismatch`) is REMOVED from `peers[]`, so the `principal_id`-keyed
 * membership gate (`evaluateFederationGate` / `resolveSourceNetwork`) then denies
 * its traffic as `unknown_network`. THAT is the security property.
 *
 * The filled-in `principal_pubkey` value itself is, today, **informational and
 * NOT yet consumed by the admission gate**: the surface-router gate + the runtime
 * LinkPool key on `principal_id`, and the crypto-verify path resolves peer
 * pubkeys from the registry on-demand (`MultiPrincipalIdentityRegistry`), not
 * from this config field. Wiring the pinned/resolved key into the verify path so
 * the config surface becomes the trust anchor is a tracked follow-up — see the
 * PR #818 body. Until then, "no separate downstream code path" means the DROP
 * flows through the SAME `principal_id` gate a hand-pin's absence would; it does
 * NOT mean the resolved key is read for admission.
 *
 * ## The three design decisions this implements
 *
 *   - **DD-5 (registry-resolved peers; hand-pin is the fallback only).** A peer
 *     may declare just `principal_id` + `stack_id` and omit `principal_pubkey`
 *     (the schema makes it optional at S2). For such a peer we resolve the
 *     pubkey from the verified roster (`NetworkRegistryClient.fetchAndCache` →
 *     `getNetworkRoster`, S1's DD-9 pin+verify) and re-encode the roster's
 *     base64 key to nkey-U (`base64PubkeyToNkey`, DD-8) so it matches the
 *     config surface.
 *
 *   - **DD-10 (registry-down → cached roster + warn).** When the live fetch is
 *     `unreachable` (transport failure / no pin), we fall back to S1's
 *     last-known-good disk cache (`loadCached`) and emit a LOUD warning.
 *     Federation stays up on last-known-good. Hand-pinned peers never need the
 *     registry at all, so they always resolve offline. Only when BOTH the live
 *     fetch and the cache are empty for a registry-only peer do we refuse to
 *     admit it (we cannot fail open — see below).
 *
 *   - **DD-11 (resolved-vs-pinned mismatch → fail-closed).** When a peer carries
 *     BOTH a hand-pinned key AND a registry-resolved key that DIFFER, we refuse
 *     to load that peer (drop it from the gate) and emit an alert. A divergence
 *     is a drift/attack signal, not a merge — it catches both a stale local
 *     pin and a tampered/compromised registry. A MATCHING pin is honored
 *     (the resolved value is identical, so the peer is kept as-is, no-op).
 *
 * ## Fail-closed posture
 *
 * The gate must NEVER admit a peer with no key — a keyless peer would either
 * crash the downstream nkey→base64 bridge or, worse, be silently skipped while
 * its `principal_id` still grants `peers[]` membership in the gate. So a peer
 * we cannot resolve a key for (registry-only, unresolvable AND uncached; or a
 * roster that omits the peer / serves a malformed key) is DROPPED from the
 * returned network and recorded as a typed {@link FederatedPeerResolveError}.
 * The caller surfaces these as `system.error` alerts; federation continues for
 * the peers that DID resolve.
 *
 * ## Failure handling (CLAUDE.md: NEVER empty catch)
 *
 * `resolveFederatedPeers` NEVER throws — a registry problem must not crash
 * cortex boot. Every degraded path either falls back (DD-10), drops the peer
 * with a typed error (fail-closed), or both, and every drop emits a `warn`.
 */

import { base64PubkeyToNkey } from "./encoding";
import type { NetworkRegistryClient, NetworkFetchResult } from "./network-client";
import type { NetworkRosterResult } from "./types";

// Compile-time assertion that the concrete S1 client structurally satisfies the
// minimal provider interface this resolver depends on. If the client's
// `fetchAndCache` / `loadCached` signatures ever drift away from what the
// resolver needs, this line fails `tsc` at the boundary rather than at a
// call-site in cortex.ts boot. Also pins the `NetworkRegistryClient` import so
// the doc-references below are not "unused".
type _ClientSatisfiesProvider =
  NetworkRegistryClient extends NetworkRosterProvider ? true : never;
import type {
  PolicyFederatedNetwork,
  PolicyFederatedPeer,
} from "../types/cortex-config";

/**
 * The minimal slice of {@link NetworkRegistryClient} this resolver needs.
 * Declared as an interface (not the concrete class) so the resolver is unit-
 * testable with a stub double and stays decoupled from the client's transport
 * + TOFU lifecycle. The concrete `NetworkRegistryClient` satisfies it
 * structurally.
 */
export interface NetworkRosterProvider {
  /**
   * Fetch + verify the network's descriptor + roster (DD-9) and, on success,
   * refresh the disk cache (DD-10). We only read `.roster` here; the descriptor
   * half is the S3/S4 leaf-renderer's concern. The full {@link NetworkRegistryClient}
   * returns the descriptor too, so its return type is assignable here.
   */
  fetchAndCache(
    networkId: string,
  ): Promise<NetworkFetchResult<{ roster: NetworkRosterResult }>>;
  /** Last-known-good cached roster for the DD-10 fallback, or `undefined`. */
  loadCached(
    networkId: string,
  ): { roster: NetworkRosterResult } | undefined;
}

/**
 * A peer the resolver refused to admit, for caller-side alerting. Each maps to
 * a fail-closed drop:
 *
 *   - `pin_mismatch` — the hand-pinned key and the registry-resolved key differ
 *     (DD-11): a drift/attack signal.
 *   - `unresolved`   — a registry-only peer whose key could not be obtained
 *     from the live roster OR the cache (peer absent from roster, malformed
 *     roster key, or registry unreachable AND uncached). The gate cannot admit
 *     a peer with no key (no fail-open).
 */
export interface FederatedPeerResolveError {
  kind: "pin_mismatch" | "unresolved";
  networkId: string;
  principalId: string;
  /** Human-readable detail, suitable for a `system.error` body. */
  detail: string;
}

/** Result of resolving every network's peers. */
export interface ResolveFederatedPeersResult {
  /**
   * The input networks with each admitted peer's `principal_pubkey` populated
   * (hand-pinned values left as-is; registry-resolved values filled in as
   * nkey-U). Peers that failed fail-closed are DROPPED from `peers[]`. Network
   * order + identity are preserved; only `peers[]` is rewritten.
   */
  networks: PolicyFederatedNetwork[];
  /** Typed fail-closed drops, for caller-side alerting (`system.error`). */
  errors: FederatedPeerResolveError[];
}

/** Construction options. */
export interface ResolveFederatedPeersOptions {
  /**
   * Loud-warning sink (DD-10 fallback + DD-11 alert + every fail-closed drop).
   * Defaults to `process.stderr` per CLAUDE.md "no empty catches". The cortex
   * boot path injects a sink that also emits a `system.error` envelope.
   */
  warn?: (message: string) => void;
}

/**
 * Resolve every federated network's peers (DD-5/DD-10/DD-11). Pure over the
 * input networks (returns new objects; never mutates the caller's array).
 * NEVER throws.
 *
 * Resolution is per-network: a network's roster is fetched at most once
 * (`fetchAndCache`) whenever the network has ANY peer — a pubkey-less peer to
 * resolve (DD-5) OR a hand-pinned peer to cross-check (DD-11). PR #818 review
 * MAJOR-1: a fully hand-pinned network is NO LONGER a zero-call fast path — when
 * a registry is configured (this resolver is only invoked with a `client` then),
 * its hand-pins are cross-checked against the verified roster so a drifted /
 * tampered key is caught (DD-11). Only an EMPTY-peers network makes zero calls.
 * Hand-pins still survive a registry outage (DD-10: down → cached → admit-as-is).
 *
 * @param networks  the parsed `policy.federated.networks[]`
 * @param client    the S1 {@link NetworkRegistryClient} (or a structural stub)
 * @param options   warning sink (see {@link ResolveFederatedPeersOptions})
 */
export async function resolveFederatedPeers(
  networks: readonly PolicyFederatedNetwork[],
  client: NetworkRosterProvider,
  options: ResolveFederatedPeersOptions = {},
): Promise<ResolveFederatedPeersResult> {
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`resolve-federated-peers: ${message}\n`);
    });

  const errors: FederatedPeerResolveError[] = [];
  const outNetworks: PolicyFederatedNetwork[] = [];

  for (const network of networks) {
    // PR #818 review MAJOR-1 fix — fetch the roster for EVERY non-empty network,
    // not only when a peer is pubkey-less. The resolver is only ever handed a
    // `client` when a registry is configured (the boot seam constructs/injects
    // one only then), so a network with ANY peer — hand-pinned or pubkey-less —
    // must be cross-checked against the verified roster.
    //
    // Why this matters (the DD-11 fast-path gap the old `needsRegistry` left
    // open): a FULLY hand-pinned network used to make ZERO registry calls, so a
    // hand-pin that had drifted from a rotated/tampered roster key was admitted
    // on the STALE pin and DD-11 never fired — contradicting the spec's
    // unconditional "when both a hand-pin AND a registry-resolved key exist they
    // MUST agree," and silently defeating exactly the stale/compromised-pin case
    // DD-11 exists to catch. Now the pin↔roster cross-check fires for
    // hand-pinned-only networks too.
    //
    // The extra fetch is safe and does NOT break "hand-pins always resolve
    // offline" (DD-5): a roster fetch that returns `unreachable` falls back to
    // the cached roster (DD-10); a fetch that yields no roster at all (down +
    // uncached, or a definitive negative) leaves `roster === undefined`, and
    // `resolvePeer` admits a hand-pinned peer as-is when it has no registry value
    // to cross-check against. So a hand-pinned-only deployment still stays up
    // across a total registry outage — it just gains the DD-11 guard whenever the
    // registry IS reachable (or cached).
    if (network.peers.length === 0) {
      // No peers ⇒ nothing to resolve or cross-check; pass through unchanged.
      outNetworks.push(network);
      continue;
    }

    // Resolve the roster once for this network: live fetch first (refreshes the
    // DD-10 cache on success), cached fallback on `unreachable`.
    const roster = await resolveRoster(network.id, client, warn);

    const outPeers: PolicyFederatedPeer[] = [];
    for (const peer of network.peers) {
      const outcome = resolvePeer(network.id, peer, roster, warn);
      if (outcome.kind === "admit") {
        outPeers.push(outcome.peer);
      } else {
        errors.push(outcome.error);
      }
    }

    outNetworks.push({ ...network, peers: outPeers });
  }

  return { networks: outNetworks, errors };
}

// =============================================================================
// Private — roster resolution (live → cache fallback, DD-10)
// =============================================================================

/**
 * Resolve a network's roster: live fetch first; on `unreachable`, fall back to
 * the last-known-good cache with a loud warning (DD-10). Returns the roster's
 * members, or `undefined` when neither the live fetch nor the cache yields one
 * (every dependent peer then fails closed).
 */
async function resolveRoster(
  networkId: string,
  client: NetworkRosterProvider,
  warn: (message: string) => void,
): Promise<NetworkRosterResult | undefined> {
  const live = await client.fetchAndCache(networkId);
  if (live.status === "ok") {
    return live.value.roster;
  }

  if (live.status === "unreachable") {
    // DD-10 — registry down. Use last-known-good; federation stays up.
    const cached = client.loadCached(networkId);
    if (cached !== undefined) {
      warn(
        `network "${networkId}": registry unreachable (${live.reason}) — ` +
          `falling back to last-known-good cached roster. Federation stays up; ` +
          `peer pubkeys may be stale until the registry is reachable again.`,
      );
      return cached.roster;
    }
    warn(
      `network "${networkId}": registry unreachable (${live.reason}) and no ` +
        `cached roster available — registry-only peers in this network cannot ` +
        `be resolved and will be dropped (fail-closed).`,
    );
    return undefined;
  }

  // `not_found` / `unverified` — a definitive negative, NOT a transient outage,
  // so the DD-10 cache fallback does not apply (we will not paper a rejected /
  // missing network over with stale data). Registry-only peers fail closed.
  warn(
    `network "${networkId}": roster fetch returned "${live.status}"` +
      (live.status === "unverified" ? ` (${live.reason})` : "") +
      ` — registry-only peers in this network cannot be resolved and will be ` +
      `dropped (fail-closed).`,
  );
  return undefined;
}

// =============================================================================
// Private — per-peer resolution (DD-5 fill + DD-11 cross-check, fail-closed)
// =============================================================================

type PeerOutcome =
  | { kind: "admit"; peer: PolicyFederatedPeer }
  | { kind: "drop"; error: FederatedPeerResolveError };

/**
 * Resolve a single peer against the network roster.
 *
 *   - Hand-pinned peer (`principal_pubkey` set):
 *       - roster has a (valid) key for it AND it MATCHES → admit (no-op, DD-11
 *         honors a matching pin).
 *       - roster has a (valid) key for it AND it DIFFERS → DROP + alert (DD-11
 *         mismatch fail-closed).
 *       - roster missing / unavailable → admit as-is (hand-pin is the offline
 *         fallback; we cannot cross-check, but a hand-pin is trusted on its
 *         own per DD-5). This keeps a hand-pinned network up across a registry
 *         outage.
 *   - Registry-only peer (`principal_pubkey` unset):
 *       - roster yields a valid key → admit with the resolved nkey-U (DD-5).
 *       - otherwise → DROP + typed `unresolved` error (no fail-open).
 */
function resolvePeer(
  networkId: string,
  peer: PolicyFederatedPeer,
  roster: NetworkRosterResult | undefined,
  warn: (message: string) => void,
): PeerOutcome {
  const resolvedNkey = lookupResolvedNkey(peer.principal_id, roster);

  if (peer.principal_pubkey !== undefined) {
    // Hand-pinned peer.
    if (resolvedNkey === undefined) {
      // No registry value to cross-check against — trust the hand-pin (the
      // offline fallback). Admit unchanged.
      return { kind: "admit", peer };
    }
    if (resolvedNkey === peer.principal_pubkey) {
      // DD-11 — matching pin honored (no-op).
      return { kind: "admit", peer };
    }
    // DD-11 — drift/attack signal. Fail-closed: drop + alert.
    const detail =
      `peer "${peer.principal_id}" in network "${networkId}" has a hand-pinned ` +
      `pubkey that DIFFERS from the registry-resolved key — refusing to load ` +
      `this peer (fail-closed). A mismatch is a drift/attack signal, not a ` +
      `merge: either the local pin is stale or the registry was tampered with. ` +
      `Resolve by re-running the join, or remove the stale pin once verified.`;
    warn(detail);
    return {
      kind: "drop",
      error: { kind: "pin_mismatch", networkId, principalId: peer.principal_id, detail },
    };
  }

  // Registry-only peer (DD-5). Must resolve a key or fail closed.
  if (resolvedNkey === undefined) {
    const detail =
      `peer "${peer.principal_id}" in network "${networkId}" declares no ` +
      `pubkey and could not be resolved from the registry roster (unreachable ` +
      `+ uncached, absent from the roster, or a malformed roster key) — ` +
      `dropping the peer (fail-closed). The gate must not admit a peer with no key.`;
    warn(detail);
    return {
      kind: "drop",
      error: { kind: "unresolved", networkId, principalId: peer.principal_id, detail },
    };
  }
  // Fill in the resolved key in the config's nkey-U surface (DD-5/DD-8).
  return {
    kind: "admit",
    peer: { ...peer, principal_pubkey: resolvedNkey },
  };
}

/**
 * Look up a principal in the roster and return its pubkey re-encoded to nkey-U
 * (the config surface, DD-8). Returns `undefined` if the roster is absent, the
 * principal is not in it, or the roster key does not re-encode (malformed) —
 * every one of which is a fail-closed condition for a registry-only peer.
 */
function lookupResolvedNkey(
  principalId: string,
  roster: NetworkRosterResult | undefined,
): string | undefined {
  if (roster === undefined) return undefined;
  const member = roster.members.find((m) => m.principal_id === principalId);
  if (member === undefined) return undefined;
  // The roster carries base64 raw ed25519 (already grammar-gated by S1's
  // parseRoster); translate to nkey-U so it matches the config/peers surface
  // and the downstream nkey→base64 verify bridge. A value that fails to
  // re-encode (defensive — S1 already validated the grammar) yields undefined
  // and the caller fails the peer closed.
  return base64PubkeyToNkey(member.principal_pubkey);
}
