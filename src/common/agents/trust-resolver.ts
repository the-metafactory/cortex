/**
 * MIG-7.2b — Trust resolver.
 *
 * Process-wide bidirectional `(platform, platformUserId) ↔ agentId` map. Sits
 * atop the AgentRegistry (MIG-7.2a) — the registry is the authoritative
 * agent source, the resolver layers the platform-id mapping on top.
 *
 * Architecture §9.3 ("Coupling discipline"):
 *
 *   > Cross-agent trust resolves at adapter startup: each presence adapter,
 *   > on connect, learns its own platform user id (e.g. `discord.client.user.id`)
 *   > and registers it in a process-wide `(platformId → agentId)` map. When
 *   > an inbound message arrives from a known platform id, the receiving
 *   > adapter looks up the source agent and consults its parent's `trust:` list.
 *
 * This module owns that map. It replaces grove-v2's hand-maintained
 * `trustedAgentBots` list (an array of platform user ids that the operator
 * manually kept in sync). The resolver builds the equivalent state from
 * adapter-connect-time registrations — no manual sync, no drift.
 *
 * ## Lifecycle
 *
 *   1. Cortex boot:        `new TrustResolver(registry)`  (no platform IDs yet)
 *   2. Discord adapter for Luna connects:
 *                          `resolver.register("discord", "1487...", "luna")`
 *   3. Inbound message from `1487...`:
 *                          `resolver.lookupAgentByPlatformId("discord", "1487...")`
 *                          → returns the Luna Agent
 *   4. Receiving adapter (Echo) checks trust:
 *                          `resolver.trustsByPlatformId("echo", "discord", "1487...")`
 *                          → true iff echo.trust includes luna
 *   5. Discord adapter for Luna disconnects:
 *                          `resolver.unregister("discord", "1487...")`
 *
 * ## Invariants
 *
 *   - A given `(platform, platformId)` maps to **at most one** agent at a
 *     time. Re-registering the same pair to a different agent throws
 *     `PlatformIdAlreadyRegisteredError` so a misconfigured presence
 *     adapter doesn't silently steal another agent's identity.
 *   - An agent can have multiple platform identities (e.g. Discord +
 *     Mattermost simultaneously). The reverse index `agentId →
 *     Set<{platform, platformId}>` carries them all.
 *   - `register` requires the target agent id to be a known agent in the
 *     backing registry. Unknown ids throw — fail-closed per §9.3 ("A
 *     presence adapter MUST refuse to start if its parent agent's id is
 *     missing from the registry").
 *
 * ## NOT in scope for 7.2b
 *
 *   - Adapter refactor — `DiscordPresenceAdapter(agent, presence)` lands at
 *     MIG-7.2c. The resolver is callable by today's adapters via a shim if
 *     useful, but the new constructor shape isn't enforced here.
 *   - Persistence — the resolver is in-memory. Cortex restart re-registers
 *     all platform ids when adapters reconnect; there's no SQLite-backed
 *     cache. (If reconnect storms become a problem post-MIG-7, revisit.)
 *   - Cross-process state — single-process only. Multi-shard cortex isn't a
 *     v1 concern.
 */

import type { Agent } from "../types/cortex-config";
import { AgentNotFoundError, AgentRegistry } from "./registry";

// =============================================================================
// Public types
// =============================================================================

/**
 * Known platform names. Constrained to the platforms cortex actually supports
 * — adding a new platform requires adding the value here AND a presence-block
 * variant in `cortex-config.ts`.
 */
export type Platform = "discord" | "mattermost";

/** A `(platform, platformId)` pair that uniquely identifies a connected presence. */
export interface PlatformIdentity {
  readonly platform: Platform;
  readonly platformId: string;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when `register` would overwrite an existing mapping with a
 * different agent. Re-registering the same agent for the same platform id
 * is a no-op (idempotent reconnect); claiming someone else's id throws so a
 * misconfigured token doesn't silently steal another agent's identity.
 */
export class PlatformIdAlreadyRegisteredError extends Error {
  readonly platform: Platform;
  readonly platformId: string;
  readonly existingAgentId: string;
  readonly attemptedAgentId: string;

  constructor(
    platform: Platform,
    platformId: string,
    existingAgentId: string,
    attemptedAgentId: string,
  ) {
    super(
      `platform identity ${platform}:${platformId} is already registered to agent ` +
        `"${existingAgentId}" — refusing to claim it for "${attemptedAgentId}". ` +
        `Check that the Discord/Mattermost token belongs to the expected bot account.`,
    );
    this.name = "PlatformIdAlreadyRegisteredError";
    this.platform = platform;
    this.platformId = platformId;
    this.existingAgentId = existingAgentId;
    this.attemptedAgentId = attemptedAgentId;
  }
}

// =============================================================================
// TrustResolver
// =============================================================================

/**
 * Process-wide map between platform user ids and agent ids, backed by an
 * AgentRegistry. Mutable — adapters register on connect, unregister on
 * disconnect. Single-process; no persistence.
 */
export class TrustResolver {
  private readonly registry: AgentRegistry;

