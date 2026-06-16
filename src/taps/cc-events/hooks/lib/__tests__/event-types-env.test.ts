import { test, expect, describe, afterEach } from "bun:test";
import { createRawEvent } from "../event-types";

/**
 * G-2a/G-3a (cortex#774) — createRawEvent reads the surface instrumentation
 * fields from CORTEX_* first, falling back to the legacy GROVE_* names.
 */
describe("createRawEvent — CORTEX_* env resolution with GROVE_* fallback", () => {
  afterEach(() => {
    delete process.env.CORTEX_CHANNEL;
    delete process.env.CORTEX_AGENT_ID;
    delete process.env.CORTEX_AGENT_NAME;
    delete process.env.CORTEX_NETWORK;
    delete process.env.GROVE_CHANNEL;
    delete process.env.GROVE_AGENT_ID;
    delete process.env.GROVE_AGENT_NAME;
    delete process.env.GROVE_NETWORK;
  });

  test("reads CORTEX_* names when set", () => {
    process.env.CORTEX_CHANNEL = "ivy";
    process.env.CORTEX_AGENT_ID = "ivy-001";
    process.env.CORTEX_AGENT_NAME = "Ivy";
    process.env.CORTEX_NETWORK = "metafactory";

    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "s1",
    });

    expect(event.grove_channel).toBe("ivy");
    expect(event.agent_id).toBe("ivy-001");
    expect(event.agent_name).toBe("Ivy");
    expect(event.network_id).toBe("metafactory");
  });

  test("falls back to GROVE_* names when only GROVE_* is set", () => {
    process.env.GROVE_CHANNEL = "ivy";
    process.env.GROVE_AGENT_ID = "ivy-001";
    process.env.GROVE_AGENT_NAME = "Ivy";
    process.env.GROVE_NETWORK = "metafactory";

    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "s1",
    });

    expect(event.grove_channel).toBe("ivy");
    expect(event.agent_id).toBe("ivy-001");
    expect(event.agent_name).toBe("Ivy");
    expect(event.network_id).toBe("metafactory");
  });

  test("CORTEX_* wins over GROVE_* when both are set", () => {
    process.env.CORTEX_CHANNEL = "ivy";
    process.env.GROVE_CHANNEL = "legacy";

    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "s1",
    });

    expect(event.grove_channel).toBe("ivy");
  });

  test("explicit options still win over both env tiers", () => {
    process.env.CORTEX_CHANNEL = "ivy";
    const event = createRawEvent("agent.task.started", "Stop", {}, {
      sessionId: "s1",
      channel: "explicit",
    });
    expect(event.grove_channel).toBe("explicit");
  });
});
