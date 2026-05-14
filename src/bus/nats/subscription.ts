/**
 * G-1100.C: NATS subject-pattern subscription primitive.
 *
 * Thin wrapper around `NatsLink.raw.subscribe(pattern)` that:
 *   - Yields raw bytes per message (no envelope decode here — that's
 *     G-1100.D's job; the validator and the subscription primitive stay
 *     separate so each can be tested in isolation).
 *   - Re-subscribes on reconnect (the underlying nats.js client emits a
 *     reconnect event but does NOT auto-restore subscriptions; we handle
 *     that explicitly).
 *   - Drains cleanly on stop.
 *
 * Coupling rule (per docs/design-collaboration-surface.md §9):
 * This module reads from NATS only — it never publishes. The myelin
 * subscriber compose (G-1100.D) wraps this with envelope validation; the
 * subject allowlist for any future publishing path is tracked in #70.
 */

import {
  Events,
  type NatsConnection,
  type Subscription,
  type SubscriptionOptions,
} from "nats";
import type { NatsLink } from "./connection";

/** Callback invoked once per received message. Errors thrown propagate to onError. */
export type RawMessageHandler = (subject: string, data: Uint8Array) => void | Promise<void>;

/** Optional error sink for handler failures. Logged if absent. */
export type RawErrorHandler = (err: Error, subject: string) => void;

export interface NatsSubscriptionOptions {
  /** NATS subject pattern, e.g. `local.acme.>`. Required. */
  pattern: string;
  /** Per-message handler. */
  onMessage: RawMessageHandler;
  /** Optional error sink — invoked on handler throws. */
  onError?: RawErrorHandler;
  /** Optional underlying-subscription options (queue group, max, etc.). */
  natsOptions?: SubscriptionOptions;
}

/**
 * A live subject-pattern subscription. Re-subscribes automatically on
 * reconnect; stops cleanly on `stop()`.
 */
export class NatsSubscription {
  readonly pattern: string;
  private readonly link: NatsLink;
  private readonly onMessage: RawMessageHandler;
  private readonly onError: RawErrorHandler;
  private readonly natsOptions?: SubscriptionOptions;

  private subscription: Subscription | null = null;
  /**
   * All consume loops we've ever started — most recent at the end. Across
   * a reconnect lifecycle there can be a handful (the previous loop usually
   * exits naturally as the old iterator closes, but if it rejects we want
   * the rejection captured here, not orphaned with no `.catch`). `stop()`
   * awaits them all so tail errors surface.
   */
  private readonly consumeLoops: Promise<void>[] = [];
  private stopped = false;

  private constructor(link: NatsLink, opts: NatsSubscriptionOptions) {
    this.link = link;
    this.pattern = opts.pattern;
    this.onMessage = opts.onMessage;
    this.onError = opts.onError ?? defaultErrorLog;
    this.natsOptions = opts.natsOptions;
    this.subscribeOnce();
    // Fire-and-forget the status watcher. Errors are logged inside
    // watchReconnects; the loop exits when the underlying connection
    // closes (link owner's lifecycle), so we don't need to track the
    // promise here.
    void this.watchReconnects();
  }

  /** Open a new subscription. Returns once the underlying NATS subscription is registered. */
  static start(link: NatsLink, opts: NatsSubscriptionOptions): NatsSubscription {
    const pattern = opts.pattern.trim();
    if (!pattern) {
      throw new Error("nats-subscription: pattern is required (non-empty, non-whitespace)");
    }
    return new NatsSubscription(link, { ...opts, pattern });
  }

