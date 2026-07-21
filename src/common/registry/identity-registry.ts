/**
 * TC-2b (Trust & Confidentiality, cortex#634) — multi-principal,
 * peer-stamped `IdentityRegistry`.
 *
 * ## What this is
 *
 * The federation crypto-verify chain (`docs/design-trust-confidentiality.md`
 * §"Phase 2-verify") needs to look up the **verified Ed25519 pubkey of ANY
 * peer principal** that signed an inbound `federated.{principal}.{stack}`
 * envelope — not just the local boot principal. Until TC-2b the verifier's
 * `buildIdentityRegistry` (`src/bus/verify-signed-by-chain.ts`) stamped
 * EVERY agent with the single boot `principalId`; cross-principal envelopes
 * were therefore unverifiable (the design's "single-principal boundary").
 *
 * `MultiPrincipalIdentityRegistry` lifts that boundary. It holds a MAP of
 * `principal_id → verified peer entry`, with the **local boot principal**
 * pinned as an always-present, never-overwritten entry. Unknown peers are
 * resolved **on demand** via the TC-2a `PrincipalPubkeyResolver` (registry-
 * signed `GET /principals/{id}`, pinned-registry-pubkey verified), cached,
 * and then served synchronously. TC-2d consumes the materialised myelin
 * `IdentityRegistry` (`toIdentityRegistry()`) in the `federated.*` verify
 * path.
 *
 * ## Posture gate (default-OFF — load-bearing)
 *
 * Per the #635 wiring note, the federation verify path engages ONLY under
 * `security.signing: enforce` — NOT merely when `cryptoVerify` is on (which
 * is `true` even for `off`/`permissive` as cheap observability). The
 * resolver is constructed with its own `enabled` flag driven by
 * `signing === "enforce"`; when federation verify is OFF the resolver is
 * inert and `resolve()` returns `{ status: "disabled" }` with ZERO network
 * I/O. In that state ONLY the pinned local boot entry is available — exactly
 * today's single-principal behaviour. This registry does no posture reading
 * itself: it delegates the gate to the resolver it is handed (an `enabled:
 * false` / absent resolver ⇒ peer lookups never reach out).
 *
 * ## Peer-stamping (provenance)
 *
 * Every entry records its `provenance`:
 *   - `"local-boot"`   — the pinned local boot principal (config-supplied,
 *     out-of-band trust anchor). Exactly one such entry; immutable.
 *   - `"resolved-registry"` — a peer whose pubkey was resolved + verified
 *     via the TC-2a resolver against the pinned registry pubkey.
 *
 * TC-2d / audit can distinguish "we trust this because the principal pinned
 * it at boot" from "we trust this because the network registry asserted it".
 * A resolved peer entry NEVER overwrites the pinned local boot identity, in
 * EITHER key space: a resolve for the boot `principalId` short-circuits on the
 * cache before the resolver is consulted, AND a resolved peer whose
 * `did:mf:<principalId>` collides with the boot DID is refused (the
 * materialised myelin registry is DID-keyed and last-write-wins, so without
 * this guard a hyphenated registry id like `andreas-meta-factory` could shadow
 * the boot stack DID `did:mf:andreas-meta-factory`). The boot anchor is the
 * strongest link in the chain and a registry compromise must not be able to
 * displace it.
 *
 * ## Failure handling (CLAUDE.md: NEVER empty catch)
 *
 * `resolve()` NEVER throws — a federation/registry problem must not crash
 * the verify path. An unresolved peer yields a clear negative
 * (`{ resolved: false, reason }`) that the verifier rejects on, logged via
 * the injected `logError` seam (defaults to `process.stderr`). A negative
 * is NOT cached (the underlying resolver already declines to cache
 * negatives), so a peer that registers after its first probe becomes
 * resolvable without waiting out a TTL.
 *
 * ## Back-compat (single-principal case)
 *
 * Constructed with only a boot principal and no resolver, this class behaves
 * as a single-entry registry: `get(bootId)` returns the boot identity,
 * `toIdentityRegistry()` materialises exactly the boot identity, and
 * `resolve(anyPeer)` returns `{ resolved: false, reason: "disabled" }`
 * without I/O. Existing single-principal consumers see no change.
 */

