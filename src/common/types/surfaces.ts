/**
 * IAW CFG.c — the `surfaces.yaml` layer schema + the binding-fold helper.
 *
 * CFG.c moves the per-platform **surface bindings** (Discord/Slack/Mattermost
 * `token`, `guild`, channel/instance bindings) out of each stack's
 * `agents[*].presence.{platform}` block and into a top-level `surfaces.yaml`
 * layer. This is the file the shared surface gateway (GW, §13.2) consumes: it
 * is the `{surface-instance → stack}` binding map — the single place that says
 * "this platform credential/instance belongs to this stack's agent".
 *
 * It is a **source-layout change, not a runtime-shape change**. The composer
 * (`composeRawConfig`) reads `surfaces/surfaces.yaml`, folds each binding back
 * into the matching `agents[*].presence.{platform}` block of the raw config,
 * and drops the `surfaces:` key — so by the time the existing
 * `loadCortexShape` parse/flatten runs, the raw object is **identical** to the
 * inline (pre-CFG.c) form. `LoadedConfig` is byte-identical; every consumer
 * (`src/cortex.ts` per-presence-token wiring, the per-stack adapters) keeps
 * working unchanged.
 *
 * The fold is **additive and optional**: a config with NO `surfaces.yaml` (the
 * three live deployments — `cortex.yaml` / `cortex.work.yaml` /
 * `cortex.halden.yaml` carry bindings inline in per-stack presence) loads
 * unchanged via the fallback. Per-stack presence is always the fallback;
 * `surfaces.yaml` is layered on top.
 *
 * =============================================================================
 * The binding map shape (GW precondition — CFG.c.3)
 * =============================================================================
 *
 * ```yaml
 * surfaces:
 *   discord:
 *     - agent: ivy            # which agent's presence.discord this binding fills
 *       stack: andreas/research   # OPTIONAL — the target stack id (GW {instance → stack})
 *       binding:              # the per-platform binding/credential fields
 *         token: REPLACE_WITH_DISCORD_BOT_TOKEN
 *         guildId: "000000000000000000"
 *         agentChannelId: "000000000000000000"
 *         logChannelId: "000000000000000000"
 *   slack:
 *     - agent: ivy
 *       binding:
 *         botToken: xoxb-...
 *         appToken: xapp-...
 *         workspaceId: T01234567
 *   mattermost:
 *     - agent: ivy
 *       binding:
 *         apiUrl: https://mm.example.com
 *         apiToken: ...
 * ```
 *
 * - **Key**: platform (`discord` | `slack` | `mattermost`).
 * - **`agent`**: the agent id whose `presence.{platform}` block this binding
 *   fills. This is the join key against `stacks/*.yaml` `agents[].id`.
 * - **`stack`**: OPTIONAL `{principal}/{stack}` id — the surface-instance ↔
 *   stack binding the GW routes on (`{instance → stack}`). Carried verbatim so
 *   the gateway can build its routing table; the composer does not consume it
 *   when folding (the agent id is the fold key within the composed raw config).
 * - **`binding`**: the per-platform credential/instance fields — exactly the
 *   subset of `{Discord,Slack,Mattermost}PresenceSchema` that constitutes the
 *   surface binding (the dangerous tokens + the guild/workspace/channel ids).
 *   These are merged onto the agent's existing `presence.{platform}` block
 *   (binding wins on leaf keys), so a stack file may still carry the
 *   non-binding presence knobs (`contextDepth`, `surfaceSubjects`, …) inline.
 *
 * Why `binding` is a nested sub-object rather than flat: it draws a crisp line
 * between the **binding** the GW owns (and resolves per instance) and the rest
 * of the presence block the stack owns. The GW reads `surfaces.{platform}[].binding`
 * for the connection; the stack keeps the render knobs.
 */

import { z } from "zod/v4";

import { LETTER_PREFIX_ID_REGEX } from "./id";
import { isPlainObject } from "./object-guards";

// =============================================================================
// Per-platform binding schemas — the credential/instance subset that moves
// =============================================================================
//
// These intentionally mirror the binding-bearing fields of the matching
// `*PresenceSchema` in `cortex-config.ts`. They are deliberately PERMISSIVE
// supersets (`.passthrough()` is avoided — see below) of the required binding
// fields: the schema's job here is to validate the REQUIRED binding fields
// (CFG.c.4) are present and well-typed. The full presence validation still
// happens downstream when the folded raw config is parsed by
// `CortexConfigSchema` — so any binding field also re-validates against the
// canonical presence schema after the fold. Keeping the binding schemas as
// supersets (required fields + open `.catchall`) means a stack can put any
// presence-shaped knob under `binding` and have it folded; the canonical
// presence schema is the final arbiter.

/**
 * Discord surface binding — the connection-defining subset of
 * `DiscordPresenceSchema`. `token` + `guildId` are the irreducible binding;
 * the channel ids are the instance's render targets. `catchall(z.unknown())`
 * lets any other presence field (e.g. `contextDepth`, `trustedBotIds`,
 * `surfaceSubjects`) ride along under `binding` and fold through — the
 * canonical `DiscordPresenceSchema` validates them post-fold.
 */
