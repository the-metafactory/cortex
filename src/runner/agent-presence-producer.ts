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
 *      routing, ADR-0007 §3). This capability set **supersedes** the legacy
 *      observability-only `agents.capabilities.registered` envelope
 *      (`src/bus/capability-registry.ts`, now `@deprecated`): both fire at boot
 *      and read the SAME `agent.runtime.capabilities[]` field, so during the
 *      ADR-0007 dual-emit window `agent.online` IS the source of truth and the
 *      legacy envelope is redundant. The capability-consistency invariant is
 *      pinned by `src/bus/__tests__/capability-registry-presence-consistency.test.ts`;
 *      the legacy envelope retires (removed) after the window;
 *   2. starts a presence HEARTBEAT ticker — publishes `agent.heartbeat` per
 *      agent on a fixed interval ({@link DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS},
 *      well under the ADR-0007 5-minute liveness TTL);
 *   3. on graceful shutdown, publishes `agent.offline` (reason: `shutdown`) per
 *      agent BEFORE the runtime/bus tears down (the boot wiring registers
 *      {@link AgentPresenceProducer.stop} in the cortex.ts shutdown drain ahead
 *      of `runtime stop`).
 *   4. (G-1114.C.1) on a mid-life capability mutation, publishes ONE
 *      `agent.capabilities-changed` carrying the FULL new steady-state set —
 *      {@link AgentPresenceProducer.publishCapabilitiesChanged}. Diff-guarded:
 *      a no-op when the new set equals the tracked set (order-insensitive), so
 *      an idempotent reload that re-asserts the same caps emits nothing.
 *
 * **The C.1 FINDING — capabilities are RESTART-ONLY at the daemon today.**
 * Per-agent capabilities live on `Agent.runtime.capabilities[]` (the agents.d/
 * fragments), NOT on `AgentConfig.agent` (bot.yaml). The only daemon-level
 * config watcher wired into `cortex.ts` is the `ConfigWatcher`, whose SAFE_FIELDS
 * / RESTART_FIELDS cover `AgentConfig` only — it never sees a capability change,
 * and cortex.ts does NOT rebuild `mergedAgents` on reload (see the cortex.ts
 * capability-registry boot block). The `AgentsDirectoryWatcher` CAN diff per-agent
 * capability changes (its `agentsChanged`), but it is not instantiated in
 * cortex.ts. So today a capability change requires a daemon RESTART, and the next
 * boot's `agent.online` already carries the new set (item 1). This method is the
 * EMIT side for the moment a capability hot-reload becomes possible: it is wired
 * defensively into the config-reload onChange handler (cortex.ts) so that IF/WHEN
 * mergedAgents starts being rebuilt mid-life, the delta flows without restart.
 * The diff logic is the load-bearing half and is fully exercised regardless.
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
import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  createAgentOnlineEvent,
  createAgentHeartbeatEvent,
  createAgentOfflineEvent,
  createAgentCapabilitiesChangedEvent,
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

/**
 * Order-insensitive set equality for capability lists. Capabilities are an
 * UNORDERED set of ids (ADR-0007 §3) — `["a","b"]` and `["b","a"]` advertise the
 * same agent, so a reorder must NOT count as a delta. Compares membership only.
 */
function capabilitySetsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const cap of a) {
    if (!b.has(cap)) return false;
  }
  return true;
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
  /**
   * G-1114.E.1 — **federate presence (OPT-IN, default OFF).** When `true`, the
   * producer publishes a SECOND copy of every presence envelope with
   * `classification: "federated"` (deriving the `federated.{principal}.{stack}.
   * agent.*` subject) IN ADDITION to the stack-local `classification: "local"`
   * copy. This is how a stack opts its agents' presence into peer Network views
   * over bus federation (the E.2 subscriber on a peer stack folds it).
   *
   * Reuses the EXISTING federated-classification mechanism — the SAME
   * `classification: "federated"` lever that opts `dispatch.task.*` /
   * `review.verdict.*` into federated emission (IAW Phase A.3). NOT a new
   * toggle: the presence builders already accept `classification` per
   * `AgentPresenceCommonOpts`; this flag just makes the producer emit the
   * federated variant alongside the local one.
   *
   * Default `false` — a stack that has NOT opted into federating presence emits
   * ONLY `local.*`, byte-identical to pre-E behaviour. The boot wiring sets this
   * `true` only when the stack's `policy.federated` opts presence in (e.g.
   * `agent.*` reachable via the network's accept/announce config), mirroring how
   * dispatch/review opt into federated classification.
   *
   * **Both copies, not a swap.** A federated stack still wants its OWN agents in
   * its OWN local Network view (the B.3 local registry folds `local.*`), AND its
   * peers want them via `federated.*`. So presence is dual-emitted (local +
   * federated) — the same two-transports-one-envelope shape ADR-0007 §2
   * describes.
   */
  federate?: boolean;
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
  /** G-1114.E.1 — when true, dual-emit a `classification: "federated"` copy. */
  private readonly federate: boolean;

  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;
  /** Bound the in-flight heartbeat publishes to 1 per agent-batch (backpressure). */
  private heartbeatInFlight = false;

  /**
   * The producer's view of each agent's CURRENT advertised capability set,
   * keyed by `agent_id`. Seeded from each {@link PresenceAgent.capabilities}
   * (the same set stamped on the boot `agent.online`), then advanced by
   * {@link publishCapabilitiesChanged} on every emitted delta. This is the
   * baseline the diff compares against — keeping it in sync with what's gone out
   * on the wire is what makes a re-asserted same-set reload a no-op (G-1114.C.1).
   */
  private readonly capabilityBaseline = new Map<string, ReadonlySet<string>>();

  /** `agent_id` → identity/scope, for routing a capabilities-changed emit. */
  private readonly agentsById = new Map<string, PresenceAgent>();

  constructor(opts: AgentPresenceProducerOptions) {
    this.runtime = opts.runtime;
    this.source = opts.source;
    this.agents = opts.agents;
    this.intervalMs = opts.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.now = opts.now ?? (() => new Date());
    this.federate = opts.federate ?? false;
    for (const agent of this.agents) {
      this.agentsById.set(agent.identity.agent_id, agent);
      this.capabilityBaseline.set(
        agent.identity.agent_id,
        new Set(agent.capabilities),
      );
    }
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

  /**
   * G-1114.C.1 — emit `agent.capabilities-changed` for `agentId` carrying the
   * FULL new steady-state capability set (ADR-0007 §3: the subscriber computes
   * the diff against its current record; we carry the whole set so a subscriber
   * that missed an earlier delta still converges).
   *
   * **Diff-guarded.** Returns `false` WITHOUT emitting when:
   *   - `agentId` is not a known hosted agent (nothing to announce), or
   *   - `newCapabilities` equals the producer's tracked baseline for that agent
   *     (order-insensitive set equality) — an idempotent reload that re-asserts
   *     the same caps emits nothing.
   *
   * On an actual change it publishes one envelope, advances the tracked baseline
   * to the new set, and returns `true`. Best-effort like the other emits: a
   * builder/publish fault is logged to stderr and swallowed (the baseline is
   * still advanced so a transient publish failure doesn't wedge the diff into
   * re-emitting on every subsequent reload). The caller (the cortex.ts
   * config-reload onChange handler) treats the return purely as "did a delta
   * fire" for logging.
   *
   * @param agentId the hosted agent whose capabilities changed (`agent_id`).
   * @param newCapabilities the agent's complete new capability set.
   * @returns `true` if an envelope was emitted (real delta), else `false`.
   */
  publishCapabilitiesChanged(
    agentId: string,
    newCapabilities: readonly string[],
  ): boolean {
    const agent = this.agentsById.get(agentId);
    if (agent === undefined) {
      // Unknown agent — never seen on boot, so there's no presence record to
      // mutate. Silently ignore (the reload handler iterates only known agents,
      // so this is a belt-and-braces guard, not an expected path).
      return false;
    }
    const baseline = this.capabilityBaseline.get(agentId) ?? new Set<string>();
    const next = new Set(newCapabilities);
    if (capabilitySetsEqual(baseline, next)) {
      // No actual change — emit nothing.
      return false;
    }
    // Advance the baseline up-front so a publish fault below doesn't leave the
    // diff re-firing on every subsequent reload (we've decided this IS the new
    // steady state; the wire emit is best-effort).
    this.capabilityBaseline.set(agentId, next);

    const sentAt = this.now();
    // G-1114.E.1 — dual-emit local (+ federated when opted in). `dualEmit`
    // owns the per-classification build try/catch + best-effort publish.
    void Promise.allSettled(
      this.dualEmit("agent.capabilities-changed", agentId, (classification) =>
        createAgentCapabilitiesChangedEvent({
          source: this.source,
          identity: agent.identity,
          scope: agent.scope,
          capabilities: [...newCapabilities],
          sentAt,
          classification,
        }),
      ),
    );
    return true;
  }

  /**
   * G-1114.E.1 — emit one presence envelope at `classification: "local"`, and —
   * when {@link federate} is on — a SECOND copy at `classification: "federated"`.
   * `build(classification)` constructs the envelope at that classification via
   * the existing builders (which thread `classification` through
   * `AgentPresenceCommonOpts`); the federated copy derives the
   * `federated.{principal}.{stack}.agent.*` subject on publish.
   *
   * Both publishes are best-effort + non-throwing (the existing per-emit
   * contract). The federated emit reuses the SAME builder/publish path — no new
   * mechanism, just a second classification. Used by the heartbeat tick which
   * needs the awaitable promises for backpressure; the fire-and-forget callers
   * (`publishOnline` / `publishOffline`) ignore the returned promises beyond
   * their own `.catch`.
   */
  private dualEmit(
    action: string,
    agentId: string,
    build: (classification: "local" | "federated") => Envelope,
  ): Promise<void>[] {
    const classifications: ("local" | "federated")[] = this.federate
      ? ["local", "federated"]
      : ["local"];
    const publishes: Promise<void>[] = [];
    for (const classification of classifications) {
      let envelope: Envelope;
      try {
        envelope = build(classification);
      } catch (err) {
        process.stderr.write(
          `agent-presence-producer: ${action} build failed (agent=${agentId}, ` +
            `classification=${classification}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }
      publishes.push(
        this.runtime.publish(envelope).catch((err: unknown) => {
          process.stderr.write(
            `agent-presence-producer: ${action} publish failed (agent=${agentId}, ` +
              `classification=${classification}): ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }),
      );
    }
    return publishes;
  }

  private publishOnline(agent: PresenceAgent): void {
    const startedAt = this.now();
    void Promise.allSettled(
      this.dualEmit("agent.online", agent.identity.agent_id, (classification) =>
        createAgentOnlineEvent({
          source: this.source,
          identity: agent.identity,
          scope: agent.scope,
          capabilities: [...agent.capabilities],
          startedAt,
          classification,
        }),
      ),
    );
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
      // G-1114.E.1 — dual-emit local (+ federated when opted in) heartbeats.
      publishes.push(
        ...this.dualEmit(
          "agent.heartbeat",
          agent.identity.agent_id,
          (classification) =>
            createAgentHeartbeatEvent({
              source: this.source,
              identity: agent.identity,
              scope: agent.scope,
              sentAt,
              classification,
            }),
        ),
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
    const sentAt = this.now();
    // G-1114.E.1 — dual-emit local (+ federated when opted in) offline. Awaited
    // (via Promise.allSettled) so the shutdown drain holds the bus open until
    // BOTH copies have gone out — a peer's Network view depends on the federated
    // `agent.offline` to drop the foreign agent promptly rather than waiting for
    // its TTL reaper.
    await Promise.allSettled(
      this.dualEmit("agent.offline", agent.identity.agent_id, (classification) =>
        createAgentOfflineEvent({
          source: this.source,
          identity: agent.identity,
          scope: agent.scope,
          reason,
          sentAt,
          classification,
        }),
      ),
    );
  }
}
