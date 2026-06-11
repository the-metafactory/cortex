/**
 * P-14 U3.3 (#937) — TRUST-VERIFIED federated OBSERVABILITY fold (the TRUST-PATH
 * FINALE of the P-14 federated-fold line).
 *
 * The observability sibling of {@link startFederatedAgentPresenceSubscriber}.
 * Where that subscriber folds TRUST-VERIFIED FOREIGN agent PRESENCE
 * (`federated.{principal}.{stack}.agent.>`) into the shared presence registry,
 * THIS module folds TRUST-VERIFIED FOREIGN OBSERVABILITY
 * (`federated.{principal}.{stack}.system.{transport,federation}.>`) into the MC
 * observability projection — ORIGIN-BADGED by peer `{principal}/{stack}`, through
 * the SAME Option-D trust path. It serves cortex#21 (network-wide consolidation):
 * a peer's curated substrate-health observability appears on the principal's
 * Observability tab + Network-view transport overlay, attributed to the peer.
 *
 * ## THE DESIGN QUESTION (resolved against the existing U2.1 path)
 *
 * **Doesn't the U2.1 observability renderer ALREADY fold `federated.*` rows?**
 * It subscribes to `federated.*.*.system.{signal,federation,transport}.>` and is
 * a `SurfaceAdapter`, so the surface-router's `evaluateFederationGate` DOES run
 * on its inbound. So why a second path?
 *
 * Because the SurfaceAdapter path has THREE trust gaps for a CROSS-PRINCIPAL
 * fold that this module closes:
 *
 *   1. **No chain verification.** The surface-router gate is accept-list /
 *      deny-list / hop-budget / anti-spoof ONLY — it does NOT run
 *      `verifySignedByChain`. A peer envelope with forged BYTES that happens to
 *      pass the accept-list would fold. U3.3 requires cryptographic
 *      verification before fold (the #914 precedent).
 *   2. **No origin binding.** U2.1's `originStackId()` reads `payload.stack_id` —
 *      ATTACKER-CONTROLLED. A peer could paint a local-looking origin. U3.3
 *      requires the origin be derived from the CHAIN-VERIFIED `source`.
 *   3. **No curation gate.** U2.1 subscribes to `federated.*.*.system.signal.>` —
 *      which would fold the DENIED `system.signal.*` class if a peer's network
 *      `accept_subjects` permitted it. U3.3 requires cortex's OWN curation gate
 *      (signal#141 recipe — ALLOW `system.{transport,federation}.>` only).
 *
 * So at U3.3 the U2.1 renderer is NARROWED to LOCAL subjects only
 * (`local.*.…`), and ALL `federated.*` observability flows through THIS
 * trust-verified path. This MIRRORS the federated-subscriber's resolution of the
 * identical question (cortex#484 / #914): a cross-principal consumer that needs
 * chain verification + source-bound identity grows its OWN inline trust path; it
 * does NOT rely on the surface-router gate (which covers neither).
 *
 * ## The trust path (mirrors federated-subscriber.ts EXACTLY, + the curation gate)
 *
 * For every inbound `federated.*.*.system.>` envelope, in order:
 *
 *   0. **Curation gate** — {@link evaluateObservabilityCuration} on the envelope
 *      TYPE. ALLOW `system.{transport,federation}.>`; everything else
 *      (`trace.>`, `metric.>`, `log.>`, `session.>`, `system.signal.*`, any
 *      novel class) is DROPPED, fail-closed. This is the load-bearing NEGATIVE
 *      CONTROL: a peer's non-exported class never reaches the fold. (No denial
 *      envelope here — a non-curated class is not a TRUST failure, it's simply
 *      out of cortex's bounded context; emitting `system.access.denied` for
 *      every peer `trace.>` tick would be noise. The trust-failure denials below
 *      are reserved for accept-list / chain-verify drops.)
 *   1. **Federation accept-list gate** — {@link evaluateFederationGate} on the
 *      wire subject + envelope, against the principal's `policy.federated`. A
 *      non-allowlisted peer / denied subject / over-budget hop / cross-network
 *      spoof is DROPPED + emits `emitFederationDenied` (the same audit path the
 *      router + presence subscriber use).
 *   2. **`signed_by[]` chain verification** — {@link verifySignedByChain} with
 *      the SAME `resolveFederatedPeer` seam (wired only under
 *      `signing === "enforce"`). A chain failure DROPS the envelope + emits
 *      `system.access.denied (chain_verify_failed)` via the U0.2 path
 *      ({@link emitSystemAccessDenied}). A verifier FAULT drops + emits
 *      `chain_verify_fault`. Posture-gated empty-chain handling via `rejectEmpty`
 *      — identical to the presence subscriber + #484 dispatch-listener.
 *
 * Only an envelope that clears ALL of curation + accept-list + chain is folded.
 *
 * ## SOURCE-BOUND ORIGIN (the #914 BLOCKER pattern, applied to observability)
 *
 * The folded row's ORIGIN BADGE — the peer `{principal}/{stack}` — is derived
 * from the CHAIN-VERIFIED `envelope.source`, NEVER from the attacker-controlled
 * payload. {@link foldVerifiedObservability} splits `source` into
 * `{principal}/{stack}` and passes it as the row's `origin: { kind: "foreign";
 * peer }`. So an accept-listed peer's observability can be badged ONLY under its
 * OWN verified identity — it can NEVER be shown as local, and a foreign row can
 * never masquerade as this principal's substrate health. This is the
 * negative-control's identity half.
 *
 * ## Sovereignty (ADR-0005)
 *
 * The curation gate's ALLOW-list is exactly the substrate-health classes
 * (transport liveness/verdicts, federation roster) — NEVER the session interior
 * (`trace.>` = OTLP spans = tool calls/prompts/diffs, always `local` scope per
 * CONTEXT.md §Session interior). Interior leakage is structurally impossible:
 * `trace.>` is denied at gate 0, and the interior never publishes `federated.`
 * in the first place. cortex consumes ONLY the curated exterior.
 *
 * ## /wire-check posture — this is a CONSUMER, not a dispatcher
 *
 * This module INGESTS curated+signed peer observability. It NEVER publishes onto
 * `federated.*` (the only thing it emits is LOCAL `system.access.denied` audit
 * envelopes on a trust drop, via the U0.2 path — those ride the local audit
 * subject derived from `source`, never the wire). The load-bearing wire-check
 * invariant (never leak LOCAL interiors back onto the wire) holds by
 * construction: there is no publish-to-federation path here at all.
 *
 * ## Dependency direction
 *
 * `bus/` never imports `surface/mc/` (layering: surface → bus). So the
 * projection write is an INJECTED `foldObservability` callback (wired in
 * cortex.ts to the observability projection + WS broadcast). This module owns the
 * TRUST PATH; the callback owns the DB write. Clean seam, testable in isolation
 * with a recording fake.
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
import { evaluateObservabilityCuration } from "./federated-observability-curation";

/**
 * Subject pattern the FEDERATED observability subscriber binds — every peer
 * principal/stack's `system.>` subtree. `federated.*.*.system.>`: segment[1]
 * (`*`) = any peer PRINCIPAL, segment[2] (`*`) = any peer STACK, `system.>` =
 * any system observability action. Intentionally broad at the bind; the
 * authoritative narrowing is the CURATION gate at fold time (`system.signal.*`
 * matches `system.>` on the wire but is denied at the gate) — mirroring the
 * presence subscriber's "subscription is the firehose, the gate is the trust
 * boundary" stance.
 */
