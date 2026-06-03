/**
 * GW.a.3b.2b — flag-gated gateway start orchestration (cortex#524).
 *
 * `startGatewayIfEnabled` is the ONE call cortex.ts makes to (maybe) stand up
 * the shared surface gateway. It keeps the boot path thin: cortex.ts adds a
 * single guarded `const gw = await startGatewayIfEnabled(...)` after its
 * per-stack adapters are built, and registers `gw?.stop()` in the existing
 * shutdown sequence. All flag-on orchestration lives HERE.
 *
 * ## HARD SAFETY CONTRACT
 *
 * `CORTEX_GATEWAY` is OFF by default. When off this function returns
 * `undefined` and constructs NOTHING — it does not call the adapter factory,
 * does not touch the runtime, does not start anything. The flag-off path is a
 * true no-op; cortex's existing per-stack adapter boot is entirely unaffected.
 *
 * ## Three exit paths (mirrors `maybeCreateSurfaceGateway`)
 *
 *   1. flag off → `undefined`, nothing constructed.
 *   2. flag on but no surface bindings → `undefined` (the factory is never
 *      called because `maybeCreateSurfaceGateway` early-exits before any
 *      adapter is needed — we mirror that by checking bindings first and
 *      skipping `buildGatewayAdapters` entirely).
 *   3. flag on + bindings → build adapters, construct the gateway, `gw.start()`,
 *      return the started instance.
 *
 * ## Sink selection — shadow default, live double-opt-in
 *
 * `CORTEX_GATEWAY=1` alone runs the gateway in SHADOW: `maybeCreateSurfaceGateway`
 * defaults to `LoggingInboundSink` (logs the routing decision, publishes
 * NOTHING) — unchanged from today. Only when `CORTEX_GATEWAY_PUBLISH=1` is ALSO
 * set does this function construct a `BusInboundSink` and inject it, flipping
 * the gateway LIVE (publishing canonical dispatch envelopes to the bus). Live
 * publish is a deliberate double-opt-in because the gateway runs on live stacks.
 * The empty-bindings Path-2 always stays on `LoggingInboundSink` (there is
 * nothing to publish without bindings anyway).
 *
 * ## Why bindings are checked before building adapters
 *
 * `buildGatewayAdapters` is construct-only and cheap, but constructing real
 * platform adapters opens no connection (start is deferred) — still, building
 * zero-value adapters for a no-binding config is pointless work, and the
 * factory-never-called invariant in the no-binding case keeps the contract
 * crisp + testable. We compute `hasBindings` up front and short-circuit.
 */

import {
  isGatewayEnabled,
  isGatewayPublishEnabled,
  maybeCreateSurfaceGateway,
} from "./gateway-bootstrap";
import {
  buildGatewayAdapters,
  defaultGatewayAdapterFactory,
  type GatewayAdapterFactory,
} from "./gateway-adapters";
import { BusInboundSink } from "./bus-inbound-sink";
import { distinctBoundStacks, crossPrincipalBindings } from "./binding-resolver";
import type { SurfaceGateway } from "./surface-gateway";
import type { Surfaces } from "../common/types/surfaces";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { SystemEventSource } from "../bus/system-events";
import type { PolicyEngine } from "../common/policy/engine";
import type { InboundMessage, PlatformAdapter } from "../adapters/types";

// =============================================================================
// Public API
// =============================================================================

