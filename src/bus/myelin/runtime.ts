/**
 * G-1100.E: Myelin runtime — opt-in startup hook for grove-bot.
 *
 * Reads `bot.yaml.nats?` and, if present, opens a NatsLink and starts a
 * MyelinSubscriber per configured subject pattern. Logs received
 * envelopes (subject + envelope.id + correlation_id + type) for
 * visibility — no fan-out to existing handlers in this slice; that's
 * G-1101+ work.
 *
 * Coupling rule (per docs/design-collaboration-surface.md §9):
 * If `bot.yaml.nats` is absent, this module is a no-op — grove starts
 * without NATS just as it always has. The bot stays installable
 * without a NATS server present.
 */

import type { ConnectionOptions, NatsConnection } from "nats";
import type { BotConfig } from "../../common/types/config";
import { NatsLink } from "../nats/connection";
import { MyelinSubscriber } from "./subscriber";
import { deriveNatsSubject, type Envelope } from "./envelope-validator";

/**
 * Per-envelope handler. Receives validated envelopes from any active
 * subscription, with the actual NATS subject (so wildcard-pattern
 * subscribers can route on the concrete subject — see
 * `src/bus/surface-router.ts`, G-1111.A).
 */
export type EnvelopeHandler = (envelope: Envelope, subject: string) => void;

/** Lifecycle handle so cortex can clean up on shutdown. */
export interface MyelinRuntime {
  readonly enabled: boolean;
  /**
   * Register a fan-out handler. Multiple handlers may register; each
   * receives every envelope from every active subscription. Returns
   * an unregister token so the caller can detach on shutdown.
   *
   * The runtime's existing `logEnvelope` always runs alongside any
   * registered handlers — registration is additive, not a replacement.
   */
  onEnvelope(handler: EnvelopeHandler): { unregister: () => void };
  /**
   * Publish an envelope to NATS.
   *
   * Subject is derived from `envelope.sovereignty.classification` +
   * `envelope.type` per G-1111 §3.1 and the myelin grammar:
   *
   *   - `classification === "local"`     → `local.{org}.{type}`
   *   - `classification === "federated"` → `federated.{org}.{type}`
   *   - `classification === "public"`    → `public.{type}` (no `{org}` segment)
   *
   * `{org}` is the first dotted segment of `envelope.source` (which
   * cortex's `system-events.ts` etc. populate from `agent.operatorId`).
   * The 1:1 alignment between subject prefix and `sovereignty.classification`
   * is myelin's protocol-level invariant — see
   * {@link validateSubjectEnvelopeAlignment}.
   *
   * **IAW Phase A.3:** prior to this slice the runtime hardcoded
   * `local.{org}.{type}` here, making federated/public emission structurally
   * impossible. Subject derivation now mirrors classification, so an emit
   * site that opts into `classification: "federated"` flows end-to-end
   * (envelope + subject) without further runtime changes.
   *
   * **No-op when the runtime is disabled** (no NATS configured) so callers
   * can fire-and-forget without checking `enabled` first. This matters at
   * the adapter layer, where `runtime.publish(...)` may run on every shard
   * disconnect / recover regardless of operator NATS configuration.
   *
   * Errors at publish time are logged and swallowed — emitting an
   * operational `system.*` event must not crash the bot, especially when
   * the bot is already in a degraded state. JetStream durability
   * (per design-cortex.md §3.3) is the safety net for lost events.
   *
   * Resolves immediately — Core NATS publishes are fire-and-forget at the
   * client layer; the `Promise<void>` shape leaves room to upgrade to
   * `JetStream.publish` (which IS async) without breaking callers.
   */
  publish(envelope: Envelope): Promise<void>;
  /** Best-effort shutdown — drains subscribers, closes the link. */
  stop(): Promise<void>;
}

/**
 * Start the myelin runtime if `config.nats?` is present. Returns a
 * `MyelinRuntime` whose `enabled` field reflects whether anything was
 * actually started. Errors during startup are logged and swallowed —
 * a misconfigured NATS section must NOT crash the bot (the rest of
 * grove keeps working without it).
 */
/**
 * Internal/test-only options. Production callers pass `config` only;
 * tests inject a fake `connectImpl` to avoid standing up a real
 * `nats-server`. The shape mirrors `NatsLink.connect`'s own seam
 * (typed against `ConnectionOptions` from `nats`) so a fake here is a
 * fake there — no `unknown`, no `as never` casts.
 *
 * @internal — not meant for production use; the constructor signature
 *             may change without semver guarantees.
 */
export interface MyelinRuntimeOptions {
  connectImpl?: (opts: ConnectionOptions) => Promise<NatsConnection>;
}

