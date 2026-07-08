/**
 * cortex#596 — no-binding-match `system.gateway.routing_decision` emit.
 *
 * PR #1667 added the routed / publish-refusal routing-decision event, emitted
 * from {@link BusInboundSink} once an inbound has MATCHED a binding. The OTHER
 * unroutable case — an inbound that matches NO binding at all — happens UPSTREAM
 * in {@link SurfaceGateway.handleInbound}'s `onUnroutable` path (default
 * `console.warn`, stdout-only) and never reached the sink, so it stayed a
 * stdout-hunt. That no-binding drop is arguably the primary dry-run miss #596
 * was raised for.
 *
 * This module supplies the composition-root seam (design option (b)): the
 * gateway boot path (`start-gateway.ts`) already holds the `runtime` + `source`
 * it uses to build {@link BusInboundSink}, so it injects an `onUnroutable` that
 * (1) preserves the existing `console.warn` breadcrumb (the fallback when the
 * bus is down) and (2) fire-and-forget emits a `system.gateway.routing_decision`
 * with `outcome: "unroutable"` and `reason` = the `unroutableReason()` string.
 * `SurfaceGateway` itself stays free of any bus/system-event coupling — it keeps
 * its injected-interface design; the bus knowledge lives only here + at the boot
 * site, exactly where `BusInboundSink` already lives.
 *
 * ## Live-only, by symmetry with the sink
 *
 * The emit is wired ONLY on the LIVE gateway path (`CORTEX_GATEWAY_PUBLISH=1`),
 * where `start-gateway.ts` constructs `BusInboundSink`. SHADOW mode's contract
 * is "touch nothing on the bus", so no routing-decision event is emitted there —
 * the same reason the sink is absent in shadow. The guard below is
 * defence-in-depth on top of that: undefined `source`/`runtime`, or a runtime
 * without a `publish` method, skip the emit silently.
 *
 * ## No agent, by construction
 *
 * A no-binding inbound has no matched agent/stack/principal. Only what the
 * {@link InboundMessage} carries — `platform` + `instanceId` — is stamped; the
 * event type's `agent` field was relaxed to optional for exactly this case
 * (see `SystemGatewayRoutingDecisionOpts.agent`).
 */

import type { InboundMessage } from "../adapters/types";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { SystemEventSource } from "../bus/system-events";
import { createSystemGatewayRoutingDecisionEvent } from "../bus/system-events";

/**
 * The optional bus deps the emit is guarded on. Both come from the gateway boot
 * path, where they are also handed to {@link BusInboundSink}. Either being
 * `undefined` (the bus has not connected / no source identity is configured)
 * skips the emit silently.
 */
export interface GatewayUnroutableEmitDeps {
  /**
   * The gateway's Myelin runtime. `undefined` before the bus connects; a stub
   * runtime without a `publish` method is also tolerated (skip, never throw).
   */
  runtime: MyelinRuntime | undefined;
  /**
   * The gateway's dispatch-source identity (`{principal}.gateway.{instance}`) —
   * the envelope `source`. `undefined` when no source identity is configured.
   */
  source: SystemEventSource | undefined;
}

/**
 * Fire-and-forget emit a `system.gateway.routing_decision` for a NO-BINDING
 * unroutable inbound. Guarded on both optional deps and on the runtime actually
 * exposing `publish`; on any miss it returns without emitting. Never throws —
 * the caller runs inside `SurfaceGateway`'s never-throw `onUnroutable` contract.
 *
 * Mirrors `BusInboundSink.emitRoutingDecision`: the emit is `void`-discarded and
 * carries a defence-in-depth `.catch` so a runtime contract change can't crash
 * the adapter loop.
 */
export function emitUnroutableRoutingDecision(
  deps: GatewayUnroutableEmitDeps,
  msg: InboundMessage,
  reason: string,
): void {
  const { runtime, source } = deps;
  if (
    source === undefined ||
    runtime === undefined ||
    typeof runtime.publish !== "function"
  ) {
    return;
  }
  const env = createSystemGatewayRoutingDecisionEvent({
    source,
    outcome: "unroutable",
    platform: msg.platform,
    instanceId: msg.instanceId,
    reason,
    // No binding matched → no agent / stack / principal / subject to stamp.
  });
  // MyelinRuntime.publish signs + swallows its own errors; the extra catch is
  // defence-in-depth so a runtime contract change can't crash the caller.
  void runtime.publish(env).catch((err: unknown) => {
    process.stderr.write(
      `[surface-gateway] publish(system.gateway.routing_decision) failed — ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}

/**
 * Build an `onUnroutable` hook that runs `base` (the breadcrumb — preserves the
 * stdout fallback) and THEN emits the structured routing-decision event.
 *
 * `base` is `SurfaceGateway`'s {@link defaultUnroutableWarn} in production; a
 * caller-supplied `onUnroutable` is threaded through here instead when one was
 * passed to the boot path, so its breadcrumb is preserved too. The breadcrumb
 * runs FIRST so it survives even if the emit is skipped (bus down).
 *
 * A throw from `base` is NOT caught here — that is the existing `onUnroutable`
 * contract, enforced by `SurfaceGateway.handleInbound`'s outer try/catch (the
 * one adapter-loop firewall). This wrapper adds no new throw surface: the emit
 * is fully guarded + catch-wrapped.
 */
export function makeEmittingUnroutable(
  base: (msg: InboundMessage, reason: string) => void,
  deps: GatewayUnroutableEmitDeps,
): (msg: InboundMessage, reason: string) => void {
  return (msg, reason) => {
    base(msg, reason);
    emitUnroutableRoutingDecision(deps, msg, reason);
  };
}
