/**
 * S9 (epic #1514, plan §2, cortex#1523) — the FINAL lane of the `startCortex`
 * extraction. Lifts the ~600-line inline Discord/Mattermost/Slack adapter
 * construction (three near-identical `for` loops) out of `cortex.ts` into
 * `wireSurfaceAdapters`. Adapter CONSTRUCTION now routes through the SAME
 * `SurfacePluginRegistry` (`adapters/registry.ts`, ADR-0024 D5) the shared
 * surface gateway already uses — each platform's `AdapterPlugin.createAdapter`
 * (the bundle-loaded plugin) knows how to build a `new DiscordAdapter`
 * / `new MattermostAdapter` / `new SlackAdapter`.
 *
 * ## What moved, what stayed (mirrors S7/S8's split)
 *
 * MOVED here: the per-instance construct → router-register → start →
 * trust-resolver-register → (Pass 2) trust-merge → attachInboundDispatch →
 * (Discord-only) outbound-poller sequence, for all three platforms.
 *
 * STAYED in `cortex.ts`: `discordInstances`/`mattermostInstances`/
 * `slackInstances` derivation (S1), the `agentBy*Token` maps, the
 * `surfaceOwnershipPlan`/`gatewayOwned` computation, `adapterPolicyEngine` /
 * `-Lookup` / `-Registry` construction, `inboundWithGateBridge`, and
 * `setupOutboundLog` — all threaded in via `opts` (free-variable capture,
 * same idiom as `WireReleaseConsumersOpts`).
 *
 * ## ONE shared boot routine, three call sites — not one literal `for`
 *
 * The three platforms' pre-extraction loops shared a skeleton (enabled-check
 * → build presence → resolve agent → gateway-suppression check → construct →
 * register → start → best-effort trust-resolver register → optional Pass 2
 * trust-merge) but diverged in real, behaviour-affecting ways: Mattermost has
 * no trust-resolver Pass 2 at all and never logged a disabled-skip or a
 * "no instances configured" line; Discord's Pass 2 additionally wires the
 * legacy outbound-poller; the three log lines differ in more than the
 * platform name. `bootPlatformAdapters<TInstance, TPresence, TAdapter>` is
 * that ONE shared skeleton, generic over the per-platform instance/presence/
 * adapter shapes; `wireSurfaceAdapters` calls it three times — discord, then
 * mattermost, then slack, in that FIXED order (see below) — each with an
 * `AdapterBootDescriptor` supplying the divergent bits explicitly. TypeScript
 * can't express "one `for` over a heterogeneous [Discord, Mattermost, Slack]
 * descriptor array" without erasing the per-platform adapter type the
 * trust-merge step needs (see the next section), so this is the shape that
 * keeps the shared skeleton in ONE place without losing that type safety.
 *
 * ## PRESERVE ORDER
 *
 * Adapters are built + registered discord → mattermost → slack, and within
 * each platform Pass 1 (construct/start/trust-register) fully completes for
 * every instance before Pass 2 (trust-merge/attachInboundDispatch) begins —
 * EXACTLY the sequence the pre-extraction inline blocks ran in. This is
 * preserved DEFENSIVELY to match that sequence, not because a test here
 * demonstrates that reordering breaks something: the unit test
 * (`surface-adapter-boot.test.ts`) pins that we EMIT discord → mattermost →
 * slack, it doesn't prove a different order would fail. The basis for
 * "don't reorder" is the ORIGINAL code's own invariants — cortex#98 item 1 /
 * cortex#235 r1#7's TOCTOU-closing Pass-1-before-Pass-2 split, and whatever
 * `liveSurfaces`/trust-resolver-registration ordering assumptions existed
 * pre-extraction — not a failure test added in this slice. Do not reorder
 * the three `bootPlatformAdapters` calls in `wireSurfaceAdapters` without a
 * deliberate, reviewed decision.
 *
 * ## `createAdapter` returns `PlatformAdapter`; this module needs the concrete class
 *
 * `AdapterPlugin.createAdapter` declares a generic `PlatformAdapter` return —
 * the shape `WebAdapter` and any test fake also satisfy. This module's
 * trust-merge / router-register / outbound-log machinery needs members
 * (`setTrustedBotIds`, `trustedBotIdCount`, `surfaceConfig`) that are NOT on
 * the generic interface — `WebAdapter` deliberately has none of them (see
 * `web-adapter.test.ts`'s explicit `"surfaceConfig" in adapter === false`
 * assertion), so widening the shared interface to require them would break
 * that invariant. Since each descriptor here only ever resolves its OWN
 * platform's plugin (never `web`), and the production plugin always
 * constructs the matching concrete class, each descriptor's `constructAdapter`
 * narrows the return with an explicit `as` cast immediately after
 * construction. A test-registered plugin must return an object that actually
 * implements the concrete class's members this module calls, or the cast is
 * a lie the test's own assertions will catch (see
 * `surface-adapter-boot.test.ts`) — it is never silently unsafe in
 * production, where the cast is always true.
 *
 * ## Location (Sage #1547 r1 architecture nit)
 *
 * Lives in `src/runner/`, not `src/gateway/` — `src/gateway/` is
 * CONTEXT.md's bounded term for the shared surface gateway (a SEPARATE
 * process, cortex#524); this module is the per-stack DIRECT-connect boot
 * lane and belongs beside its sibling `*-consumer-boot.ts` lanes
 * (`review-consumer-boot.ts`, `brain-consumer-boot.ts`,
 * `release-consumer-boot.ts`, all S7/S8). It resolves each platform's
 * `AdapterPlugin` from the shared `SurfacePluginRegistry`
 * (`src/adapters/registry.ts`) — only the boot-wiring module lives here, not
 * the plugins it constructs from.
 */

