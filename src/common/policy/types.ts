/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine types.
 *
 * The PolicyEngine is the single decision point for "what is this
 * principal allowed to do?" — replacing the per-surface duplication
 * cortex carries today (Discord adapter role-resolver,
 * Mattermost adapter equivalent). Phase C.2 will collapse those into
 * a single `policy:` block on cortex.yaml; this slice (C.1) ships
 * the engine + decision shape.
 *
 * Cross-references:
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107 — the
 *     spec this module implements.
 *   - cortex#114 (Phase B) — `signed_by[].principal` is verifiable
 *     post-Phase B; that DID resolves to a `Principal` here.
 *   - cortex#115 (Phase C umbrella) — this slice + C.2 (schema flip)
 *     + C.3 (harness integration) + C.4 (audit envelopes) +
 *     C.5 (tests + migration).
 */

/**
 * A principal is the identity-bearing actor a dispatch is attributed
 * to. Built from `cortex.yaml.policy.principals[]` post-Phase C.2;
 * for C.1 the engine accepts pre-built principals from its caller
 * (the schema flip happens in C.2 — until then the construction
 * path is wherever the caller assembles them).
 */
export interface Principal {
  /**
   * Stable principal id. Convention: matches `did:mf:<name>`'s
   * `<name>` segment (i.e. agent id), so a verified `signed_by[]`
   * stamp's `principal` field resolves directly to this id by
   * stripping the `did:mf:` prefix.
   */
  id: string;
  /**
   * Operator that owns this principal. Same value across all
   * principals in a single-operator deployment; varies across
   * principals once Phase D federation lands and the registry
   * spans multiple operators.
   */
  home_operator: string;
  /**
   * Stack identity in `{operator_id}/{stack_id}` form (Phase A.5
   * Q7 lock-in). The stack a principal calls "home" — bus
   * envelopes signed on its behalf carry the stack's NKey in
   * `signed_by[]`.
   */
  home_stack: string;
  /**
   * Role ids this principal holds. Each role is defined in
   * `RoleDefinition` and grants a set of capabilities. A principal's
   * effective capabilities are the union of its roles' capabilities.
   *
   * `readonly` deliberately — the engine treats the registry as a
   * cortex.yaml snapshot; permitting post-construction mutation
   * would silently change `check()` behaviour on the next call
   * (Echo cortex#218 round 1).
   */
  readonly role: readonly string[];
  /**
   * Peer principals this principal trusts. Empty array is legal
   * (no peer dispatches allowed). Symmetric with the existing
   * `agent.trust[]` field on `cortex.yaml` (which Phase C.2 will
   * migrate into the top-level `policy:` block). Same `readonly`
   * snapshot discipline as `role`.
   */
  readonly trust: readonly string[];
  /**
   * IAW cortex#482 + cortex#486 — platform-author-id → principal
   * mapping.
   *
   * Open record of `<platform_name> → <author_id>[]`, mirroring
   * `PolicyPrincipalSchema.platform_ids` on cortex.yaml. Consumed
   * at envelope-publish time by the dispatch-source publisher
   * (`adapterOriginatorIdentity` in
   * `src/bus/dispatch-source-publisher.ts`) via
   * `PolicyEngine.lookupPrincipalIdByPlatformId(platform, authorId)`
   * to resolve the inbound `(platform, authorId)` tuple to a
   * registered principal. The envelope then carries
   * `originator.identity = did:mf:<principal-id>` — the RESOLVED
   * principal DID, per CONTEXT.md §Dispatch-source. Platform-prefixed
   * DID shapes (`did:mf:<platform>-<authorId>`) no longer appear on
   * the wire (the pre-#486 cortex#482 / PR #483 behaviour).
   *
   * Optional + defaults to `{}` so existing callers (engine tests,
   * federation peer principals — which by convention SHOULD NOT
   * carry platform_ids per `PolicyPrincipalSchema` JSDoc) keep
   * working unchanged. The engine treats the map as read-only after
   * construction — mutating it post-construction does not refresh
   * the reverse index.
   */
  readonly platform_ids?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Sovereignty constraints on an intent. Mirrors the structure of
 * `Envelope.sovereignty` from the myelin schema — the engine reads
 * these fields when deciding whether a dispatch's classification +
 * residency + frontier-model-acceptability are compatible with the
 * principal's allowed scope (Phase D extends with per-network
 * accept/deny rules).
 */
export interface IntentSovereignty {
  classification: "local" | "federated" | "public";
  data_residency: string;
  max_hop: number;
  frontier_ok: boolean;
  model_class: "local-only" | "frontier" | "any";
}

/**
 * The "what is being requested" half of a policy check. The engine
 * matches an intent against the principal's effective capabilities
 * + sovereignty constraints.
 */
