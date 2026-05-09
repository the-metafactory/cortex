#!/usr/bin/env bun
/**
 * MIG-7.1 — Cortex entrypoint. Wires runtime → surface-router → adapters
 * (Discord + Mattermost) → dispatch-handler → dispatch-listener →
 * worklog-manager → taps. Equivalent of grove-v2's `src/bot/grove-bot.ts`
 * against the cortex layout; per plan §1.3, startup behaviour is parity.
 *
 * Out of scope (deferred): arc-manifest (MIG-7.7), launchd plist (MIG-7.8),
 * config schema flip — `agents:` + `renderers:` (MIG-7.2*), relay daemon
 * wiring (MIG-5b). Public surface: `startCortex(config) → { stop }` —
 * tests construct pieces directly; the CLI bottom wires SIGINT/SIGTERM.
 */

import { Command } from "commander";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { parse as parseYaml } from "yaml";
import type { TextChannel } from "discord.js";

import { loadConfig } from "./common/config/loader";
import { ConfigWatcher } from "./common/config/watcher";
import { type BotConfig, getAllRepos } from "./common/types/config";
import { fetchWithTimeout } from "./common/timeout";
import { UsageMonitor } from "./common/usage/monitor";
import type { UsageStats } from "./runner/stream-parser";

import { buildSecurityPreamble } from "./runner/security-preamble";
import { DispatchHandler } from "./bus/dispatch-handler";
import { startMyelinRuntime, type MyelinRuntime } from "./bus/myelin/runtime";
import { createSurfaceRouter, type SurfaceRouter } from "./bus/surface-router";
import { createNetworkResolver } from "./bus/network-resolver";
import type { SystemEventSource } from "./bus/system-events";

import { DiscordAdapter } from "./adapters/discord";
import { MattermostAdapter } from "./adapters/mattermost";
import type { PlatformAdapter } from "./adapters/types";

import { createDispatchListener, type DispatchListener } from "./runner/dispatch-listener";
import { WorklogManager } from "./runner/worklog-manager";

import { CloudPublisher } from "./taps/cc-events/cloud-publisher";
import { JsonlReader } from "./taps/cc-events/lib/jsonl-reader";
import { PublishedEventSchema } from "./taps/cc-events/hooks/lib/event-types";
import { formatEventForDiscord } from "./adapters/discord/event-formatter";

// MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
// paths for now so the operator's existing `bot.yaml` continues to work.
const STATE_DIR = join(process.env.HOME ?? "~", ".config", "grove", "state");
const PID_FILE = join(STATE_DIR, "cortex.pid");
const DEFAULT_CONFIG = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");

/** Lifecycle handle returned by `startCortex`. Capped at 15s — components
 *  that don't drain are abandoned (logged). */
export interface CortexHandle {
  stop(): Promise<void>;
}

/** Optional test-only injection points. Production callers omit. */
export interface StartCortexOptions {
  /** Override config-file path. Defaults to no watching. */
  configPath?: string;
  /** Skip the config-watcher (tests). */
  disableConfigWatcher?: boolean;
  /** Skip the dashboard API even if config.api.enabled is set (tests). */
  disableDashboard?: boolean;
  /** Skip the JSONL outbound poller (tests). */
  disableOutboundPoller?: boolean;
}

/**
 * Construct the full cortex stack and start it. Returns a stop handle.
 *
 * Order: runtime → router → dispatch-handler → adapters → dispatch-listener
 * → router.start(). Optional taps (cloud publisher, dashboard, JSONL
 * poller) run alongside. Errors during startup of OPTIONAL components are
 * logged and swallowed; REQUIRED components (runtime, router, listener)
 * propagate so the operator sees them at the CLI exit.
 */
