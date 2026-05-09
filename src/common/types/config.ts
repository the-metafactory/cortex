/**
 * F-007: Bot Configuration Types
 *
 * Supports both legacy flat format and new instance-list format:
 *   Legacy:  discord: { token: "...", guildId: "..." }
 *   New:     discord: [{ instanceId: "main", token: "...", guildId: "..." }]
 */

import { z } from "zod/v4";

// =============================================================================
// Role schema (shared across platforms)
// =============================================================================

/** Role-based access control for platform users */
export const RoleSchema = z.object({
  /** Role name (e.g. "operator", "user", "viewer") */
  name: z.string().min(1),
  /** User IDs assigned to this role */
  users: z.array(z.string()).default([]),
  /** Features this role can use. Default: ["chat"] */
  features: z.array(z.enum(["chat", "async", "team"])).default(["chat"]),
  /** Additional tools to deny for this role (merged with global claude.disallowedTools) */
  disallowedTools: z.array(z.string()).optional(),
  /** Override allowedDirs for this role. If set, replaces global claude.allowedDirs. */
  allowedDirs: z.array(z.string()).optional(),
  /** G-121: Skills this role may invoke. absent/null → all allowed; [] → none allowed; [...] → only listed. */
  allowedSkills: z.array(z.string()).optional(),
});

// Keep backward-compat alias
export const DiscordRoleSchema = RoleSchema;
export type DiscordRole = z.infer<typeof RoleSchema>;

// =============================================================================
// Instance schemas (new: each platform entry is an instance)
// =============================================================================

/** G-300: DM role configuration */
export const DMRoleSchema = z.object({
  features: z.array(z.enum(["chat", "async", "team"])).default(["chat"]),
  disallowedTools: z.array(z.string()).default([]),
  allowedDirs: z.array(z.string()).optional(),
  /** G-121: Skills this role may invoke. absent/null → all allowed; [] → none allowed; [...] → only listed. */
  allowedSkills: z.array(z.string()).optional(),
  /** Whether bash guard is active for this DM role. Default: true. */
  bashGuard: z.boolean().default(true),
  /** Override bash allowlist for this DM role. If set, replaces global claude.bashAllowlist. */
  bashAllowlist: z.object({
    rules: z.array(z.object({
      pattern: z.string(),
      repos: z.array(z.string()).optional(),
    })).default([]),
    repos: z.array(z.string()).default([]),
  }).optional(),
});

export type DMRole = z.infer<typeof DMRoleSchema>;

/** G-300: Per-user DM role override */
export const DMUserRoleSchema = z.object({
  users: z.array(z.string()),
  features: z.array(z.enum(["chat", "async", "team"])).default(["chat"]),
  disallowedTools: z.array(z.string()).default([]),
  allowedDirs: z.array(z.string()).optional(),
  /** G-121: Skills this role may invoke. absent/null → all allowed; [] → none allowed; [...] → only listed. */
  allowedSkills: z.array(z.string()).optional(),
  bashGuard: z.boolean().default(true),
});

/**
 * G-300: DM configuration section.
 *
 * Defaults provide safe-by-default behavior:
 * - operatorRole: full feature access, bash guard ON (override via bashAllowlist)
 * - defaultRole: "denied" — unknown DMs silently ignored
 * - userRoles: empty — no per-user overrides
 *
 * The operator is identified by agent.operatorDiscordId in bot.yaml.
 * If not set, no DM user is treated as operator.
 */
export const DMConfigSchema = z.object({
  /** Role applied to operator DMs. Full access by default, bash guard stays active with relaxed rules. */
  operatorRole: DMRoleSchema.default({
    features: ["chat", "async", "team"],
    disallowedTools: [],
    bashGuard: true,
  }),
  /** Role applied to unknown DMs. "denied" = silently ignore. */
  defaultRole: z.enum(["denied", "allow-all"]).default("denied"),
  /** Per-user DM role overrides */
  userRoles: z.array(DMUserRoleSchema).default([]),
});

