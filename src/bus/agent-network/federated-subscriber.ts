/**
 * G-1114.E.2 + E.5 — TRUST-VERIFIED federated agent-presence subscriber.
 *
 * The federation half of the agent-presence registry. Where the B.3
 * {@link startAgentPresenceRegistry} folds the stack's OWN
 * `local.{principal}.{stack}.agent.>` subtree, THIS module folds TRUST-VERIFIED
 * FOREIGN presence from peers' `federated.{principal}.{stack}.agent.>` subtree
 * into the SAME registry, tagging each foreign record with its `{principal}/{stack}`
 * provenance (`origin: { kind: "foreign", … }`).
 *
 * ## THE DESIGN QUESTION (resolved against the existing gate)
 *
 * **Does inbound `federated.*.agent.*` ALREADY pass through the surface-router's
 * `evaluateFederationGate` + signed_by chain verification before reaching a
 * consumer?**
 *
 * **NO — for THIS consumer.** The presence registry is an **Option-D direct
 * consumer**: it subscribes via `runtime.subscribe(pattern)` + `runtime.onEnvelope`
 * (see `startAgentPresenceRegistry`), NOT through the surface-router. The
 * surface-router's `evaluateFederationGate` runs ONLY for envelopes the router
 * fans to registered `SurfaceAdapter`s via `router.dispatch`. The runtime's
 * `onEnvelope` fan-out delivers EVERY inbound envelope to EVERY registered
 * handler RAW — pre-gate, pre-verify. So a registry that simply widened its
 * subscription to `federated.*.agent.>` would fold UNVERIFIED, UNGATED foreign
 * presence: a trust hole (any peer — accept-listed or not, signed or not — would
 * appear in the Network view).
 *
 * This is the EXACT situation the **runner dispatch-listener** faced at
 * cortex#484 ("Option D — executor, not renderer"): once it stopped registering
 * as a SurfaceAdapter and consumed envelopes directly off the runtime, the
 * surface-router's federation gate no longer covered it, so it grew its OWN
 * inline gate (`evaluateFederationGate`) + its own chain verification
 * (`verifySignedByChain` + `resolveFederatedPeer`). This module MIRRORS that
 * established trust path — it does NOT invent a parallel mechanism:
 *
 *   1. **Federation accept-list gate** — {@link evaluateFederationGate} on the
 *      wire subject + envelope, against the principal's
 *      `policy.federated.networks[]` (accept_subjects / deny_subjects / max_hop +
 *      the F-3d leaf anti-spoof cross-check). A non-allowlisted peer, a denied
 *      subject, an over-budget hop chain, or a cross-network-spoofed leaf is
 *      DROPPED before any fold. A `system.access.denied` audit envelope is
 *      emitted (`emitFederationDenied`) so the drop is observable.
 *   2. **`signed_by[]` chain verification** — {@link verifySignedByChain} with
 *      the same `resolveFederatedPeer` seam the dispatch-listener uses (wired
 *      ONLY under `signing === "enforce"`). A foreign envelope whose chain fails
 *      to verify (forged bytes, unresolved peer pubkey, stale timestamp) is
 *      DROPPED — never folded.
 *
 * ## Posture (matches the #484 dispatch-listener EXACTLY)
 *
 * Empty-chain handling is POSTURE-GATED via `rejectEmpty`, identical to how the
 * #484 dispatch-listener treats federated inbound (`rejectEmpty:
 * signingKnobs.rejectEmpty`):
 *   - `signing: off`        → accept-list-ONLY trust: an unsigned foreign
 *     envelope that passes the accept-list gate folds. Safe ONLY because of the
 *     source-bound identity below.
 *   - `signing: permissive` → accept-list + best-effort crypto-verify of any
 *     present chain.
 *   - `signing: enforce`    → require a verifiable `signed_by[]` chain (empty ⇒
 *     dropped) + registry peer-pubkey resolution.
 * A `signing: off` stack federates DISPATCH the same way, so presence is
 * consistent — not laxer.
 *
 * ## SOURCE-BOUND IDENTITY (PR #914 review BLOCKER fix)
 *
 * The folded record's IDENTITY — principal, stack, and the registry MAP KEY — is
 * derived from the CHAIN-VERIFIED `source`, NEVER from the attacker-controlled
 * `payload.scope`. {@link foldForeign} passes the source-derived
 * `{principal}/{stack}` to {@link AgentPresenceRegistry.applyForeign} as the
 * authoritative `verifiedScope`; the registry DROPS the envelope if
 * `payload.scope` disagrees (a spoof). So an accept-listed peer can announce ONLY
 * agents under its OWN verified `{principal}/{stack}` — it can NOT paint a
 * local-looking record, and a foreign record can NEVER collide with / overwrite a
 * local one. This is what makes the `signing: off` accept-list-only posture safe.
 *
 * Only an envelope that passes BOTH gates is folded. **Security invariant: only
 * accept-listed (and, under enforce, chain-verified) foreign presence is shown,
 * always under its source-bound identity.**
 *
 * ## Sovereignty (ADR-0005 / ADR-0007)
 *
 * Foreign presence carries presence + lifecycle metadata ONLY — identity,
 * capabilities, liveness state. The `agent.*` payload schema (the SAME shape a
 * local envelope uses) has NO interior fields (tool calls, prompts, diffs), so
 * interior leakage is structurally impossible: the registry stores exactly the
 * presence descriptor and nothing more. Peers never send interiors; the registry
 * never stores or exposes them.
 */

