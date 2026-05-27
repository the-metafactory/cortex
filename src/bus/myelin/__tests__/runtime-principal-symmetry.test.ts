/**
 * IAW Phase A.3 follow-up (cortex#130 item 1) — pin the subscribe/publish
 * `{principal}` symmetry invariant.
 *
 * Subscribe-side substitutes `{principal}` in NATS subject patterns from
 * `config.agent.operatorId` at startup via `principalFromConfig`.
 * Publish-side extracts `{principal}` from `envelope.source`'s first
 * segment via `principalFromEnvelope`. For any envelope this stack emits
 * via the system-event helpers (which build `source` as
 * `${principal}.${assistant}.${instance}`), the two MUST return identical
 * strings — otherwise publish/subscribe subjects diverge and round-trips
 * break.
 */
import { describe, test, expect } from "bun:test";

import {
  principalFromConfig,
  principalFromEnvelope,
} from "../envelope-validator";
import { createSystemAdapterDegradedEvent } from "../../system-events";

describe("MyelinRuntime — subscribe/publish {principal} symmetry (cortex#130 item 1)", () => {
  test("principalFromConfig and principalFromEnvelope agree for stack-emitted envelopes", () => {
    const operatorId = "metafactory";
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: operatorId, agent: "cortex", instance: "local" },
      adapterId: "discord-1",
      platform: "discord",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromConfig(operatorId)).toBe(principalFromEnvelope(envelope));
  });

  test("principalFromConfig falls back to 'default' when operatorId is undefined", () => {
    expect(principalFromConfig(undefined)).toBe("default");
  });

  test("principalFromEnvelope extracts the first dotted segment", () => {
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: "andreas", agent: "luna", instance: "work" },
      adapterId: "slack-1",
      platform: "slack",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromEnvelope(envelope)).toBe("andreas");
    // Sanity: the envelope.source itself has the full multi-segment form.
    expect(envelope.source).toBe("andreas.luna.work");
  });

  test("symmetry holds when principal changes — second stack identity", () => {
    const operatorId = "the-metafactory";
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: operatorId, agent: "echo", instance: "local" },
      adapterId: "discord-1",
      platform: "discord",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromConfig(operatorId)).toBe(principalFromEnvelope(envelope));
    expect(principalFromEnvelope(envelope)).toBe("the-metafactory");
  });
});
