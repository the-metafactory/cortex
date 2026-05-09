import { test, expect, describe } from "bun:test";
import { RelayPolicySchema } from "../policy-schema";

const validPolicy = {
  allow_events: ["agent.task.started", "agent.task.completed"],
  fields: {
    "agent.task.started": { include: ["prompt_preview"] },
    "agent.task.completed": { include: ["summary", "duration_ms"] },
  },
  redact: [
    { pattern: "/Users/[a-zA-Z0-9_-]+", replace: "~" },
  ],
  drop_if: [
    { field: "payload.path", contains: [".env", "credentials"] },
  ],
};

describe("RelayPolicySchema", () => {
  test("validates well-formed policy", () => {
    const result = RelayPolicySchema.parse(validPolicy);
    expect(result.allow_events).toHaveLength(2);
    expect(result.fields["agent.task.started"]!.include).toContain("prompt_preview");
  });

  test("rejects missing allow_events", () => {
    const { allow_events, ...noAllow } = validPolicy;
    expect(() => RelayPolicySchema.parse(noAllow)).toThrow();
  });

  test("accepts empty allow_events array", () => {
    const result = RelayPolicySchema.parse({ allow_events: [] });
    expect(result.allow_events).toHaveLength(0);
  });

  test("defaults fields to empty when omitted", () => {
    const result = RelayPolicySchema.parse({ allow_events: ["test"] });
    expect(result.fields).toEqual({});
  });

  test("defaults redact to empty when omitted", () => {
    const result = RelayPolicySchema.parse({ allow_events: ["test"] });
    expect(result.redact).toEqual([]);
  });

  test("defaults drop_if to empty when omitted", () => {
    const result = RelayPolicySchema.parse({ allow_events: ["test"] });
    expect(result.drop_if).toEqual([]);
  });

  test("rejects invalid regex pattern in redact", () => {
    expect(() =>
      RelayPolicySchema.parse({
        allow_events: ["test"],
        redact: [{ pattern: "[invalid", replace: "x" }],
      })
    ).toThrow();
  });

  test("rejects drop_if with empty field string", () => {
    expect(() =>
      RelayPolicySchema.parse({
        allow_events: ["test"],
        drop_if: [{ field: "", contains: ["test"] }],
      })
    ).toThrow();
  });

  test("rejects drop_if with empty contains string", () => {
    expect(() =>
      RelayPolicySchema.parse({
        allow_events: ["test"],
        drop_if: [{ field: "payload.path", contains: [""] }],
      })
    ).toThrow();
  });

  test("accepts redact with optional flags", () => {
    const result = RelayPolicySchema.parse({
      allow_events: ["test"],
      redact: [{ pattern: "secret", replace: "[REDACTED]", flags: "i" }],
    });
    expect(result.redact[0]!.flags).toBe("i");
  });
});
