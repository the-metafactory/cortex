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
 */

import type { ErrorObject } from "ajv/dist/2020";
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

export interface MyelinSubscriberOptions {
  /** NATS subject pattern, e.g. `local.acme.>`. Required. */
  pattern: string;
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
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Strip C0 control characters (newlines, tabs, etc.) to prevent log injection. */
function sanitizeForLog(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * A live myelin subscriber. Wraps a `NatsSubscription`; same lifecycle
 * (start at construction, stop via `stop()`, reconnects handled by the
 * inner subscription).
 */
export class MyelinSubscriber {
  readonly pattern: string;
  private readonly subscription: NatsSubscription;
  private readonly onEnvelope: EnvelopeHandler;
  private readonly onError: EnvelopeErrorHandler;
  private readonly onInvalidEnvelope: InvalidEnvelopeHandler;

  private constructor(link: NatsLink, opts: MyelinSubscriberOptions) {
    this.pattern = opts.pattern;
    this.onEnvelope = opts.onEnvelope;
    this.onError = opts.onError ?? defaultHandlerErrorLog;
    this.onInvalidEnvelope =
      opts.onInvalidEnvelope ?? makeDefaultInvalidEnvelopeLog(opts.logRawSnippet ?? false);

    this.subscription = NatsSubscription.start(link, {
      pattern: opts.pattern,
      onMessage: (subject, data) => this.handleRaw(subject, data),
      onError: (err, subject) => this.onError(err, subject),
    });
  }

  /** Start a new myelin subscriber. */
  static start(link: NatsLink, opts: MyelinSubscriberOptions): MyelinSubscriber {
    return new MyelinSubscriber(link, opts);
  }

  /** Stop the subscriber. Drains the inner subscription. Idempotent. */
  async stop(): Promise<void> {
    await this.subscription.stop();
  }

  private async handleRaw(subject: string, data: Uint8Array): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(data));
    } catch (err) {
      this.onInvalidEnvelope(
        { kind: "json-parse", message: err instanceof Error ? err.message : String(err) },
        subject,
        safeSnippet(data),
      );
      return;
    }

    const result = validateEnvelope(parsed);
    if (!result.ok) {
      const first = result.errors[0];
      this.onInvalidEnvelope(
        {
          kind: "schema",
          errors: result.errors,
          firstPath: first?.instancePath || "/",
          firstMessage: first?.message ?? "(no message)",
        },
        subject,
        safeSnippet(data),
      );
      return;
    }

    try {
      await this.onEnvelope(result.envelope, subject);
    } catch (err) {
      this.onError(
        err instanceof Error ? err : new Error(String(err)),
        subject,
      );
    }
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

/** First 200 bytes of the payload, decoded as UTF-8 with replacement chars
 *  for invalid sequences. */
function safeSnippet(data: Uint8Array): string {
  return utf8.decode(data.slice(0, 200));
}
