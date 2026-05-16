/**
 * G-1100.D: Myelin envelope subscriber.
 *
 * Composes G-1100.C's `NatsSubscription` (raw bytes from a NATS subject
 * pattern) with G-1100.B's `validateEnvelope` to deliver typed,
 * schema-validated `Envelope` objects to a callback.
 *
 * Invalid envelopes are routed to `onInvalidEnvelope` as a discriminated
 * union (`json-parse` vs `schema`) with the full Ajv error array on the
 * schema branch. Default sink logs subject + reason only; raw payload
 * snippet is gated behind `logRawSnippet` to prevent leaking credentials
 * or PII from misconfigured publishers.
 *
 * Coupling rule (per docs/design-collaboration-surface.md §9):
 * Subscribe-only — never publishes. The publish path is gated by a
 * subject allowlist that lands in a follow-up (issue #70).
 *
 * cortex#237 PR-1: extended with `mode: "pull"` for JetStream
 * pull-consumer subscriptions. Default mode is `"push"` — every existing
 * call site keeps working byte-identically (push wraps the same
 * `NatsSubscription` primitive). The pull-mode branch binds to a durable
 * JetStream consumer via `nc.jetstream().consumers.get(stream, durable)`
 * and runs a `consume()` loop with explicit ack on handler success,
 * `nak()` on handler throw, and `term()` on un-parseable / schema-invalid
 * envelopes (garbage payloads must not loop until `max_deliver`).
 *
 * The mode flag is local to this primitive; consumers see the same
 * `(envelope, subject) => void | Promise<void>` callback regardless.
 * See docs/design-capability-dispatch-review-consumer.md §2.3 for the
 * acceptable delivery semantics this primitive realises.
 */

import type { ErrorObject } from "ajv/dist/2020";
import type {
  ConsumeOptions,
  Consumer,
  ConsumerMessages,
  JsMsg,
} from "nats";
import type { NatsLink } from "../nats/connection";
import { NatsSubscription } from "../nats/subscription";
import { validateEnvelope, type Envelope } from "./envelope-validator";

export type { ErrorObject };

/** Per-envelope handler. Errors thrown propagate to onError. */
export type EnvelopeHandler = (envelope: Envelope, subject: string) => void | Promise<void>;

/** Optional sink for *handler* errors (NOT for invalid envelopes — those are
 *  always logged and dropped by the validator branch, never surfaced as a
 *  handler error). */
export type EnvelopeErrorHandler = (err: Error, subject: string) => void;

/** Discriminated reason for invalid envelopes. */
export type InvalidEnvelopeReason =
  | { kind: "json-parse"; message: string }
  | { kind: "schema"; errors: ErrorObject[]; firstPath: string; firstMessage: string };

/** Optional sink invoked when an envelope fails validation. Defaults to a
 *  structured console.warn so a missing handler doesn't make drops invisible. */
export type InvalidEnvelopeHandler = (
  reason: InvalidEnvelopeReason,
  subject: string,
  rawSnippet: string,
) => void;

/**
 * Pull-mode subscription parameters. Only meaningful when `mode: "pull"`.
 *
 * The consumer MUST already exist on the JetStream server (created by a
 * sibling provisioning helper or by NATS CLI / ops tooling — PR-1 does
 * NOT manage consumer lifecycle, only binding). `Consumers.get(stream,
 * durable)` returns a handle whose `consume()` runs the pull loop.
 *
 * Tuning fields (`maxMessages`, `expiresMs`, `thresholdMessages`) are
 * passed through to the underlying `ConsumeOptions`. Sensible defaults
 * come from nats.js; we don't shadow them here so future client
 * upgrades don't quietly drift.
 */
export interface MyelinPullOptions {
  /** JetStream stream name carrying the bound consumer. */
  stream: string;
  /** Durable consumer name. The consumer MUST exist server-side. */
  durable: string;
  /** Max messages outstanding in the consume request. Optional; nats.js default applies. */
  maxMessages?: number;
  /** How long the consume request waits for messages before re-pulling, in ms. */
  expiresMs?: number;
  /** Refill threshold (messages remaining before issuing another consume request). */
  thresholdMessages?: number;
}

