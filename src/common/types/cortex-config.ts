/**
 * MIG-7.2 base — CortexConfig schema (the flipped model from architecture §9.1).
 *
 * Replaces grove-v2's `BotConfig` shape (`agent:` + `discord:[]` + `mattermost:[]` +
 * `trustedAgentBots:`) with a first-class agent model:
 *
 *   operator:                  who is running this cortex instance
 *   agents:                    first-class agent bundles
 *     - id: luna
 *       displayName: Luna
 *       persona: ./personas/luna.md
 *       roles: [operator]
 *       trust: [echo, holly, ivy]
 *       presence:              owned by the agent — one per platform
 *         discord: { token, guildId, ... }
 *         mattermost: { ... }
 *   renderers:                 multi-agent / non-agent-bound surfaces
 *     - kind: dashboard | pagerduty | cli-tail | webhook-out
 *   nats:                      bus runtime config (M2)
 *   github:                    GitHub webhook surface (taps)
 *   claude / paths / etc.      cross-cutting infra (unchanged shape)
 *
 * This file is **additive** — `BotConfig` in `./config.ts` continues to be the
 * load-bearing config until MIG-7.2 sub-PRs (7.2a registry, 7.2b trust-resolver,
 * 7.2c adapter refactor, 7.2d renderers, 7.2e migrate-config) move call-sites
 * across. See `docs/plan-cortex-migration.md` §4 MIG-7.2*.
 *
 * Coupling rules from architecture §9.3 enforced by this schema:
 *   - agents never reference other agents' platform user IDs (trust is by agent id)
 *   - presence blocks carry only credentials, not persona/roles overrides
 *   - personas are platform-neutral (just a markdown file path)
 *   - renderers never publish on the bus (kind enum constrains the choice set)
 */

import { z } from "zod/v4";

import {
  DMConfigSchema,
  NetworkClaudeSchema,
  NetworkCloudSchema,
  NetworkFileSchema,
  RoleSchema,
} from "./config";
import { StackConfigSchema } from "./stack";

// =============================================================================
// Helper — Zod v4 empty-default workaround
// =============================================================================

/**
 * Zod v4 quirk: `schema.default({} as any)` does NOT re-parse `{}` through the
 * inner schema. Consumers that omit the field get the literal `{}` rather than
 * the populated inner defaults — so `parsed.attachments.enabled` is undefined
 * instead of `true`.
 *
 * `emptyDefault(schema)` wraps a ZodObject so the default value is computed by
 * parsing `{}` through the schema itself, which DOES trigger field-level
 * defaults. Eager computation — the inner parse happens once at schema-
 * definition (module load) time, and the resulting value is reused for every
 * subsequent `.parse()` call on the outer schema. This keeps validation
 * predictable and avoids per-parse-call recomputation.
 *
 * Use this everywhere a "block is optional and falls back to its own field
 * defaults" pattern is needed. Single greppable site replaces the scattered
 * `as any` casts inherited from grove-v2's config.ts.
 */
function emptyDefault<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  // Eagerly parse `{}` through the schema to compute the inner-default-applied
  // shape, then use that concrete value as the literal default. Zod's typed
  // default expects `NoUndefined<output<T>>` which the parse result satisfies
  // structurally — but the generic narrowing requires a single localized
  // `as never` cast at the call to `.default()`. This is the only type-system
  // escape hatch in the file; the rest is strongly-typed.
  return schema.default(schema.parse({}) as never);
}

// =============================================================================
// Operator — who is running this cortex instance
// =============================================================================

/**
 * The operator is the human (or team) running this cortex deployment. Replaces
 * grove-v2's `agent.operatorId` + `agent.operatorDiscordId` + `agent.operatorMattermostId`
 * fields by lifting them out of the (now removed) singular `agent:` block.
 */
export const OperatorSchema = z.object({
  /**
   * Operator identifier — used as the `{org}` subject segment on the bus
   * (`local.{org}.…`). Must be safe to embed verbatim in NATS subjects, so
   * the same regex agents use applies: lowercase alphanumeric + hyphen. No
   * dots, no wildcards, no whitespace.
   */
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "operator id must be lowercase alphanumeric"),
  /** Display name shown on the dashboard. Defaults to `id`. */
  displayName: z.string().optional(),
  /** Operator's Discord user id — receives DM notifications from agents. */
  discordId: z.string().optional(),
  /** Operator's Mattermost user id — same purpose, Mattermost-side. */
  mattermostId: z.string().optional(),
  /**
   * Data residency stamped into `sovereignty.data_residency` on emitted
   * envelopes. ISO-3166-1 alpha-2 country code (two uppercase ASCII letters).
   * Defaults to "NZ" when omitted. Operators in AU/EU/US/etc. set this to
   * match their jurisdiction.
   *
   * Format-enforced so a typo at config time fails fast rather than emitting
   * envelopes with malformed residency tags that survive into compliance
   * audits (Holly W2 review).
   */
  dataResidency: z.string()
    .regex(/^[A-Z]{2}$/, "dataResidency must be a 2-letter ISO-3166-1 alpha-2 country code")
    .default("NZ"),
});

