/**
 * P1 (cortex#1086, design-roster-driven-federation-wiring §7) — the
 * **runtime-callable** registry-roster read.
 *
 * Lifts cortex's roster resolution out of the `network` CLI
 * (`src/cli/cortex/commands/network-lib.ts` `joinNetwork`'s step (b) +
 * `buildPeers`) into a reusable function the federation roster reconciler (P3,
 * #1088) can call WITHOUT going through a CLI command. The question it answers
 * is exactly the umbrella's (#1084): *"who is on network X?"* — resolved from
 * the registry, the authority for membership (ADR-0003; design §6).
 *
 * ## Reuse, do not rebuild (design §3)
 *
 * The verified fetch + DD-10 disk cache already live in
 * `src/common/registry/` and are abstracted by the existing
 * {@link NetworkRosterProvider} interface (the minimal `{fetchAndCache,
 * loadCached}` slice of `NetworkRegistryClient`, already exported + structurally
 * satisfied by the concrete client — reused here rather than re-declared):
 *
 *   - `fetchAndCache` — `GET /networks/{id}` + `/roster`, pin+verify (DD-9),
 *     cache the pair on success (DD-10).
 *   - `loadCached` — last-known-good pair when the registry is unreachable
 *     (DD-10 fallback).
 *
 * This module is the small piece the CLI kept private: the
 * `fetchAndCache → unreachable → loadCached` orchestration plus the
 * roster-members → peers projection (which excludes the local principal — a
 * stack is never in its own peers[]) and the #762 "0 resolved peers" signal so
 * a caller can preserve hand-pins rather than wipe them.
 *
 * ## Signal-optional (design §4, hard constraint)
 *
 * This module reads the registry **directly** via cortex's own registry client
 * (the {@link NetworkRosterProvider} slice). It has **zero** dependency on the `signal`
 * package — signal independently reads the same registry behind its own
 * `RegistryIntentSource` seam (shared *registry*, not shared *package*; the
 * dependency direction is cortex→registry and signal→registry, never
 * cortex→signal). Do NOT add a signal import here.
 *
 * ## Trust boundary
 *
 * `fetchAndCache`/`loadCached` only ever return DD-9-verified payloads (a bad
 * signature / shape is a definitive negative, never cached). This module
 * therefore never sees an unverified roster; it does not re-implement
 * verification. It also does not write any federation policy or accept-list —
 * deriving `accept_subjects` is P2 (#1087), applying it is P3 (#1088). This is
 * a READ.
 */

import type { NetworkFetchResult } from "../../common/registry/network-client";
import type { NetworkRosterProvider } from "../../common/registry/resolve-federated-peers";
import type { NetworkRosterResult } from "../../common/registry/types";
import { base64PubkeyToNkey } from "../../common/registry/encoding";

// =============================================================================
// Result shapes
// =============================================================================

/**
 * One peer on a network's roster, in the runtime caller's shape.
 *
 * Carries BOTH the wire-segment view the reconciler needs
 * (`principal` / `stack` build `federated.{principal}.{stack}.>` — design §5
 * step 2) AND the config-peer view the CLI writes
 * (`principal_id` / `stack_id` / optional nkey `principal_pubkey` →
 * `PolicyFederatedPeer`), so a single resolve serves both consumers losslessly.
 */
export interface RosterPeer {
  /** Peer principal id — the `{principal}` wire segment. Same as `principal_id`. */
  principal: string;
  /**
   * Peer stack slug — the `{stack}` wire segment (the part AFTER the `/` in
   * `stack_id`). Defaults to `default` when the roster omits the stack id.
   */
  stack: string;
  /** Peer principal id — the `PolicyFederatedPeer.principal_id` field. */
  principal_id: string;
  /**
   * Peer stack id in `{principal_id}/{stack_slug}` form — the
   * `PolicyFederatedPeer.stack_id` field. Falls back to
   * `{principal_id}/default` when the roster omits it (mirrors the CLI's
   * `buildPeers`).
   */
  stack_id: string;
  /**
   * Peer principal's NKey-U public key, re-encoded from the roster's base64
   * Ed25519 key (DD-8). LEFT OFF when the roster key is not re-encodable, so
   * the config-load resolver (S2) fills it from the registry (DD-5: declare by
   * id). Mirrors the CLI's `buildPeers` exactly.
   */
  principal_pubkey?: string;
}

