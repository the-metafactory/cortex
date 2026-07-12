/**
 * cortex#1794 (S9, ADR-0024 D5 extraction lane) — the Web/SSE surface binding
 * schema. Originally lived in cortex's `src/common/types/surfaces.ts`; S9b
 * relocated it to cortex's in-tree `src/adapters/web/schema.ts` (plugin-owned
 * data — S4's own principle: `adapters/registry.ts`'s
 * `AdapterPlugin.bindingSchema` docstring). S9 (this bundle) is the FINAL
 * relocation: the schema now lives HERE, in the
 * `metafactory-cortex-adapter-web` bundle repo, and cortex core no longer
 * imports or re-exports it at all — `surfaces.web[]` bindings validate
 * structurally like any other registry-contributed platform (cortex's
 * `SurfacesSchema` catchall), with this schema supplying the REAL per-field
 * validation once cortex's plugin loader registers `webAdapterPlugin` (see
 * `./plugin.ts`) and reads `bindingSchema` off it.
 */

import { z } from "zod/v4";

/**
 * Web surface binding — generic HTTP ingress + broadcast-push outbound.
 *
 * Any web/SSE app becomes a cortex-backed bot by:
 *  1. Posting inbound messages to cortex at `POST /message`.
 *  2. Receiving responses via the broadcast target (WS Durable Object or SSE
 *     endpoint) at `broadcastUrl`.
 *
 * Multi-tenant: each web application binds with its own `instanceId` +
 * `broadcastUrl` + agent. Zero surface-code changes are needed to add a
 * second consumer.
 *
 * Auth: cortex NEVER trusts `authorId` from the request body. It is derived
 * from platform-signed headers:
 *   - `cf-access`: `Cf-Access-Jwt-Assertion` JWT `sub` claim (default — CF
 *     Access-protected deployments). The JWT is decoded without verification
 *     at the adapter layer; CF Access already verified it at the edge.
 *   - `header`: a named request header carries the caller-identity directly
 *     (see `authHeader`). Suitable for trusted internal surfaces.
 *   - `none`: no auth header — falls back to the static instanceId as the
 *     authorId. DEV ONLY — never enable on a public-facing endpoint.
 */
export const WebBindingSchema = z
  .object({
    /**
     * Tenant/instance identifier — the `{tenant}` segment of `web:{tenant}`.
     * Must be unique across all web bindings for this principal so the
     * dispatch-sink can route responses to the correct adapter instance.
     * Example: `"acme"` → instanceId `"web:acme"`.
     */
    instanceId: z.string().min(1, "surfaces.web[].binding.instanceId is required"),
    /**
     * Port for the Bun HTTP ingress server. Each binding gets its own port
     * so multiple web surfaces can coexist on the same host. Default: 8090.
     */
    port: z.number().int().min(1).max(65535).default(8090),
    /**
     * Bind address for the Bun HTTP ingress. Defaults to loopback so the
     * ingress is never exposed on all interfaces; the CF-Access + cloudflared
     * perimeter is the only public path. Set to `"0.0.0.0"` ONLY for a
     * deliberately multi-homed deployment.
     */
    host: z.string().default("127.0.0.1"),
    /**
     * URL to POST broadcast messages to when cortex wants to push a reply to
     * the web surface. For `transport: "ws"` this is the WS Durable Object's
     * `/broadcast` endpoint (mirrors `dashboard-socket.ts` DO protocol); for
     * `transport: "sse"` it is an SSE push server's ingest endpoint. The
     * payload shape is identical: `{ adapter_instance, target, type, text }`.
     */
    broadcastUrl: z
      .string()
      .min(1, "surfaces.web[].binding.broadcastUrl is required")
      .regex(
        /^https?:\/\/.+/,
        "surfaces.web[].binding.broadcastUrl must be an http/https URL",
      ),
    /**
     * Transport flavour for the push half. `ws` (default) mirrors the
     * dashboard-socket DO protocol (POST /broadcast with a JSON body). `sse`
     * targets a plain SSE ingest endpoint with the same payload shape. The
     * adapter's push path is identical for both — the distinction lives in
     * the receiving server's delivery mechanism.
     */
    transport: z.enum(["ws", "sse"]).default("ws"),
    /**
     * Auth scheme for deriving `authorId` from inbound HTTP requests.
     * See module docstring for the full contract. Default: `cf-access`.
     */
    authScheme: z.enum(["cf-access", "header", "none"]).default("cf-access"),
    /**
     * Header name used when `authScheme = "header"`. The adapter reads this
     * header's value verbatim as the `authorId`. Ignored for other schemes.
     * Example: `"X-Cortex-User-Id"`.
     */
    authHeader: z.string().optional(),
    /**
     * Service-to-service inbound auth token (POST /message → cortex).
     *
     * When set, the adapter requires the inbound request to carry:
     *   `Authorization: Bearer <inboundToken>`
     * Requests missing or mismatching the token receive `401 Unauthorized`
     * before any message is dispatched.
     *
     * **Omit only on loopback deployments** where the network perimeter is
     * the sole trust boundary. Required for any cross-machine deployment.
     * Structured as a bearer-token seam so mTLS or a stronger scheme can
     * replace it via config alone — no code change required.
     */
    inboundToken: z.string().optional(),
    /**
     * Service-to-service outbound auth token (cortex → broadcastUrl POST).
     *
     * When set, every broadcast POST carries:
     *   `Authorization: Bearer <broadcastToken>`
     * The broadcast endpoint MUST verify this token — an unauthenticated
     * public broadcast endpoint is a cortex Critical Rule violation (SEV-1).
     *
     * **Omit only on loopback deployments.** Required for any cross-machine
     * deployment. Same bearer-token seam as `inboundToken`.
     */
    broadcastToken: z.string().optional(),
  })
  .catchall(z.unknown());

export type WebBinding = z.infer<typeof WebBindingSchema>;
