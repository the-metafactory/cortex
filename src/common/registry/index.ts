/**
 * Cortex-side network-registry consumers.
 *
 * Public surface for the rest of cortex. Two consumers live here:
 *
 *   - `RegistryClient` (Phase D.4.3) — boot-time, fixed-peer-list polling
 *     cache; consume the reader interface unless wiring lifecycle
 *     (cortex.ts boot/shutdown only).
 *   - `PrincipalPubkeyResolver` (TC-2a, cortex#633) — on-demand,
 *     posture-gated peer-pubkey resolver for the federation crypto-verify
 *     chain (TC-2b/TC-2d). Default-OFF; inert unless `signing: enforce`.
 *   - `MultiPrincipalIdentityRegistry` (TC-2b, cortex#634) — multi-principal,
 *     peer-stamped registry: a pinned local boot principal plus peers
 *     resolved on demand via the TC-2a resolver. Materialises the myelin
 *     `IdentityRegistry` the `federated.*` crypto-verify path (TC-2d) reads.
 *   - `NetworkRegistryClient` (S1, cortex#735) — typed network descriptor +
 *     roster client (DD-9 pin+verify, DD-10 disk cache, DD-12 descriptor).
 *   - `resolveFederatedPeers` (S2, cortex#736) — config-load resolver that
 *     fills each `policy.federated.networks[].peers[].principal_pubkey` from
 *     the verified roster (DD-5), falls back to the cached roster when the
 *     registry is unreachable (DD-10), and fails a peer closed when a
 *     hand-pinned key and the resolved key disagree (DD-11).
 */

export { RegistryClient } from "./client";
export {
  PrincipalPubkeyResolver,
  resolvePrincipalPubkey,
} from "./resolve-pubkey";
export { NetworkRegistryClient } from "./network-client";
export type {
  NetworkFetchResult,
  NetworkRegistryClientOptions,
} from "./network-client";
export { NetworkCache } from "./network-cache";
export type { CachedNetwork, NetworkCacheOptions } from "./network-cache";
export { base64PubkeyToNkey, nkeyToBase64Pubkey } from "./encoding";
export { verifySignedAssertion } from "./verify-assertion";
export type { VerifyAssertionResult } from "./verify-assertion";
export { resolveFederatedPeers } from "./resolve-federated-peers";
export type {
  FederatedPeerResolveError,
  NetworkRosterProvider,
  ResolveFederatedPeersOptions,
  ResolveFederatedPeersResult,
} from "./resolve-federated-peers";
export { resolveBootFederatedPeers } from "./resolve-federated-peers-boot";
export type {
  ResolveBootFederatedPeersOptions,
  ResolveBootFederatedPeersResult,
} from "./resolve-federated-peers-boot";
export type {
  PrincipalPubkeyResolverOptions,
  ResolveResult,
} from "./resolve-pubkey";
export { MultiPrincipalIdentityRegistry } from "./identity-registry";
export type {
  EntryProvenance,
  FederatedPeerResolution,
  MultiPrincipalIdentityRegistryOptions,
  PrincipalEntry,
  RegistryResolveOutcome,
} from "./identity-registry";
export type {
  Capability,
  NetworkDescriptor,
  NetworkRosterPeer,
  NetworkRosterResult,
  PrincipalRecord,
  RegistryClientOptions,
  RegistryClientReader,
  RegistryPubkeyResponse,
  SignedAssertion,
  StackIdentity,
} from "./types";
