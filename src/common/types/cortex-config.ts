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
 *   - presence blocks carry only credentials, not assistant-prompt or role overrides
 *   - the assistant prompt is platform-neutral (just a markdown file path)
 *   - renderers never publish on the bus (kind enum constrains the choice set)
 */

import { z } from "zod/v4";

import { CapabilitySchema } from "./capability";
import {
  NetworkClaudeSchema,
  NetworkCloudSchema,
  NetworkFileSchema,
} from "./config";
import { NKEY_PUBKEY_REGEX } from "./nkey";
import { LETTER_PREFIX_ID_REGEX } from "./id";
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
// Principal — who is running this cortex instance
// =============================================================================

/**
 * The principal is the human (or team) running this cortex deployment. Replaces
 * grove-v2's `agent.operatorId` + `agent.operatorDiscordId` + `agent.operatorMattermostId`
 * fields by lifting them out of the (now removed) singular `agent:` block.
 *
 * R1 vocabulary migration (cortex#388) — `principal:` is the canonical
 * key in `cortex.yaml`. The transition-release `operator:` block alias
 * was removed at v3.0.0 (manifest PR-11); operators upgrading from
 * cortex v2.x run `cortex migrate-config` to rewrite their cortex.yaml
 * before installing v3.
 */
export const PrincipalConfigSchema = z.object({
  /**
   * Principal identifier — used as the `{principal}` subject segment on the
   * bus (`local.{principal}.…`). Must be safe to embed verbatim in NATS
   * subjects.
   *
   * Grammar: lowercase alphanumeric + hyphen, **first character must be a
   * letter**. The letter-prefix rule mirrors `StackConfigSchema.id` segments
   * (cortex#141): NATS subject segments starting with a digit interact poorly
   * with downstream pattern-matchers that treat segments as numeric literals.
   * Letter-prefix is the safe boundary.
   *
   * Closing cortex#141 — the round-trip invariant `PrincipalConfigSchema.id →
   * deriveStackId → StackConfigSchema.id` now holds for every value the
   * upstream gate accepts. Migration hint for a principal hitting this rule:
   * rename `2andreas` → `team2andreas` or `andreas-2026` (prepend / wrap the
   * digits with a letter-prefixed token).
   */
  id: z.string().min(1).regex(
    LETTER_PREFIX_ID_REGEX,
    "principal id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'andreas', 'team-research'); rename digit-prefixed ids like '2andreas' to 'team2andreas' or 'andreas-2026'",
  ),
  /** Display name shown on the dashboard. Defaults to `id`. */
  displayName: z.string().optional(),
  /** Principal's Discord user id — receives DM notifications from agents. */
  discordId: z.string().optional(),
  /** Principal's Mattermost user id — same purpose, Mattermost-side. */
  mattermostId: z.string().optional(),
  /** Principal's Slack user id (`U...`) — same purpose, Slack-side. */
  slackId: z.string().optional(),
  /**
   * Data residency stamped into `sovereignty.data_residency` on emitted
   * envelopes. ISO-3166-1 alpha-2 country code (two uppercase ASCII letters).
   * Defaults to "NZ" when omitted. Principals in AU/EU/US/etc. set this to
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

export type PrincipalConfig = z.infer<typeof PrincipalConfigSchema>;

// R1 vocabulary migration (cortex#388) v3.0.0 BREAKING — the
// `OperatorSchema` / `Operator` deprecated aliases were removed at
// v3.0.0 (manifest PR-11). External importers update to
// `PrincipalConfigSchema` / `PrincipalConfig`.

// =============================================================================
// Agent presence — one block per platform an agent shows up on
// =============================================================================

/**
 * Discord presence — an agent's identity on a Discord guild. The full grove-v2
 * `DiscordInstanceSchema` carries channel ids, role config, DM rules, etc.;
 * we keep them here in the same shape so adapter code can move with minimal
 * field renames. The architecture §9.3 coupling rules forbid overriding the
 * parent agent's assistant or roles in a presence block — those live on the
 * parent agent.
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
   * v2.0.0 cutover (cortex#297) — `roles[]`, `defaultRole`, and `dm` retired.
   * Per-adapter authorisation now flows through the top-level `policy:` block
   * (`PolicyPrincipalSchema` / `PolicyRoleSchema`). Operators upgrading from
   * <v2.0.0 MUST run `bun src/cli/cortex/commands/migrate-config.ts` first.
   * See `docs/design-policy-cutover.md` §16.
   */
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
  /**
   * MIG-3b / cortex#205: NATS subject patterns this Discord adapter renders
   * to chat. Threaded into `DiscordAdapterInfra.surfaceSubjects` at
   * construction time and registered with the surface-router as the
   * adapter's match set. Empty/undefined → the adapter never matches any
   * envelope and `DiscordAdapter` logs a one-shot warning at startup (the
   * v0 behaviour preserved for back-compat with operators on legacy
   * configs).
   *
   * Common values:
   *   - `local.{principal}.tasks.code-review.>` — pilot review-requests (IoAW
   *     Offer grammar per myelin/specs/namespace.md §Tasks Domain;
   *     renamed from Broadcast — vocabulary migration 2026-05, R11).
   *   - `local.{principal}.code.pr.review.>`    — sage review outcomes.
   *
   * Moves to per-renderer config at MIG-7.2d; for v1 the whole-adapter
   * subscription list is enough to unblock the bus→Discord render path.
   */
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  /**
   * MIG-3b / cortex#207: Discord channel id where `renderEnvelope` posts
   * inbound bus envelopes that don't carry their own channel routing.
   * Threaded into `DiscordAdapterInfra.surfaceFallbackChannelId` at
   * construction.
   *
   * Unset (default) → the adapter receives matching envelopes (per
   * `surfaceSubjects`) but drops each one with a one-shot warning
   * (`discord-{instanceId}: has no surfaceFallbackChannelId configured
   * — dropping envelope ...`). This is the v0 behaviour preserved for
   * configs that subscribe-without-render (e.g. observability-only
   * deployments that log envelope receipts but don't post to chat).
   *
   * Operators typically set this to `agentChannelId` so review-requests
   * and similar bus events land in the agent's primary channel.
   * Future per-event-type routing (MIG-7.2d Renderer model) will
   * override on a per-envelope basis; this remains the fallback when
   * no per-event rule matches.
   */
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type DiscordPresence = z.infer<typeof DiscordPresenceSchema>;

/**
 * Mattermost presence — an agent's identity on a Mattermost server. Mirrors
 * grove-v2's `MattermostInstanceSchema` minus the operator/role-override fields
 * that move to the parent agent.
 */
// TODO(cortex#205-followup): add `surfaceSubjects` mirror —
// `MattermostAdapter` already accepts it in its infra type
// (`src/adapters/mattermost/index.ts:57`), so today the bus→chat render
// path is operator-configurable via cortex.yaml for Discord but silently
// unreachable for Mattermost.
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
  /**
   * v2.0.0 cutover (cortex#297) — `roles[]` + `defaultRole` retired.
   * Authorisation flows through `policy.principals[]` / `policy.roles[]`.
   */
});

export type MattermostPresence = z.infer<typeof MattermostPresenceSchema>;

/**
 * Slack presence — an agent's identity in a Slack workspace. Mirrors the
 * Discord/Mattermost presence shape: tokens + workspace id + channels +
 * trusted user/bot ids + platform-side role allowlists.
 *
 * Transport choice: Socket Mode (`xapp-` app-level token paired with the
 * `xoxb-` bot token). Socket Mode keeps cortex behind NAT without needing a
 * public webhook URL — the same fit as Mattermost's outgoing-webhook
 * polling model and unlike Discord's gateway-with-public-bot path. HTTP /
 * Events API mode is deferred until a deployment actually needs it.
 *
 * Architecture §9.3 coupling rules: no overrides of the parent agent's
 * assistant or roles at this layer — those live on the parent agent.
 * `roles` here is the
 * platform-side allowlist that maps the agent's cortex-wide capability
 * set onto Slack user ids.
 */