export type Operator = z.infer<typeof OperatorSchema>;

// =============================================================================
// Agent presence — one block per platform an agent shows up on
// =============================================================================

/**
 * Discord presence — an agent's identity on a Discord guild. The full grove-v2
 * `DiscordInstanceSchema` carries channel ids, role config, DM rules, etc.;
 * we keep them here in the same shape so adapter code can move with minimal
 * field renames. The architecture §9.3 coupling rules forbid `persona` or
 * `roles` overrides in a presence block — those live on the parent agent.
 */
export const DiscordPresenceSchema = z.object({
  /** Whether this presence is active. Default: true. */
  enabled: z.boolean().default(true),
  token: z.string().min(1),
  guildId: z.coerce.string().min(1),
  agentChannelId: z.coerce.string().min(1),
  logChannelId: z.coerce.string().min(1),
  /** Channel id for worklog threads (G-200). If set, agent tasks get threaded updates. */
  worklogChannelId: z.coerce.string().optional(),
  contextDepth: z.number().int().positive().default(10),
  /** Post agent events to #agent-log. Default: false (opt-in). */
  enableAgentLog: z.boolean().default(false),
  /**
   * Platform-side role allowlists. Empty = all users get full access
   * (backward compat with grove-v2). Architecture §9.3: this restricts the
   * parent agent's `roles` to the subset that maps onto this platform's
   * users — it never widens.
   */
  roles: z.array(RoleSchema).default([]),
  /**
   * Role applied to users not listed in any role. Default `"allow-all"` is
   * preserved verbatim from grove-v2 to keep `migrate-config` (MIG-7.2e)
   * a pure-translation step. Cortex deployments that want secure-by-default
   * should set this to `"denied"` (or a named role) in their `cortex.yaml`.
   * Flipping the default value is a deliberate-behaviour-change decision
   * tracked as a follow-up — not part of the schema-flip PR.
   */
  defaultRole: z.string().default("allow-all"),
  /** G-300: DM privilege configuration. */
  dm: emptyDefault(DMConfigSchema),
  /**
   * F-11: Optional Discord role id to mention on `severity = 'ping'`
   * notifications. Unset → plain channel post with no mention.
   */
  operatorRoleId: z.coerce.string().optional(),
  /**
   * cortex#98 (part A) — operator-set Discord user ids of peer bots that
   * are permitted to trigger this presence. MIRROR of
   * `DiscordInstanceSchema.trustedBotIds` in `./config.ts`; the cortex.yaml
   * loader (`loadCortexShape` in `src/common/config/loader.ts`) threads
   * this through to the synthesized legacy `DiscordInstance.trustedBotIds`
   * verbatim so the messageCreate bot-author gate in
   * `src/adapters/discord/index.ts` honours it.
   *
   * The TrustResolver (cortex#76) populates the effective allowlist
   * automatically for in-process peers (cortex#98 part B); this field
   * stays as the **cross-process bridge** — peers running in a different
   * cortex process that the in-process resolver can never see (e.g. Ivy
   * in PAI's local cortex trusting Holly in a server cortex). The two
   * sources merge in `src/cortex.ts` before the adapter starts.
   *
   * Empty array (default) is fine when every trusted peer is in-process.
   * `z.coerce.string()` matches the surrounding fields' shape — operators
   * who paste Discord snowflakes as numbers get them coerced rather than
   * a schema error. Each entry is a Discord snowflake; the bot's own
   * user id is never allowed regardless of this list (anti-self-loop
   * guard in `DiscordAdapter` is unchanged).
   */
  trustedBotIds: z.array(z.coerce.string()).default([]),
});

export type DiscordPresence = z.infer<typeof DiscordPresenceSchema>;

/**
 * Mattermost presence — an agent's identity on a Mattermost server. Mirrors
 * grove-v2's `MattermostInstanceSchema` minus the operator/role-override fields
 * that move to the parent agent.
 */
export const MattermostPresenceSchema = z.object({
  /** Whether this presence is active. Default: true. */
  enabled: z.boolean().default(true),
  callbackPort: z.number().int().default(8080),
  triggerWord: z.string().optional(),
  webhookUrl: z.string().optional(),
  apiUrl: z.string().optional(),
  apiToken: z.string().optional(),
  webhookToken: z.string().optional(),
  /** Channel ids to poll. If empty, uses search API (public channels only). */
  channels: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().positive().default(3000),
  /** Mattermost user ids allowed to trigger the bot. Empty = allow all. */
  allowedUsers: z.array(z.string()).default([]),
  /** Platform-side role config (see DiscordPresenceSchema.roles). */
  roles: z.array(RoleSchema).default([]),
  defaultRole: z.string().default("allow-all"),
});

