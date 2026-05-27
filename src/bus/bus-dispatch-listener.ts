/**
 * IAW Phase B.2a (cortex#114) — `BusDispatchListener`.
 *
 * Listens on the local `MyelinRuntime` for inbound `dispatch.task.*`
 * envelopes from peer bots (i.e. envelopes that did NOT originate from
 * this cortex's own publish path). Verifies each envelope's
 * `signed_by[]` chain via `verifySignedByChain` (cryptoVerify-gated by
 * whether the receiving agent has an `nkey_pub` declared), then surfaces
 * the receipt as a `system.bus.peer_dispatch_received` visibility event.
 *
 * **What this slice delivers (B.2a — inbound listener half of B.2):**
 *   - Subscribes via `runtime.onEnvelope` and filters for
 *     `dispatch.task.dispatched` envelopes whose source is a peer (not
 *     our own publish).
 *   - Verifies the chain (structural always; cryptographic when the
 *     receiving agent has an `nkey_pub`).
 *   - Emits a structured `system.bus.peer_dispatch_received` envelope
 *     on every valid arrival — operators see "peer X dispatched a task
 *     to us at <time>" on the dashboard / audit trail.
 *   - Drops invalid envelopes with a stderr log carrying the structured
 *     `ChainRejectionReason` discriminator.
 *
 * **What this slice deliberately doesn't do (deferred to B.2a+ / B.2b):**
 *   - **No DispatchHandler routing.** `DispatchHandler.handleMessage`'s
 *     `InboundMessage` shape is platform-specific (Discord/Mattermost
 *     fields like `channelId`, `authorId`). Mapping a bus envelope onto
 *     that shape is a real adapter — designed alongside Phase C's
 *     PolicyEngine (cortex#107) which natively takes a `Principal`
 *     rather than a platform-user-id. Until that lands, this listener
 *     is a visibility-only surface: cortex *knows* peers are dispatching
 *     to it, but doesn't *act* on those dispatches yet.
 *   - **No outbound peer dispatch.** That's B.2b (tracked at cortex#202)
 *     — the LLM-driven publish side.
 *   - **No Discord trustedBotIds retirement.** The legacy bot-to-bot
 *     Discord @-mention path stays operational until B.2a + B.2b both
 *     land in production and operators flip the deprecation flag.
 *
 * **Cross-references:**
 *   - cortex#114 — IAW Phase B umbrella
 *   - cortex#202 — B.2b outbound side
 *   - cortex#194 (B.1a) — `verifySignedByChain` primitive
 *   - cortex#200 (B.1c) — cryptographic verification
 *   - cortex#195 (B.1b) — `BusPeerHarness` (the publish-and-collect peer
 *     this listener pairs with on outbound dispatches)
 */

import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import type { TrustResolver } from "../common/agents/trust-resolver";
import { verifySignedByChain } from "./verify-signed-by-chain";
import {
  createSystemBusPeerDispatchReceivedEvent,
  type SystemEventSource,
} from "./system-events";

// =============================================================================
// Constructor options
// =============================================================================

export interface BusDispatchListenerOpts {
  /** Runtime to subscribe through. */
  runtime: MyelinRuntime;
  /** Trust resolver for chain verification. */
  resolver: TrustResolver;
  /**
   * Agent id of the receiving side — whose `trust:` list governs which
   * peer signers we admit. Single-agent stacks pass their sole agent's
   * id; multi-agent stacks pass the agent that handles bus-peer routing
   * (typically a designated `peer-router` agent in cortex.yaml).
   */
  receivingAgentId: string;
  /**
   * Principal id (e.g. `andreas`). Threaded into the myelin
   * `PrincipalRegistry` constructed by `verifySignedByChain`'s crypto
   * path. Required even when `cryptoVerify: false` so the listener can
   * flip the flag on later without re-threading.
   */
  principalId: string;
  /**
   * Source attribution for emitted visibility events. Same shape the
   * runner already builds for `dispatch.task.*` and `system.*` event
   * constructors.
   */
  source: SystemEventSource;
  /**
   * When true, runs the cryptographic verification step in addition to
   * the structural trust check. Default `false` — structural-only at
   * this slice. Operators flip this on once every trusted peer has an
   * `nkey_pub` declared on the agent (B.1c primitives are in place;
   * the missing piece is config-side opt-in).
   */
  cryptoVerify?: boolean;
}

// =============================================================================
// Listener
// =============================================================================

export class BusDispatchListener {
  private readonly runtime: MyelinRuntime;
  private readonly resolver: TrustResolver;
  private readonly receivingAgentId: string;
  private readonly principalId: string;
  private readonly source: SystemEventSource;
  private readonly cryptoVerify: boolean;

  private registration: { unregister: () => void } | undefined;
  /**
   * Set of in-flight verify promises. Each inbound runs in its own
   * microtask chain (no serial queue — see Echo cortex#203 round 1).
   * Tracked here so `stop()` can await drain and so the listener can
   * be cleanly torn down in tests / shutdown without late stderr or
   * late publish side effects landing on a closed channel.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: BusDispatchListenerOpts) {
    this.runtime = opts.runtime;
    this.resolver = opts.resolver;
    this.receivingAgentId = opts.receivingAgentId;
    this.principalId = opts.principalId;
    this.source = opts.source;
    this.cryptoVerify = opts.cryptoVerify ?? false;
  }

  /**
   * Register the runtime subscription. Idempotent — calling `start()`
   * twice is a no-op (returns the existing registration). Each inbound
   * envelope's verify runs in its own microtask chain, in parallel
   * with other inbounds — there is no per-listener arrival-order
   * invariant (no consumer iterator, no inter-envelope dependency),
   * so the `BusPeerHarness` serial-chain pattern is deliberately NOT
   * reused here (Echo cortex#203 round 1 finding). In-flight promises
   * are tracked on `inFlight` so `stop()` can await drain.
   */
  start(): void {
    if (this.registration !== undefined) return;
    this.registration = this.runtime.onEnvelope((envelope) => {
      if (!this.isPeerDispatch(envelope)) return;
      this.trackInFlight(this.runOneVerify(envelope));
    });
  }

