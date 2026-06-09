/**
 * S4 (Network Join Control Plane, epic #733 · spec
 * `docs/design-network-join-control-plane.md` §6 F2 "wiring") — the boot-path
 * seam that invokes the S2 {@link resolveFederatedPeers} resolver during
 * `startCortex` config-load and rewrites `policy.federated.networks[]` in place
 * so EVERY downstream consumer (the runtime LinkPool, the surface-router /
 * dispatch-listener membership gates, the review-consumer subjects, the public
 * index) reads the registry-resolved `peers[]` rather than the raw static
 * config.
 *
 * ## Why this exists (DD-5: no separate code path)
 *
 * Before S4, `resolveFederatedPeers` was shipped + unit-tested but never
 * invoked on the boot path (the `cortex-config.ts` "WIRING STATUS (S2)" note):
 * the membership gate keyed on `principal_id` from the STATIC `peers[]` only,
 * and a peer that declared just `principal_id` + `stack_id` (no
 * `principal_pubkey`) was admitted by the relaxed schema but never resolved nor
 * cross-checked. This module closes that gap by resolving at boot and feeding
 * the resolved networks into the SAME `policy.federated.networks[]` view every
 * gate already reads.
 *
 * ## What it ENFORCES (PR #818 review MAJOR-2 — scope honestly)
 *
 * The security property delivered here is the **fail-closed DROP**: a peer that
 * is unresolvable (DD-5 `unresolved`) or whose hand-pin disagrees with the
 * roster (DD-11 `pin_mismatch`) is REMOVED from `peers[]`, so the
 * `principal_id`-keyed membership gate then denies its federated traffic as
 * `unknown_network`. The filled-in `principal_pubkey` value is, today,
 * informational — the gate keys on `principal_id` and the crypto-verify path
 * resolves keys from the registry on-demand (`MultiPrincipalIdentityRegistry`),
 * NOT from this config field. Wiring the resolved key into the verify path is a
 * tracked follow-up (PR #818 body).
 *
 * ## What it does
 *
 *   1. **DD-5** — for each joined network, fetch the VERIFIED registry roster
 *      (pin+verify via the S1 {@link NetworkRegistryClient}) and fill each
 *      pubkey-less peer's `principal_pubkey` from roster membership.
 *   2. **DD-11** — a hand-pinned key that DISAGREES with the registry-resolved
 *      key fails that peer closed (dropped from `peers[]`), never merged. PR #818
 *      review MAJOR-1: this cross-check fires for FULLY hand-pinned networks too
 *      (the roster is fetched whenever a registry is configured), so a drifted /
 *      tampered pin is caught rather than admitted on the stale value.
 *   3. **DD-10** — registry-unreachable falls back to the cached roster + the
 *      static/hand-pinned peers, with a loud warning; federation stays up.
 *
 * Hand-pin support is preserved end-to-end (DD-5: hand-pin is the offline
 * fallback) — a hand-pin survives a total registry outage (DD-10), it is just
 * additionally cross-checked when the registry IS reachable.
 *
 * ## Boot-safety
 *
 * NEVER throws. A missing `policy.federated` (no federation declared) or a
 * missing `registry` sub-block (federation declared but no registry to resolve
 * against — fully hand-pinned deployments) is a no-op: the policy is returned
 * unchanged and no registry client is constructed. Every fail-closed drop and
 * every degraded-mode fallback is surfaced via the `warn` sink (defaults to
 * `process.stderr`, per CLAUDE.md "no empty catches"); the caller additionally
 * logs an aggregate so a silent peer-drop can't hide.
 */

import { NetworkRegistryClient } from "./network-client";
import {
  resolveFederatedPeers,
  type FederatedPeerResolveError,
  type NetworkRosterProvider,
} from "./resolve-federated-peers";
import type {
  Policy,
  PolicyFederatedRegistry,
} from "../types/cortex-config";

/** Options for {@link resolveBootFederatedPeers}. */
export interface ResolveBootFederatedPeersOptions {
  /**
   * Loud-warning sink (DD-10 fallback + DD-11 alert + every fail-closed drop +
   * the aggregate summary). Defaults to `process.stderr`. The boot path injects
   * a sink that also goes to the cortex console logs.
   */
  warn?: (message: string) => void;
  /**
   * Inject a roster provider instead of constructing a live
   * {@link NetworkRegistryClient} from `policy.federated.registry`. Tests pass a
   * fixture/stub provider so the boot wiring runs with NO network I/O and NO
   * `~/.config` cache touch. Production omits this and a real client is built.
   *
   * @internal — not part of the public API.
   */
  rosterProvider?: NetworkRosterProvider;
}