import {
  createInMemoryRegistry,
  type Identity,
  type IdentityRegistry,
} from "@the-metafactory/myelin/identity";
// WP-6 (#1882) / ADR-0025 — ADDITIVE import of the RFC-0001 class-explicit
// codec. Consumed ONLY by the STAGED, flag-day-gated resolved-peer relabel
// (`classExplicitResolvedPeerDid`, selected in `resolve()` when
// `RESOLVED_PEER_DID_CLASS_EXPLICIT` flips at flag-day R). It does NOT touch
// the flat form this module emits/expects today — pre-cut every stamp is
// byte-identical to prior releases (see the const's docblock for the no-emit
// argument). Never hand-roll a `{p}-{s}` join; the codec is the sole owner.
import { renderDid, parseStackId } from "@the-metafactory/myelin/wire/identity";

import type { PrincipalPubkeyResolver } from "./resolve-pubkey";

/**
 * TC-2d (cortex#635) — outcome of {@link
 * MultiPrincipalIdentityRegistry.resolveFederatedPeer}, the adapter the
 * `federated.*` crypto-verify path (`verifySignedByChain`) consumes.
 *
 * Structurally identical to the verifier's `FederatedPeerResolution` so the
 * registry method can be handed directly as the verify seam without an
 * adapter layer — kept defined HERE (not imported from `src/bus/`) so the
 * registry module stays free of a back-edge into the bus layer.
 */
export type FederatedPeerResolution =
  | { resolved: true; identity: Identity }
  | { resolved: false; reason: string };

/**
 * Where an entry's verified pubkey came from. Stamped onto every entry so
 * TC-2d / audit can distinguish the boot trust anchor from a registry-
 * resolved peer.
 */
export type EntryProvenance = "local-boot" | "resolved-registry";

/**
 * A single verified principal entry held by the registry.
 */
export interface PrincipalEntry {
  /** The principal id (e.g. `andreas`) — the map key. */
  readonly principalId: string;
  /**
   * The materialised myelin `Identity` for this principal. Fed verbatim
   * into the myelin `IdentityRegistry` that the crypto-verify path consumes.
   */
  readonly identity: Identity;
  /** How this entry's pubkey was established. See {@link EntryProvenance}. */
  readonly provenance: EntryProvenance;
}

/**
 * Outcome of an async {@link MultiPrincipalIdentityRegistry.resolve}.
 * Discriminated so TC-2d can branch: a positive feeds the entry into the
 * verify path; every negative rejects the inbound envelope.
 */
export type RegistryResolveOutcome =
  | { resolved: true; entry: PrincipalEntry }
  | {
      resolved: false;
      /**
       * Why the peer could not be resolved:
       *   - `"disabled"`    — federation verify is OFF (resolver inert / absent);
       *                       no I/O was performed.
       *   - `"not_found"`   — the registry returned 404 for this principal id.
       *   - `"unresolved"`  — transient/structural failure (network, parse,
       *                       signature, mismatch). Retry-able; not cached.
       */
      reason: "disabled" | "not_found" | "unresolved";
    };

/** Construction options for {@link MultiPrincipalIdentityRegistry}. */
export interface MultiPrincipalIdentityRegistryOptions {
  /**
   * The local boot principal — the pinned, always-present, never-overwritten
   * trust anchor. `principalId` is its map key; `identity` is the myelin
   * `Identity` to materialise into the verify registry (the same shape
   * `buildIdentityRegistry` constructs for the local stack).
   */
  bootPrincipal: { principalId: string; identity: Identity };
  /**
   * On-demand peer-pubkey resolver (TC-2a). When omitted, peer lookups are
   * inert (`resolve()` returns `{ resolved: false, reason: "disabled" }`)
   * — the single-principal back-compat path. When present, its OWN
   * `enabled` flag (driven by `signing === "enforce"`) decides whether it
   * reaches out: a disabled resolver short-circuits to `{ status:
   * "disabled" }` with zero I/O, surfaced here as `reason: "disabled"`.
   */
  resolver?: Pick<PrincipalPubkeyResolver, "resolve">;
  /**
   * The owning-network slug stamped onto resolved peer `Identity` objects'
   * `network` field. For a federated peer the network IS the peer's own
   * principal id (the bus-addressing model — see `verify-signed-by-chain.ts`
   * R4 note). Defaults to the resolved peer's own `principalId`.
   */
  peerNetwork?: (principalId: string) => string;
  /**
   * Logger seam — defaults to writing to `process.stderr` (CLAUDE.md
   * "no empty catches"). Tests inject a spy / no-op.
   */
  logError?: (msg: string) => void;
}