export type MattermostPresence = z.infer<typeof MattermostPresenceSchema>;

/**
 * An agent's presence map — keyed by platform. Architecture §9.1 puts
 * presence under the parent agent, not the other way around. Adding a new
 * platform (Slack, etc.) adds a new optional key here at the time the
 * adapter lands — no speculative placeholders.
 */
export const PresenceSchema = z.object({
  discord: DiscordPresenceSchema.optional(),
  mattermost: MattermostPresenceSchema.optional(),
});

export type Presence = z.infer<typeof PresenceSchema>;

// =============================================================================
// Agent — first-class principal in the cortex deployment
// =============================================================================

/**
 * An agent bundles identity + persona + capability set + platform credentials.
 * Architecture §9.1: agents are principals; platforms are servers; the agent's
 * credentials are how the agent shows up on a platform.
 *
 * Coupling rules from §9.3:
 *   - `trust` references other agents by their `id` (never by platform user id)
 *   - `persona` is a path to platform-neutral markdown
 *   - `roles` is the maximum capability set; presences may restrict, never widen
 */
/**
 * Optional `runtime` block on an agent — declares the substrate harness and
 * dispatch mode for arc-installable sub-bots (cortex#60 D4 + design-arc-agent-
 * bots.md §5). Optional in v1: inline agents in cortex.yaml may omit it
 * (cortex assumes claude-code/in-process as the default substrate). Fragments
 * dropped under `agents.d/` SHOULD declare it for dashboard provenance.
 */
export const AgentRuntimeSchema = z.object({
  /** Execution substrate. Claude Code is the in-cortex default; other
   *  substrates run as standalone arc-installed daemons. */
  substrate: z.enum(["claude-code", "codex", "pi-dev", "cursor", "custom"]),
  /** Dispatch mode. `in-process` = cortex's runner spawns the substrate;
   *  `standalone` = arc-installed daemon connects to the bus directly. */
  mode: z.enum(["in-process", "standalone"]),
  /** NATS capability names the agent claims (e.g. `code-review`,
   *  `research`). Cortex's dispatcher routes tasks via these.
   *  Empty list is allowed for `in-process` agents whose capabilities are
   *  declared elsewhere (e.g. inferred from `roles`); for `standalone`
   *  agents, at least one capability is required — see refine below. */
  capabilities: z.array(z.string().min(1)).default([]),
}).refine(
  // Echo M2 on cortex#62 — a `standalone` agent with zero capabilities parses
  // fine but routes zero work. The daemon connects to NATS, publishes nothing
  // to the capability KV, and just sits there. Worst-of-both failure mode:
  // operator sees the agent in the dashboard, dispatcher never gives it
  // anything to do. Catch it at config-load time.
  (rt) => rt.mode !== "standalone" || rt.capabilities.length >= 1,
  {
    message:
      "agent.runtime.capabilities must list at least one capability when " +
      "runtime.mode is 'standalone' (otherwise the daemon registers no NATS " +
      "subjects and silently fails to receive tasks)",
    path: ["capabilities"],
  },
);

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const AgentSchema = z.object({
  /** Logical agent id — stable across deployments. Lowercase, alphanumeric. */
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "Agent id must be lowercase alphanumeric"),
  /** Display name shown to humans. */
  displayName: z.string().min(1),
  /**
   * Path to the agent's persona markdown file. Resolved relative to the
   * cortex config file. Architecture §9.3: personas are platform-neutral
   * — no `<@id>` mentions baked in; the adapter translates at render time.
   */
  persona: z.string().min(1),
  /**
   * Cortex-wide capability set. Each role string maps to a capability bundle
   * (defined elsewhere). Architecture §9.3: this is the agent's **maximum**
   * capability set; presences may further restrict.
   */
  roles: z.array(z.string().min(1)).default([]),
  /**
   * Peer agents this agent trusts (by logical agent id). When an inbound
   * message arrives from a trusted agent's platform user, the receiving
   * adapter treats it as agent-originated (vs human-originated).
   *
   * Coupling rule (§9.3): values MUST be agent ids — never platform user ids.
   * Schema-level format check applies the same `^[a-z0-9-]+$` regex as
   * `AgentSchema.id` and `OperatorSchema.id` so a typo (e.g. accidentally
   * pasting a Discord user id like `"1497..."`) is caught at config load,
   * not silently when the registry fails to resolve the reference
   * (Holly W2 review).
   *
   * Validation that the referenced ids resolve to known agents happens at
   * load time in the agent registry (MIG-7.2a), not in this schema.
   */
  trust: z.array(
    z.string().regex(/^[a-z0-9-]+$/, "trust entries must be agent ids (lowercase alphanumeric)"),
  ).default([]),
  /** Per-platform presence blocks — at least one is required. */
  presence: PresenceSchema,
  /**
   * F-2 (cortex#60 §5) — substrate harness + dispatch mode. Optional in v1:
   * inline cortex.yaml agents may omit it (cortex assumes
   * claude-code/in-process). Fragments dropped under `agents.d/` SHOULD
   * declare it so the dashboard renders accurate substrate provenance.
   */
  runtime: AgentRuntimeSchema.optional(),
}).refine(
  (agent) => Object.values(agent.presence).some((p) => p !== undefined),
  { message: "agent must have at least one presence block", path: ["presence"] },
);

