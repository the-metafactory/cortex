/**
 * IAW Phase C.2b-242a (cortex#296) — `policy.parallel_mode_enabled`
 * schema field tests. Pins the default-off behaviour so existing
 * operator configs continue to parse cleanly without an explicit
 * flag.
 */

import { describe, expect, test } from "bun:test";
import { PolicySchema } from "../../types/cortex-config";

describe("policy.parallel_mode_enabled (cortex#296)", () => {
  test("defaults to false when omitted", () => {
    const policy = PolicySchema.parse({
      principals: [],
      roles: [],
    });
    expect(policy.parallel_mode_enabled).toBe(false);
  });

  test("accepts explicit true", () => {
    const policy = PolicySchema.parse({
      principals: [],
      roles: [],
      parallel_mode_enabled: true,
    });
    expect(policy.parallel_mode_enabled).toBe(true);
  });

  test("accepts explicit false", () => {
    const policy = PolicySchema.parse({
      principals: [],
      roles: [],
      parallel_mode_enabled: false,
    });
    expect(policy.parallel_mode_enabled).toBe(false);
  });

  test("rejects non-boolean", () => {
    expect(() =>
      PolicySchema.parse({
        principals: [],
        roles: [],
        parallel_mode_enabled: "yes",
      }),
    ).toThrow();
  });
});
