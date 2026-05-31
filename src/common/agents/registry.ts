/**
 * MIG-7.2a — Agent registry.
 *
 * Given a parsed `CortexConfig`, the registry builds an immutable lookup
 * keyed by agent id. Each entry exposes the static identity bundle
 * (`{ id, displayName, persona, roles, trust, presence }`) plus the helper
 * methods presence adapters and the runner need at startup:
 *
 *   - `getById(id)`           — strict lookup; throws `AgentNotFoundError`
 *   - `tryGetById(id)`        — soft lookup; returns undefined
 *   - `getAll()`              — iteration order matches config order
 *   - `getTrustedPeers(id)`   — resolve an agent's `trust:` list to Agent
 *                                objects; throws if any unresolved
 *   - `trusts(truster, trusted)` — boolean trust check (self-trust → true)
 *
 * Architecture §9.3 rules enforced at construction:
 *
 *   1. Trust entries MUST resolve — every id in any agent's `trust:` list
 *      MUST be a known agent in the registry. Unknown ids surface here,
 *      not later when an inbound message arrives from a peer.
 *   2. Self-trust is silently allowed — an agent trusting itself is a no-op
 *      but isn't a config bug worth refusing the deployment over. (Self-
 *      trust is filtered out of `getTrustedPeers()` so callers don't have
 *      to special-case the bot's own messages.)
 *   3. The registry is immutable — `Object.freeze` on the index keeps
 *      downstream code from mutating in flight.
 *
 * NOT in scope for 7.2a:
 *
 *   - Platform user id ↔ agent id mapping (`platformId → agentId`) — that
 *     lives in `trust-resolver.ts` per MIG-7.2b. Presence adapters register
 *     their own user id at connect time, and the resolver maintains the
 *     process-wide bidirectional map.
 *   - Persona file loading — `persona` here is the path string from
 *     CortexConfig; loading the markdown is the presence adapter's job
 *     when it builds its agent context.
 *   - Role/capability resolution — `roles` is the string list from config;
 *     the role → capability bundle mapping lives elsewhere (G-121 etc.).
 */

import type { Agent, CortexConfig } from "../types/cortex-config";

// =============================================================================
// Public surface
// =============================================================================

/**
 * Thrown when a trust reference cannot be resolved at registry construction.
 * The error carries the offending agent + the unresolved id so the principal
 * sees exactly which line of cortex.yaml is wrong.
 *
 * NOT used for plain `getById` misses — that's `AgentNotFoundError` with no
 * trust-relationship implication.
 */
export class UnknownAgentReferenceError extends Error {
  readonly fromAgent: string;
  readonly unresolvedId: string;

  constructor(fromAgent: string, unresolvedId: string) {
    super(
      `agent "${fromAgent}" trusts "${unresolvedId}", but no agent with that id is registered. ` +
        `Check the agents[] block in cortex.yaml — every entry in trust:[] must be a known agent id.`,
    );
    this.name = "UnknownAgentReferenceError";
    this.fromAgent = fromAgent;
    this.unresolvedId = unresolvedId;
  }
}

/**
 * Thrown by `AgentRegistry.getById` when an id has no matching agent. Plain
 * lookup miss; no trust-relationship implication. Use `tryGetById` if a miss
 * is a normal branch in your code path.
 */
export class AgentNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`no agent registered with id "${id}"`);
    this.name = "AgentNotFoundError";
    this.id = id;
  }
}

/**
 * Thrown when `AgentRegistry.fromConfig` is called with duplicate agent ids.
 * Zod's `CortexConfigSchema` already catches this at parse time, but the
 * registry double-checks to remain safe when callers bypass schema parse
 * (e.g. in tests that hand-build an `Agent[]` array).
 */
export class DuplicateAgentIdError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`duplicate agent id "${id}" — agent ids must be unique`);
    this.name = "DuplicateAgentIdError";
    this.id = id;
  }
}

/**
 * The agent registry — immutable lookup over a parsed cortex config.
 *
 * Build via the static factory `AgentRegistry.fromConfig(config)`; never
 * `new AgentRegistry(...)` directly. The factory is the only place that
 * validates the trust closure; constructing a registry from a hand-built
 * agent array (via `fromAgents([...])`) is also supported for tests.
 */
export class AgentRegistry {
  /**
   * Iteration order matches the order agents appear in `cortex.yaml`. Stable
   * across registry rebuilds (no sorting, no re-keying). Downstream code that
   * cares about ordering (e.g. the dashboard's actor-column layout) can rely
   * on this.
   */
  readonly agents: readonly Agent[];

  private readonly index: ReadonlyMap<string, Agent>;

  private constructor(agents: readonly Agent[], index: ReadonlyMap<string, Agent>) {
    this.agents = agents;
    this.index = index;
  }

  /**
   * Build a registry from a parsed CortexConfig. Validates the trust closure
   * — every id mentioned in any `trust:` list must match a registered agent.
   */
  static fromConfig(config: CortexConfig): AgentRegistry {
    return AgentRegistry.fromAgents(config.agents);
  }