import type { InboundMessage, PlatformAdapter } from "../adapters/types";
import type { AgentConfig } from "../common/types/config";
import {
  type Agent,
  type DiscordPresence,
  type MattermostPresence,
  type SlackPresence,
} from "../common/types/cortex-config";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { SurfaceRouter, SurfaceAdapter } from "../bus/surface-router";
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../common/policy";
import type { AgentRegistry } from "../common/agents/registry";
import type { TrustResolver, Platform } from "../common/agents/trust-resolver";
import { surfaceInstanceEnabled } from "../common/config/loader";
import type { AdapterPlugin, SurfacePluginRegistry } from "../adapters/registry";
import { buildAdapterPolicyPort, buildAdapterSystemEventPort } from "../adapters/plugin-support";
import { formatEnvelopeAsMarkdown } from "../adapters/envelope-renderer";

// =============================================================================
// Per-platform boot descriptor — the divergent bits `bootPlatformAdapters` needs
// =============================================================================

/**
 * The one member `bootPlatformAdapters`' shared skeleton needs beyond
 * `PlatformAdapter` itself: ALL THREE platforms' concrete adapters expose a
 * `surfaceConfig` getter for `router.register()` (unlike `setTrustedBotIds` /
 * `trustedBotIdCount`, which only Discord + Slack have — see
 * `TrustResolverSupport.applyMergedTrust` below for how those are kept out of
 * the generic bound). `WebAdapter` deliberately has none of this — it never
 * flows through this module (see the module doc).
 */
interface RouterRegistrable {
  readonly surfaceConfig: SurfaceAdapter;
}

interface StartedAdapter<TInstance, TAdapter extends PlatformAdapter> {
  adapter: TAdapter;
  agent: Agent;
  instance: TInstance;
  instanceId: string;
  explicitTrustedBotIds: ReadonlySet<string>;
}

/** Pass-2 (trust-resolver merge) support — Discord + Slack only; Mattermost has none. */
interface TrustResolverSupport<TInstance, TAdapter extends PlatformAdapter> {
  /**
   * Suffix appended to the trust-resolver-register failure log line.
   * Discord's pre-extraction text carried none; Slack's carried `" (slack)"`
   * — preserved verbatim, not derived from `platform`.
   */
  registerFailSuffix: string;
  /**
   * The platform-specific fragment inside the Pass-2 "adapter started" log
   * line. Declared as an arrow-typed property (not method shorthand) — the
   * shared skeleton destructures these off `trustResolverSupport` before
   * calling them, which `@typescript-eslint/unbound-method` flags for
   * method-shorthand-declared members.
   */
  startedSummary: (instance: TInstance) => string;
  /**
   * Apply the merged trust allowlist to the CONCRETE adapter
   * (`setTrustedBotIds` + `attachInboundDispatch`) and return the resulting
   * `trustedBotIdCount` for the log line. Lives on the descriptor (not the
   * shared generic skeleton) because those members aren't on the generic
   * `PlatformAdapter` bound — Mattermost's concrete class doesn't have them,
   * so the shared skeleton never references them directly.
   */
  applyMergedTrust: (adapter: TAdapter, merged: ReadonlySet<string>) => number;
  /** Discord-only: the legacy outbound-poller wiring, run after the merge + log. */
  afterMerge?: (adapter: TAdapter, instance: TInstance, instanceId: string) => void;
}

interface AdapterBootDescriptor<
  TInstance extends { enabled: boolean },
  TPresence,
  TAdapter extends PlatformAdapter & RouterRegistrable,
> {
  readonly platform: Platform;
  readonly instances: readonly TInstance[];
  /**
   * `config.discord.length` / `config.slack.length` — the ORIGINAL
   * pre-extraction check on the flat INLINE-config count, not
   * `instances.length` (which also includes agents.d/ fragment-only
   * instances appended by S1). `undefined` for Mattermost — it never logged
   * this line pre-extraction; that asymmetry is preserved, not "fixed".
   */
  readonly noInstancesConfiguredCount?: number;
  /** Disabled-skip log line, or `undefined` to skip logging (Mattermost's pre-extraction behaviour). */
  disabledSkipLog?(instance: TInstance): string;
  /** Extra pre-construction validation beyond `surfaceInstanceEnabled` (Mattermost's apiUrl/apiToken guard). Returns the error to log + skip, or `undefined` to proceed. */
  extraValidate?(instance: TInstance): string | undefined;
  instanceIdFor(instance: TInstance): string;
  buildPresence(instance: TInstance): TPresence;
  lookupAgent(presence: TPresence): Agent | undefined;
  fallbackAgent(presence: TPresence): Agent;
  /** cortex#84 cross-process bridge allowlist — Discord + Slack only. */
  trustedBotIdsFor?(instance: TInstance): ReadonlySet<string>;
  constructAdapter(args: {
    agent: Agent;
    presence: TPresence;
    instanceId: string;
    explicitTrustedBotIds: ReadonlySet<string> | undefined;
  }): TAdapter;
  /** Mattermost-only: its immediate post-start log line (Discord/Slack log in Pass 2 instead). */
  postStartLog?(adapter: TAdapter, instance: TInstance, instanceId: string): string;
  /** Present for Discord + Slack; `undefined` for Mattermost (no trust resolver, no Pass 2). */
  trustResolverSupport?: TrustResolverSupport<TInstance, TAdapter>;
}

/**
 * Minimal shape {@link applyStandardMergedTrust} needs — Discord + Slack's
 * concrete adapters both satisfy this structurally (Mattermost's doesn't,
 * which is exactly why this lives behind `TrustResolverSupport.applyMergedTrust`
 * rather than the generic skeleton — see that field's doc).
 */
