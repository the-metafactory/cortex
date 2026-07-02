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
    // cortex#1186 — `filter_subject` is immutable on a durable, so a filter
    // drift is migrated by delete + recreate.
    delete(stream: string, durable: string): Promise<boolean>;
  };
}

/**
 * R26 P1 (cortex#1371) — one entry read from a {@link ProvisionKv} bucket.
 * Mirror of nats.js's `KvEntry` minus everything the admission gate doesn't
 * touch. `operation` matters: a `DEL`/`PURGE` tombstone is still returned by
 * `get()` with a live revision — consumers MUST treat it as "absent value"
 * while still CAS-ing against its revision.
 */
export interface ProvisionKvEntry {
  value: Uint8Array;
  revision: number;
  operation: "PUT" | "DEL" | "PURGE";
}

/**
 * Narrow NATS-KV surface — the subset of nats.js's `KV` view the admission
 * gate uses (myelin `specs/admission.md` §5: get → create-if-absent →
 * CAS-update on revision). Same neutral-module rationale as
 * {@link ProvisionJsm}: the MyelinRuntime exposes a `kvBucket()` capability
 * returning this shape, tests stub it in-memory, and the runtime stays
 * decoupled from nats.js's full materialized-views surface.
 */
export interface ProvisionKv {
  get(key: string): Promise<ProvisionKvEntry | null>;
  /** Create-if-absent — rejects when the key already exists (CAS on absence). */
  create(key: string, value: Uint8Array): Promise<number>;
  /** Compare-and-swap update — rejects unless `revision` is the live revision. */
  update(key: string, value: Uint8Array, revision: number): Promise<number>;
}
