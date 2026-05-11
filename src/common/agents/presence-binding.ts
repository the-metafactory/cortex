/**
 * MIG-7.2c-binding — PresenceBinding.
 *
 * Glue between a `PlatformAdapter` (Discord / Mattermost / ...) and the
 * process-wide `TrustResolver` (MIG-7.2b). Owns the start-then-register +
 * unregister-then-stop lifecycle pair that ensures the platform user id is
 * known to the trust map for exactly the window the adapter is connected.
 *
 * The binding is intentionally a *helper*, not a subclass: each existing
 * adapter keeps its current constructor shape, and the cortex.ts wiring
 * step (next sub-PR — MIG-7.2c-discord) just wraps each adapter in a
 * PresenceBinding instead of calling `adapter.start()` directly.
 *
 * ## Lifecycle (the only correct order)
 *
 *   1. `await binding.startAndBind(onMessage)`
 *        a. `adapter.start(onMessage)` — connect first; platform user id is
 *           only available post-connect (e.g. Discord populates
 *           `client.user` on the `ready` event).
 *        b. `adapter.getPlatformUserId()` — learn the id.
 *        c. `trustResolver.register(...)` — publish the mapping so peer
 *           adapters can resolve inbound trust by platform id.
 *
 *   2. `await binding.unbindAndStop()`
 *        a. `trustResolver.unregister(...)` — peers see the agent as
 *           "offline" immediately on shutdown (graceful disconnect).
 *        b. `adapter.stop()` — close the socket.
 *
 * Failure paths are explicit:
 *   - If `adapter.start()` throws → no register, no stop (start failed; the
 *     adapter is already in its pre-start state).
 *   - If `getPlatformUserId()` or `register()` throws after a successful
 *     start → roll back via `adapter.stop()` so we don't leak an unbound,
 *     connected adapter. The original error is re-thrown; stop errors are
 *     suppressed because the original failure is the actionable signal.
 *
 * ## Out of scope for this sub-PR
 *
 *   - Adapter constructor refactor to `(Agent, Presence, ...)` lands at
 *     MIG-7.2c-discord / MIG-7.2c-mattermost. The binding takes today's
 *     constructed adapters as-is.
 *   - Reconnect retry / backoff. Adapters handle their own reconnect; the
 *     binding just bind/unbinds at the outer lifecycle boundary.
 */

import type { PlatformAdapter, InboundMessage } from "../../adapters/types";
import { type Platform, type TrustResolver } from "./trust-resolver";

// =============================================================================
// Known platform narrowing
// =============================================================================

/**
 * The platforms the trust resolver accepts, expressed as a record keyed by
 * every variant of the `Platform` union. The `satisfies Record<Platform, …>`
 * bound is the compile-time drift guard Holly W1 asked for: if a new
 * variant is added to the `Platform` union in `trust-resolver.ts` without
 * adding a key here, this literal fails to typecheck — the runtime
 * narrowing stays in sync with the union by construction.
 *
 * Use `isKnownPlatform` to narrow an adapter's `platform: string` field at
 * the binding boundary.
 */
const KNOWN_PLATFORMS = {
  discord: true,
  mattermost: true,
} as const satisfies Record<Platform, true>;

const KNOWN_PLATFORM_LIST: readonly Platform[] = Object.keys(KNOWN_PLATFORMS) as Platform[];

function isKnownPlatform(s: string): s is Platform {
  return Object.hasOwn(KNOWN_PLATFORMS, s);
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when constructing a `PresenceBinding` against an adapter whose
 * `platform` is not in the `Platform` union (e.g. the test mock with
 * `platform = "mock"`, or a hypothetical future Slack adapter that lands
 * before the union is extended).
 *
 * Distinct class so callers can `instanceof`-check and surface a clear
 * "this platform isn't wired through trust resolution yet" message rather
 * than the generic "platform identity unknown" downstream error from
 * `trustResolver.register`.
 */
export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly knownPlatforms: readonly Platform[];

  constructor(platform: string) {
    super(
      `PresenceBinding: adapter.platform "${platform}" is not a known trust-resolver ` +
        `platform (known: ${KNOWN_PLATFORM_LIST.join(", ")}). Extend the Platform union in ` +
        `src/common/agents/trust-resolver.ts and the KNOWN_PLATFORMS record in ` +
        `src/common/agents/presence-binding.ts before binding adapters for new platforms.`,
    );
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.knownPlatforms = KNOWN_PLATFORM_LIST;
  }
}

// =============================================================================
// PresenceBinding
// =============================================================================

/**
 * Binds a `PlatformAdapter` to a `TrustResolver` for the duration of the
 * adapter's connected lifetime. Single-use: each adapter instance gets its
 * own binding. Bindings are NOT reused across reconnect cycles — the
 * adapter handles reconnect internally, and the binding's
 * `(platformUserId → agentId)` registration is idempotent for same-agent
 * re-registration (see `TrustResolver.register`).
 */
export class PresenceBinding {
  private readonly platform: Platform;
  private platformUserId: string | undefined;

  /**
   * @throws UnsupportedPlatformError if `adapter.platform` is not in the
   *         `Platform` union understood by the trust resolver.
   */
  constructor(
    private readonly agentId: string,
    private readonly adapter: PlatformAdapter,
    private readonly trustResolver: TrustResolver,
  ) {
    if (!isKnownPlatform(adapter.platform)) {
      throw new UnsupportedPlatformError(adapter.platform);
    }
    this.platform = adapter.platform;
  }

  /**
   * Start the underlying adapter, learn its platform user id, and register
   * the mapping with the trust resolver. The three steps run sequentially
   * because each depends on the previous one succeeding.
   *
   * On `start()` failure: nothing is registered, nothing to roll back.
   * On `getPlatformUserId()` or `register()` failure after `start()`
   * succeeded: the adapter is stopped before re-throwing, so we never
   * leave a connected-but-unbound adapter behind. Stop errors during
   * rollback are suppressed (the original error is the one that matters).
   */
  async startAndBind(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    await this.adapter.start(onMessage);
    try {
      const platformUserId = await this.adapter.getPlatformUserId();
      this.trustResolver.register(this.platform, platformUserId, this.agentId);
      this.platformUserId = platformUserId;
    } catch (err) {
      try {
        await this.adapter.stop();
      } catch (_rollbackErr) {
        // Rollback best-effort; the caller's actionable signal is `err`.
      }
      throw err;
    }
  }

  /**
   * Unregister the platform mapping and stop the underlying adapter.
   * Idempotent — safe to call when `startAndBind()` was never called or
   * already unbound. Stops the adapter even when unregister is a no-op so
   * a binding constructed-but-never-bound can still be drained safely.
   */
  async unbindAndStop(): Promise<void> {
    if (this.platformUserId !== undefined) {
      this.trustResolver.unregister(this.platform, this.platformUserId);
      this.platformUserId = undefined;
    }
    await this.adapter.stop();
  }

  /** The platform user id this binding registered, or undefined if not bound. */
  get registeredPlatformId(): string | undefined {
    return this.platformUserId;
  }

  /** The agent id this binding registered for. */
  get registeredAgentId(): string {
    return this.agentId;
  }

  /** The platform (narrowed to the trust-resolver union) for this binding. */
  get registeredPlatform(): Platform {
    return this.platform;
  }
}