export const SlackPresenceSchema = z.object({
  /** Whether this presence is active. Default: true. */
  enabled: z.boolean().default(true),
  /**
   * Bot user OAuth token (`xoxb-...`). Required. Used by the Web API
   * client for `chat.postMessage`, `conversations.replies`, etc.
   */
  botToken: z.string().regex(
    /^xoxb-/,
    "slack.botToken must be a bot user OAuth token (xoxb-...)",
  ),
  /**
   * App-level token (`xapp-...`) with `connections:write`. Required for
   * Socket Mode — the adapter opens a WebSocket connection to Slack using
   * this token. Distinct from `botToken`: `xoxb-` posts as the bot,
   * `xapp-` opens the events stream.
   */
  appToken: z.string().regex(
    /^xapp-/,
    "slack.appToken must be an app-level token (xapp-...)",
  ),
  /**
   * Slack workspace (team) id, `T...`. Stamped into the inbound message's
   * `guildId` field so network resolution and trust paths can disambiguate
   * across workspaces the same way they do across Discord guilds.
   */
  workspaceId: z.coerce.string().regex(
    // cortex#235 r1#6 — bound the regex. Real Slack team ids are
    // 9-11 chars (T + 8-10 base32-ish). 16 gives Slack headroom for
    // future expansion without admitting unbounded operator-pasted
    // garbage that would bloat downstream subject strings.
    /^T[A-Z0-9]{8,16}$/,
    "slack.workspaceId must be a Slack team id (T... with 8-16 trailing chars)",
  ),
  /**
   * Channels the adapter listens on / posts to. `id` is the canonical
   * `C...` channel id used by Slack APIs; `name` is the human-readable
   * label (no leading `#`) carried into `InboundMessage.channelName` for
   * routing.
   */
  channels: z.array(z.object({
    id: z.string().regex(
      // cortex#235 r1#6 — same upper-bound logic as workspaceId.
      // Real Slack channel/group ids are 11 chars; 16 leaves headroom.
      /^[CG][A-Z0-9]{8,16}$/,
      "slack channel id must be a Slack channel/group id (C... or G... with 8-16 trailing chars)",
    ),
    name: z.string().min(1),
  })).default([]),
  /**
   * Slack user ids (`U...`) allowed to trigger the bot. Empty = allow all
   * (subject to the platform-side `roles` allowlist below). Mirrors
   * `MattermostPresenceSchema.allowedUsers`.
   */
  allowedUserIds: z.array(z.string()).default([]),
  /**
   * Operator-set Slack **bot ids** (`B…`) of peer bots permitted to
   * trigger this presence. Mirrors `DiscordPresenceSchema.trustedBotIds`
   * — same cross-process bridge semantics.
   *
   * Echo cortex#233 round-2 N2: this field used to say "user ids (`U…`)"
   * but Slack delivers peer-bot messages as the `bot_message` subtype
   * with author identified by `event.bot_id` (`B…`), NOT `event.user`.
   * Operators populating `U…` values would silently never see their
   * trust take effect. Always use the `B…` value Slack reports for
   * the peer bot — visible in the peer bot's `auth.test.bot_id`, or
   * on the peer's app manifest under "Bot User".
   *
   * The bot's own ids (`auth.test.user_id` AND `auth.test.bot_id`)
   * are never allowed regardless of this list (anti-self-loop guard
   * in `SlackAdapter`).
   */
  trustedBotIds: z.array(z.coerce.string()).default([]),
  /**
   * v2.0.0 cutover (cortex#297) — `roles[]` + `defaultRole` retired.
   * Authorisation flows through `policy.principals[]` / `policy.roles[]`.
   */
  /**
   * MIG-3b mirror: NATS subject patterns this Slack adapter renders to
   * chat. Empty/undefined → adapter never matches in the surface-router.
   * See `DiscordPresenceSchema.surfaceSubjects` for the canonical
   * docstring and IoAW examples.
   */
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  /**
   * MIG-3b mirror: Slack channel id where `renderEnvelope` posts
   * inbound bus envelopes that don't carry their own channel routing.
   * Unset → drop-with-warning per the Discord/Mattermost pattern.
   */
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type SlackPresence = z.infer<typeof SlackPresenceSchema>;

/**
 * An agent's presence map — keyed by platform. Architecture §9.1 puts
 * presence under the parent agent, not the other way around. Adding a new
 * platform (Slack, etc.) adds a new optional key here at the time the
 * adapter lands — no speculative placeholders.
 *
 * **Empty presence (`presence: {}`) is valid** (cortex#245). A
 * headless agent has no human-facing surface — it runs CC sessions
 * via the dispatch-listener, emits envelopes onto the bus, and
 * surfaces on the dashboard. Useful for the multi-stack pattern
 * (cortex#244) where the second stack is bus-only until its
 * platform presence is wired in.
 */
export const PresenceSchema = z.object({
  discord: DiscordPresenceSchema.optional(),
  mattermost: MattermostPresenceSchema.optional(),
  slack: SlackPresenceSchema.optional(),
});

export type Presence = z.infer<typeof PresenceSchema>;

// =============================================================================
// Agent — first-class principal in the cortex deployment
// =============================================================================

/**
 * An agent bundles identity + assistant + capability set + platform credentials.
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
  /**
   * cortex#237 PR-4 — per-agent sovereignty mode declaration. One of the
   * four modes from `docs/architecture.md` §7.4:
   *
   *   - `open`      — auto-ack all matching tasks (no per-envelope evaluation).
   *   - `selective` — agent evaluates each envelope's sovereignty axes
   *                   (`classification`, `data_residency`, `model_class`) and
   *                   may nak with `wont_do` per design §7.2.
   *   - `strict`    — explicit capability + sovereignty match required;
   *                   any mismatch on any axis naks.
   *   - `bidding`   — triggers a request/reply (M6 pattern) for selection
   *                   optimisation. Reserved for future bidding rollout.
   *
   * **Optional.** When unset the runtime consumer (PR-6) applies a
   * deployment-wide default — schema does not pick a default here so an
   * absent value remains observable downstream. Existing cortex.yaml
   * configs that pre-date this field continue to parse unchanged.
   *
   * Enum lifted verbatim from myelin's `sovereignty_required` (vendor
   * `envelope.schema.json:159` — F-021 + F-10 bidding) so the agent-side
   * declaration and the envelope-side requirement share one taxonomy.
   * Runtime consumption is PR-5/PR-6's concern; this PR is schema-only.
   */
  sovereignty: z.enum(["open", "selective", "strict", "bidding"]).optional(),
  /**
   * cortex#237 PR-4 — upper bound on the number of concurrent dispatched
   * tasks this agent will admit. When the in-flight count reaches this
   * value the consumer (PR-6) emits `dispatch.task.failed` with
   * `reason.kind = "not_now"` and naks the JetStream message per design
   * §7.3 (backpressure). The retry_after_ms hint is consumer-side
   * derived — this schema only carries the bound itself.
   *
   * **Optional.** Treated as "unbounded" by downstream consumers when
   * absent. A value of `0` is rejected (zero would mean "never accept
   * any work", which is more clearly expressed by omitting the agent
   * from the capability catalog entirely). Non-integer and negative
   * values are rejected at parse time so a typo (`maxConcurrent: 1.5`,
   * `maxConcurrent: -1`) surfaces immediately at config load rather
   * than as a runtime error on first dispatch.
   *
   * Runtime consumption is PR-5/PR-6's concern; this PR is schema-only.
   */
  maxConcurrent: z
    .number()
    .int("agent.runtime.maxConcurrent must be an integer (got a fractional number)")
    .positive("agent.runtime.maxConcurrent must be a positive integer (omit the field for unbounded concurrency)")
    .optional(),
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
  /**
   * Logical agent id — stable across deployments.
   *
   * Grammar: lowercase alphanumeric + hyphen, **first character must be a
   * letter**. Mirrors `OperatorSchema.id` and `StackConfigSchema.id` segments
   * (cortex#141, cortex#144): the same trilogy of identifiers that end up
   * embedded verbatim in NATS subjects (`local.{op}.{stack}.dispatch.{agent}.>`
   * after A.5.5). NATS subject segments starting with a digit interact poorly
   * with downstream pattern-matchers that treat segments as numeric literals;
   * letter-prefix is the safe boundary.
   *
   * Closing cortex#145 — the last permissive regex in the operator/stack/agent
   * trilogy now tightens to the same letter-prefix rule. Migration hint for an
   * agent id hitting this rule: rename `2agent` → `team-2agent` or
   * `agent-2026` (prepend / wrap the digits with a letter-prefixed token).
   */
  id: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "agent id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'luna', 'echo', 'team-research'); rename digit-prefixed ids like '2agent' to 'team-2agent' or 'agent-2026'",
  ),
  /** Display name shown to humans. */
  displayName: z.string().min(1),
  /**
   * Path to the agent's persona markdown file. Resolved relative to the
   * cortex config file. Architecture §9.3: personas are platform-neutral
   * — no `<@id>` mentions baked in; the adapter translates at render time.
   */
  persona: z.string().min(1),
  /**
   * v2.0.0 cutover (cortex#297) — `AgentSchema.roles[]` retired.
   * Authorisation flows through `policy.principals[<agent_id>].role[]` →
   * `policy.roles[].capabilities[]`. The agent block no longer carries
   * an authorisation surface; capability declarations live in the
   * top-level `policy:` block.
   */
  /**
   * Peer agents this agent trusts (by logical agent id). When an inbound
   * message arrives from a trusted agent's platform user, the receiving
   * adapter treats it as agent-originated (vs human-originated).
   *
   * Coupling rule (§9.3): values MUST be agent ids — never platform user ids.
   * Schema-level format check applies the same `^[a-z][a-z0-9-]*$` regex as
   * `AgentSchema.id` and `OperatorSchema.id` (cortex#141/#144/#145 trilogy) so
   * a typo (e.g. accidentally pasting a Discord user id like `"1497..."`) is
   * caught at config load, not silently when the registry fails to resolve
   * the reference (Holly W2 review). The letter-prefix rule also catches the
   * digit-only-snowflake paste-bug deterministically rather than relying on
   * downstream registry resolution to fail.
   *
   * Validation that the referenced ids resolve to known agents happens at
   * load time in the agent registry (MIG-7.2a), not in this schema.
   */
  trust: z.array(
    z.string().regex(
      LETTER_PREFIX_ID_REGEX,
      "trust entries must be agent ids — lowercase alphanumeric + hyphen, starting with a letter (e.g. 'echo', 'team-research'); rename digit-prefixed entries like '2agent' to 'team-2agent' or 'agent-2026'",
    ),
  ).default([]),
  /**
   * IAW Phase B.1 (cortex#114) — NKey public key the agent uses (via its
   * home stack) to sign outbound bot↔bot envelopes. Optional in Phase B.1:
   * agents without `nkey_pub` cannot participate in NKey-verified bot↔bot
   * dispatch and fall back to the platform-id trust path on Discord /
   * Mattermost DMs. The field becomes required for any agent intended to
   * speak on the bus once Phase C absorbs principals into the top-level
   * `policy:` block.
   *
   * Same regex as `StackConfigSchema.nkey_pub` (56-char U-prefixed base32):
   * NKeys are stack-scoped on the wire (the stack signs every envelope),
   * but at the cortex.yaml surface they're declared per-agent because
   * each agent has exactly one home stack today. When Phase D introduces
   * multi-stack-per-operator membership, the principal model migrates
   * this off `AgentSchema` onto `policy.principals[]`.
   */
  nkey_pub: z.string().regex(
    NKEY_PUBKEY_REGEX,
    "agent.nkey_pub must be a base32 NKey public key (U-prefixed, 56 chars total)",
  ).optional(),
  /**
   * Per-platform presence blocks. Empty object (`presence: {}`) is
   * valid — it declares a headless agent (cortex#245). The field
   * itself is still required, so a missing or mistyped `presence:`
   * key is rejected by Zod's required-field check.
   */
  presence: PresenceSchema,
  /**
   * F-2 (cortex#60 §5) — substrate harness + dispatch mode. Optional in v1:
   * inline cortex.yaml agents may omit it (cortex assumes
   * claude-code/in-process). Fragments dropped under `agents.d/` SHOULD
   * declare it so the dashboard renders accurate substrate provenance.
   */
  runtime: AgentRuntimeSchema.optional(),
});
// cortex#245 — the previous `at least one presence block` refine was
// dropped to admit headless agents (bus-only participants with no
// platform presence). A valid headless agent declares `presence: {}` —
// it still runs CC sessions via the dispatch-listener, emits
// envelopes onto the bus, and surfaces on the dashboard, but has no
// human-facing surface.
//
// What changes vs. the pre-#245 schema:
//   - `presence: {}`         was rejected, now ACCEPTED (headless).
//   - `presence:` missing    was rejected, still REJECTED
//                            (the `presence` field on AgentSchema is
//                             required, so an absent key fails at the
//                             field-presence layer, not the refine).
//   - `presnce:` (typo)      was rejected (because the agent ended up
//                            with no `presence` key at all), still
//                            REJECTED for the same reason.
//   - Platform sub-blocks    each enforce their own structural
//                            requirements (token/guildId/...) when
//                            an operator DOES declare a platform.
//
// Net effect: operator-friendliness is preserved for the typo case;
// the relaxation is narrowly scoped to "explicit empty object."

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
 * covering `local.{principal}.system.>` — that check fires at config-load (MIG-1.10),
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
  subscribe: z.array(z.string().min(1)).default(["local.{principal}.>"]),
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
  subscribe: z.array(z.string().min(1)).default(["local.{principal}.>"]),
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
    NKEY_PUBKEY_REGEX,
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
   * Subject patterns to subscribe to. Default empty. `{principal}` is substituted
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
// Bus — application-level stream/consumer provisioning
// =============================================================================

