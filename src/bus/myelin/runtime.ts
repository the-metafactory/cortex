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
import type { Envelope } from "./envelope-validator";

/** Lifecycle handle so grove-bot can clean up on shutdown. */
export interface MyelinRuntime {
  readonly enabled: boolean;
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
  if (!config.nats?.url) {
    return { enabled: false, stop: async () => {} };
  }

  const nats = config.nats;
  const subjects = nats.subjects.map((s) =>
    s.replaceAll("{org}", config.agent.operatorId ?? "default"),
  );

  if (subjects.length === 0) {
    console.warn(
      "grove-bot: nats.url configured but nats.subjects is empty — no subscriptions started",
    );
    return { enabled: false, stop: async () => {} };
  }

  let link: NatsLink;
  const safeUrl = nats.url.replace(/\/\/[^@/]+@/, "//***@");
  try {
    link = await NatsLink.connect({
      url: nats.url,
      token: nats.token,
      name: nats.name,
      ...(options?.connectImpl ? { connectImpl: options.connectImpl } : {}),
    });
    console.log(
      `grove-bot: myelin runtime connected to ${safeUrl} as "${nats.name}"`,
    );
  } catch (err) {
    console.error(
      "grove-bot: myelin runtime failed to connect — continuing without NATS:",
      err instanceof Error ? err.message : err,
    );
    return { enabled: false, stop: async () => {} };
  }

  const subscribers: MyelinSubscriber[] = [];
  for (const pattern of subjects) {
    try {
      const sub = MyelinSubscriber.start(link, {
        pattern,
        onEnvelope: (env, subject) => logEnvelope(env, subject),
      });
      subscribers.push(sub);
      console.log(`grove-bot: myelin subscribed to "${pattern}"`);
    } catch (err) {
      console.error(
        `grove-bot: myelin failed to subscribe to "${pattern}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (subscribers.length === 0) {
    // Nothing actually subscribed — close the link so we don't hold a
    // socket open for nothing.
    await link.close().catch(() => {});
    return { enabled: false, stop: async () => {} };
  }

  let stopped = false;
  return {
    enabled: true,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Drain subscribers first so they exit cleanly; then close the
      // underlying link.
      await Promise.allSettled(subscribers.map((s) => s.stop()));
      await link.close().catch((err) => {
        console.error(
          "grove-bot: myelin runtime close error:",
          err instanceof Error ? err.message : err,
        );
      });
      console.log("grove-bot: myelin runtime stopped");
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
    `grove-bot: myelin received envelope subject=${subject} id=${env.id} type=${env.type}${corr}`,
  );
}
