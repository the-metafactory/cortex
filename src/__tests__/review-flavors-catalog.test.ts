/**
 * compass#96 F16 — catalog reconciliation guard.
 *
 * `cortex.yaml.example`'s `code-review.<flavor>` capability catalog and the
 * canonical `REVIEW_FLAVORS` vocabulary (`src/common/types/review-flavors.ts`)
 * are two surfaces of ONE contract. Before this reconciliation they had drifted:
 * the example declared `code-review.documentation` / `.architecture` /
 * `.performance` / `.ecosystem-compliance` — ids that do NOT resolve via
 * `reviewFlavorOfCapability` (phantoms a principal could `pilot request-review
 * --capability` against and get nothing), while omitting real flavors.
 *
 * This test parses the on-disk example and asserts, in BOTH directions:
 *   1. NO PHANTOM — every `code-review.*` id in the example (top-level catalog
 *      AND every agent's runtime.capabilities[]) resolves via
 *      `reviewFlavorOfCapability` / `isReviewFlavor`.
 *   2. NO GAP — every canonical `REVIEW_FLAVORS` flavor is declared in the
 *      example's top-level catalog, so the starter config is complete.
 *
 * A future flavor added to `REVIEW_FLAVORS` without updating the example (or a
 * stray non-flavor capability added to the example) fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { CortexConfigSchema } from "../common/types/cortex-config";
import {
  REVIEW_FLAVORS,
  isReviewFlavor,
  reviewFlavorOfCapability,
} from "../common/types/review-flavors";

function loadExample(): ReturnType<typeof CortexConfigSchema.parse> {
  const examplePath = join(import.meta.dir, "..", "..", "cortex.yaml.example");
  const raw = readFileSync(examplePath, "utf-8");
  const yamlObj: unknown = parseYaml(raw);
  return CortexConfigSchema.parse(yamlObj);
}

const CODE_REVIEW_PREFIX = "code-review.";

describe("cortex.yaml.example — review-flavor catalog reconciliation (compass#96 F16)", () => {
  test("every code-review.* id in the top-level catalog resolves to a flavor (no phantom)", () => {
    const parsed = loadExample();
    const ids = parsed.capabilities
      .map((c) => c.id)
      .filter((id) => id.startsWith(CODE_REVIEW_PREFIX));

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      // `reviewFlavorOfCapability` is the ONE parser of the `code-review.<flavor>`
      // syntax; undefined means the id is not a known flavor (a phantom).
      expect(reviewFlavorOfCapability(id)).toBeDefined();
      // …and the trailing segment is a known flavor via `isReviewFlavor`.
      expect(isReviewFlavor(id.slice(CODE_REVIEW_PREFIX.length))).toBe(true);
    }
  });

  test("every code-review.* id in every agent's runtime.capabilities resolves (no phantom)", () => {
    const parsed = loadExample();
    const agentReviewIds = parsed.agents.flatMap((a) =>
      (a.runtime?.capabilities ?? []).filter((id) =>
        id.startsWith(CODE_REVIEW_PREFIX),
      ),
    );

    expect(agentReviewIds.length).toBeGreaterThan(0);
    for (const id of agentReviewIds) {
      expect(reviewFlavorOfCapability(id)).toBeDefined();
    }
  });

  test("the top-level catalog declares EVERY canonical flavor (no gap)", () => {
    const parsed = loadExample();
    const declared = new Set(
      parsed.capabilities
        .map((c) => c.id)
        .filter((id) => id.startsWith(CODE_REVIEW_PREFIX))
        .map((id) => id.slice(CODE_REVIEW_PREFIX.length)),
    );
    for (const flavor of REVIEW_FLAVORS) {
      expect(declared.has(flavor)).toBe(true);
    }
  });

  test("the example catalog is EXACTLY the canonical flavor set (bijective)", () => {
    const parsed = loadExample();
    const declared = parsed.capabilities
      .map((c) => c.id)
      .filter((id) => id.startsWith(CODE_REVIEW_PREFIX))
      .map((id) => id.slice(CODE_REVIEW_PREFIX.length))
      .sort();
    expect(declared).toEqual([...REVIEW_FLAVORS].sort());
  });
});