export async function startCortex(
  config: BotConfig,
  options: StartCortexOptions = {},
): Promise<CortexHandle> {
  const expandedConfigPath = options.configPath
    ? options.configPath.replace(/^~/, process.env.HOME ?? "~")
    : DEFAULT_CONFIG;

  const securityPreamble = buildSecurityPreamble(config, expandedConfigPath);
  console.log("cortex: starting...");
  console.log(`  Agent: ${config.agent.displayName}`);
  console.log(`  Config: ${options.configPath ?? "(in-memory)"}`);
  console.log(`  PID: ${process.pid}`);

  // Bus runtime (M2-M6) — no-op when `config.nats?` is absent.
  let runtime: MyelinRuntime = {
    enabled: false,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
  try {
    runtime = await startMyelinRuntime(config);
  } catch (err) {
    console.error("cortex: myelin runtime startup error (non-fatal):", err instanceof Error ? err.message : err);
  }

  // Surface router (in-process fan-out).
  const router: SurfaceRouter = createSurfaceRouter(runtime, {
    onAdapterError: (adapterId, err) => {
      console.error(`cortex: surface adapter "${adapterId}" render error:`, err.message);
    },
  });

  // SystemEventSource for `system.*` envelopes (spec §3.6:
  // `{operatorId}.cortex.{instance}`). `local` until federation lands.
  const systemEventSource: SystemEventSource = {
    org: config.agent.operatorId ?? "default",
    agent: "cortex",
    instance: "local",
  };

  // Dispatch-handler — synchronous platform-message → CC pipeline.
  const dispatchHandler = new DispatchHandler({
    config,
    securityPreamble,
    configPath: expandedConfigPath,
  });

  // Cloud publisher (G-401 + G-500) — opt-in via cloud-capable network.
  let cloudPublisher: CloudPublisher | null = null;
  const hasCloudNetworks = config.networks.some((n) => !!n.cloud);
  if (hasCloudNetworks) {
    const networkResolver = createNetworkResolver(config);
    cloudPublisher = new CloudPublisher({ networkResolver });
    const networkIds = config.networks.filter((n) => n.cloud).map((n) => n.id);
    console.log(`cortex: cloud publisher active (networks: ${networkIds.join(", ")})`);
    CloudPublisher.checkEndpoints(networkResolver, networkIds).catch((err) =>
      console.error("cortex: endpoint health check error:", err instanceof Error ? err.message : err),
    );
  } else if (config.api.mode === "cloud") {
    console.warn("cortex: api.mode is 'cloud' but no network has cloud config. Events will not be published.");
  }

  // Adapters (Discord + Mattermost).
  const adapters: PlatformAdapter[] = [];
  const adapterCleanup: Array<() => void> = [];

  for (const instance of config.discord) {
    if (instance.enabled === false) {
      console.log(`cortex: discord instance ${instance.instanceId ?? instance.guildId} disabled — skipping`);
      continue;
    }
    const instanceId = instance.instanceId ?? `discord-${instance.guildId}`;
    try {
      const adapter = new DiscordAdapter(
        {
          instanceId,
          token: instance.token,
          guildId: instance.guildId,
          agentChannelId: instance.agentChannelId,
          logChannelId: instance.logChannelId,
          contextDepth: instance.contextDepth,
          enableAgentLog: instance.enableAgentLog,
          operatorDiscordId: config.agent.operatorDiscordId,
          roles: instance.roles,
          defaultRole: instance.defaultRole,
          dm: instance.dm,
        },
        config,
        // MIG-3b-ii: bus wiring for `system.adapter.*` envelopes.
        { runtime, systemEventSource },
      );
      // Register the adapter's surface-router face. Empty `surfaceSubjects`
      // makes this a no-op match; harmless to register either way.
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);
      console.log(`cortex: discord adapter started (instance: ${instanceId}, guild: ${instance.guildId})`);

      // Outbound JSONL → #agent-log + worklog (opt-in). Dashboard + cloud
      // delivery handled by the HTTP path (H-004).
      if (!options.disableOutboundPoller && (instance.enableAgentLog || instance.worklogChannelId)) {
        const cleanup = setupOutboundLog(adapter, instance, config, router, systemEventSource);
        if (cleanup) adapterCleanup.push(cleanup);
      }
    } catch (err) {
      console.error(`cortex: discord adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  if (config.discord.length === 0) {
    console.log("cortex: no discord instances configured");
  }

  for (const instance of config.mattermost) {
    if (instance.enabled === false) continue;
    if (!instance.apiUrl || !instance.apiToken) {
      console.error(`cortex: mattermost instance ${instance.instanceId ?? "unnamed"} missing apiUrl/apiToken — skipping`);
      continue;
    }
    const instanceId = instance.instanceId ?? `mattermost-${config.agent.name}`;
    try {
      const adapter = new MattermostAdapter(
        {
          instanceId,
          apiUrl: instance.apiUrl,
          apiToken: instance.apiToken,
          triggerWord: instance.triggerWord,
          channels: instance.channels,
          pollIntervalMs: instance.pollIntervalMs,
          operatorMattermostId: config.agent.operatorMattermostId,
          roles: instance.roles,
          defaultRole: instance.defaultRole,
        },
        config,
      );
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);
      console.log(`cortex: mattermost adapter started (instance: ${instanceId}, ${instance.channels.length} channel(s))`);
    } catch (err) {
      console.error(`cortex: mattermost adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // Dispatch-listener — bus envelope → CC spawn.
  const dispatchListener: DispatchListener = createDispatchListener({ runtime, router, source: systemEventSource });
  await dispatchListener.start();

  // Start router AFTER all surfaces register so the first envelope
  // (which may arrive synchronously after `runtime.onEnvelope`) fans
  // out to every registered adapter.
  await router.start();

  // Config watcher (hot-reload for safe fields).
  let configWatcher: ConfigWatcher | null = null;
  if (
    !options.disableConfigWatcher
    && options.configPath
    && existsSync(expandedConfigPath)
  ) {
    configWatcher = new ConfigWatcher(expandedConfigPath, config, (event) => {
      dispatchHandler.updateConfig(event.config, expandedConfigPath);
      for (const adapter of adapters) adapter.updateConfig?.(event.config);
      if (cloudPublisher) {
        cloudPublisher.updateResolver(createNetworkResolver(event.config));
      }
      if (event.applied.length > 0) {
        console.log(`cortex: config reloaded — applied ${event.applied.length} change(s)`);
      }
      if (event.requiresRestart.length > 0) {
        console.warn(`cortex: ${event.requiresRestart.length} field(s) require restart:`, event.requiresRestart.join(", "));
      }
    });
    configWatcher.start();
  }

  // Dashboard API + usage monitor (G-201 / G-206) — opt-in.
  let dashboardApi: { stop?: () => void } | null = null;
  let usageMonitor: UsageMonitor | null = null;
  if (config.api.enabled && !options.disableDashboard) {
    try {
      ({ api: dashboardApi, usageMonitor } = await setupDashboard(config, dispatchHandler, cloudPublisher));
    } catch (err) {
      console.error("cortex: dashboard API startup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Shutdown — reverse-order; capped at SHUTDOWN_TIMEOUT_MS.
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 15_000;

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\ncortex: shutting down...");

    const drain = async (): Promise<void> => {
      configWatcher?.stop();
      usageMonitor?.stop();
      logIfThrows("dashboard stop", () => dashboardApi?.stop?.());
      for (const cleanup of adapterCleanup) {
        logIfThrows("outbound poller stop", cleanup);
      }
      await logIfRejects("dispatch-listener stop", dispatchListener.stop());
      await logIfRejects("surface-router stop", router.stop());
      await logIfRejects("dispatch-handler shutdown", dispatchHandler.shutdown());
      for (const adapter of adapters) {
        await logIfRejects(`adapter ${adapter.instanceId} stop`, adapter.stop());
      }
      await logIfRejects("cloud publisher close", cloudPublisher?.close());
      await logIfRejects("runtime stop", runtime.stop());
    };

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn(`cortex: shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — abandoning remaining components`);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS),
    );
    await Promise.race([drain(), timeout]);
  };

  return { stop };
}

/** G-201 / G-206 dashboard wiring. Dynamic import: surface/mc uses bun-only
 *  globals tsc can't see, so we keep this off the type-check path. Tests
 *  pass `disableDashboard` and never enter here. */
async function setupDashboard(
  config: BotConfig,
  dispatchHandler: DispatchHandler,
  cloudPublisher: CloudPublisher | null,
): Promise<{ api: { stop?: () => void }; usageMonitor: UsageMonitor }> {
  const { DashboardApi } = await import("./surface/mc/api/index" as string);
  const dbPath = join(STATE_DIR, "dashboard.db");
  const cortexRoot = join(dirname(import.meta.dir), ".");
  const dashboardDir = join(cortexRoot, "dist", "dashboard");
  const api = new DashboardApi({
    port: config.api.port,
    corsOrigin: config.api.corsOrigin,
    dbPath,
    github: { ...config.github, repos: getAllRepos(config) },
    apiMode: config.api.mode,
    operatorId: config.agent.operatorId ?? config.agent.name,
    operatorName: config.agent.operatorName ?? config.agent.operatorId ?? config.agent.displayName,
    dashboardDir,
  });
  console.log(`cortex: dashboard DB at ${dbPath}`);

  const publishedDir = config.paths.publishedEventsDir.replace(/^~/, process.env.HOME ?? "~");
  const replayed = api.getState().rehydrate(publishedDir);
  if (replayed > 0) console.log(`cortex: rehydrated dashboard with ${replayed} events from disk`);
  api.start();

  const cloudNetworks = config.networks.filter((n) => n.cloud);
  if (cloudNetworks.length > 0) {
    runStartupCloudSync(cloudNetworks, api).catch((err) =>
      console.error("cortex: cloud sync error:", err instanceof Error ? err.message : err),
    );
  } else {
    api.runStartupSync();
  }
  if (cloudPublisher) api.setCloudPublisher((event: unknown) => cloudPublisher.publish(event as never));

  const usageMonitor = new UsageMonitor((usage, snapshot) => {
    api.getState().setAccountUsage(usage);
    api.getDb()?.insertUsageSnapshot(snapshot);
    api.notifyStateChanged();
  });
  api.setUsageMonitor(usageMonitor);
  usageMonitor.start();

  dispatchHandler.on("session-usage", (sessionId: string, usage: UsageStats) => {
    const changed = api.getState().updateSessionUsage(sessionId, usage);
    if (changed) api.notifyStateChanged();
  });
  return { api, usageMonitor };
}

/** Subscribe a Discord adapter to the published-events JSONL stream so legacy
 *  `#agent-log` and per-task worklog threads keep working. Mirrors grove-bot's
 *  `setupOutboundLog`. The dispatch.task.* projection has migrated to
 *  `worklog-manager.surfaceConfig` (router-driven); this function runs the
 *  legacy direct-call path while MIG-7.2d Renderer cutover is pending. */
function setupOutboundLog(
  discordAdapter: DiscordAdapter,
  instance: import("./common/types/config").DiscordInstance,
  config: BotConfig,
  router: SurfaceRouter,
  systemEventSource: SystemEventSource,
): (() => void) | null {
  const eventsDir = config.paths.publishedEventsDir.replace(/^~/, process.env.HOME ?? "~");
  const client = discordAdapter.getClient();
  if (!client) {
    console.log("cortex: discord client not available for outbound log");
    return null;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  client.on("ready", () => {
    if (!existsSync(eventsDir)) {
      console.log(`cortex: published events dir not found (${eventsDir}), skipping outbound`);
      return;
    }

    const reader = new JsonlReader();
    reader.skipAllToEnd(eventsDir);
    const logChannelId = instance.logChannelId;
    const guildId = instance.guildId;
    const postedEventIds = new Set<string>();

    let worklog: WorklogManager | null = null;
    if (instance.worklogChannelId) {
      worklog = new WorklogManager(client, instance.worklogChannelId);
      console.log(`cortex: worklog enabled → channel ${instance.worklogChannelId}`);
      // Register the worklog manager's `dispatch.task.*` surface so the
      // bus-driven path projects into the same threads as the JSONL path.
      router.register(
        worklog.surfaceConfig({
          org: systemEventSource.org,
          adapterId: `worklog-${discordAdapter.instanceId}`,
        }),
      );
    }

    const processFile = async (path: string) => {
      const events = reader.readNew(path);
      if (events.length > 0) {
        console.log(`cortex: processing ${events.length} event(s) from ${path.split("/").pop()}`);
      }
      for (const raw of events) {
        try {
          const event = PublishedEventSchema.parse(raw);
          if (postedEventIds.has(event.event_id)) continue;
          postedEventIds.add(event.event_id);
          if (worklog) await worklog.handleEvent(event);
          if (instance.enableAgentLog) {
            const formatted = formatEventForDiscord(event);
            if (!formatted) continue;
            const guild = client.guilds.cache.get(guildId);
            const channel =
              (guild?.channels.cache.get(logChannelId) as TextChannel | null)
              ?? ((await client.channels.fetch(logChannelId).catch(() => null)) as TextChannel | null);
            if (channel && "send" in channel) {
              await channel.send(formatted);
            } else {
              console.error(`cortex: could not resolve log channel ${logChannelId} — check bot permissions and channel ID`);
            }
          }
        } catch (err) {
          console.error("cortex: outbound error:", err instanceof Error ? err.message : err);
        }
      }
    };

    pollInterval = setInterval(() => {
      try {
        const files = readdirSync(eventsDir).filter((f: string) => f.endsWith(".jsonl"));
        for (const file of files) processFile(join(eventsDir, file));
      } catch (err) {
        console.error("cortex: poll error:", err instanceof Error ? err.message : err);
      }
    }, 2000);

    console.log(`cortex: polling ${eventsDir} for outbound events (every 2s)`);
  });

  return () => {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}

// Shutdown helpers — log-and-swallow so one slow stop doesn't block the next.

function logIfThrows(label: string, fn: (() => void) | undefined): void {
  if (!fn) return;
  try { fn(); } catch (err) {
    console.error(`cortex: ${label} error:`, err instanceof Error ? err.message : err);
  }
}

async function logIfRejects(label: string, p: Promise<unknown> | undefined): Promise<void> {
  if (!p) return;
  try { await p; } catch (err) {
    console.error(`cortex: ${label} error:`, err instanceof Error ? err.message : err);
  }
}

/** G-204a + G-500: Issue startup `/api/sync` POST against each cloud-capable
 *  network; fall back to a local sync for any network that errors. */
async function runStartupCloudSync(
  cloudNetworks: BotConfig["networks"],
  api: { runStartupSync: () => unknown },
): Promise<void> {
  let anyFailed = false;
  for (const network of cloudNetworks) {
    if (!network.cloud) continue;
    const { endpoint, apiKey, cfAccessClientId, cfAccessClientSecret } = network.cloud;
    try {
      const syncUrl = `${endpoint.replace(/\/+$/, "")}/api/sync`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (cfAccessClientId && cfAccessClientSecret) {
        headers["CF-Access-Client-Id"] = cfAccessClientId;
        headers["CF-Access-Client-Secret"] = cfAccessClientSecret;
      }
      const res = await fetchWithTimeout("startup_sync", 15_000, syncUrl, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        const result = (await res.json()) as { repos?: number; issues?: number; prs?: number };
        console.log(`cortex: cloud sync [${network.id}] — ${result.repos ?? 0} repo(s), ${result.issues ?? 0} issues, ${result.prs ?? 0} PRs`);
      } else {
        console.error(`cortex: cloud sync [${network.id}] failed: HTTP ${res.status}`);
        anyFailed = true;
      }
    } catch (err) {
      console.error(`cortex: cloud sync [${network.id}] error:`, err instanceof Error ? err.message : err);
      anyFailed = true;
    }
  }
  if (anyFailed) await api.runStartupSync();
}

// CLI

function getVersion(): string {
  try {
    const manifestPath = join(dirname(import.meta.dir), "arc-manifest.yaml");
    const manifest = parseYaml(readFileSync(manifestPath, "utf-8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function checkSingleton(): void {
  if (!existsSync(PID_FILE)) return;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    console.error(`cortex: removing invalid PID file (contents: "${raw}")`);
    unlinkSync(PID_FILE);
    return;
  }
  try {
    process.kill(pid, 0);
    console.error(`cortex: already running (PID ${pid}). Stop it first with: cortex stop`);
    process.exit(1);
  } catch {
    console.error(`cortex: removing stale PID file (PID ${pid} not running)`);
    unlinkSync(PID_FILE);
  }
}

// `import.meta.main` is true only when this file is the CLI entrypoint.
// Skipping the CLI wiring at module load is what lets tests
// `import { startCortex }` here without parsing argv or registering signal
// handlers.
if (import.meta.main) {
  const program = new Command()
    .name("cortex")
    .description("Cortex — PAI Discord bot, the M7 conscious processing surface")
    .version(getVersion());

  program
    .command("start")
    .description("Start the bot")
    .option("--config <path>", "Path to bot config YAML", DEFAULT_CONFIG)
    .action(async (options) => {
      mkdirSync(STATE_DIR, { recursive: true });
      checkSingleton();
      writeFileSync(PID_FILE, String(process.pid));

      process.on("uncaughtException", (err) => {
        console.error("cortex: uncaught exception (non-fatal):", err.message);
      });
      process.on("unhandledRejection", (reason) => {
        console.error("cortex: unhandled rejection (non-fatal):", reason);
      });

      const config = loadConfig(options.config);
      const handle = await startCortex(config, { configPath: options.config });

      const shutdown = async () => {
        await handle.stop();
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  program
    .command("stop")
    .description("Stop the bot")
    .action(() => {
      if (!existsSync(PID_FILE)) {
        console.log("cortex: not running");
        return;
      }
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
      try {
        process.kill(pid, "SIGTERM");
        unlinkSync(PID_FILE);
        console.log(`cortex: stopped (PID ${pid})`);
      } catch {
        console.log(`cortex: process ${pid} not found, cleaning up`);
        unlinkSync(PID_FILE);
      }
    });

  program
    .command("status")
    .description("Check bot status")
    .action(() => {
      if (!existsSync(PID_FILE)) {
        console.log("cortex: not running");
        return;
      }
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
      try {
        process.kill(pid, 0);
        console.log(`cortex: running (PID ${pid})`);
      } catch {
        console.log("cortex: stale PID file");
        unlinkSync(PID_FILE);
      }
    });

  program.parse();
}