interface TrustMergeable {
  setTrustedBotIds(ids: ReadonlySet<string>): void;
  attachInboundDispatch(): void;
  readonly trustedBotIdCount: number;
}

/**
 * cortex#1795 (S10) — `SlackAdapter`'s concrete class extracted to the
 * `metafactory-cortex-adapter-slack` bundle; its TYPE is no longer
 * importable in-tree. This module only ever touches slack's
 * `PlatformAdapter` + `RouterRegistrable` + `TrustMergeable` surface (never
 * a slack-specific member) — the SAME structural bound `TAdapter` is already
 * constrained to, and `applyStandardMergedTrust` already takes
 * `TrustMergeable` directly rather than the concrete class. A structural
 * alias satisfies every use site the real `SlackAdapter` type used to
 * (the `AdapterBootDescriptor<..., SlackLikeAdapter>` type argument, and the
 * `as SlackLikeAdapter` cast after the slack plugin's `createAdapter(...)`
 * construction) — the
 * REAL adapter the bundle constructs at runtime still satisfies this
 * structurally, so behaviour is unchanged; only the compile-time type
 * source moved.
 */
type SlackLikeAdapter = PlatformAdapter & RouterRegistrable & TrustMergeable;

/**
 * cortex#1797 (S12) — `DiscordAdapter`'s concrete class extracted to the
 * `metafactory-cortex-adapter-discord` bundle (the FOURTH and FINAL in-tree
 * adapter to extract); its TYPE is no longer importable in-tree. Same
 * structural-alias pattern as {@link SlackLikeAdapter} — this module only
 * ever touches discord's `PlatformAdapter` + `RouterRegistrable` +
 * `TrustMergeable` surface (never a discord-specific member like
 * `getClient()`, which only the now-extracted `outbound-log.ts` used). The
 * REAL adapter the bundle constructs at runtime still satisfies this
 * structurally, so behaviour is unchanged; only the compile-time type
 * source moved.
 */
type DiscordLikeAdapter = PlatformAdapter & RouterRegistrable & TrustMergeable;

/**
 * Shared `applyMergedTrust` body — Discord + Slack's pre-hoist descriptors
 * had this identical three-line closure; hoisted once (Sage #1547 r1 nit 6)
 * so a future third trust-supporting platform doesn't re-copy it. Takes the
 * `TrustMergeable` shape directly (not a generic `<TAdapter extends
 * TrustMergeable>`) — the type parameter would be used only once in the
 * signature, which `@typescript-eslint/no-unnecessary-type-parameters`
 * correctly flags as buying no extra safety over the plain interface type.
 */
function applyStandardMergedTrust(
  adapter: TrustMergeable,
  merged: ReadonlySet<string>,
): number {
  adapter.setTrustedBotIds(merged);
  adapter.attachInboundDispatch();
  return adapter.trustedBotIdCount;
}

/**
 * MIG-7.2e: the synthesized-from-singular fallback `Agent` each platform's
 * `fallbackAgent` closure built when no `agentBy*Token` match exists —
 * identical across all three pre-hoist descriptors except for the
 * `presence` key (hoisted, Sage #1547 r1 nit 5). The `persona` sentinel
 * value is a marker, never actually read (this synthetic agent never spawns
 * a CC session).
 */
function deferredFallbackAgent(config: AgentConfig, presence: Agent["presence"]): Agent {
  return {
    id: config.agent.name,
    displayName: config.agent.displayName,
    persona: "(deferred-mig-7.2e)",
    trust: [],
    presence,
  };
}

/**
 * Sage #1547 r4 nit — Mattermost's and Slack's `instanceIdFor` closures
 * built an identical shape (`instance.instanceId ?? (configInstances.length
 * > 1 ? "${agentName}-${platform}-${index}" : "${agentName}-${platform}")`),
 * differing only in the platform word + which config array to index into.
 * `configInstances` MUST be `opts.config.mattermost` / `opts.config.slack`
 * (the flat INLINE-config array), NOT `mattermostInstances`/`slackInstances`
 * (which also include agents.d/ fragment-only instances, S1) — matches the
 * pre-extraction `config.X.indexOf(instance)` / `config.X.length` exactly.
 * Discord doesn't use this shape at all (its instanceId derives from
 * `guildId`, never an index), so it isn't a third caller.
 */
function indexedInstanceId<TInstance extends { instanceId?: string }>(
  configInstances: readonly TInstance[],
  agentName: string,
  platform: string,
  instance: TInstance,
): string {
  return (
    instance.instanceId ??
    (configInstances.length > 1
      ? `${agentName}-${platform}-${configInstances.indexOf(instance)}`
      : `${agentName}-${platform}`)
  );
}

/**
 * Sage #1547 r2 nit — Discord's and Slack's `constructAdapter` closures built
 * an identical factory-arg block (instanceId/source/binding/runtime/agent/
 * principal/presence + the policy triad + trustedBotIds/surfaceSubjects/
 * surfaceFallbackChannelId), differing only in Discord's extra
 * `allowedGuildIds`/`presenceByGuildId` (Slack's factory args don't have
 * those fields at all — Mattermost's shape diverges enough elsewhere —
 * no `runtime`/`source`, no trust fields — that it stays hand-written).
 * Each descriptor spreads this, then Discord adds its two extra fields.
 */
