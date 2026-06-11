/**
 * #989 part-1 — production NATS connector for the sibling-presence aggregator.
 *
 * Adapts the bus-layer {@link NatsLink} + {@link NatsSubscription} primitives to
 * the aggregator's {@link SiblingBusConnection} interface. One {@link NatsLink}
 * per sibling bus (its OWN loopback url + its OWN `.creds`), one
 * {@link NatsSubscription} bound to the sibling's `local.{principal}.{stack}.agent.>`
 * subtree. READ-ONLY: it only subscribes, never publishes.
 *
 * Kept SEPARATE from the aggregator core (`sibling-presence-subscriber.ts`) so
 * the core stays NATS-free + unit-testable (a fake connector), and this thin
 * adapter is the only place that touches real NATS — mirroring how the rest of
 * the codebase keeps `NatsLink` wiring at the edges.
 *
 * `NatsLink.connect` THROWS when the bus is unreachable / auth fails; the
 * aggregator catches that and degrades the sibling to absent (never crashes
 * boot). This connector does NOT swallow — it lets the throw propagate so the
 * aggregator's single degrade path owns the policy.
 */

import { NatsLink } from "../../../bus/nats/connection";
import { NatsSubscription } from "../../../bus/nats/subscription";
import type {
  SiblingBusConnection,
  SiblingBusConnector,
} from "./sibling-presence-subscriber";
import type { SiblingStackDescriptor } from "./sibling-discovery";

/** A live NATS-backed sibling connection: one link + one subscription. */
class NatsSiblingBusConnection implements SiblingBusConnection {
  private readonly link: NatsLink;
  private subscription: NatsSubscription | null = null;

  constructor(link: NatsLink) {
    this.link = link;
  }

  subscribe(
    pattern: string,
    onMessage: (subject: string, data: Uint8Array) => void,
  ): void {
    // NatsSubscription auto-resubscribes on reconnect — a sibling bus that
    // bounces re-binds without losing the aggregator. Handler errors are logged
    // by the subscription's default error sink; we keep onMessage non-throwing
    // (the aggregator's parse/fold already swallow), so the sink rarely fires.
    this.subscription = NatsSubscription.start(this.link, {
      pattern,
      onMessage,
    });
  }

  async close(): Promise<void> {
    // Stop the subscription first (drains in-flight), then close the link.
    if (this.subscription !== null) {
      await this.subscription.stop();
    }
    await this.link.close();
  }
}

/**
 * The production {@link SiblingBusConnector}. Opens a read-only `NatsLink` to the
 * sibling's bus:
 *   - `creds`  → connect with the declared `.creds` file (operator-mode auth).
 *   - `noauth` → connect with NO credential. An OPEN loopback bus (e.g. halden's
 *     `nats-server -js`) accepts it; a LOCKED NSC bus rejects it with an
 *     Authorization Violation — `NatsLink.connect` throws, the aggregator
 *     catches it, and that sibling degrades to absent (logged). The throw is
 *     intentional — this connector lets the aggregator's single degrade path
 *     own the policy rather than swallowing here.
 */
export const natsSiblingBusConnector: SiblingBusConnector = async (
  sibling: SiblingStackDescriptor,
): Promise<SiblingBusConnection> => {
  const link = await NatsLink.connect({
    url: sibling.url,
    // `creds` ⇒ supply the credsPath; `noauth` ⇒ omit it (unauthenticated
    // connect — the open-bus path).
    ...(sibling.credential.kind === "creds"
      ? { credsPath: sibling.credential.credsPath }
      : {}),
    // A distinct connection name so the sibling bus's `varz` shows WHO is
    // observing (the serving stack aggregating that sibling read-only).
    name: `cortex-mc-aggregator:${sibling.stack}`,
  });
  return new NatsSiblingBusConnection(link);
};
