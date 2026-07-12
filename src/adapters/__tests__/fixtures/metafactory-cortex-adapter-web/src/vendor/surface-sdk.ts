/**
 * Vendored subset of cortex's plugin SDK contract
 * (`the-metafactory/cortex`'s `src/surface-sdk/index.ts` +
 * `src/adapters/types.ts` + `src/adapters/registry.ts` +
 * `src/common/types/context.ts`), pinned to `SURFACE_SDK_VERSION` "1.0.0"
 * (this bundle's `cortex-plugin.yaml` declares `sdkRange: "^1"`).
 *
 * WHY VENDORED, NOT IMPORTED: cortex's own `docs/plugin-sdk.md` states the
 * `@cortex/surface-sdk` import specifier shown in its authoring guide is
 * "illustrative of how an out-of-tree bundle resolves the SDK once S6's
 * loader ships it" — and explicitly lists "Publishing an npm package for the
 * SDK" as OUT OF SCOPE for that doc. As of cortex#1794 (S9), no published
 * package or workspace alias exists for `surface-sdk` — cortex's own
 * `package.json` `exports` map exposes only `./bus` and `./config-loader`.
 * This is a real, currently-unbuilt piece of ecosystem tooling, not
 * something a single adapter-extraction slice should invent unilaterally.
 *
 * Until that publishing mechanism exists, this file is the pragmatic
 * stand-in — a hand-maintained copy of ONLY the types this adapter's
 * `PlatformAdapter` / `AdapterPlugin` implementation actually references.
 * It carries no runtime code of its own (every export here is `type`/
 * `interface`), so it is erased entirely by `import type` at both the
 * bundle's own build AND at cortex's loader `import()` time — this file
 * exists purely to make `bunx tsc --noEmit` succeed standalone; it changes
 * nothing about runtime behavior.
 *
 * KEEP IN SYNC MANUALLY: if cortex bumps `SURFACE_SDK_VERSION` to a new
 * major (a breaking change to `PlatformAdapter`, `AdapterPlugin`, or
 * `AdapterPolicyPort`), re-diff this file against cortex's real
 * `src/surface-sdk/index.ts` + `src/adapters/types.ts` +
 * `src/adapters/registry.ts` before bumping this bundle's `sdkRange`.
 */

import type { z } from "zod/v4";

// =============================================================================
// Platform adapter contract (cortex's src/adapters/types.ts)
// =============================================================================

/** Inbound file attachment metadata. */
export interface InboundAttachment {
  url: string;
  filename: string;
  contentType?: string;
  size?: number;
  content?: string;
}

/** Platform-agnostic inbound message. */
export interface InboundMessage {
  platform: string;
  instanceId: string;
  authorId: string;
  authorName: string;
  content: string;
  channelId: string;
  threadId?: string;
  channelName?: string;
  threadName?: string;
  guildId?: string;
  isDM?: boolean;
  dmType?: "principal" | "user";
  authorIsPrincipal?: boolean;
  attachments: InboundAttachment[];
  timestamp: Date;
  _native?: unknown;
}

/** Result of an access-control check. */
export interface AccessDecision {
  allowed: boolean;
  features: {
    chat: boolean;
    async: boolean;
    team: boolean;
  };
  toolRestrictions?: string[];
  allowedTools?: string[];
  dirRestrictions?: string[];
  allowedSkills?: string[];
  bashGuard?: boolean;
  bashAllowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] };
  isDM?: boolean;
  trusted?: boolean;
  denyReason?: string;
  denyCode?: "no_policy" | "unmapped_sender" | "registry_drift" | "lockout";
  anonPrincipal?: boolean;
  anonPrincipalId?: string;
}

/** Where to send a response. */
export interface ResponseTarget {
  instanceId: string;
  channelId: string;
  threadId?: string;
  sessionId?: string;
  _native?: unknown;
}

/** Outbound file attachment. */
export interface OutboundFile {
  content: Buffer;
  filename: string;
  contentType?: string;
}

