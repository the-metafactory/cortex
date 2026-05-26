/**
 * cortex#338 — neutral JetStream type module.
 *
 * Holds the narrow `ProvisionJsm` shape — the subset of nats.js's
 * `JetStreamManager` we use across the codebase — so both the
 * MyelinRuntime (which exposes a `jetstreamManager()` capability) and
 * the review-provisioning helpers can import the type without the
 * runtime needing to depend on the review-specific `provision.ts`
 * module (per sage review on #338 round 3 — Architecture).
 *
 * Keep this file dependency-free apart from `nats` type imports. Any
 * future JetStream capability that needs a narrower / wider subset of
 * the JSM surface can add a sibling alias here without dragging
 * review-specific concerns into the boundary.
 */

import type { ConsumerConfig, StreamConfig, StreamInfo, ConsumerInfo } from "nats";

/**
 * Narrow JetStreamManager surface — the operations the provisioning
 * helpers (and any consumer of `MyelinRuntime.jetstreamManager()`)
 * touch. Mirror of `nats.JetStreamManager` minus everything we don't
 * call. Tests stub this; production wires it via the runtime helper
 * which delegates to `nc.jetstreamManager()`.
 */
export interface ProvisionJsm {
  streams: {
    info(name: string): Promise<StreamInfo>;
    add(cfg: Partial<StreamConfig>): Promise<StreamInfo>;
  };
  consumers: {
    info(stream: string, durable: string): Promise<ConsumerInfo>;
    add(stream: string, cfg: Partial<ConsumerConfig>): Promise<ConsumerInfo>;
    update(
      stream: string,
      durable: string,
      cfg: Partial<ConsumerConfig>,
    ): Promise<ConsumerInfo>;
  };
}