import type { Envelope } from "../myelin/envelope-validator";
import { getSignedByChain } from "../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../myelin/runtime";
import type { MyelinSubscriber } from "../myelin/subscriber";
import type { TrustResolver } from "../../common/agents/trust-resolver";
import type { FederatedPeerResolution } from "../../common/registry";
import type {
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../../common/types/cortex-config";
import type { SystemEventSource } from "../system-events";
import {
  emitFederationDenied,
  evaluateFederationGate,
  subjectMatches,
} from "../surface-router";
import { emitSystemAccessDenied } from "../emit-system-access-denied";
import { verifySignedByChain } from "../verify-signed-by-chain";
import {
  AccessDeniedDeduper,
  type DenialDecision,
  type DenialIdentity,
} from "../access-denied-dedup";
import { AgentPresenceRegistry } from "./registry";
import { AGENT_PRESENCE_TYPES } from "./envelopes";
import type { FederatedPresenceReceipts } from "./federated-presence-receipts";

/**
 * Subject pattern the FEDERATED subscriber binds — every peer principal/stack's
 * presence subtree. `federated.*.*.agent.>`: segment[1] (`*`) = any peer
 * PRINCIPAL, segment[2] (`*`) = any peer STACK, `agent.>` = any presence action.
 *
 * Unlike the B.3 stack-local pattern (which pins `{principal}.{stack}` to THIS
 * stack), the federated pattern is principal-WILDCARD: we want every peer's
 * presence, and WHICH peers are admissible is decided by the federation
 * accept-list gate at fold time — NOT by narrowing the subscription. (Narrowing
 * the subscription per-peer would couple the NATS bind to the peer roster and
 * miss the gate's deny/hop/anti-spoof checks; the gate is the trust boundary,
 * the subscription is just the firehose.)
 */
export function federatedAgentPresenceSubject(): string {
  return "federated.*.*.agent.>";
}

/** Lifecycle handle for the federated subscriber. */
export interface FederatedAgentPresenceSubscriberHandle {
  /**
   * Stop the federated subscriber: unregister the fan-out handler, drain the
   * push subscriber, AND remove every foreign record from the registry (so
   * disabling federation cleanly removes foreign agents — plan §4.5). The
   * registry's LOCAL records survive. Idempotent.
   */
  stop(): Promise<void>;
}

/** Options for {@link startFederatedAgentPresenceSubscriber}. */
export interface StartFederatedAgentPresenceSubscriberOptions {
  runtime: MyelinRuntime;
  /** The SHARED registry — same instance B.3 folds local presence into. */
  registry: AgentPresenceRegistry;
  /**
   * E.1 — federation policy. The OPT-IN switch: when `undefined` or
   * `networks[]` is empty, the subscriber is INERT — it does NOT subscribe to
   * `federated.*` at all, and no foreign presence is folded. Federation is
   * OPT-IN (the resolved plan §4.5 decision); a stack with no
   * `policy.federated.networks[]` sees zero foreign agents, byte-identical to
   * pre-E behaviour. Supplying at least one network opts the stack into folding
   * that network's accept-listed, chain-verified peer presence.
   */
  federated: PolicyFederated | undefined;
  /** Source identity for the `system.access.denied` audit envelopes on a gate drop. */
  source: SystemEventSource;
  /**
   * E.5 — chain-verification trust resolver. Mirrors the dispatch-listener:
   * when supplied (with `receivingAgentId`), every foreign presence envelope is
   * run through `verifySignedByChain` before folding. When `undefined`, the
   * structural+crypto chain check is SKIPPED — but the accept-list gate STILL
   * runs (the gate alone bounds which peers can appear; the chain check adds
   * cryptographic attribution under `enforce`). Production wiring supplies it.
   */
  trustResolver?: TrustResolver;
  /** Receiving agent id whose `trust:` list governs admitted signers. */
  receivingAgentId?: string;
  /** Principal id — required by the crypto-verify pass (threaded to myelin Principals). */
  principalId?: string;
  /** Whether the chain verifier runs ed25519 crypto verification. Default `true`. */
  cryptoVerify?: boolean;
  /**
   * Whether an empty `signed_by[]` chain is REJECTED — POSTURE-GATED, matching
   * the #484 dispatch-listener for federated inbound EXACTLY (do not invent a
   * different posture for presence).
   *
   * `cortex.ts` passes `signingKnobs.rejectEmpty` — the SAME value the
   * dispatch-listener / bus-dispatch-listener receive:
   *   - `signing: off`         → `false` → **accept-list-only trust**: an
   *     unsigned foreign envelope that PASSES the federation accept-list gate is
   *     folded. This is SAFE only because the record's identity is SOURCE-BOUND
   *     (PR #914 BLOCKER fix): an accept-listed peer can announce ONLY agents
   *     under its OWN `{principal}/{stack}` — never impersonate a local agent —
   *     so accept-list membership IS the trust boundary under `off`. (A
   *     `signing: off` stack federates DISPATCH the same way, so presence is
   *     consistent, not laxer.)
   *   - `signing: permissive`  → `false` → folds when accept-listed; ALSO crypto-
   *     verifies any present chain (cheap observability; doesn't reject on its own).
   *   - `signing: enforce`     → `true`  → an empty chain is REJECTED; foreign
   *     presence MUST carry a verifiable `signed_by[]` chain.
   *
   * Default `false` here (the #484-consistent off-posture) — but production
   * ALWAYS passes the posture-derived value explicitly.
   */
  rejectEmpty?: boolean;
  /** Receiving stack's signing DID (own-stack short-circuit in the verifier). */
  stackIdentity?: string;
  /** Receiving stack's NKey pubkey (crypto-verify pass for own-stack stamps). */
  stackNKeyPub?: string;
  /**
   * E.5 — federated peer-pubkey resolution seam. The SAME seam the
   * dispatch-listener uses (wired ONLY under `signing === "enforce"`). When
   * supplied, a foreign envelope's signer peer principal is resolved to a
   * verified Ed25519 identity before the crypto pass. `undefined` ⇒ foreign
   * presence verifies local-only (no registry peer resolution).
   */
  resolveFederatedPeer?: (
    peerPrincipal: string,
  ) => Promise<FederatedPeerResolution>;
  /**
   * cortex#1213 — windowed deduper for the `system.access.denied` audit emits
   * this consumer makes. A TEST SEAM: production omits it and a fresh
   * 60s-window deduper is created internally. Tests inject one with an injected
   * clock to assert "audited at most once per window".
   */
  denialDeduper?: AccessDeniedDeduper;
  /**
   * cortex#1213 — principal-facing "bubble up" hook, invoked ONCE per distinct
   * denial tuple (the first time it is seen). Default writes a clear WARN to
   * `process.stderr`; production may also route a notify/dashboard signal. A
   * self-deny or federation misconfig surfaces to the principal ONCE here
   * rather than re-spamming the audit subject every tick.
   */
  onDenialBubbleUp?: (info: DenialBubbleUp) => void;
  /**
   * FS-6 (cortex#1821) — per-peer received-presence ledger. When supplied, EVERY
   * `federated.{principal}.{stack}.agent.*` envelope that REACHES this subscriber
   * is recorded against its source principal here — **folded OR gated** (recorded
   * BEFORE the accept-list / chain-verify gates, so a peer we can physically hear
   * on the wire but that the gate later drops still reads as "heard"). The MC
   * verdict projection reads {@link FederatedPresenceReceipts.everReceived} to
   * split an absent peer into `absent-offline` (heard, went stale) vs
   * `absent-unheard` (never heard — an import/cred gap). OPTIONAL: omit it (tests
   * that don't exercise the ledger) and the subscriber behaves byte-identically.
   */
  receipts?: FederatedPresenceReceipts;
  /**
   * FS-6 — receiver clock stamped onto a received-presence receipt. Injectable so
   * a test can assert deterministic `lastAt` values. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * FS-1 (cortex#1825, design §3 D-1) — **presence-by-membership** oracle,
   * NETWORK-SCOPED. Pure, synchronous predicate: is `sourcePrincipal` an ADMITTED
   * member of the SPECIFIC network `networkId` (per the authoritative
   * admission-rows roster, ADR-0018 Q3)?
   *
   * The subscriber resolves the DELIVERING LEAF (`sourceLink`) → the network(s)
   * that leaf serves, then requires the source to be an admitted member OF THAT
   * network. This is the anti-spoof scoping (cortex#1825 review): a principal
   * admitted only on Network B can NEVER be membership-folded when its envelope
   * arrives on Network A's leaf, and a bare forgery on a leaf the source is not a
   * member of is refused. The fold fires ONLY when the gate denied with the
   * OFFERINGS precondition AND `unknown_network === true` (a source in NO
   * configured `peers[]` — never a config-declared peer whose `accept_subjects`
   * deliberately excludes presence). This drops the hand-pin/offerings
   * precondition for folding, NOT the crypto: GATE 2 (`verifySignedByChain`) +
   * source-binding are unchanged. Other deny kinds (deny_subjects, hop budget,
   * leaf anti-spoof) are SAFETY checks and are NEVER overridden. Omitted ⇒
   * defaults to "never a member" ⇒ byte-identical to pre-FS-1 (peers[]-only)
   * behaviour.
   */
  isAdmittedMemberOfNetwork?: (
    sourcePrincipal: string,
    networkId: string,
  ) => boolean;
  /**
   * FS-1 (cortex#1825) — principals for which a `peers[].principal_pubkey`
   * was HAND-PINNED in the ORIGINAL config (pre-resolution). DD-11 is
   * UNCHANGED for these: a hand-pinned peer keeps the exact pre-FS-1 path
   * (`resolveFederatedPeers`: matching pin → admit; mismatching pin → fail-closed
   * DROP), so it is NEVER re-admitted by membership — a membership-fold of a
   * hand-pinned peer would silently paper over a DD-11 pin-mismatch drop.
   * Presence-by-membership is for membership-ONLY peers (no local pin). Omitted ⇒
   * empty set (no hand-pins to exclude).
   */
  handPinnedPrincipals?: ReadonlySet<string>;
}

/** cortex#1213 — payload handed to {@link StartFederatedAgentPresenceSubscriberOptions.onDenialBubbleUp}. */
export interface DenialBubbleUp {
  /** The denied tuple (capability/subject/reason/source). */
  identity: DenialIdentity;
  /** Human-readable one-line summary (already includes a remediation hint). */
  message: string;
}

/**
 * Wire the trust-verified federated presence subscriber into the running
 * cortex. OPT-IN: when `federated` is absent / has no networks, returns an
 * INERT handle that subscribed to nothing (no firehose, no folds).
 *
 * NON-THROWING / best-effort, matching every other capability-side boot
 * feature: a subscribe failure logs + leaves the subscriber dormant. When
 * `runtime.enabled` is false (no NATS) the subscriber stays dormant.
 */
export async function startFederatedAgentPresenceSubscriber(
  opts: StartFederatedAgentPresenceSubscriberOptions,
): Promise<FederatedAgentPresenceSubscriberHandle> {
  const {
    runtime,
    registry,
    federated,
    source,
    trustResolver,
    receivingAgentId,
    principalId,
    stackIdentity,
    stackNKeyPub,
    resolveFederatedPeer,
    receipts,
  } = opts;
  const cryptoVerify = opts.cryptoVerify ?? true;
  // FS-1 (cortex#1825) — presence-by-membership oracle + DD-11 hand-pin guard.
  // Defaults keep pre-FS-1 behaviour: no membership-fold, no hand-pins.
  const isAdmittedMemberOfNetwork =
    opts.isAdmittedMemberOfNetwork ?? ((): boolean => false);
  const handPinnedPrincipals = opts.handPinnedPrincipals ?? new Set<string>();
  // FS-6 — receiver clock for received-presence receipts.
  const now = opts.now ?? Date.now;
  // cortex#1213 — dedupe the `system.access.denied` audit emits. Default to a
  // fresh 60s-window deduper; tests inject one with an injected clock.
  const denialDeduper = opts.denialDeduper ?? new AccessDeniedDeduper();
  // cortex#1213 — principal-facing bubble-up. Default: a clear WARN to stderr,
  // emitted ONCE per distinct denial tuple (the deduper's `firstSeen` flag).
  const onDenialBubbleUp =
    opts.onDenialBubbleUp ??
    ((info: DenialBubbleUp): void => {
      process.stderr.write(`[federated-presence] WARN ${info.message}\n`);
    });

  /**
   * cortex#1213 — emit a `system.access.denied` audit through the deduper.
   * `doEmit` performs the actual `runtime.publish` (via the existing
   * emitFederationDenied / emitSystemAccessDenied helpers). We call it ONLY
   * when the deduper says to (first occurrence or a post-window rollup), so a
   * genuinely-repeated denial is still audited — security preserved — but never
   * floods the bus. The first occurrence of each tuple also bubbles up ONCE.
   */
  const emitDeny = (id: DenialIdentity, doEmit: () => void): void => {
    const decision: DenialDecision = denialDeduper.decide(id);
    if (decision.firstSeen) {
      onDenialBubbleUp({
        identity: id,
        message:
          `federation denial: capability=${id.capability} subject=${id.subject} ` +
          `reason=${id.reason} source=${id.source} — verify this peer is on a ` +
          `shared network's peers[]/accept_subjects[] (or remove the federated ` +
          `publish if this is the stack's OWN presence looping back).`,
      });
    }
    if (decision.emit) doEmit();
  };

  /**
   * cortex#1213 — bubble up a non-audited condition (no `system.access.denied`
   * to emit) to the principal ONCE per distinct tuple. Routed through the SAME
   * deduper so it can never flood stderr on a per-tick loopback.
   */
  const bubbleUpOnce = (id: DenialIdentity, message: string): void => {
    if (denialDeduper.decide(id).firstSeen) {
      onDenialBubbleUp({ identity: id, message });
    }
  };
  // POSTURE-GATED, matching the #484 dispatch-listener EXACTLY: production passes
  // `signingKnobs.rejectEmpty` (off/permissive → false ⇒ accept-list-only trust;
  // enforce → true ⇒ require a verifiable chain). Default `false` mirrors the
  // off-posture. Safe under `off` ONLY because identity is source-bound (the
  // BLOCKER fix): an accept-listed peer can announce only its OWN agents.
  const rejectEmpty = opts.rejectEmpty ?? false;

  // E.1 — OPT-IN gate. No networks ⇒ federation is OFF for this stack: the
  // subscriber binds NOTHING and folds NOTHING. This is the resolved opt-in
  // default (plan §4.5).
  const networks = federated?.networks ?? [];
  if (networks.length === 0) {
    // Inert: nothing subscribed, nothing to fold, nothing to tear down.
    return { stop: (): Promise<void> => Promise.resolve() };
  }

  // Index networks by id for the gate (mirrors the surface-router /
  // dispatch-listener construction). The gate resolves the SOURCE network from
  // the SOURCE PRINCIPAL's `peers[]` membership — the network is never on the
  // wire (ADR-0001).
  const federatedNetworksById = new Map<string, PolicyFederatedNetwork>();
  for (const network of networks) {
    federatedNetworksById.set(network.id, network);
  }

  // FS-1 (cortex#1825 review) — DELIVERING-LEAF → network(s) index for the
  // membership-fold anti-spoof scope. A physical leaf (`leaf_node`) may be POOLED
  // by more than one network (config type: "two networks sharing a `leaf_node`
  // share one physical link"), so map each leaf to EVERY network that rides it.
  // The membership override requires the source to be admitted on one of the
  // networks the DELIVERING leaf serves — never a flat union across all joined
  // networks (which let a Network-B member fold on Network-A's leaf, cortex#1825
  // PROBE 1). `primary` is deliberately NOT indexed: it is the shared local link,
  // not a per-network isolation boundary (mirrors the F-3d gate's `primary` skip),
  // so a source arriving on `primary` can never satisfy the membership scope.
  const networkIdsByLeaf = new Map<string, string[]>();
  for (const network of networks) {
    if (network.leaf_node === "primary") continue;
    const existing = networkIdsByLeaf.get(network.leaf_node);
    if (existing !== undefined) existing.push(network.id);
    else networkIdsByLeaf.set(network.leaf_node, [network.id]);
  }

  /**
   * FS-1 (cortex#1825 review) — is `sourcePrincipal` an admitted member of a
   * network served by the DELIVERING leaf `sourceLink`? Fail-closed: an absent /
   * `primary` / unrecognised leaf yields false so the membership override never
   * fires without a dedicated-leaf attribution (closes the cross-network spoof
   * + the bare `signing:off` forgery on `primary`).
   */
  const isAdmittedOnDeliveringLeaf = (
    sourcePrincipal: string,
    sourceLink: string | undefined,
  ): boolean => {
    if (sourceLink === undefined || sourceLink === "primary") return false;
    const candidateNetworkIds = networkIdsByLeaf.get(sourceLink);
    if (candidateNetworkIds === undefined) return false;
    for (const networkId of candidateNetworkIds) {
      if (isAdmittedMemberOfNetwork(sourcePrincipal, networkId)) return true;
    }
    return false;
  };

  const pattern = federatedAgentPresenceSubject();

  // The set of valid presence `envelope.type` literals — a fast membership
  // check so a non-presence envelope that happens to match `agent.>` (none
  // exist today, but defensive) is ignored without a fold attempt.
  const presenceTypes = new Set<string>(AGENT_PRESENCE_TYPES);

  const handler: EnvelopeHandler = (envelope, subject, sourceLink) => {
    // Subject filter — only the federated presence subtree. The runtime fans
    // EVERY envelope to EVERY handler, so this handler must reject everything
    // that isn't a `federated.*.*.agent.*` subject (incl. the stack's own
    // `local.*` presence, which B.3 owns).
    if (!subjectMatches(pattern, subject)) return;
    if (!presenceTypes.has(envelope.type)) return;

    const sourcePrincipal = envelope.source.split(".")[0] ?? envelope.source;

    // === FS-6 (cortex#1821) — RECEIVED-PRESENCE RECEIPT ===================
    // Record that we HEARD a federated-presence envelope from this source
    // principal, BEFORE any gate runs — folded OR gated. This is the whole
    // point: "unheard" must mean nothing arrived on the wire (an import/cred
    // gap), not arrived-but-policy-dropped. A peer we can physically hear but
    // whose envelope the accept-list gate later drops is still HEARD here, so
    // the roster reports it `absent-offline` (a config choice, visible
    // elsewhere), never the misleading `absent-unheard`. The self-loopback of
    // our OWN presence is recorded too, but our own principal is never
    // evaluated as an absent peer, so it is inert in the verdict.
    receipts?.record(sourcePrincipal, now());

    // === SELF-LOOPBACK SHORT-CIRCUIT (cortex#1213, mirrors cortex#480) =====
    // A federated stack publishes its OWN presence onto `federated.{us}.agent.>`
    // so peers see it; that publish LOOPS BACK to this subscriber. The
    // accept-list gate below would then deny it (we are not our own peer →
    // `peer_not_in_accept_list` / `unknown_network`) and audit it on EVERY
    // heartbeat tick — a self-deny FLOOD (#1213).
    //
    // Detect the self-claim the SAME way `verifySignedByChain` does (cortex#480):
    // the SOURCE stamp's `identity` equals the receiving stack's OWN signing DID
    // (`stackIdentity`, from config — NOT the spoofable `envelope.source` /
    // `payload` fields). When it matches, SKIP the federation accept-list (TRUST)
    // gate — but the crypto bytes-check below STILL runs against `stackNKeyPub`,
    // so a spoofed self-DID without our private key is rejected exactly as a
    // forged foreign envelope. A crypto-verified self-loopback is silently
    // DROPPED (B.3 already folds our LOCAL presence — we never fold our own as a
    // foreign record) and emits NO deny-audit.
    const claimsOwnStack =
      stackIdentity !== undefined &&
      getSignedByChain(envelope)[0]?.identity === stackIdentity;

    // === TRUST GATE 1 — federation accept-list (E.5) ======================
    // Mirror of the dispatch-listener's Option-D gate (cortex#484). A foreign
    // presence envelope from a peer NOT in any configured network's `peers[]`,
    // OR on a denied subject, OR over the hop budget, OR cross-network-spoofed
    // on the wrong leaf, is DROPPED here — never folded. The audit envelope
    // makes the drop observable (deduped per #1213 so a repeat can't flood).
    // SKIPPED for a self-loopback claim (the short-circuit above) — our own DID
    // is never in our own `peers[]`, and the bytes-check (GATE 2) is the real
    // boundary for a self-claim.
    if (!claimsOwnStack) {
      const decision = evaluateFederationGate(
        subject,
        envelope,
        federatedNetworksById,
        sourceLink,
      );
      if (decision !== "allow") {
        // FS-1 (cortex#1825, D-1) — PRESENCE-BY-MEMBERSHIP override, LEAF-SCOPED.
        // The OFFERINGS precondition — `peer_not_in_accept_list` with
        // `unknown_network === true` (a source in NO configured `peers[]` at all) —
        // is DROPPED for presence: an ADMITTED member of the verified admission
        // roster (ADR-0018 Q3) folds even with no `peers[]` offering, PROVIDED it is
        // admitted on a network served by the DELIVERING leaf. This drops the
        // hand-pin/offerings precondition, NOT the crypto: GATE 2
        // (`verifySignedByChain`) + source-binding run UNCHANGED below.
        //
        // ONLY the `unknown_network` variant of `peer_not_in_accept_list` is an
        // offering precondition. The NON-`unknown_network` variant — a
        // config-declared peer whose `accept_subjects` deliberately excludes the
        // presence subtree — is the principal's EXPLICIT narrowing and is NEVER
        // overridden by membership (cortex#1825 PROBE 2). `peer_deny_list`,
        // `max_hop_exceeded`, and `source_link_mismatch` are SAFETY / anti-spoof
        // checks — NEVER overridden by membership (a member on a deny-listed subject,
        // over the hop budget, or spoofed onto the wrong leaf is still hard-denied).
        //
        // DD-11 UNCHANGED: a HAND-PINNED peer keeps the exact pre-FS-1 path
        // (`resolveFederatedPeers`: matching pin → admit; mismatching pin →
        // fail-closed drop). It is NEVER re-admitted by membership — that would
        // silently paper over a DD-11 pin-mismatch drop. Membership-fold is for
        // membership-ONLY peers (no local pin).
        //
        // cortex#1825 review — TWO anti-spoof scopes make membership no weaker
        // than the pre-existing accept-list posture:
        //   (a) `unknown_network === true` — the source resolved to NO configured
        //       `peers[]` at all. A config-declared peer whose `accept_subjects`
        //       deliberately excludes presence denies with the SAME `kind` but
        //       WITHOUT `unknown_network`; its explicit narrowing must NEVER be
        //       overridden by membership (PROBE 2).
        //   (b) `isAdmittedOnDeliveringLeaf` — the source must be an admitted
        //       member of a network served by the DELIVERING leaf (`sourceLink`),
        //       not merely admitted on SOME joined network. This closes the
        //       cross-network / cross-leaf impersonation (PROBE 1) and the bare
        //       `signing:off` forgery attributed to `primary` (finding #2), which
        //       the flat union + skipped F-3d check previously let through.
        const foldByMembership =
          decision.kind === "peer_not_in_accept_list" &&
          decision.unknown_network === true &&
          !handPinnedPrincipals.has(sourcePrincipal) &&
          isAdmittedOnDeliveringLeaf(sourcePrincipal, sourceLink);
        if (!foldByMembership) {
          emitDeny(
            {
              capability: "federated.subject_dispatch",
              subject,
              reason: decision.kind,
              source: sourcePrincipal,
            },
            () => {
              emitFederationDenied(runtime, source, envelope, subject, decision);
            },
          );
          return;
        }
        // Admitted member, no offering, no hand-pin → fold BY MEMBERSHIP. Fall
        // through to GATE 2 (crypto/source-binding UNCHANGED). Grep-friendly line
        // so the pilot loop / on-call can confirm the D-1 path fired.
        process.stderr.write(
          `federated-agent-presence: folding ${envelope.type} (id=${envelope.id}) ` +
            `from ADMITTED member "${sourcePrincipal}" by MEMBERSHIP ` +
            `(no peers[] offering; D-1 presence-by-membership)\n`,
        );
      }
    }

    // === TRUST GATE 2 — signed_by[] chain verification (E.5) ===============
    // The chain check is async; fold happens in its `.then`. A verification
    // failure DROPS the envelope (never folds). When no `trustResolver` /
    // `receivingAgentId` is wired, the chain check is skipped (the gate above
    // still bounded which peers can appear) and the envelope folds directly.
    //
    // For a self-loopback claim this is THE security check — the cortex#480
    // own-stack short-circuit inside `verifySignedByChain` accepts the stamp
    // structurally, then the crypto pass verifies the bytes against
    // `stackNKeyPub`. The `resolveFederatedPeer` seam is OMITTED for a
    // self-claim: the signer is our OWN stack, not a federated peer, so there is
    // nothing to resolve (resolving ourselves as a peer would wrongly reject).
    if (trustResolver !== undefined && receivingAgentId !== undefined) {
      void verifySignedByChain(envelope, {
        resolver: trustResolver,
        receivingAgentId,
        rejectEmpty,
        cryptoVerify,
        ...(principalId !== undefined && { principalId }),
        ...(stackIdentity !== undefined && { stackIdentity }),
        ...(stackNKeyPub !== undefined && { stackNKeyPub }),
        ...(!claimsOwnStack &&
          resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
      })
        .then((result) => {
          if (!result.valid) {
            // Chain failed — DROP. A presence envelope that can't be
            // cryptographically attributed never appears in the view. For a
            // self-claim this is the spoofed-self path (a forged self-DID whose
            // bytes don't verify against our NKey) — STILL rejected + audited.
            process.stderr.write(
              `federated-agent-presence: dropping ${claimsOwnStack ? "self-claimed" : "foreign"} presence ${envelope.type} ` +
                `(id=${envelope.id}) — signed_by chain verification failed: ` +
                `${result.reason.kind}\n`,
            );
            // cortex#932 — emit a queryable `system.access.denied` on our local
            // audit stream so governance sees the chain-verify rejection.
            // Deduped (#1213) so a repeated bad signer can't flood.
            emitDeny(
              {
                capability: envelope.type,
                subject,
                reason: "chain_verify_failed",
                source: sourcePrincipal,
              },
              () => {
                emitSystemAccessDenied(runtime, source, envelope, {
                  envelopeSubject: subject,
                  principalId: sourcePrincipal,
                  capability: envelope.type,
                  reason: {
                    kind: "chain_verify_failed",
                    verify_reason: result.reason.kind,
                  },
                });
              },
            );
            return;
          }
          // Verified. A self-loopback is OUR OWN presence — silently DROP (do
          // NOT fold our own agents as foreign records; B.3 owns the local copy).
          if (claimsOwnStack) return;
          foldForeign(registry, envelope);
        })
        .catch((err: unknown) => {
          // A verifier fault must never crash the fan-out — log + drop (fail
          // closed: an envelope we couldn't verify is not folded).
          const faultMessage = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `federated-agent-presence: chain verify threw for ${envelope.type} ` +
              `(id=${envelope.id}) — dropping: ` +
              `${faultMessage}\n`,
          );
          // cortex#932 — a verifier FAULT is also a fail-closed drop; make it
          // observable on the local audit stream (distinct reason kind from a
          // clean chain rejection). Deduped (#1213).
          emitDeny(
            {
              capability: envelope.type,
              subject,
              reason: "chain_verify_fault",
              source: sourcePrincipal,
            },
            () => {
              emitSystemAccessDenied(runtime, source, envelope, {
                envelopeSubject: subject,
                principalId: sourcePrincipal,
                capability: envelope.type,
                reason: { kind: "chain_verify_fault", fault: faultMessage },
              });
            },
          );
        });
      return;
    }

    // No chain verifier wired. A self-loopback claim CANNOT be cryptographically
    // verified here, so we cannot fold it (it would be our own presence anyway)
    // — DROP it silently to stop the self-deny flood; the once-per-tuple
    // bubble-up notes it is unverifiable. A foreign envelope folds directly (the
    // accept-list gate already bounded the admissible peers).
    if (claimsOwnStack) {
      bubbleUpOnce(
        {
          capability: envelope.type,
          subject,
          reason: "self_loopback_unverifiable",
          source: sourcePrincipal,
        },
        `self-loopback presence ${envelope.type} on ${subject} dropped — no ` +
          `chain verifier wired to confirm the self-signature; not folded.`,
      );
      return;
    }
    foldForeign(registry, envelope);
  };

  const registration = runtime.onEnvelope(handler);

  // Self-subscribe to the federated presence firehose (cortex#477 push-mode
  // seam). Best-effort: a subscribe failure leaves the subscriber dormant
  // (still registered as a handler, but no NATS interest declared).
  let subscriber: MyelinSubscriber | null = null;
  try {
    subscriber = (await runtime.subscribe?.(pattern)) ?? null;
    if (runtime.enabled && subscriber === null) {
      process.stderr.write(
        `federated-agent-presence: runtime.subscribe(${pattern}) returned null — ` +
          `subscriber will only see envelopes from other static subscriptions\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `federated-agent-presence: subscribe(${pattern}) failed (non-fatal — dormant): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  let stopped = false;
  return {
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      registration.unregister();
      if (subscriber) {
        await subscriber.stop();
      }
      // Disabling federation cleanly removes foreign agents (plan §4.5). The
      // registry's local records survive.
      registry.removeForeign();
    },
  };
}

/**
 * Fold a TRUST-VERIFIED foreign presence envelope into the registry, deriving
 * the provenance `{principal}` + `{stack}` from the envelope's SOURCE (the
 * signing identity). `envelope.source` is `{principal}.{stack}.{instance}[...]`,
 * so segment[0] is the bare principal and segment[1] the bare stack slug.
 *
 * The derived `{principal}/{stack}` is the CHAIN-VERIFIED identity (the source
 * was bound to a verified pubkey by the chain check above). It is passed to
 * {@link AgentPresenceRegistry.applyForeign} as the `verifiedScope` — the
 * AUTHORITATIVE identity for the record's key + principal + stack. The registry
 * cross-checks the envelope's `payload.scope` against it and DROPS the envelope
 * if they disagree (a spoof attempt), so a peer can paint records ONLY under its
 * OWN verified identity and can never collide with / overwrite a local record
 * (PR #914 review BLOCKER fix).
 *
 * A source with fewer than two segments (defensive — the schema forbids it) is
 * dropped rather than folded as an originless record.
 */
function foldForeign(registry: AgentPresenceRegistry, envelope: Envelope): void {
  const segments = envelope.source.split(".");
  const principal = segments[0];
  const stack = segments[1];
  if (
    principal === undefined ||
    principal.length === 0 ||
    stack === undefined ||
    stack.length === 0
  ) {
    process.stderr.write(
      `federated-agent-presence: dropping foreign presence ${envelope.type} ` +
        `(id=${envelope.id}) — could not derive {principal}/{stack} provenance from source "${envelope.source}"\n`,
    );
    return;
  }
  registry.applyForeign(envelope, { principal, stack });
}

/**
 * Re-export for the boot wiring's hop-budget sanity: a foreign presence chain
 * is bounded by `max_hop` inside the gate, but a caller that wants to inspect
 * the observed hop count (diagnostics) reads it the same way the gate does.
 */
export function observedHops(envelope: Envelope): number {
  return getSignedByChain(envelope).length;
}
