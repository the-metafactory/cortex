/**
 * G-1114.B.3 — stack-local runtime agent-presence registry (subscriber).
 *
 * The consumer half of the Phase B end-to-end wiring. It subscribes to the
 * stack's own `local.{principal}.{stack}.agent.>` subtree (STACK-LOCAL ONLY —
 * NO `federated.` namespace yet; that is Phase E / G-1114.E) and folds the
 * inbound `agent.*` presence stream into an in-memory, observable map keyed by
 * agent identity.
 *
 * ## What it records (B.3 scope)
 *
 *   - `agent.online`               → upsert a record, `state: "online"`, store
 *                                    the initial capability set + `startedAt`.
 *   - `agent.heartbeat`            → bump `lastHeartbeatAt` (+ refresh `lastSeenAt`);
 *                                    an unknown agent is upserted as `online`
 *                                    (a heartbeat is itself a liveness signal —
 *                                    we never want a heartbeat from an agent we
 *                                    missed the `online` for to be dropped).
 *   - `agent.offline`              → mark the record `state: "offline"`, store
 *                                    the reason.
 *   - `agent.capabilities-changed` → store the latest full capability set
 *                                    (B records the LATEST set only; the full
 *                                    diff/reconcile handling is Phase C).
 *
 * ## Boundary — what it does NOT do (deferred to Phase C / G-1114.C)
 *
 *   - **No liveness FSM / TTL expiry.** B records `lastHeartbeatAt` + the last
 *     explicit state only. The 5-minute liveness TTL → `offline` transition
 *     (a record going stale because heartbeats STOPPED, with no `agent.offline`
 *     envelope) is Phase C's reaper. B never times anything out — a record stays
 *     `online` until an explicit `agent.offline` arrives. This is the
 *     deliberate B/C split (ADR-0007 §Consequences: "the liveness FSM … TTL
 *     lapse" is its own line item).
 *   - **No capability diffing.** B stores the latest set; C computes the delta
 *     against the prior record + reconciles.
 *   - **No federation.** B subscribes to `local.` only. The `federated.`
 *     subtree is Phase E.
 *
 * ## Observability seam (for B.4 + the MC API)
 *
 * The registry is queryable via {@link AgentPresenceRegistry.getAgents} (a
 * snapshot copy — callers can't mutate internal state) and exposes a
 * change-notification seam via {@link AgentPresenceRegistry.onChange} so the
 * B.4 panel (and the MC projection) can subscribe to live updates rather than
 * poll. Every applied envelope that mutates a record fires the change callbacks
 * AFTER the mutation, with the affected agent key + the new snapshot.
 *
 * ## Wiring
 *
 * `startAgentPresenceRegistry` self-subscribes via `runtime.subscribe(pattern)`
 * (the cortex#477 push-mode seam — same model the dispatch-listener uses) and
 * registers a `runtime.onEnvelope` fan-out handler that filters by subject
 * against the stack-local pattern. On `runtime.enabled === false` (no NATS) the
 * registry stays dormant but constructed — `getAgents()` returns `[]` and the
 * boot/shutdown wiring behaves identically whether or not the bus is up
 * (matching every other capability-side boot feature).
 */

import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../myelin/runtime";
import type { MyelinSubscriber } from "../myelin/subscriber";
import { subjectMatches } from "../surface-router";
import {
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
  AgentOnlinePayloadSchema,
  AgentHeartbeatPayloadSchema,
  AgentOfflinePayloadSchema,
  AgentCapabilitiesChangedPayloadSchema,
  type AgentOfflineReason,
} from "./envelopes";

/**
 * The observable presence state for one agent. Keyed in the registry by
 * {@link AgentPresenceRecord.key} (`{principal}/{stack}/{agent_id}` — see
 * {@link recordKey}).
 *
 * `state` carries only what B observes from explicit envelopes: an agent is
 * `online` after `agent.online` / `agent.heartbeat`, `offline` after an
 * explicit `agent.offline`. There is deliberately NO `"stale"`/TTL-derived
 * state in B — that transition is Phase C's liveness FSM.
 */
export interface AgentPresenceRecord {
  /** Stable map key — `{principal}/{stack}/{agent_id}`. */
  key: string;
  /** Logical agent id (`luna`, `echo`, …). */
  agentId: string;
  /** The agent's NKey public key (stable cross-restart identity). */
  nkeyPublicKey: string;
  /** Soma-layer assistant name the agent hosts, or `null` when none. */
  assistantName: string | null;
  /** `{principal}` the agent lives in. */
  principal: string;
  /** `{stack}` the agent lives in. */
  stack: string;
  /** Latest known declared capability set. */
  capabilities: readonly string[];
  /** Last explicit liveness state observed from an envelope. */
  state: "online" | "offline";
  /** Reason from the last `agent.offline`, when `state === "offline"`. */
  offlineReason?: AgentOfflineReason;
  /** Boot time from the last `agent.online` (ISO-8601), when known. */
  startedAt?: string;
  /**
   * Timestamp of the last `agent.heartbeat` observed (epoch ms, receiver
   * clock). Phase C's TTL reaper reads this; B only records it. Undefined
   * until the first heartbeat arrives.
   */
  lastHeartbeatAt?: number;
  /** Timestamp any presence envelope was last applied for this agent (epoch ms). */
  lastSeenAt: number;
}

