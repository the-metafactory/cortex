// API-P0.3 (epic #2055, Phase 0, decisions D1/D2) — the KEYSTONE: the
// normalized, provider-neutral model-provider contract that every provider
// adapter implements and the harness consumes. Design §"Model-provider
// contract": deliberately SMALLER than any provider's full API. Provider-only
// knobs live under the single namespaced `options` escape hatch (open Q5);
// no vendor wire fields leak onto these core types.
//
// Types only — no runtime code, no provider implementations, no registry
// (→ API-P0.4), no dispatch-envelope mapping (→ API-P1.4).

import type { ProviderError } from "./errors";

// ── Content model ───────────────────────────────────────────────────────────
// Text, image references, tool calls, and tool results. Phase 1 sends text
// ONLY, but the content types must already support the others so Phase 3 does
// not have to reshape them.

/** A plain-text span of message content. */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * A reference to an image — a pointer (url or opaque provider-side id / handle),
 * NOT inlined bytes. The core model carries the reference; providers that
 * support images resolve it. `mediaType` is the MIME type when known.
 */
export interface ImageRefContent {
  type: "image_ref";
  /** How to locate the image: a URL, or a provider/store-scoped handle. */
  source: { kind: "url"; url: string } | { kind: "handle"; id: string };
  /** MIME type (e.g. "image/png"), when known. */
  mediaType?: string;
}

/**
 * A model-issued request to invoke a tool. `input` is the fully-assembled tool
 * arguments (streamed deltas arrive separately as `tool_call.delta` events).
 */
export interface ToolCallContent {
  type: "tool_call";
  /** Correlates the call with its later result. */
  id: string;
  name: string;
  input: unknown;
}

/**
 * The result of executing a tool, fed back to the model. `toolCallId` matches
 * the originating {@link ToolCallContent.id}.
 */
export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  /** The tool's output as normalized content (typically text). */
  content: readonly MessageContent[];
  /** Whether the tool execution failed. */
  isError?: boolean;
}

/** A single unit of normalized message content. */
export type MessageContent =
  | TextContent
  | ImageRefContent
  | ToolCallContent
  | ToolResultContent;

/** The author of a message in the normalized request. */
export type MessageRole = "user" | "assistant" | "tool";

/** One normalized message: an author plus an ordered list of content parts. */
export interface ModelMessage {
  role: MessageRole;
  content: readonly MessageContent[];
}

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * The single namespaced escape hatch for provider-only knobs. Keyed by an
 * opaque provider namespace (e.g. `"anthropic"`); the value is an opaque bag
 * the harness never inspects. This is the ONLY place vendor-specific options
 * may appear — never as fields on the core request/content/event types.
 */
export type ProviderOptions = Readonly<Record<string, Record<string, unknown>>>;

/**
 * A normalized inference request. Provider-neutral by construction: no provider
 * wire fields appear here; anything vendor-specific goes under {@link options}.
 */
export interface ModelRequest {
  /** The target model id (provider-neutral identifier). */
  model: string;
  /**
   * System / persona instructions applied to the whole request, separate from
   * the conversational message list.
   */
  instructions?: string;
  /** The ordered conversation history. */
  messages: readonly ModelMessage[];
  /** Upper bound on generated tokens. */
  maxOutputTokens?: number;
  /**
   * Namespaced, opaque provider-only options. The harness passes these through
   * untouched; portable behaviour must NOT depend on them.
   */
  options?: ProviderOptions;
}

// ── Streaming events ────────────────────────────────────────────────────────

/**
 * The reason a response finished. A small closed union; every provider's native
 * stop reason normalizes onto one of these.
 */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_use"
  | "content_filter"
  | "error";

/**
 * The normalized streaming event union yielded by {@link ModelProvider.stream}.
 * Every provider's server-sent stream maps onto these events.
 */
export type ModelEvent =
  | { type: "response.started"; providerRequestId?: string }
  | { type: "text.delta"; text: string }
  | { type: "tool_call.delta"; id: string; name?: string; json: string }
  | { type: "tool_call.completed"; id: string; name: string; input: unknown }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
    }
  | { type: "response.completed"; finishReason: FinishReason }
  | { type: "error"; error: ProviderError };

// ── Provider ────────────────────────────────────────────────────────────────

/** The feature matrix a provider advertises up front. */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelTools: boolean;
  images: boolean;
  documents: boolean;
  structuredOutput: boolean;
  serverContinuation: boolean;
  promptCaching: boolean;
}

/**
 * The normalized model-provider contract. Every provider adapter implements
 * this; the harness consumes only this. Deliberately smaller than any
 * provider's full API.
 */
export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
