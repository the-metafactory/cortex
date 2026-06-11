/**
 * #989 part-1 — sibling-bus PRESENCE aggregator.
 *
 * For each discovered sibling stack ({@link SiblingStackDescriptor}), open a
 * READ-ONLY subscriber to that sibling's OWN local NATS bus and fold its
 * `local.{siblingPrincipal}.{siblingStack}.agent.>` presence stream into the
 * SHARED {@link AgentPresenceRegistry} — the same registry the serving stack's
 * own B.3 path folds its own presence into. Each sibling agent is tagged with
 * its `{principal}/{stack}` ORIGIN (`origin: { kind: "foreign", … }`), so
 * `/api/agents` groups it under its own stack-hub and the Network view renders
 * every local stack as a distinct hub (#989).
 *
 * ## Why `applyForeign`, with NO trust machinery
 *
 * This MIRRORS the federated subscriber's fold (`federated-subscriber.ts`) —
 * same registry, same origin-tagged record — but DROPS the cross-principal trust
 * machinery (accept-list gate + `signed_by[]` chain verification). It is safe to
 * drop because this is the PRINCIPAL'S OWN bus: the daemon connects with the
 * principal's own credential to a loopback bus the principal owns end-to-end
 * (ADR-0005 — the principal sees their own interiors). There is no cross-
 * principal boundary to defend. We STILL call {@link AgentPresenceRegistry.applyForeign}
 * (not `apply`) because:
 *   - it tags the record with the sibling's origin so the view groups by hub, and
 *   - it source-binds identity to the DISCOVERED `{principal}/{stack}` (the
 *     `verifiedScope`), so a sibling that somehow emits a mis-scoped payload is
 *     dropped rather than painting a wrong-hub record — a cheap consistency guard,
 *     not a trust boundary.
 *
 * ## Resilience (the load-bearing contract)
 *
 *   - A sibling whose connection FAILS at start (bus down, auth fault) is
 *     recorded in `degraded[]`, logged to stderr, and SKIPPED — the serving
 *     daemon's boot is never blocked and no exception escapes. That stack's hub
 *     simply doesn't appear until the next process start.
 *   - A sibling with a `noauth` credential is connected WITHOUT a credential
 *     (an open loopback bus accepts it; a locked NSC bus rejects it and the
 *     connect-failure path above degrades it to absent + logs why). Minting a
 *     read-only observer user for a locked bus is a #989 follow-up.
 *   - Malformed bytes / bad envelopes on a sibling bus are dropped by the
 *     registry's best-effort fold (logged), never thrown.
 *   - The serving stack's OWN presence path (B.3 + the producer) is untouched —
 *     this aggregator only ADDS foreign records to the shared registry.
 *
 * ## Liveness
 *
 * Sibling records flow through the SAME registry, so the existing 5-minute TTL
 * reaper ({@link AgentPresenceRegistry.startReaper}, started by the B.3 wiring)
 * applies to them too: a sibling that goes quiet (its bus drops, or its agents
 * stop heartbeating) ages out to `offline` exactly like a local agent.
 */

import { tryParseEnvelope } from "../../../bus/myelin/envelope-validator";
import type { AgentPresenceRegistry } from "../../../bus/agent-network/registry";
import type { SiblingStackDescriptor } from "./sibling-discovery";

/**
 * The read-only handle on ONE sibling bus the aggregator drives. A test passes
 * a fake; production passes a NATS-backed implementation (see
 * {@link natsSiblingBusConnector}).
 */
export interface SiblingBusConnection {
  /**
   * Subscribe to `pattern` on this sibling bus, invoking `onMessage` per raw
   * message. Called exactly ONCE per connection (the aggregator binds the
   * sibling's `local.{principal}.{stack}.agent.>` subtree).
   */
  subscribe(
    pattern: string,
    onMessage: (subject: string, data: Uint8Array) => void,
  ): void;
  /** Close the connection + drain. Idempotent on the production side. */
  close(): Promise<void>;
}

/**
 * Open a read-only connection to a sibling bus. THROWS when the bus is
 * unreachable / auth fails — the aggregator catches it and degrades that
 * sibling to absent (never crashes boot). Injectable so tests avoid real NATS.
 */
export type SiblingBusConnector = (
  sibling: SiblingStackDescriptor,
) => Promise<SiblingBusConnection>;

