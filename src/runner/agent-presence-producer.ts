/**
 * G-1114.B.2 — live agent-presence PRODUCER, wired into the cortex boot
 * lifecycle.
 *
 * The producer half of the Phase B end-to-end wiring. For each hosted agent
 * (an `Agent` from the assembled registry) it:
 *
 *   1. publishes ONE `agent.online` on boot — carrying the agent's identity
 *      (`agent_id` + assistant name + NKey pubkey) and its declared
 *      CAPABILITIES (the same `runtime.capabilities[]` used for dispatch
 *      routing, ADR-0007 §3);
 *   2. starts a presence HEARTBEAT ticker — publishes `agent.heartbeat` per
 *      agent on a fixed interval ({@link DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS},
 *      well under the ADR-0007 5-minute liveness TTL);
 *   3. on graceful shutdown, publishes `agent.offline` (reason: `shutdown`) per
 *      agent BEFORE the runtime/bus tears down (the boot wiring registers
 *      {@link AgentPresenceProducer.stop} in the cortex.ts shutdown drain ahead
 *      of `runtime stop`).
 *
 * **Mirrors `src/runner/heartbeat-ticker.ts`** — the dispatch HeartbeatTicker's
 * interval-publish + injectable-scheduler + idempotent-stop pattern — but it is
 * a SEPARATE, presence-scoped ticker. It publishes the PRESENCE `agent.heartbeat`
 * (`"agent.heartbeat"`, from `bus/agent-network/builders.ts`), NEVER the
 * dispatch `system.agent.heartbeat`. The two heartbeats are differently-scoped
 * by design (ADR-0007 §1): presence = "process up, idle or not"; dispatch =
 * "task in flight, keyed by correlation_id".
 *
 * **STACK-LOCAL ONLY.** Every envelope is `classification: "local"` (the
 * builders default), so subjects derive to `local.{principal}.{stack}.agent.*`.
 * Federation (`federated.` scope feeding peer Network views) is Phase E.
 *
 * **Non-throwing / best-effort.** A publish failure (NATS hiccup, signer fault)
 * is logged to stderr and swallowed — a presence-producer fault must never
 * crash boot or shutdown. `runtime.publish` itself is a no-op when the runtime
 * is disabled (no NATS), so the producer is safe to run unconditionally; the
 * boot wiring still gates it behind the presence flag for clarity + to skip the
 * ticker churn when presence isn't wanted.
 */

import type { MyelinRuntime } from "../bus/myelin/runtime";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  type AgentPresenceSource,
} from "../bus/agent-network/builders";
import type {
  AgentPresenceIdentity,
  AgentPresenceScope,
} from "../bus/agent-network/envelopes";
import type { Agent } from "../common/types/cortex-config";

/**
 * Default presence-heartbeat interval — 60 s.
 *
 * Chosen WELL under the ADR-0007 5-minute (300 s) liveness TTL so Phase C's
 * reaper sees ~5 heartbeats per TTL window: a single dropped heartbeat (one
 * NATS hiccup) never flips an agent offline. 60 s also keeps envelope volume
 * modest for an idle stack (one envelope/agent/minute) — lower than the
 * dispatch ticker's 30 s because presence is liveness-only, not progress.
 *
 * Not config-driven in B: a module constant keeps the B surface minimal. If a
 * future need to tune it per-stack arises, it would land on BOTH
 * `AgentConfigSchema` AND `CortexConfigSchema` (cortex#877 dual-schema rule) —
 * deliberately NOT added speculatively here.
 */
export const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * One agent's presence descriptor — the identity + scope + capability set the
 * producer stamps onto its `agent.*` envelopes. Derived from an assembled
 * `Agent` by {@link presenceAgentFromAgent} at the boot site, kept as a narrow
 * struct so the producer doesn't depend on the full `Agent` shape (and tests
 * construct it directly).
 */
export interface PresenceAgent {
  identity: AgentPresenceIdentity;
  scope: AgentPresenceScope;
  /** Capability ids the agent advertises (same as dispatch-routing caps). */
  capabilities: readonly string[];
}