  /**
   * Build a registry from a raw agent array. Validates uniqueness + trust
   * closure. Used by `fromConfig` and directly by tests.
   *
   * **Deep immutability:** each agent is recursively frozen before being
   * indexed so a downstream `registry.getById("luna").trust.push("evil")`
   * fails in strict mode rather than silently bypassing the trust closure
   * invariant that the constructor validated. The defensive copy of the
   * outer array further isolates the registry from external mutation of
   * the source.
   */
  static fromAgents(agents: readonly Agent[]): AgentRegistry {
    const frozen: Agent[] = [];
    const index = new Map<string, Agent>();

    for (const raw of agents) {
      if (index.has(raw.id)) {
        throw new DuplicateAgentIdError(raw.id);
      }
      const agent = deepFreezeAgent(raw);
      frozen.push(agent);
      index.set(agent.id, agent);
    }

    // Validate trust closure AFTER all agents are indexed, so forward
    // references (luna trusts echo, echo defined later) work cleanly.
    for (const agent of frozen) {
      for (const trustedId of agent.trust) {
        if (!index.has(trustedId)) {
          throw new UnknownAgentReferenceError(agent.id, trustedId);
        }
      }
    }

    return new AgentRegistry(Object.freeze(frozen), index);
  }

  /**
   * Strict lookup. Throws `AgentNotFoundError` if no agent with that id is
   * registered. Use this when you've already validated the id (e.g. it
   * came from a parsed envelope's `actor.agent_id`) and an unknown id is
   * a bug, not a normal branch.
   */
  getById(id: string): Agent {
    const agent = this.index.get(id);
    if (!agent) {
      throw new AgentNotFoundError(id);
    }
    return agent;
  }

  /**
   * Soft lookup. Returns `undefined` for unknown ids. Use this when the id
   * may legitimately be unknown (e.g. probing whether an inbound platform
   * id corresponds to a registered agent before deciding how to route).
   */
  tryGetById(id: string): Agent | undefined {
    return this.index.get(id);
  }

  /**
   * Enumerate all registered agents in config order.
   */
  getAll(): readonly Agent[] {
    return this.agents;
  }

  /**
   * Number of registered agents. Cheap shorthand.
   */
  get size(): number {
    return this.agents.length;
  }

  /**
   * Resolve an agent's `trust:` list to Agent objects. Self-trust entries
   * (an agent trusting its own id) are filtered out — they're harmless in
   * config but would cause downstream code to double-process the bot's own
   * messages.
   *
   * Throws `AgentNotFoundError` if `id` itself is unknown.
   * Throws `UnknownAgentReferenceError` if any trusted id is not registered.
   * The second check is defence-in-depth — `fromAgents` already validates
   * the trust closure, and deep-freezing each agent prevents mutation, so
   * this branch is structurally unreachable in production. Kept for tests
   * that bypass the factory or call from unfrozen contexts.
   */
  getTrustedPeers(id: string): Agent[] {
    const agent = this.getById(id);
    const peers: Agent[] = [];
    for (const trustedId of agent.trust) {
      if (trustedId === id) {
        // Self-trust: filter out silently per architecture §9.3 rationale.
        continue;
      }
      const peer = this.index.get(trustedId);
      if (!peer) {
        throw new UnknownAgentReferenceError(id, trustedId);
      }
      peers.push(peer);
    }
    return peers;
  }

  /**
   * Whether `truster` trusts `trusted`. Self-trust returns `true` (an agent
   * trusts itself transitively; this matters for routing inbound messages
   * the bot wrote itself).
   */
  trusts(truster: string, trusted: string): boolean {
    if (truster === trusted) return true;
    const trusterAgent = this.tryGetById(truster);
    if (!trusterAgent) return false;
    return trusterAgent.trust.includes(trusted);
  }

  /**
   * IAW Phase B.1 (cortex#114) — reverse-lookup an agent by its declared
   * NKey public key. Returns `undefined` when no registered agent declares
   * `nkey_pub === pubkey`, OR when more than one does (ambiguous — refuse
   * to silently pick one). The ambiguity case is a config bug; the caller
   * surfaces it as a verification failure rather than an exception so the
   * bus path can log + reject without throwing into an event handler.
   *
   * Linear scan is intentional: the registry holds O(small) agents and
   * the call site is per-stamp during inbound verification, not per-byte.
   * If profiling shows this matters, build an `nkey_pub → agentId` index
   * once at registry construction.
   */
  tryGetByNkeyPub(pubkey: string): Agent | undefined {
    let match: Agent | undefined;
    for (const agent of this.agents) {
      if (agent.nkey_pub === pubkey) {
        if (match) {
          // Two agents claim the same NKey — refuse to disambiguate at
          // read time. fromAgents should reject this at construction once
          // Phase C tightens the principal model, but until then a config
          // with duplicate keys gets a structural-trust failure rather
          // than a silently-wrong agent resolution.
          return undefined;
        }
        match = agent;
      }
    }
    return match;
  }
}

// =============================================================================
// Private helpers
// =============================================================================

/**
 * Recursively freeze an Agent and its nested mutable surfaces (`trust`,
 * `roles`, and the per-platform `presence` blocks). Closes Holly's
 * shallow-freeze warning — without this, a downstream
 * `registry.getById("luna").trust.push("evil")` would succeed and silently
 * bypass the trust-closure invariant the constructor validated.
 *
 * Re-freezing an already-frozen object is a no-op, so calling this twice
 * (e.g. tests that pass an already-frozen Agent into `fromAgents`) is safe.
 */
function deepFreezeAgent(agent: Agent): Agent {
  Object.freeze(agent.trust);
  // v2.0.0 (cortex#297) — AgentSchema.roles[] retired.
  if (agent.presence.discord) Object.freeze(agent.presence.discord);
  if (agent.presence.mattermost) Object.freeze(agent.presence.mattermost);
  Object.freeze(agent.presence);
  Object.freeze(agent);
  return agent;
}