export type Agent = z.infer<typeof AgentSchema>;

// =============================================================================
// Renderers — non-agent-bound surfaces that subscribe and project
// =============================================================================

/**
 * Renderer kinds enumerated explicitly. Architecture §9.3: renderers never
 * publish on the bus; they're pure sinks. The enum constrains the choice set
 * to known platform classes (dashboard, pagerduty, cli-tail, webhook-out).
 *
 * The G-1111 §4.6 fail-safe rule requires ≥2 distinct platform classes
 * covering `local.{org}.system.>` — that check fires at config-load (MIG-1.10),
 * not in the Zod schema.
 */
export const RendererKindSchema = z.enum([
  "dashboard",
  "pagerduty",
  "cli-tail",
  "webhook-out",
]);

export type RendererKind = z.infer<typeof RendererKindSchema>;

// ---------------------------------------------------------------------------
// Renderer visibility — IAW Phase A.4 (cortex#113, cortex#109 §B)
// ---------------------------------------------------------------------------

/**
 * IAW Phase A.4 — per-renderer visibility constraints applied by the
 * surface-router BEFORE invoking `adapter.render(envelope)`. Mirrors the
 * three sovereignty axes myelin's envelope schema carries
 * (`sovereignty.classification`, `sovereignty.data_residency`,
 * `sovereignty.model_class`).
 *
 * **All fields are optional.** An unset field means "no constraint on this
 * axis" — the renderer accepts any value the envelope happens to carry. This
 * keeps the schema additive: renderers without a `visibility:` block behave
 * exactly as they did pre-A.4 (no filtering).
 *
 * Rules (only applied when the corresponding field is set):
 *   - `hide_residency_outside: [iso, ...]`
 *       Drop the envelope when `envelope.sovereignty.data_residency` is
 *       defined AND not in the list. Envelopes with no `data_residency`
 *       (always present per schema today) are not dropped — the schema
 *       requires the field, so this is mostly defensive.
 *   - `require_model_class: [class, ...]`
 *       Drop when `envelope.sovereignty.model_class` is defined AND not in
 *       the list.
 *   - `max_classification: <tier>`
 *       Cap the maximum classification this surface renders. Ordering is
 *       `local < federated < public` per myelin's reach taxonomy:
 *         - `"local"`     → only `local.*` envelopes render
 *         - `"federated"` → `local.*` + `federated.*` render; `public.*` drops
 *         - `"public"`    → all classifications render (no cap)
 *       If unset, no cap is applied (equivalent to `"public"`).
 *
 * Composition: when multiple fields are set, they compose with AND semantics
 * — the envelope must satisfy every active constraint to render.
 *
 * Drop side-effect: the surface-router emits a `system.access.filtered`
 * envelope per drop (carrying `renderer_id`, `envelope_subject`, `reason`)
 * so operators can subscribe to access-decision events for audit/debug.
 *
 * Cortex#109 §B references this as the consumer of myelin's existing
 * sovereignty taxonomy — the schema lifts the values directly, no new enum.
 */
export const RendererVisibilitySchema = z.object({
  /**
   * ISO-3166-1 alpha-2 country codes the surface accepts. When set,
   * envelopes carrying a `sovereignty.data_residency` outside this list are
   * dropped before render. Format-enforced so a typo at config time fails
   * fast rather than silently dropping every envelope.
   */
  hide_residency_outside: z.array(
    z.string().regex(
      /^[A-Z]{2}$/,
      "residency entries must be 2-letter ISO-3166-1 alpha-2 country codes",
    ),
  ).optional(),
  /**
   * Model-class allowlist. When set, envelopes whose
   * `sovereignty.model_class` is outside this list are dropped. Values match
   * myelin's `model_class` enum verbatim (`local-only` / `frontier` / `any`)
   * so a typo fails at config load.
   */
  require_model_class: z.array(
    z.enum(["local-only", "frontier", "any"]),
  ).optional(),
  /**
   * Maximum classification tier this surface will render. Caps reach using
   * myelin's three-tier ordering (`local < federated < public`). Unset =
   * no cap.
   */
  max_classification: z.enum(["local", "federated", "public"]).optional(),
});

export type RendererVisibility = z.infer<typeof RendererVisibilitySchema>;