/**
 * Build a {@link PresenceAgent} from an assembled `Agent` + the boot-resolved
 * `{principal}` / `{stack}` scope.
 *
 * Identity mapping (ADR-0007 §4 — `@assistant on {stack}`):
 *   - `agent_id`          ← `agent.id` (the logical `luna`/`echo`/… id).
 *   - `assistant_name`    ← `agent.displayName` — the human-facing named being
 *     the agent hosts. The `Agent` schema carries no separate `assistant`
 *     field today; `displayName` IS that name (e.g. `Luna`, `Echo`). Never
 *     `null` for a hosted agent (displayName is a required, non-empty field).
 *   - `nkey_public_key`   ← `agent.nkey_pub` when declared, else the stack's
 *     own NKey pubkey (`fallbackNkey`). At Phase B, presence is stack-local and
 *     the stack signs every envelope, so the stack key is the honest fallback
 *     identity for an agent that hasn't declared its own. When neither is
 *     available the agent is SKIPPED (the payload schema requires a non-empty
 *     key) — the caller logs the skip.
 *   - `capabilities`      ← `agent.runtime.capabilities` (the SAME set used for
 *     dispatch routing). Empty when the agent declares no runtime block.
 *
 * Returns `null` when no NKey can be resolved (so the boot site can log + skip
 * rather than emit an unkeyed, schema-invalid presence envelope).
 */
export function presenceAgentFromAgent(
  agent: Agent,
  scope: { principal: string; stack: string },
  fallbackNkey: string | undefined,
): PresenceAgent | null {
  const nkey = agent.nkey_pub ?? fallbackNkey;
  if (nkey === undefined || nkey.length === 0) {
    return null;
  }
  return {
    identity: {
      nkey_public_key: nkey,
      agent_id: agent.id,
      // assistant_name is the human-facing named being (Luna/Echo) — AgentSchema
      // has no dedicated assistant field, and `displayName` is `.min(1)` required,
      // so this is always non-empty. The wire schema permits `assistant_name:
      // string | null`; this direct map relies on the canonical Agent schema's
      // required displayName, so there's no null/empty path here.
      assistant_name: agent.displayName,
    },
    scope: { principal: scope.principal, stack: scope.stack },
    capabilities: agent.runtime?.capabilities ?? [],
  };
}

/** Injectable scheduler — tests pass a controllable fake; production omits. */
export interface PresenceScheduler {
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const realScheduler: PresenceScheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => {
    clearInterval(handle);
  },
};

/** Construction options for {@link AgentPresenceProducer}. */
export interface AgentPresenceProducerOptions {
  runtime: MyelinRuntime;
  /** The envelope emitter `source` triple (`{principal}.{stack}.{instance}`). */
  source: AgentPresenceSource;
  /** Hosted agents to announce presence for. */
  agents: readonly PresenceAgent[];
  /** Heartbeat interval. Defaults to {@link DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable scheduler (tests). Defaults to the real timers. */
  scheduler?: PresenceScheduler;
  /** Injectable clock for `started_at` / `sent_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Live agent-presence producer. One instance per cortex process, owning the
 * presence lifecycle for every hosted agent.
 *
 * Lifecycle:
 *   1. `new AgentPresenceProducer(opts)` — does nothing observable.
 *   2. `start()` — publishes one `agent.online` per agent immediately, then
 *      schedules the recurring `agent.heartbeat` ticks. The FIRST heartbeat
 *      fires on the first interval (not immediately — `online` already
 *      announced liveness at t=0).
 *   3. `stop("shutdown")` — clears the interval + publishes one `agent.offline`
 *      per agent. Idempotent; safe to call twice.
 */
export class AgentPresenceProducer {
  private readonly runtime: MyelinRuntime;
  private readonly source: AgentPresenceSource;
  private readonly agents: readonly PresenceAgent[];
  private readonly intervalMs: number;
  private readonly scheduler: PresenceScheduler;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;
  /** Bound the in-flight heartbeat publishes to 1 per agent-batch (backpressure). */
  private heartbeatInFlight = false;