/**
 * Review-task JetStream provisioning knobs. These tune cortex's
 * CODE_REVIEW stream + per-agent durable consumers; the MyelinRuntime
 * connection itself still lives under `nats:`.
 */
export const BusReviewConfigSchema = z.object({
  stream: z.object({
    /** Stream name that carries tasks.code-review.* envelopes. */
    name: z.string().min(1).default("CODE_REVIEW"),
    /** How long unclaimed review-task messages remain in JetStream. */
    maxAgeSeconds: z
      .number()
      .int("bus.review.stream.maxAgeSeconds must be an integer number of seconds")
      .positive("bus.review.stream.maxAgeSeconds must be positive")
      .default(86_400),
    /** Finite storage cap; avoids account-level reservation failures. */
    maxBytes: z
      .number()
      .int("bus.review.stream.maxBytes must be an integer number of bytes")
      .positive("bus.review.stream.maxBytes must be positive")
      .default(512 * 1024 * 1024),
  }).default({
    name: "CODE_REVIEW",
    maxAgeSeconds: 86_400,
    maxBytes: 512 * 1024 * 1024,
  }),
  consumer: z.object({
    /** Delivery attempts before JetStream stops redelivering the task. */
    maxDeliver: z
      .number()
      .int("bus.review.consumer.maxDeliver must be an integer")
      .positive("bus.review.consumer.maxDeliver must be positive")
      .default(5),
  }).default({ maxDeliver: 5 }),
});

export const BusConfigSchema = z.object({
  review: BusReviewConfigSchema.default({
    stream: {
      name: "CODE_REVIEW",
      maxAgeSeconds: 86_400,
      maxBytes: 512 * 1024 * 1024,
    },
    consumer: { maxDeliver: 5 },
  }),
});

export type BusConfig = z.infer<typeof BusConfigSchema>;
export type BusReviewConfig = z.infer<typeof BusReviewConfigSchema>;

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
// PolicySchema — IAW Phase C.2a (refs cortex#115)
// =============================================================================