export interface MyelinSubscriberOptions {
  /** NATS subject pattern, e.g. `local.acme.>`.
   *
   * In `"push"` mode this is the subject filter passed to
   * `NatsConnection.subscribe`. In `"pull"` mode it is informational
   * only — the JetStream consumer's own filter (declared at consumer
   * creation) drives delivery. Recorded on `subscriber.pattern` for
   * logging consistency across modes.
   */
  pattern: string;
  /**
   * Subscription mode. `"push"` (default) uses Core-NATS push delivery
   * via `NatsSubscription`. `"pull"` binds to a durable JetStream pull
   * consumer with explicit ack/nak. Default keeps every pre-cortex#237
   * call site byte-identical.
   */
  mode?: "push" | "pull";
  /** Per-valid-envelope handler. */
  onEnvelope: EnvelopeHandler;
  /** Optional sink for handler throws. */
  onError?: EnvelopeErrorHandler;
  /** Optional sink for envelope validation failures. */
  onInvalidEnvelope?: InvalidEnvelopeHandler;
  /** Include raw payload snippet in default invalid-envelope log. Off by
   *  default to prevent leaking credentials or PII from misconfigured
   *  upstream publishers. */
  logRawSnippet?: boolean;
  /** Pull-mode parameters. Required when `mode: "pull"`. */
  pull?: MyelinPullOptions;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Strip C0 control characters (newlines, tabs, etc.) to prevent log injection. */
function sanitizeForLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Internal contract every backend (push, pull) implements. Keeps the
 * outer `MyelinSubscriber` envelope-validation logic identical across
 * modes; only the I/O surface differs.
 */
interface SubscriberBackend {
  /** Resolves once the backend is wired and ready to receive. */
  ready: Promise<void>;
  /** Drain in-flight, stop accepting new envelopes. Idempotent. */
  stop(): Promise<void>;
}

/**
 * A live myelin subscriber. Wraps either a `NatsSubscription` (push) or
 * a JetStream pull-consumer `consume()` loop (pull); same lifecycle
 * surface either way (start at construction, stop via `stop()`).
 *
 * `ready` is a Promise that resolves once the backend is fully wired.
 * Push mode resolves synchronously (the underlying `NatsSubscription`
 * subscribes during construction); pull mode resolves after the
 * `Consumers.get()` round-trip and the initial `consume()` call. Tests
 * that need deterministic ordering should `await subscriber.ready`
 * before publishing.
 */
export class MyelinSubscriber {
  readonly pattern: string;
  /** Resolves once the underlying backend is wired and ready. */
  readonly ready: Promise<void>;
  private readonly onEnvelope: EnvelopeHandler;
  private readonly onError: EnvelopeErrorHandler;
  private readonly onInvalidEnvelope: InvalidEnvelopeHandler;
  private readonly backend: SubscriberBackend;

  private constructor(link: NatsLink, opts: MyelinSubscriberOptions) {
    this.pattern = opts.pattern;
    this.onEnvelope = opts.onEnvelope;
    this.onError = opts.onError ?? defaultHandlerErrorLog;
    this.onInvalidEnvelope =
      opts.onInvalidEnvelope ?? makeDefaultInvalidEnvelopeLog(opts.logRawSnippet ?? false);

    const mode = opts.mode ?? "push";
    if (mode === "pull") {
      if (!opts.pull) {
        throw new Error(
          'myelin-subscriber: mode: "pull" requires a `pull` options block (stream + durable)',
        );
      }
      this.backend = new PullBackend(
        link,
        opts.pull,
        (subject, data, msg) => this.handleRaw(subject, data, msg),
      );
    } else {
      this.backend = new PushBackend(
        link,
        opts.pattern,
        (subject, data) => this.handleRaw(subject, data, null),
        (err, subject) => { this.onError(err, subject); },
      );
    }
    this.ready = this.backend.ready;
  }

  /** Start a new myelin subscriber. */
  static start(link: NatsLink, opts: MyelinSubscriberOptions): MyelinSubscriber {
    return new MyelinSubscriber(link, opts);
  }

  /** Stop the subscriber. Drains the inner backend. Idempotent. */
  async stop(): Promise<void> {
    await this.backend.stop();
  }