  /**
   * Detach the subscription and drain any in-flight verifies.
   * Idempotent. Async (Echo cortex#203 round 1 finding) so callers
   * relying on `stop()` as a clean cutoff — test teardown that
   * mocks `runtime.publish` and then restores it, shutdown sequences
   * — can `await listener.stop()` and trust that no late stderr or
   * publish side effects land afterwards.
   */
  async stop(): Promise<void> {
    if (this.registration === undefined) return;
    this.registration.unregister();
    this.registration = undefined;
    // Drain in-flight verifies — Promise.allSettled because individual
    // verifies already catch their own errors; we just need the
    // microtask chain to flush before returning.
    await Promise.allSettled(Array.from(this.inFlight));
  }

  /**
   * Filter: only `dispatch.task.dispatched` envelopes are interesting,
   * and we deliberately skip our own published envelopes (the runtime's
   * onEnvelope fan-out fires for outbound publishes too).
   *
   * The "own publish" check uses envelope source attribution rather
   * than envelope id — at this slice we don't track our own outbound
   * ids, and `source` is the dotted `{principal}.{agent}.{instance}`
   * shape every cortex publish stamps.
   *
   * **Security note** (Echo cortex#203 round 1): the source filter is
   * `trust-list-anchored, not source-anchored`. `envelope.source` is
   * NOT part of the canonical bytes verified by
   * `verifyEnvelopeIdentity` — a peer could stamp a valid signed
   * envelope with our triple as the source, and this filter would
   * drop it (denial-of-service for legitimate peer dispatches).
   * Conversely, an attacker who knows our triple can suppress our
   * visibility into their dispatches. The verify chain is the
   * authoritative gate — `signed_by[]` is bound to canonical bytes
   * and trusted by the receiving agent's `trust:` list. The source
   * filter is a cheap loopback suppressor, not a security boundary.
   * Once cortex#202 (B.2b) lands and peers start publishing
   * `dispatch.task.dispatched` envelopes routinely, consider pairing
   * this with the BusPeerHarness pattern of also tracking our own
   * outbound `envelope.id`s for stricter loopback suppression.
   */
  private isPeerDispatch(envelope: Envelope): boolean {
    if (envelope.type !== "dispatch.task.dispatched") return false;
    const ourSource = `${this.source.principal}.${this.source.agent}.${this.source.instance}`;
    return envelope.source !== ourSource;
  }

  /**
   * Run a single verify in its own microtask. Catches its own errors
   * so the caller doesn't need to attach a `.catch`. Returns the
   * promise so the caller can track it for drain.
   */
  private async runOneVerify(envelope: Envelope): Promise<void> {
    try {
      await this.handleInbound(envelope);
    } catch (err) {
      process.stderr.write(
        `[bus-dispatch-listener:${this.receivingAgentId}] verification ` +
          `threw on envelope ${envelope.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * Track a verify promise on `inFlight` and remove it on settle.
   * Sibling helper that owns the bookkeeping without inline arrow
   * gymnastics — the alternative (let / two-step bind inside the
   * subscription callback) trips TS's definite-assignment analysis.
   */
  private trackInFlight(verifyPromise: Promise<void>): void {
    this.inFlight.add(verifyPromise);
    void verifyPromise.finally(() => this.inFlight.delete(verifyPromise));
  }

  private async handleInbound(envelope: Envelope): Promise<void> {
    const verification = await verifySignedByChain(envelope, {
      resolver: this.resolver,
      receivingAgentId: this.receivingAgentId,
      // Peer dispatches MUST be signed — an unsigned dispatch envelope
      // arriving on the bus is a misconfig we want surfaced.
      rejectEmpty: true,
      cryptoVerify: this.cryptoVerify,
      principalId: this.principalId,
    });

    if (!verification.valid) {
      process.stderr.write(
        `[bus-dispatch-listener:${this.receivingAgentId}] dropped peer ` +
          `dispatch envelope ${envelope.id} (correlation_id=` +
          `${envelope.correlation_id ?? "<none>"}): ${verification.reason.kind} ` +
          `at chain index ${verification.rejectedAt}\n`,
      );
      return;
    }

    // Emit visibility — Phase C audit envelopes will consume this on
    // the wire. Today operators see it via the dashboard renderer +
    // any other surface subscribed to `system.bus.*`.
    const visibilityEvent = createSystemBusPeerDispatchReceivedEvent({
      source: this.source,
      receivingAgentId: this.receivingAgentId,
      peerSource: envelope.source,
      dispatchEnvelopeId: envelope.id,
      ...(envelope.correlation_id !== undefined && {
        correlationId: envelope.correlation_id,
      }),
      receivedAt: new Date(),
    });
    // Await per MyelinRuntime.publish contract — the runtime logs and
    // swallows publish errors internally, so this returns quickly, but
    // awaiting means `handleInbound` (and the tracked `inFlight` entry)
    // only settles after publish settles. That makes `stop()`'s
    // `allSettled(inFlight)` drain a true cutoff for both verify and
    // publish side effects (Echo cortex#203 round 2 — closes the
    // partial-fix nuance on the original async-stop fix).
    await this.runtime.publish(visibilityEvent);
  }
}