/**
 * Session-construction parameters attached to a principal.
 *
 * IAW Phase C.2b — schema extension (cortex#243a). Carries the
 * legacy `allowedDirs`, `allowedSkills`, `bashGuard`, and
 * `bashAllowlist` knobs that grove-v2 hung off `presence.discord.dm`
 * + `presence.discord.roles[].users[]`. The cutover moves these
 * onto the principal so the dispatch path — not the adapter — picks
 * them up when a CC session is constructed.
 *
 * Used by `PolicyPrincipalSchema.session_config.{default,dm}`
 * (see `docs/design-policy-cutover.md` §5.3 + §12.2). Splitting
 * `default` vs `dm` lets a principal carry a broader bash
 * allowlist in 1:1 DMs than they get in channels — the divergence
 * Andreas's live config exercises today.
 */
const SessionConfigShape = z.object({
  /**
   * Absolute or `~/`-prefixed directory paths the principal may
   * touch in a CC session. The dispatch path expands `~/` and
   * passes the result to `claude --add-dir`. Unset → no
   * per-principal restriction; the global default applies.
   */
  allowed_dirs: z.array(z.string()).optional(),
  /**
   * Skill ids the principal is allowed to load into a CC session.
   * Matches the runner's skill-resolution pass. Unset → no
   * per-principal restriction.
   */
  allowed_skills: z.array(z.string()).optional(),
  /**
   * Whether the cortex bash-guard hook is active for this
   * principal's sessions. Defaults to `true` — guard ON unless
   * an operator explicitly opts out (e.g. for their own `operator`
   * principal in a DM). Preserves the legacy `bashGuard` default.
   */
  bash_guard: z.boolean().default(true),
  /**
   * Optional bash command allowlist. Each rule pairs a regex
   * `pattern` with an optional `repos[]` scope; if `repos` is
   * present the rule only matches when the session is anchored
   * to one of those repos. Top-level `repos[]` carries the
   * always-allowed repo set (e.g. operator's own work tree).
   *
   * Shape mirrors grove-v2's `presence.discord.dm.operatorRole.
   * bashAllowlist` so the cortex#243 migration CLI can copy
   * values across without re-shaping. The runner-side guard
   * consumes this directly post-C.2b (cortex#244).
   */
  bash_allowlist: z.object({
    rules: z.array(z.object({
      pattern: z.string(),
      repos: z.array(z.string()).optional(),
    })).default([]),
    repos: z.array(z.string()).default([]),
  }).optional(),
});

/**
 * A principal — identity-bearing actor the PolicyEngine authorises.
 * Top-level on `cortex.yaml.policy.principals[]` post-C.2a; the
 * PolicyEngine consumes the parsed shape via the
 * `policyEngineFromConfig` factory.
 *
 * Mirrors the `Principal` type from `src/common/policy/types.ts`
 * (C.1); kept as a Zod schema here so config parse validation is
 * authoritative.
 *
 * IAW Phase C.2b — schema extension (cortex#243a). Two additive
 * fields land here:
 *
 *   - `platform_ids` — open record of `<platform_name>: string[]`,
 *     letting any current or future adapter (Discord, Mattermost,
 *     Slack, MCP, HTTP, email, voice, cron, webhook, …) attach a
 *     list of platform-native user ids to a principal. The
 *     pressure-test §15.5 finding flips this to an open `z.record`
 *     so adding a new adapter never requires a schema bump.
 *   - `session_config` — split `{ default, dm? }` carrying CC
 *     session construction parameters (§5.3 + §12.2). `default`
 *     is the channel/group context baseline; optional `dm` overrides
 *     when the message arrived via a 1:1 DM. The dispatch path picks
 *     the right one so adapters stop deciding this.
 *
 * **Convention — federation peers do NOT carry `platform_ids`.**
 * A principal that represents a remote operator's stack (a
 * federation peer) is authenticated by the `signed_by[]` chain's
 * stack NKey, not by any platform-side identity. Setting
 * `platform_ids` on such a principal is meaningless at best and
 * misleading at worst; the schema does not refuse it (operators
 * may carry both during transition) but the migration CLI
 * (cortex#243) emits peer principals with empty `platform_ids`
 * and the dispatch path never consults the field for federated
 * traffic.
 *
 * See `docs/design-policy-cutover.md` §16 for the locked-in schema
 * delta this implements.
 */
export const PolicyPrincipalSchema = z.object({
  /**
   * Stable principal id. Letter-prefix lowercase alphanumeric +
   * hyphen — matches the agent id grammar tightened in cortex#149
   * (AgentSchema.id letter-prefix trilogy). A verified
   * `signed_by[].principal` field with `did:mf:<name>` resolves to
   * this id by stripping the prefix.
   */
  id: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "principal id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'luna', 'echo')",
  ),
  /**
   * Operator that owns this principal. Same letter-prefix
   * grammar — `OperatorSchema.id` enforces it at the operator
   * level and we mirror here so a parsed principal can't carry
   * a malformed home_operator that downstream code would have
   * to defend against.
   */
  home_operator: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "principal.home_operator must match the operator id grammar (lowercase alphanumeric + hyphen, starting with a letter)",
  ),
  /**
   * Stack identity in `{operator_id}/{stack_id}` form — same shape
   * as `StackConfigSchema.id` (Phase A.5).
   */
  home_stack: z.string().regex(
    /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/,
    "principal.home_stack must match {operator_id}/{stack_id} format",
  ),
  /**
   * Stack signing NKey public key. **Declared at C.2a for forward
   * compat — not yet consumed by any verification path.** B.1c
   * cryptoVerify currently reads `agents[].nkey_pub` from the
   * agent registry (`src/bus/verify-signed-by-chain.ts`); C.2b/C.3
   * will migrate the signature-verification lookup to
   * `policy.principals[].nkey_pub` and retire the agent-side
   * field. Until then, declaring `nkey_pub` on a principal parses
   * cleanly but nothing gates on it (Echo cortex#219 round 1).
   *
   * Same regex as `StackConfigSchema.nkey_pub` (56-char U-prefixed
   * base32).
   */
  nkey_pub: z.string().regex(
    NKEY_PUBKEY_REGEX,
    "principal.nkey_pub must be a base32 NKey public key (U-prefixed, 56 chars total)",
  ).optional(),
  /**
   * Role ids the principal holds. Each id must resolve to a
   * `RoleDefinition` in the same policy block; cross-validation
   * via `.refine()` below catches dangling refs at parse time.
   */
  role: z.array(
    z.string().regex(
      LETTER_PREFIX_ID_REGEX,
      "principal.role[] entries must be role ids — lowercase alphanumeric + hyphen, starting with a letter",
    ),
  ).default([]),
  /**
   * Peer principal ids this principal trusts. Cross-validation
   * via `.refine()` ensures every entry resolves to a known
   * principal in the same block.
   */
  trust: z.array(
    z.string().regex(
      LETTER_PREFIX_ID_REGEX,
      "principal.trust[] entries must be principal ids — same grammar as principal.id",
    ),
  ).default([]),
  /**
   * Platform-native user ids this principal answers for, keyed by
   * platform name. **Open record by deliberate design (§15.5)** —
   * any letter-prefix lowercase platform name is accepted, so
   * adding a new adapter (Discord, Mattermost, Slack, MCP, HTTP,
   * email, voice, cron, webhook, …) does not require a schema
   * change. Values are platform-native string ids (e.g. Discord
   * snowflakes), opaque to cortex; the adapter that owns the
   * platform decides what they mean.
   *
   * Uniqueness across the policy block is enforced by
   * `PolicySchema.superRefine` below: no `(platform_name, platform_id)`
   * tuple may appear in two principals.
   *
   * **Convention — federation peer principals SHOULD NOT carry
   * `platform_ids`.** Their identity is asserted via the
   * `signed_by[]` chain's stack NKey, not via platform ids. The
   * schema does not enforce this (operators may carry transition
   * state); the migration CLI and dispatch path simply do not
   * populate or consult it for peers.
   */
  platform_ids: z.record(
    z.string().regex(
      LETTER_PREFIX_ID_REGEX,
      "platform name must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'discord', 'mattermost', 'mcp', 'email')",
    ),
    z.array(z.string()).default([]),
  ).default({}),
  /**
   * CC session construction parameters, split between the
   * channel/group context (`default`) and an optional 1:1 DM
   * override (`dm`). The dispatch-listener picks the right block
   * when constructing a session for a verified principal; adapters
   * no longer decide this. See `docs/design-policy-cutover.md`
   * §5.3 + §12.2 for the channel-vs-DM divergence Andreas's
   * config exercises.
   */
  session_config: z.object({
    default: SessionConfigShape,
    dm: SessionConfigShape.optional(),
  }).optional(),
});