  /**
   * Validate + dispatch one raw payload. `msg` is the JetStream message
   * handle in pull mode (carries `ack`/`nak`/`term`) or `null` in push
   * mode (Core NATS has no per-message ack). Ack semantics:
   *
   *   - JSON-parse failure or schema failure → `msg.term(reason)`. The
   *     payload is structurally garbage; redelivery would loop until
   *     `max_deliver`. We send it straight to the dead-letter path.
   *   - Handler throws                       → `msg.nak()`. The payload
   *     is well-formed but the handler couldn't process it; let the
   *     server redeliver per its `max_deliver` policy.
   *   - Handler resolves                     → `msg.ack()`. Done.
   *
   * In push mode all of the above are no-ops on `msg` (it's null).
   */
  private async handleRaw(
    subject: string,
    data: Uint8Array,
    msg: JsMsg | null,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(data));
    } catch (err) {
      const reason: InvalidEnvelopeReason = {
        kind: "json-parse",
        message: err instanceof Error ? err.message : String(err),
      };
      this.onInvalidEnvelope(reason, subject, safeSnippet(data));
      if (msg) safeTerm(msg, `json-parse: ${reason.message}`);
      return;
    }

    const result = validateEnvelope(parsed);
    if (!result.ok) {
      const first = result.errors[0];
      const reason: InvalidEnvelopeReason = {
        kind: "schema",
        errors: result.errors,
        firstPath: first?.instancePath ?? "/",
        firstMessage: first?.message ?? "(no message)",
      };
      this.onInvalidEnvelope(reason, subject, safeSnippet(data));
      if (msg) safeTerm(msg, `schema: ${reason.firstPath} ${reason.firstMessage}`);
      return;
    }