/**
 * Build the DID for a peer principal's federation identity. Peers are
 * stamped with `did:mf:<principalId>` — the principal-level identity that
 * signs `federated.{principal}.{stack}` envelopes. Mirrors the
 * `did:mf:<id>` convention `buildIdentityRegistry` uses for local agents.
 */
function peerDid(principalId: string): string {
  return `did:mf:${principalId}`;
}

/**
 * WP-6 (#1882) / ADR-0025 — flag-day R gate for the resolved-peer DID class.
 *
 * **Pre-cut (`false`, today):** a resolved peer's materialised identity is
 * stamped with the flat PRINCIPAL-class DID (`peerDid`, `did:mf:<principal>`),
 * byte-identical to every release since TC-2b. This is a no-emit constant: it
 * changes nothing this module produces or expects on the wire.
 *
 * **Flag-day R (`true`, ADR-0025 hard cut):** the resolved peer is stamped
 * with its true STACK-class DID via the ./wire codec
 * (`did:mf:stack.<principal>.<stack>`), so the structural short-circuit in
 * `verify-signed-by-chain` (`principal === federatedPeerDid`,
 * verify-signed-by-chain.ts) matches the class-explicit wire stamp cortex's
 * emitter ALSO flips to at R (#2034) — and jc's presence FOLDS. See the WP-6
 * finding in the PR: the live drop is defect (a), the structural `===`
 * class-label mismatch, NOT (b) the just-in-time crypto merge (the structural
 * walk rejects `unknown_agent` BEFORE the crypto pass merges the per-stack
 * key, so the per-stack key never gets a chance to win).
 *
 * This is a clean SWAP, never a dual-accept window: ADR-0025 §Compatibility is
 * a HARD CUT (no both-forms tolerance, no staged emitter window). Flipping
 * this const WITHOUT the paired #2034 emitter flip would relabel the peer to a
 * class-explicit DID that no longer matches the still-flat wire — re-breaking
 * the fold. The two flip together at R (runbook §3 atomic cut).
 *
 * WHY NOT relabel to the flat stack form (`did:mf:<p>-<s>`) NOW — which would
 * match today's flat wire and fold jc immediately: it re-entrenches the
 * NON-injective flat encoding in the trust path, the exact collision the
 * SECURITY refuse in `resolve()` (and epic #1876) exists to eliminate. WP-6
 * does not buy the fold at the cost of that vigilance debt.
 *
 * Widened to `boolean` (via `as`, not the `false` literal type) so the
 * flag-day branch stays live to the type-checker and the ./wire relabel is
 * type-checked pre-cut rather than narrowed away as dead.
 */
const RESOLVED_PEER_DID_CLASS_EXPLICIT = false as boolean;

/**
 * WP-6 (#1882) — compute a resolved peer's class-explicit STACK-class DID from
 * the peer principal + the QUALIFIED `{principal}/{stack}` stack id the verify
 * seam threads (`stackFromEnvelope`, envelope-validator.ts — NOTE it is the
 * qualified pair, not a bare slug; passing the bare slug silently drops). Uses
 * ./wire's `parseStackId` + `renderDid` (RFC-0001 §6.2 class-explicit codec),
 * never a hand-rolled join.
 *
 * Returns `undefined` — so the caller falls back to the flat principal-class
 * stamp — when there is no stack id (a root/principal-level resolve), the pair
 * is ungrammatical, or (anti-spoof) the pair's principal segment disagrees
 * with the resolved peer principal. `stackFromEnvelope` derives both the
 * principal and the stack from the SAME `envelope.source`, so a disagreement
 * is a malformed/foreign source and must never mint a stack DID under another
 * principal's name.
 *
 * Exported + unit-tested now, but SELECTED by `resolve()` only when
 * {@link RESOLVED_PEER_DID_CLASS_EXPLICIT} flips at flag-day R — so the
 * relabel logic is reviewed and proven against ./wire BEFORE the cut, and the
 * flag-day change is a one-const flip rather than net-new trust-path code.
 */
