/**
 * C-110: Generic Web/SSE Surface Adapter
 *
 * Implements `PlatformAdapter` for any web or SSE-backed bot surface. Any web
 * application becomes a cortex-backed bot by:
 *
 *   1. POSTing inbound messages to cortex at `POST /message`.
 *   2. Receiving responses via the configured broadcast target.
 *
 * ## Inbound (HTTP POST)
 *
 * Accepts `POST /message` with JSON body `{ channel, thread?, body, user? }`.
 * Maps to cortex's neutral `InboundMessage` with:
 *   - `platform: "web"`
 *   - `instanceId`: from the binding (e.g. `"web:acme"`)
 *   - `authorId`: derived from platform-signed headers ONLY — NEVER from the
 *     request body (CF-Access JWT `sub`, or a trusted internal header)
 *   - `channelId` / `threadId`: from the body `channel` / `thread` fields
 *   - `channelName` / `threadName`: same values (web surfaces don't have a
 *     separate display-name vs id distinction)
 *
 * Responds `202 Accepted` immediately; cortex processes async and pushes the
 * response via the broadcast target.
 *
 * ## Outbound sink (broadcast push)
 *
 * `postResponse` / `sendProgress` / `clearProgress` push to the configured
 * `broadcastUrl`. Payload: `{ adapter_instance, target, type, text }`. The
 * dispatch-sink's `adapter_instance` filter already ensures only envelopes
 * routed to THIS instance are delivered; the `target` carries `channel` +
 * optional `thread` so the receiving app knows where to render the reply.
 *
 * `surfaceSubjects: []` — the web adapter never registers bus subjects, so the
 * surface-router never double-delivers lifecycle envelopes (dispatch-sink owns
 * the sole delivery path per `dispatch-sink.ts:18-28`).
 *
 * ## Auth — two independent layers
 *
 * ### Layer 1: Service-to-service (inbound gate)
 * When `binding.inboundToken` is set, every `POST /message` must carry:
 *   `Authorization: Bearer <inboundToken>`
 * Requests missing or mismatching the token return `401` before the body is
 * parsed. Omit only on loopback deployments; required for cross-machine.
 * Bearer-token seam — mTLS can replace via config, no code change.
 *
 * ### Layer 2: Per-user identity (authorId derivation)
 * After the service gate, `authorId` is derived from the user-identifying header:
 *   - `cf-access` (default): `Cf-Access-Jwt-Assertion` header → base64-decode
 *     the JWT payload → extract `sub` claim. CF Access verifies the JWT at the
 *     edge; the adapter decodes without re-verifying.
 *   - `header`: a named request header (`authHeader`) carries the caller id.
 *   - `none`: falls back to the static `instanceId` (DEV ONLY — never on a
 *     public endpoint).
 *
 * ### Outbound auth
 * When `binding.broadcastToken` is set, every broadcast POST carries:
 *   `Authorization: Bearer <broadcastToken>`
 * The broadcast endpoint MUST verify this — an unauthenticated public broadcast
 * endpoint is a cortex Critical Rule violation (SEV-1). Omit only on loopback.
 *
 * ## Reusability
 *
 * No tenant-specific logic lives here. A second web app binds with its own
 * `instanceId` + `broadcastUrl` + agent, zero surface-code changes.
 */

