/**
 * F-092: Config Hot-Reload
 * Watches bot.yaml for changes and applies safe fields without restart.
 */

import { watch, type FSWatcher, existsSync } from "fs";
import { loadConfig } from "./loader";
import type { BotConfig } from "../types/config";

export interface ConfigChangeEvent {
  /** Fields that were applied without requiring restart */
  applied: string[];
  /** Fields that changed but require restart */
  requiresRestart: string[];
  /** New config (already applied to the watcher's internal state) */
  config: BotConfig;
}

export type ConfigChangeHandler = (event: ConfigChangeEvent) => void;

/**
 * Fields safe to hot-reload (no connection restart needed).
 * Changes to these fields are applied immediately.
 */
const SAFE_FIELDS = new Set([
  // Claude execution config
  "claude.timeoutMs",
  "claude.asyncTimeoutMs",
  "claude.additionalArgs",
  "claude.allowedTools",
  "claude.disallowedTools",
  "claude.bashAllowlist",
  "claude.allowedDirs",
  "claude.readOnlyDirs",

  // Discord instance config (per instance)
  "discord.contextDepth",
  "discord.enableAgentLog",
  "discord.worklogChannelId",
  "discord.roles",
  "discord.defaultRole",
  "discord.dm",

  // Mattermost instance config (per instance)
  "mattermost.channels",
  "mattermost.allowedUsers",
  "mattermost.roles",
  "mattermost.defaultRole",
  "mattermost.pollIntervalMs",

  // Attachments
  "attachments.enabled",
  "attachments.maxFileSizeBytes",
  "attachments.maxTotalSizeBytes",
  "attachments.maxAttachmentsPerMessage",

  // GitHub config
  "github.webhookSecret",
  "github.repos",
  "github.agentDetection",

  // API config (port changes need reconnect warning)
  "api.corsOrigin",

  // Agent identity
  "agent.displayName",
  "agent.operatorName",
]);

/**
 * Fields that require a full restart.
 * Changes to these fields are logged but NOT applied.
 */
const RESTART_FIELDS = new Set([
  // Connection credentials
  "discord.token",
  "discord.guildId",
  "discord.agentChannelId",
  "discord.logChannelId",
  "mattermost.apiUrl",
  "mattermost.apiToken",
  "mattermost.webhookUrl",
  "mattermost.webhookToken",

  // API connection
  "api.enabled",
  "api.port",
  "api.mode",
  "api.endpoint",
  "api.apiKey",

  // Agent core identity
  "agent.name",
  "agent.operatorId",
  "agent.operatorDiscordId",
  "agent.operatorMattermostId",

  // Execution backend
  "execution.default",
  "execution.backends",

  // Paths
  "paths.publishedEventsDir",
  "paths.logDir",
]);

/**
 * Compare two config objects and determine which fields changed.
 * Returns:
 * - applied: fields safe to hot-reload
 * - requiresRestart: fields requiring restart
 */
