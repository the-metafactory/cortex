/**
 * F-007: Bot Configuration Types
 *
 * Supports both legacy flat format and new instance-list format:
 *   Legacy:  discord: { token: "...", guildId: "..." }
 *   New:     discord: [{ instanceId: "main", token: "...", guildId: "..." }]
 */

import { z } from "zod/v4";
import { NKEY_PUBKEY_REGEX } from "./nkey";
import { NatsSubjectsSchema } from "./nats-subjects";

// =============================================================================
// Helper: typed empty default for nested Zod object schemas.
//
// When every inner field has its own `.default(...)`, Zod parses an empty
// `{}` correctly at runtime — but the parent's `.default()` requires a
// value matching the schema's *output* type, which lists the inner fields
// as required. The cast here narrows once at the helper boundary instead
// of repeating `{} as any` at every call site. The lint suppressions are
// targeted: a single helper carries the unsafety, the call sites stay
// clean.
// =============================================================================
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
function emptyDefault<T>(): T {
  return {} as any;
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

// =============================================================================
// v2.0.0 cutover (cortex#297) — legacy per-adapter role / DM / role-resolver
// schemas removed. Authorisation now flows exclusively through the top-level
// `policy:` block on cortex.yaml (`PolicyPrincipalSchema` / `PolicyRoleSchema`
// in `./cortex-config.ts`). Principals upgrading from <v2.0.0 MUST run
// `bun src/cli/cortex/commands/migrate-config.ts <your-config.yaml>` first to
// synthesise the new `policy:` block from their legacy `presence.<platform>.roles[]`
// + `dm.*` blocks. See `docs/design-policy-cutover.md` §16 for the full schema
// delta and `docs/iteration-policy-cutover.md` cortex#297 for the slice scope.
// =============================================================================

// =============================================================================
// TC-0 (Trust & Confidentiality, #628): unified security-posture schema.
//
// Extracted to a single exported schema so BOTH config shapes reference the
// same source of truth — `AgentConfigSchema.security` (legacy bot.yaml) and
// `CortexConfigSchema.security` (cortex.yaml) — exactly as `NatsSubjectsSchema`
// is shared. Without this, a `security:` block written in a cortex.yaml is
// silently stripped by `CortexConfigSchema` and the resolver falls back to the
// `off` default — a fail-OPEN silent downgrade (a principal who writes
// `signing: enforce` would unknowingly run unsigned/non-rejecting).
//
// Every layer defaults OFF so the stack runs unsigned/cleartext for dev; each
// ramps independently `off → permissive → enforce`.
// See docs/design-trust-confidentiality.md §Phase 0 (part of #627).
//
// - `signing`: off = no signer · permissive = sign + verify but NEVER reject
//   (cryptoVerify:true, rejectEmpty:false, signFailureMode:"fallback") ·
//   enforce = reject unsigned/invalid (rejectEmpty:true, signFailureMode:"drop").
// - `encryption.payload`: off = cleartext · opt-in = seal when the recipient
//   advertises an enc_pub (both accepted) · require = reject cleartext.
// - `encryption.at_rest`: off | on (field-encrypt high-sensitivity columns).
// - `transport.mtls`: off | on (offer client cert) | require (refuse non-mTLS).
//   `transport.tls.{cert_path,key_path,ca_path}` (TC-4d/4e) carry the client
//   cert material consumed when `mtls` is on/require. Key file chmod-600 gated.
//
// The `emptyDefault()` + transform idiom mirrors the `cockpit` block below:
// `.default(emptyDefault())` returns `{}` without re-parsing inner defaults,
// so the transform re-applies them — callers always get the populated shape.
// =============================================================================
export const SecurityPostureSchema = z.object({
  signing: z.enum(["off", "permissive", "enforce"]).default("off"),
  encryption: z.object({
    payload: z.enum(["off", "opt-in", "require"]).default("off"),
    at_rest: z.enum(["off", "on"]).default("off"),
  }).default(emptyDefault()),
  transport: z.object({
    mtls: z.enum(["off", "on", "require"]).default("off"),
    // TC-4d/4e (#627 Phase 4) — client cert/key/ca paths for transport mTLS.
    // CONSUMED only when `mtls` is `on`/`require` (the `buildNatsTlsOptions`
    // builder in `src/common/config/transport-mtls.ts` reads them). The
    // private `key_path` is chmod-600 gated at load (same policy as the
    // nkey-seed / `.creds` loaders); cert + ca are public material. All three
    // are optional so a partial config fails per-mode at connect time (a clear
    // fail-closed error under `require`) rather than being rejected at schema
    // parse — and so the back-compat `off` path never requires these fields.
    tls: z.object({
      cert_path: z.string().optional(),
      key_path: z.string().optional(),
      ca_path: z.string().optional(),
    }).optional(),
  }).default(emptyDefault()),
}).default(emptyDefault()).transform((val) => ({
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  signing: val.signing ?? "off",
  encryption: {
    payload: val.encryption?.payload ?? "off",
    at_rest: val.encryption?.at_rest ?? "off",
  },
  transport: {
    mtls: val.transport?.mtls ?? "off",
    ...(val.transport?.tls !== undefined ? { tls: val.transport.tls } : {}),
  },
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}));

// =============================================================================
// Instance schemas (new: each platform entry is an instance)
// =============================================================================

export const DiscordInstanceSchema = z.object({
  /** Unique instance ID. Auto-generated from guildId if not provided. */
  instanceId: z.string().optional(),
  /** Whether this instance is active. Default: true. */
  enabled: z.boolean().default(true),
  token: z.string().min(1),
  guildId: z.coerce.string().min(1),
  agentChannelId: z.coerce.string().min(1),
  logChannelId: z.coerce.string().min(1),
  /** Channel ID for worklog threads (G-200). If set, agent tasks get threaded updates. */
  worklogChannelId: z.coerce.string().optional(),
  contextDepth: z.number().int().positive().default(10),
  /** Post agent events to #agent-log. Default: false (opt-in). */
  enableAgentLog: z.boolean().default(false),
  /**
   * F-11: Optional Discord role id to mention on high-priority block
   * notifications. When set, channel posts marked `severity = 'ping'`
   * render `<@&{operatorRoleId}>` in the body. When unset (default),
   * those notifications render as plain channel posts with no mention.
   * See `docs/design-mc-f11-discord-notifications.md` Decision 5.
   */
  operatorRoleId: z.coerce.string().optional(),

  /**
   * cortex#84: Discord user IDs of peer bots that are permitted to
   * trigger this bot. Bot-authored messages are dropped by default to
   * prevent self-loops and unsolicited bot chatter; entries listed here
   * are allowed through the author-bot filter and then handled by the
   * normal role-based access path (so the principal still has to grant
   * each peer bot a role in `roles[]` or `dm.userRoles[]` to actually
   * respond).
   *
   * Each entry is a Discord snowflake. The bot's own user id is NEVER
   * allowed regardless of this list (anti-self-loop guard kept).
   *
   * Bridge field — at MIG-7.2e cortex.ts will switch to reading
   * `agents[].trust` from cortex.yaml and the in-process TrustResolver
   * (see `src/common/agents/trust-resolver.ts`) will populate the
   * effective allowlist automatically for peer bots co-hosted in the
   * same cortex process. This field stays as the cross-process bridge
   * (e.g. Ivy in PAI's local cortex trusting Holly in a server cortex),
   * since the resolver only sees adapters started in its own process.
   */
  trustedBotIds: z.array(z.coerce.string()).default([]),

  /**
   * cortex#709 — DM stack-OWNERSHIP flag. Mirror of the cortex-shape field —
   * `cortex.ts` threads it through to the `DiscordPresence` it builds, and the
   * adapter drops DM-scoped `messageCreate` early when `false`.
   *
   * @see DiscordPresenceSchema.dmOwner in `cortex-config.ts` for the canonical
   * principal-facing description, default (`true`), and misconfiguration
   * semantics.
   */
  dmOwner: z.boolean().default(true),

  /**
   * MIG-3b / cortex#205: NATS subject patterns this Discord adapter renders
   * to chat. Mirror of the cortex-shape field — `flattenDiscordPresences`
   * threads it through verbatim.
   *
   * @see DiscordPresenceSchema.surfaceSubjects in `cortex-config.ts` for the
   * canonical principal-facing description, IoAW examples, and contract.
   */
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  /**
   * MIG-3b / cortex#207: Discord channel id for the bus → chat render
   * fallback. Mirror of the cortex-shape field — `flattenDiscordPresences`
   * threads it through verbatim.
   *
   * @see DiscordPresenceSchema.surfaceFallbackChannelId in `cortex-config.ts`
   * for the canonical principal-facing description.
   */
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type DiscordInstance = z.infer<typeof DiscordInstanceSchema>;

export const MattermostInstanceSchema = z.object({
  /** Unique instance ID. Auto-generated if not provided. */
  instanceId: z.string().optional(),
  /** Whether this instance is active. Default: true. */
  enabled: z.boolean().default(true),
  callbackPort: z.number().int().default(8080),
  triggerWord: z.string().optional(),
  webhookUrl: z.string().optional(),
  apiUrl: z.string().optional(),
  apiToken: z.string().optional(),
  webhookToken: z.string().optional(),
  /** Channel IDs to poll. If empty, uses search API (public channels only). */
  channels: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().positive().default(3000),
  /** Mattermost user IDs allowed to trigger the bot. Empty = allow all. */
  allowedUsers: z.array(z.string()).default([]),
});

export type MattermostInstance = z.infer<typeof MattermostInstanceSchema>;

/**
 * Slack instance (legacy AgentConfig shape). Mirror of
 * `SlackPresenceSchema` in `./cortex-config.ts` — `flattenSlackPresences`
 * in `src/common/config/loader.ts` threads cortex.yaml's
 * `agents[].presence.slack` blocks through to entries of this shape so
 * the boot path in `src/cortex.ts` can iterate `config.slack` uniformly
 * with `config.discord` and `config.mattermost`.
 *
 * See `SlackPresenceSchema` for the canonical field docstrings.
 */
export const SlackInstanceSchema = z.object({
  /** Unique instance ID. Auto-generated if not provided. */
  instanceId: z.string().optional(),
  /** Whether this instance is active. Default: true. */
  enabled: z.boolean().default(true),
  botToken: z.string().regex(/^xoxb-/),
  appToken: z.string().regex(/^xapp-/),
  workspaceId: z.coerce.string().regex(/^T[A-Z0-9]+$/),
  channels: z.array(z.object({
    id: z.string().regex(/^[CG][A-Z0-9]+$/),
    name: z.string().min(1),
  })).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  trustedBotIds: z.array(z.coerce.string()).default([]),
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type SlackInstance = z.infer<typeof SlackInstanceSchema>;

// =============================================================================
// Preprocessing: upgrade legacy flat format → instance arrays
// =============================================================================

/**
 * Accept either a single object (legacy) or an array (new).
 * If a single object is provided, wrap it in an array.
 */
function normalizeToArray(val: unknown): unknown {
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val];
  return [];
}

// =============================================================================
// G-500: Per-network file schemas
// =============================================================================

/**
 * Cloud endpoint configuration for a network.
 *
 * R2.I vocabulary migration (cortex#436) — v4.0.0 BREAKING CUT. The canonical
 * (and only) principal-identity key is `principalId`. The legacy `operatorId`
 * cloud alias that was accepted during the transition release is gone: a block
 * declaring `operatorId` is now rejected as an unknown key (strict object), the
 * same as any other typo. Run `cortex migrate-config <your-config.yaml>` to
 * rewrite a legacy `operatorId:`-shaped config to `principalId:`.
 */
export const NetworkCloudSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().min(1),
  principalId: z.string().min(1),
  cfAccessClientId: z.string().optional(),
  cfAccessClientSecret: z.string().optional(),
}).strict();

/** Per-network Claude security overrides */
export const NetworkClaudeSchema = z.object({
  allowedDirs: z.array(z.string()).default([]),
  readOnlyDirs: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  bashAllowlist: z.object({
    rules: z.array(z.object({
      pattern: z.string(),
      repos: z.array(z.string()).optional(),
    })).default([]),
    repos: z.array(z.string()).default([]),
  }).optional(),
});

/** Per-network GitHub configuration */
export const NetworkGithubSchema = z.object({
  repos: z.array(z.string()).default([]),
  webhookSecret: z.string().default(""),
  /**
   * F-17 — GitHub label that marks a parent issue as a Grove iteration.
   * Defaults to `"iteration"`. The mission-control auto-import path
   * uses this to filter `issues.labeled` webhook events down to the
   * iteration funnel; non-matching labels are no-ops.
   *
   * Per `docs/design-mc-iteration-planning.md` Decision 10 Q6 — the
   * label is explicit (configurable here) so the import surface can't
   * accidentally promote unrelated parent issues. Different networks
   * can run different conventions (e.g. `mc-iteration` vs `iteration`)
   * without a code change.
   */
  iterationLabel: z.string().default("iteration"),
  agentDetection: z.object({
    commitTrailers: z.array(z.string()).default(["Co-Authored-By: Claude"]),
    branchPatterns: z.array(z.string()).default(["^feat/(g|f|i)-\\d+"]),
    commentPatterns: z.array(z.string()).default(["^Starting:", "^Completed:"]),
  }).default({
    commitTrailers: ["Co-Authored-By: Claude"],
    branchPatterns: ["^feat/(g|f|i)-\\d+"],
    commentPatterns: ["^Starting:", "^Completed:"],
  }),
}).default({
  repos: [],
  webhookSecret: "",
  iterationLabel: "iteration",
  agentDetection: {
    commitTrailers: ["Co-Authored-By: Claude"],
    branchPatterns: ["^feat/(g|f|i)-\\d+"],
    commentPatterns: ["^Starting:", "^Completed:"],
  },
});

/**
 * G-500: Network file schema — represents a single networks/*.yaml file.
 */
export const NetworkFileSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "Network ID must be lowercase alphanumeric with hyphens"),
  cloud: NetworkCloudSchema.optional(),
  discord: z.preprocess(normalizeToArray, z.array(DiscordInstanceSchema)).default([]),
  mattermost: z.preprocess(normalizeToArray, z.array(MattermostInstanceSchema)).default([]),
  slack: z.preprocess(normalizeToArray, z.array(SlackInstanceSchema)).default([]),
  github: NetworkGithubSchema,
  claude: NetworkClaudeSchema.optional(),
  operator: z.object({
    operatorDiscordId: z.string().optional(),
    operatorMattermostId: z.string().optional(),
    operatorSlackId: z.string().optional(),
  }).optional(),
});

