/**
 * P-14 U0.1 — `/api/observability/*` on the CLOUD worker (parity decision).
 *
 * WORKER-PARITY DECISION: the cloud worker does NOT proxy to the sideband. The
 * sideband is a LOCAL-ONLY daemon by design (signal cortex-sideband.md §3) —
 * it binds `127.0.0.1` on the principal's host and carries no token; the
 * security boundary is the host process boundary. The CF worker runs off-host
 * (in Cloudflare's edge), so it physically cannot — and per §3.2/§3.4 MUST not
 * — reach a principal's loopback sideband. Tier-3 drill-down is therefore a
 * LOCAL-MC-ONLY capability.
 *
 * On the cloud path we return the SAME structured "interior capture not
 * available" `SidebandError` the local server returns when no sideband is
 * configured, so the dashboard (#933) renders the cloud case honestly:
 * "interior capture not available — open the local Mission Control for Tier-3".
 * The frontend pins on the contract `SidebandError` shape regardless of which
 * MC served the request.
 */

import { Hono } from "hono";
import type { Env } from "../index";

export const observabilityRoutes = new Hono<{ Bindings: Env }>();

/**
 * Catch-all for the observability surface on the cloud worker. Always returns
 * the not-available error — the sideband is unreachable from the edge by design.
 */
observabilityRoutes.all("/api/observability/*", (c) => {
  return c.json(
    {
      code: "backend_unavailable",
      message:
        "interior capture not available on cloud Mission Control — Tier-3 " +
        "drill-down is local-only (the signal sideband binds loopback on the " +
        "principal's host). Open the local Mission Control to view traces/logs.",
    },
    503,
  );
});