export interface Intent {
  /**
   * The capability the principal wants to exercise. Matched
   * against the union of capabilities granted by the principal's
   * `role[]` via `RoleDefinition`.
   */
  capability: string;
  /**
   * Sovereignty constraints from the envelope being dispatched.
   * The engine doesn't enforce sovereignty directly at C.1 — the
   * field is part of the decision input so future C.4 audit
   * envelopes carry it on the access record without an extra read.
   */
  sovereignty: IntentSovereignty;
  /**
   * Short, human-readable summary of the payload. Used only for
   * audit envelopes (C.4) — the engine itself doesn't read it.
   * Kept optional so callers without a useful summary handy don't
   * have to fabricate one.
   */
  payload_summary?: string;
  /**
   * IAW Phase D.3 (cortex#116) — federation source-network id.
   *
   * When the inbound envelope arrived via a `federated.{network_id}.>`
   * subject, the caller sets `source_network` to the matched
   * `{network_id}` segment. The engine then consults
   * `policy.federated.networks[]` by id and applies that network's
   * policy slice: the principal MUST be a declared peer on the
   * network, AND the principal's `home_stack` MUST appear in the
   * network's `peers[].stack_id` roster. Either miss → deny with
   * the network-scoped reason kinds (`unknown_network`,
   * `unknown_federated_peer`, `stack_not_in_network`).
   *
   * `undefined` (local dispatch) leaves the engine's C.3 behaviour
   * unchanged — the federation branch is skipped entirely.
   *
   * **⚠ Pre-Phase-B caveat.** The principal claim on
   * `signed_by[0].principal` (which the dispatch-listener strips to
   * derive the principal id passed to `check()`) is NOT yet
   * cryptographically verified at the envelope-validator layer
   * (cortex#114). Until Phase B wires verification, the federation
   * branch is authorisation-without-authentication: a forged
   * `signed_by[0].principal` would let an attacker pose as a
   * declared peer. The check is still useful as defence-in-depth
   * against misconfigured peers, but operators MUST treat the
   * federation gate as binding only after cortex#114 lands.
   */
  source_network?: string;
}

/**
 * A role definition: id + the capabilities it grants. Comes from
 * `cortex.yaml.policy.roles[]` post-C.2. The engine takes the
 * principal's `role[]` ids, looks them up here, and unions the
 * capabilities to compute the principal's effective grant set.
 */
export interface RoleDefinition {
  /** Role id (e.g. `operator`, `code-reviewer`). */
  id: string;
  /**
   * Capabilities this role grants. Convention follows Phase A.6
   * capability ids: `<domain>.<entity>` (e.g. `code-review.typescript`).
   * The engine matches `Intent.capability` against this list
   * literally — no glob expansion at C.1; future PRs may add it.
   *
   * `readonly` for the same snapshot discipline as `Principal.role`
   * (Echo cortex#218 round 1).
   */
  readonly capabilities: readonly string[];
}

/**
 * Discriminated rejection reason. Matches the shape Phase C.4 audit
 * envelopes need (`system.access.denied` payload's `reason` field).
 * Splitting the kinds at the discriminator now means audit
 * envelopes don't have to re-parse a stringly-typed reason later.
 */
export type PolicyDenyReason =
  | {
      kind: "unknown_principal";
      /** The principal id the caller tried to authorise. */
      principal_id: string;
    }
  | {
      kind: "insufficient_role";
      /** The missing capability — diagnostic, not a hint to the caller. */
      missing_capability: string;
      principal_id: string;
    }
  | {
      kind: "sovereignty_mismatch";
      /** Human-readable description of the mismatch. */
      reason: string;
    }
  | {
      /**
       * IAW Phase D.3 (cortex#116) — `intent.source_network` referenced
       * a network id that is not declared in `policy.federated.networks[]`.
       * Indicates either a misconfigured peer (the inbound envelope
       * names a network this operator doesn't participate in) or a
       * stale config snapshot. Distinct from `unknown_federated_peer`
       * (the network IS declared but the principal isn't a member).
       */
      kind: "unknown_network";
      /** The network id the caller tried to dispatch on. */
      source_network: string;
      principal_id: string;
    }
  | {
      /**
       * IAW Phase D.3 (cortex#116) — principal id resolved locally but
       * the principal's `home_stack` does not appear in the source
       * network's `peers[].stack_id` roster. Indicates a principal who
       * exists in `policy.principals[]` but is not authorised to act on
       * the federated network the envelope arrived on (e.g. an internal
       * agent attempting to dispatch on a partner-only network).
       */
      kind: "stack_not_in_network";
      principal_id: string;
      /** The network id the dispatch arrived on. */
      source_network: string;
      /** The principal's local `home_stack` — diagnostic for operators. */
      home_stack: string;
    }
  | {
      /**
       * IAW Phase D.3 (cortex#116) — reserved for future federation
       * paths that resolve principals directly from a peer roster
       * (e.g. D.4's cloud registry) without requiring a local
       * `policy.principals[]` entry. The D.3 engine doesn't emit
       * this kind today: an unknown principal on a federated edge
       * is caught by `unknown_principal` at the top of `check()`,
       * which fires before the federation branch. The variant lives
       * in the discriminator now so audit consumers (dashboard,
       * pipeline) can compile against the full set without a wire-
       * schema bump when D.4 lands.
       */
      kind: "unknown_federated_peer";
      principal_id: string;
      /** The network id the dispatch arrived on. */
      source_network: string;
    };

/**
 * The output of `PolicyEngine.check`. Discriminated on `allow`:
 *   - On accept, the engine surfaces the principal's full effective
 *     capability set so downstream callers (substrate harness,
 *     dispatch-handler) can prune tool/skill lists by what was
 *     actually granted, not just by what the intent asked for.
 *   - On reject, the engine surfaces the structured deny reason
 *     for audit envelopes + operator logs.
 */
export type PolicyDecision =
  | {
      allow: true;
      /**
       * The principal's full effective capability set (union of
       * all role grants). Includes the requested capability plus
       * everything else the principal can do. Downstream callers
       * use this to filter substrate-level allow lists.
       */
      capabilities: readonly string[];
    }
  | {
      allow: false;
      reason: PolicyDenyReason;
    };