import type { Server } from "bun";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServer = Server<any>;
import type {
  PlatformAdapter,
  InboundMessage,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "../../surface-sdk";
import type { Agent } from "../../common/types/cortex-config";
import type { WebBinding } from "../../common/types/surfaces";
import {
  isOperatorPrincipal,
  resolvePolicyAccess,
  type PlatformPrincipalIndex,
  type PolicyEngine,
  type PrincipalRegistry,
} from "../../common/policy";

// =============================================================================
// Inbound body shape
// =============================================================================

/** Shape of the JSON body posted to `POST /message`. */
export interface WebInboundBody {
  /** Platform-native channel id (required). */
  channel: string;
  /** Thread id within the channel (optional — omit for top-level). */
  thread?: string;
  /** Message text (required). */
  body: string;
  /**
   * Caller-supplied display name (optional, used as `authorName` only when
   * the adapter cannot derive a display name from the auth header).
   */
  user?: string;
}

/** Broadcast push payload shape. */
export interface WebBroadcastPayload {
  /** Which adapter instance this response belongs to (dispatch-sink demux key). */
  adapter_instance: string;
  /** The target the caller originally sent to. */
  target: {
    channel: string;
    thread?: string;
  };
  /** Message type: `"response"` | `"progress"` | `"clear_progress"` | `"typing"`. */
  type: "response" | "progress" | "clear_progress" | "typing";
  /** Response text (absent for `clear_progress` and `typing`). */
  text?: string;
  /** Attached files (absent unless type=response with files). */
  files?: { filename: string; contentType?: string; content: string }[];
}

// =============================================================================
// Infra
// =============================================================================

/**
 * Cortex-deployment-level wiring for the WebAdapter.
 * Mirrors the `*AdapterInfra` shapes of Discord/Slack/Mattermost.
 */
export interface WebAdapterInfra {
  /** Unique adapter instance id — MUST be `"web:{tenant}"` for consistent demux. */
  instanceId: string;
  /** Principal identity (unused for push but required by the interface). */
  principal: { id?: string };
  /** Policy engine for access control (optional — allow-all when absent). */
  policyEngine?: PolicyEngine;
  /** Platform principal index for (platform, authorId) → principalId resolution. */
  policyLookup?: PlatformPrincipalIndex;
  /** Principal registry for principalId → PolicyPrincipal. */
  policyRegistry?: PrincipalRegistry;
}

// =============================================================================
// Auth helpers
// =============================================================================

/**
 * Decode a Cloudflare Access JWT (three-part, base64url) and return the `sub`
 * claim. CF Access has already verified the signature at the edge; we decode
 * only (no re-verification required here). Returns `null` if the header is
 * absent or the payload is unparseable.
 */
function extractCfAccessSub(request: Request): string | null {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    // base64url → base64 → Buffer → string → JSON
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(payload);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.sub === "string" && parsed.sub.length > 0) {
      return parsed.sub;
    }
    return null;
  } catch (_err) {
    // Malformed JWT payload — not a cortex error (could be upstream misconfiguration)
    return null;
  }
}

/**
 * Derive the `authorId` for an inbound request according to the binding's
 * `authScheme`. Returns a non-empty string in all cases (falls back to the
 * instanceId for the `none` scheme so the downstream pipeline always has a
 * stable id to correlate with).
 */
function deriveAuthorId(
  request: Request,
  binding: WebBinding,
  instanceId: string,
): string {
  switch (binding.authScheme) {
    case "cf-access": {
      const sub = extractCfAccessSub(request);
      return sub ?? `anon:web:${instanceId}`;
    }
    case "header": {
      const headerName = binding.authHeader ?? "X-Cortex-User-Id";
      const value = request.headers.get(headerName);
      return value && value.length > 0 ? value : `anon:web:${instanceId}`;
    }
    case "none":
      // DEV ONLY — always returns a fixed synthetic id.
      return `dev:web:${instanceId}`;
    default:
      return `anon:web:${instanceId}`;
  }
}

// =============================================================================
// WebAdapter
// =============================================================================

/**
 * Generic web/SSE platform adapter. Implements the full `PlatformAdapter`
 * interface; operates an HTTP ingress on a configured port and pushes
 * responses via a broadcast URL.
 */
export class WebAdapter implements PlatformAdapter {
  readonly platform = "web";
  readonly instanceId: string;

  private binding: WebBinding;
  /** The synthetic gateway agent — carries agentId for log correlation. */
  private agentId: string;
  private infra: WebAdapterInfra;
  private server: BunServer | null = null;
  private onMessageCallback: ((msg: InboundMessage) => Promise<void>) | null = null;
  /** The actual TCP port the server bound to (may differ from binding.port when port=0). */
  private _serverPort: number | null = null;