export async function startMyelinRuntime(
  config: BotConfig,
  options?: MyelinRuntimeOptions,
): Promise<MyelinRuntime> {
  // Fan-out registry — populated regardless of whether NATS itself
  // starts. Callers (like the surface-router) can safely register
  // even when the runtime is a no-op; their handlers simply never
  // fire, which is the right semantic for a bot started without
  // NATS configured.
  const handlers = new Set<EnvelopeHandler>();
  const onEnvelope = (handler: EnvelopeHandler) => {
    handlers.add(handler);
    return {
      unregister: () => {
        handlers.delete(handler);
      },
    };
  };

  // Disabled `publish` — same opt-in semantics as `onEnvelope`. Adapters
  // call `runtime.publish(...)` from inside reconnect callbacks regardless
  // of whether NATS is configured; making this a no-op (rather than a
  // throw) keeps adapter code simple. The `enabled === false` flag is the
  // explicit signal for callers who DO want to gate.
  const publishDisabled = async (_envelope: Envelope) => {};

  if (!config.nats?.url) {
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      stop: async () => {},
    };
  }

  const nats = config.nats;
  const subjects = nats.subjects.map((s) =>
    s.replaceAll("{org}", config.agent.operatorId ?? "default"),
  );

  if (subjects.length === 0) {
    // cortex#88 item 6: empty `subjects` is the typical state today —
    // cortex publishes envelopes but doesn't subscribe (subscription
    // routing is G-1111+ territory). Demoted from `console.warn` to
    // `console.info`: the prior wording ("no subscriptions started")
    // misled every operator into chasing a phantom misconfiguration on
    // every boot. The runtime IS still considered disabled here because
    // `publish` from this branch requires the same connect-and-subscribe
    // path the populated case takes — keeping the early-return preserves
    // the existing publish-disabled contract until G-1111 wires the
    // publish-only mode end-to-end.
    console.info(
      "myelin-runtime: nats.url configured, nats.subjects empty — no subscriptions started (this is normal for current cortex deployments; subscription routing lands in G-1111)",
    );
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      stop: async () => {},
    };
  }

  let link: NatsLink;
  const safeUrl = nats.url.replace(/\/\/[^@/]+@/, "//***@");
  try {
    link = await NatsLink.connect({
      url: nats.url,
      token: nats.token,
      // cortex#86: operator-mode auth path. NatsLink loader expands ~/
      // and enforces chmod 600; if both token and credsPath are set,
      // credsPath wins with a warn log.
      ...(nats.credsPath ? { credsPath: nats.credsPath } : {}),
      name: nats.name,
      ...(options?.connectImpl ? { connectImpl: options.connectImpl } : {}),
    });
    console.log(
      `myelin-runtime: connected to ${safeUrl} as "${nats.name}"`,
    );
  } catch (err) {
    console.error(
      "myelin-runtime: failed to connect — continuing without NATS:",
      err instanceof Error ? err.message : err,
    );
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      stop: async () => {},
    };
  }

  const subscribers: MyelinSubscriber[] = [];
  for (const pattern of subjects) {
    try {
      const sub = MyelinSubscriber.start(link, {
        pattern,
        onEnvelope: (env, subject) => {
          logEnvelope(env, subject);
          // Fan out to registered handlers. Each handler runs in its
          // own try/catch so one slow/failing consumer can't poison
          // the others (router-level isolation lives in the
          // surface-router; this is a defensive last line).
          for (const handler of handlers) {
            try {
              handler(env, subject);
            } catch (err) {
              console.error(
                "myelin-runtime: onEnvelope handler threw:",
                err instanceof Error ? err.message : err,
              );
            }
          }
        },
      });
      subscribers.push(sub);
      console.log(`myelin-runtime: subscribed to "${pattern}"`);
    } catch (err) {
      console.error(
        `myelin-runtime: failed to subscribe to "${pattern}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (subscribers.length === 0) {
    // Nothing actually subscribed — close the link so we don't hold a
    // socket open for nothing.
    await link.close().catch(() => {});
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      stop: async () => {},
    };
  }

  let stopped = false;

  const publishEnabled = async (envelope: Envelope): Promise<void> => {
    if (stopped) {
      // Post-stop publish: short-circuit. The runtime's `link.drain()`
      // (called inside `stop()` below) flushes pending publishes before the
      // underlying connection closes; a publish call that races between
      // `stopped = true` and `link.close()` would either flush along with
      // drain or be dropped silently — never crash the caller. The check
      // here is belt-and-braces: the underlying nats client is already
      // drain-safe, but short-circuiting at this layer keeps the contract
      // explicit ("publish-after-stop is a no-op") and saves a JSON.stringify
      // of the envelope on the shutdown path.
      return;
    }
    // IAW Phase A.3: subject derivation now mirrors
    // `envelope.sovereignty.classification`. Prior code hardcoded
    // `local.{org}.{type}` here, making federated/public emission
    // structurally impossible — `{org}` came from `config.agent.operatorId`
    // and the classification prefix was always "local". `deriveNatsSubject`
    // reads classification + extracts `{org}` from `envelope.source` so the
    // 1:1 subject↔classification invariant
    // (`validateSubjectEnvelopeAlignment`) holds for every emit site
    // without further changes. `envelope.source`'s first segment is the
    // same value `agent.operatorId` produces when emit-site helpers
    // assemble it, so subscribe-side `{org}` substitution stays symmetric.
    const subject = deriveNatsSubject(envelope);
    try {
      link.publish(subject, JSON.stringify(envelope));
    } catch (err) {
      // Swallow + log per the contract on `MyelinRuntime.publish`. A failing
      // operational event must NOT escalate into a crash, particularly since
      // most failure modes here (closed connection, oversized payload) are
      // already-bad-state signals.
      console.error(
        `myelin-runtime: publish failed for subject=${subject} id=${envelope.id} type=${envelope.type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  return {
    enabled: true,
    onEnvelope,
    publish: publishEnabled,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Drain subscribers first so they exit cleanly; then close the
      // underlying link.
      await Promise.allSettled(subscribers.map((s) => s.stop()));
      await link.close().catch((err) => {
        console.error(
          "myelin-runtime: close error:",
          err instanceof Error ? err.message : err,
        );
      });
      console.log("myelin-runtime: stopped");
    },
  };
}

/**
 * Default envelope handler for G-1100.E — log enough context that an
 * operator triaging a missing-message complaint can find the envelope
 * in the bus. Fan-out to specific event handlers (pilot errand
 * projection, signal alert ingestion, etc.) is the next iteration's
 * work and uses the same Envelope type from this layer.
 */
function logEnvelope(env: Envelope, subject: string): void {
  const corr = env.correlation_id ? ` correlation=${env.correlation_id}` : "";
  console.log(
    `myelin-runtime: received envelope subject=${subject} id=${env.id} type=${env.type}${corr}`,
  );
}