/** Result of the boot-path resolution. */
export interface ResolveBootFederatedPeersResult {
  /**
   * The input policy with `federated.networks[]` rewritten to the resolved set
   * (pubkeys filled, fail-closed peers dropped). When federation/registry is
   * absent, this is the input policy returned unchanged (referential identity
   * preserved for the no-op path). Networks are NEVER mutated in place.
   */
  policy: Policy | undefined;
  /** Typed fail-closed drops (DD-11 mismatch / DD-5 unresolved), for alerting. */
  errors: FederatedPeerResolveError[];
}

/**
 * Build the live S1 roster provider from the registry sub-block. Separated so
 * the construction (and its `cacheDir` default of `~/.config/cortex/...`) is
 * skipped entirely when a test injects a provider.
 */
function liveProvider(registry: PolicyFederatedRegistry): NetworkRosterProvider {
  return new NetworkRegistryClient({
    url: registry.url,
    ...(registry.pubkey !== undefined && { pubkey: registry.pubkey }),
  });
}

/**
 * Resolve `policy.federated.networks[].peers[]` from the registry roster at
 * boot (DD-5/DD-10/DD-11). NEVER throws.
 *
 * No-op (returns the policy unchanged) when:
 *   - `policy` is `undefined` (no `policy:` block), OR
 *   - `policy.federated` is absent (no federation declared), OR
 *   - `policy.federated.networks` is empty, OR
 *   - `policy.federated.registry` is absent AND no `rosterProvider` is injected
 *     (federation declared but no registry to resolve against — a fully
 *     hand-pinned deployment; the resolver would make zero calls anyway).
 *
 * @param policy   the loaded `policy:` block (or `undefined`)
 * @param options  warn sink + optional injected roster provider (tests)
 */
export async function resolveBootFederatedPeers(
  policy: Policy | undefined,
  options: ResolveBootFederatedPeersOptions = {},
): Promise<ResolveBootFederatedPeersResult> {
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`cortex federated-peer boot resolve: ${message}\n`);
    });

  const federated = policy?.federated;
  if (
    policy === undefined ||
    federated === undefined ||
    federated.networks.length === 0
  ) {
    // No federation to resolve — pass through untouched.
    return { policy, errors: [] };
  }

  // Pick the roster provider: an injected one (tests) or a live client built
  // from the registry sub-block. With NEITHER, every network is necessarily
  // fully hand-pinned (there is no registry to resolve a pubkey-less peer
  // against) — so resolution is a no-op and we skip building a client. A
  // network that left a peer pubkey-less WITHOUT declaring a registry is a
  // config error caught by the resolver's fail-closed `unresolved` drop the
  // moment a registry IS configured; with no registry we cannot reach the
  // roster at all, so we leave the static peers as-is and warn.
  const provider =
    options.rosterProvider ??
    (federated.registry !== undefined
      ? liveProvider(federated.registry)
      : undefined);

  if (provider === undefined) {
    const hasPubkeylessPeer = federated.networks.some((n) =>
      n.peers.some((p) => p.principal_pubkey === undefined),
    );
    if (hasPubkeylessPeer) {
      warn(
        "policy.federated declares a pubkey-less peer but no " +
          "policy.federated.registry — cannot registry-resolve it. Such peers " +
          "stay in config but carry no key; add a registry block (DD-5) or " +
          "hand-pin the peer's principal_pubkey.",
      );
    }
    return { policy, errors: [] };
  }

  const resolved = await resolveFederatedPeers(federated.networks, provider, {
    warn,
  });

  if (resolved.errors.length > 0) {
    // Aggregate summary so a silent peer-drop can't hide in per-peer warns.
    const summary = resolved.errors
      .map((e) => `${e.networkId}/${e.principalId} (${e.kind})`)
      .join(", ");
    warn(
      `${resolved.errors.length.toString()} federated peer(s) failed closed at ` +
        `boot and were dropped from the membership gate: ${summary}. ` +
        `Federation continues for the peers that DID resolve.`,
    );
  }

  // Rewrite the policy's federated networks with the resolved set. NEW objects
  // throughout (resolveFederatedPeers never mutates its input); the rest of the
  // policy is carried by reference. This is the single field every downstream
  // consumer (runtime LinkPool, surface-router + dispatch-listener gates,
  // review subjects, public index) reads — DD-5: no separate code path.
  const nextPolicy: Policy = {
    ...policy,
    federated: {
      ...federated,
      networks: resolved.networks,
    },
  };

  return { policy: nextPolicy, errors: resolved.errors };
}