  /**
   * Stop the subscription. Drains in-flight messages and waits for the
   * consume loop to exit. Idempotent.
   *
   * The status loop is NOT awaited here — it can only exit when the
   * underlying connection closes, which is the link owner's
   * responsibility (typically via `NatsLink.close()`). After `stop()`
   * the status loop early-exits on its next observed event because
   * `this.stopped` is set; until then it sits idle waiting for an event
   * that won't come — no work, no leak that survives connection close.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // No race in the current code: in single-threaded JS, the entire
    // Reconnect branch in watchReconnects runs synchronously from its
    // outer `if (this.stopped) return;` check through `subscribeOnce()`,
    // with no await between. So stop() and watchReconnects can't
    // interleave inside the swap. If a future change adds an await
    // inside that branch, this read becomes load-bearing — keep it.
    const sub = this.subscription;
    if (sub) {
      try {
        await sub.drain();
      } catch (err) {
        // Drain can fail if the connection is already closed; log and proceed.
        console.error(
          `nats-subscription: "${this.pattern}" drain error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Await every consume loop we've ever started — multiple may exist
    // across reconnects; settledResults lets stop() resolve even if some
    // rejected. Reject reasons would have already been logged inside
    // consume() so we just swallow here.
    await Promise.allSettled(this.consumeLoops);
  }

  /**
   * Open one subscription on the underlying connection.
   *
   * Returns true on success, false if `raw.subscribe()` threw — caller
   * uses this so a misleading "re-subscribed" log doesn't fire on the
   * failure path. (Round-1 had no error log; round-2 added one but the
   * "re-subscribed" line still fired — Echo cycle-2 regression note.)
   */
  private subscribeOnce(): boolean {
    const raw: NatsConnection = this.link.raw;
    try {
      this.subscription = raw.subscribe(this.pattern, this.natsOptions);
    } catch (err) {
      // Subscribe can throw synchronously if the connection is in an
      // unusable state (auth revoked between disconnect and reconnect,
      // server gone). Surface — this is exactly the failure that should
      // page someone — and leave `subscription` null so stop() won't
      // try to drain a phantom.
      console.error(
        `nats-subscription: "${this.pattern}" subscribe failed:`,
        err instanceof Error ? err.message : err,
      );
      this.subscription = null;
      return false;
    }
    // Wrap the consume loop so unhandled rejections become caught
    // rejections owned by `consumeLoops`. Without `.catch`, a rejection
    // from the OLD generation's loop after we've moved on becomes an
    // unhandled-promise warning with nothing watching.
    const loop = this.consume(this.subscription).catch((err: unknown) => {
      if (!this.stopped) {
        console.error(
          `nats-subscription: "${this.pattern}" consume loop rejection:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    this.consumeLoops.push(loop);
    return true;
  }

  private async consume(sub: Subscription): Promise<void> {
    try {
      for await (const msg of sub) {
        if (this.stopped) return;
        try {
          await this.onMessage(msg.subject, msg.data);
        } catch (err) {
          // Guard the onError invocation itself — a thrown onError must
          // not kill the consume loop. The whole point of the sink is
          // to keep delivery alive. Fall back to defaultErrorLog so the
          // failure is at least visible.
          try {
            this.onError(
              err instanceof Error ? err : new Error(String(err)),
              msg.subject,
            );
          } catch (sinkErr) {
            defaultErrorLog(
              sinkErr instanceof Error ? sinkErr : new Error(String(sinkErr)),
              msg.subject,
            );
            defaultErrorLog(
              err instanceof Error ? err : new Error(String(err)),
              msg.subject,
            );
          }
        }
      }
    } catch (err) {
      if (!this.stopped) {
        console.error(
          `nats-subscription: "${this.pattern}" consume loop error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Watch the connection's status stream for Reconnect events; on each
   * reconnect, re-subscribe (nats.js reconnects the connection but does
   * NOT auto-restore subject subscriptions — they're considered client
   * state).
   */
  private async watchReconnects(): Promise<void> {
    try {
      for await (const status of this.link.raw.status()) {
        if (this.stopped) return;
        if (status.type === Events.Reconnect) {
          // Drain the old subscription before opening the new one. Two
          // reasons: (a) closes the old iterator deterministically so the
          // prior consume loop exits — without this it stays blocked
          // waiting for messages on a subscription that's now an orphan
          // server-side; (b) `stop()` later awaits every loop in
          // `consumeLoops`, and a never-exiting loop would hang stop().
          // Drain failures are best-effort and logged inside `consume()`.
          //
          const old = this.subscription;
          this.subscription = null;
          if (old) {
            old.drain().catch((err: unknown) => {
              console.error(
                `nats-subscription: "${this.pattern}" pre-reconnect drain error:`,
                err instanceof Error ? err.message : String(err),
              );
            });
          }
          // Prune already-settled loops from previous generations so the
          // array doesn't grow unbounded over a long-running connection
          // (Echo cycle-2 nit). Tracks live loops only; the old loop we
          // just drained becomes settled shortly after this point and
          // will be pruned on the next reconnect.
          this.pruneSettledLoops();
          // Only emit "re-subscribed" on the success branch — Echo
          // cycle-2 caught the regression where this fired even after
          // `subscribeOnce()` logged a subscribe failure, producing the
          // misleading "subscribe failed → re-subscribed" log pair.
          if (this.subscribeOnce()) {
            console.info(
              `nats-subscription: "${this.pattern}" re-subscribed after reconnect`,
            );
          }
        }
      }
    } catch (err) {
      if (!this.stopped) {
        console.error(
          `nats-subscription: "${this.pattern}" status loop error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Bound `consumeLoops` to the last two generations (current + previous).
   *
   * JS gives no synchronous "is this promise settled" check, so we can't
   * filter by liveness. The previous-generation loop is drained at
   * reconnect time and settles within a microtask or two, so keeping
   * just the last two is enough to cover the realistic "stop() awaits a
   * still-pending loop" case while keeping the array bounded over a
   * long-running connection (Echo cycle-2 nit).
   */
  private pruneSettledLoops(): void {
    const KEEP = 2;
    if (this.consumeLoops.length > KEEP) {
      // `splice` returns the dropped slice; we intentionally discard the
      // settled Promises (they each already attached a `.catch` handler
      // that logs and continues).
      void this.consumeLoops.splice(0, this.consumeLoops.length - KEEP);
    }
  }
}

function defaultErrorLog(err: Error, subject: string): void {
  console.error(
    `nats-subscription: handler error on "${subject}":`,
    err.message,
  );
}