/**
 * Dashboard renderer — the Mission Control v3 surface. Subscribes to a slice
 * of the bus and projects into Kanban/inbox/status-banner views. Per
 * architecture §9.2: dashboards are activity-centric, not agent-centric.
 */
export const DashboardRendererSchema = z.object({
  kind: z.literal("dashboard"),
  port: z.number().int().positive().default(8767),
  publicUrl: z.url().optional(),
  subscribe: z.array(z.string().min(1)).default(["local.{org}.>"]),
  /**
   * Optional projection rules. Each entry maps an event source pattern to
   * a dashboard projection (kanban-card, inbox-row, status-banner, etc.).
   * Free-form here; the dashboard renderer interprets at runtime.
   */
  projections: z.array(z.object({
    source: z.string().min(1),
    into: z.string().min(1),
    column: z.string().optional(),
  })).default([]),
  /**
   * IAW Phase A.4 — optional visibility guardrails (cortex#113 §A.4,
   * cortex#109 §B). Unset = no filtering applied; preserves pre-A.4 behaviour.
   * See {@link RendererVisibilitySchema} for the rule semantics.
   */
  visibility: RendererVisibilitySchema.optional(),
});

export type DashboardRendererConfig = z.infer<typeof DashboardRendererSchema>;

/**
 * PagerDuty renderer — operational events out per G-1111 §4.6. Subscribes to
 * `system.adapter.degraded`, `system.process.crashed`, etc., and routes them
 * to PagerDuty via the events-v2 API.
 */
export const PagerDutyRendererSchema = z.object({
  kind: z.literal("pagerduty"),
  /** Integration / routing key for PagerDuty events-v2. */
  routingKey: z.string().min(1),
  /** Subject patterns to subscribe to. Operator chooses what counts as page-worthy. */
  subscribe: z.array(z.string().min(1)).default([]),
  /**
   * IAW Phase A.4 — optional visibility guardrails. See
   * {@link RendererVisibilitySchema}.
   */
  visibility: RendererVisibilitySchema.optional(),
});

export type PagerDutyRendererConfig = z.infer<typeof PagerDutyRendererSchema>;

/**
 * CLI-tail renderer — local stdout follower. Developer tool; subscribes to the
 * bus and pretty-prints envelopes to stdout.
 */
export const CliTailRendererSchema = z.object({
  kind: z.literal("cli-tail"),
  subscribe: z.array(z.string().min(1)).default(["local.{org}.>"]),
  /**
   * IAW Phase A.4 — optional visibility guardrails. See
   * {@link RendererVisibilitySchema}.
   */
  visibility: RendererVisibilitySchema.optional(),
});

export type CliTailRendererConfig = z.infer<typeof CliTailRendererSchema>;

/**
 * Webhook-out renderer — generic outbound HTTP POST. Subscribes to a slice of
 * the bus and forwards envelopes as JSON to an external URL.
 */
export const WebhookOutRendererSchema = z.object({
  kind: z.literal("webhook-out"),
  url: z.url(),
  subscribe: z.array(z.string().min(1)).default([]),
  /** Optional auth header (e.g. `Bearer <token>`). */
  authHeader: z.string().optional(),
  /**
   * IAW Phase A.4 — optional visibility guardrails. See
   * {@link RendererVisibilitySchema}.
   */
  visibility: RendererVisibilitySchema.optional(),
});

export type WebhookOutRendererConfig = z.infer<typeof WebhookOutRendererSchema>;

/**
 * Discriminated union over renderer kinds. Each variant carries `kind` as a
 * literal so callers can switch on it.
 */
export const RendererSchema = z.discriminatedUnion("kind", [
  DashboardRendererSchema,
  PagerDutyRendererSchema,
  CliTailRendererSchema,
  WebhookOutRendererSchema,
]);

/**
 * MIG-7.2d: renamed from `Renderer` → `RendererConfig` so the unprefixed
 * `Renderer` name can refer to the runtime class hierarchy in
 * `src/renderers/`. The schema-inferred type represents the CONFIG block
 * for a renderer, not the renderer instance itself, so the new name is
 * more accurate as well.
 */
export type RendererConfig = z.infer<typeof RendererSchema>;

// =============================================================================
// NATS — bus runtime config
// =============================================================================

/**
 * NATS identity — the agent-level signing material used for envelope identity
 * stamps (per JC's E2E NATS work, myelin MY-400). Optional in v0.1 cortex;
 * required once chain-of-stamps signing (myelin#31) lands.
 *
 * The `seed` and `publicKey` are NKeys (ed25519) provisioned externally and
 * referenced by file path. Cortex never reads the seed material directly into
 * config — it's loaded by NatsLink at connect time.
 */