export type DMConfig = z.infer<typeof DMConfigSchema>;

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
  /** Role-based access control. If empty, all users get full access (backward compat). */
  roles: z.array(RoleSchema).default([]),
  /** Role applied to users not listed in any role. "denied" = reject, or a role name. Default: allow all. */
  defaultRole: z.string().default("allow-all"),
  /** G-300: DM privilege configuration */
  dm: DMConfigSchema.default({} as any),
  /**
   * F-11: Optional Discord role id to mention on high-priority block
   * notifications. When set, channel posts marked `severity = 'ping'`
   * render `<@&{operatorRoleId}>` in the body. When unset (default),
   * those notifications render as plain channel posts with no mention.
   * See `docs/design-mc-f11-discord-notifications.md` Decision 5.
   */
  operatorRoleId: z.coerce.string().optional(),
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
  /** Role-based access control. If empty, falls back to allowedUsers (backward compat). */
  roles: z.array(RoleSchema).default([]),
  /** Role applied to users not listed in any role. Default: allow all. */
  defaultRole: z.string().default("allow-all"),
});

export type MattermostInstance = z.infer<typeof MattermostInstanceSchema>;

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

/** Cloud endpoint configuration for a network */
export const NetworkCloudSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().min(1),
  operatorId: z.string().min(1),
  cfAccessClientId: z.string().optional(),
  cfAccessClientSecret: z.string().optional(),
});

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
  github: NetworkGithubSchema,
  claude: NetworkClaudeSchema.optional(),
  operator: z.object({
    operatorDiscordId: z.string().optional(),
    operatorMattermostId: z.string().optional(),
  }).optional(),
});

export type NetworkFile = z.infer<typeof NetworkFileSchema>;

// =============================================================================
// Main config schema
// =============================================================================

export const BotConfigSchema = z.object({
  agent: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    /** Operator identity — groups agents sharing a subscription. Used in both local and cloud mode. */
    operatorId: z.string().optional(),
    /** Display name for the operator (shown on dashboard). Defaults to operatorId. */
    operatorName: z.string().optional(),
    /** Operator's Discord user ID — receives DM notifications when others talk to the bot */
    operatorDiscordId: z.string().optional(),
    /** Operator's Mattermost user ID — receives DM notifications when others talk to the bot */
    operatorMattermostId: z.string().optional(),
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
  }).default({} as any),

  execution: z.object({
    /** Default backend name. Default: "local". */
    default: z.string().default("local"),
    /** Future: remote backend configurations */
    backends: z.array(z.object({
      name: z.string(),
      type: z.enum(["cloudflare", "e2b", "ssh", "custom"]),
      endpoint: z.string(),
    })).default([]),
  }).default({ default: "local" } as any),

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
    }).default({} as any),
  }).default({} as any).transform((val) => ({
    webhookSecret: val.webhookSecret ?? "",
    repos: val.repos ?? [],
    agentDetection: {
      commitTrailers: val.agentDetection?.commitTrailers ?? ["Co-Authored-By: Claude"],
      branchPatterns: val.agentDetection?.branchPatterns ?? ["^feat/(g|f|i)-\\d+"],
      commentPatterns: val.agentDetection?.commentPatterns ?? ["^Starting:", "^Completed:"],
    },
  })),

  /** G-201: Dashboard API configuration (local dashboard — cloud fields moved to network files) */
  api: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().default(8766),
    corsOrigin: z.string().default("*"),
    mode: z.enum(["local", "cloud"]).default("local"),
    // Legacy cloud fields — kept for backward compat, migrated to network files by config-loader
    endpoint: z.string().default(""),
    apiKey: z.string().default(""),
    operatorId: z.string().default(""),
    cfAccessClientId: z.string().default(""),
    cfAccessClientSecret: z.string().default(""),
  }).default({} as any),

  paths: z.object({
    publishedEventsDir: z.string().default("~/.claude/events/published"),
    logDir: z.string().default("~/.config/grove/logs"),
  }).default({} as any),

  /**
   * F-11: Grove platform-level config (cross-cutting, not bound to a
   * single platform adapter). See
   * `docs/design-mc-f11-discord-notifications.md` Decision 6.
   *
   * - `notifications.discord` — master toggle for the F-11 Discord push
   *   surface. Default `false`; explicit off-by-default avoids
   *   surprising operators with a DM torrent after a fresh install.
   * - `baseUrl` — used to build dashboard deep links in notification
   *   bodies. Tier 1 default `http://localhost:8766`; Tier 2 should set
   *   `https://grove.meta-factory.ai`. When unset on Tier 2, F-11
   *   renders the deep link as a plain assignment id with a one-line
   *   warning instead of crashing.
   */
  grove: z.object({
    notifications: z.object({
      discord: z.boolean().default(false),
    }).default({ discord: false } as any),
    baseUrl: z.string().default(""),
  }).default({} as any),

  /** G-500: Directory containing per-network YAML files */
  networksDir: z.string().default("./networks"),

  /** G-500: Loaded network configurations (populated by config-loader) */
  networks: z.array(NetworkFileSchema).default([]),

  /**
   * G-1100: NATS / myelin subscriber configuration. Optional — the bot
   * remains installable without NATS configured (per design doc §9
   * coupling rules); when absent, no subscriber is started and grove
   * runs as before. When `url` is present, the bot subscribes to each
   * pattern in `subjects` (default `local.{org}.>`) and logs received
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
    name: z.string().default("grove-bot"),
    /**
     * Subject patterns to subscribe to. Default empty — caller must
     * provide at least one pattern when enabling NATS. The placeholder
     * `{org}` is substituted with `agent.operatorId` at runtime so a
     * single template works across operators.
     */
    subjects: z.array(z.string().min(1)).default([]),
  }).optional(),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