export function classExplicitResolvedPeerDid(
  principalId: string,
  stackId: string | undefined,
): string | undefined {
  if (stackId === undefined) return undefined;
  const scope = parseStackId(stackId);
  if (!scope.ok) return undefined;
  // Anti-spoof: never stamp a peer under a `{principal}` other than the one we
  // resolved. Both segments come from the same envelope.source, so a mismatch
  // is malformed/foreign — refuse (fall back to the flat principal stamp).
  if (scope.value.principal !== principalId) return undefined;
  const did = renderDid("stack", scope.value.principal, scope.value.stack);
  return did.ok ? did.value : undefined;
}

/**
 * C-787 — `entries` map key for a RESOLVED PEER. The boot principal is keyed
 * by its bare `principalId` (pinned in the ctor); resolved peers are keyed
 * per-stack as `"{principalId} {stackId}"` so a principal federating multiple
 * stacks caches one verified entry per stack (each with that stack's pubkey)
 * without the second clobbering the first. A space cannot appear in a
 * principal id or stack id, so the per-stack key space never collides with a
 * bare-principal key. A peer resolve with no `stackId` keys on the bare
 * principal id — the pre-C-787 behaviour.
 */
function entryKey(principalId: string, stackId?: string): string {
  return stackId === undefined ? principalId : `${principalId} ${stackId}`;
}

/**
 * Multi-principal, peer-stamped identity registry. Construct once at boot
 * with the local boot principal pinned + (optionally) the TC-2a resolver,
 * then:
 *   - `get(principalId)` — synchronous lookup against what's already stored.
 *   - `resolve(principalId)` — async resolve-and-cache for unknown peers
 *     (posture-gated via the resolver).
 *   - `toIdentityRegistry()` — materialise the myelin `IdentityRegistry`
 *     the crypto-verify path consumes.
 *
 * Single-process, in-memory.
 */
export class MultiPrincipalIdentityRegistry {
  /** `principal_id → verified entry`. The boot principal is pinned here. */
  private readonly entries = new Map<string, PrincipalEntry>();
  /** The boot principal id — immutable, never overwritten by a peer. */
  private readonly bootPrincipalId: string;
  /**
   * The boot principal's DID. The boot anchor is keyed two ways: by
   * `principalId` in {@link entries} AND by this DID in the materialised
   * myelin registry. A resolved peer must never collide with EITHER, so we
   * refuse to store a peer whose `peerDid(principalId)` equals this value.
   */
  private readonly bootDid: string;
  private readonly resolver: Pick<PrincipalPubkeyResolver, "resolve"> | undefined;
  private readonly peerNetwork: (principalId: string) => string;
  private readonly logError: (msg: string) => void;

  constructor(options: MultiPrincipalIdentityRegistryOptions) {
    this.bootPrincipalId = options.bootPrincipal.principalId;
    this.bootDid = options.bootPrincipal.identity.id;
    this.resolver = options.resolver;
    this.peerNetwork = options.peerNetwork ?? ((id) => id);
    this.logError =
      options.logError ??
      ((msg: string) => {
        process.stderr.write(`identity-registry: ${msg}\n`);
      });

    // Pin the local boot principal — always present, provenance "local-boot".
    this.entries.set(this.bootPrincipalId, {
      principalId: this.bootPrincipalId,
      identity: options.bootPrincipal.identity,
      provenance: "local-boot",
    });
  }

  /**
   * Synchronous lookup against what's ALREADY stored (the pinned boot
   * principal + any peer resolved by a prior `resolve()`). Returns
   * `undefined` for a principal that has not been resolved — the caller
   * should `resolve()` (async) to attempt populating it. NEVER does I/O.
   */
  get(principalId: string): PrincipalEntry | undefined {
    return this.entries.get(principalId);
  }

  /** Whether a principal is already stored (boot or previously-resolved). */
  has(principalId: string): boolean {
    return this.entries.has(principalId);
  }