export const NatsIdentitySchema = z.object({
  /** Path to the NKey seed file (.nk). */
  seedPath: z.string().min(1),
  /**
   * NKey user-identifier public key. NATS NKey user keys are exactly 56
   * characters: a `U` prefix byte plus 55 base32-encoded payload bytes
   * (RFC-4648 alphabet, no padding). Anything shorter is a typo or a
   * placeholder — fail at config load.
   *
   * Reference: `nkeys` package — `Codec.encode(NKeysPrefixByte.User, …)`.
   */
  publicKey: z.string().regex(
    /^U[A-Z2-7]{55}$/,
    "publicKey must be a 56-char NKey user identifier (U + 55 base32 chars)",
  ),
});

export type NatsIdentity = z.infer<typeof NatsIdentitySchema>;

/**
 * NATS / myelin subscriber configuration. Mirrors `BotConfig.nats` shape from
 * grove-v2 plus the new `identity` block.
 */
export const NatsConfigSchema = z.object({
  url: z.string().min(1).refine(
    (s) => s.startsWith("nats://") || s.startsWith("tls://"),
    { message: "nats.url must start with nats:// or tls://" },
  ),
  /** Bearer token for connect-time auth. Optional; deprecated in favour of `identity`. */
  token: z.string().optional(),
  /** Connection name surfaced on the server's varz endpoint. */
  name: z.string().default("cortex"),
  /**
   * Subject patterns to subscribe to. Default empty. `{org}` is substituted
   * with `operator.id` at runtime.
   */
  subjects: z.array(z.string().min(1)).default([]),
  /** Optional NKey identity for envelope signing (MY-400). */
  identity: NatsIdentitySchema.optional(),
  /**
   * cortex#86 — path to a NATS user `.creds` file for operator-mode connect
   * auth. When set, the daemon authenticates via `credsAuthenticator(...)`
   * instead of anonymous / bearer-token. Leading `~/` expands to `$HOME`;
   * the `NatsLink` loader enforces chmod 600 on POSIX. Wins over `token`
   * when both are set (warn log explains precedence).
   *
   * MIRROR: `BotConfigSchema.nats.credsPath` in `./config.ts`. Drop both
   * on MIG-7.2e alongside `identity` and `accountSigningKeyPath`.
   */
  credsPath: z.string().optional(),
  /**
   * Absolute path to operator account signing nkey file. Loaded into daemon
   * memory only. File MUST be chmod 600 (loader enforces). Optional — when
   * absent, cortex creds mutation subcommands return exit 2.
   *
   * The account signing key is what mints per-agent NATS user JWTs (C-067,
   * cortex#58 D7 + §6.3). It is the most sensitive key material cortex
   * holds; it must never be logged, persisted to disk by cortex, or shipped
   * to any renderer. See `src/common/config/account-signing-key.ts` for the
   * loader that enforces chmod 600 and SA-prefix.
   *
   * MIRROR: `BotConfigSchema.nats.accountSigningKeyPath` in `./config.ts`.
   * Drop both on MIG-7.2e.
   */
  accountSigningKeyPath: z.string().optional(),
});

export type NatsConfig = z.infer<typeof NatsConfigSchema>;

// =============================================================================
// Cross-cutting infra blocks — carried forward in same shape as BotConfig
// =============================================================================
//
// MIRROR NOTE: during the MIG-7.2 overlap window, these schemas live in two
// places: here as standalone exports, and inline inside `BotConfigSchema`
// in `./config.ts`. Field additions/changes MUST be applied to BOTH until
// MIG-7.2e retires BotConfig. Each block below carries a `MIRROR:` breadcrumb
// pointing at the corresponding section in config.ts so a grep for `MIRROR:`
// surfaces every overlap site.
//
// Removed at MIG-7.2e together with the inline copies. (Holly review.)

/**
 * Claude runtime config — passed to spawned CC sessions. Identical shape to
 * grove-v2's `BotConfig.claude` block; not refactored at MIG-7.2 because the
 * shape is already correct (no agent-bound coupling to break).
 *
 * MIRROR: see `BotConfigSchema.claude` in `./config.ts`. Drop both on 7.2e.
 */
export const ClaudeConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(120_000),
  asyncTimeoutMs: z.number().int().positive().default(900_000),
  additionalArgs: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  bashAllowlist: z.object({
    rules: z.array(z.object({
      pattern: z.string(),
      repos: z.array(z.string()).optional(),
    })).default([]),
    repos: z.array(z.string()).default([]),
  }).optional(),
  allowedDirs: z.array(z.string()).default([]),
  readOnlyDirs: z.array(z.string()).default([]),
});

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

/**
 * Attachments config — identical shape to BotConfig.attachments.
 * MIRROR: see `BotConfigSchema.attachments` in `./config.ts`. Drop both on 7.2e.
 */
export const AttachmentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFileSizeBytes: z.number().int().positive().default(10 * 1024 * 1024),
  maxTotalSizeBytes: z.number().int().positive().default(25 * 1024 * 1024),
  maxAttachmentsPerMessage: z.number().int().positive().default(10),
});