export function federatedObservabilitySubject(): string {
  return "federated.*.*.system.>";
}

/**
 * The CHAIN-VERIFIED, CURATED foreign observability envelope handed to the
 * injected projection callback. Carries the source-bound peer identity so the
 * projection writes the origin badge from a VERIFIED value, never the payload.
 */
export interface FoldedObservability {
  envelope: Envelope;
  /** The wire subject the envelope arrived on. */
  subject: string;
  /** CHAIN-VERIFIED peer `{principal}/{stack}` (the origin badge). */
  peer: string;
}

/**
 * Injected projection write. cortex.ts wires this to the observability
 * projection (insert the row with `origin: { kind: "foreign"; peer }` + WS
 * broadcast). Returns nothing — fire-and-forget; a projection error is the
 * callback's own to swallow (the projection layer is non-throwing by contract).
 */
export type FoldObservabilityFn = (folded: FoldedObservability) => void;

/** Lifecycle handle for the federated observability fold. */
export interface FederatedObservabilityFoldHandle {
  /**
   * Stop the fold: unregister the fan-out handler + drain the push subscriber.
   * Idempotent. (Unlike presence, projected observability ROWS are an
   * append-only history retained by db/retention.ts — disabling federation
   * stops folding NEW peer rows but does not retro-delete projected history;
   * that is retention's job, identical to how local rows age out.)
   */
  stop(): Promise<void>;
}