function baseFactoryArgs<TPresence extends { surfaceSubjects: string[]; surfaceFallbackChannelId?: string }>(args: {
  instanceId: string;
  systemEventSource: SystemEventSource;
  runtime: MyelinRuntime | undefined;
  agent: Agent;
  principal: Record<string, unknown>;
  presence: TPresence;
  explicitTrustedBotIds: ReadonlySet<string> | undefined;
  policyEngine: PolicyEngine | undefined;
  policyLookup: PlatformPrincipalIndex | undefined;
  policyRegistry: PrincipalRegistry | undefined;
}) {
  return {
    instanceId: args.instanceId,
    source: args.systemEventSource,
    binding: presenceAsBinding(args.presence),
    runtime: args.runtime,
    agent: args.agent,
    principal: args.principal,
    presence: args.presence,
    ...(args.explicitTrustedBotIds !== undefined && { trustedBotIds: args.explicitTrustedBotIds }),
    ...(args.policyEngine !== undefined && { policyEngine: args.policyEngine }),
    ...(args.policyLookup !== undefined && { policyLookup: args.policyLookup }),
    ...(args.policyRegistry !== undefined && { policyRegistry: args.policyRegistry }),
    // cortex#1795 (S10) — ADDITIVE host-bound ports, alongside the raw
    // fields above. Discord/Mattermost's (still un-inverted) `createAdapter`
    // bodies read the raw `policyEngine`/`policyLookup`/`policyRegistry`/
    // `runtime`/`source` fields and ignore these; the extracted slack
    // plugin's `createAdapter` reads ONLY `policy`/`systemEvents`/
    // `formatEnvelope` and ignores the raw fields. Both shapes coexist in
    // the SAME record — each platform's plugin picks the keys it knows
    // about (`AdapterPlugin.createAdapter`'s documented convention).
    policy: buildAdapterPolicyPort({
      policyEngine: args.policyEngine,
      policyLookup: args.policyLookup,
      policyRegistry: args.policyRegistry,
    }),
    systemEvents: buildAdapterSystemEventPort({
      runtime: args.runtime,
      source: args.systemEventSource,
    }),
    formatEnvelope: formatEnvelopeAsMarkdown,
    surfaceSubjects: args.presence.surfaceSubjects,
    ...(args.presence.surfaceFallbackChannelId !== undefined && {
      surfaceFallbackChannelId: args.presence.surfaceFallbackChannelId,
    }),
  };
}

/** Shared dependencies every platform boot reads from. */
interface BootCtx {
  gatewayOwned: ReadonlySet<string>;
  router: SurfaceRouter;
  agentRegistry: AgentRegistry;
  trustResolver: TrustResolver;
  inboundWithGateBridge: (
    adapter: PlatformAdapter,
    agent: Agent,
  ) => (msg: InboundMessage) => Promise<void>;
  adapters: PlatformAdapter[];
  liveSurfaces: Set<string>;
}

// =============================================================================
// The shared skeleton — ONE implementation, called once per platform
// =============================================================================

async function bootPlatformAdapters<
  TInstance extends { enabled: boolean },
  TPresence,
  TAdapter extends PlatformAdapter & RouterRegistrable,
