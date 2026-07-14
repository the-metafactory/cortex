/**
 * cortex#1788 (S3) — shared helpers every in-tree `AdapterPlugin.createAdapter`
 * body needs. Moved verbatim out of `src/gateway/gateway-adapters.ts`'s
 * pre-registry factory closures (GW.a.3b.2b, S9/cortex#1523) so the
 * four platform plugin modules (`discord/plugin.ts`, `slack/plugin.ts`,
 * `mattermost/plugin.ts`, `web/plugin.ts`) can share them without each
 * reaching into `gateway-adapters.ts` for gateway-only construction logic.
 * Behavior is UNCHANGED — this is a relocation, not a rewrite.
 */

import type { Agent } from "../common/types/cortex-config";
import type { SystemEventSource } from "../bus/system-events";
import {
  createSystemAdapterRecoveredEvent,
  createSystemAdapterDisconnectedEvent,
  createSystemAdapterDegradedEvent,
  createSystemAccessDeniedEvent,
  type SystemAdapterPlatform,
} from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import {
  resolvePolicyAccess,
  isOperatorPrincipal,
  type PolicyEngine,
  type PlatformPrincipalIndex,
  type PrincipalRegistry,
} from "../common/policy";
import type { AdapterPolicyPort, AdapterSystemEventPort } from "../surface-sdk";

/**
 * The gateway owns one connection per binding but is NOT a stack — it has no
 * persona file and dispatches nothing locally (inbound is rebound to the
 * gateway's sink, bypassing `dispatchHandler.handleMessage`). The adapter
 * constructor still requires an `Agent`; build a minimal synthetic one keyed
 * to the binding's `agent` id so log lines and the trust set are coherent.
 *
 * `persona` is a sentinel — the gateway never spawns a CC session through this
 * adapter, so the persona file is never read.
 */
export function syntheticGatewayAgent(
  agentId: string,
  presence: Agent["presence"],
): Agent {
  return {
    id: agentId,
    displayName: agentId,
    persona: "(gateway-owned — no local dispatch)",
    trust: [],
    presence,
  };
}

/**
 * S9 (cortex#1523) — resolve the `Agent` a factory call constructs the
 * adapter with. `args.agent` (the per-stack boot path always supplies it)
 * wins; the gateway never supplies `agent`, so it falls through to the
 * synthetic gateway-owned placeholder keyed off `args.source`. Throws if
 * NEITHER is present — a caller must supply one or the other so the
 * constructed adapter always has a real identity.
 */
export function resolveFactoryAgent(
  args: { agent?: Agent; source: SystemEventSource | undefined },
  presence: Agent["presence"],
): Agent {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return syntheticGatewayAgent(args.source.agent, presence);
}

/**
 * Safely read a string-typed field off a raw `Record<string, unknown>`
 * binding for `AdapterPlugin.demuxKey`'s ungrouped fallback. Bare
 * `String(binding.x ?? "")` trips `@typescript-eslint/no-base-to-string`
 * because `binding.x` is `unknown` and could stringify to
 * `"[object Object]"` for a non-string value; a demux key built from that
 * would silently misgroup bindings instead of failing loudly.
 */
export function stringBindingField(binding: Record<string, unknown>, field: string, fallback = ""): string {
  const value = binding[field];
  return typeof value === "string" ? value : fallback;
}

// =============================================================================
// cortex#1794 (S9b) — host-bound AdapterPolicyPort
// =============================================================================

/**
 * The v2.0.0 (cortex#297) policy triad a host may have in hand when
 * constructing an adapter. All three optional — absent means "no policy
 * configured", the same deny-by-default posture `resolvePolicyAccess` /
 * `isOperatorPrincipal` already implement (see `common/policy/resolve-access.ts`).
 */
export interface AdapterPolicyTriad {
  policyEngine?: PolicyEngine;
  policyLookup?: PlatformPrincipalIndex;
  policyRegistry?: PrincipalRegistry;
}

/**
 * cortex#1794 (S9b) — bind cortex's real policy-resolution functions
 * (`common/policy`) into the narrow {@link AdapterPolicyPort} shape
 * `surface-sdk` exposes. The host (today: `gateway-adapters.ts`'s
 * `buildGatewayAdapters`) calls this ONCE per construction with whatever
 * triad it has — possibly none, e.g. the shared surface-gateway's
 * shadow-stage build, which never wires a live `PolicyEngine` for ANY
 * platform — and forwards the returned port through `createAdapter`'s args.
 * The adapter body — originally `src/adapters/web/index.ts`, relocated
 * cortex#1794 (S9 MOVE) to the `metafactory-cortex-adapter-web` bundle's
 * `src/index.ts` — never imports `common/policy` itself; it only calls the
 * injected port. (The bundle's `src/plugin.ts` no longer calls THIS
 * function either, post-move — it carries its own local
 * `NO_POLICY_PORT` fallback reproducing the same behaviour, since this
 * function is cortex-internal and doesn't ship with the bundle.)
 *
 * Called with no triad (or an all-undefined one), this reproduces EXACTLY
 * the behaviour a direct `resolvePolicyAccess({msg, engine: undefined, ...})`
 * / `isOperatorPrincipal(platform, id, undefined, undefined)` call gave
 * pre-S9b: `resolveAccess` denies with `denyCode: "no_policy"`,
 * `isOperatorPrincipal` returns `false`.
 */
export function buildAdapterPolicyPort(triad: AdapterPolicyTriad = {}): AdapterPolicyPort {
  const { policyEngine, policyLookup, policyRegistry } = triad;
  return {
    resolveAccess: (msg) =>
      resolvePolicyAccess({
        msg,
        engine: policyEngine,
        index: policyLookup,
        registry: policyRegistry,
      }),
    isOperatorPrincipal: (platform, platformId) =>
      isOperatorPrincipal(platform, platformId, policyEngine, policyLookup),
  };
}