/** Options for {@link startFederatedObservabilityFold}. */
export interface StartFederatedObservabilityFoldOptions {
  runtime: MyelinRuntime;
  /**
   * The projection write — wired in cortex.ts to insert the origin-badged row.
   * MUST be supplied; without it the fold is pointless (and the subscriber stays
   * inert rather than verifying envelopes it then drops on the floor).
   */
  foldObservability: FoldObservabilityFn;
  /**
   * Federation policy — the OPT-IN switch. When `undefined` or `networks[]` is
   * empty, the fold is INERT (no subscription, no folds), byte-identical to
   * pre-U3.3 behaviour. Mirrors the presence subscriber's opt-in default.
   */
  federated: PolicyFederated | undefined;
  /** Source identity for the `system.access.denied` / federation-denied audit envelopes. */
  source: SystemEventSource;
  /** Chain-verification trust resolver (mirrors the presence subscriber). */
  trustResolver?: TrustResolver;
  /** Receiving agent id whose `trust:` list governs admitted signers. */
  receivingAgentId?: string;
  /** Principal id — threaded to the crypto-verify pass. */
  principalId?: string;
  /** Whether the chain verifier runs ed25519 crypto verification. Default `true`. */
  cryptoVerify?: boolean;
  /** Posture-gated empty-chain rejection (off/permissive → false; enforce → true). */
  rejectEmpty?: boolean;
  /** Receiving stack's signing DID (own-stack short-circuit in the verifier). */
  stackIdentity?: string;
  /** Receiving stack's NKey pubkey (crypto-verify pass for own-stack stamps). */
  stackNKeyPub?: string;
  /** Federated peer-pubkey resolution seam (wired only under `signing === "enforce"`). */
  resolveFederatedPeer?: (
    peerPrincipal: string,
  ) => Promise<FederatedPeerResolution>;
}

/**
 * Wire the trust-verified federated observability fold into the running cortex.
 * OPT-IN: inert when `federated` is absent / has no networks.
 *
 * NON-THROWING / best-effort, matching every other capability-side boot feature.
 */