  /** All stored entries (boot + resolved peers). For audit / introspection. */
  list(): PrincipalEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Resolve `principalId` to its verified entry.
   *
   * Cache-first: a stored entry (boot or previously-resolved) is returned
   * synchronously-fast without I/O. On a miss, consults the TC-2a resolver
   * (when present + enabled); a successful, verified resolve is stamped
   * `provenance: "resolved-registry"`, cached, and returned. Posture-gated:
   * when the resolver is absent or disabled, no I/O is performed and
   * `{ resolved: false, reason: "disabled" }` is returned — only the boot
   * entry (and any earlier-resolved peer) is available.
   *
   * The pinned local boot entry is NEVER overwritten: a resolve for the
   * boot id returns the pinned entry without consulting the resolver, so a
   * registry assertion cannot displace the out-of-band boot anchor.
   *
   * NEVER throws.
   */
  async resolve(
    principalId: string,
    stackId?: string,
  ): Promise<RegistryResolveOutcome> {
    // Cache-first. The pinned boot principal is ALWAYS in `entries` (set in
    // the ctor, never deleted — there is no eviction API), so a resolve for
    // the boot id short-circuits here and the resolver is NEVER consulted
    // for it. This is the mechanism by which a registry assertion can never
    // displace the out-of-band boot anchor: the resolved-peer write below is
    // unreachable for the boot id.
    //
    // C-787 — the boot principal is keyed by its bare `principalId` (it is
    // pinned, single-stack, never registry-resolved), so a resolve for the
    // boot id still short-circuits here regardless of `stackId`. A PEER is
    // keyed per-stack (see `entryKey`) so a principal federating two stacks
    // caches a distinct verified pubkey per stack and they never clobber.
    const bootEntry = this.entries.get(principalId);
    if (bootEntry?.provenance === "local-boot") {
      return { resolved: true, entry: bootEntry };
    }
    const cached = this.entries.get(entryKey(principalId, stackId));
    if (cached !== undefined) {
      return { resolved: true, entry: cached };
    }

    // No resolver wired (single-principal back-compat) → inert.
    if (this.resolver === undefined) {
      return { resolved: false, reason: "disabled" };
    }

    const result = await this.resolver.resolve(principalId, stackId);
    switch (result.status) {
      case "disabled":
        // Posture OFF — the resolver did no I/O. Federation verify not engaged.
        return { resolved: false, reason: "disabled" };
      case "not_found":
        this.logError(
          `resolve(${principalId}): registry returned not_found; peer is unverifiable`,
        );
        return { resolved: false, reason: "not_found" };
      case "unresolved":
        // Already logged in detail by the resolver; record a clear negative.
        this.logError(
          `resolve(${principalId}): unresolved (transient/structural); peer is unverifiable this attempt`,
        );
        return { resolved: false, reason: "unresolved" };
      case "resolved": {
        // Reached only on a CACHE MISS, so `principalId` cannot be the boot
        // id (boot is always cached above) — the boot anchor is structurally
        // safe from a resolver-supplied pubkey IN THE principalId MAP.
        //
        // But the materialised myelin registry is keyed by DID, and
        // `peerDid(principalId)` is NOT injective with the boot DID: registry
        // ids permit hyphens and the boot stack DID is `did:mf:<principal>-
        // <stack>`, so a peer id like `andreas-meta-factory` yields the same
        // DID as boot `did:mf:andreas-meta-factory`. myelin `add()` is
        // last-write-wins, so storing such a peer would let a registry
        // assertion DISPLACE the out-of-band boot anchor in the exact
        // registry the verifier consumes. Refuse it — a peer whose DID
        // collides with the boot anchor is a trust-displacement attempt.
        const did = peerDid(principalId);
        if (did === this.bootDid) {
          this.logError(
            `resolve(${principalId}): SECURITY — resolved peer DID ${did} collides with the boot anchor DID; refusing (possible trust-displacement via a hyphenated registry id)`,
          );
          return { resolved: false, reason: "unresolved" };
        }
        // WP-6 (#1882) / ADR-0025 — STAGED, flag-day-gated resolved-peer DID.
        // Pre-cut: `stampDid === did` (the flat principal-class DID) — the
        // stamp is byte-identical to prior releases. At flag-day R the gate
        // flips and the peer is stamped with its true class-explicit STACK DID
        // (paired with the #2034 emitter flip), which is what makes the verify
        // short-circuit match and jc's presence fold. The `?? did` fallback
        // keeps the principal-class stamp for a root/ungrammatical resolve.
        // See `RESOLVED_PEER_DID_CLASS_EXPLICIT` for the full no-emit argument.
        const stampDid = RESOLVED_PEER_DID_CLASS_EXPLICIT
          ? (classExplicitResolvedPeerDid(principalId, stackId) ?? did)
          : did;
        const entry: PrincipalEntry = {
          principalId,
          identity: {
            // Pre-cut the stamp DID is principal-level (`did:mf:<peer>` — see
            // `principalFromEnvelope`); the materialised identity keeps that
            // DID even for a per-stack resolve. C-787: `public_key` is the
            // resolved PER-STACK key (when a stackId was supplied and the stack
            // carried one) — that is the key the peer's envelope from THAT
            // stack is signed with. At flag-day R (`stampDid` above) the id
            // flips to the class-explicit STACK DID so the structural
            // short-circuit matches the wire; until then the per-stack key is
            // merged just-in-time before the active envelope's crypto pass, but
            // the class-label mismatch rejects `unknown_agent` structurally
            // first (the WP-6 finding) — which is exactly why the fold rides R.
            id: stampDid,
            display_name: principalId,
            network: this.peerNetwork(principalId),
            public_key: result.principalPubkey,
            type: "agent",
            // Resolved at runtime; the registry record carries no creation
            // timestamp for the peer, so anchor to the epoch (a stable,
            // non-misleading value — myelin only requires a valid ISO-8601).
            created_at: new Date(0).toISOString(),
          },
          provenance: "resolved-registry",
        };
        this.entries.set(entryKey(principalId, stackId), entry);
        return { resolved: true, entry };
      }
    }
  }