export type NetworkFile = z.infer<typeof NetworkFileSchema>;

// =============================================================================
// Main config schema
// =============================================================================

/**
 * MC-I1.S1 (ADR-0005): in-process Mission Control embed schema. Extracted as a
 * SHARED const (fix/c-844) so BOTH top-level config schemas reference the same
 * definition — `AgentConfigSchema` (legacy bot.yaml) and `CortexConfigSchema`
 * (the modern config-split shape every live stack loads). Defining it inline on
 * only one schema is exactly how `mc.enabled: true` got silently stripped for
 * every cortex-shape deployment (the strip-by-default parse drops unknown keys).
 * One definition → the two schemas cannot drift again.
 *
 * Embedded mode deliberately overrides db + cursor + port; an MC yaml at
 * `configPath` governs only hooks / ws / log (ADR-0005 §2). Empty `dbPath` /
 * `port` resolve to the per-slug default / the MC yaml's port at boot.
 */
export const McSchema = z.object({
  enabled: z.boolean().default(false),
  /** Optional MC yaml supplying hooks/ws/log settings. Empty → MC defaults. */
  configPath: z.string().default(""),
  /**
   * Absolute (or leading-`~`) db path. Empty → per-slug default at boot.
   * ONE db per stack is required: the hook cursor lands beside the db
   * (`mc-hook-cursor.json`), so two stacks pointed at the same explicit
   * `dbPath` would share — and race — the cursor (and the db itself). The
   * per-slug default keeps stacks isolated; only override with a path unique
   * to this stack.
   */
  dbPath: z.string().default(""),
  /** Listen port. 0 → fall back to the MC yaml's port (default 8767). */
  port: z.number().int().nonnegative().default(0),
}).default(emptyDefault()).transform((val) => ({
  // `.default(emptyDefault())` returns `{}` literally rather than re-parsing
  // the inner defaults, so the fields would be undefined. Re-apply the inner
  // defaults so callers get the populated shape. The `??` chains are
  // load-bearing (not redundant) for the all-defaults parse path.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  enabled: val.enabled ?? false,
  configPath: val.configPath ?? "",
  dbPath: val.dbPath ?? "",
  port: val.port ?? 0,
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}));