export const DiscordBindingSchema = z
  .object({
    token: z.string().min(1, "surfaces.discord[].binding.token is required"),
    guildId: z.coerce.string().min(1, "surfaces.discord[].binding.guildId is required"),
    agentChannelId: z.coerce
      .string()
      .min(1, "surfaces.discord[].binding.agentChannelId is required"),
    logChannelId: z.coerce
      .string()
      .min(1, "surfaces.discord[].binding.logChannelId is required"),
  })
  .catchall(z.unknown());

/**
 * Slack surface binding — `botToken` + `appToken` + `workspaceId` are the
 * irreducible Socket-Mode binding (mirror of `SlackPresenceSchema`). Regexes
 * match the canonical presence schema so a malformed token fails at the
 * surfaces layer, not only post-fold.
 */
export const SlackBindingSchema = z
  .object({
    botToken: z
      .string()
      .regex(/^xoxb-/, "surfaces.slack[].binding.botToken must be a bot user OAuth token (xoxb-...)"),
    appToken: z
      .string()
      .regex(/^xapp-/, "surfaces.slack[].binding.appToken must be an app-level token (xapp-...)"),
    workspaceId: z.coerce
      .string()
      .regex(
        /^T[A-Z0-9]{8,16}$/,
        "surfaces.slack[].binding.workspaceId must be a Slack team id (T... with 8-16 trailing chars)",
      ),
  })
  .catchall(z.unknown());

/**
 * Mattermost surface binding — the API connection subset of
 * `MattermostPresenceSchema`. `apiUrl` + `apiToken` are the irreducible
 * binding (the bot needs both to reach the server); webhook/trigger knobs ride
 * along via the catchall.
 */
export const MattermostBindingSchema = z
  .object({
    apiUrl: z.string().min(1, "surfaces.mattermost[].binding.apiUrl is required"),
    apiToken: z.string().min(1, "surfaces.mattermost[].binding.apiToken is required"),
  })
  .catchall(z.unknown());

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
     * Example: `"amt"` → instanceId `"web:amt"`.
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

// =============================================================================
// Binding entry — one surface-instance bound to one stack's agent
// =============================================================================

/** Common fields on every per-platform binding entry. */
const bindingEntryBase = {
  /**
   * The agent id whose `presence.{platform}` block this binding fills — the
   * join key against `stacks/*.yaml` `agents[].id`. Same id grammar as
   * `AgentSchema.id` (letter-prefixed lowercase alphanumeric + hyphen).
   */
  agent: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "surfaces[].agent must be a valid agent id (lowercase alphanumeric + hyphen, starting with a letter) matching an agents[].id in the stack",
  ),
  /**
   * OPTIONAL `{principal}/{stack}` id — the surface-instance ↔ stack binding
   * the GW routes on. Carried verbatim for the gateway's `{instance → stack}`
   * routing table; the composer does not consume it when folding (the agent
   * id is the fold key). Validated loosely as a non-empty string here — the
   * canonical stack-id grammar lives in `StackConfigSchema.id` and is GW's to
   * resolve.
   */
  stack: z.string().min(1).optional(),
};

export const DiscordSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: DiscordBindingSchema,
});

export const SlackSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: SlackBindingSchema,
});

export const MattermostSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: MattermostBindingSchema,
});

/**
 * Web surface binding entry.
 *
 * Unlike the Discord/Slack/Mattermost entries, the `web` binding does NOT fold
 * into `agents[*].presence.web` at config-compose time (there is no legacy
 * `cortex.yaml` web-presence shape to fold into). Instead, the gateway
 * consumes `surfaces.web[]` directly from the `Surfaces` object and constructs
 * a `WebAdapter` per entry. The `agent` field is still the join key used by
 * `buildGatewayAdapters` to build the synthetic gateway agent; the `stack`
 * field carries the `{principal}/{stack}` routing target as usual.
 */
export const WebSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: WebBindingSchema,
});

// =============================================================================
// Top-level `surfaces:` block
// =============================================================================

/**
 * The `surfaces:` block — the binding map. Keyed by platform; each platform
 * holds a list of `{agent, stack?, binding}` entries. All platforms are
 * optional (a deployment may bind only Discord). `.strict()` rejects an
 * unknown platform key loudly so a typo (`discrod:`) surfaces at load rather
 * than silently contributing nothing to the fold.
 *
 * Note: `web[]` bindings are NOT folded by `foldSurfaceBindings` (there is no
 * legacy presence shape). The gateway factory consumes them directly.
 */
