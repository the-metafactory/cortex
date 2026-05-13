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

import { loadConfigWithAgents, loadAgentsDirectory, expandTilde, FragmentLoadError } from "./common/config/loader";
import { ConfigWatcher } from "./common/config/watcher";
import { type BotConfig, getAllRepos } from "./common/types/config";
import { fetchWithTimeout } from "./common/timeout";
import { UsageMonitor } from "./common/usage/monitor";
import { AgentRegistry } from "./common/agents/registry";
import { TrustResolver } from "./common/agents/trust-resolver";
// cortex#79 — creds minting moved to `arc nats … --json` (shelled out from
// `src/cli/cortex/commands/creds.ts`). No daemon-side RPC handler in
// cortex; the operator-signature verifier in TrustResolver keeps using
// `loadAccountSigningKey` independently.
import type { UsageStats } from "./runner/stream-parser";

import { buildSecurityPreamble } from "./runner/security-preamble";
import { DispatchHandler } from "./bus/dispatch-handler";
import { startMyelinRuntime, type MyelinRuntime } from "./bus/myelin/runtime";
import { createSurfaceRouter, type SurfaceRouter } from "./bus/surface-router";
import { createNetworkResolver } from "./bus/network-resolver";
import type { SystemEventSource } from "./bus/system-events";

import { DiscordAdapter } from "./adapters/discord";
import { createRenderer, type Renderer } from "./renderers";
import { RendererSchema } from "./common/types/cortex-config";
import type { Agent, DiscordPresence, MattermostPresence } from "./common/types/cortex-config";
import { MattermostAdapter } from "./adapters/mattermost";
import type { PlatformAdapter } from "./adapters/types";

import { createDispatchListener, type DispatchListener } from "./runner/dispatch-listener";
import { WorklogManager } from "./runner/worklog-manager";

import { CloudPublisher } from "./taps/cc-events/cloud-publisher";
import { JsonlReader } from "./taps/cc-events/lib/jsonl-reader";
import { PublishedEventSchema } from "./taps/cc-events/hooks/lib/event-types";
import { formatEventForDiscord } from "./adapters/discord/event-formatter";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "./taps/gh-webhook-receiver/server";

// MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
// paths for now so the operator's existing `bot.yaml` continues to work.
const STATE_DIR = join(process.env.HOME ?? "~", ".config", "grove", "state");
const PID_FILE = join(STATE_DIR, "cortex.pid");
const DEFAULT_CONFIG = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");

/** Lifecycle handle returned by `startCortex`. Capped at 15s — components
 *  that don't drain are abandoned (logged). */