/**
 * G-1113 ML.5: Mission Control Cockpit live-refresh schema. SHARED const
 * (fix/c-844) for the same reason as {@link McSchema} — referenced by both
 * `AgentConfigSchema` and `CortexConfigSchema` so the cockpit block survives
 * the cortex-shape parse. When `enabled`, the bot runs `refreshCockpit` on
 * `refreshIntervalMs` (plan-doc ingestion → work-item ingestion → attention
 * reconcile) and publishes `system.attention.*` notifications; `attention.
 * channel` is the review-sink destination those render to (empty → notifications
 * stay on the bus but aren't routed).
 */
export const CockpitSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path to the plan/iteration docs dir (relative to cwd or absolute). */
  docsDir: z.string().default("docs"),
  /** Default repo ("owner/name") for short umbrella refs + doc URLs. */
  repo: z.string().default(""),
  /** Refresh interval in ms (default 5 min). */
  refreshIntervalMs: z.number().int().positive().default(300_000),
  /** Attention notification destination (the review-sink's attentionRouting). */
  attention: z.object({
    surface: z.string().default("discord"),
    channel: z.string().default(""),
    thread: z.string().optional(),
  }).default(emptyDefault()),
}).default(emptyDefault()).transform((val) => ({
  // `.default(emptyDefault())` returns `{}` literally rather than re-parsing
  // the inner defaults, so `cockpit.attention` would be undefined. Re-apply the
  // inner defaults so callers get the populated shape. The `??` chains are
  // load-bearing (not redundant) for the all-defaults parse path.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  enabled: val.enabled ?? false,
  docsDir: val.docsDir ?? "docs",
  repo: val.repo ?? "",
  refreshIntervalMs: val.refreshIntervalMs ?? 300_000,
  attention: {
    surface: val.attention?.surface ?? "discord",
    channel: val.attention?.channel ?? "",
    ...(val.attention?.thread !== undefined && { thread: val.attention.thread }),
  },
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}));