  /**
   * TC-2d (cortex#635) — verify-path adapter. Resolve `peerPrincipal` and
   * project the {@link RegistryResolveOutcome} onto the shape the
   * `federated.*` crypto-verify seam (`verifySignedByChain`'s
   * `resolveFederatedPeer`) consumes: a positive carries the peer's myelin
   * `Identity` to merge into the verify registry; every negative carries a
   * grep-friendly `reason` string (`disabled` / `not_found` / `unresolved`)
   * the verifier surfaces as `federated_peer_unresolved`.
   *
   * `disabled` (resolver inert — federation verify not engaged) is mapped to
   * a negative here on purpose: if this adapter is ever invoked under a
   * disabled resolver (it should not be — `cortex.ts` only wires the seam
   * under `signing === "enforce"`), the verifier rejects rather than admits.
   * NEVER throws (delegates to {@link resolve}, which never throws).
   *
   * Bind this method (`registry.resolveFederatedPeer.bind(registry)`) when
   * handing it to the verifier so `this` stays the registry instance.
   */
  async resolveFederatedPeer(
    peerPrincipal: string,
    peerStack?: string,
  ): Promise<FederatedPeerResolution> {
    const outcome = await this.resolve(peerPrincipal, peerStack);
    if (outcome.resolved) {
      return { resolved: true, identity: outcome.entry.identity };
    }
    return { resolved: false, reason: outcome.reason };
  }

  /**
   * Materialise a myelin `IdentityRegistry` containing the pinned boot
   * identity plus every peer resolved so far. This is the shape the
   * crypto-verify path (`verifyEnvelopeIdentity`, TC-2d) consumes. A fresh
   * registry is built per call from the current entry set — cheap (single-
   * digit-to-dozens of entries) and avoids handing the verifier a mutable
   * reference into our internal store.
   */
  toIdentityRegistry(): IdentityRegistry {
    const registry = createInMemoryRegistry();
    // myelin `add()` is last-write-wins on the DID key. Track DIDs and skip
    // any later entry that collides with one already added. The boot principal
    // is inserted first in `entries` (ctor) so it is iterated first here and
    // therefore always WINS a collision — the boot anchor can never be
    // displaced in the materialised registry the verifier consumes. (The
    // resolve-success guard already refuses peers whose DID collides with the
    // boot DID; this is the defense-in-depth backstop, and it also prevents
    // two distinct peers with a colliding DID from silently clobbering.)
    const seenDids = new Set<string>();
    for (const entry of this.entries.values()) {
      const did = entry.identity.id;
      if (seenDids.has(did)) {
        this.logError(
          `toIdentityRegistry: skipping ${entry.principalId} (provenance=${entry.provenance}) — DID ${did} already materialised; refusing to overwrite`,
        );
        continue;
      }
      seenDids.add(did);
      registry.add(entry.identity);
    }
    return registry;
  }
}
