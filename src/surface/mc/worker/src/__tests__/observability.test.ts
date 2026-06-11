/**
 * P-14 U0.1 — cloud worker observability parity.
 *
 * The worker does NOT proxy to the sideband (local-only daemon, §3). Every
 * `/api/observability/*` request on the cloud path returns the structured
 * not-available SidebandError so the frontend (#933) renders the cloud case
 * honestly. The route has no env dependencies, so we exercise the sub-app
 * directly.
 */

import { describe, expect, it } from "bun:test";
import { observabilityRoutes } from "../routes/observability";

describe("cloud worker /api/observability/* — local-only parity", () => {
  it("returns structured not-available (503) for /traces", async () => {
    const res = await observabilityRoutes.request(
      "http://x/api/observability/traces?correlation_id=abcd",
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("backend_unavailable");
    expect(body.message).toContain("interior capture not available");
    expect(body.message).toContain("local-only");
  });

  it("returns the SAME shape for /traces/{id}/timeline", async () => {
    const res = await observabilityRoutes.request(
      "http://x/api/observability/traces/0123456789abcdef/timeline",
    );
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("backend_unavailable");
  });

  it("returns the SAME shape for /healthz", async () => {
    const res = await observabilityRoutes.request("http://x/api/observability/healthz");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("backend_unavailable");
  });

  it("never emits a deep_link the cloud can't honour", async () => {
    const res = await observabilityRoutes.request("http://x/api/observability/logs");
    const body = await res.json();
    expect(body.deep_link).toBeUndefined();
  });
});
