/**
 * IAW Phase B.1b (cortex#114) — `BusPeerHarness`.
 *
 * The carry-over from Phase A.1.3 (which was speculatively ticked in
 * PR #192 but never shipped — see PR #193 plan correction). This is
 * the second concrete `SessionHarness` implementation alongside
 * `ClaudeCodeHarness`: a harness that delegates the actual work to a
 * peer agent reachable via the local bus. Cortex publishes a request
 * envelope, the peer (sage / cedar / alpha / future) does the work
 * over there, and progress + terminal envelopes return via the
 * `MyelinRuntime.onEnvelope` fan-out.
 *
 * **What this slice delivers (B.1b.1 + B.1b.2 of the plan):**
 *   - `BusPeerHarness implements SessionHarness` — publish-and-collect
 *     pattern keyed on `correlation_id`. The harness yields a local
 *     `dispatch.task.started` envelope on entry, then every verified
 *     inbound envelope tagged with the same `correlation_id`, then a
 *     terminal envelope yielded by the peer (`dispatch.task.completed`
 *     / `failed` / `aborted`). Consumer-break causes the runtime
 *     subscription to unregister via the try/finally; the runner is
 *     responsible for recording an aborted lifecycle envelope from its
 *     outside view (matches `ClaudeCodeHarness`'s contract — see the
 *     `dispatch()` JSDoc for the spec rationale).
 *   - **Verification gate on every inbound** via `verifySignedByChain`
 *     (Phase B.1a). Envelopes that fail the structural trust check
 *     are dropped at the boundary with a single-line `process.stderr`
 *     write — no audit envelope yet (that's Phase C.4) and no yield
 *     to the consumer.
 *
 * **What this slice deliberately doesn't do:**
 *   - **No ed25519 verification of signature bytes.** The structural
 *     check from B.1a is the only gate today. The harness's file
 *     header explicitly acknowledges that wiring this into a real
 *     production inbound path requires B.1c to land first; until then
 *     this scaffold is safe behind a feature flag / capability
 *     declaration that no principal actually has bound to a peer.
 *   - **No production wire format for the outbound request envelope.**
 *     The harness builds a minimal `dispatch.task.dispatched`-shaped
 *     envelope from `DispatchRequest`. The richer "task contract" shape
 *     (capability requirements, deadline, etc. — F-021) is Phase D
 *     federation work; for B.1b the outbound is structurally sound but
 *     doesn't carry the full sovereignty/capability advertisement.
 *   - **No reply timeout.** Caller's `req.timeoutMs` is observed and
 *     surfaces in the synthetic terminal envelope's reason when the
 *     iterator is broken, but the harness doesn't internally race a
 *     timeout against inbound — the caller iterates with whatever
 *     timeout discipline they bring (matches `ClaudeCodeHarness`'s
 *     "iterator close means stop" contract).
 *   - **No graceful shutdown drain.** `shutdown(opts)` is omitted; the
 *     `SessionHarness` contract says omitting is "stateless across
 *     dispatches" which is true here (each `dispatch` allocates +
 *     unregisters its own onEnvelope handler).
 *
 * **Cross-references:**
 *   - cortex#114 B.1b — this slice.
 *   - cortex#102 — design: bot↔bot via bus envelopes.
 *   - `src/bus/verify-signed-by-chain.ts` — B.1a primitive consumed here.
 *   - `src/substrates/claude-code/harness.ts` — the sibling pattern.
 */

import { randomUUID } from "crypto";

import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { TrustResolver } from "../../common/agents/trust-resolver";
import { verifySignedByChain } from "../../bus/verify-signed-by-chain";
import type {
  Capability,
  DispatchRequest,
  HarnessId,
  MyelinEnvelope,
  SessionHarness,
} from "../../common/substrates/types";
import {
  createDispatchTaskStartedEvent,
  type DispatchEventSource,
} from "../../bus/dispatch-events";

// =============================================================================
// Constructor options
// =============================================================================

