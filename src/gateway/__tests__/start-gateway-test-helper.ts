import {
  startGatewayIfEnabled,
  type StartGatewayOpts,
} from "../start-gateway";
import { isGatewayEnabled } from "../gateway-bootstrap";
import { planSurfaceOwnership } from "../surface-ownership-plan";

export function startGatewayWithPlan(
  opts: Omit<StartGatewayOpts, "ownershipPlan">,
): ReturnType<typeof startGatewayIfEnabled> {
  return startGatewayIfEnabled({
    ...opts,
    ownershipPlan: planSurfaceOwnership({
      surfaces: opts.surfaces,
      gatewayEnabled: isGatewayEnabled(opts.env),
      principal: opts.principal,
      // cortex#1951 — same registry `startGatewayIfEnabled` itself resolves
      // (opts.registry, or its own factory-derived fallback) so the
      // ownership plan's Gateway adapter instance ids never drift from what
      // gets constructed. `undefined` here is fine — `planSurfaceOwnership`
      // falls back to the in-tree default registry same as
      // `startGatewayIfEnabled` does.
      registry: opts.registry,
    }),
  });
}