export const AgentConfigSchema = z.object({
  agent: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    /**
     * cortex#429 PR-C (deprecation graduation) — `agent.operatorId` and
     * `agent.operatorName` were the legacy v2 fields carrying the principal
     * identity. cortex#427 PR-A migrated every read site to the v3-canonical
     * `principal.id` (surfaced via `LoadedConfig.principal`). cortex#429 PR-C
     * drops the fields entirely; configs that still declare them will see
     * Zod strip them silently (no schema error — Zod default mode) and any
     * downstream consumer that still expects them needs to be re-migrated.
     *
     * v2.0.0 cutover (cortex#297) — `operatorDiscordId/Mattermost/Slack` retired.
     * The principal's platform-side ids live on `PrincipalConfigSchema.discordId/mattermostId/slackId`
     * in cortex-config.ts and are surfaced through `LoadedConfig.principal` for the
     * boot path. Runtime "is this principal an operator?" decisions consult the
     * PolicyEngine via the `operator` capability per the new model.
     */
    /** Principal data residency stamped into `sovereignty.data_residency` on emitted
     *  envelopes (system.*, dispatch.task.*, cc.*). ISO-3166 country code; defaults
     *  to "NZ" when omitted. Principals in AU/EU/US/etc. set this to match their
     *  jurisdiction so envelopes accurately reflect residency for compliance audits. */
    dataResidency: z.string().optional(),
  }),

  /** Discord instances — accepts a single object (legacy) or array (multi-instance) */
  discord: z.preprocess(
    normalizeToArray,
    z.array(DiscordInstanceSchema),
  ),

  /** Mattermost instances — accepts a single object (legacy) or array (multi-instance) */
  mattermost: z.preprocess(
    normalizeToArray,
    z.array(MattermostInstanceSchema).default([]),
  ),

  /**
   * Slack instances — synthesized from `agents[].presence.slack` by the
   * cortex.yaml loader. Empty by default so legacy bot.yaml deployments
   * (which never declared Slack) keep parsing unchanged.
   */
  slack: z.preprocess(
    normalizeToArray,
    z.array(SlackInstanceSchema).default([]),
  ),

  claude: z.object({
    timeoutMs: z.number().int().positive().default(120_000),
    /** Timeout for async: and team: tasks (default: 15 minutes). These run longer than chat. */
    asyncTimeoutMs: z.number().int().positive().default(900_000),
    additionalArgs: z.array(z.string()).default([]),
    /** Tools to allow when invoked from chat. Empty = no restriction. */
    allowedTools: z.array(z.string()).default([]),
    /** Tools to deny when invoked from chat. Applied on top of allowedTools. */
    disallowedTools: z.array(z.string()).default([]),
    /** Bash command allowlist for Grove sessions. When set, only matching commands are allowed.
     *  Each rule has a regex pattern and optional repo whitelist (for gh CLI).
     *  Requires Bash NOT in disallowedTools. Enforced by bash-guard.hook.ts. */
    bashAllowlist: z.object({
      rules: z.array(z.object({
        pattern: z.string(),
        repos: z.array(z.string()).optional(),
      })).default([]),
      /** Global repo whitelist — applies to all gh commands without per-rule repos. */
      repos: z.array(z.string()).default([]),
    }).optional(),
    /** Directories the agent can access (read+write). Empty = unrestricted. Passed as --add-dir. */
    allowedDirs: z.array(z.string()).default([]),
    /** Directories the agent can read but not modify. Also passed as --add-dir, with write restriction enforced via security preamble. */
    readOnlyDirs: z.array(z.string()).default([]),
  }),

  attachments: z.object({
    /** Enable attachment support. Default: true. */
    enabled: z.boolean().default(true),
    /** Max file size per attachment in bytes. Default: 10MB. */
    maxFileSizeBytes: z.number().int().positive().default(10 * 1024 * 1024),
    /** Max total attachment size per message in bytes. Default: 25MB. */
    maxTotalSizeBytes: z.number().int().positive().default(25 * 1024 * 1024),
    /** Max number of attachments per message. Default: 10. */
    maxAttachmentsPerMessage: z.number().int().positive().default(10),
  }).default(emptyDefault()),

  execution: z.object({
    /** Default backend name. Default: "local". */
    default: z.string().default("local"),
    /** Future: remote backend configurations */
    backends: z.array(z.object({
      name: z.string(),
      type: z.enum(["cloudflare", "e2b", "ssh", "custom"]),
      endpoint: z.string(),
    })).default([]),
  }).default(emptyDefault()),

  /** G-203b: GitHub webhook ingestion */
  github: z.object({
    /**
     * Webhook secret for HMAC signature verification. If empty, webhooks are disabled.
     * G-404: In cloud mode, the Worker has its own webhook secret — this field is not
     * needed locally. Still accepted for local mode where the bot handles webhooks directly.
     */
    webhookSecret: z.string().default(""),
    /** Repos to accept webhook events from (allowlist). Format: "owner/repo". */
    repos: z.array(z.string()).default([]),
    /** Agent attribution heuristics */
    agentDetection: z.object({
      /** Strings to match in commit messages (e.g. "Co-Authored-By: Claude") */
      commitTrailers: z.array(z.string()).default(["Co-Authored-By: Claude"]),
      /** Regex patterns for agent-created branches (e.g. "^feat/(g|f|i)-\\d+") */
      branchPatterns: z.array(z.string()).default(["^feat/(g|f|i)-\\d+"]),
      /** Regex patterns for agent issue comments (e.g. "^Starting:", "^Completed:") */
      commentPatterns: z.array(z.string()).default(["^Starting:", "^Completed:"]),
    }).default(emptyDefault()),
    /**
     * MIG-5.6 (C-106): Local HTTP receiver that publishes webhook payloads
     * as `local.{principal}.github.{event}.{action}` envelopes onto the bus.
     *
     * Opt-in: only started when `enabled: true` AND `webhookSecret` is set
     * (the secret is required for HMAC re-verification at the local hop).
     * The default hostname is `127.0.0.1` — never expose to LAN/internet
     * without an explicit override (HMAC is the only auth).
     */
    receiver: z.object({
      /** Whether to start the local receiver. Default false (opt-in). */
      enabled: z.boolean().default(false),
      /** TCP port to bind. Default 8770. */
      port: z.number().int().positive().default(8770),
      /** Hostname to bind. Default `127.0.0.1` — never `0.0.0.0` unless explicitly chosen. */
      hostname: z.string().default("127.0.0.1"),
    }).default(emptyDefault()),
  }).default(emptyDefault()).transform((val) => ({
    // Zod v4's `.default(value)` returns `value` literally when input is
    // undefined — it does NOT re-parse the default through the inner
    // schema. So even though every inner field has its own `.default(...)`,
    // the parent's `.default(emptyDefault())` produces `{}` at runtime,
    // not the populated shape. This transform manually re-applies the
    // inner defaults so callers get the populated shape regardless of
    // input. The `??` chains LOOK defensive (and the typed-checked lint
    // rules flag them as such), but they're load-bearing — without them,
    // `bot.github.agentDetection` parses as `{}`, breaking
    // cortex-config.test.ts MIRROR sync. Suppressed locally; the
    // `emptyDefault()` runtime quirk is the root cause to fix here, not
    // the defensive `??` checks.
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    webhookSecret: val.webhookSecret ?? "",
    repos: val.repos ?? [],
    agentDetection: {
      commitTrailers: val.agentDetection?.commitTrailers ?? ["Co-Authored-By: Claude"],
      branchPatterns: val.agentDetection?.branchPatterns ?? ["^feat/(g|f|i)-\\d+"],
      commentPatterns: val.agentDetection?.commentPatterns ?? ["^Starting:", "^Completed:"],
    },
    receiver: {
      enabled: val.receiver?.enabled ?? false,
      port: val.receiver?.port ?? 8770,
      hostname: val.receiver?.hostname ?? "127.0.0.1",
    },
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })),

  /** G-201: Dashboard API configuration (local dashboard — cloud fields moved to network files) */
  api: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().default(8766),
    corsOrigin: z.string().default("*"),
    mode: z.enum(["local", "cloud"]).default("local"),
    // Legacy cloud fields — kept for backward compat, migrated to network files by config-loader.
    // R2.I (cortex#436): `operatorId` here is the LEGACY flat `api.*` key. It is
    // intentionally NOT renamed — this block is the backward-compat reader, and
    // `buildLegacyNetwork` rewrites it to the canonical cloud `principalId` when
    // synthesising the default network. New configs use per-network `cloud.principalId`.
    endpoint: z.string().default(""),
    apiKey: z.string().default(""),
    operatorId: z.string().default(""),
    cfAccessClientId: z.string().default(""),
    cfAccessClientSecret: z.string().default(""),
  }).default(emptyDefault()),

  /**
   * MC-I1.S1 (ADR-0005): in-process Mission Control embed. Supersedes the dead
   * `api.*` embedded-dashboard path (#712). OFF by default (opt-in) so existing
   * deployments are unchanged. When `enabled`, `startCortex` boots the MC v3
   * server in-process (see `src/surface/mc/embed.ts`).
   *
   * Embedded mode deliberately overrides db + cursor + port; an MC yaml at
   * `configPath` governs only hooks / ws / log (ADR-0005 §2). Empty `dbPath` /
   * `port` resolve to the per-slug default / the MC yaml's port at boot.
   */
  mc: McSchema,

  paths: z.object({
    publishedEventsDir: z.string().default("~/.claude/events/published"),
    logDir: z.string().default("~/.config/grove/logs"),
  }).default(emptyDefault()),

  /**
   * F-11: Grove platform-level config (cross-cutting, not bound to a
   * single platform adapter). See
   * `docs/design-mc-f11-discord-notifications.md` Decision 6.
   *
   * - `notifications.discord` — master toggle for the F-11 Discord push
   *   surface. Default `false`; explicit off-by-default avoids
   *   surprising principals with a DM torrent after a fresh install.
   * - `baseUrl` — used to build dashboard deep links in notification
   *   bodies. Tier 1 default `http://localhost:8766`; Tier 2 should set
   *   `https://grove.meta-factory.ai`. When unset on Tier 2, F-11
   *   renders the deep link as a plain assignment id with a one-line
   *   warning instead of crashing.
   */
  grove: z.object({
    notifications: z.object({
      discord: z.boolean().default(false),
    }).default(emptyDefault()),
    baseUrl: z.string().default(""),
  }).default(emptyDefault()),

  /**
   * G-1113 ML.5: Mission Control Cockpit live-refresh. OFF by default (opt-in)
   * so existing deployments are unchanged. When `enabled`, the bot runs
   * `refreshCockpit` on `refreshIntervalMs` (plan-doc ingestion → work-item
   * ingestion → attention reconcile) and publishes `system.attention.*`
   * notifications; `attention.channel` is the review-sink destination those
   * render to (empty → notifications stay on the bus but aren't routed).
   */
  cockpit: CockpitSchema,

  /**
   * TC-0 (Trust & Confidentiality, #628): unified security posture toggles.
   * Shared schema (`SecurityPostureSchema`) so the cortex.yaml shape
   * (`CortexConfigSchema.security`) and this legacy-bot.yaml shape stay in
   * lockstep — same source of truth, no silent-strip drift. See the schema's
   * own docstring above for the per-toggle semantics.
   */
  security: SecurityPostureSchema,

  /** G-500: Directory containing per-network YAML files */
  networksDir: z.string().default("./networks"),

  /** G-500: Loaded network configurations (populated by config-loader) */
  networks: z.array(NetworkFileSchema).default([]),

  /**
   * G-1100: NATS / myelin subscriber configuration. Optional — the bot
   * remains installable without NATS configured (per design doc §9
   * coupling rules); when absent, no subscriber is started and grove
   * runs as before. When `url` is present, the bot subscribes to each
   * pattern in `subjects` (default `local.{principal}.>`) and logs received
   * envelopes. Fan-out to specific event handlers lands in subsequent
   * features (G-1101 pilot errand projection, etc.).
   */
  nats: z.object({
    /** NATS server URL — `nats://localhost:4222` for local development. */
    url: z.string().min(1).refine(
      (s) => s.startsWith("nats://") || s.startsWith("tls://"),
      { message: "nats.url must start with nats:// or tls://" },
    ),
    /** Bearer token for connect-time auth. Optional. */
    token: z.string().optional(),
    /** Connection name surfaced on the server's varz endpoint. */
    name: z.string().default("cortex"),
    /**
     * Subject patterns to subscribe to. Default empty — caller must
     * provide at least one pattern when enabling NATS. The placeholder
     * `{principal}` is substituted with the boot-resolved `principal.id`
     * at runtime so a single template works across principals.
     *
     * MIRROR: `NatsConfigSchema.subjects` in `./cortex-config.ts`. Both use
     * the shared `NatsSubjectsSchema` (IAW CFG.b.3) so a malformed or
     * duplicate pattern fails loudly at load on either config shape.
     */
    subjects: NatsSubjectsSchema,
    /**
     * Absolute path to operator account signing nkey file. Loaded into
     * daemon memory only. File MUST be chmod 600 (loader enforces).
     * Optional — when absent, cortex creds mutation subcommands return
     * exit 2.
     *
     * MIRROR: `NatsConfigSchema.accountSigningKeyPath` in
     * `./cortex-config.ts`. Drop both on MIG-7.2e.
     */
    accountSigningKeyPath: z.string().optional(),
    /**
     * cortex#86 — path to a NATS user `.creds` file for operator-mode
     * connect auth. See `NatsConfigSchema.credsPath` in `./cortex-config.ts`
     * for the canonical docstring; this entry MIRRORS the field so that
     * the migrate-config loader can synthesize an AgentConfig from cortex.yaml
     * without stripping the creds path. Drop both on MIG-7.2e.
     */
    credsPath: z.string().optional(),
    /**
     * MIG-7.2e: NKey identity for envelope signing (MY-400). Optional.
     * Mirror of `NatsConfigSchema.identity` in `./cortex-config.ts` so the
     * loader can synthesize an AgentConfig from cortex.yaml without stripping
     * the identity block. Legacy bot.yaml deployments never set this;
     * cortex.yaml deployments always do.
     */
    identity: z.object({
      seedPath: z.string().min(1),
      publicKey: z.string().regex(
        NKEY_PUBKEY_REGEX,
        "publicKey must be a 56-char NKey user identifier (U + 55 base32 chars)",
      ),
    }).optional(),
  }).optional(),

  /**
   * MIG-7.2d: optional `renderers[]` block for non-agent-bound surfaces
   * (dashboard, pagerduty, …). Additive on the legacy `AgentConfig` so an
   * existing `bot.yaml` keeps loading unchanged; cortex.yaml (post-7.2e
   * migrate-config) emits this field directly off the cortex-config
   * schema. The shape passes through Zod via `z.unknown()` and the
   * stricter parse happens inside `createRenderer` (each variant is its
   * own `RendererSchema` block); a typo at this layer surfaces at the
   * factory rather than at config load.
   */
  renderers: z.array(z.unknown()).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// =============================================================================