export type PolicyPrincipal = z.infer<typeof PolicyPrincipalSchema>;

/**
 * A role definition. Roles bind capability sets to a name that
 * principals reference. The C.1 PolicyEngine computes a principal's
 * effective capabilities as the union of all referenced roles'
 * capabilities.
 */
export const PolicyRoleSchema = z.object({
  id: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "role id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'operator', 'code-reviewer')",
  ),
  /**
   * Capability ids granted by this role. Convention follows
   * Phase A.6 capability ids — `<domain>.<entity>` dotted
   * lowercase. The C.1 engine matches `Intent.capability`
   * literally against this list; future PRs may add glob
   * expansion.
   */
  capabilities: z.array(z.string().min(1)).default([]),
});

export type PolicyRole = z.infer<typeof PolicyRoleSchema>;

/**
 * Top-level policy block — `cortex.yaml.policy`. Replaces per-
 * adapter `roles[]` post-C.2b (the cutover). At C.2a both shapes
 * coexist; this block parses optionally and the PolicyEngine
 * factory below builds an engine when the block is present and
 * non-empty.
 *
 * Cross-validation at C.2a:
 *   - Every `principal.role[]` id resolves to a declared role.
 *   - Every `principal.trust[]` id resolves to a declared principal.
 * Dangling refs fail at parse time with a clear pointer at the
 * offending principal.
 *
 * Phase D extends with `policy.federated.networks[]` per the
 * Q4 lock-in (`docs/design-internet-of-agentic-work.md` §3.4).
 */
/**
 * A single peer in a federation network — IAW Phase D.1 (cortex#116).
 *
 * Every peer is a remote operator's stack-NKey identity that this
 * operator's cortex will accept federated traffic from. The triple
 * `{operator_id, stack_id, operator_pubkey}` is the verifiable
 * attribution slot: incoming federated envelopes carry
 * `signed_by[].principal = did:mf:<stack_id>` + a signature that
 * verifies against `operator_pubkey`. Phase D verification wiring
 * lands in D.2/D.3; the schema lands first so operators can declare
 * their federation topology before the verification path is live.
 */
export const PolicyFederatedPeerSchema = z.object({
  /**
   * Peer operator id — same letter-prefix grammar as `OperatorSchema.id`.
   * Distinct from the operator's local id; the local operator's id
   * doesn't appear in `federated.networks[].peers[]` (the local
   * operator IS the consumer of the peer list).
   */
  operator_id: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "peer.operator_id must match the operator id grammar (lowercase alphanumeric + hyphen, starting with a letter)",
  ),
  /**
   * Peer stack id in `{operator_id}/{stack_id}` form — same shape as
   * `PolicyPrincipalSchema.home_stack`. The `operator_id` prefix MUST
   * match the sibling `operator_id` field (cross-validated below);
   * the redundancy is deliberate so operators can read the file and
   * see "yes, this is jcfischer's sage-host stack" without splitting
   * the identity across fields.
   */
  stack_id: z.string().regex(
    /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/,
    "peer.stack_id must match {operator_id}/{stack_id} format",
  ),
  /**
   * Peer operator's NKey public key — same 56-char U-prefixed base32
   * grammar as every other NKey on the schema (StackConfigSchema,
   * PolicyPrincipalSchema). Phase D.4 swaps this static declaration
   * for a registry-resolved lookup; until then, operators paste the
   * peer's pubkey directly into cortex.yaml.
   */
  operator_pubkey: z.string().regex(
    NKEY_PUBKEY_REGEX,
    "peer.operator_pubkey must be a base32 NKey public key (U-prefixed, 56 chars total)",
  ),
});

export type PolicyFederatedPeer = z.infer<typeof PolicyFederatedPeerSchema>;

/**
 * NATS subject pattern with `*` / `>` wildcards. Used for
 * `accept_subjects[]` and `deny_subjects[]` lists on a federated
 * network. Format: dotted lowercase-alphanumeric segments,
 * optional `*` (single-segment wildcard) or `>` (trailing
 * multi-segment wildcard, only as the final segment).
 *
 * Conservative grammar — matches what cortex actually produces +
 * what the surface-router's `adapterMatches()` will gate against
 * in D.2. Operators can always relax via additional patterns
 * rather than building a regex string.
 *
 * **Bare `>` is intentionally rejected** (Echo cortex#223 round 1).
 * A naked top-level wildcard on `accept_subjects[]` would defeat
 * the purpose of a federation accept-list; the maximal valid
 * accept pattern is `federated.{network_id}.>`. The cross-validation
 * below enforces the `federated.{network_id}.` prefix on every
 * entry — this regex covers only the grammar of the trailing
 * portion.
 */
const NATS_SUBJECT_PATTERN_RE = /^([a-z][a-z0-9_-]*|\*)(\.([a-z][a-z0-9_-]*|\*))*(\.>)?$/;

/**
 * A single federation network — IAW Phase D.1 (cortex#116).
 *
 * Networks are the unit of federation policy in cortex per Q4
 * lock-in: a cortex instance participates in N networks; each
 * network has its own peer roster, accept/deny lists, and hop
 * budget. Multi-link transport (one MyelinRuntime per network)
 * lands in Phase E; Phase D operates one network's leaf-node at a
 * time, named via `leaf_node`.
 */
export const PolicyFederatedNetworkSchema = z.object({
  /**
   * Network id — same letter-prefix grammar as principal/role ids.
   * Appears in NATS subject prefixes
   * (`federated.{network_id}.<...>`); kept short and
   * dash-separated for readability on the wire.
   */
  id: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "network id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'research-collab')",
  ),
  /**
   * Reference to a named NATS leaf-node connection. In Phase D only
   * one leaf-node is operable concurrently; the `leaf_node` field
   * exists for forward compat with Phase E's multi-link
   * MyelinRuntime. Field grammar matches the agent/network id
   * pattern (letter-prefix lowercase alphanumeric + hyphen).
   */
  leaf_node: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "network.leaf_node must match the connection id grammar (lowercase alphanumeric + hyphen, starting with a letter)",
  ),
  /**
   * Peer operators reachable on this network. Each entry declares
   * one peer stack's NKey identity. The list is the trust closure
   * for the network: a `signed_by[].principal` not in this list
   * fails verification on the inbound side.
   */
  peers: z.array(PolicyFederatedPeerSchema).default([]),
  /**
   * Accept-list of NATS subject patterns. An inbound `federated.*`
   * envelope is dispatched only if its subject matches at least one
   * entry here (and no entry in `deny_subjects[]`). Empty means
   * "accept nothing" — operators must explicitly enumerate accepted
   * subject patterns. D.2 wires the surface-router gate.
   */
  accept_subjects: z.array(
    z.string().regex(
      NATS_SUBJECT_PATTERN_RE,
      "accept_subjects[] entries must be NATS subject patterns (dotted lowercase + optional * / > wildcards)",
    ),
  ).default([]),
  /**
   * Deny-list of NATS subject patterns. A match here overrides
   * `accept_subjects[]` and rejects the inbound envelope with
   * `peer_deny_list` (D.2 audit). Useful for "accept all
   * code-review.* except *.private.*" patterns.
   */
  deny_subjects: z.array(
    z.string().regex(
      NATS_SUBJECT_PATTERN_RE,
      "deny_subjects[] entries must be NATS subject patterns (dotted lowercase + optional * / > wildcards)",
    ),
  ).default([]),
  /**
   * Capability ids this stack announces on the network. Mirrors the
   * Phase A.6 capability registry — the network publishes these on
   * `system.capability.announced.<network_id>` so peers can route
   * tasks by capability without having to know each operator's
   * agent inventory. Empty = "announce nothing" (a silent
   * participant — consumes but doesn't offer work).
   */
  announce_capabilities: z.array(
    z.string().regex(
      /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/,
      "announce_capabilities[] entries must follow the <domain>.<entity> capability id grammar (e.g. 'code-review.typescript')",
    ),
  ).default([]),
  /**
   * Maximum chain length on inbound envelopes. `signed_by[].length`
   * over this value rejects with `max_hop_exceeded` (D.2.3). Zero
   * means "no hops" — accept only directly-signed envelopes, no
   * relay. Hop budgets bound the federation graph and prevent
   * unbounded forwarding loops.
   *
   * **No default — required field.** Every other list-shaped field
   * on this schema defaults to `[]`, but `max_hop` is deliberately
   * not defaulted: a hop budget MUST be a conscious operator
   * choice. A silent `.default(0)` would let a typoed `max_hop:`
   * line pass parse with the most-restrictive setting and confuse
   * operators wondering why federated traffic stopped arriving;
   * a missing line should fail loudly at config-load instead.
   * Echo cortex#223 round 2.
   */
  max_hop: z.number().int().min(0),
});