export const SurfacesSchema = z
  .object({
    discord: z.array(DiscordSurfaceBindingSchema).optional(),
    slack: z.array(SlackSurfaceBindingSchema).optional(),
    mattermost: z.array(MattermostSurfaceBindingSchema).optional(),
    /**
     * Web/SSE bindings — generic HTTP-ingress + broadcast-push surface.
     * Multi-tenant: one entry per web application. Not folded into the
     * per-stack config; the gateway factory constructs a WebAdapter per entry.
     */
    web: z.array(WebSurfaceBindingSchema).optional(),
  })
  // `.strict()` rejects an unknown platform key loudly so a typo (`discrod:`)
  // surfaces at load rather than silently contributing nothing to the fold.
  .strict();

export type Surfaces = z.infer<typeof SurfacesSchema>;
export type DiscordSurfaceBinding = z.infer<typeof DiscordSurfaceBindingSchema>;
export type SlackSurfaceBinding = z.infer<typeof SlackSurfaceBindingSchema>;
export type MattermostSurfaceBinding = z.infer<typeof MattermostSurfaceBindingSchema>;
export type WebSurfaceBinding = z.infer<typeof WebSurfaceBindingSchema>;
export type WebBinding = z.infer<typeof WebBindingSchema>;

// =============================================================================
// The fold — surfaces.yaml bindings → agents[*].presence.{platform}
// =============================================================================

const PLATFORMS = ["discord", "slack", "mattermost"] as const;

/**
 * CFG.c.1/CFG.c.2 — fold a `surfaces:` block into the composed raw config's
 * `agents[*].presence.{platform}` blocks, returning a NEW raw object with the
 * top-level `surfaces:` key removed.
 *
 * Called by `composeRawConfig` AFTER the directory layers are deep-merged and
 * BEFORE the result is handed to the parse/flatten path. The result is the
 * exact shape the inline (pre-CFG.c) config produced — so `LoadedConfig` is
 * unchanged and no consumer is touched.
 *
 * Resolution / precedence (the design fork called out in CFG.c):
 *
 *   - The binding's `agent` field is matched against `agents[].id` in the
 *     composed raw config. The binding is merged onto that agent's
 *     `presence.{platform}` block, **binding fields winning on leaf keys**
 *     (the surfaces.yaml layer is the more-specific surface-of-truth for the
 *     credential/instance fields, layered on top of any inline presence the
 *     stack file declared). A stack may therefore keep non-binding presence
 *     knobs (`contextDepth`, `surfaceSubjects`) inline and let surfaces.yaml
 *     own only the binding — the two merge.
 *   - If the agent has no `presence.{platform}` block yet, one is created from
 *     the binding alone.
 *   - **No matching agent → loud error.** A binding that names an agent absent
 *     from every stack is almost certainly a typo or a stale binding; failing
 *     loudly beats silently dropping a credential (which would leave the agent
 *     dark with no diagnostic).
 *
 * `surfaces` absent or empty → `raw` returned unchanged (minus a no-op clone),
 * which is the fallback path the three live single-presence configs take.
 *
 * The function does NOT mutate its input (pure fold — idempotent re-composition
 * yields the same object, matching `deepMerge`'s contract).
 */
export function foldSurfaceBindings(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const surfacesRaw = raw.surfaces;
  if (surfacesRaw === undefined || surfacesRaw === null) {
    // No surfaces layer — per-stack presence is the fallback. Nothing to fold.
    return raw;
  }

  // Validate the binding map loudly (CFG.c.4 — required binding fields). A
  // malformed surfaces.yaml fails at load, not silently.
  const surfaces = SurfacesSchema.parse(surfacesRaw);

  // Detach so we never mutate the caller's object (idempotent fold).
  const out = structuredClone(raw);
  delete out.surfaces;

  const agents = out.agents;
  if (!Array.isArray(agents)) {
    throw new Error(
      "config-composer: surfaces.yaml is present but the composed config declares no `agents:` array to fold bindings into — " +
        "surface bindings name an agent id, so at least one stack with `agents:` must compose alongside surfaces.yaml.",
    );
  }

  // Index agents by id for the fold join.
  const agentById = new Map<string, Record<string, unknown>>();
  for (const a of agents) {
    if (isPlainObject(a) && typeof a.id === "string") {
      agentById.set(a.id, a);
    }
  }

  for (const platform of PLATFORMS) {
    const entries = surfaces[platform];
    if (!entries) continue;
    for (const entry of entries) {
      const agent = agentById.get(entry.agent);
      if (!agent) {
        throw new Error(
          `config-composer: surfaces.yaml ${platform} binding names agent "${entry.agent}", ` +
            `but no agents[].id in the composed config matches it. ` +
            `Known agent ids: [${[...agentById.keys()].join(", ") || "(none)"}]. ` +
            `Fix the binding's \`agent:\` field or add the agent to a stack.`,
        );
      }
      const presence = isPlainObject(agent.presence) ? agent.presence : {};
      const existing = isPlainObject(presence[platform])
        ? presence[platform]
        : {};
      // Binding wins on leaf keys (surfaces.yaml is the credential surface of
      // truth, layered over any inline non-binding presence knobs).
      presence[platform] = { ...existing, ...entry.binding };
      agent.presence = presence;
    }
  }

  return out;
}