/**
 * Construct-time configuration. The harness binds to a single
 * receiving identity (`receivingAgentId`) and a single peer target
 * subject classification at construction time — different peers / peer
 * networks instantiate different harness objects rather than
 * multiplexing through one.
 */
export interface BusPeerHarnessOpts {
  /** Runtime the harness publishes + listens through. */
  runtime: MyelinRuntime;
  /** Trust resolver — passed through to `verifySignedByChain`. */
  resolver: TrustResolver;
  /**
   * Agent id of the LOCAL side of the bus-peer link — the receiver
   * whose `trust:` list governs which inbound peers are accepted.
   * Trust direction: this harness accepts envelopes from peers that
   * `agents[receivingAgentId].trust` includes.
   */
  receivingAgentId: string;
  /**
   * Source attribution stamped onto outbound + locally-synthesised
   * envelopes. The runner already builds one of these for the
   * dispatch path; pass it through verbatim.
   */
  source: DispatchEventSource;
  /**
   * Capabilities the harness advertises — what work it can route to
   * peers. The capability registry (Phase A.6) aggregates across all
   * harnesses; this list is what cortex sees from this harness.
   * Empty array is legal during scaffold work — the harness is
   * structurally valid but principals won't actually dispatch tasks
   * to it.
   */
  capabilities?: Capability[];
}

// =============================================================================
// Harness
// =============================================================================

export class BusPeerHarness implements SessionHarness {
  readonly id: HarnessId = "bus-peer";
  readonly capabilities: Capability[];

  private readonly runtime: MyelinRuntime;
  private readonly resolver: TrustResolver;
  private readonly receivingAgentId: string;
  private readonly source: DispatchEventSource;

  constructor(opts: BusPeerHarnessOpts) {
    this.runtime = opts.runtime;
    this.resolver = opts.resolver;
    this.receivingAgentId = opts.receivingAgentId;
    this.source = opts.source;
    this.capabilities = opts.capabilities ?? [];
  }