// =============================================================================
// G-501: Network-aware routing types
// =============================================================================

/**
 * Network configuration for event routing.
 * Represents a single network's cloud endpoint, API key, and operator identity.
 */
export interface NetworkConfig {
  /** Network identifier (e.g. "metafactory", "default") */
  id: string;
  /** Cloud Worker endpoint URL */
  endpoint: string;
  /** API key for this network */
  apiKey: string;
  /** Operator ID for event attribution */
  operatorId: string;
  /** S-001: CF Access service token for machine-to-machine auth (optional) */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/**
 * Function type for resolving network config by network_id.
 * Used by CloudPublisher to look up endpoint/apiKey/operatorId.
 * Returns null if network_id is unknown.
 */
export type NetworkResolver = (networkId: string | undefined) => NetworkConfig | null;

// =============================================================================
// Helpers: backward-compat accessors for code that expects flat config.discord
// =============================================================================

/**
 * Build a "scoped" BotConfig where `discord` contains a single instance's config.
 * This lets existing modules (role-resolver, discord-client, etc.) that read
 * `config.discord.roles` or `config.discord.guildId` work without changes.
 *
 * Usage in adapters:
 *   const scopedConfig = scopeConfigToDiscordInstance(botConfig, instance);
 *   resolveRole(userId, scopedConfig); // reads scopedConfig.discord[0].roles
 */
export function scopeConfigToDiscordInstance(config: BotConfig, instance: DiscordInstance): BotConfig {
  return { ...config, discord: [instance] };
}

export function scopeConfigToMattermostInstance(config: BotConfig, instance: MattermostInstance): BotConfig {
  return { ...config, mattermost: [instance] };
}

/**
 * Get the first Discord instance config (for backward-compat code that
 * expects `config.discord.*` as a flat object). Returns undefined if no instances.
 */
export function getFirstDiscordInstance(config: BotConfig): DiscordInstance | undefined {
  return config.discord[0];
}

export function getFirstMattermostInstance(config: BotConfig): MattermostInstance | undefined {
  return config.mattermost[0];
}

/**
 * Aggregate GitHub repos from top-level config AND all network configs.
 * Returns a deduplicated array of "owner/repo" strings.
 */
export function getAllRepos(config: BotConfig): string[] {
  const repos = new Set<string>(config.github.repos);
  for (const network of config.networks) {
    if (network.github?.repos) {
      for (const repo of network.github.repos) {
        repos.add(repo);
      }
    }
  }
  return [...repos];
}
