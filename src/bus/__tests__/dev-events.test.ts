/**
 * F-2.1 (cortex#835) — tests for `bus/dev-events.ts`.
 *
 * Mirrors `review-events.test.ts` style: construct a request, assert the
 * envelope shape; round-trip the payload parser; cover the chain-id helper.
 */

import { describe, expect, test } from "bun:test";
import {
  createDevImplementRequestEvent,
  parseDevImplementPayload,
  devCorrelationChainId,
  type DevEventSource,
  type DevImplementPayload,
} from "../dev-events";
import type { Envelope } from "../myelin/envelope-validator";

const SOURCE: DevEventSource = { principal: "andreas", agent: "cortex", instance: "local" };
const PAYLOAD: DevImplementPayload = {
  repo: "the-metafactory/cortex",
  branch: "feat/c-300-panel",
  base: "main",
  brief: "Implement the panel.",
  issue: 300,
  gates: ["bunx tsc --noEmit"],
  feature: "C-300",
  title: "feat: panel",
};

describe("createDevImplementRequestEvent", () => {
  test("builds a tasks.dev.implement envelope with the canonical payload", () => {
    const env = createDevImplementRequestEvent({ source: SOURCE, payload: PAYLOAD });
    expect(env.type).toBe("tasks.dev.implement");
    expect(env.source).toBe("andreas.cortex.local");
    expect(env.sovereignty.classification).toBe("local");
    expect(env.payload).toMatchObject({
      repo: "the-metafactory/cortex",
      branch: "feat/c-300-panel",
      base: "main",
      brief: "Implement the panel.",
      issue: 300,
      gates: ["bunx tsc --noEmit"],
    });
    // Fresh UUID id; no correlation_id on a first-of-chain request.
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("federated classification opt-in", () => {
    const env = createDevImplementRequestEvent({
      source: SOURCE,
      classification: "federated",
      payload: PAYLOAD,
    });
    expect(env.sovereignty.classification).toBe("federated");
  });
});

describe("parseDevImplementPayload", () => {
  function envWith(payload: Record<string, unknown>): Envelope {
    const env = createDevImplementRequestEvent({ source: SOURCE, payload: PAYLOAD });
    env.payload = payload;
    return env;
  }

  test("round-trips a valid payload", () => {
    const env = createDevImplementRequestEvent({ source: SOURCE, payload: PAYLOAD });
    const parsed = parseDevImplementPayload(env);
    expect(parsed).toEqual(PAYLOAD);
  });

  test("minimal payload (no optionals)", () => {
    const env = envWith({
      repo: "the-metafactory/cortex",
      branch: "feat/x",
      base: "main",
      brief: "do it",
    });
    expect(parseDevImplementPayload(env)).toEqual({
      repo: "the-metafactory/cortex",
      branch: "feat/x",
      base: "main",
      brief: "do it",
    });
  });

  test.each([
    ["bad repo", { repo: "noslash", branch: "feat/x", base: "main", brief: "b" }],
    ["blank brief", { repo: "o/r", branch: "feat/x", base: "main", brief: "   " }],
    ["missing branch", { repo: "o/r", base: "main", brief: "b" }],
    ["bad branch (space)", { repo: "o/r", branch: "a b", base: "main", brief: "b" }],
    ["branch with .. (traversal)", { repo: "o/r", branch: "feat/x..y", base: "main", brief: "b" }],
    ["base with .. (traversal)", { repo: "o/r", branch: "feat/x", base: "..", brief: "b" }],
    ["non-int issue", { repo: "o/r", branch: "x", base: "main", brief: "b", issue: 1.5 }],
    ["negative issue", { repo: "o/r", branch: "x", base: "main", brief: "b", issue: -1 }],
    ["gates not array", { repo: "o/r", branch: "x", base: "main", brief: "b", gates: "tsc" }],
    ["empty gate", { repo: "o/r", branch: "x", base: "main", brief: "b", gates: [""] }],
  ])("rejects: %s", (_label, payload) => {
    expect(parseDevImplementPayload(envWith(payload as Record<string, unknown>))).toBeNull();
  });
});

describe("devCorrelationChainId", () => {
  test("uses correlation_id when present (the chain root)", () => {
    const env = createDevImplementRequestEvent({ source: SOURCE, payload: PAYLOAD });
    (env as { correlation_id?: string }).correlation_id = "chain-root-id";
    expect(devCorrelationChainId(env)).toBe("chain-root-id");
  });

  test("falls back to envelope.id for a first-of-chain request", () => {
    const env = createDevImplementRequestEvent({ source: SOURCE, payload: PAYLOAD });
    expect(devCorrelationChainId(env)).toBe(env.id);
  });
});