/** A change callback — invoked AFTER a record mutates, with the new snapshot. */
export type AgentPresenceChangeListener = (
  key: string,
  record: AgentPresenceRecord,
) => void;

/** Unregister handle returned by {@link AgentPresenceRegistry.onChange}. */
export interface AgentPresenceChangeSubscription {
  unsubscribe(): void;
}

/**
 * Compute the stable registry key for an identity+scope pair.
 * `{principal}/{stack}/{agent_id}` — the same agent in two stacks is two
 * records; the same agent_id across restarts is one record (state converges).
 */
function recordKey(principal: string, stack: string, agentId: string): string {
  return `${principal}/${stack}/${agentId}`;
}

/** Optional injection points — tests pass a clock; production omits. */
export interface AgentPresenceRegistryOptions {
  /** Receiver clock for `lastHeartbeatAt` / `lastSeenAt`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-memory observable agent-presence registry. Pure state + a fold over the
 * `agent.*` envelope stream — no bus wiring of its own (that is
 * {@link startAgentPresenceRegistry}'s job). Unit-testable by feeding
 * envelopes to {@link apply} directly.
 */
export class AgentPresenceRegistry {
  private readonly records = new Map<string, AgentPresenceRecord>();
  private readonly listeners = new Set<AgentPresenceChangeListener>();
  private readonly now: () => number;