export type PolicyFederatedNetwork = z.infer<typeof PolicyFederatedNetworkSchema>;

/**
 * IAW Phase D.4.3 — optional `policy.federated.registry` block.
 *
 * Declares the cortex-network-registry endpoint the operator wants
 * cortex to consult for peer-pubkey resolution. When present, the
 * `RegistryClient` (in `src/common/registry/`) is instantiated at
 * boot and consults `{url}/operators/{id}` on a refresh schedule
 * to populate an in-memory cache of verified peer pubkeys.
 *
 * The trust anchor is the registry's own Ed25519 pubkey:
 *
 *   - If `pubkey` is set, cortex pins it from config and refuses
 *     any assertion whose `registry` field disagrees.
 *   - If `pubkey` is absent, cortex performs Trust-On-First-Use
 *     (TOFU) at boot via `GET /registry/pubkey` and pins whatever
 *     comes back. This is the documented Phase-B caveat: the TOFU
 *     window is exactly the first boot against an unknown registry,
 *     and operators preferring zero-TOFU should populate `pubkey`
 *     out-of-band before first run.
 *
 * Absence of the block is the default — cortex runs without a
 * registry client and the federation roster is whatever lives
 * statically in `policy.federated.networks[].peers[]`. The block
 * is fully additive; existing configs are unaffected.
 */
export const PolicyFederatedRegistrySchema = z.object({
  /**
   * Registry base URL. Trailing slashes are tolerated but the client
   * normalises before joining endpoint paths. Must be `https://` in
   * production; `http://` is accepted so test rigs can run against a
   * local in-process Hono app without TLS.
   */
  url: z.url("registry.url must be a valid URL"),
  /**
   * Optional pinned registry pubkey (base64-encoded Ed25519, 32 raw
   * bytes before encoding). When set, the client refuses any
   * assertion whose `registry` field does not match this value. When
   * absent, TOFU at boot — the first `/registry/pubkey` response is
   * pinned for the lifetime of the process. Operators wanting a
   * persistent pin across restarts must paste it here.
   *
   * Grammar matches the registry service's `OperatorRecord.operator_pubkey`
   * shape (base64 of 32 raw bytes → 44 chars including `=` padding).
   * Validated softly (length + base64 alphabet) — strict 32-byte
   * decoding happens at the client during initial fetch.
   */
  pubkey: z.string().regex(
    /^[A-Za-z0-9+/]{43}=$/,
    "registry.pubkey must be base64-encoded Ed25519 (44 chars including padding)",
  ).optional(),
});

export type PolicyFederatedRegistry = z.infer<typeof PolicyFederatedRegistrySchema>;

/**
 * `policy.federated` block — IAW Phase D.1 (cortex#116). Optional
 * on cortex.yaml; absence means "no federation declared" and the
 * surface-router treats inbound `federated.*` envelopes as
 * unrecognised (rejected at the validator layer). When present,
 * carries the operator's network roster.
 *
 * IAW Phase D.4.3 extends with the optional `registry` sub-block —
 * see `PolicyFederatedRegistrySchema` for the trust-anchor model.
 */
export const PolicyFederatedSchema = z.object({
  networks: z.array(PolicyFederatedNetworkSchema).default([]),
  registry: PolicyFederatedRegistrySchema.optional(),
});

export type PolicyFederated = z.infer<typeof PolicyFederatedSchema>;