/** A sibling that did NOT aggregate, with the reason (for logs + the handle). */
export interface DegradedSibling {
  stack: string;
  reason: string;
}

/** Lifecycle handle for the sibling-presence aggregator. */
export interface SiblingPresenceAggregatorHandle {
  /**
   * Siblings that are NOT being aggregated — an unresolved credential, or a
   * connection that failed at start. Surfaced so the boot log (and a future
   * `/api/agents` diagnostics field) can show which local stacks are dark and
   * why. Empty when every sibling connected.
   */
  readonly degraded: readonly DegradedSibling[];
  /** Stop every sibling subscriber + close its link. Idempotent. */
  stop(): Promise<void>;
}

/** Options for {@link startSiblingPresenceAggregator}. */
export interface StartSiblingPresenceAggregatorOptions {
  /** The SHARED registry — same instance the B.3 local path folds into. */
  registry: AgentPresenceRegistry;
  /** Discovered siblings to aggregate (see {@link discoverSiblingStacks}). */
  siblings: readonly SiblingStackDescriptor[];
  /** Per-bus connector. Tests inject a fake; production uses the NATS connector. */
  connect: SiblingBusConnector;
}

/**
 * The subject subtree the aggregator binds on a sibling's bus — the sibling's
 * OWN stack-local presence subtree. `local.{principal}.{stack}.agent.>`.
 */
function siblingPresenceSubject(principal: string, stack: string): string {
  return `local.${principal}.${stack}.agent.>`;
}

/**
 * Start the sibling-presence aggregator. Opens one read-only subscriber per
 * connectable sibling and folds its presence into the shared registry, tagged
 * with the sibling's origin. NON-THROWING: a sibling that can't connect is
 * degraded to absent, never an exception.
 */
export async function startSiblingPresenceAggregator(
  opts: StartSiblingPresenceAggregatorOptions,
): Promise<SiblingPresenceAggregatorHandle> {
  const { registry, siblings, connect } = opts;
  const connections: SiblingBusConnection[] = [];
  const degraded: DegradedSibling[] = [];

  for (const sibling of siblings) {
    // Every credential kind (`creds` + `noauth`) gets a connect attempt — a
    // `noauth` open bus connects, a locked one fails the connect below and is
    // degraded there. No pre-judging.
    let conn: SiblingBusConnection;
    try {
      conn = await connect(sibling);
    } catch (err) {
      // GRACEFUL DEGRADE — bus down / auth fault at start. Log + skip; the
      // serving daemon's boot is never blocked, no exception escapes.
      const reason = `connect failed: ${err instanceof Error ? err.message : String(err)}`;
      degraded.push({ stack: sibling.stack, reason });
      process.stderr.write(
        `sibling-presence: "${sibling.stack}" (${sibling.url}) not aggregated — ${reason}\n`,
      );
      continue;
    }

    connections.push(conn);
    const pattern = siblingPresenceSubject(sibling.principal, sibling.stack);
    // SOURCE-BIND identity to the DISCOVERED sibling — a cheap consistency guard
    // (a mis-scoped payload is dropped, never paints a wrong-hub record). NOT a
    // trust boundary: this is the principal's own loopback bus.
    const verifiedScope = {
      principal: sibling.principal,
      stack: sibling.stack,
    };
    conn.subscribe(pattern, (_subject, data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(data));
      } catch (err) {
        // Malformed bytes — drop (logged), never throw into the bus callback.
        process.stderr.write(
          `sibling-presence: "${sibling.stack}" dropping un-JSON message: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        return;
      }
      const envelope = tryParseEnvelope(parsed);
      if (envelope === null) {
        // Not a valid envelope — drop quietly (the registry's own fold would
        // also reject it; we stop it earlier to avoid a needless apply call).
        return;
      }
      // Fold with the sibling's origin. `applyForeign` tags the record foreign +
      // source-binds identity to `verifiedScope`; a payload.scope mismatch is
      // dropped by the registry (logged there).
      registry.applyForeign(envelope, verifiedScope);
    });
  }

  let stopped = false;
  return {
    degraded,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // Close every sibling link. Best-effort: a close fault on one link must
      // not prevent closing the others.
      await Promise.allSettled(connections.map((c) => c.close()));
      // Drop the foreign records this aggregator added so a stop cleanly clears
      // sibling hubs (mirrors the federated subscriber's removeForeign on stop).
      registry.removeForeign();
    },
  };
}