  constructor(opts: AgentPresenceRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Apply one presence envelope to the registry. Best-effort: an envelope
   * whose payload fails the Phase A schema is logged + dropped (a malformed
   * presence envelope must never throw into the bus fan-out path). Returns the
   * mutated record, or `null` when the envelope was dropped (bad payload /
   * non-presence type).
   */
  apply(envelope: Envelope): AgentPresenceRecord | null {
    switch (envelope.type) {
      case AGENT_ONLINE_TYPE:
        return this.applyOnline(envelope);
      case AGENT_HEARTBEAT_TYPE:
        return this.applyHeartbeat(envelope);
      case AGENT_OFFLINE_TYPE:
        return this.applyOffline(envelope);
      case AGENT_CAPABILITIES_CHANGED_TYPE:
        return this.applyCapabilitiesChanged(envelope);
      default:
        // Not a presence envelope — the subject filter should have excluded
        // it, but be defensive (the fan-out delivers every matching envelope).
        return null;
    }
  }

  private applyOnline(envelope: Envelope): AgentPresenceRecord | null {
    const parsed = AgentOnlinePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const key = recordKey(p.scope.principal, p.scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    const record: AgentPresenceRecord = {
      key,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: p.scope.principal,
      stack: p.scope.stack,
      capabilities: p.capabilities,
      state: "online",
      startedAt: p.started_at,
      // online clears any prior offline reason (an online agent is not
      // offline) but preserves a prior heartbeat timestamp if one exists.
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyHeartbeat(envelope: Envelope): AgentPresenceRecord | null {
    const parsed = AgentHeartbeatPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const key = recordKey(p.scope.principal, p.scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    // An unknown agent's heartbeat is itself a liveness signal — upsert it as
    // online rather than drop it (we may have missed the `online`). It carries
    // no capability list, so capabilities default to [] until an online /
    // capabilities-changed fills them.
    const record: AgentPresenceRecord = {
      key,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: p.scope.principal,
      stack: p.scope.stack,
      capabilities: existing?.capabilities ?? [],
      state: "online",
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      lastHeartbeatAt: ts,
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyOffline(envelope: Envelope): AgentPresenceRecord | null {
    const parsed = AgentOfflinePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const key = recordKey(p.scope.principal, p.scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    const record: AgentPresenceRecord = {
      key,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: p.scope.principal,
      stack: p.scope.stack,
      capabilities: existing?.capabilities ?? [],
      state: "offline",
      offlineReason: p.reason,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyCapabilitiesChanged(envelope: Envelope): AgentPresenceRecord | null {
    const parsed = AgentCapabilitiesChangedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const key = recordKey(p.scope.principal, p.scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    // B stores the LATEST capability set only. The diff/reconcile (against the
    // prior set) is Phase C — here we just converge to the new full set.
    const record: AgentPresenceRecord = {
      key,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: p.scope.principal,
      stack: p.scope.stack,
      capabilities: p.capabilities,
      // capabilities-changed does not assert liveness state; preserve the
      // prior state (default online — an agent emitting it is alive).
      state: existing?.state ?? "online",
      ...(existing?.offlineReason !== undefined && {
        offlineReason: existing.offlineReason,
      }),
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private dropMalformed(envelope: Envelope, err: unknown): null {
    // Per CLAUDE.md "no empty catch blocks" — log + drop. A malformed presence
    // payload is an observability gap, never a reason to throw into the bus
    // fan-out (which would take down delivery for every other handler).
    process.stderr.write(
      `agent-presence-registry: dropping malformed ${envelope.type} envelope ` +
        `(id=${envelope.id}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  private emit(key: string, record: AgentPresenceRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(key, record);
      } catch (err) {
        // A listener throwing must not break sibling listeners or the apply
        // path. Log + continue.
        process.stderr.write(
          `agent-presence-registry: change listener threw (key=${key}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Snapshot of every known agent record. Returns COPIES so callers can't
   * mutate internal state. Order is insertion order (Map semantics).
   */
  getAgents(): AgentPresenceRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  /** Look up a single record by key, or `undefined`. Returns a copy. */
  getAgent(key: string): AgentPresenceRecord | undefined {
    const r = this.records.get(key);
    return r ? { ...r } : undefined;
  }

  /**
   * Register a change listener. Fires AFTER each record mutation with the
   * affected key + the new (post-mutation) record. Returns an unsubscribe
   * handle. B.4 + the MC projection use this to push live updates.
   */
  onChange(listener: AgentPresenceChangeListener): AgentPresenceChangeSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

/**
 * Subject pattern the registry subscribes to — STACK-LOCAL ONLY.
 * `local.{principal}.{stack}.agent.>` — the `>` matches every presence action
 * (`online`/`heartbeat`/`offline`/`capabilities-changed`). The `federated.`
 * counterpart is deliberately NOT subscribed (Phase E).
 */
export function agentPresenceSubject(principal: string, stack: string): string {
  return `local.${principal}.${stack}.agent.>`;
}

/** Lifecycle handle for the wired registry. */
export interface AgentPresenceRegistryHandle {
  /** The observable store — `getAgents()` / `onChange()` for downstream. */
  readonly registry: AgentPresenceRegistry;
  /**
   * Stop the subscriber: unregister the fan-out handler + drain the
   * push subscriber. Idempotent. The in-memory store survives stop (a stopped
   * registry just stops receiving updates).
   */
  stop(): Promise<void>;
}

/** Options for {@link startAgentPresenceRegistry}. */
export interface StartAgentPresenceRegistryOptions {
  runtime: MyelinRuntime;
  /** Boot-resolved `{principal}` — the subject's second segment. */
  principal: string;
  /** Resolved `{stack}` — the subject's third segment. */
  stack: string;
  /** Optional pre-constructed registry (tests). Production constructs one. */
  registry?: AgentPresenceRegistry;
  /** Injected clock, forwarded to a freshly-constructed registry (tests). */
  now?: () => number;
}

/**
 * Wire the registry into the running cortex. Self-subscribes to the
 * stack-local `agent.>` subtree (cortex#477 push-mode seam) and registers a
 * fan-out handler that filters matching envelopes into the registry's `apply`.
 *
 * NON-THROWING / best-effort, matching every other capability-side boot
 * feature: a subscribe failure logs + leaves the registry dormant (still
 * constructed + queryable, just not receiving). When `runtime.enabled` is false
 * (no NATS) the subscriber stays dormant.
 */
export async function startAgentPresenceRegistry(
  opts: StartAgentPresenceRegistryOptions,
): Promise<AgentPresenceRegistryHandle> {
  const registry =
    opts.registry ??
    new AgentPresenceRegistry(opts.now !== undefined ? { now: opts.now } : {});
  const pattern = agentPresenceSubject(opts.principal, opts.stack);

  const handler: EnvelopeHandler = (envelope, subject) => {
    if (!subjectMatches(pattern, subject)) return;
    registry.apply(envelope);
  };
  const registration = opts.runtime.onEnvelope(handler);

  // cortex#477 push-mode self-subscribe. `subscribe` is optional on the
  // interface; treat undefined as "runtime can't push-subscribe" (dormant).
  let subscriber: MyelinSubscriber | null = null;
  try {
    subscriber = (await opts.runtime.subscribe?.(pattern)) ?? null;
    if (opts.runtime.enabled && subscriber === null) {
      process.stderr.write(
        `agent-presence-registry: runtime.subscribe(${pattern}) returned null — ` +
          `registry will only see envelopes from other static subscriptions\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `agent-presence-registry: subscribe(${pattern}) failed (non-fatal — registry dormant): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  let stopped = false;
  return {
    registry,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      registration.unregister();
      // The runtime tracks `subscribe()` subscribers and drains them on
      // `runtime.stop()`, but we stop ours explicitly so a listener-scoped
      // teardown (tests, hot-reload) doesn't wait for full runtime shutdown.
      if (subscriber) {
        await subscriber.stop();
      }
    },
  };
}
