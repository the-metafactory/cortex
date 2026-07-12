/**
 * GW.a.3b.2b — flag-gated gateway start orchestration (cortex#524).
 *
 * `startGatewayIfEnabled` is the ONE call cortex.ts makes to (maybe) stand up
 * the shared surface gateway. Cortex computes the pure ownership plan once
 * before per-stack adapter boot, then passes the same plan here for Gateway
 * start and outbound subject derivation.
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
 * crisp + testable. The ownership plan computes `hasSurfaceBindings` up front,
 * and this start path short-circuits from that decision.
 */

import {
  isGatewayPublishEnabled,
  maybeCreateSurfaceGateway,
} from "./gateway-bootstrap";
import {
  buildGatewayAdapters,
  defaultGatewayAdapterFactory,
  type GatewayAdapterFactory,
} from "./gateway-adapters";
import { registryFromFactory, type SurfacePluginRegistry } from "../adapters/registry";
import { BusInboundSink } from "./bus-inbound-sink";
import { defaultUnroutableWarn } from "./surface-gateway";
import { makeEmittingUnroutable } from "./gateway-unroutable-emit";
import type { BoundPrincipalStack } from "./binding-resolver";
import type { SurfaceOwnershipPlan } from "./surface-ownership-plan";
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
   * returns construct-only stubs (no platform connection). Superseded by
   * {@link registry} when both are supplied.
   */
  factory?: GatewayAdapterFactory;
  /**
   * cortex#1788 (S3, ADR-0024 D5) — the `(kind, id)`-keyed registry
   * (`src/adapters/registry.ts`). cortex.ts composes ONE registry and
   * threads it here and to the per-stack boot path
   * (`wireSurfaceAdapters`). Takes priority over {@link factory} when both
   * are supplied; existing `factory`-based test doubles keep working
   * unchanged via {@link registryFromFactory}.
   */
  registry?: SurfacePluginRegistry;
  /** Optional unroutable-message hook forwarded to the gateway. */
  onUnroutable?: (msg: InboundMessage, reason: string) => void;
  /**
   * Precomputed pure ownership plan from the boot path. Required so Gateway
   * start, per-stack suppression, and outbound sink subject derivation all use
   * the same ownership decision.
   */
  ownershipPlan: SurfaceOwnershipPlan;
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
   *
   * Single-principal: these pair with the gateway's own principal. Prefer
   * {@link StartedGateway.principalStacks} for the multi-principal sink subjects
   * (F-1 — cortex#629); `stacks` is retained for back-compat / single-principal
   * callers.
   */
  stacks: readonly (string | undefined)[];
  /**
   * F-1 (cortex#629) — distinct `(principal, stack)` pairs across every
   * binding, each carrying its OWN parsed principal (gap-4 bindings fall back
   * to the gateway principal). The outbound dispatch sink builds one subscribe
   * subject per pair so a multi-principal gateway sees every bound stack's
   * replies on the right principal namespace. See
   * {@link distinctBoundPrincipalStacks}.
   */
  principalStacks: readonly BoundPrincipalStack[];
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
  const { ownershipPlan } = opts;

  // ── Path 1: flag off → true no-op. Construct NOTHING. ─────────────────────
  if (!ownershipPlan.gatewayEnabled) {
    return undefined;
  }

  // cortex#1951 — resolve ONCE, thread the SAME registry to both
  // `maybeCreateSurfaceGateway` calls below (inbound demux) AND
  // `buildGatewayAdapters` (construction) — one registry, no drift between
  // how a binding's demux key and its live adapter are derived.
  const registry =
    opts.registry ?? registryFromFactory(opts.factory ?? defaultGatewayAdapterFactory);

  // ── Path 2: flag on but no bindings → degrade gracefully. ─────────────────
  // Short-circuit BEFORE buildGatewayAdapters so the factory is never called
  // when there is nothing to demux (keeps the no-binding invariant crisp).
  const { surfaces } = opts;
  if (!ownershipPlan.gatewayStartEligible) {
    // maybeCreateSurfaceGateway emits the principal-facing stderr warning for
    // the no-binding case AND returns `undefined` (zero bindings). Call it for
    // that one-place log side-effect, then return `undefined` — there is no
    // gateway, no adapters, and no outbound sink to wire.
    maybeCreateSurfaceGateway({
      enabled: true,
      surfaces,
      adapters: [],
      registry,
      ...(opts.onUnroutable !== undefined && { onUnroutable: opts.onUnroutable }),
    });
    return undefined;
  }
  if (surfaces === undefined) {
    throw new Error(
      "surface-gateway ownership plan is start-eligible but surfaces are undefined",
    );
  }

  // ── Path 3: flag on + bindings → build, construct, start. ─────────────────
  //
  // F-1 (cortex#629) — multi-principal, UNSIGNED. The gateway now serves
  // bindings spanning MORE THAN ONE principal on a shared bus so cross-principal
  // collaboration works. The outbound dispatch sink subscribes per distinct
  // `(principal, stack)` pair (see `principalStacks` below) — each binding's
  // reply lands on ITS OWN principal namespace, no longer absorbed into the
  // gateway principal's.
  //
  // a.3d shipped a HARD THROW here (single-principal v1). F-1 RELAXES that to a
  // non-fatal WARNING: cross-principal bindings are allowed but are
  // UNSIGNED/UNAUTHENTICATED, so the inbound publish hop carries no per-stack
  // signature. That is fine for a dev/trusted shared bus but MUST NOT face
  // untrusted peers until signing is layered on (cortex#552 / cortex#635).
  // `crossPrincipalBindings` stays the detector — only this consumer changed
  // from throw→warn.
  const crossPrincipal = ownershipPlan.crossPrincipalBindings;
  if (crossPrincipal.length > 0) {
    process.stderr.write(
      `[surface-gateway] WARNING: cross-principal surface bindings are UNSIGNED/UNAUTHENTICATED ` +
        `— dev/trusted only; enable signing before untrusted peers. ` +
        `Bindings ${crossPrincipal.map((s) => `"${s}"`).join(", ")} ` +
        `declare a principal other than the gateway principal "${opts.principal}". ` +
        `Allowing (F-1, cortex#629); signing is layered on later (cortex#552 / cortex#635).\n`,
    );
  }

  const adapters = buildGatewayAdapters(surfaces, {
    principal: opts.principal,
    runtime: opts.runtime,
    registry,
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

  // cortex#596 — on the LIVE path, decorate `onUnroutable` so a NO-BINDING-match
  // inbound emits a `system.gateway.routing_decision { outcome: "unroutable" }`
  // bus event (the signal/MC-consumable replacement for the stdout hunt-line),
  // NOT just the `console.warn` breadcrumb. This is the upstream twin of the
  // publish-refusal emit `BusInboundSink` already does (that case matched a
  // binding; this one matched none). Only wired when the gateway is LIVE
  // (`publish`), symmetric with the sink: SHADOW mode publishes nothing to the
  // bus, so it keeps the plain breadcrumb (`opts.onUnroutable` unchanged). The
  // breadcrumb is preserved as the emit's base (the fallback when the bus is
  // down); a caller-supplied `onUnroutable` is decorated in its place when one
  // was passed. The emit itself is fully guarded on runtime/source (see
  // `emitUnroutableRoutingDecision`).
  const onUnroutable = publish
    ? makeEmittingUnroutable(opts.onUnroutable ?? defaultUnroutableWarn, {
        runtime: opts.runtime,
        source: opts.source,
      })
    : opts.onUnroutable;

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
    registry,
    ...(sink !== undefined && { sink }),
    ...(onUnroutable !== undefined && { onUnroutable }),
  });

  // `gw` is defined here (bindings > 0 + adapters built), but the factory
  // contract returns `SurfaceGateway | undefined` — guard rather than assert.
  if (gw === undefined) {
    return undefined;
  }
  await gw.start();

  // a.3d (cortex#524) — hand the boot path the adapters + bound stacks the
  // OUTBOUND dispatch sink needs. The sink itself is constructed in cortex.ts
  // (it owns the `runtime`), but the subject set is derived HERE, where
  // `surfaces` is parsed, so subject-shape logic stays in the gateway layer.
  //
  // F-1 (cortex#629) — also derive `principalStacks`: distinct `(principal,
  // stack)` pairs carrying each binding's OWN parsed principal, so a
  // multi-principal gateway sink subscribes per principal namespace. `stacks`
  // is retained for back-compat (single-principal callers / the legacy shape).
  return {
    gateway: gw,
    adapters,
    stacks: ownershipPlan.outboundStacks,
    principalStacks: ownershipPlan.outboundPrincipalStacks,
  };
}