  constructor(agent: Agent, binding: WebBinding, infra: WebAdapterInfra) {
    this.agentId = agent.id;
    this.binding = binding;
    this.infra = infra;
    this.instanceId = infra.instanceId;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessageCallback = onMessage;

    this.server = Bun.serve({
      hostname: this.binding.host,
      port: this.binding.port,
      fetch: (req) => this.handleRequest(req),
    });
    this._serverPort = this.server.port ?? null;

    console.log(
      `web-adapter[${this.instanceId}] agent=${this.agentId}: HTTP ingress listening on ${this.binding.host}:${this._serverPort} (transport=${this.binding.transport})`,
    );
    return Promise.resolve();
  }

  /** The port the HTTP ingress is bound to (set after `start()`). */
  get serverPort(): number | null {
    return this._serverPort;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this._serverPort = null;
    this.onMessageCallback = null;
    console.log(`web-adapter[${this.instanceId}]: stopped`);
  }

  // ---------------------------------------------------------------------------
  // PlatformAdapter contract — identity
  // ---------------------------------------------------------------------------

  /**
   * MIG-7.2c-binding: stable service identity for this adapter instance.
   * The web adapter has no bot user id; returns a synthetic `web:{instanceId}`
   * string that is stable across restarts (keyed on the binding, not a session).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getPlatformUserId(): Promise<string> {
    return `web:${this.instanceId}`;
  }

  // ---------------------------------------------------------------------------
  // PlatformAdapter contract — access / context
  // ---------------------------------------------------------------------------

  resolveAccess(msg: InboundMessage): AccessDecision {
    return resolvePolicyAccess({
      msg,
      engine: this.infra.policyEngine,
      index: this.infra.policyLookup,
      registry: this.infra.policyRegistry,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchContext(_msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    // Web surfaces carry no server-side conversation history.
    return [];
  }

  // ---------------------------------------------------------------------------
  // PlatformAdapter contract — outbound delivery
  // ---------------------------------------------------------------------------

  async postResponse(
    target: ResponseTarget,
    text: string,
    files?: OutboundFile[],
  ): Promise<void> {
    const payload: WebBroadcastPayload = {
      adapter_instance: this.instanceId,
      target: {
        channel: target.channelId,
        ...(target.threadId !== undefined && { thread: target.threadId }),
      },
      type: "response",
      text,
      ...(files && files.length > 0 && {
        files: files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          content: f.content.toString("base64"),
        })),
      }),
    };
    await this.broadcast(payload);
  }

  async sendTyping(_target: ResponseTarget): Promise<void> {
    // No-op: web surfaces manage their own typing indicators locally.
    await Promise.resolve();
  }

  async sendProgress(target: ResponseTarget, text: string): Promise<void> {
    const payload: WebBroadcastPayload = {
      adapter_instance: this.instanceId,
      target: {
        channel: target.channelId,
        ...(target.threadId !== undefined && { thread: target.threadId }),
      },
      type: "progress",
      text,
    };
    await this.broadcast(payload);
  }

  async clearProgress(target: ResponseTarget): Promise<void> {
    const payload: WebBroadcastPayload = {
      adapter_instance: this.instanceId,
      target: {
        channel: target.channelId,
        ...(target.threadId !== undefined && { thread: target.threadId }),
      },
      type: "clear_progress",
    };
    await this.broadcast(payload);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createThread(msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    // Web surfaces use the channel id as the thread root for top-level
    // messages; a threaded reply carries the thread id through.
    return {
      instanceId: this.instanceId,
      channelId: msg.channelId,
      threadId: msg.threadId ?? msg.channelId,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolveLogicalTarget(_addr: {
    surface: string;
    channel: string;
    thread?: string;
  }): Promise<ResponseTarget | null> {
    // Not yet implemented — returns null so the review sink skips this adapter.
    return null;
  }

  async notifyPrincipal(text: string): Promise<void> {
    // Push to the broadcast target with a synthetic "principal-notify" channel.
    // The receiving app can filter on `target.channel === "_principal"`.
    const payload: WebBroadcastPayload = {
      adapter_instance: this.instanceId,
      target: { channel: "_principal" },
      type: "response",
      text,
    };
    await this.broadcast(payload);
  }

  // ---------------------------------------------------------------------------
  // HTTP ingress handler
  // ---------------------------------------------------------------------------

  /**
   * Handle an inbound HTTP request. Routes:
   *   - `GET  /health` — liveness check
   *   - `POST /message` — inbound bot message
   *   - Everything else — 404
   */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", adapter: this.instanceId });
    }

    if (url.pathname === "/message" && req.method === "POST") {
      return this.handleInbound(req);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleInbound(req: Request): Promise<Response> {
    // 0. Service-to-service inbound auth gate.
    //    When `inboundToken` is configured, the request MUST carry:
    //      Authorization: Bearer <inboundToken>
    //    Requests missing or mismatching the token are rejected before any body
    //    is parsed — this is service auth, separate from the per-user CF-Access /
    //    header auth that produces `authorId`.
    if (this.binding.inboundToken) {
      const authHeader = req.headers.get("Authorization");
      const expected = `Bearer ${this.binding.inboundToken}`;
      if (authHeader !== expected) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // 1. Parse body
    let body: WebInboundBody;
    try {
      body = (await req.json()) as WebInboundBody;
    } catch (_err) {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    if (typeof body.channel !== "string" || body.channel.length === 0) {
      return Response.json({ error: "body.channel is required" }, { status: 400 });
    }
    if (typeof body.body !== "string" || body.body.length === 0) {
      return Response.json({ error: "body.body is required" }, { status: 400 });
    }

    // 2. Derive authorId from platform-signed headers — NEVER the body
    const authorId = deriveAuthorId(req, this.binding, this.instanceId);

    // 3. Build InboundMessage
    const msg: InboundMessage = {
      platform: "web",
      instanceId: this.instanceId,
      authorId,
      authorName: body.user ?? authorId,
      content: body.body,
      channelId: body.channel,
      ...(body.thread !== undefined && { threadId: body.thread }),
      channelName: body.channel,
      ...(body.thread !== undefined && { threadName: body.thread }),
      authorIsPrincipal: this.isOperator(authorId),
      attachments: [],
      timestamp: new Date(),
    };

    // 4. Dispatch async — respond immediately so the caller isn't blocked
    //    on the CC session's latency.
    const handler = this.onMessageCallback;
    if (handler) {
      void handler(msg).catch((err: unknown) => {
        process.stderr.write(
          `web-adapter[${this.instanceId}]: onMessage error: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }

    return Response.json({ status: "accepted" }, { status: 202 });
  }

  // ---------------------------------------------------------------------------
  // Broadcast push (outbound)
  // ---------------------------------------------------------------------------

  /**
   * HTTP POST the broadcast payload to `binding.broadcastUrl`. Both `ws` and
   * `sse` transports use the same POST-to-URL mechanism; the distinction is on
   * the receiving server's delivery side (the DO's fan-out vs an SSE emitter).
   *
   * Failures are logged and swallowed — a failed push does not throw because:
   *   1. The dispatch already completed on the bus.
   *   2. The dispatch-sink's error boundary already logs at the delivery level.
   *   3. Surface delivery failures are retried via JetStream replay at the
   *      runner level, not here.
   */
  private async broadcast(payload: WebBroadcastPayload): Promise<void> {
    // Build headers — always Content-Type; add Authorization when
    // `broadcastToken` is configured (service-to-service outbound auth).
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.binding.broadcastToken) {
      headers.Authorization = `Bearer ${this.binding.broadcastToken}`;
    }

    try {
      const res = await fetch(this.binding.broadcastUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        process.stderr.write(
          `web-adapter[${this.instanceId}]: broadcast POST failed: ` +
            `${res.status} ${res.statusText} → ${this.binding.broadcastUrl}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `web-adapter[${this.instanceId}]: broadcast POST threw: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected isOperator(authorId: string): boolean {
    return isOperatorPrincipal(
      "web",
      authorId,
      this.infra.policyEngine,
      this.infra.policyLookup,
    );
  }
}