  /** Forward: `${platform}:${platformId}` → agentId */
  private readonly forward = new Map<string, string>();

  /** Reverse: agentId → Set<`${platform}:${platformId}`> */
  private readonly reverse = new Map<string, Set<string>>();

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  /**
   * Register a platform identity for an agent. Called by presence adapters
   * on connect with their freshly-learned platform user id.
   *
   * @throws AgentNotFoundError if `agentId` is not in the backing registry.
   * @throws PlatformIdAlreadyRegisteredError if the `(platform, platformId)`
   *         pair is already registered to a *different* agent. Re-registering
   *         the same agent is idempotent (no-op).
   */
  register(platform: Platform, platformId: string, agentId: string): void {
    // Validate agent existence — fail-closed per architecture §9.3.
    if (!this.registry.tryGetById(agentId)) {
      throw new AgentNotFoundError(agentId);
    }

    const key = makeKey(platform, platformId);
    const existing = this.forward.get(key);
    if (existing) {
      if (existing === agentId) {
        // Idempotent reconnect — silently OK.
        return;
      }
      throw new PlatformIdAlreadyRegisteredError(platform, platformId, existing, agentId);
    }

    this.forward.set(key, agentId);
    let owned = this.reverse.get(agentId);
    if (!owned) {
      owned = new Set();
      this.reverse.set(agentId, owned);
    }
    owned.add(key);
  }

  /**
   * Remove a platform identity registration. Called by presence adapters on
   * graceful disconnect. Silently no-op on unknown pairs (avoids spurious
   * errors during shutdown races).
   */
  unregister(platform: Platform, platformId: string): void {
    const key = makeKey(platform, platformId);
    const agentId = this.forward.get(key);
    if (!agentId) return;
    this.forward.delete(key);
    const owned = this.reverse.get(agentId);
    if (owned) {
      owned.delete(key);
      if (owned.size === 0) this.reverse.delete(agentId);
    }
  }

  /**
   * Reverse lookup: given a platform user id, return the registered agent
   * id (or undefined). The caller usually pairs this with
   * `registry.getById(agentId)` to get the full Agent object.
   */
  lookupAgentId(platform: Platform, platformId: string): string | undefined {
    return this.forward.get(makeKey(platform, platformId));
  }

  /**
   * Reverse lookup: given a platform user id, return the registered Agent
   * (or undefined). Convenience wrapper combining `lookupAgentId` and the
   * registry.
   */
  lookupAgent(platform: Platform, platformId: string): Agent | undefined {
    const agentId = this.lookupAgentId(platform, platformId);
    if (!agentId) return undefined;
    return this.registry.tryGetById(agentId);
  }

  /**
   * Forward lookup: given an agent id, return all platform identities it has
   * registered. Order is registration order. Returns `[]` for unknown or
   * unregistered agents.
   */
  identitiesOf(agentId: string): PlatformIdentity[] {
    const owned = this.reverse.get(agentId);
    if (!owned) return [];
    const out: PlatformIdentity[] = [];
    for (const key of owned) {
      const [platform, platformId] = parseKey(key);
      out.push({ platform, platformId });
    }
    return out;
  }

  /**
   * Full trust check by platform identity. Returns true iff:
   *   1. The `(platform, platformId)` is registered to a known agent.
   *   2. `receivingAgentId` is a known agent.
   *   3. `receivingAgent.trust` includes the sender's agent id
   *      (OR sender and receiver are the same agent — self-trust is
   *      transitive, matching `AgentRegistry.trusts`).
   *
   * Returns false (not throws) for any unknown identity, so the receiving
   * adapter can fall back to human-message handling without a try/catch.
   */
  trustsByPlatformId(
    receivingAgentId: string,
    senderPlatform: Platform,
    senderPlatformId: string,
  ): boolean {
    const senderAgentId = this.lookupAgentId(senderPlatform, senderPlatformId);
    if (!senderAgentId) return false;
    return this.registry.trusts(receivingAgentId, senderAgentId);
  }

  /**
   * The backing registry. Exposed for callers that need the full Agent
   * object alongside the platform-id mapping (e.g. presence adapters that
   * fetch personas after resolving the sender).
   */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /** Number of currently-registered platform identities (debug + tests). */
  get size(): number {
    return this.forward.size;
  }
}

// =============================================================================
// Private — key encoding
// =============================================================================

/**
 * Encode a `(platform, platformId)` pair into a Map key. Separator chosen to
 * avoid collision with Discord/Mattermost id characters (digits + dashes for
 * snowflakes, lowercase alphanumeric for Mattermost). `|` is reserved across
 * both platforms.
 */
function makeKey(platform: Platform, platformId: string): string {
  return `${platform}|${platformId}`;
}

function parseKey(key: string): [Platform, string] {
  const sep = key.indexOf("|");
  const platform = key.slice(0, sep) as Platform;
  const platformId = key.slice(sep + 1);
  return [platform, platformId];
}