/** Options for {@link startGatewayIfEnabled}. */
export interface StartGatewayOpts {
  /** The env record to read `CORTEX_GATEWAY` from (cortex.ts passes `process.env`). */
  env: Record<string, string | undefined>;
  /** Validated surface binding map from `LoadedConfig.surfaces` (may be undefined). */
  surfaces: Surfaces | undefined;
  /** Principal slug — first segment of the gateway source identity. */
  principal: string;
  /** Myelin runtime (may be dormant — adapters track state locally either way). */
  runtime: MyelinRuntime | undefined;
  /**
   * The gateway's dispatch-source identity, threaded into a live
   * {@link BusInboundSink}. Supplies principal / agent / instance for the
   * envelope `source`. `undefined` before the bus connects → the publisher
   * refuses with `reason: "missing-runtime"`. Only consumed when
   * `CORTEX_GATEWAY_PUBLISH` selects the live sink.
   */
  source: SystemEventSource | undefined;
  /**
   * Policy engine that resolves `(platform, authorId)` → principal DID for the
   * envelope `originator.identity`, threaded into a live {@link BusInboundSink}.
   * `undefined` → the publisher refuses with `reason: "invalid-originator"`.
   * Only consumed when `CORTEX_GATEWAY_PUBLISH` selects the live sink.
   */
  policyEngine: PolicyEngine | undefined;
  /**
   * Adapter-construction seam. Production omits this and gets
   * {@link defaultGatewayAdapterFactory}; tests inject a recording fake that
   * returns construct-only stubs (no platform connection).
   */
  factory?: GatewayAdapterFactory;
  /** Optional unroutable-message hook forwarded to the gateway. */
  onUnroutable?: (msg: InboundMessage, reason: string) => void;
}

/**
 * What a successfully-started gateway hands back to the cortex.ts boot path.
 *
 * a.3d (cortex#524) — the gateway owns its platform adapters AND the set of
 * bound stacks; the OUTBOUND dispatch sink (constructed in `cortex.ts`,
 * mirroring the per-stack sink) needs both. Rather than reaching into the
 * gateway's internals, `startGatewayIfEnabled` exposes them here so the
 * subject derivation stays in the gateway layer (where `surfaces` is parsed)
 * while the sink construction stays at the boot site (where `runtime` lives).
 */
export interface StartedGateway {
  /** The started inbound demux gateway. Joins the shutdown drain via `stop()`. */
  gateway: SurfaceGateway;
  /**
   * The gateway's own platform adapters — one per surface binding. The
   * outbound dispatch sink drives THESE (its `adapter_instance` filter keys
   * off their `instanceId`), disjoint from the per-stack `adapters[]`.
   */
  adapters: readonly PlatformAdapter[];
  /**
   * Distinct bound-stack leaves (`undefined` = a gap-4 no-stack binding) for
   * the outbound sink's subscribe subjects. See {@link distinctBoundStacks}.
   */
  stacks: readonly (string | undefined)[];
}

/** Count the total bindings across all platforms in a `Surfaces` map. */
function countBindings(surfaces: Surfaces): number {
  return (
    (surfaces.discord?.length ?? 0) +
    (surfaces.slack?.length ?? 0) +
    (surfaces.mattermost?.length ?? 0)
  );
}

/**
 * Flag-gated: maybe construct + start the shared surface gateway.
 *
 * Returns the started {@link SurfaceGateway} when the flag is on AND surface
 * bindings exist; otherwise `undefined`. See the module doc for the HARD
 * SAFETY CONTRACT — flag off constructs NOTHING.
 *
 * @throws re-throws from `buildGatewayAdapters` (bad presence / adapter
 *   construction) and `maybeCreateSurfaceGateway` (duplicate demux key) so a
 *   misconfigured-but-flagged deployment fails loudly at boot. The flag-off
 *   path never reaches either and so never throws.
 */