  constructor(opts: AgentPresenceProducerOptions) {
    this.runtime = opts.runtime;
    this.source = opts.source;
    this.agents = opts.agents;
    this.intervalMs = opts.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Publish `agent.online` for every agent, then begin the heartbeat ticker.
   * No-op when there are no agents (nothing to announce — but the ticker isn't
   * scheduled either, so an empty roster is free). Idempotent on re-entry: a
   * second `start()` is ignored + logged (defensive — boot never re-starts).
   */
  start(): void {
    if (this.started) {
      process.stderr.write(
        "agent-presence-producer: start() called twice — ignoring\n",
      );
      return;
    }
    this.started = true;
    if (this.agents.length === 0) {
      // Nothing to announce; leave the ticker unscheduled.
      return;
    }
    for (const agent of this.agents) {
      this.publishOnline(agent);
    }
    this.timer = this.scheduler.setInterval(() => {
      this.tickHeartbeats();
    }, this.intervalMs);
  }

  /**
   * Stop the ticker + publish `agent.offline` for every agent. Returns a
   * promise that resolves once every offline publish has settled (so the
   * cortex.ts shutdown drain can await it BEFORE the runtime closes — an
   * offline that loses the race with `runtime.stop()` is silently dropped by
   * the disabled-runtime no-op). Idempotent.
   *
   * `reason` defaults to `"shutdown"` (the graceful-shutdown path). A future
   * caller could pass `"restart"` / `"error"`.
   */
  async stop(reason: "shutdown" | "restart" | "error" = "shutdown"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    // Publish offline for every agent and AWAIT them so the drain step holds
    // the bus open until they've gone out.
    await Promise.allSettled(
      this.agents.map((agent) => this.publishOffline(agent, reason)),
    );
  }

  private publishOnline(agent: PresenceAgent): void {
    let envelope;
    try {
      envelope = createAgentOnlineEvent({
        source: this.source,
        identity: agent.identity,
        scope: agent.scope,
        capabilities: [...agent.capabilities],
        startedAt: this.now(),
      });
    } catch (err) {
      process.stderr.write(
        `agent-presence-producer: createAgentOnlineEvent failed (agent=${agent.identity.agent_id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    void this.runtime.publish(envelope).catch((err: unknown) => {
      process.stderr.write(
        `agent-presence-producer: agent.online publish failed (agent=${agent.identity.agent_id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

  private tickHeartbeats(): void {
    // Backpressure guard — mirror heartbeat-ticker: if the previous tick's
    // batch hasn't settled, the bus is slower than the interval; skip this tick.
    if (this.heartbeatInFlight) {
      process.stderr.write(
        "agent-presence-producer: skipping heartbeat tick — previous batch still in flight\n",
      );
      return;
    }
    const sentAt = this.now();
    const publishes: Promise<void>[] = [];
    for (const agent of this.agents) {
      let envelope;
      try {
        envelope = createAgentHeartbeatEvent({
          source: this.source,
          identity: agent.identity,
          scope: agent.scope,
          sentAt,
        });
      } catch (err) {
        process.stderr.write(
          `agent-presence-producer: createAgentHeartbeatEvent failed (agent=${agent.identity.agent_id}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }
      publishes.push(
        this.runtime.publish(envelope).catch((err: unknown) => {
          process.stderr.write(
            `agent-presence-producer: agent.heartbeat publish failed (agent=${agent.identity.agent_id}): ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }),
      );
    }
    this.heartbeatInFlight = true;
    void Promise.allSettled(publishes).finally(() => {
      this.heartbeatInFlight = false;
    });
  }

  private async publishOffline(
    agent: PresenceAgent,
    reason: "shutdown" | "restart" | "error",
  ): Promise<void> {
    let envelope;
    try {
      envelope = createAgentOfflineEvent({
        source: this.source,
        identity: agent.identity,
        scope: agent.scope,
        reason,
        sentAt: this.now(),
      });
    } catch (err) {
      process.stderr.write(
        `agent-presence-producer: createAgentOfflineEvent failed (agent=${agent.identity.agent_id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    try {
      await this.runtime.publish(envelope);
    } catch (err) {
      process.stderr.write(
        `agent-presence-producer: agent.offline publish failed (agent=${agent.identity.agent_id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