/**
 * The outcome of {@link resolveNetworkRoster}. Never throws — every failure is
 * a discriminated `ok: false` so a long-running reconciler (P3) can branch
 * without a try/catch and keep ticking across a transient registry outage.
 */
export type ResolveNetworkRosterResult =
  | {
      ok: true;
      /** The peers on the network, local principal excluded. */
      peers: RosterPeer[];
      /**
       * True when the roster came from the DD-10 last-known-good disk cache
       * because the registry was unreachable (the live fetch failed). The
       * peers are still trustworthy (cached only after DD-9 verification); the
       * flag lets a caller surface "stale" in its status/UI.
       */
      usedCache: boolean;
      /**
       * #762 guard signal — true when the registry roster resolved ZERO peers.
       * The registry roster is populated implicitly (a principal is "in" a
       * network only if one of its announced capabilities lists that network),
       * so an empty roster is the COMMON early state, NOT an error. A caller
       * that already has hand-pinned peers should PRESERVE them rather than
       * overwrite with `[]` (the CLI join does exactly this). When this is
       * true, `peers` is `[]`.
       */
      emptyRoster: boolean;
    }
  | {
      ok: false;
      /** Discriminated reason — mirrors the {@link NetworkFetchResult} negatives. */
      reason:
        | "not_found"
        | "unverified"
        | "unreachable_uncached";
      /** Human-readable detail for logs / status. */
      detail: string;
    };

// =============================================================================
// resolveNetworkRoster
// =============================================================================

/**
 * Resolve "who is on `networkId`" from the registry, runtime-callable.
 *
 * Drives the same DD-9/DD-10 path the CLI join does:
 *   1. `client.fetchAndCache` — verified live fetch (refreshes the DD-10 cache
 *      on success).
 *   2. On `unreachable`, fall back to `client.loadCached` (DD-10). No cached
 *      pair ⇒ `unreachable_uncached`.
 *   3. `not_found` / `unverified` ⇒ a definitive negative (do NOT render a
 *      roster we couldn't verify).
 *
 * On success projects the verified roster members → {@link RosterPeer}[],
 * excluding `localPrincipalId` (a stack is never in its own peers[]), and
 * flags an `emptyRoster` so the caller can apply the #762 hand-pin guard.
 *
 * Pure over its injected client — no filesystem, network, or env access beyond
 * what the client encapsulates; trivially testable with a fake client.
 *
 * @param networkId        Network whose roster to resolve.
 * @param localPrincipalId The local principal — excluded from the peer set.
 * @param client           cortex's OWN registry client (the
 *                         {@link NetworkRosterProvider} slice — no signal; §4).
 */
export async function resolveNetworkRoster(
  networkId: string,
  localPrincipalId: string,
  client: NetworkRosterProvider,
): Promise<ResolveNetworkRosterResult> {
  let roster: NetworkRosterResult;
  let usedCache = false;

  const fetched: NetworkFetchResult<{ roster: NetworkRosterResult }> =
    await client.fetchAndCache(networkId);

  if (fetched.status === "ok") {
    roster = fetched.value.roster;
  } else if (fetched.status === "unreachable") {
    // DD-10 — registry down → fall back to the last-known-good cached roster
    // so the reconciler keeps resolving peers across a transient outage. The
    // cache is written only after DD-9 verification, so the pair is trusted.
    const cached = client.loadCached(networkId);
    if (cached === undefined) {
      return {
        ok: false,
        reason: "unreachable_uncached",
        detail:
          `registry unreachable (${fetched.reason}) and no cached descriptor ` +
          `for "${networkId}" — cannot resolve roster`,
      };
    }
    roster = cached.roster;
    usedCache = true;
  } else {
    // not_found / unverified — a definitive negative. Do NOT project a roster
    // we could not verify (a bad-signature roster never reaches here anyway;
    // fetchAndCache returns the negative without caching).
    return {
      ok: false,
      reason: fetched.status,
      detail:
        fetched.status === "unverified"
          ? `roster/descriptor failed verification (${fetched.reason}) for "${networkId}"`
          : `network "${networkId}" not found in registry`,
    };
  }

  const peers = buildRosterPeers(localPrincipalId, roster);
  return {
    ok: true,
    peers,
    usedCache,
    emptyRoster: peers.length === 0,
  };
}