// =============================================================================
// cortex#1795 (S10) — host-bound AdapterSystemEventPort
// =============================================================================

/**
 * The runtime + source pair a host may have in hand when constructing an
 * adapter. Both optional — mirrors the pre-extraction `SlackAdapterInfra`
 * shape (`runtime?`, `systemEventSource?`).
 */
export interface AdapterSystemEventWiring {
  runtime?: MyelinRuntime;
  source?: SystemEventSource;
}

/**
 * cortex#1795 (S10) — bind cortex's real system-event construction
 * (`bus/system-events`'s `createSystemAdapterRecoveredEvent`/
 * `createSystemAdapterDisconnectedEvent`) + publish (`MyelinRuntime.publish`)
 * into the narrow {@link AdapterSystemEventPort} shape `surface-sdk` exposes.
 * The host (`gateway-adapters.ts`'s `buildGatewayAdapters`,
 * `runner/surface-adapter-boot.ts`'s `baseFactoryArgs`) calls this ONCE per
 * construction with whatever `{runtime, source}` it has — possibly neither,
 * e.g. the shared surface-gateway's shadow-stage build — and forwards the
 * returned port through `createAdapter`'s args. The adapter body
 * (`src/adapters/slack/index.ts`) never imports `bus/myelin/runtime` or
 * `bus/system-events` itself; it only calls the injected port.
 *
 * Reproduces the pre-extraction `SlackAdapter.canPublishSystemEvent()` gate
 * EXACTLY: no runtime → silent no-op (adapters started without NATS still
 * track connection state locally); runtime present but no source → warn
 * ONCE per constructed port (mirrors the per-instance `warnedMissingSource`
 * flag) then no-op; both present → build the envelope and
 * `void runtime.publish(env)`.
 */
export function buildAdapterSystemEventPort(
  wiring: AdapterSystemEventWiring = {},
): AdapterSystemEventPort {
  const { runtime, source } = wiring;
  let warnedMissingSource = false;

  function warnOnceIfMissingSource(adapterId: string, platform: string): void {
    if (warnedMissingSource) return;
    warnedMissingSource = true;
    console.warn(
      `${platform}-${adapterId}: runtime is configured but systemEventSource is missing — system.* events will not be emitted`,
    );
  }

  return {
    recovered(opts) {
      if (!runtime) return;
      if (!source) {
        warnOnceIfMissingSource(opts.adapterId, opts.platform);
        return;
      }
      const env = createSystemAdapterRecoveredEvent({
        source,
        adapterId: opts.adapterId,
        // `SystemAdapterPlatform` is cortex-internal (bus/system-events); the
        // port's `platform` is a plain string so it stays out of surface-sdk.
        platform: opts.platform as SystemAdapterPlatform,
        degradedForMs: opts.degradedForMs,
        disconnectedSince: opts.disconnectedSince,
        ...(opts.reconnectAttempts !== undefined && { reconnectAttempts: opts.reconnectAttempts }),
      });
      void runtime.publish(env);
    },
    disconnected(opts) {
      if (!runtime) return;
      if (!source) {
        warnOnceIfMissingSource(opts.adapterId, opts.platform);
        return;
      }
      const env = createSystemAdapterDisconnectedEvent({
        source,
        adapterId: opts.adapterId,
        // See `.recovered()` above.
        platform: opts.platform as SystemAdapterPlatform,
        disconnectedSince: opts.disconnectedSince,
        wasClean: opts.wasClean,
        ...(opts.shardId !== undefined && { shardId: opts.shardId }),
        ...(opts.closeCode !== undefined && { closeCode: opts.closeCode }),
        ...(opts.closeReason !== undefined && { closeReason: opts.closeReason }),
      });
      void runtime.publish(env);
    },
    // cortex#1797 (S12) — Discord's two extra system-event kinds. Same
    // no-runtime / no-source-warns-once gate as `.recovered()`/.disconnected()`
    // above; reproduces `DiscordAdapter.publishAdapterDegraded`/
    // `.publishUntrustedBotDenied`'s pre-extraction inline construction
    // exactly (module doc on `AdapterSystemEventPort` has the rationale).
    degraded(opts) {
      if (!runtime) return;
      if (!source) {
        warnOnceIfMissingSource(opts.adapterId, opts.platform);
        return;
      }
      const env = createSystemAdapterDegradedEvent({
        source,
        adapterId: opts.adapterId,
        platform: opts.platform as SystemAdapterPlatform,
        disconnectedSince: opts.disconnectedSince,
        thresholdMs: opts.thresholdMs,
        ...(opts.reconnectAttempts !== undefined && { reconnectAttempts: opts.reconnectAttempts }),
      });
      void runtime.publish(env);
    },
    untrustedBotDenied(opts) {
      if (!runtime) return;
      if (!source) {
        warnOnceIfMissingSource(opts.principalId, opts.platform);
        return;
      }
      const env = createSystemAccessDeniedEvent({
        source,
        principalId: opts.principalId,
        capability: `${opts.platform}.inbound`,
        sovereignty: {
          classification: "local",
          data_residency: source.principal,
          max_hop: 0,
          frontier_ok: false,
          model_class: "local-only",
        },
        correlationId: opts.correlationId,
        signedBy: [],
        envelopeSubject: opts.envelopeSubject,
        envelopeId: opts.envelopeId,
        reason: opts.reason,
      });
      void runtime.publish(env);
    },
  };
}
