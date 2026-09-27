/**
 * #2536 — the production connector must never turn a `no-observer` sibling
 * into a connect (authenticated or not). It throws before touching NATS, so the
 * aggregator's degrade path owns it even if a new call path skips the
 * aggregator's own `no-observer` check.
 */

import { describe, expect, test } from "bun:test";
import { natsSiblingBusConnector } from "../nats-sibling-connector";

describe("#2536 natsSiblingBusConnector", () => {
  test("throws on a no-observer sibling without connecting", async () => {
    await expect(
      natsSiblingBusConnector({
        stack: "work",
        principal: "alice",
        // Unroutable on purpose: a connect attempt would hang or fail
        // differently than the pre-connect refusal asserted below.
        url: "nats://127.0.0.1:1",
        credential: {
          kind: "no-observer",
          reason: "missing",
          observerUser: "mc-observer-default-to-work",
          observerCredsPath: "/nonexistent/mc-observer-default-to-work.creds",
        },
      }),
    ).rejects.toThrow(/no observer creds for sibling "work"/);
  });
});