export const PolicySchema = z.object({
  principals: z.array(PolicyPrincipalSchema).default([]),
  roles: z.array(PolicyRoleSchema).default([]),
  federated: PolicyFederatedSchema.optional(),
  // v2.0.0 cutover (cortex#297) — `parallel_mode_enabled` retired with
  // the parallel-mode plumbing in adapters. PolicyEngine is the sole
  // authorisation gate; legacy role-resolver is gone.
}).superRefine((policy, ctx) => {
  // Per-offender path emission so a YAML-aware loader can render
  // the error inline at the bad token (Echo cortex#219 round 1).
  // Capability-catalog precedent: `superRefine` with batch
  // `ctx.addIssue` per offender at the same nesting depth.

  // Uniqueness — principals[] keyed on `(id, home_stack)` (§15.4,
  // cortex#243a). Federated peers in multi-stack deployments may
  // legitimately register two principals with the same id but
  // different home_stacks — e.g. sage records both
  // `luna@andreas/meta-factory` and `luna@andreas/work`. The pre-
  // cutover key was `id` alone, which rejected that pattern. The
  // tuple key preserves the original intent (no two principals
  // collide within a stack) while permitting cross-stack
  // homonyms.
  const seenPrincipal = new Map<string, number>();
  policy.principals.forEach((p, i) => {
    const key = `${p.id}\u0001${p.home_stack}`;
    const dupAt = seenPrincipal.get(key);
    if (dupAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `principal id "${p.id}" already declared for home_stack "${p.home_stack}" at principals[${dupAt}] — multi-stack peers may share an id only if their home_stack differs`,
        path: ["principals", i, "id"],
      });
    } else {
      seenPrincipal.set(key, i);
    }
  });

  // Uniqueness — `(platform_name, platform_id)` tuple across all
  // principals (§16, cortex#243a). No platform-side identity may
  // be claimed by two principals; that would let the dispatch path
  // resolve an inbound platform message to either of them
  // non-deterministically. Caught at parse time with a per-offender
  // path so operators see the second declaration as the offender.
  // Federation peer principals SHOULD NOT carry platform_ids (see
  // PolicyPrincipalSchema JSDoc); when they do, this rule still
  // applies — the convention is operator-side, the uniqueness
  // rule is schema-side.
  const seenPlatformTuple = new Map<string, { principalIdx: number; principalId: string }>();
  policy.principals.forEach((p, principalIdx) => {
    for (const [platformName, ids] of Object.entries(p.platform_ids)) {
      ids.forEach((platformId, idIdx) => {
        const key = `${platformName}\u0001${platformId}`;
        const prior = seenPlatformTuple.get(key);
        if (prior !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `platform_ids.${platformName} entry "${platformId}" already claimed by principal "${prior.principalId}" at principals[${prior.principalIdx}] — a platform-side identity may belong to only one principal. Note: federation-peer principals should not carry platform_ids; their identity is asserted via the signed_by chain's stack NKey (see PolicyPrincipalSchema JSDoc + docs/design-policy-cutover.md §16)`,
            path: ["principals", principalIdx, "platform_ids", platformName, idIdx],
          });
        } else {
          seenPlatformTuple.set(key, { principalIdx, principalId: p.id });
        }
      });
    }
  });

  // Uniqueness — roles[].id.
  const seenRole = new Map<string, number>();
  policy.roles.forEach((r, i) => {
    const dupAt = seenRole.get(r.id);
    if (dupAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `role id "${r.id}" already declared at roles[${dupAt}]`,
        path: ["roles", i, "id"],
      });
    } else {
      seenRole.set(r.id, i);
    }
  });

  // Cross-ref: every principal.role[] resolves to a declared role.
  // Batch-emit (not first-failure) so an operator with multiple
  // dangling refs sees all of them on one parse pass.
  const knownRoles = new Set(policy.roles.map((r) => r.id));
  policy.principals.forEach((p, principalIdx) => {
    p.role.forEach((roleId, roleIdx) => {
      if (!knownRoles.has(roleId)) {
        ctx.addIssue({
          code: "custom",
          message: `principal "${p.id}" references undeclared role "${roleId}" — declare it in policy.roles[]`,
          path: ["principals", principalIdx, "role", roleIdx],
        });
      }
    });
  });

  // Cross-ref: every principal.trust[] resolves to a declared principal.
  const knownPrincipals = new Set(policy.principals.map((p) => p.id));
  policy.principals.forEach((p, principalIdx) => {
    p.trust.forEach((peerId, trustIdx) => {
      if (!knownPrincipals.has(peerId)) {
        ctx.addIssue({
          code: "custom",
          message: `principal "${p.id}" trusts undeclared peer "${peerId}" — declare it in policy.principals[]`,
          path: ["principals", principalIdx, "trust", trustIdx],
        });
      }
    });
  });

  // IAW Phase D.1 — federation cross-validation. Same per-offender
  // path pattern as the principal/role rules above; consistent
  // failure shape across the policy block.
  if (policy.federated !== undefined) {
    // Uniqueness — networks[].id.
    const seenNetwork = new Map<string, number>();
    policy.federated.networks.forEach((n, networkIdx) => {
      const dupAt = seenNetwork.get(n.id);
      if (dupAt !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `network id "${n.id}" already declared at federated.networks[${dupAt}]`,
          path: ["federated", "networks", networkIdx, "id"],
        });
      } else {
        seenNetwork.set(n.id, networkIdx);
      }

      // Subject-pattern scope: every accept/deny pattern MUST begin
      // with `federated.{network.id}.` so the network can't
      // accidentally subscribe to or block out-of-scope subjects.
      // Echo cortex#223 round 1 — without this guard, a typo like
      // `accept_subjects: ["internal.private.>"]` parses cleanly
      // and the surface-router gate (D.2) has to defend against it.
      // Enforce at parse time instead.
      const expectedSubjectPrefix = `federated.${n.id}.`;
      const validateSubjectScope = (
        list: readonly string[],
        listName: "accept_subjects" | "deny_subjects",
      ) => {
        list.forEach((pattern, patternIdx) => {
          if (!pattern.startsWith(expectedSubjectPrefix)) {
            ctx.addIssue({
              code: "custom",
              message: `${listName}[${patternIdx}] "${pattern}" must begin with "federated.${n.id}." — the network's own subject scope`,
              path: ["federated", "networks", networkIdx, listName, patternIdx],
            });
          }
        });
      };
      validateSubjectScope(n.accept_subjects, "accept_subjects");
      validateSubjectScope(n.deny_subjects, "deny_subjects");

      // Per-network peer cross-validation.
      const seenPeerStack = new Map<string, number>();
      const seenPeerPubkey = new Map<string, number>();
      n.peers.forEach((peer, peerIdx) => {
        // stack_id prefix must match operator_id — the two fields
        // are deliberately redundant so the file reads naturally,
        // but they MUST agree. A drift between them would let an
        // operator declare "peer X has stack Y" where Y belongs to
        // a different operator — the surface-router would then
        // accept federated traffic claiming a forged identity.
        const expectedPrefix = `${peer.operator_id}/`;
        if (!peer.stack_id.startsWith(expectedPrefix)) {
          ctx.addIssue({
            code: "custom",
            message: `peer.stack_id "${peer.stack_id}" must start with peer.operator_id "${peer.operator_id}" — got prefix "${peer.stack_id.split("/")[0]}/" instead`,
            path: ["federated", "networks", networkIdx, "peers", peerIdx, "stack_id"],
          });
        }

        // Uniqueness — peer.stack_id within a network. Two
        // declarations of the same stack are operator error; the
        // schema rejects rather than silently dedup.
        const dupStackAt = seenPeerStack.get(peer.stack_id);
        if (dupStackAt !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `peer.stack_id "${peer.stack_id}" already declared at federated.networks[${networkIdx}].peers[${dupStackAt}]`,
            path: ["federated", "networks", networkIdx, "peers", peerIdx, "stack_id"],
          });
        } else {
          seenPeerStack.set(peer.stack_id, peerIdx);
        }

        // Uniqueness — peer.operator_pubkey within a network. A
        // single pubkey appearing twice signals a copy-paste error
        // (operator pasted the same key into two peer entries with
        // different stack_ids); the schema catches it.
        const dupKeyAt = seenPeerPubkey.get(peer.operator_pubkey);
        if (dupKeyAt !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `peer.operator_pubkey already declared at federated.networks[${networkIdx}].peers[${dupKeyAt}] (pubkey collision — paste error?)`,
            path: ["federated", "networks", networkIdx, "peers", peerIdx, "operator_pubkey"],
          });
        } else {
          seenPeerPubkey.set(peer.operator_pubkey, peerIdx);
        }
      });
    });
  }
});

export type Policy = z.infer<typeof PolicySchema>;

// =============================================================================
// CortexConfig — the top-level schema
// =============================================================================

/**
 * The cortex deployment configuration. One file per principal
 * (`~/.config/cortex/cortex.yaml`). Loaded at startup; hot-reloaded by
 * `config-watcher.ts` for fields that don't require a restart.
 *
 * Architecture §9 compliance: there is exactly ONE singular block
 * (`principal:` — renamed from `operator:` per the vocabulary migration
 * 2026-05 v3.0.0 BREAKING; manifest PR-11), and the agent list is the
 * canonical source. Renderers are top-level peers, not properties of
 * any agent. No `agent:` (singular) — that's the legacy grove-v2 shape
 * and is replaced by the agents[] array.
 */