/** Context-fetch attachment (cortex's src/common/types/context.ts). */
export interface ContextAttachment {
  name: string;
  url: string;
  contentType: string;
  size: number;
}

/** One fetched context message (cortex's src/common/types/context.ts). */
export interface ContextMessage {
  role: "human" | "assistant";
  author: string;
  content: string;
  timestamp: string;
  attachments?: ContextAttachment[];
}

/** The core adapter interface every platform implements. */
export interface PlatformAdapter {
  readonly platform: string;
  readonly instanceId: string;
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  getPlatformUserId(): Promise<string>;
  fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]>;
  resolveAccess(msg: InboundMessage): AccessDecision;
  postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void>;
  sendTyping(target: ResponseTarget): Promise<void>;
  sendProgress(target: ResponseTarget, text: string): Promise<void>;
  clearProgress(target: ResponseTarget): Promise<void>;
  createThread(msg: InboundMessage, name: string): Promise<ResponseTarget>;
  resolveLogicalTarget(addr: {
    surface: string;
    channel: string;
    thread?: string;
  }): Promise<ResponseTarget | null>;
  notifyPrincipal(text: string): Promise<void>;
  updateConfig?(config: unknown): void;
  attachInboundDispatch?(): void;
}

// =============================================================================
// Plugin descriptor contract (cortex's src/adapters/registry.ts, ADR-0024 D5)
// =============================================================================

export type PluginKind = "adapter" | "renderer";

/** A `surfaces.{platform}[]` entry — `{ agent, stack?, binding }`. */
export interface SurfaceBindingEntry {
  readonly agent: string;
  readonly stack?: string;
  readonly binding: Record<string, unknown>;
}

/** One construction group — the binding entries sharing ONE live connection. */
export interface BindingGroup {
  readonly entries: readonly SurfaceBindingEntry[];
  readonly instanceId: string;
}

/** The fields `buildGatewayAdapters`' generic loop threads into
 *  `AdapterPlugin.buildGatewayConstructArgs` for every platform. */
export interface GatewayConstructBase {
  readonly instanceId: string;
  readonly source: unknown;
  readonly runtime: unknown;
  readonly policy?: unknown;
}

/** Per-platform adapter plugin descriptor — the shape the S6 loader
 *  structurally validates a bundle's default export against. */
export interface AdapterPlugin {
  readonly kind: "adapter";
  readonly id: string;
  readonly platform: string;
  readonly bindingSchema: z.ZodType;
  readonly foldsIntoPresence: boolean;
  readonly secretFields: readonly string[];
  demuxKey(binding: Record<string, unknown>): string;
  groupBindings?(entries: readonly SurfaceBindingEntry[]): BindingGroup[];
  buildGatewayConstructArgs(group: BindingGroup, base: GatewayConstructBase): Record<string, unknown>;
  createAdapter(args: Record<string, unknown>): PlatformAdapter;
}

/** A plugin's `sdkRange`-carrying default export (ADR-0024 D1). */
export type SurfacePluginDescriptor<T> = T & { readonly sdkRange: string };

// =============================================================================
// Host-injected policy port (cortex#1794 S9b — ADR-0024 D5 extraction lane)
// =============================================================================

/**
 * The narrow, TYPE-ONLY behavioral contract an adapter uses to authorise an
 * inbound message, in place of importing cortex's `PolicyEngine` /
 * `PlatformPrincipalIndex` / `PrincipalRegistry` (`common/policy`) directly.
 * The host (cortex's `gateway-adapters.ts`) binds this over its real policy
 * engine at adapter-construction time and hands the bound port through
 * `AdapterPlugin.createAdapter`'s args — this adapter never imports
 * `common/policy` itself.
 */
export interface AdapterPolicyPort {
  /** Resolve `msg` to an `AccessDecision` via the host's bound policy engine. */
  resolveAccess(msg: InboundMessage): AccessDecision;
  /** Whether `(platform, platformId)` maps to a principal holding the
   *  `operator` capability. */
  isOperatorPrincipal(platform: string, platformId: string): boolean;
}
