/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine implementation.
 * IAW Phase D.3 (cortex#116) — per-network slicing on federated dispatches.
 *
 * The single authorization decision point for cortex. Replaces the
 * per-surface role-resolver duplication today (Discord adapter +
 * Mattermost adapter equivalent) with one `check(principal, intent)`
 * call. Phase C.2 collapses cortex.yaml's per-adapter `roles[]`
 * into the top-level `policy:` block that constructs the engine;
 * Phase C.3 wires the engine into the dispatch-handler so every
 * inbound dispatch passes through `check` before reaching a
 * substrate harness; Phase C.4 emits `system.access.{allowed,denied}`
 * audit envelopes carrying the decision shape this engine returns.
 * Phase D.3 extends `check()` with per-network policy slicing — when
 * `intent.source_network` is set, the engine consults the matching
 * `policy.federated.networks[]` entry and rejects principals that
 * aren't peers of the named network.
 *
 * Cross-references:
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107.
 *   - `docs/plan-internet-of-agentic-work.md` §D.3.
 *   - `./types.ts` — `Principal`, `Intent`, `RoleDefinition`,
 *     `PolicyDecision`, `PolicyDenyReason`.
 *
 * What this slice deliberately doesn't do (deferred):
 *   - **No sovereignty enforcement.** `Intent.sovereignty` is part
 *     of the decision input shape so audit envelopes (C.4) carry
 *     it, but the engine doesn't yet reject on sovereignty
 *     mismatches. The `sovereignty_mismatch` deny reason exists
 *     in the discriminator for forward compatibility; today it
 *     never fires.
 *   - **No subject-level accept/deny.** Phase D.2 gates inbound
 *     `federated.*` envelopes at the surface-router by
 *     `policy.federated.networks[].accept_subjects[]` /
 *     `deny_subjects[]` BEFORE they reach this engine. D.3 runs
 *     after that gate and answers the residual question: "now that
 *     the envelope was admitted by the router, is the originating
 *     principal actually authorised to act on this network?"
 *   - **No glob expansion on capability matches.** Literal
 *     `===` matching only; PRs after Phase C may add patterns.
 */

import type {
  Intent,
  PolicyDecision,
  Principal,
  RoleDefinition,
} from "./types";

/**
 * IAW Phase D.3 (cortex#116) — slim federation slice the engine
 * consumes for per-network membership checks.
 *
 * Structurally compatible with `PolicyFederated` from
 * `src/common/types/cortex-config.ts` (the Zod-parsed shape) — the
 * factory passes the parsed `Policy.federated` through verbatim.
 * Declared here as a local type so the engine module stays
 * independent of the config schema's module graph (avoids
 * `engine.ts` importing from `common/types/`, which today imports
 * from elsewhere in `common/`).
 *
 * Only the fields D.3 actually reads are typed; the wider federated
 * config carries `accept_subjects` / `deny_subjects` / `max_hop` etc.
 * which are surface-router concerns (D.2), not engine concerns.
 */
export interface FederatedPolicy {
  /** Networks this operator participates in. */
  readonly networks: readonly FederatedNetwork[];
}

export interface FederatedNetwork {
  /** Network id — matches `intent.source_network`. */
  readonly id: string;
  /**
   * Peer stacks declared on this network. The engine reads
   * `stack_id` to validate that an incoming principal's
   * `home_stack` belongs to the network's peer roster.
   *
   * Other peer fields (`principal_id`, `principal_pubkey`) are
   * consumed elsewhere (verifier, registry); the engine doesn't
   * read them.
   */
  readonly peers: readonly { readonly stack_id: string }[];
}

export interface PolicyEngineOptions {
  /**
   * All principals known to this engine. Built from
   * `cortex.yaml.policy.principals[]` post-C.2; for C.1 callers
   * assemble manually (the schema flip is the next slice).
   */
  principals: readonly Principal[];
  /**
   * Role definitions, by id. The engine looks up each id in a
   * principal's `role[]` against this list and unions the
   * capabilities to compute the effective grant set.
   */
  roles: readonly RoleDefinition[];
  /**
   * IAW Phase D.3 (cortex#116) — optional federation slice. When
   * present, the engine evaluates `intent.source_network` against
   * the matching network's peer roster on every `check()` call.
   * When absent, the federation branch is inert — federated
   * dispatches (those with `intent.source_network` set) reject
   * with `unknown_network` because nothing is declared.
   *
   * The default-undefined shape preserves backward compatibility:
   * a caller that doesn't pass `federated` gets the C.3 behaviour
   * for every check (no federation gate, no federation deny
   * reasons).
   */
  federated?: FederatedPolicy;
}

export class PolicyEngine {
  private readonly principalsById: ReadonlyMap<string, Principal>;
  private readonly rolesById: ReadonlyMap<string, RoleDefinition>;
  /**
   * IAW Phase D.3 — networks indexed by id for O(1) lookup on the
   * federation branch. `undefined` when no federated policy was
   * passed at construction; callers see `unknown_network` deny on
   * any federated `check()` in that case.
   */
  private readonly networksById: ReadonlyMap<string, FederatedNetwork> | undefined;
  /**
   * IAW cortex#482 — reverse index `platform → author_id → principal_id`.
   *
   * Built once at construction from each principal's `platform_ids`
   * map so `lookupPrincipalIdByPlatformId` is O(1) per call. Uniqueness
   * of `(platform, author_id)` tuples is enforced upstream by
   * `PolicySchema.superRefine`; if a duplicate slips through here the
   * later principal in the constructor list wins (last-write semantics,
   * consistent with `principalsById`'s `new Map(...)` collision rule).
   *
   * **Duplication note (keep in sync with `PlatformPrincipalIndex` in
   * `src/common/policy/policy-gate.ts`).** `PlatformPrincipalIndex`
   * builds the same `(platform, platform_id) → principal_id` lookup
   * from the same `policy.principals[]` shape, for adapter-side
   * `resolvePolicyAccess`.
   *
   * Pre-#486: both indexes were kept because they served different
   * boundaries — `PlatformPrincipalIndex` adapter-side BEFORE publish,
   * this index runner-side AFTER verify (PR #483 used it to back-
   * resolve platform-prefixed originator DIDs to a principal id).
   *
   * Post-#486: the runner no longer consumes this index — the dispatch
   * source resolves `(platform, authorId)` to a principal at publish
   * time so `originator.identity` lands on the wire as the resolved
   * principal DID. This index remains because (a) it's the engine's
   * native surface (`lookupPrincipalIdByPlatformId`) and the
   * dispatch-source now consumes it from there rather than depending
   * on `policy-gate.ts`, and (b) keeping a single registry inside the
   * engine avoids drift between dispatch-source and federation
   * surfaces that may also want the reverse lookup in future.
   *
   * Schema-side changes (case-folding, platform-name canonicalisation,
   * deprecation) must land in BOTH places or the boundaries drift.
   * Cross-referenced from `PlatformPrincipalIndex` JSDoc.
   */
  private readonly principalIdByPlatformId: ReadonlyMap<string, ReadonlyMap<string, string>>;

  constructor(opts: PolicyEngineOptions) {
    this.principalsById = new Map(opts.principals.map((p) => [p.id, p]));
    this.rolesById = new Map(opts.roles.map((r) => [r.id, r]));
    this.networksById = opts.federated
      ? new Map(opts.federated.networks.map((n) => [n.id, n]))
      : undefined;

    // IAW cortex#482 — flatten principals[].platform_ids[platform][]
    // into a `platform → author_id → principal_id` reverse index.
    // Built at construction and never mutated; the registry is a
    // cortex.yaml snapshot (see `Principal.role`'s `readonly`
    // discipline JSDoc).
    const reverse = new Map<string, Map<string, string>>();
    for (const p of opts.principals) {
      const platformIds = p.platform_ids;
      if (platformIds === undefined) continue;
      for (const [platform, ids] of Object.entries(platformIds)) {
        let bucket = reverse.get(platform);
        if (bucket === undefined) {
          bucket = new Map<string, string>();
          reverse.set(platform, bucket);
        }
        for (const authorId of ids) {
          bucket.set(authorId, p.id);
        }
      }
    }
    this.principalIdByPlatformId = reverse;
  }

  /**
   * IAW cortex#482 — reverse-lookup a `(platform, author_id)` tuple
   * to a registered principal id, or `undefined` when no principal
   * claims that platform identity.
   *
   * Consumes the reverse index built from
   * `Principal.platform_ids[platform][]` at construction. Post-#486
   * the canonical caller is the dispatch-source publisher
   * (`adapterOriginatorIdentity` in
   * `src/bus/dispatch-source-publisher.ts`), which performs the
   * `(platform, authorId) → principal-id` resolution at envelope
   * publish time so `originator.identity` carries the RESOLVED
   * principal DID (`did:mf:<principal-id>`). PR #483 briefly used
   * this surface from the dispatch-listener's `resolvePrincipalId`
   * for a back-resolve when the publisher emitted a platform-
   * prefixed DID; cortex#486 reverted that and moved the lookup
   * adapter-side, restoring the CONTEXT.md §Dispatch-source
   * "adapter populates `originator.identity` with the **resolved**
   * human/agent DID" contract.
   *
   * Returning `undefined` for unknown tuples is the security
   * default: the adapter refuses the publish with
   * `invalid-originator`. No platform identity gets implicitly
   * authorised by failure to resolve.
   */
  lookupPrincipalIdByPlatformId(
    platform: string,
    authorId: string,
  ): string | undefined {
    return this.principalIdByPlatformId.get(platform)?.get(authorId);
  }

  /**
   * IAW cortex#483 — registered platform names (the keys of the
   * `platform → author_id → principal_id` reverse index).
   *
   * Originally introduced (PR #483) so the dispatch-listener could
   * disambiguate platform-prefixed agent ids by longest-prefix match
   * against the registered set. cortex#486 retired that consumer:
   * platform-id resolution now happens at the dispatch source, which
   * has the `(platform, authorId)` tuple directly and doesn't need to
   * disambiguate after-the-fact from a flattened DID tail.
   *
   * The surface stays — it's still useful for ad-hoc diagnostics
   * (e.g. enumerating which platforms are policy-registered in boot
   * logs, or unit tests that exercise the reverse index). Returns an
   * `Iterable` (not an array snapshot) to avoid materialising a copy
   * on every call; callers that need stable iteration should spread.
   */
  get knownPlatforms(): Iterable<string> {
    return this.principalIdByPlatformId.keys();
  }

  /**
   * Authorise a principal id to exercise an intent. Returns a
   * `PolicyDecision` discriminated on `allow`.
   *
   * Decision flow:
   *   1. Look up the principal by id. Unknown → `unknown_principal`.
   *   2. Compute effective capabilities = union of every role's
   *      capabilities. Unknown role ids are silently skipped (the
   *      caller's responsibility to keep the principals and roles
   *      lists consistent; in production C.2 will validate this
   *      at config load).
   *   3. Match `intent.capability` against the effective set.
   *      Miss → `insufficient_role`.
   *   4. **(D.3)** When `intent.source_network` is set, evaluate the
   *      federation slice:
   *        - Network not declared in `policy.federated.networks[]`
   *          → `unknown_network`.
   *        - Principal known locally but `home_stack` not in the
   *          network's `peers[].stack_id` roster →
   *          `stack_not_in_network`.
   *      Local dispatches (`source_network === undefined`) skip
   *      this branch entirely and preserve C.3 behaviour.
   *   5. (Future phase) Sovereignty rejection. `intent.sovereignty`
   *      is on the input shape today for audit envelopes; the
   *      rejection branch is deferred.
   *   6. Allow with the full effective set.
   *
   * The federation branch is placed AFTER capability matching so
   * the deny reason surfaces the most-specific failure: a principal
   * that lacks the capability gets `insufficient_role` (the local
   * issue) rather than `stack_not_in_network` (the federation
   * issue). Operators triaging deny logs see the closest miss
   * first.
   *
   * Taking an id (not a `Principal` object) is deliberate: the
   * registry is authoritative for roles/trust, and accepting a
   * caller-constructed `Principal` would invite attacker-spoofed
   * `{id, role: ["admin"]}` payloads from parsed envelopes. The
   * dispatch-handler integration in C.3 strips `did:mf:` from a
   * verified `signed_by[].principal` and passes the bare id here
   * (Echo cortex#218 round 1).
   *
   * **⚠ Pre-Phase-B caveat (federation branch).** The principal
   * claim resolved from `signed_by[0].principal` is NOT yet
   * cryptographically verified at the validator (cortex#114). The
   * D.3 federation gate inherits this: a forged
   * `signed_by[0].principal` matching a declared local principal
   * would pass `home_stack`-vs-`peers[].stack_id` check until
   * Phase B's signature verification is mandatory. Defence in
   * depth, not authentication.
   */
  check(principalId: string, intent: Intent): PolicyDecision {
    const known = this.principalsById.get(principalId);
    if (known === undefined) {
      return {
        allow: false,
        reason: { kind: "unknown_principal", principal_id: principalId },
      };
    }

    const effectiveCapabilities = this.effectiveCapabilities(known);

    if (!effectiveCapabilities.has(intent.capability)) {
      return {
        allow: false,
        reason: {
          kind: "insufficient_role",
          missing_capability: intent.capability,
          principal_id: principalId,
        },
      };
    }

    // IAW Phase D.3 — federation slice. Inert for local dispatches.
    if (intent.source_network !== undefined) {
      const networkDecision = this.checkFederation(
        principalId,
        known,
        intent.source_network,
      );
      if (networkDecision !== undefined) {
        return networkDecision;
      }
    }

    // TODO(phase-D, sovereignty): enforce `intent.sovereignty` —
    // classification, residency, frontier-ok, model-class. C.4 audit
    // envelopes already carry the field; the rejection branch is
    // deferred until the sovereignty taxonomy stabilises across
    // myelin#31 + cortex#109.

    return {
      allow: true,
      capabilities: [...effectiveCapabilities],
    };
  }

  /**
   * IAW Phase D.3 — federation membership check. Returns a deny
   * decision when the source network rejects the principal, or
   * `undefined` to pass through to the allow branch.
   *
   * Two failure modes:
   *   - Network not in `policy.federated.networks[]` (either no
   *     federated slice configured, or this network id isn't
   *     declared) → `unknown_network`.
   *   - Network declared but principal's `home_stack` doesn't
   *     appear in the network's `peers[].stack_id` roster →
   *     `stack_not_in_network`.
   *
   * The "unknown principal on a federated edge"
   * (`unknown_federated_peer`) path doesn't fire here — that case
   * is already caught by the `unknown_principal` branch at the top
   * of `check()`, which runs before the federation slice. The deny
   * reason is in the discriminator for forward-compat with future
   * federation paths that resolve principals directly from peer
   * rosters (D.4 cloud registry) without a local
   * `policy.principals[]` entry.
   */
  private checkFederation(
    principalId: string,
    principal: Principal,
    sourceNetwork: string,
  ): PolicyDecision | undefined {
    const network = this.networksById?.get(sourceNetwork);
    if (network === undefined) {
      return {
        allow: false,
        reason: {
          kind: "unknown_network",
          source_network: sourceNetwork,
          principal_id: principalId,
        },
      };
    }

    const stackInNetwork = network.peers.some(
      (peer) => peer.stack_id === principal.home_stack,
    );
    if (!stackInNetwork) {
      return {
        allow: false,
        reason: {
          kind: "stack_not_in_network",
          principal_id: principalId,
          source_network: sourceNetwork,
          home_stack: principal.home_stack,
        },
      };
    }
    return undefined;
  }

  /**
   * Union of every role's capabilities for a principal. Unknown
   * role ids are silently skipped here — config validation belongs
   * upstream at parse time (C.2 will add it). Returning a Set
   * keeps the membership check at `check`'s callsite O(1).
   */
  private effectiveCapabilities(principal: Principal): Set<string> {
    const out = new Set<string>();
    for (const roleId of principal.role) {
      const role = this.rolesById.get(roleId);
      if (role === undefined) continue;
      for (const cap of role.capabilities) {
        out.add(cap);
      }
    }
    return out;
  }

  /**
   * Number of registered principals. Useful for boot-log lines +
   * smoke tests.
   */
  get principalCount(): number {
    return this.principalsById.size;
  }

  /**
   * Number of role definitions. Same role: boot-log + smoke.
   */
  get roleCount(): number {
    return this.rolesById.size;
  }
}