// =============================================================================
// roster members → peers projection (lifted from network-lib.ts buildPeers)
// =============================================================================

/**
 * Project verified roster members → {@link RosterPeer}[] (DD-5). Excludes the
 * LOCAL principal (a stack is never in its own peers[]). Each peer carries the
 * wire-segment view (`principal`/`stack`) and the config view
 * (`principal_id`/`stack_id`/optional nkey `principal_pubkey`).
 *
 * `principal_pubkey` is filled from the roster's base64 key, re-encoded to
 * nkey-U (DD-8), ONLY when re-encodable — otherwise LEFT OFF so the S2
 * config-load resolver fills it (DD-5: declare by id). This mirrors the CLI's
 * private `buildPeers` exactly, so the lifted lib is behavior-preserving.
 *
 * Exported for direct unit testing of the projection in isolation.
 */
/**
 * Called for each roster member DROPPED from the peer projection because its
 * `stack_id` is absent or malformed. Default: a loud stderr warning. The
 * reconciler passes its own sink so the drop reaches the event pipeline.
 * cortex#1852 half B — fail loud, never fabricate `{principal}/default`.
 */
export type RosterPeerDropSink = (principalId: string, reason: string) => void;

const warnDroppedPeer: RosterPeerDropSink = (principalId, reason) => {
  process.stderr.write(
    `WARNING federation roster: dropping peer "${principalId}" — ${reason}. ` +
      "Its presence/dispatch will NOT be accepted until the registry roster carries a valid " +
      "{principal}/{stack} stack_id. (cortex#1852)\n",
  );
};

export function buildRosterPeers(
  localPrincipalId: string,
  roster: NetworkRosterResult,
  onDrop: RosterPeerDropSink = warnDroppedPeer,
): RosterPeer[] {
  const peers: RosterPeer[] = [];
  for (const member of roster.members) {
    if (member.principal_id === localPrincipalId) continue; // never self
    // cortex#1852 half B — NEVER fabricate `{principal}/default`. A missing or
    // malformed stack_id is a FAULT (registry roster projection gap / underivable
    // stack), not a default: drop the peer and warn loudly rather than derive a
    // wrong-but-plausible accept-subject that silently never matches. (Half A —
    // #1854 — makes the registry project stack_id, so this path is now rare.)
    const stackId = member.stack_id;
    if (stackId === undefined) {
      onDrop(member.principal_id, "roster carries no stack_id");
      continue;
    }
    const slash = stackId.indexOf("/");
    if (slash < 0 || slash >= stackId.length - 1) {
      onDrop(
        member.principal_id,
        `malformed stack_id "${stackId}" (expected {principal}/{stack})`,
      );
      continue;
    }
    const stackSlug = stackId.slice(slash + 1);
    const nkey = base64PubkeyToNkey(member.principal_pubkey);
    const peer: RosterPeer = {
      principal: member.principal_id,
      stack: stackSlug,
      principal_id: member.principal_id,
      stack_id: stackId,
      ...(nkey !== undefined && { principal_pubkey: nkey }),
    };
    peers.push(peer);
  }
  return peers;
}
