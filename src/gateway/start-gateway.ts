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
 * ## Shadow stage (this slice)
 *
 * `maybeCreateSurfaceGateway` always wires `LoggingInboundSink` — even the
 * flag-on path is shadow/log-only and publishes NOTHING to the bus. The
 * `BusInboundSink` flip is a later slice.
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
  maybeCreateSurfaceGateway,
} from "./gateway-bootstrap";
import {
  buildGatewayAdapters,
  defaultGatewayAdapterFactory,
  type GatewayAdapterFactory,
} from "./gateway-adapters";
import type { SurfaceGateway } from "./surface-gateway";
import type { Surfaces } from "../common/types/surfaces";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { InboundMessage } from "../adapters/types";

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
   * Adapter-construction seam. Production omits this and gets
   * {@link defaultGatewayAdapterFactory}; tests inject a recording fake that
   * returns construct-only stubs (no platform connection).
   */
  factory?: GatewayAdapterFactory;
  /** Optional unroutable-message hook forwarded to the gateway. */
  onUnroutable?: (msg: InboundMessage, reason: string) => void;
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
): Promise<SurfaceGateway | undefined> {
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
    // the no-binding case; delegate to it (with empty adapters) so the log
    // line lives in exactly one place.
    return maybeCreateSurfaceGateway({
      enabled: true,
      surfaces,
      adapters: [],
      ...(opts.onUnroutable !== undefined && { onUnroutable: opts.onUnroutable }),
    });
  }

  // ── Path 3: flag on + bindings → build, construct, start. ─────────────────
  const adapters = buildGatewayAdapters(surfaces, {
    principal: opts.principal,
    runtime: opts.runtime,
    factory: opts.factory ?? defaultGatewayAdapterFactory,
  });

  const gw = maybeCreateSurfaceGateway({
    enabled: true,
    surfaces,
    adapters,
    ...(opts.onUnroutable !== undefined && { onUnroutable: opts.onUnroutable }),
  });

  // `gw` is defined here (bindings > 0 + adapters built), but the factory
  // contract returns `SurfaceGateway | undefined` — guard rather than assert.
  if (gw !== undefined) {
    await gw.start();
  }
  return gw;
}