export interface CortexHandle {
  stop(): Promise<void>;
  /**
   * Subsystems that did not finish their `stop()` within
   * `SHUTDOWN_TIMEOUT_MS` on the most recent `stop()` invocation. Empty
   * after a clean shutdown; non-empty signals operators (or launchd) that
   * the process exited dirty — typically wiring this to a non-zero exit
   * code.
   *
   * Echo round-1 N2: previously the timeout warned but didn't surface
   * which components were left in flight. The CLI handler at the bottom
   * of this file checks this list after stop() and exits 1 if non-empty
   * so launchd knows to log a dirty shutdown.
   */
  readonly lastShutdownAbandoned: readonly string[];
  /**
   * cortex#67 prereq C — agent registry assembled at startup from inline
   * cortex.yaml `agents[]` + fragments under `agents.d/` (inline wins on id
   * conflict per design §6.1). Read-only; downstream consumers (dashboard,
   * trust resolver, future capability surfaces) look up agents here rather
   * than synthesising local `Agent` shapes.
   *
   * Today this coexists with the transitional inline `Agent` synthesis at
   * cortex.ts:246 and :321 (Discord + Mattermost adapter wiring). Those
   * paths land in MIG-7.2c-presence-adapter-flip; this PR does not refactor
   * them.
   */
  readonly agentRegistry: AgentRegistry;
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
  /** Skip the GitHub webhook receiver even if config.github.receiver.enabled is true (tests). */
  disableGithubReceiver?: boolean;
  /**
   * Inject a runtime instead of constructing one via `startMyelinRuntime`.
   * Tests pass a recording fake to assert observable side-effects (e.g. that
   * the surface-router actually called `runtime.onEnvelope`). Production
   * callers omit this and the runtime is built from `config.nats?` as usual.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  injectRuntime?: MyelinRuntime;
  /**
   * Override the 15s shutdown timeout. Tests use a small value (50–200ms)
   * to exercise the abandoned-set tracking path without holding the test
   * runner hostage for 15 real seconds.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  shutdownTimeoutMs?: number;
  /**
   * Override the agents.d/ fragment directory the AgentRegistry assembly
   * step reads. Production code derives this from the config file's
   * directory (`{configDir}/agents.d`) matching `cortex agents` CLI
   * behaviour, falling back to `~/.config/cortex/agents.d/` when no
   * `configPath` was supplied. Tests pass a tmp dir so the registry
   * assembly path runs without touching the operator's real `agents.d/`.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  agentsDir?: string;
  /**
   * Inline `Agent[]` to merge with the fragment-loaded list when building
   * the registry. Mirrors the cortex.yaml `agents[]` block (design §6.1):
   * inline entries win on id conflict with fragments.
   *
   * BotConfig (today's legacy shape) carries no inline `agents[]` field, so
   * production callers pass nothing and the registry is built purely from
   * fragments. The seam exists today so tests can assemble a registry
   * without writing fragment files, and so the cortex.yaml migration
   * (MIG-7.2e) can plumb the real inline list through without changing
   * this signature.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  inlineAgents?: readonly Agent[];
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

  // Bus runtime (M2-M6) — no-op when `config.nats?` is absent. Tests inject
  // a recording fake via `options.injectRuntime` to assert observable
  // wire-up side-effects without standing up a real NATS server.
  let runtime: MyelinRuntime = {
    enabled: false,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
  if (options.injectRuntime) {
    runtime = options.injectRuntime;
  } else {
    try {
      runtime = await startMyelinRuntime(config);
    } catch (err) {
      console.error("cortex: myelin runtime startup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // cortex#67 prereq C — assemble the AgentRegistry from inline agents +
  // fragments dropped under `agents.d/`. Per design §6.1, inline entries win
  // on id conflict with fragments.
  //
  // The fragment directory defaults to `{configDir}/agents.d` (matching the
  // `cortex agents` CLI's resolver) so an operator who already manages
  // fragments via that command sees them honoured at daemon startup too.
  // When `options.configPath` is absent (e.g. tests with in-memory config),
  // we fall back to `~/.config/cortex/agents.d/`.
  //
  // Fragment-load errors are non-fatal at this stage of the migration: the
  // bot must keep starting in BotConfig mode even when an operator's
  // experimental fragment is malformed. Once the cortex.yaml migration is
  // complete (MIG-7.2e), the rule flips to strict per spec §FR-4.
  const agentsDir = options.agentsDir
    ?? (options.configPath ? join(dirname(expandedConfigPath), "agents.d") : expandTilde("~/.config/cortex/agents.d/"));
  let fragmentAgents: Agent[] = [];
  try {
    fragmentAgents = loadAgentsDirectory(agentsDir);
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      console.error(`cortex: agents.d fragment load failed (non-fatal during BotConfig migration): ${err.message}`);
    } else {
      throw err;
    }
  }

  // Merge: inline wins on id conflict (design §6.1). BotConfig today carries
  // no inline `agents[]`, so production callers pass `inlineAgents: undefined`
  // and the merged list is just the fragments. The seam exists so tests can
  // exercise the merge rule without writing fragment files, and so MIG-7.2e
  // can plumb the real inline list through without changing the signature.
  const inlineAgents = options.inlineAgents ?? [];
  const inlineIds = new Set(inlineAgents.map((a) => a.id));
  const shadowedFragmentCount = fragmentAgents.filter((a) => inlineIds.has(a.id)).length;
  const mergedAgents: Agent[] = [
    ...inlineAgents,
    ...fragmentAgents.filter((a) => !inlineIds.has(a.id)),
  ];
  const agentRegistry = AgentRegistry.fromAgents(mergedAgents);
  if (mergedAgents.length > 0) {
    console.log(
      `cortex: agent registry assembled — ${mergedAgents.length} agent(s) `
        + `(${inlineAgents.length} inline + ${fragmentAgents.length} fragment, `
        + `${shadowedFragmentCount} fragment override(s) shadowed by inline)`,
    );
  } else {
    console.log("cortex: agent registry assembled — 0 agents (no inline agents, no fragments)");
  }

  // cortex#98 (part B) — in-process trust map. Each Discord adapter
  // registers its own `client.user.id` after login (Pass 1 of the adapter
  // loop below), and the merge step (Pass 2) walks each agent's `trust:[]`
  // list and asks the resolver for each peer's bot user id. Co-hosted
  // peers land in the merged set; cross-process peers (never registered
  // here) silently fall through and stay covered by the operator-explicit
  // `presence.discord.trustedBotIds` field (cortex#98 part A).
  //
  // The resolver is constructed unconditionally — even legacy bot.yaml
  // configs with `trust: []` (no peers) get a no-op resolver rather than
  // a branching code path, keeping the adapter loop uniform.
  const trustResolver = new TrustResolver(agentRegistry);

  // cortex#79 — creds minting is no longer a cortex daemon responsibility.
  // `cortex creds issue / revoke / rotate` now shell out to
  // `arc nats … --json`; arc owns nsc and the operator account.
  // `config.nats.accountSigningKeyPath` survives for the operator-signature
  // verifier on TrustResolver (cortex#76); see
  // `src/common/agents/trust-resolver.ts`.

  // SystemEventSource for `system.*` envelopes (spec §3.6:
  // `{operatorId}.cortex.{instance}`). `local` until federation lands.
  // `dataResidency` flows from `config.agent.dataResidency` so a non-NZ
  // operator gets envelopes stamped with their actual residency without
  // touching the per-event constructors. Defaults to "NZ" when absent
  // (the original cortex deployment's residency).
  //
  // Declared BEFORE the surface-router (cortex#134 Echo round-1 fix):
  // the router needs the source to publish `system.access.filtered`
  // envelopes when a visibility-config renderer drops an envelope.
  // Without this, the audit-trail emit silently degrades to console.info
  // in production — only unit tests passed the explicit source.
  const systemEventSource: SystemEventSource = {
    org: config.agent.operatorId ?? "default",
    agent: "cortex",
    instance: "local",
    ...(config.agent.dataResidency !== undefined && {
      dataResidency: config.agent.dataResidency,
    }),
  };

  // Surface router (in-process fan-out).
  // Receives `systemEventSource` so visibility-config drops produce
  // `system.access.filtered` envelopes operators can subscribe to — see
  // `evaluateVisibility()` in surface-router.ts.
  const router: SurfaceRouter = createSurfaceRouter(runtime, {
    systemEventSource,
    onAdapterError: (adapterId, err) => {
      console.error(`cortex: surface adapter "${adapterId}" render error:`, err.message);
    },
  });

  // Dispatch-handler — synchronous platform-message → CC pipeline.
  //
  // MIG-3.8 / C-104: hand the runtime + systemEventSource down so the handler
  // can publish `system.inbound.aborted` envelopes when an adapter outbound
  // (today: Discord attachment fetch) trips `TimeoutSourceError`. Both
  // fields are passed unconditionally — when the runtime is the no-op stub
  // (NATS absent), `MyelinRuntime.publish` is a no-op and emission falls
  // through silently. See `DispatchHandler.canPublishSystemEvent`.
  const dispatchHandler = new DispatchHandler({
    config,
    securityPreamble,
    configPath: expandedConfigPath,
    runtime,
    systemEventSource,
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

  // MIG-7.2e: per-instance agent lookup. When cortex.yaml supplies
  // `inlineAgents` (reused from the registry-merge block above), each
  // Discord/Mattermost adapter binds to the declared Agent (real id,
  // displayName, persona, roles, trust) instead of the
  // synthesized-from-singular fallback. Keyed by the unique platform
  // credential — `presence.discord.token` for Discord,
  // `presence.mattermost.apiToken` for Mattermost.
  const agentByDiscordToken = new Map<string, Agent>();
  const agentByMattermostApiToken = new Map<string, Agent>();
  for (const a of mergedAgents) {
    if (a.presence.discord?.token) agentByDiscordToken.set(a.presence.discord.token, a);
    if (a.presence.mattermost?.apiToken) {
      agentByMattermostApiToken.set(a.presence.mattermost.apiToken, a);
    }
  }

  // cortex#98 (part B) — two-pass adapter start so peer-bot ids can be
  // resolved across adapters. Pass 1 starts each adapter with its operator-
  // explicit `trustedBotIds` set (the cross-process bridge list from
  // cortex.yaml) and registers each agent's freshly-learned bot user id in
  // the TrustResolver. Pass 2 walks each adapter's `agent.trust[]` list,
  // asks the resolver for each peer's bot id, and merges the result into
  // the adapter's allowlist via `setTrustedBotIds`. The split is required
  // because adapter A's `trust` list may reference adapter B, and B's
  // platform id is only known after B's `client.login()` resolves.
  //
  // Started Discord state carried between passes. We capture the adapter,
  // its declaring agent, and the operator-explicit set as a baseline so
  // Pass 2 can produce the merged set in one place (explicit ∪ resolved
  // peers) without re-parsing the instance.
  interface StartedDiscord {
    adapter: DiscordAdapter;
    agent: Agent;
    instance: BotConfig["discord"][number];
    instanceId: string;
    explicitTrustedBotIds: ReadonlySet<string>;
  }
  const startedDiscord: StartedDiscord[] = [];

  for (const instance of config.discord) {
    if (instance.enabled === false) {
      console.log(`cortex: discord instance ${instance.instanceId ?? instance.guildId} disabled — skipping`);
      continue;
    }
    // MIG-7.2c-discord-flip: derive the instance id from the agent name plus
    // the discord guild so multi-instance bot.yaml configs (same `agent.name`,
    // multiple `discord[]` entries) still produce a unique key. Once
    // migrate-config (MIG-7.2e) emits a proper `agents[]` array the suffix
    // collapses to plain `${agent.id}-discord`.
    const instanceId = instance.instanceId ?? `${config.agent.name}-discord-${instance.guildId}`;
    // Build the `DiscordPresence` from the bot.yaml discord[i] entry.
    // Schema defaults already applied by `BotConfigSchema` at load time —
    // this is a structural mapping, not a parse.
    //
    // cortex#98 (part A): `trustedBotIds` carries the operator-explicit
    // cross-process bridge list (architecture §9.3). It MUST be threaded
    // through verbatim — the auto-population step below merges in-process
    // peers from `agent.trust[]` on top via the TrustResolver (part B).
    const presence: DiscordPresence = {
      enabled: instance.enabled,
      token: instance.token,
      guildId: instance.guildId,
      agentChannelId: instance.agentChannelId,
      logChannelId: instance.logChannelId,
      ...(instance.worklogChannelId !== undefined && { worklogChannelId: instance.worklogChannelId }),
      contextDepth: instance.contextDepth,
      enableAgentLog: instance.enableAgentLog,
      roles: instance.roles,
      defaultRole: instance.defaultRole,
      dm: instance.dm,
      ...(instance.operatorRoleId !== undefined && { operatorRoleId: instance.operatorRoleId }),
      trustedBotIds: instance.trustedBotIds,
    };
    // MIG-7.2e: prefer the cortex-shape `inlineAgents` lookup when present —
    // per-instance identity (real id, persona, roles, trust) flows from
    // cortex.yaml. Falls back to the transitional synthesis-from-singular
    // for legacy bot.yaml input (no inlineAgents).
    const matchedAgent = agentByDiscordToken.get(instance.token);
    const agent: Agent = matchedAgent ?? {
      id: config.agent.name,
      displayName: config.agent.displayName,
      persona: "(deferred-mig-7.2e)",
      roles: [],
      trust: [],
      presence: { discord: presence },
    };
    try {
      // cortex#84: build the trusted-peer-bot allowlist once per adapter
      // start so the messageCreate hot path doesn't re-allocate per event.
      // Empty list → adapter falls back to "drop every bot author"
      // (pre-cortex#84 behaviour). Pass 2 below merges resolver-derived
      // in-process peer ids on top via `adapter.setTrustedBotIds`.
      const explicitTrustedBotIds = new Set<string>(instance.trustedBotIds);
      const adapter = new DiscordAdapter(
        agent,
        presence,
        {
          instanceId,
          operator: {
            ...(config.agent.operatorDiscordId !== undefined && { discordId: config.agent.operatorDiscordId }),
          },
          runtime,
          systemEventSource,
          trustedBotIds: explicitTrustedBotIds,
        },
      );
      // Register the adapter's surface-router face. Empty `surfaceSubjects`
      // makes this a no-op match; harmless to register either way.
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);

      // cortex#98 (part B) — Pass 1 step c: register this adapter's bot
      // user id in the trust resolver so OTHER adapters' Pass 2 lookups
      // can resolve `agent.trust = [<this-agent>]` to this bot id. The
      // matched-agent lookup above already gave us this agent's
      // declarative id; pair it with `client.user.id` (available
      // post-login via `getPlatformUserId`).
      //
      // The register call is best-effort: if the agent id isn't in the
      // registry (legacy bot.yaml with synthesized-from-singular agent
      // — `mergedAgents` is empty, so the registry has no entries),
      // skip silently. Pass 2 will still produce a correctly-sized
      // empty resolved-peer set for those configs.
      if (agentRegistry.tryGetById(agent.id)) {
        try {
          const botUserId = await adapter.getPlatformUserId();
          trustResolver.register("discord", botUserId, agent.id);
        } catch (err) {
          // Register failures (PlatformIdAlreadyRegisteredError on a
          // misconfigured token, or getPlatformUserId throwing if the
          // adapter's client.user is unexpectedly null) should not abort
          // startup — log and continue so other adapters can come up.
          console.error(
            `cortex: trust-resolver register for "${agent.id}" failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      startedDiscord.push({
        adapter,
        agent,
        instance,
        instanceId,
        explicitTrustedBotIds,
      });
    } catch (err) {
      console.error(`cortex: discord adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // cortex#98 (part B) — Pass 2: merge resolver-derived in-process peer
  // bot ids on top of each adapter's operator-explicit set, and log the
  // final allowlist size per adapter. Peers absent from the resolver
  // (cross-process — they live in a different cortex deployment) are
  // silently skipped; the operator-explicit field in
  // `presence.discord.trustedBotIds` covers those.
  //
  // cortex#108 item 1 — closing the Pass-1→Pass-2 TOCTOU window: after
  // `setTrustedBotIds(merged)` populates the allowlist, we IMMEDIATELY
  // call `attachInboundDispatch()` so the `messageCreate` listener is
  // registered against the post-merge allowlist. Order is load-bearing:
  // setTrustedBotIds MUST complete before attachInboundDispatch, so the
  // first delivered message sees the correct allowlist. Echo's round-1
  // review of cortex#105 flagged the start()-attaches-listener-pre-merge
  // shape as a [major/security] silent-drop bug for bot-to-bot traffic
  // landing in the startup window.
  for (const { adapter, agent, instance, instanceId, explicitTrustedBotIds } of startedDiscord) {
    const merged = new Set<string>(explicitTrustedBotIds);
    const resolvedPeers: string[] = [];
    const skippedPeers: string[] = [];
    for (const peerAgentId of agent.trust) {
      if (peerAgentId === agent.id) continue; // self-trust handled by adapter's self-loop guard
      const peerBotId = trustResolver.lookupPlatformIdByAgent("discord", peerAgentId);
      if (peerBotId !== undefined) {
        merged.add(peerBotId);
        resolvedPeers.push(peerAgentId);
      } else {
        skippedPeers.push(peerAgentId);
      }
    }
    adapter.setTrustedBotIds(merged);
    // cortex#108 item 1: attach the messageCreate listener now — AFTER the
    // merged allowlist is in place. discord.js holds inbound events at the
    // WebSocket layer until a JS listener is attached, so no startup-window
    // bot-to-bot traffic is dropped.
    adapter.attachInboundDispatch();
    console.log(
      `cortex: discord adapter started (instance: ${instanceId}, guild: ${instance.guildId}, ` +
        `trustedBotIds: ${adapter.trustedBotIdCount}` +
        (resolvedPeers.length > 0 ? ` [resolver: ${resolvedPeers.join(", ")}]` : "") +
        (skippedPeers.length > 0 ? ` [cross-process: ${skippedPeers.join(", ")}]` : "") +
        `)`,
    );

    // Outbound JSONL → #agent-log + worklog (opt-in). Dashboard + cloud
    // delivery handled by the HTTP path (H-004). Moved into Pass 2 so the
    // log-line ordering stays "adapter started → outbound poller wired";
    // poller setup is decoupled from the trust-resolver merge.
    if (!options.disableOutboundPoller && (instance.enableAgentLog || instance.worklogChannelId)) {
      const cleanup = setupOutboundLog(adapter, instance, config, router, systemEventSource);
      if (cleanup) adapterCleanup.push(cleanup);
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
    // MIG-7.2c-mattermost: same instanceId-derivation strategy as Discord —
    // suffix the legacy fallback with `mattermost-${index}` when
    // botConfig.mattermost[] has multiple entries per agent.name. Collapses
    // to plain `${agent.id}-mattermost` at MIG-7.2e.
    const mmIndex = config.mattermost.indexOf(instance);
    const instanceId = instance.instanceId ?? (config.mattermost.length > 1
      ? `${config.agent.name}-mattermost-${mmIndex}`
      : `${config.agent.name}-mattermost`);
    // Build the `MattermostPresence` from the bot.yaml mattermost[i] entry.
    const presence: MattermostPresence = {
      enabled: instance.enabled,
      callbackPort: instance.callbackPort,
      apiUrl: instance.apiUrl,
      apiToken: instance.apiToken,
      ...(instance.triggerWord !== undefined && { triggerWord: instance.triggerWord }),
      ...(instance.webhookUrl !== undefined && { webhookUrl: instance.webhookUrl }),
      ...(instance.webhookToken !== undefined && { webhookToken: instance.webhookToken }),
      channels: instance.channels,
      pollIntervalMs: instance.pollIntervalMs,
      allowedUsers: instance.allowedUsers,
      roles: instance.roles,
      defaultRole: instance.defaultRole,
    };
    // MIG-7.2e: prefer the cortex-shape `inlineAgents` lookup when present —
    // same pattern as the Discord block above. apiToken is the cleanest
    // unique key on Mattermost presence.
    const matchedAgent = instance.apiToken
      ? agentByMattermostApiToken.get(instance.apiToken)
      : undefined;
    const agent: Agent = matchedAgent ?? {
      id: config.agent.name,
      displayName: config.agent.displayName,
      persona: "(deferred-mig-7.2e)",
      roles: [],
      trust: [],
      presence: { mattermost: presence },
    };
    try {
      const adapter = new MattermostAdapter(
        agent,
        presence,
        {
          instanceId,
          operator: {
            ...(config.agent.operatorMattermostId !== undefined && { mattermostId: config.agent.operatorMattermostId }),
          },
        },
      );
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);
      console.log(`cortex: mattermost adapter started (instance: ${instanceId}, ${instance.channels.length} channel(s))`);
    } catch (err) {
      console.error(`cortex: mattermost adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // MIG-7.2d: non-agent-bound renderers (dashboard, pagerduty, …).
  // Per architecture §9.2 these are activity-centric sinks that subscribe
  // to a slice of the bus and project envelopes into a UI / pager / log
  // stream. The G-1111 §4.6 fail-safe rule requires ≥2 distinct platform
  // classes covering `local.{org}.system.>` so an operational alert
  // reliably reaches the operator even if one sink is the thing that
  // broke. Renderers never publish on the bus (architecture §9.3).
  const renderers: Renderer[] = [];
  for (const raw of config.renderers ?? []) {
    // BotConfig types renderers as z.unknown() so legacy bot.yaml loads
    // without breakage (the canonical shape lives on cortex-config's
    // RendererSchema). Parse each entry strictly here — a typo fails fast
    // with a Zod error rather than surfacing as a runtime cast failure
    // inside the factory.
    const parseResult = RendererSchema.safeParse(raw);
    if (!parseResult.success) {
      console.error(
        `cortex: renderer config rejected by schema:`,
        parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      continue;
    }
    const rendererConfig = parseResult.data;
    try {
      const renderer = createRenderer(rendererConfig);
      await renderer.start();
      router.register(renderer.surfaceConfig);
      renderers.push(renderer);
      console.log(`cortex: ${rendererConfig.kind} renderer started (id: ${renderer.id})`);
    } catch (err) {
      // Renderer construction can throw (UnimplementedRendererKindError)
      // or `start()` can fail. Per the G-1111 fail-safe rule, ONE broken
      // renderer must not prevent the others from coming up — log + skip.
      console.error(
        `cortex: ${rendererConfig.kind} renderer failed to start:`,
        err instanceof Error ? err.message : err,
      );
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

  // MIG-5.6 (C-106): GitHub webhook receiver — opt-in via `github.receiver.enabled`
  // AND a non-empty `github.webhookSecret`. Publishes `local.{org}.github.{event}.{action}`
  // envelopes via `runtime.publish`; that path is a no-op when NATS isn't configured
  // (see `myelin/runtime.ts`), so this block stays safe to run even without NATS.
  let githubReceiver: GithubWebhookReceiverHandle | null = null;
  if (
    !options.disableGithubReceiver
    && config.github.receiver.enabled
    && config.github.webhookSecret.length > 0
  ) {
    try {
      githubReceiver = startGithubWebhookReceiver({
        secret: config.github.webhookSecret,
        port: config.github.receiver.port,
        hostname: config.github.receiver.hostname,
        source: systemEventSource,
        publish: (env) => runtime.publish(env),
      });
    } catch (err) {
      console.error(
        "cortex: github webhook receiver startup error (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (config.github.receiver.enabled && !config.github.webhookSecret) {
    console.warn(
      "cortex: github.receiver.enabled is true but github.webhookSecret is empty — receiver not started",
    );
  }

  // Shutdown — reverse-order; capped at SHUTDOWN_TIMEOUT_MS.
  //
  // Echo round-1 N2 — abandoned-set tracking: each drain step is named
  // and pre-registered in `pending` BEFORE the loop runs. Steps remove
  // themselves on completion. If the timeout fires first, whatever
  // remains in `pending` is the abandoned set:
  //   - the slow/hanging step itself (if any), and
  //   - every subsequent step that never got its turn (drain is sequential
  //     by design — a hung step also blocks its siblings).
  // The handle exposes `lastShutdownAbandoned` so the CLI can exit 1
  // (visible to launchd / operators) when shutdown was unclean.
  let shuttingDown = false;
  let lastShutdownAbandoned: string[] = [];
  const SHUTDOWN_TIMEOUT_MS = options.shutdownTimeoutMs ?? 15_000;

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\ncortex: shutting down...");

    // Named slots in shutdown order. Pre-register everything; each step
    // removes its name on completion so the leftover after the race is
    // the abandoned set.
    const pending = new Set<string>();
    const adapterStopNames = adapters.map((a) => `adapter ${a.instanceId} stop`);
    const rendererStopNames = renderers.map((r) => `renderer ${r.id} stop`);
    const allSlots: string[] = [
      "config-watcher stop",
      "usage-monitor stop",
      "dashboard stop",
      "github webhook receiver stop",
      ...adapterCleanup.map((_, i) => `outbound poller stop[${i}]`),
      "dispatch-listener stop",
      "surface-router stop",
      "dispatch-handler shutdown",
      ...adapterStopNames,
      ...rendererStopNames,
      "cloud publisher close",
      "runtime stop",
    ];
    for (const slot of allSlots) pending.add(slot);

    const completeSync = (slot: string, fn: () => void): void => {
      try { fn(); } catch (err) {
        console.error(`cortex: ${slot} error:`, err instanceof Error ? err.message : err);
      } finally {
        pending.delete(slot);
      }
    };
    const completeAsync = async (slot: string, p: Promise<unknown> | undefined): Promise<void> => {
      try { if (p) await p; } catch (err) {
        console.error(`cortex: ${slot} error:`, err instanceof Error ? err.message : err);
      } finally {
        pending.delete(slot);
      }
    };

    const drain = async (): Promise<void> => {
      completeSync("config-watcher stop", () => configWatcher?.stop());
      completeSync("usage-monitor stop", () => usageMonitor?.stop());
      completeSync("dashboard stop", () => dashboardApi?.stop?.());
      completeSync("github webhook receiver stop", () => githubReceiver?.stop());
      for (let i = 0; i < adapterCleanup.length; i++) {
        completeSync(`outbound poller stop[${i}]`, adapterCleanup[i]!);
      }
      await completeAsync("dispatch-listener stop", dispatchListener.stop());
      await completeAsync("surface-router stop", router.stop());
      await completeAsync("dispatch-handler shutdown", dispatchHandler.shutdown());
      for (let i = 0; i < adapters.length; i++) {
        await completeAsync(adapterStopNames[i]!, adapters[i]!.stop());
      }
      for (let i = 0; i < renderers.length; i++) {
        await completeAsync(rendererStopNames[i]!, renderers[i]!.stop());
      }
      await completeAsync("cloud publisher close", cloudPublisher?.close());
      await completeAsync("runtime stop", runtime.stop());
    };

    let timeoutFired = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timeoutFired = true;
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([drain(), timeout]);

    if (timeoutFired) {
      lastShutdownAbandoned = Array.from(pending);
      console.warn(
        `cortex: shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — abandoned: ${lastShutdownAbandoned.join(", ")}`,
      );
    } else {
      lastShutdownAbandoned = [];
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  return {
    stop,
    get lastShutdownAbandoned() {
      return lastShutdownAbandoned;
    },
    get agentRegistry() {
      return agentRegistry;
    },
  };
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

  // discord.js v15 prep — see comment in adapters/discord/client.ts.
  client.on("clientReady", () => {
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

// cortex#88 item 2 — `cortex start --dry-run` config validator.
//
// `scripts/postinstall.sh` already advertises `cortex start --config <path>
// --dry-run` to operators as a post-migration sanity check. This helper
// implements that contract: parse the file through the normal load path
// (`loadConfigWithAgents`, which validates against both `BotConfigSchema`
// and `CortexConfigSchema` depending on shape), print a one-line OK
// summary, exit 0. Schema parse failures surface verbatim with exit 2 so
// the postinstall path stays distinguishable from "file unreadable" (1).
//
// Exported so the unit tests can invoke it in-process with captured stdout
// /stderr — the production CLI block below delegates to it as well. No
// adapter startup, no NATS connect, no plist render, no daemon — purely
// schema validation.
export interface DryRunResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export function runDryRun(configPath: string): DryRunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const { config, inlineAgents } = loadConfigWithAgents(configPath);
    // cortex#106 item 4: clamp to the actual length — don't mask a degenerate
    // "no agents" config behind a fallback of 1. For cortex-shape input
    // `CortexConfigSchema.agents.min(1)` enforces ≥1 at parse time, so a
    // zero here means a legacy bot.yaml shape that the loader returned with
    // empty `inlineAgents` AND no synthesized singular agent — surface that
    // as a hard failure rather than reporting "1 agent" misleadingly.
    const agentCount = inlineAgents.length;
    if (agentCount === 0) {
      stderr.push(
        `cortex config validation FAILED: ${configPath} has no agents — config invalid`,
      );
      return { exitCode: 2, stdout: stdout.join("\n"), stderr: stderr.join("\n") + "\n" };
    }
    const rendererCount = config.renderers?.length ?? 0;
    const natsUrl = config.nats?.url ?? "(disabled)";
    stdout.push(
      `cortex config validation OK — ${agentCount} agents, ${rendererCount} renderers, NATS=${natsUrl}`,
    );
    return { exitCode: 0, stdout: stdout.join("\n") + "\n", stderr: stderr.join("\n") };
  } catch (err) {
    // Operator-readable: surface the Zod-shaped message verbatim. The
    // schema's own error formatter is already field-pathed (`agent.name:
    // Required`, etc.) so we don't try to re-pretty-print here.
    stderr.push(
      `cortex config validation FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: 2, stdout: stdout.join("\n"), stderr: stderr.join("\n") + "\n" };
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
    .option("--dry-run", "Validate config file and exit (no adapter / NATS / daemon startup)")
    .action(async (options) => {
      // cortex#88 item 2 — short-circuit: skip PID file, signal handlers,
      // and the full startCortex pipeline. Just parse + validate the config.
      if (options.dryRun) {
        const result = runDryRun(options.config);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      }

      mkdirSync(STATE_DIR, { recursive: true });
      checkSingleton();
      writeFileSync(PID_FILE, String(process.pid));

      process.on("uncaughtException", (err) => {
        console.error("cortex: uncaught exception (non-fatal):", err.message);
      });
      process.on("unhandledRejection", (reason) => {
        console.error("cortex: unhandled rejection (non-fatal):", reason);
      });

      // MIG-7.2e: detect cortex shape vs legacy bot.yaml. `loadConfigWithAgents`
      // returns both the BotConfig projection (for downstream legacy consumers)
      // and the rich cortex `agents[]` so `startCortex` can route per-instance
      // identity correctly.
      const { config, inlineAgents } = loadConfigWithAgents(options.config);
      const handle = await startCortex(config, {
        configPath: options.config,
        ...(inlineAgents.length > 0 && { inlineAgents }),
      });

      const shutdown = async () => {
        await handle.stop();
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        // Echo round-1 N2: surface dirty shutdown to launchd / operators
        // via a non-zero exit code. `lastShutdownAbandoned` is non-empty
        // only when the 15s drain timeout fired with subsystems still in
        // flight (logged by `stop()` already).
        const abandoned = handle.lastShutdownAbandoned;
        process.exit(abandoned.length > 0 ? 1 : 0);
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