export type AttachmentsConfig = z.infer<typeof AttachmentsConfigSchema>;

/**
 * Execution backends — identical shape to BotConfig.execution.
 * MIRROR: see `BotConfigSchema.execution` in `./config.ts`. Drop both on 7.2e.
 */
export const ExecutionConfigSchema = z.object({
  default: z.string().default("local"),
  backends: z.array(z.object({
    name: z.string(),
    type: z.enum(["cloudflare", "e2b", "ssh", "custom"]),
    endpoint: z.string(),
  })).default([]),
});

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

/**
 * GitHub agent-detection heuristics — extracted from `GithubConfigSchema` so
 * it can use `emptyDefault` cleanly when nested. Identical defaults to grove-v2.
 *
 * MIRROR: see `BotConfigSchema.github.agentDetection` (inline) in `./config.ts`.
 * Drop both on 7.2e.
 */
export const AgentDetectionSchema = z.object({
  commitTrailers: z.array(z.string()).default(["Co-Authored-By: Claude"]),
  branchPatterns: z.array(z.string()).default(["^feat/(g|f|i)-\\d+"]),
  commentPatterns: z.array(z.string()).default(["^Starting:", "^Completed:"]),
});

export type AgentDetection = z.infer<typeof AgentDetectionSchema>;

/**
 * MIG-5.6 (C-106): local GitHub-webhook receiver — extracted so it can
 * nest cleanly under `GithubConfigSchema` and stay MIRRORed with the
 * inline shape in `BotConfigSchema.github.receiver`. Defaults are
 * opt-in: `enabled=false`, `127.0.0.1:8770`.
 *
 * MIRROR: see `BotConfigSchema.github.receiver` (inline) in `./config.ts`.
 * Drop both on 7.2e.
 */
export const GithubReceiverSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(8770),
  hostname: z.string().default("127.0.0.1"),
});

export type GithubReceiver = z.infer<typeof GithubReceiverSchema>;

/**
 * GitHub webhook surface — identical shape to BotConfig.github.
 * MIRROR: see `BotConfigSchema.github` in `./config.ts`. Drop both on 7.2e.
 */
export const GithubConfigSchema = z.object({
  webhookSecret: z.string().default(""),
  repos: z.array(z.string()).default([]),
  agentDetection: emptyDefault(AgentDetectionSchema),
  receiver: emptyDefault(GithubReceiverSchema),
});

export type GithubConfig = z.infer<typeof GithubConfigSchema>;

/**
 * Filesystem paths — identical shape to BotConfig.paths but cortex-named
 * (default logDir `~/.config/cortex/logs` vs grove-v2's `~/.config/grove/logs`).
 * MIRROR: see `BotConfigSchema.paths` in `./config.ts`. Drop both on 7.2e.
 */
export const PathsConfigSchema = z.object({
  publishedEventsDir: z.string().default("~/.claude/events/published"),
  logDir: z.string().default("~/.config/cortex/logs"),
});

export type PathsConfig = z.infer<typeof PathsConfigSchema>;

// =============================================================================
// CortexConfig — the top-level schema
// =============================================================================

/**
 * The cortex deployment configuration. One file per operator
 * (`~/.config/cortex/cortex.yaml`). Loaded at startup; hot-reloaded by
 * `config-watcher.ts` for fields that don't require a restart.
 *
 * Architecture §9 compliance: there is exactly ONE singular block (`operator:`),
 * and the agent list is the canonical source. Renderers are top-level peers,
 * not properties of any agent. No `agent:` (singular) — that's the legacy
 * grove-v2 shape and is replaced by the agents[] array.
 */