  /**
   * Dispatch a task by publishing an outbound request envelope onto
   * the bus and yielding every verified inbound envelope correlated
   * with this dispatch. The iterator closes when the peer's terminal
   * envelope arrives, OR (if the consumer breaks) when iteration
   * stops — at which point the harness yields a synthetic `aborted`
   * terminal envelope so the runner can record the cancellation.
   *
   * **Failure modes & their wire shapes:**
   *   - Inbound envelope fails `verifySignedByChain`: logged to
   *     stderr, dropped. The consumer never sees it. Audit-envelope
   *     emission lives in Phase C.
   *   - Consumer breaks early: handler unregisters via the
   *     try/finally cleanup. No synthetic terminal envelope is
   *     yielded — async-generator semantics drop yields in finally
   *     after iterator return, and the pattern matches
   *     `ClaudeCodeHarness`'s contract (runner / dispatch-listener
   *     observes iterator close + records an aborted lifecycle
   *     envelope from its outside view).
   *   - Runtime publish errors: swallowed. The harness uses
   *     `void this.runtime.publish(...)` per `MyelinRuntime.publish`'s
   *     fire-and-forget contract — the runtime itself logs and
   *     swallows publish errors (so a misconfigured NATS section
   *     can't crash the bot), and this harness deliberately doesn't
   *     `await` the returned promise. The only observable failure
   *     mode of a publish failure here is "the receiving peer never
   *     sees the outbound request"; no synthetic terminal is emitted
   *     locally before the started yield. A future B.1c+ refinement
   *     could opt into the `await + synthetic failed-terminal`
   *     pattern (Echo's option B on cortex#195) if principals want
   *     a louder failure surface, but at this slice we mirror the
   *     existing runtime contract.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async *dispatch(
    req: DispatchRequest,
  ): AsyncIterable<MyelinEnvelope> {
    // Per the SessionHarness contract, `req.requestId` is the
    // correlation key downstream subscribers use to thread the
    // dispatch lifecycle. We thread it through to BOTH the outbound
    // request envelope AND the started/aborted envelopes we
    // synthesise locally.
    const correlationId = req.requestId;
    const startedAt = new Date();

    // ----------------------------------------------------------------
    // 1. Build the outbound request envelope (minimal shape for B.1b)
    // ----------------------------------------------------------------
    const requestEnvelope: Envelope = {
      id: randomUUID(),
      source: `${this.source.principal}.${this.source.agent}.${this.source.instance}`,
      type: "dispatch.task.dispatched",
      timestamp: startedAt.toISOString(),
      correlation_id: correlationId,
      sovereignty: {
        classification: "local",
        data_residency: this.source.dataResidency ?? "NZ",
        max_hop: 4,
        frontier_ok: false,
        model_class: "any",
      },
      payload: {
        agent_id: req.agent.id,
        prompt: req.prompt,
        request_id: correlationId,
        ...(req.timeoutMs !== undefined && { timeout_ms: req.timeoutMs }),
      },
    };

    // ----------------------------------------------------------------
    // 2. Set up the inbound queue + verification gate
    // ----------------------------------------------------------------
    // Async-producer / async-consumer rendezvous: the runtime fans
    // out inbound envelopes synchronously to our handler; the handler
    // pushes onto `inboundQueue`. The generator below pulls.
    const inboundQueue: MyelinEnvelope[] = [];
    const pendingResolvers: ((env: MyelinEnvelope | null) => void)[] = [];
    // Wrapped in an object so the closure-mutation visible to the
    // onEnvelope handler is also visible to lint's flow analysis on
    // the generator side. A bare `let closed = false` would compile
    // correctly but trip `no-unnecessary-condition` because the
    // closure's `closed = true` write doesn't propagate to the outer
    // linear narrow.
    const state = { closed: false };

    function pushInbound(env: MyelinEnvelope) {
      const next = pendingResolvers.shift();
      if (next !== undefined) {
        next(env);
      } else {
        inboundQueue.push(env);
      }
    }

    function signalClosed() {
      state.closed = true;
      while (pendingResolvers.length > 0) {
        const resolve = pendingResolvers.shift();
        if (resolve !== undefined) resolve(null);
      }
    }

    // Serial-verification chain. Each inbound envelope's verify is
    // appended via `.then(...)` so verifies run in arrival order and
    // the terminal-envelope detection fires only after every prior
    // envelope has pushed. Echo cortex#200 round 1, findings #1+#2.
    let inFlight: Promise<void> = Promise.resolve();

    // Register the handler BEFORE the try block so envelopes arriving
    // between registration and the first yield are captured; the
    // unregister in `finally` (which wraps the publish + every yield
    // below) covers every exit path — including a consumer break at
    // the `started` yield. Async-generator semantics: only finally
    // blocks that *wrap* the suspended yield point run on
    // `iterator.return()`, so the try must enclose every yield this
    // method emits, but the registration itself must precede the try
    // to avoid a registration-vs-yield race.
    const handlerRegistration = this.runtime.onEnvelope((envelope) => {
      // Filter: only envelopes tagged with our correlation_id are
      // relevant to this dispatch. Bus traffic for other dispatches
      // flows past untouched.
      if (envelope.correlation_id !== correlationId) return;

      // Filter: don't loop our own outbound request back into our
      // inbound stream — the local fan-out also fires for envelopes
      // this harness just published.
      if (envelope.id === requestEnvelope.id) return;

      // verifySignedByChain is async (B.1c) but onEnvelope's handler
      // is sync. Chain each verify onto `inFlight` so:
      //   1. Verifies run in arrival order (Echo cortex#200 finding #1
      //      — bare IIFE would let later-arrived B's verify resolve
      //      before A's, breaking the dispatch progress→terminal
      //      arrival-order invariant the SessionHarness contract
      //      implicitly relies on).
      //   2. Terminal-envelope detection runs AFTER every prior
      //      envelope has pushed (Echo finding #2 — without
      //      serialisation, terminal-detection on B could close the
      //      queue while A's verify was still pending, dropping A
      //      from the consumer's view).
      // The chain swallows rejections (try/catch + stderr log) so an
      // unexpected throw from verifySignedByChain (e.g. the
      // principalId-missing guard once a follow-up flips cryptoVerify
      // on without threading principalId — Echo finding #3) doesn't
      // surface as an unhandled rejection on the process.
      inFlight = inFlight.then(async () => {
        try {
          const verification = await verifySignedByChain(envelope, {
            resolver: this.resolver,
            receivingAgentId: this.receivingAgentId,
            // Peers always sign at least the bare ed25519 stamp; an
            // unsigned envelope on the bus-peer path is a misconfig
            // we want surfaced.
            rejectEmpty: true,
          });

          if (!verification.valid) {
            // Phase C wires audit envelopes; for now stderr is the
            // visibility surface. Format the reason discriminator
            // inline so a principal grepping stderr gets the
            // structural class without consulting code.
            const reason = verification.reason;
            process.stderr.write(
              `[bus-peer:${this.receivingAgentId}] dropped inbound envelope ` +
                `${envelope.id} (correlation_id=${correlationId}): ` +
                `${reason.kind} at chain index ${verification.rejectedAt}\n`,
            );
            return;
          }

          pushInbound(envelope);

          // Terminal-envelope detection — when the peer signals end of
          // the dispatch, close the inbound queue so the generator
          // can exit cleanly. Conventional terminal types per
          // G-1111 §3.4. Runs INSIDE the same chain link as the
          // preceding push, so the queue contains every prior
          // envelope before close fires (Echo finding #2 fix).
          if (
            envelope.type === "dispatch.task.completed" ||
            envelope.type === "dispatch.task.failed" ||
            envelope.type === "dispatch.task.aborted"
          ) {
            signalClosed();
          }
        } catch (err) {
          process.stderr.write(
            `[bus-peer:${this.receivingAgentId}] verification threw on ` +
              `envelope ${envelope.id} (correlation_id=${correlationId}): ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      });
    });

    // ----------------------------------------------------------------
    // 3. Publish the outbound request + drive the pull loop inside a
    //    single try/finally so the handler unregisters on every exit
    //    path — including a consumer break at the FIRST yield.
    // ----------------------------------------------------------------
    try {
      // Fire-and-forget per MyelinRuntime.publish's documented contract:
      // the runtime logs and swallows publish errors internally, so the
      // returned promise resolves rather than rejects. We `void` it so
      // ESLint's no-floating-promises rule is satisfied without an
      // `await` that would block on the runtime's own swallow path.
      void this.runtime.publish(requestEnvelope);

      // ----------------------------------------------------------------
      // 4. Yield local started envelope so the runner has a lifecycle
      //    anchor before any peer envelopes arrive
      // ----------------------------------------------------------------
      const startedEnvelope = createDispatchTaskStartedEvent({
        source: this.source,
        taskId: correlationId,
        agentId: req.agent.id,
        startedAt,
        correlationId,
      });
      yield startedEnvelope;

      // ----------------------------------------------------------------
      // 5. Pull inbound until the peer signals terminal OR consumer
      //    breaks. Both paths trigger the finally below.
      // ----------------------------------------------------------------
      while (!state.closed || inboundQueue.length > 0) {
        const buffered = inboundQueue.shift();
        if (buffered !== undefined) {
          yield buffered;
          continue;
        }
        if (state.closed) break;

        const next = await new Promise<MyelinEnvelope | null>((resolve) => {
          pendingResolvers.push(resolve);
        });
        if (next === null) break;
        yield next;
      }
    } finally {
      // Consumer-break path: matches `ClaudeCodeHarness`'s contract —
      // we clean up the runtime subscription so the bus doesn't
      // fan out to a dropped handler. The caller (runner /
      // dispatch-listener) is responsible for recording an aborted
      // lifecycle envelope from its outside view when iteration
      // breaks before a peer terminal arrives. A yield inside this
      // finally would land on a closed iterator and never reach the
      // consumer anyway (async-generator semantics: yields in finally
      // after iterator return are silently dropped).
      handlerRegistration.unregister();
    }
  }
}
