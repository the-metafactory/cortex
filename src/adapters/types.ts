/**
 * F-007: Platform Adapter Abstraction — Shared Types
 *
 * Defines the PlatformAdapter interface and all platform-agnostic
 * message types used by the MessageRouter pipeline.
 */

import type { ContextMessage } from "../common/types/context";

// Re-export for convenience
export type { ContextMessage };

/** Platform-agnostic inbound message */
export interface InboundMessage {
  /** Platform identifier: "discord", "mattermost", "slack", etc. */
  platform: string;
  /** Unique adapter instance ID (e.g. "discord-pai-collab") */
  instanceId: string;
  /** Platform-native user ID */
  authorId: string;
  /** Display name for prompt context */
  authorName: string;
  /** Raw message text (with mention/trigger word stripped) */
  content: string;
  /** Platform-native channel ID */
  channelId: string;
  /** Thread/reply-chain ID (if in a thread) */
  threadId?: string;
  /** G-204c: Human-readable channel name (e.g. "grove") for context routing */
  channelName?: string;
  /** G-204c: Human-readable thread name (e.g. "grove/issue/43") for entity routing */
  threadName?: string;
  /** Platform guild/server/team ID (e.g., Discord guild ID) for network resolution */
  guildId?: string;
  /** Whether this message is from a DM channel */
  isDM?: boolean;
  /** DM classification: principal (full access) or user (standard guards) */
  dmType?: "principal" | "user";
  /** Inbound file attachments */
  attachments: InboundAttachment[];
  /** Message timestamp */
  timestamp: Date;
  /** Escape hatch for platform-specific data (discord.js Message, MM post, etc.) */
  _native?: unknown;
}

/** Inbound file attachment metadata */
export interface InboundAttachment {
  url: string;
  filename: string;
  contentType?: string;
  size?: number;
}

/** Result of access control check */
export interface AccessDecision {
  allowed: boolean;
  features: {
    chat: boolean;
    async: boolean;
    team: boolean;
  };
  /** Disallowed MCP tools for this user */
  toolRestrictions?: string[];
  /** Allowed working directories for this user */
  dirRestrictions?: string[];
  /** G-121: Skills this role may invoke. undefined → all; [] → none; [...] → only listed. */
  allowedSkills?: string[];
  /** Whether bash guard should be active. Default: true. Principal DM may set false. */
  bashGuard?: boolean;
  /** Override bash allowlist (DM role may specify its own) */
  bashAllowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] };
  /** Whether this is a DM conversation */
  isDM?: boolean;
  /** Human-readable denial reason */
  denyReason?: string;
}

/** Where to send a response */
export interface ResponseTarget {
  /** Which adapter instance to respond on */
  instanceId: string;
  /** Platform-native channel ID */
  channelId: string;
  /** Thread to reply in (if applicable) */
  threadId?: string;
  /** Escape hatch for platform-specific channel objects */
  _native?: unknown;
}

/** Outbound file attachment */
export interface OutboundFile {
  content: Buffer;
  filename: string;
  contentType?: string;
}

/**
 * The core adapter interface. Each platform implements this.
 * Adapters are thin I/O wrappers — all pipeline logic lives in MessageRouter.
 */
export interface PlatformAdapter {
  /** Platform identifier: "discord", "mattermost", "slack", etc. */
  readonly platform: string;
  /** Unique instance ID across all adapters */
  readonly instanceId: string;

  /** Connect to the platform and start listening for messages */
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Disconnect and clean up resources */
  stop(): Promise<void>;

  /**
   * MIG-7.2c-binding: Return the platform user id of the bot account this
   * adapter is connected as. Required for `PresenceBinding` to register the
   * adapter with the process-wide `TrustResolver` so inbound messages from
   * peer agents are resolvable by their platform id (§9.3).
   *
   * Contract: callable only after `start()` has completed. Adapters that
   * learn their bot id at connect-time (e.g. Discord via `client.user`)
   * MUST throw if called pre-start; adapters that fetch on demand (e.g.
   * Mattermost via `/api/v4/users/me`) MAY cache the result.
   */
  getPlatformUserId(): Promise<string>;

  /** Fetch conversation history for context */
  fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]>;
  /** Check if the message author has access */
  resolveAccess(msg: InboundMessage): AccessDecision;
  /** Post a response (handles platform-specific splitting/formatting) */
  postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void>;
  /** Show typing indicator */
  sendTyping(target: ResponseTarget): Promise<void>;
  /** Post or update a progress message (edit-in-place, one message per target) */
  sendProgress(target: ResponseTarget, text: string): Promise<void>;
  /** Delete the progress message for a target */
  clearProgress(target: ResponseTarget): Promise<void>;
  /** Create a thread from a message */
  createThread(msg: InboundMessage, name: string): Promise<ResponseTarget>;

  /**
   * cortex#502 — resolve a LOGICAL surface address (the review-path
   * `response_routing` shape) to a native {@link ResponseTarget}.
   *
   * The review wire stays platform-NEUTRAL (`{ surface, channel, thread? }`
   * — repo short name + `{repo}/{entity-type}/{number}` logical key per the
   * channel-routing SOP) so the same `review.verdict.*` / `dispatch.task.*`
   * envelope routes on Discord/Mattermost/Slack unchanged. Each adapter
   * implements this seam to map logical→native:
   *
   *   - Returns `null` when `addr.surface` is NOT this adapter's platform
   *     (the review sink then skips this adapter — no cross-surface posting).
   *   - Otherwise resolves `addr.channel` (repo short name) to the platform
   *     channel and, when `addr.thread` is present, the platform thread
   *     primitive (Discord reuses `findOrCreateThreadByName`).
   *   - Returns `null` when the channel/thread can't be resolved (caller
   *     falls back to ignoring the envelope rather than mis-posting).
   *
   * Mattermost/Slack implement the same method later with their own
   * name→primitive mapping; the wire never changes.
   */
  resolveLogicalTarget(addr: {
    surface: string;
    channel: string;
    thread?: string;
  }): Promise<ResponseTarget | null>;
  /** Send a notification to the principal */
  notifyPrincipal(text: string): Promise<void>;
  /** F-092: Hot-reload adapter config (optional, for adapters that support it) */
  updateConfig?(config: unknown): void;
  /**
   * Two-phase inbound registration (optional). `start()` connects + stores the
   * `onMessage` callback; this SECOND call registers the platform's message
   * listener so inbound events actually dispatch. Discord + Slack split start
   * from listen (the per-stack boot defers this until after Pass-2 trust merge);
   * single-phase adapters (Mattermost) register inside `start()` and omit it.
   *
   * Callers that drive an adapter directly (the shared surface gateway,
   * cortex#524) MUST call this after `start()` or no inbound is ever delivered.
   * Idempotent — adapters latch on first attach so re-calls are no-ops.
   */
  attachInboundDispatch?(): void;
}
