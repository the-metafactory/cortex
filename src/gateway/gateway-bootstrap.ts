/**
 * GW.a.3b.1 — flag-gated gateway bootstrap factory (cortex#524).
 *
 * Pure construction logic: reads the `CORTEX_GATEWAY` env flag, validates that
 * at least one surface binding exists, builds the binding index, and returns a
 * fully constructed (but not yet started) {@link SurfaceGateway}.
 *
 * ## Sink selection (shadow default, live opt-in)
 *
 * `maybeCreateSurfaceGateway` defaults to {@link LoggingInboundSink} (SHADOW)
 * when no `sink` is injected — it logs the routing decision that WOULD be
 * published to the bus, but does NOT publish. This lets the gateway run
 * alongside per-stack adapters on a staging identity to prove demux
 * correctness before any stack loses its own adapter. A live `BusInboundSink`
 * is injected by `startGatewayIfEnabled` ONLY when the second opt-in flag
 * `CORTEX_GATEWAY_PUBLISH` is set — making live publish a deliberate
 * double-opt-in (`CORTEX_GATEWAY` AND `CORTEX_GATEWAY_PUBLISH`).
 *
 * ## GW.a.3b.2 prerequisites (NOT done in this slice)
 *
 * 1. **cortex.ts boot wiring** — call `maybeCreateSurfaceGateway` after
 *    adapters are built, attach the returned gateway to the shutdown sequence
 *    (`await gw.start()` on startup; `await gw.stop()` on SIGTERM/SIGINT), and
 *    guard the whole block behind the same `enabled` flag.
 *
 * 2. **`LoadedConfig` must expose `Surfaces`** — today `foldSurfaceBindings`
 *    (`src/common/config/loader.ts:389`) folds surface bindings into the
 *    per-agent presence blocks and then DROPS the `surfaces:` key, so
 *    `LoadedConfig` does not retain the binding map. GW.a.3b.2 must either:
 *      (a) surface the validated `Surfaces` object on `LoadedConfig` (preferred
 *          — the gateway reads it from there), or
 *      (b) have the gateway read `surfaces.yaml` directly via a side-load.
 *    Option (a) is preferred; the fold already runs the schema validation, so
 *    the validated object is available at that point and can be returned
 *    alongside the existing `LoadedConfig` shape.
 *
 * 3. **Live staging adapters** — a throwaway gateway bot identity (cortex#562)
 *    with its own Discord/Slack application and bot token is needed to connect
 *    real platform adapters to the gateway during the shadow dry-run. These are
 *    injected via the `adapters` parameter; constructing them from a live config
 *    is GW.a.3b.2 work. **Precondition a.3b.2 must honour:** pass ≥1 adapter when
 *    bindings are present — this factory does not guard `adapters: []` (a gateway
 *    with bindings but no connections has nothing to receive on); a.3b.2 builds
 *    one adapter per `(platform, identity)` the gateway owns.
 *
 * ## Decision log (principal-locked 2026-06-02)
 *
 * - Env var name: `CORTEX_GATEWAY` (not `GATEWAY_ENABLED` — stays in the
 *   cortex namespace, consistent with `CORTEX_CHANNEL`, `CORTEX_AGENT_*`).
 * - Only `"1"` is truthy; `"true"`, `"yes"`, `"on"` are all false. Keeps the
 *   contract minimal and grep-stable.
 * - `isGatewayEnabled` is kept separate from the factory so flag-reading is
 *   independently testable without constructing anything.
 * - Empty-surfaces early-exit is a stderr warning (not a throw) because a
 *   misconfigured-but-flagged deployment should degrade gracefully — the rest
 *   of cortex starts normally, the gateway simply does not run.
 */

import type { PlatformAdapter, InboundMessage } from "../adapters/types";
import type { Surfaces } from "../common/types/surfaces";
import { buildBindingIndex } from "./binding-resolver";
import {
  SurfaceGateway,
  LoggingInboundSink,
  type GatewayInboundSink,
} from "./surface-gateway";

// =============================================================================
// Public API
// =============================================================================

/**
 * Constructor-time options for {@link maybeCreateSurfaceGateway}.
 *
 * The caller is responsible for:
 *   - evaluating the flag (`enabled = isGatewayEnabled(process.env)`)
 *   - sourcing the surface binding map (GW.a.3b.2 loads it from `LoadedConfig`)
 *   - constructing the live adapters (GW.a.3b.2 builds them from the config)
 *
 * This keeps the factory pure and independently testable.
 */
export interface GatewayBootstrapOpts {
  /** Pass `isGatewayEnabled(process.env)` — the factory does not read env directly. */
  enabled: boolean;
  /**
   * The validated surface binding map from the config layer.
   * `undefined` when the config has no `surfaces:` block (GW.a.3b.2 precondition
   * 2 above — `LoadedConfig` must expose this).
   */
  surfaces: Surfaces | undefined;
  /** Platform adapters the gateway will own — injected by GW.a.3b.2 caller. */
  adapters: PlatformAdapter[];
  /**
   * The inbound sink the gateway publishes routing decisions to.
   *
   * Defaults to {@link LoggingInboundSink} (SHADOW — logs the decision that
   * WOULD be published, but does NOT touch the bus) when omitted, so every
   * existing caller and the default shadow stage are unchanged. The live-path
   * `BusInboundSink` is injected here by `startGatewayIfEnabled` ONLY when the
   * second opt-in flag `CORTEX_GATEWAY_PUBLISH` is set — making live publish a
   * deliberate double-opt-in.
   */
  sink?: GatewayInboundSink;
  /**
   * Optional unroutable-message hook forwarded to {@link SurfaceGateway}.
   * When absent the gateway's default `console.warn` fires.
   */
  onUnroutable?: (msg: InboundMessage, reason: string) => void;
}