export async function startGatewayIfEnabled(
  opts: StartGatewayOpts,
): Promise<StartedGateway | undefined> {
  const enabled = isGatewayEnabled(opts.env);

  // ── Path 1: flag off → true no-op. Construct NOTHING. ─────────────────────
  if (!enabled) {
    return undefined;
  }

  // ── Path 2: flag on but no bindings → degrade gracefully. ─────────────────
  // Short-circuit BEFORE buildGatewayAdapters so the factory is never called
  // when there is nothing to demux (keeps the no-binding invariant crisp).
  const { surfaces } = opts;
  if (surfaces === undefined || countBindings(surfaces) === 0) {
    // maybeCreateSurfaceGateway emits the principal-facing stderr warning for
    // the no-binding case AND returns `undefined` (zero bindings). Call it for
    // that one-place log side-effect, then return `undefined` — there is no
    // gateway, no adapters, and no outbound sink to wire.
    maybeCreateSurfaceGateway({
      enabled: true,
      surfaces,
      adapters: [],
      ...(opts.onUnroutable !== undefined && { onUnroutable: opts.onUnroutable }),
    });
    return undefined;
  }

  // ── Path 3: flag on + bindings → build, construct, start. ─────────────────
  //
  // a.3d review (single-principal v1 enforcement): the inbound publisher and
  // the outbound dispatch sink both key off the gateway's OWN principal and
  // discard each binding's parsed principal. Reject any cross-principal binding
  // LOUDLY at boot rather than silently absorbing it into the gateway
  // principal's namespace (the latent cross-principal leak single-principal v1
  // excludes). Same loud-validation stance as `buildBindingIndex`.
  const crossPrincipal = crossPrincipalBindings(surfaces, opts.principal);
  if (crossPrincipal.length > 0) {
    throw new Error(
      `gateway: cross-principal surface bindings are not supported in single-principal v1 — ` +
        `${crossPrincipal.map((s) => `"${s}"`).join(", ")} ` +
        `declare a principal other than "${opts.principal}". ` +
        `Either move them under "${opts.principal}/…" or run a separate gateway for that principal.`,
    );
  }

  const adapters = buildGatewayAdapters(surfaces, {
    principal: opts.principal,
    runtime: opts.runtime,
    factory: opts.factory ?? defaultGatewayAdapterFactory,
  });

  // Sink selection — the SECOND opt-in gate.
  //
  // SHADOW (default): `CORTEX_GATEWAY_PUBLISH` unset → omit `sink`, so
  // `maybeCreateSurfaceGateway` defaults to `LoggingInboundSink` (logs only, no
  // bus publish). This is the unchanged-from-today behaviour for a gateway-on,
  // publish-off stack.
  //
  // LIVE (double-opt-in): `CORTEX_GATEWAY` AND `CORTEX_GATEWAY_PUBLISH` both
  // "1" → construct a `BusInboundSink` and inject it, so each routable inbound
  // message is published to the bus as a canonical dispatch envelope.
  //
  // D1 (CONTEXT.md §Dispatch-source, 2026-06-02): the gateway is a separate
  // process with NO stack NKey, so `BusInboundSink` publishes via this runtime
  // UNSIGNED + originator-stamped on the intra-principal hop (Shape A v1). The
  // bound stack's consumer tolerates unsigned (`rejectEmpty:false`). The
  // explicit re-sign-on-ingest (Shape B) is deferred to cortex#552 — signing is
  // a property of the injected runtime, not of this sink.
  const publish = isGatewayPublishEnabled(opts.env);
  const sink = publish
    ? new BusInboundSink({
        runtime: opts.runtime,
        source: opts.source,
        policyEngine: opts.policyEngine,
      })
    : undefined;

  process.stdout.write(
    publish
      ? "[surface-gateway] CORTEX_GATEWAY_PUBLISH set — gateway LIVE" +
          " (BusInboundSink — publishing to the bus)\n"
      : "[surface-gateway] CORTEX_GATEWAY_PUBLISH unset — gateway SHADOW" +
          " (LoggingInboundSink — no bus publish)\n",
  );

  const gw = maybeCreateSurfaceGateway({
    enabled: true,
    surfaces,
    adapters,
    ...(sink !== undefined && { sink }),
    ...(opts.onUnroutable !== undefined && { onUnroutable: opts.onUnroutable }),
  });

  // `gw` is defined here (bindings > 0 + adapters built), but the factory
  // contract returns `SurfaceGateway | undefined` — guard rather than assert.
  if (gw === undefined) {
    return undefined;
  }
  await gw.start();

  // a.3d (cortex#524) — hand the boot path the adapters + bound stacks the
  // OUTBOUND dispatch sink needs. The sink itself is constructed in cortex.ts
  // (it owns the `runtime`), but the bound-stack subject set is derived HERE,
  // where `surfaces` is parsed, so subject-shape logic stays in the gateway
  // layer. Single-principal v1: the sink's principal segment is the gateway
  // principal (supplied at the boot site).
  return {
    gateway: gw,
    adapters,
    stacks: distinctBoundStacks(surfaces),
  };
}
