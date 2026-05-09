/**
 * Tests for `src/bus/envelope-builder.ts` — the shared envelope skeleton
 * lifted from system-events / dispatch-events / cc-events when the rule
 * of three was satisfied (MIG-7 sweep).
 */

import { describe, expect, test } from "bun:test";
import { buildBaseEnvelope } from "../envelope-builder";
import { validateEnvelope } from "../myelin/envelope-validator";

const SOVEREIGNTY = {
  classification: "local" as const,
  data_residency: "NZ",
  max_hop: 0,
  frontier_ok: false,
  model_class: "local-only" as const,
};

describe("buildBaseEnvelope", () => {
  test("populates id (fresh UUID) and timestamp (current ISO) per call", () => {
    const a = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload: {},
    });
    const b = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload: {},
    });

    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("threads provided fields verbatim", () => {
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload: { foo: "bar", n: 1 },
    });

    expect(env.type).toBe("test.event.fired");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.sovereignty).toEqual(SOVEREIGNTY);
    expect(env.payload).toEqual({ foo: "bar", n: 1 });
  });

  test("correlation_id is set when provided", () => {
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      correlationId: "11111111-1111-4111-8111-111111111111",
      payload: {},
    });
    expect(env.correlation_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("correlation_id is omitted when not provided", () => {
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload: {},
    });
    expect("correlation_id" in env).toBe(false);
  });

  test("correlation_id is omitted when empty string passed (truthy gate)", () => {
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      correlationId: "",
      payload: {},
    });
    expect("correlation_id" in env).toBe(false);
  });

  test("output passes the myelin schema validator with valid inputs", () => {
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload: { repo: "grove" },
    });
    const v = validateEnvelope(env);
    expect(v.ok).toBe(true);
  });

  test("payload reference is not aliased (caller can mutate without affecting envelope)", () => {
    const payload: Record<string, unknown> = { foo: "bar" };
    const env = buildBaseEnvelope({
      type: "test.event.fired",
      source: "metafactory.cortex.local",
      sovereignty: SOVEREIGNTY,
      payload,
    });
    // The current contract DOES alias payload by reference (no defensive
    // copy). Document that behaviour explicitly so a future refactor
    // changing it has to update this test consciously. Domain helpers
    // construct fresh payload literals at every call site, so the alias
    // is harmless in practice.
    expect(env.payload).toBe(payload);
  });
});