// =============================================================================
// isGatewayEnabled
// =============================================================================

/**
 * Read the `CORTEX_GATEWAY` flag from `env` (defaults to `process.env`).
 *
 * Returns `true` iff `env.CORTEX_GATEWAY === "1"`. All other values —
 * including `"true"`, `"yes"`, `"on"`, and `undefined` — return `false`.
 * Kept separate from the factory so flag-reading is independently testable.
 *
 * Decision (2026-06-02): only `"1"` is truthy; the contract is minimal and
 * grep-stable across launchd plists, `.env` files, and shell exports.
 */
export function isGatewayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CORTEX_GATEWAY === "1";
}

// =============================================================================
// isGatewayPublishEnabled
// =============================================================================

/**
 * Read the `CORTEX_GATEWAY_PUBLISH` flag from `env` (defaults to `process.env`).
 *
 * Returns `true` iff `env.CORTEX_GATEWAY_PUBLISH === "1"`. All other values —
 * including `"true"`, `"yes"`, `"on"`, and `undefined` — return `false`,
 * mirroring {@link isGatewayEnabled}'s strict `"1"`-only contract.
 *
 * This is the SECOND, independent opt-in gate. The gateway only publishes to
 * the bus (live `BusInboundSink`) when BOTH `CORTEX_GATEWAY` AND
 * `CORTEX_GATEWAY_PUBLISH` are `"1"`. With the gateway flag on but THIS flag
 * off, the gateway runs in SHADOW (`LoggingInboundSink` — no publish), exactly
 * as it does today. Live publish is a deliberate double-opt-in because it runs
 * on live stacks.
 *
 * Kept separate from {@link isGatewayEnabled} so each flag is independently
 * testable without constructing anything.
 */
export function isGatewayPublishEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CORTEX_GATEWAY_PUBLISH === "1";
}

// =============================================================================
// Binding count helper
// =============================================================================

/**
 * Count the total number of surface bindings across all platforms in a
 * `Surfaces` map.
 *
 * Used for the empty-check (zero → early-exit) and the construction log line.
 */
function countBindings(surfaces: Surfaces): number {
  return (
    (surfaces.discord?.length ?? 0) +
    (surfaces.slack?.length ?? 0) +
    (surfaces.mattermost?.length ?? 0)
  );
}

// =============================================================================
// maybeCreateSurfaceGateway
// =============================================================================

/**
 * Flag-gated factory for {@link SurfaceGateway}.
 *
 * Three exit paths:
 *
 *   1. `enabled === false` → return `undefined` silently. Today's per-stack
 *      dispatch path is entirely untouched; the gateway is opt-in.
 *
 *   2. `enabled === true` but zero bindings (`surfaces` absent or all arrays
 *      empty) → return `undefined` + a clear `stderr` warning. The flag is set
 *      but there is nothing to demux — degrade gracefully rather than starting
 *      an idle gateway process.
 *
 *   3. Otherwise → build the binding index, construct a {@link SurfaceGateway}
 *      with a {@link LoggingInboundSink} (shadow stage — no bus publish), log a
 *      one-line summary to stdout, and return the instance. The caller calls
 *      `gw.start()` / `gw.stop()` at the appropriate lifecycle points.
 *
 * @throws re-throws any `Error` from `buildBindingIndex` (e.g. duplicate demux
 *   keys) — config invariant violations should fail loudly at startup.
 */
export function maybeCreateSurfaceGateway(
  opts: GatewayBootstrapOpts,
): SurfaceGateway | undefined {
  const { enabled, surfaces, adapters, onUnroutable } = opts;

  // ── Path 1: flag off ─────────────────────────────────────────────────────
  if (!enabled) {
    return undefined;
  }

  // ── Path 2: flag on but no bindings ──────────────────────────────────────
  const bindingCount = surfaces !== undefined ? countBindings(surfaces) : 0;
  if (surfaces === undefined || bindingCount === 0) {
    process.stderr.write(
      "[surface-gateway] CORTEX_GATEWAY set but no surfaces bindings found" +
        " — gateway not started. " +
        "Ensure surfaces.yaml is present and LoadedConfig exposes the Surfaces map" +
        " (GW.a.3b.2 prerequisite).\n",
    );
    return undefined;
  }

  // ── Path 3: construct ────────────────────────────────────────────────────
  //
  // buildBindingIndex throws on duplicate demux keys — that is intentional
  // (loud startup failure on bad config). The throw propagates to the caller.
  const index = buildBindingIndex(surfaces);

  // Sink selection: defaults to LoggingInboundSink (SHADOW — no bus publish)
  // when the caller omits `sink`, so every existing caller and the default
  // shadow stage are byte-unchanged. A live BusInboundSink is injected by
  // `startGatewayIfEnabled` only when the second opt-in flag
  // `CORTEX_GATEWAY_PUBLISH` is set. This factory does not read either flag —
  // it trusts the caller's choice of sink, keeping it pure and testable.
  const sink = opts.sink ?? new LoggingInboundSink();
  const live = !(sink instanceof LoggingInboundSink);

  const gw = new SurfaceGateway(adapters, index, sink, { onUnroutable });

  process.stdout.write(
    `[surface-gateway] surface gateway constructed (${live ? "LIVE" : "SHADOW"})` +
      ` — ${bindingCount} ${bindingCount === 1 ? "binding" : "bindings"},` +
      ` ${adapters.length} ${adapters.length === 1 ? "adapter" : "adapters"};` +
      ` ${live ? "BusInboundSink (publishing to the bus)" : "LoggingInboundSink (no bus publish)"}\n`,
  );

  return gw;
}