export async function startFederatedObservabilityFold(
  opts: StartFederatedObservabilityFoldOptions,
): Promise<FederatedObservabilityFoldHandle> {
  const {
    runtime,
    foldObservability,
    federated,
    source,
    trustResolver,
    receivingAgentId,
    principalId,
    stackIdentity,
    stackNKeyPub,
    resolveFederatedPeer,
  } = opts;
  const cryptoVerify = opts.cryptoVerify ?? true;
  // Posture-gated, matching the presence subscriber + #484 dispatch-listener.
  const rejectEmpty = opts.rejectEmpty ?? false;

  // OPT-IN gate — no networks ⇒ inert (no firehose, no folds).
  const networks = federated?.networks ?? [];
  if (networks.length === 0) {
    return { stop: (): Promise<void> => Promise.resolve() };
  }

  const federatedNetworksById = new Map<string, PolicyFederatedNetwork>();
  for (const network of networks) {
    federatedNetworksById.set(network.id, network);
  }

  const pattern = federatedObservabilitySubject();

  const handler: EnvelopeHandler = (envelope, subject, sourceLink) => {
    // Subject filter — only the federated `system.>` subtree (the runtime fans
    // EVERY envelope to EVERY handler, so reject everything else, incl. local
    // `system.*` which the U2.1 renderer owns).
    if (!subjectMatches(pattern, subject)) return;

    // === GATE 0 — CURATION (signal#141 recipe; the NEGATIVE CONTROL) =========
    // ALLOW only `system.{transport,federation}.>`. A peer's non-exported class
    // (`system.signal.*`, or — if a misconfigured peer somehow routed them onto
    // `system.>` — anything else) is DROPPED here, BEFORE any trust work. This
    // is the load-bearing exclusion: a denied class can NEVER appear in MC.
    if (evaluateObservabilityCuration(envelope.type).kind !== "allow") {
      // Out-of-context, not a trust failure → no audit envelope (would be noise).
      return;
    }

    // === GATE 1 — FEDERATION ACCEPT-LIST =====================================
    const decision = evaluateFederationGate(
      subject,
      envelope,
      federatedNetworksById,
      sourceLink,
    );
    if (decision !== "allow") {
      emitFederationDenied(runtime, source, envelope, subject, decision);
      return;
    }

    // === GATE 2 — signed_by[] CHAIN VERIFICATION =============================
    if (trustResolver !== undefined && receivingAgentId !== undefined) {
      void verifySignedByChain(envelope, {
        resolver: trustResolver,
        receivingAgentId,
        rejectEmpty,
        cryptoVerify,
        ...(principalId !== undefined && { principalId }),
        ...(stackIdentity !== undefined && { stackIdentity }),
        ...(stackNKeyPub !== undefined && { stackNKeyPub }),
        ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
      })
        .then((result) => {
          if (!result.valid) {
            // Chain failed — DROP. A foreign observability envelope that can't
            // be cryptographically attributed never appears in the view.
            process.stderr.write(
              `federated-observability: dropping foreign observability ${envelope.type} ` +
                `(id=${envelope.id}) — signed_by chain verification failed: ` +
                `${result.reason.kind}\n`,
            );
            // cortex#932 (U0.2) — make the chain-verify drop queryable on the
            // local audit stream. Carries signed_by[] verbatim. REUSES the
            // exact emit path the presence subscriber uses.
            emitSystemAccessDenied(runtime, source, envelope, {
              envelopeSubject: subject,
              principalId: envelope.source.split(".")[0] ?? envelope.source,
              capability: envelope.type,
              reason: {
                kind: "chain_verify_failed",
                verify_reason: result.reason.kind,
              },
            });
            return;
          }
          foldVerifiedObservability(foldObservability, envelope, subject);
        })
        .catch((err: unknown) => {
          // A verifier FAULT must never crash the fan-out — log + drop (fail
          // closed). Distinct reason kind so governance tells "verifier broke"
          // from "signature didn't verify".
          const faultMessage = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `federated-observability: chain verify threw for ${envelope.type} ` +
              `(id=${envelope.id}) — dropping: ${faultMessage}\n`,
          );
          emitSystemAccessDenied(runtime, source, envelope, {
            envelopeSubject: subject,
            principalId: envelope.source.split(".")[0] ?? envelope.source,
            capability: envelope.type,
            reason: { kind: "chain_verify_fault", fault: faultMessage },
          });
        });
      return;
    }

    // No chain verifier wired — fold directly (the accept-list + curation gates
    // already bounded the admissible peers + classes). Matches the presence
    // subscriber's no-resolver branch.
    foldVerifiedObservability(foldObservability, envelope, subject);
  };

  const registration = runtime.onEnvelope(handler);

  // Self-subscribe to the federated observability firehose. Best-effort.
  let subscriber: MyelinSubscriber | null = null;
  try {
    subscriber = (await runtime.subscribe?.(pattern)) ?? null;
    if (runtime.enabled && subscriber === null) {
      process.stderr.write(
        `federated-observability: runtime.subscribe(${pattern}) returned null — ` +
          `fold will only see envelopes from other static subscriptions\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `federated-observability: subscribe(${pattern}) failed (non-fatal — dormant): ` +
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
    },
  };
}

/**
 * Fold a TRUST-VERIFIED, CURATED foreign observability envelope by deriving the
 * source-bound peer `{principal}/{stack}` from the CHAIN-VERIFIED
 * `envelope.source` (segment[0]/segment[1]) and handing it to the injected
 * projection callback as the `peer` origin badge.
 *
 * `envelope.source` is `{principal}.{stack}.{instance}[...]`. A source with
 * fewer than two segments (defensive — the schema forbids it) is dropped rather
 * than folded as an originless row, so a foreign row is ALWAYS attributable.
 *
 * Exported for direct unit testing of the source-binding.
 */
export function foldVerifiedObservability(
  foldObservability: FoldObservabilityFn,
  envelope: Envelope,
  subject: string,
): void {
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
      `federated-observability: dropping foreign observability ${envelope.type} ` +
        `(id=${envelope.id}) — could not derive {principal}/{stack} provenance ` +
        `from source "${envelope.source}"\n`,
    );
    return;
  }
  foldObservability({ envelope, subject, peer: `${principal}/${stack}` });
}

/**
 * Re-export for the boot wiring's hop-budget sanity (mirror of the presence
 * subscriber's helper).
 */
export function observedHops(envelope: Envelope): number {
  return getSignedByChain(envelope).length;
}
