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
 * could drift there unseen. This file therefore does TWO things: it pins the
 * constant's meaning, and (second describe block) it verifies each of the four
 * lanes actually uses it rather than inlining a fork.
 *
 * These assertions are deliberately about MEANING, not phrasing: each of the
 * three disabled-runtime returns in `runtime.ts` must be findable in the text,
 * and the silent one must be flagged as silent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DORMANT_RUNTIME_DIAGNOSIS } from "../runtime";

/** The four lanes that emit a DORMANT line, relative to `src/`. */
const EMIT_SITES = [
  "runner/review-consumer-boot.ts",
  "runner/release-consumer-boot.ts",
  "runner/brain-consumer-boot.ts",
  "cortex.ts",
] as const;

const SRC_ROOT = join(import.meta.dir, "..", "..", "..");

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

/**
 * Pinning the constant's TEXT does not, on its own, cover the four lanes —
 * a lane could inline its own variant and every assertion above would still
 * pass. That is the exact drift that let two of the four sites go unchecked
 * before the constant existed. These tests check the wiring, not the words.
 */
describe("DORMANT_RUNTIME_DIAGNOSIS — every emit site uses it", () => {
  for (const site of EMIT_SITES) {
    test(`${site} references the shared constant`, () => {
      const src = readFileSync(join(SRC_ROOT, site), "utf8");
      expect(src).toContain("DORMANT_RUNTIME_DIAGNOSIS");
    });

    test(`${site} does not inline its own diagnosis text`, () => {
      const src = readFileSync(join(SRC_ROOT, site), "utf8");
      // Derived from the constant, NOT a hand-copied literal: if the constant
      // is reworded, this guard follows it instead of passing vacuously
      // against a substring that no longer exists anywhere.
      const tail = DORMANT_RUNTIME_DIAGNOSIS.slice(-40);
      expect(src).not.toContain(tail);
    });
  }
});