function compareConfigs(oldConfig: BotConfig, newConfig: BotConfig): {
  applied: string[];
  requiresRestart: string[];
} {
  const applied: string[] = [];
  const requiresRestart: string[] = [];

  // Helper: deep compare two values
  const isDifferent = (a: unknown, b: unknown): boolean => {
    if (a === b) return false;
    if (typeof a !== typeof b) return true;
    if (a === null || b === null) return a !== b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return true;
      return a.some((item, i) => isDifferent(item, b[i]));
    }
    if (typeof a === "object" && typeof b === "object") {
      const aKeys = Object.keys(a as object);
      const bKeys = Object.keys(b as object);
      if (aKeys.length !== bKeys.length) return true;
      return aKeys.some((key) => isDifferent((a as any)[key], (b as any)[key]));
    }
    return true;
  };

  // Check top-level fields
  const checkField = (path: string, oldVal: unknown, newVal: unknown) => {
    if (!isDifferent(oldVal, newVal)) return;

    if (SAFE_FIELDS.has(path)) {
      applied.push(path);
    } else if (RESTART_FIELDS.has(path)) {
      requiresRestart.push(path);
    } else {
      // Unknown field — be conservative, require restart
      requiresRestart.push(path);
    }
  };

  // Agent fields
  if (isDifferent(oldConfig.agent, newConfig.agent)) {
    for (const key of Object.keys(newConfig.agent)) {
      checkField(`agent.${key}`, (oldConfig.agent as any)[key], (newConfig.agent as any)[key]);
    }
  }

  // Claude fields
  if (isDifferent(oldConfig.claude, newConfig.claude)) {
    for (const key of Object.keys(newConfig.claude)) {
      checkField(`claude.${key}`, (oldConfig.claude as any)[key], (newConfig.claude as any)[key]);
    }
  }

  // Attachments fields
  if (isDifferent(oldConfig.attachments, newConfig.attachments)) {
    for (const key of Object.keys(newConfig.attachments)) {
      checkField(`attachments.${key}`, (oldConfig.attachments as any)[key], (newConfig.attachments as any)[key]);
    }
  }

  // GitHub fields
  if (isDifferent(oldConfig.github, newConfig.github)) {
    for (const key of Object.keys(newConfig.github)) {
      checkField(`github.${key}`, (oldConfig.github as any)[key], (newConfig.github as any)[key]);
    }
  }

  // API fields
  if (isDifferent(oldConfig.api, newConfig.api)) {
    for (const key of Object.keys(newConfig.api)) {
      checkField(`api.${key}`, (oldConfig.api as any)[key], (newConfig.api as any)[key]);
    }
  }

  /**
   * Compare old and new instance arrays, detect added/removed/changed instances.
   */
  const compareInstanceArrays = <T extends Record<string, unknown>>(
    oldInstances: T[],
    newInstances: T[],
    platformName: string,
    getInstanceId: (inst: T) => string
  ): void => {
    const oldMap = new Map(oldInstances.map((inst) => [getInstanceId(inst), inst]));
    const newMap = new Map(newInstances.map((inst) => [getInstanceId(inst), inst]));

    for (const [id, newInst] of newMap) {
      const oldInst = oldMap.get(id);
      if (!oldInst) {
        requiresRestart.push(`${platformName}[${id}]`);
        continue;
      }
      for (const key of Object.keys(newInst)) {
        if (key === "instanceId") continue;
        checkField(`${platformName}.${key}`, (oldInst as any)[key], (newInst as any)[key]);
      }
    }

    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        requiresRestart.push(`${platformName}[${id}] (removed)`);
      }
    }
  };

  // Discord instances
  compareInstanceArrays(
    oldConfig.discord,
    newConfig.discord,
    "discord",
    (inst) => (inst as any).instanceId ?? (inst as any).guildId
  );

  // Mattermost instances
  compareInstanceArrays(
    oldConfig.mattermost,
    newConfig.mattermost,
    "mattermost",
    (inst) => (inst as any).instanceId ?? "default"
  );

  return { applied, requiresRestart };
}

/**
 * Watches bot.yaml for changes and triggers reload events.
 */
export class ConfigWatcher {
  private configPath: string;
  private config: BotConfig;
  private handler: ConfigChangeHandler;
  private watcher: FSWatcher | null = null;
  private reloadTimeout: NodeJS.Timeout | null = null;

  constructor(configPath: string, initialConfig: BotConfig, handler: ConfigChangeHandler) {
    this.configPath = configPath.replace(/^~/, process.env.HOME ?? "~");
    this.config = initialConfig;
    this.handler = handler;
  }

  start(): void {
    if (!existsSync(this.configPath)) {
      console.error(`config-watcher: config file not found at ${this.configPath}`);
      return;
    }

    console.log(`config-watcher: watching ${this.configPath} for changes`);

    // Debounced reload: wait 200ms after last change before reloading
    const triggerReload = () => {
      if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
      this.reloadTimeout = setTimeout(() => this.reload(), 200);
    };

    this.watcher = watch(this.configPath, { persistent: false }, (eventType: string) => {
      if (eventType === "change") {
        triggerReload();
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
  }

  /**
   * Reload config from disk, validate, compare, and trigger handler.
   */
  private reload(): void {
    try {
      console.log("config-watcher: reloading config...");

      const newConfig = loadConfig(this.configPath);
      const changes = compareConfigs(this.config, newConfig);

      // Apply the new config (handler is responsible for updating its own state)
      this.config = newConfig;

      // Log what changed
      if (changes.applied.length > 0) {
        console.log(`config-watcher: applied ${changes.applied.length} change(s):`, changes.applied.join(", "));
      }
      if (changes.requiresRestart.length > 0) {
        console.warn(
          `config-watcher: ${changes.requiresRestart.length} field(s) require restart:`,
          changes.requiresRestart.join(", ")
        );
      }
      if (changes.applied.length === 0 && changes.requiresRestart.length === 0) {
        console.log("config-watcher: no changes detected");
      }

      // Trigger handler
      this.handler({
        applied: changes.applied,
        requiresRestart: changes.requiresRestart,
        config: newConfig,
      });
    } catch (err) {
      console.error("config-watcher: reload failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Get current config (reflects last successful reload) */
  getConfig(): BotConfig {
    return this.config;
  }
}