>(
  descriptor: AdapterBootDescriptor<TInstance, TPresence, TAdapter>,
  ctx: BootCtx,
): Promise<void> {
  const started: StartedAdapter<TInstance, TAdapter>[] = [];

  for (const instance of descriptor.instances) {
    if (!surfaceInstanceEnabled(instance)) {
      const log = descriptor.disabledSkipLog?.(instance);
      if (log !== undefined) console.log(log);
      continue;
    }
    const validationError = descriptor.extraValidate?.(instance);
    if (validationError !== undefined) {
      console.error(validationError);
      continue;
    }

    const instanceId = descriptor.instanceIdFor(instance);
    const presence = descriptor.buildPresence(instance);
    const matchedAgent = descriptor.lookupAgent(presence);
    const agent = matchedAgent ?? descriptor.fallbackAgent(presence);

    // GW.a.3b.2c — yield to the gateway when it owns this surface (identical
    // across all three platforms pre-extraction, modulo the platform word).
    if (ctx.gatewayOwned.has(`${descriptor.platform}:${agent.id}`)) {
      console.log(
        `cortex: per-stack ${descriptor.platform} adapter for agent "${agent.id}" suppressed — the shared surface gateway owns this surface (CORTEX_GATEWAY).`,
      );
      continue; // skip — the gateway owns this connection
    }

    try {
      const explicitTrustedBotIds = descriptor.trustedBotIdsFor?.(instance);
      const adapter = descriptor.constructAdapter({ agent, presence, instanceId, explicitTrustedBotIds });
      // Register the adapter's surface-router face. Empty `surfaceSubjects`
      // makes this a no-op match; harmless to register either way.
      ctx.router.register(adapter.surfaceConfig);
      await adapter.start(ctx.inboundWithGateBridge(adapter, agent));
      // B-3: confirm this surface live (idempotent — seeded from config; a
      // hot-reloaded surface joins here).
      ctx.liveSurfaces.add(adapter.platform);
      ctx.adapters.push(adapter);

      if (descriptor.trustResolverSupport && ctx.agentRegistry.tryGetById(agent.id)) {
        try {
          const botUserId = await adapter.getPlatformUserId();
          ctx.trustResolver.register(descriptor.platform, botUserId, agent.id);
        } catch (err) {
          console.error(
            `cortex: trust-resolver register for "${agent.id}"${descriptor.trustResolverSupport.registerFailSuffix} failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const postStart = descriptor.postStartLog?.(adapter, instance, instanceId);
      if (postStart !== undefined) console.log(postStart);

      if (descriptor.trustResolverSupport) {
        started.push({
          adapter,
          agent,
          instance,
          instanceId,
          explicitTrustedBotIds: explicitTrustedBotIds ?? new Set<string>(),
        });
      }
    } catch (err) {
      console.error(
        `cortex: ${descriptor.platform} adapter ${instanceId} failed to start:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Pass 2 — merge resolver-derived in-process peer bot ids on top of each
  // adapter's principal-explicit set, log the final allowlist size, then
  // attachInboundDispatch() to drain queued events through the merged
  // allowlist. Order is load-bearing: setTrustedBotIds MUST complete before
  // attachInboundDispatch (cortex#98 item 1 / cortex#235 r1#7).
  if (descriptor.trustResolverSupport) {
    const { startedSummary, applyMergedTrust, afterMerge } = descriptor.trustResolverSupport;
    for (const { adapter, agent, instance, instanceId, explicitTrustedBotIds } of started) {
      const merged = new Set<string>(explicitTrustedBotIds);
      const resolvedPeers: string[] = [];
      const skippedPeers: string[] = [];
      for (const peerAgentId of agent.trust) {
        if (peerAgentId === agent.id) continue; // self-loop guard owns this case
        const peerBotId = ctx.trustResolver.lookupPlatformIdByAgent(descriptor.platform, peerAgentId);
        if (peerBotId !== undefined) {
          merged.add(peerBotId);
          resolvedPeers.push(peerAgentId);
        } else {
          skippedPeers.push(peerAgentId);
        }
      }
      // `setTrustedBotIds` / `attachInboundDispatch` / `trustedBotIdCount`
      // aren't on the generic `PlatformAdapter` bound (Mattermost's concrete
      // class doesn't have them) — `applyMergedTrust` is the descriptor's
      // concrete-typed callback that applies them (see the interface doc).
      const trustedBotIdCount = applyMergedTrust(adapter, merged);
      console.log(
        `cortex: ${descriptor.platform} adapter started (instance: ${instanceId}, ${startedSummary(instance)}, ` +
          `trustedBotIds: ${trustedBotIdCount}` +
          (resolvedPeers.length > 0 ? ` [resolver: ${resolvedPeers.join(", ")}]` : "") +
          (skippedPeers.length > 0 ? ` [cross-process: ${skippedPeers.join(", ")}]` : "") +
          `)`,
      );
      afterMerge?.(adapter, instance, instanceId);
    }
  }

  // Sage #1547 r4 (real behavior deviation, fixed) — this check must run
  // AFTER Pass 2, not before. The pre-extraction inline blocks emitted "no
  // {platform} instances configured" only once Pass 2 (and, for Discord,
  // the outbound-poller wiring) had already finished — confirmed against
  // the pre-S9 `cortex.ts` (both the discord and slack blocks). Since
  // `noInstancesConfiguredCount` is `config.<platform>.length` (the INLINE
  // count) while `instances` also includes agents.d/ fragment-only
  // instances (S1), a config with 0 inline entries but ≥1 fragment
  // instance would otherwise print this line BEFORE those fragment
  // instances' "adapter started" lines — reversed vs. the original order.
  if (descriptor.noInstancesConfiguredCount === 0) {
    console.log(`cortex: no ${descriptor.platform} instances configured`);
  }
}

// =============================================================================
// Public API
// =============================================================================

/** Inputs `cortex.ts` threads into the surface-adapter boot wiring. */
export interface WireSurfaceAdaptersOpts {
  config: AgentConfig;
  discordInstances: readonly AgentConfig["discord"][number][];
  mattermostInstances: readonly AgentConfig["mattermost"][number][];
  slackInstances: readonly AgentConfig["slack"][number][];
  agentByDiscordToken: ReadonlyMap<string, Agent>;
  agentByMattermostApiToken: ReadonlyMap<string, Agent>;
  agentBySlackBotToken: ReadonlyMap<string, Agent>;
  /** GW.a.3b.2c ownership plan's suppression keys — empty when `CORTEX_GATEWAY` is off. */
  gatewayOwned: ReadonlySet<string>;
  router: SurfaceRouter;
  runtime: MyelinRuntime | undefined;
  /** Always wired for Discord + Slack. Mattermost's inline construction never wired it — preserved as-is (see the module doc + `gateway-adapters.ts`'s `source` doc). */
  systemEventSource: SystemEventSource;
  principalDiscordId: string | undefined;
  principalMattermostId: string | undefined;
  principalSlackId: string | undefined;
  policyEngine: PolicyEngine | undefined;
  policyLookup: PlatformPrincipalIndex | undefined;
  policyRegistry: PrincipalRegistry | undefined;
  agentRegistry: AgentRegistry;
  trustResolver: TrustResolver;
  inboundWithGateBridge: (
    adapter: PlatformAdapter,
    agent: Agent,
  ) => (msg: InboundMessage) => Promise<void>;
  disableOutboundPoller: boolean;
  /**
   * The legacy JSONL→`#agent-log`/worklog bridge. Cortex#1787 (S2) moved
   * the implementation into `adapters/discord/outbound-log.ts` (exported
   * as `attachLegacyOutboundLog` from the adapter's index) so the
   * discord.js-specific coupling — `DiscordAdapter.getClient()`,
   * `formatEventForDiscord`, `WorklogManager`-with-`Client` — lived on the
   * adapter's side of the boundary instead of in `cortex.ts`. Threaded
   * through as a function reference (not imported directly here) to keep
   * this Discord-only, otherwise-unrelated legacy path opt-in via
   * `cortex.ts`'s wiring rather than a hard import from this shared boot
   * module.
   *
   * cortex#1797 (S12 MOVE) — `attachLegacyOutboundLog` now lives ENTIRELY
   * inside the `metafactory-cortex-adapter-discord` bundle (moved alongside
   * the rest of `src/adapters/discord/`), which cortex core can no longer
   * statically import (bundles load dynamically, at runtime, through the
   * plugin loader — never via a compile-time `import`). `cortex.ts` can
   * therefore no longer wire a real implementation here; this field is now
   * OPTIONAL and `cortex.ts` omits it. The JSONL-polling direct-call bridge
   * (per-CC-hook-event `#agent-log` posts + `WorklogManager`'s direct-call
   * thread creation for `enableAgentLog`/`worklogChannelId`) goes UNWIRED
   * from `cortex.ts`'s boot sequence as a result — a genuine, intentional
   * behaviour change this extraction accepts, flagged for the orchestrator.
   * The BUS-DRIVEN sibling path (`WorklogManager.surfaceConfig`,
   * `dispatch.task.*` envelopes via the surface-router) is UNAFFECTED and
   * already the documented forward path (`outbound-log.ts`'s own module doc:
   * "MIG-7.2d Renderer cutover is pending") — deployments that need the
   * legacy per-event JSONL bridge specifically should either stay on a
   * pre-S12 cortex version until a follow-up re-exposes it through the
   * plugin contract, or migrate onto the bus-driven path.
   */
  setupOutboundLog?: (
    discordAdapter: PlatformAdapter,
    instance: AgentConfig["discord"][number],
    config: AgentConfig,
    router: SurfaceRouter,
    systemEventSource: SystemEventSource,
  ) => (() => void) | null;
  /** Shared, NOT owned — `cortex.ts` still declares + reads this array for the shutdown drain and hot-reload loop. */
  adapters: PlatformAdapter[];
  /** Shared, NOT owned — `cortex.ts` still declares + reads this array for the shutdown drain. */
  adapterCleanup: (() => void)[];
  /** Shared, NOT owned. */
  liveSurfaces: Set<string>;
  /**
   * cortex#1788 (S3, ADR-0024 D5) — the `(kind, id)`-keyed registry
   * (`src/adapters/registry.ts`). cortex.ts composes ONE registry and
   * threads it to both this boot path and the gateway path
   * (`buildGatewayAdapters`). REQUIRED (cortex#1896) — there is no legacy
   * factory fallback; each platform's adapter is constructed by resolving its
   * `AdapterPlugin` from this registry and calling `createAdapter`. Tests
   * register recording `AdapterPlugin` stubs on a registry they build.
   */
  registry: SurfacePluginRegistry;
}

/**
 * Boot the Discord, Mattermost, and Slack adapters for a stack's own
 * `agents[].presence.*` — the per-stack (non-gateway) direct-connect path.
 * Construction resolves each platform's `AdapterPlugin` from the SAME
 * `SurfacePluginRegistry` the shared surface gateway uses (see the module
 * doc), then calls its `createAdapter`. Mutates the shared
 * `opts.adapters` / `opts.adapterCleanup` / `opts.liveSurfaces` in place;
 * returns nothing — nothing else in `cortex.ts` reads per-adapter state
 * beyond those three shared arrays (mirrors `wireReleaseConsumers`'s
 * shared-not-owned array convention).
 *
 * Runs discord → mattermost → slack, in that FIXED order — see the module
 * doc's "PRESERVE ORDER" section.
 */
export async function wireSurfaceAdapters(opts: WireSurfaceAdaptersOpts): Promise<void> {
  // cortex#1896 — resolve each platform's plugin from the composed registry
  // and call `createAdapter` directly (replaces the retired legacy-factory
  // shim). A missing platform is a boot-time misconfiguration (`cortex.ts`
  // always registers the bundle-loaded plugin before wiring), surfaced as a
  // loud, actionable error.
  const requireAdapter = (platform: string): AdapterPlugin => {
    const plugin = opts.registry.getAdapter(platform);
    if (!plugin) {
      throw new Error(
        `wireSurfaceAdapters: no adapter plugin registered for platform "${platform}"`,
      );
    }
    return plugin;
  };
  const ctx: BootCtx = {
    gatewayOwned: opts.gatewayOwned,
    router: opts.router,
    agentRegistry: opts.agentRegistry,
    trustResolver: opts.trustResolver,
    inboundWithGateBridge: opts.inboundWithGateBridge,
    adapters: opts.adapters,
    liveSurfaces: opts.liveSurfaces,
  };

  // ── Discord ─────────────────────────────────────────────────────────────
  const discordDescriptor: AdapterBootDescriptor<
    AgentConfig["discord"][number],
    DiscordPresence,
    DiscordLikeAdapter
  > = {
    platform: "discord",
    instances: opts.discordInstances,
    noInstancesConfiguredCount: opts.config.discord.length,
    disabledSkipLog: (instance) =>
      `cortex: discord instance ${instance.instanceId ?? instance.guildId} disabled — skipping`,
    instanceIdFor: (instance) =>
      instance.instanceId ?? `${opts.config.agent.name}-discord-${instance.guildId}`,
    buildPresence: (instance): DiscordPresence => ({
      enabled: instance.enabled,
      token: instance.token,
      guildId: instance.guildId,
      agentChannelId: instance.agentChannelId,
      logChannelId: instance.logChannelId,
      ...(instance.worklogChannelId !== undefined && { worklogChannelId: instance.worklogChannelId }),
      contextDepth: instance.contextDepth,
      enableAgentLog: instance.enableAgentLog,
      ...(instance.operatorRoleId !== undefined && { operatorRoleId: instance.operatorRoleId }),
      trustedBotIds: instance.trustedBotIds,
      dmOwner: instance.dmOwner,
      surfaceSubjects: instance.surfaceSubjects,
      ...(instance.surfaceFallbackChannelId !== undefined && {
        surfaceFallbackChannelId: instance.surfaceFallbackChannelId,
      }),
    }),
    lookupAgent: (presence) => opts.agentByDiscordToken.get(presence.token),
    fallbackAgent: (presence) => deferredFallbackAgent(opts.config, { discord: presence }),
    trustedBotIdsFor: (instance) => new Set<string>(instance.trustedBotIds),
    constructAdapter: ({ agent, presence, instanceId, explicitTrustedBotIds }) =>
      requireAdapter("discord").createAdapter({
        ...baseFactoryArgs({
          instanceId,
          systemEventSource: opts.systemEventSource,
          runtime: opts.runtime,
          agent,
          principal: {
            ...(opts.principalDiscordId !== undefined && { discordId: opts.principalDiscordId }),
          },
          presence,
          explicitTrustedBotIds,
          policyEngine: opts.policyEngine,
          policyLookup: opts.policyLookup,
          policyRegistry: opts.policyRegistry,
        }),
        // Sage #1547 r1 — NOT a scoping change. The inline pre-extraction
        // `new DiscordAdapter(...)` call passed NEITHER of these two fields,
        // but `DiscordAdapter`'s own constructor (adapters/discord/index.ts)
        // already defaults `presenceByGuildId` to `new Map([[presence.guildId,
        // presence], ...(infra.presenceByGuildId ?? [])])` and `allowedGuildIds`
        // to `infra.allowedGuildIds ?? new Set(presenceByGuildId.keys())` — i.e.
        // exactly the single-guild set/map built here. Passing them explicitly
        // reproduces that construction-time default byte-for-byte; it does not
        // narrow or widen the adapter's effective guild allowlist — pinned by
        // `src/adapters/discord/__tests__/guild-filter.test.ts`'s "explicit
        // allowedGuildIds/presenceByGuildId == omitted (S9, cortex#1523)" suite
        // (Sage #1547 r2), which fires own-guild/foreign-guild/DM messages at a
        // REAL `DiscordAdapter` built both ways and asserts identical dispatch.
        allowedGuildIds: new Set([presence.guildId]),
        presenceByGuildId: new Map([[presence.guildId, presence]]),
      }) as DiscordLikeAdapter,
    trustResolverSupport: {
      registerFailSuffix: "",
      startedSummary: (instance) => `guild: ${instance.guildId}`,
      applyMergedTrust: applyStandardMergedTrust,
      afterMerge: (adapter, instance, _instanceId) => {
        // Outbound JSONL → #agent-log + worklog (opt-in). Dashboard + cloud
        // delivery handled by the HTTP path (H-004). Runs after the trust
        // merge so the log-line ordering stays "adapter started → outbound
        // poller wired"; poller setup is decoupled from the trust-resolver
        // merge.
        if (!opts.disableOutboundPoller && (instance.enableAgentLog || instance.worklogChannelId)) {
          const cleanup = opts.setupOutboundLog?.(adapter, instance, opts.config, opts.router, opts.systemEventSource);
          if (cleanup) opts.adapterCleanup.push(cleanup);
        }
      },
    },
  };
  await bootPlatformAdapters(discordDescriptor, ctx);

  // ── Mattermost ──────────────────────────────────────────────────────────
  const mattermostDescriptor: AdapterBootDescriptor<
    AgentConfig["mattermost"][number],
    MattermostPresence,
    // cortex#1796 (S11 MOVE) — `MattermostAdapter`'s concrete class no
    // longer lives in-tree (extracted to `metafactory-cortex-adapter-mattermost`);
    // constructed via `requireAdapter("mattermost").createAdapter(...)` →
    // the bundle-loaded plugin's `createAdapter`, so only its STRUCTURAL
    // shape is available at this boundary. `PlatformAdapter & RouterRegistrable`
    // is exactly what this descriptor actually needs (Mattermost carries no
    // `trustResolverSupport`/`TrustMergeable` methods — see those fields'
    // docs) — same structural-bound pattern the generic skeleton already
    // uses everywhere else.
    PlatformAdapter & RouterRegistrable
  > = {
    platform: "mattermost",
    instances: opts.mattermostInstances,
    // No `noInstancesConfiguredCount` / `disabledSkipLog` — Mattermost never
    // logged either pre-extraction; preserved, not "fixed".
    extraValidate: (instance) =>
      !instance.apiUrl || !instance.apiToken
        ? `cortex: mattermost instance ${instance.instanceId ?? "unnamed"} missing apiUrl/apiToken — skipping`
        : undefined,
    instanceIdFor: (instance) =>
      indexedInstanceId(opts.config.mattermost, opts.config.agent.name, "mattermost", instance),
    buildPresence: (instance): MattermostPresence => ({
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
    }),
    lookupAgent: (presence) =>
      presence.apiToken ? opts.agentByMattermostApiToken.get(presence.apiToken) : undefined,
    fallbackAgent: (presence) => deferredFallbackAgent(opts.config, { mattermost: presence }),
    // No trustedBotIdsFor — Mattermost's presence carries no trust field.
    constructAdapter: ({ agent, presence, instanceId }) =>
      requireAdapter("mattermost").createAdapter({
        instanceId,
        // Mattermost's inline construction never wired `runtime`/`source` —
        // preserved as-is (see the module doc + gateway-adapters.ts's `source` doc).
        source: undefined,
        binding: presenceAsBinding(presence),
        runtime: undefined,
        agent,
        principal: {
          ...(opts.principalMattermostId !== undefined && { mattermostId: opts.principalMattermostId }),
        },
        presence,
        // cortex#1796 (S11, ADR-0024 D5 extraction lane) — mattermost's
        // (now out-of-tree) plugin reads a host-bound `AdapterPolicyPort`
        // instead of the raw policy triad (see `index.ts`'s
        // `MattermostAdapterInfra.policy` doc). Built here, cortex-side,
        // from the SAME resolved triad discord/slack still forward
        // directly — `buildAdapterPolicyPort` reproduces the identical
        // `resolvePolicyAccess`/`isOperatorPrincipal` behaviour byte-for-
        // byte (see that function's own doc), so this is a pure call-site
        // conversion, not a behavior change.
        policy: buildAdapterPolicyPort({
          policyEngine: opts.policyEngine,
          policyLookup: opts.policyLookup,
          policyRegistry: opts.policyRegistry,
        }),
      }) as PlatformAdapter & RouterRegistrable,
    postStartLog: (_adapter, instance, instanceId) =>
      `cortex: mattermost adapter started (instance: ${instanceId}, ${instance.channels.length} channel(s))`,
    // No trustResolverSupport — Mattermost has no trust resolver / Pass 2.
  };
  await bootPlatformAdapters(mattermostDescriptor, ctx);

  // ── Slack ───────────────────────────────────────────────────────────────
  const slackDescriptor: AdapterBootDescriptor<AgentConfig["slack"][number], SlackPresence, SlackLikeAdapter> = {
    platform: "slack",
    instances: opts.slackInstances,
    noInstancesConfiguredCount: opts.config.slack.length,
    disabledSkipLog: (instance) =>
      `cortex: slack instance ${instance.instanceId ?? instance.workspaceId} disabled — skipping`,
    instanceIdFor: (instance) =>
      indexedInstanceId(opts.config.slack, opts.config.agent.name, "slack", instance),
    buildPresence: (instance): SlackPresence => ({
      enabled: instance.enabled,
      botToken: instance.botToken,
      appToken: instance.appToken,
      workspaceId: instance.workspaceId,
      channels: instance.channels,
      allowedUserIds: instance.allowedUserIds,
      trustedBotIds: instance.trustedBotIds,
      surfaceSubjects: instance.surfaceSubjects,
      ...(instance.surfaceFallbackChannelId !== undefined && {
        surfaceFallbackChannelId: instance.surfaceFallbackChannelId,
      }),
    }),
    lookupAgent: (presence) => opts.agentBySlackBotToken.get(presence.botToken),
    fallbackAgent: (presence) => deferredFallbackAgent(opts.config, { slack: presence }),
    trustedBotIdsFor: (instance) => new Set<string>(instance.trustedBotIds),
    constructAdapter: ({ agent, presence, instanceId, explicitTrustedBotIds }) =>
      requireAdapter("slack").createAdapter(
        baseFactoryArgs({
          instanceId,
          systemEventSource: opts.systemEventSource,
          runtime: opts.runtime,
          agent,
          principal: {
            ...(opts.principalSlackId !== undefined && { slackId: opts.principalSlackId }),
          },
          presence,
          explicitTrustedBotIds,
          policyEngine: opts.policyEngine,
          policyLookup: opts.policyLookup,
          policyRegistry: opts.policyRegistry,
        }),
      ) as SlackLikeAdapter,
    trustResolverSupport: {
      registerFailSuffix: " (slack)",
      startedSummary: (instance) => `workspace: ${instance.workspaceId}, ${instance.channels.length} channel(s)`,
      applyMergedTrust: applyStandardMergedTrust,
      // No afterMerge — Slack has no outbound-poller step.
    },
  };
  await bootPlatformAdapters(slackDescriptor, ctx);
}

/**
 * S9 r2 (Sage #1547 review round 2, security) — ALLOW-list, not deny-list.
 * Round 1's `/token/i` deny-list missed `webhookUrl` (Mattermost's webhook
 * URL embeds a secret hook key in its path — the adapter itself treats
 * `apiToken`/`webhookUrl` as sensitive). A deny-list is only as complete as
 * the set of names someone remembered to exclude; a FUTURE secret-bearing
 * field added to any presence type (a new `*Token`/`*Secret`/`*Key` name, or
 * a URL that embeds one) would silently pass through unless every reviewer
 * remembers to extend the pattern. An allow-list fails the opposite,
 * SAFE direction: a field simply doesn't show up in `binding` until someone
 * deliberately adds it here.
 */
const SAFE_BINDING_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "instanceId",
  // Discord
  "guildId",
  "agentChannelId",
  "logChannelId",
  "worklogChannelId",
  "contextDepth",
  "enableAgentLog",
  "operatorRoleId",
  "dmOwner",
  "surfaceSubjects",
  "surfaceFallbackChannelId",
  "trustedBotIds",
  // Mattermost
  "apiUrl",
  "callbackPort",
  "channels",
  "pollIntervalMs",
  "allowedUsers",
  // Slack
  "workspaceId",
  "allowedUserIds",
]);

/**
 * `binding` is forwarded to the adapter plugin purely for observability/test
 * assertions (the construct-args `binding` field) — the production plugins
 * never read it. The per-stack boot path has
 * no equivalent "raw pre-parse binding" the way the gateway does (it builds
 * `presence` directly from the already-Zod-parsed config instance), so this
 * forwards the already-built presence as the closest analogue, filtered down
 * to {@link SAFE_BINDING_KEYS} — never `token`/`botToken`/`appToken`/
 * `apiToken`/`webhookToken`/`webhookUrl`, none of which any test or log line
 * needs.
 */
function presenceAsBinding(presence: object): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(presence as Record<string, unknown>)) {
    if (SAFE_BINDING_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}
