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
  /** DM classification: operator (full access) or user (standard guards) */
  dmType?: "operator" | "user";
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
  /** Whether bash guard should be active. Default: true. Operator DM may set false. */
  bashGuard?: boolean;
  /** Override bash allowlist (DM role may specify its own) */
  bashAllowlist?: { rules: Array<{ pattern: string; repos?: string[] }>; repos: string[] };
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
  /** Send a notification to the operator */
  notifyOperator(text: string): Promise<void>;
  /** F-092: Hot-reload adapter config (optional, for adapters that support it) */
  updateConfig?(config: unknown): void;
}