    try {
      await this.onEnvelope(result.envelope, subject);
      if (msg) safeAck(msg);
    } catch (err) {
      this.onError(
        err instanceof Error ? err : new Error(String(err)),
        subject,
      );
      if (msg) safeNak(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * Push backend — wraps `NatsSubscription`. Behaviour is byte-identical
 * to the pre-cortex#237 `MyelinSubscriber` (the only change is that the
 * raw-handling loop now lives on the outer class instead of inline in
 * the constructor — same call shape, same lifecycle).
 */
class PushBackend implements SubscriberBackend {
  readonly ready: Promise<void> = Promise.resolve();
  private readonly subscription: NatsSubscription;

  constructor(
    link: NatsLink,
    pattern: string,
    onRaw: (subject: string, data: Uint8Array) => Promise<void>,
    onError: (err: Error, subject: string) => void,
  ) {
    this.subscription = NatsSubscription.start(link, {
      pattern,
      onMessage: (subject, data) => onRaw(subject, data),
      onError,
    });
  }

  async stop(): Promise<void> {
    await this.subscription.stop();
  }
}

/**
 * Pull backend — binds to a durable JetStream consumer and runs the
 * `consume()` async-iterator loop. One outstanding consume request per
 * backend instance; on stop we close the iterator and await the loop to
 * exit cleanly so partially-delivered messages either ack or nak before
 * the subscriber resolves.
 */
class PullBackend implements SubscriberBackend {
  readonly ready: Promise<void>;
  private messages: ConsumerMessages | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    link: NatsLink,
    opts: MyelinPullOptions,
    onRaw: (subject: string, data: Uint8Array, msg: JsMsg) => Promise<void>,
  ) {
    this.ready = this.init(link, opts, onRaw);
  }

  private async init(
    link: NatsLink,
    opts: MyelinPullOptions,
    onRaw: (subject: string, data: Uint8Array, msg: JsMsg) => Promise<void>,
  ): Promise<void> {
    const js = link.raw.jetstream();
    const consumer: Consumer = await js.consumers.get(opts.stream, opts.durable);

    // nats.js's `ConsumeOptions` is an intersection of several Partial
    // option-bag types (MaxMessages, Expires, ThresholdMessages, …) so
    // a single literal that sets only the snake_case fields satisfies
    // the call signature without a cast. We pin to a Partial here to
    // make the intent explicit.
    const consumeOpts: Partial<ConsumeOptions> & {
      max_messages?: number;
      expires?: number;
      threshold_messages?: number;
    } = {};
    if (opts.maxMessages !== undefined) {
      consumeOpts.max_messages = opts.maxMessages;
    }
    if (opts.expiresMs !== undefined) {
      consumeOpts.expires = opts.expiresMs;
    }
    if (opts.thresholdMessages !== undefined) {
      consumeOpts.threshold_messages = opts.thresholdMessages;
    }

    this.messages = await consumer.consume(consumeOpts);
    // Fire-and-forget consume loop. Errors are captured on `loopPromise`
    // so `stop()` can surface them by awaiting; mid-loop errors that
    // aren't fatal are logged and swallowed so one bad message doesn't
    // kill delivery.
    this.loopPromise = this.run(onRaw);
  }

  private async run(
    onRaw: (subject: string, data: Uint8Array, msg: JsMsg) => Promise<void>,
  ): Promise<void> {
    const messages = this.messages;
    if (!messages) return;
    try {
      for await (const m of messages) {
        if (this.stopped) {
          // Best-effort nak so the message isn't held until ack_wait
          // expires on the server during a graceful shutdown.
          safeNak(m);
          return;
        }
        try {
          await onRaw(m.subject, m.data, m);
        } catch (err) {
          // onRaw owns its own ack/nak; a throw here means the
          // dispatch logic itself failed (very rare — validator
          // doesn't throw, handler errors are caught inside). Log and
          // continue.
          console.error(
            `myelin-subscriber: pull dispatch error on "${sanitizeForLog(m.subject)}":`,
            err instanceof Error ? err.message : String(err),
          );
          safeNak(m);
        }
      }
    } catch (err) {
      if (!this.stopped) {
        console.error(
          "myelin-subscriber: pull consume loop error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      // Wait for init in case stop() is called before ready resolved —
      // we don't want to leak a half-bound consumer.
      try {
        await this.ready;
      } catch {
        // init failed; nothing to close. The init rejection has
        // already surfaced via the `ready` Promise (callers awaiting
        // `ready` see it); stop() is a no-op for that path.
        return;
      }
      const messages = this.messages;
      if (messages) {
        try {
          await messages.close();
        } catch (err) {
          console.error(
            "myelin-subscriber: pull close error:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (this.loopPromise) {
        // The loop owns its own try/catch, but we await it so callers
        // get deterministic teardown. The `.catch` swallows any
        // residual rejection from the run() promise itself (rare —
        // run() catches per-message errors internally, but if the
        // async-iterator itself rejects after stopping that's a
        // benign shutdown-time noise we don't want to surface here).
        await this.loopPromise.catch((_err: unknown) => undefined);
      }
    })();
    return this.stopPromise;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ack a JetStream message, swallowing the per-call error (logged). The
 * nats.js `JsMsg.ack/nak/term` methods are synchronous and very rarely
 * throw; we still guard so an ack failure doesn't take down the
 * consume loop.
 */
function safeAck(m: JsMsg): void {
  try {
    m.ack();
  } catch (err) {
    console.error(
      "myelin-subscriber: ack failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function safeNak(m: JsMsg): void {
  try {
    m.nak();
  } catch (err) {
    console.error(
      "myelin-subscriber: nak failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function safeTerm(m: JsMsg, reason: string): void {
  try {
    m.term(reason);
  } catch (err) {
    console.error(
      "myelin-subscriber: term failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function defaultHandlerErrorLog(err: Error, subject: string): void {
  console.error(
    `myelin-subscriber: onEnvelope handler error on "${sanitizeForLog(subject)}":`,
    err.message,
  );
}

function makeDefaultInvalidEnvelopeLog(logRawSnippet: boolean): InvalidEnvelopeHandler {
  return (reason, subject, rawSnippet) => {
    const safeSubject = sanitizeForLog(subject);
    // The reason string is built from data that may transitively echo
    // attacker-controlled bytes — JSON.parse's error message can include
    // the offending input, and Ajv's `instancePath` echoes attacker-
    // chosen JSON property names verbatim. Sanitize the assembled
    // string before interpolating into the log line so a crafted CRLF
    // in a key (e.g. `{"\n[FAKE-LOG]": …}`) cannot split the log.
    const reasonStr = sanitizeForLog(
      reason.kind === "json-parse"
        ? `JSON parse error: ${reason.message}`
        : `schema: ${reason.firstPath} ${reason.firstMessage} (${reason.errors.length} error(s))`,
    );
    // Always emit `data.length=N` so log-aggregation regexes have a
    // stable shape; append the sanitised snippet only when opt-in.
    const lengthSuffix = `data.length=${rawSnippet.length}`;
    const snippetSuffix = logRawSnippet
      ? `; payload snippet: ${sanitizeForLog(rawSnippet)}`
      : "";
    console.warn(
      `myelin-subscriber: dropped invalid envelope on "${safeSubject}" — ${reasonStr}; ${lengthSuffix}${snippetSuffix}`,
    );
  };
}

/**
 * First 200 bytes of the payload, decoded as UTF-8 with replacement chars
 * for invalid sequences.
 */
function safeSnippet(data: Uint8Array): string {
  return utf8.decode(data.slice(0, 200));
}