export const CortexConfigSchema = z.object({
  /** Who is running this cortex instance. */
  operator: OperatorSchema,
  /**
   * IAW Phase A.5 (refs cortex#113) — optional stack identity. When set,
   * declares `{operator_id}/{stack_id}` for the deployment and the
   * stack-level NKey public key. Unset → `deriveStackId` default-derives
   * `${operator.id}/default` preserving today's identity. The schema
   * lives in `./stack.ts` next to the `deriveStackId` resolver; importing
   * the schema here keeps the cortex.yaml top-level surface contained in
   * one file.
   *
   * Behaviour today: the block parses, the resolver reads it, the boot
   * path logs the derived id. Emit subjects do NOT yet consume the stack
   * segment — that's A.5.5, blocked on myelin#113's namespace extension.
   * Wiring the schema in ahead of the namespace cutover lets operators
   * declare `stack:` in cortex.yaml without breaking their deployment
   * before A.5.5 lands.
   */
  stack: StackConfigSchema.optional(),
  /**
   * Anti-field: the legacy grove-v2 `agent:` (singular) block must not be
   * present in a cortex.yaml. Caught here with an explicit Zod refusal so
   * the operator sees a clear migration error rather than the field being
   * silently stripped by Zod's default unknown-key-strip behaviour. Holly
   * W2 flagged the strip path as a real migration safety gap — operators
   * who hand-edit a partially-translated config get no feedback otherwise.
   *
   * The schema-level error here complements `migrate-config` (MIG-7.2e):
   * the converter produces a cortex.yaml *without* `agent:`; this guard
   * catches the case where an operator pastes a legacy block into a new
   * file or fails to remove it during a hand migration.
   */
  agent: z.never({
    error: () =>
      "legacy `agent:` (singular) field is not supported by CortexConfig — " +
      "use `operator:` + `agents:[]` per architecture §9.1. " +
      "Run `cortex migrate-config <bot.yaml>` (MIG-7.2e) to convert.",
  }).optional(),
  /**
   * Anti-field: the legacy `trustedAgentBots:` block is replaced by the
   * agent-id-keyed `trust:` arrays on each agent (architecture §9.3).
   * Same migration-safety rationale as the `agent:` anti-field above.
   */
  trustedAgentBots: z.never({
    error: () =>
      "legacy `trustedAgentBots:` is not supported — express peer trust via " +
      "`agents[].trust: [<agent-id>, ...]` on each agent (architecture §9.3).",
  }).optional(),

  /** First-class agents — the canonical list. */
  agents: z.array(AgentSchema).min(1, "at least one agent is required"),

  /**
   * Anti-field: top-level `discord:` arrays are the grove-v2 shape where
   * platform credentials sit as siblings of `agent:`. In cortex they live
   * under `agents[].presence.discord` (architecture §9.1). A typical
   * hand-migration miss is to lift `agents:` into the new file but leave
   * the legacy `discord:[...]` block alongside it — Zod would silently
   * strip it, producing agents with no presence and a confusing
   * "at least one presence block" failure rather than a pointer at the
   * actual mistake. This guard surfaces the migration error at the
   * source (Holly W3 review).
   */
  discord: z.never({
    error: () =>
      "legacy top-level `discord:` is not supported by CortexConfig — " +
      "move per-instance credentials to `agents[<id>].presence.discord` " +
      "(architecture §9.1). Run `cortex migrate-config <bot.yaml>` (MIG-7.2e) to convert.",
  }).optional(),
  /**
   * Anti-field: same migration-safety rationale as `discord:` above.
   * Legacy `mattermost:[...]` arrays move under `agents[].presence.mattermost`.
   */
  mattermost: z.never({
    error: () =>
      "legacy top-level `mattermost:` is not supported by CortexConfig — " +
      "move per-instance credentials to `agents[<id>].presence.mattermost` " +
      "(architecture §9.1). Run `cortex migrate-config <bot.yaml>` (MIG-7.2e) to convert.",
  }).optional(),

  /** Non-agent-bound surfaces. Optional in v0.1; MIG-1.10 enforces fail-safe rule at load. */
  renderers: z.array(RendererSchema).default([]),

  /** Claude runtime config — shared by all agents' dispatch sessions. */
  claude: ClaudeConfigSchema,

  /** Attachment handling — shared by all platform presences. */
  attachments: emptyDefault(AttachmentsConfigSchema),

  /** Execution backends — local default, plus optional remotes. */
  execution: emptyDefault(ExecutionConfigSchema),

  /** GitHub webhook ingestion (the taps side). */
  github: emptyDefault(GithubConfigSchema),

  /** Filesystem paths used by the runner + taps. */
  paths: emptyDefault(PathsConfigSchema),

  /** Directory containing per-network YAML files (G-500). */
  networksDir: z.string().default("./networks"),

  /** Loaded network configurations (populated by config-loader). */
  networks: z.array(NetworkFileSchema).default([]),

  /** NATS / myelin subscriber configuration. Optional — bot stays installable without NATS. */
  nats: NatsConfigSchema.optional(),
}).refine(
  (config) => {
    const ids = config.agents.map((a) => a.id);
    return new Set(ids).size === ids.length;
  },
  { message: "agent ids must be unique", path: ["agents"] },
);

export type CortexConfig = z.infer<typeof CortexConfigSchema>;

// =============================================================================
// Public-API re-exports — preserve existing import paths for shared types
// =============================================================================

export {
  DMConfigSchema,
  NetworkClaudeSchema,
  NetworkCloudSchema,
  NetworkFileSchema,
  RoleSchema,
};

/**
 * IAW Phase A.5 re-exports — the stack identity primitive ships in its own
 * module (`./stack.ts`) for tighter ownership, but downstream code that
 * already pulls `CortexConfigSchema` from this file shouldn't need a second
 * import path. Mirror the `DMConfigSchema` / `NetworkClaudeSchema` re-export
 * pattern above.
 */
export { StackConfigSchema, deriveStackId } from "./stack";
export type { StackConfig, DerivedStackId, DeriveStackIdInput } from "./stack";