// G-501: Network-aware routing types
// =============================================================================

/**
 * Network configuration for event routing.
 * Represents a single network's cloud endpoint, API key, and principal identity.
 */
export interface NetworkConfig {
  /** Network identifier (e.g. "metafactory", "default") */
  id: string;
  /** Cloud Worker endpoint URL */
  endpoint: string;
  /** API key for this network */
  apiKey: string;
  /** Principal ID for event attribution (R2.I rename of legacy `operatorId`) */
  principalId: string;
  /** S-001: CF Access service token for machine-to-machine auth (optional) */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/**
 * Function type for resolving network config by network_id.
 * Used by CloudPublisher to look up endpoint/apiKey/principalId.
 * Returns null if network_id is unknown.
 */
export type NetworkResolver = (networkId: string | undefined) => NetworkConfig | null;

// =============================================================================
// Helpers: backward-compat accessors for code that expects flat config.discord
// =============================================================================

/**
 * Build a "scoped" AgentConfig where `discord` contains a single instance's config.
 * v2.0.0 (cortex#297) — the legacy role-resolver retired; this scoping helper
 * survives for adapters / discord-client code that reads `config.discord[0].guildId`
 * etc. Authorisation flows through `policy:` block now.
 */
export function scopeConfigToDiscordInstance(config: AgentConfig, instance: DiscordInstance): AgentConfig {
  return { ...config, discord: [instance] };
}

export function scopeConfigToMattermostInstance(config: AgentConfig, instance: MattermostInstance): AgentConfig {
  return { ...config, mattermost: [instance] };
}

export function scopeConfigToSlackInstance(config: AgentConfig, instance: SlackInstance): AgentConfig {
  return { ...config, slack: [instance] };
}

/**
 * Get the first Discord instance config (for backward-compat code that
 * expects `config.discord.*` as a flat object). Returns undefined if no instances.
 */
export function getFirstDiscordInstance(config: AgentConfig): DiscordInstance | undefined {
  return config.discord[0];
}

export function getFirstMattermostInstance(config: AgentConfig): MattermostInstance | undefined {
  return config.mattermost[0];
}

export function getFirstSlackInstance(config: AgentConfig): SlackInstance | undefined {
  return config.slack[0];
}

/**
 * Aggregate GitHub repos from top-level config AND all network configs.
 * Returns a deduplicated array of "owner/repo" strings.
 */
export function getAllRepos(config: AgentConfig): string[] {
  const repos = new Set<string>(config.github.repos);
  for (const network of config.networks) {
    for (const repo of network.github.repos) {
      repos.add(repo);
    }
  }
  return [...repos];
}
