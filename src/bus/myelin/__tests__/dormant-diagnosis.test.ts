/**
 * Pins {@link DORMANT_RUNTIME_DIAGNOSIS} — the one string every consumer lane
 * prints when `subscribePull` returns null.
 *
 * ## Why this test exists
 *
 * The DORMANT hint has now been wrong twice, in the same way both times: it
 * named a cause that did not cover every path to a disabled runtime, and sent
 * the principal somewhere that had nothing to tell them.
 *
 *   - It said **"G-1111 pending"** for two months after cortex#335 closed —
 *     the misdirection visible in cortex#1875's title.
 *   - Its replacement said **"check nats.url … grep for 'failed to connect'"**,
 *     which is empty for the `!config.nats?.url` return (that path logs nothing)
 *     and wrong for the all-subscribers-failed-to-bind return (link was up).
 *
 * The per-lane boot tests only cover review + release. Two of the four emit
 * sites — brain and dev — had no assertion at all, so a hand-copied variant
 * could drift there unseen. Pinning the shared constant covers all four at
 * once, which is the point of having extracted it.
 *
 * These assertions are deliberately about MEANING, not phrasing: each of the
 * three disabled-runtime returns in `runtime.ts` must be findable in the text,
 * and the silent one must be flagged as silent.
 */

import { describe, expect, test } from "bun:test";
import { DORMANT_RUNTIME_DIAGNOSIS } from "../runtime";

describe("DORMANT_RUNTIME_DIAGNOSIS", () => {
  test("names the unset-nats.url cause AND flags that it logs nothing", () => {
    // `if (!config.nats?.url) return { enabled: false, … }` returns without
    // logging. A hint that only offered a grep would come back empty here —
    // and this is the most common misconfiguration of the three.
    expect(DORMANT_RUNTIME_DIAGNOSIS).toContain("nats.url");
    expect(DORMANT_RUNTIME_DIAGNOSIS).toMatch(/silent|no log line/i);
  });

  test("names the failed-connect cause", () => {
    expect(DORMANT_RUNTIME_DIAGNOSIS).toMatch(/connect failed|failed to connect/i);
  });

  test("names the all-subscribers-failed-to-bind cause", () => {
    // The link was UP for this one, so "no NATS link" alone would misdescribe it.
    expect(DORMANT_RUNTIME_DIAGNOSIS).toMatch(/failed to bind|subscriber/i);
  });

  test("points at a log prefix that actually exists", () => {
    // `myelin-runtime:` prefixes both the connect and the subscribe failures,
    // so it resolves for causes 2 and 3.
    expect(DORMANT_RUNTIME_DIAGNOSIS).toContain("myelin-runtime:");
  });

  test("does not resurrect the retired G-1111 pointer", () => {
    expect(DORMANT_RUNTIME_DIAGNOSIS).not.toMatch(/g-?1111/i);
  });
});
