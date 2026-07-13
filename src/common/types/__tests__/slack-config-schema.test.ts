/**
 * F-slack: SlackPresenceSchema / SlackInstanceSchema parse tests.
 *
 * The schemas are the contract between cortex.yaml (principal-facing) and
 * the adapter. Lock in the field-level invariants so a schema regression
 * surfaces immediately at config-load rather than as a runtime stack trace
 * inside the adapter.
 *
 * cortex#1795 (S10) — relocated from `src/adapters/slack/__tests__/
 * schema.test.ts`. This file tests cortex-core's OWN `cortex-config.ts` /
 * `config.ts` schemas (the config-loader-facing "fold `surfaces.slack[]`/
 * `agents[].presence.slack` into a validated presence object" schema — see
 * `src/adapters/slack/schema.ts`'s module doc for why that schema stays in
 * cortex-config.ts rather than moving with the adapter) — NOT the
 * plugin-owned duplicate in `src/adapters/slack/schema.ts`. It never
 * exercised `SlackAdapter`/`slackAdapterPlugin` and has no bundle
 * counterpart; it moved here (out of the adapter's test directory) so the
 * MOVE half of #1795 (deleting `src/adapters/slack/`) doesn't silently
 * drop cortex-core schema coverage.
 */

import { test, expect, describe } from "bun:test";
import { SlackPresenceSchema } from "../cortex-config";
import { SlackInstanceSchema } from "../config";

const VALID_PRESENCE = {
  botToken: "xoxb-TEST-TOKEN-12345",
  appToken: "xapp-TEST-APP-12345",
  workspaceId: "T0WORKSPACE",
  channels: [{ id: "C0CHANNEL1", name: "cortex" }],
};

describe("SlackPresenceSchema", () => {
  test("parses a minimal valid presence", () => {
    const parsed = SlackPresenceSchema.parse(VALID_PRESENCE);
    expect(parsed.botToken).toBe("xoxb-TEST-TOKEN-12345");
    expect(parsed.appToken).toBe("xapp-TEST-APP-12345");
    expect(parsed.workspaceId).toBe("T0WORKSPACE");
    expect(parsed.enabled).toBe(true);
    expect(parsed.allowedUserIds).toEqual([]);
    expect(parsed.trustedBotIds).toEqual([]);
    expect(parsed.surfaceSubjects).toEqual([]);
  });

  test("rejects botToken without xoxb- prefix", () => {
    expect(() =>
      SlackPresenceSchema.parse({ ...VALID_PRESENCE, botToken: "not-a-bot-token" }),
    ).toThrow(/xoxb-/);
  });

  test("rejects appToken without xapp- prefix", () => {
    expect(() =>
      SlackPresenceSchema.parse({ ...VALID_PRESENCE, appToken: "xoxb-wrong-kind" }),
    ).toThrow(/xapp-/);
  });

  test("rejects workspaceId without T-prefix", () => {
    expect(() =>
      SlackPresenceSchema.parse({ ...VALID_PRESENCE, workspaceId: "U0WRONG" }),
    ).toThrow(/T\.\.\./);
  });

  test("rejects channel id with wrong prefix", () => {
    expect(() =>
      SlackPresenceSchema.parse({
        ...VALID_PRESENCE,
        channels: [{ id: "U0WRONG", name: "nope" }],
      }),
    ).toThrow();
  });

  test("accepts both C- and G-prefixed channel ids", () => {
    const parsed = SlackPresenceSchema.parse({
      ...VALID_PRESENCE,
      channels: [
        { id: "C0PUBLIC01", name: "pub" },
        { id: "G0PRIVATE1", name: "priv" },
      ],
    });
    expect(parsed.channels).toHaveLength(2);
  });

  test("rejects too-short channel id (cortex#235 r1#6)", () => {
    expect(() =>
      SlackPresenceSchema.parse({
        ...VALID_PRESENCE,
        channels: [{ id: "C0SHORT", name: "tooshort" }], // 7 chars after C, below 8 min
      }),
    ).toThrow(/8-16/);
  });

  test("rejects too-long channel id (cortex#235 r1#6)", () => {
    expect(() =>
      SlackPresenceSchema.parse({
        ...VALID_PRESENCE,
        channels: [{ id: "C" + "0".repeat(17), name: "toolong" }],
      }),
    ).toThrow(/8-16/);
  });

  test("rejects too-long workspaceId (cortex#235 r1#6)", () => {
    expect(() =>
      SlackPresenceSchema.parse({
        ...VALID_PRESENCE,
        workspaceId: "T" + "0".repeat(17),
      }),
    ).toThrow(/8-16/);
  });

  test("passes through optional surfaceFallbackChannelId", () => {
    const parsed = SlackPresenceSchema.parse({
      ...VALID_PRESENCE,
      surfaceFallbackChannelId: "C0FALLBACK",
    });
    expect(parsed.surfaceFallbackChannelId).toBe("C0FALLBACK");
  });

  test("preserves surfaceSubjects when set", () => {
    const parsed = SlackPresenceSchema.parse({
      ...VALID_PRESENCE,
      surfaceSubjects: ["local.metafactory.review.>"],
    });
    expect(parsed.surfaceSubjects).toEqual(["local.metafactory.review.>"]);
  });
});

describe("SlackInstanceSchema", () => {
  test("parses the legacy-shaped instance with auto-defaults", () => {
    const parsed = SlackInstanceSchema.parse(VALID_PRESENCE);
    expect(parsed.enabled).toBe(true);
    expect(parsed.channels).toHaveLength(1);
  });

  test("instanceId is optional", () => {
    const parsed = SlackInstanceSchema.parse(VALID_PRESENCE);
    expect(parsed.instanceId).toBeUndefined();
  });

  test("instanceId pass-through when provided", () => {
    const parsed = SlackInstanceSchema.parse({ ...VALID_PRESENCE, instanceId: "luna-slack" });
    expect(parsed.instanceId).toBe("luna-slack");
  });
});