export const CortexConfigSchema = z.object({
  /** Who is running this cortex instance. */
  principal: PrincipalConfigSchema,
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
   * IAW Phase A.6 (refs cortex#113) — stack-level capability declarations,
   * per Q2 lock-in (`docs/design-internet-of-agentic-work.md` §5 Q2,
   * 2026-05-13 Andreas). Each entry is a constrained-schema declaration:
   * `id` (dot-separated lowercase), `description` (non-empty), `tags`
   * (taxonomic labels), `provided_by` (≥1 declared agent id), optional
   * `rate` / `cost` envelopes.
   *
   * The block is OPTIONAL and defaults to `[]` — an operator running
   * cortex without any declared capabilities parses cleanly, same as
   * before this block landed. The cross-field invariants below run only
   * when at least one of `agents[].runtime.capabilities[]` or
   * `capabilities[]` is non-empty.
   *
   * Per A.6.3, `agents[].runtime.capabilities[]` stays a string array of
   * capability IDs (no shape change there). The top-level `capabilities[]`
   * is the catalog those IDs reference; the existence check at the
   * document level (refine below) rejects dangling references at config
   * load.
   *
   * Behaviour today: schema-only. No runtime dispatcher consumes the
   * catalog yet — that's a future phase (orchestrator pattern, design §3.6).
   * Wiring the schema in now means operators can declare capabilities
   * before the dispatch path consumes them, and the network registry
   * (Q3) has the deterministic shape it needs when Phase D ships.
   */
  capabilities: z.array(CapabilitySchema).default([]),
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

  /**
   * IAW Phase C.2a (refs cortex#115) — top-level policy block. The
   * single principal + role registry that the PolicyEngine consumes.
   * Optional at C.2a (additive); C.2b removes the per-adapter
   * `roles[]` legacy shape and makes `policy:` the authoritative
   * source. Until C.2b lands, both shapes coexist and operators
   * MAY declare `policy:` ahead of the cutover to validate their
   * principal model without waiting on the full schema flip.
   *
   * Behaviour today (C.2a): schema-only. The dispatch-handler still
   * reads per-adapter roles for authorisation; C.3 wires PolicyEngine
   * into the dispatch path. Declaring `policy:` in cortex.yaml is
   * forward-compatible — parses cleanly and is available via the
   * `policyEngineFromConfig` factory for callers that opt in.
   */
  policy: PolicySchema.optional(),

  /** First-class agents — the canonical list. */
  agents: z.array(AgentSchema).min(1, "at least one agent is required"),

  /**
   * Anti-field: top-level `discord:` arrays are the grove-v2 shape where
   * platform credentials sit as siblings of `agent:`. In cortex they live
   * under `agents[].presence.discord` (architecture §9.1). A typical
   * hand-migration miss is to lift `agents:` into the new file but leave
   * the legacy `discord:[...]` block alongside it — Zod would silently
   * strip it, producing a headless agent (no platform presence) without
   * an obvious migration-error signal. This guard surfaces the
   * mistake at the source (Holly W3 review). Post-cortex#245 headless
   * is a legitimate config, so this guard is the only thing now
   * differentiating "intentional headless" from "stripped legacy
   * discord block."
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

  /** Application-level bus provisioning knobs. Optional; defaults are production-safe. */
  bus: emptyDefault(BusConfigSchema),
}).refine(
  (config) => {
    const ids = config.agents.map((a) => a.id);
    return new Set(ids).size === ids.length;
  },
  { message: "agent ids must be unique", path: ["agents"] },
)
  // IAW Phase A.6.3 — capability catalog invariants.
  //
  // Three document-level cross-field checks, each with a pointed error
  // message so an operator hitting one knows exactly which key to fix:
  //
  //   1. Top-level capability ids are unique. Two entries with the same id
  //      represent two declarations of the same capability — likely a
  //      copy-paste error; rejected at load time so the operator sees the
  //      duplication immediately rather than the registry surfacing the
  //      "last write wins" silently.
  //
  //   2. Every `provided_by[]` reference resolves to a declared `agents[].id`.
  //      Symmetric dangling-reference guard with the agent-side reference
  //      check below. A capability claiming to be provided by an agent
  //      that doesn't exist would silently never run; we fail fast at
  //      config load.
  //
  //   3. Every `agents[].runtime.capabilities[]` entry exists in the
  //      top-level `capabilities[]` catalog. This is the core A.6.3
  //      requirement: per-agent capability annotations REFERENCE the
  //      catalog by id; references that don't resolve are configuration
  //      errors, not silent runtime degradations.
  //
  // Implementation note: Zod's `.refine()` short-circuits on the first
  // failing predicate, so we run the cheap structural checks first
  // (unique catalog ids) before the cross-set walks (provider / consumer
  // reference resolution). The Set construction and lookups are O(n+m)
  // per check, which is well below any realistic config size.
  .refine(
    (config) => {
      const ids = config.capabilities.map((c) => c.id);
      return new Set(ids).size === ids.length;
    },
    {
      message: "capability ids must be unique within the top-level capabilities[] block",
      path: ["capabilities"],
    },
  )
  // Document-level checks 2 + 3 (provider / consumer dangling references)
  // use `superRefine` so the error message can name the specific dangling
  // id and the specific config key that's at fault. Each issue is reported
  // at a path that points to the offending array entry (`capabilities[i]`
  // / `agents[j].runtime.capabilities`) so a YAML-aware loader can render
  // the error in line with the source.
  //
  // We emit ALL dangling references (not just the first) so a config with
  // many broken references surfaces them as a batch rather than the
  // operator having to fix-and-rerun per failure.
  .superRefine((config, ctx) => {
    const agentIds = new Set(config.agents.map((a) => a.id));
    const declaredAgentList = [...agentIds].sort().join(", ") || "(none)";
    for (let capIdx = 0; capIdx < config.capabilities.length; capIdx++) {
      const cap = config.capabilities[capIdx];
      if (!cap) continue;
      for (let providerIdx = 0; providerIdx < cap.provided_by.length; providerIdx++) {
        const providerId = cap.provided_by[providerIdx];
        if (providerId !== undefined && !agentIds.has(providerId)) {
          ctx.addIssue({
            code: "custom",
            message:
              `capability "${cap.id}" lists provider agent "${providerId}" in provided_by[], ` +
              `but no agent with that id is declared in agents[] ` +
              `(declared agent ids: ${declaredAgentList})`,
            path: ["capabilities", capIdx, "provided_by", providerIdx],
          });
        }
      }
    }
  })
  .superRefine((config, ctx) => {
    const catalogIds = new Set(config.capabilities.map((c) => c.id));
    const declaredCatalog = [...catalogIds].sort().join(", ") || "(none)";
    for (let agentIdx = 0; agentIdx < config.agents.length; agentIdx++) {
      const agent = config.agents[agentIdx];
      if (!agent) continue;
      const claimed = agent.runtime?.capabilities ?? [];
      for (let claimIdx = 0; claimIdx < claimed.length; claimIdx++) {
        const capId = claimed[claimIdx];
        if (capId !== undefined && !catalogIds.has(capId)) {
          // cortex#314 — reworded for first-install safety. The previous
          // "Either add ... or remove ..." framing implied symmetric
          // choice; in practice (especially for code-review.* flavors)
          // the right fix is almost always to add the capability to the
          // top-level catalog. The catalog is the source of truth that
          // the dispatch consumer + future network registry consult;
          // the agent's runtime.capabilities[] is the agent's
          // declaration of intent. Spell that asymmetry out so a fresh
          // operator hitting this error knows which surface to edit.
          ctx.addIssue({
            code: "custom",
            message:
              `agent "${agent.id}" claims capability "${capId}" in runtime.capabilities[], ` +
              `but no matching entry exists in the top-level capabilities[] catalog ` +
              `(declared capability ids: ${declaredCatalog}).\n\n` +
              `Fix: add a "${capId}" entry to capabilities[] at the top level of cortex.yaml. ` +
              `The top-level capabilities[] is the source of truth that the dispatch consumer ` +
              `consults; the agent's runtime.capabilities[] is the agent's declaration of intent.\n\n` +
              `Example minimal entry:\n` +
              `  - id: ${capId}\n` +
              `    description: <one-line description>\n` +
              `    provided_by: [${agent.id}]\n\n` +
              `(Only remove from agent "${agent.id}" runtime.capabilities[] if the agent should NOT ` +
              `actually provide that capability.)`,
            path: ["agents", agentIdx, "runtime", "capabilities", claimIdx],
          });
        }
      }
    }
  });

export type CortexConfig = z.infer<typeof CortexConfigSchema>;

// =============================================================================
// Public-API re-exports — preserve existing import paths for shared types
// =============================================================================

export {
  NetworkClaudeSchema,
  NetworkCloudSchema,
  NetworkFileSchema,
};

/**
 * IAW Phase A.5 re-exports — the stack identity primitive ships in its own
 * module (`./stack.ts`) for tighter ownership, but downstream code that
 * already pulls `CortexConfigSchema` from this file shouldn't need a second
 * import path. Mirror the `NetworkClaudeSchema` re-export pattern above.
 */
export { StackConfigSchema, deriveStackId } from "./stack";
export type { StackConfig, DerivedStackId, DeriveStackIdInput } from "./stack";

/**
 * IAW Phase A.6 re-exports — the capability declaration primitive ships in
 * its own module (`./capability.ts`) for tighter ownership, but downstream
 * code that already pulls `CortexConfigSchema` from this file shouldn't need
 * a second import path. Mirrors the `StackConfigSchema` re-export above.
 */
export { CapabilitySchema } from "./capability";
export type { Capability, CapabilityRate, CapabilityCost } from "./capability";
