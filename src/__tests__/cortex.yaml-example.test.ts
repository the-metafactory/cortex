/**
 * cortex#314 — `cortex.yaml.example` parse test.
 *
 * The example file at the repo root is the first thing a fresh principal
 * copies and edits. If it drifts from `CortexConfigSchema` (a field
 * renamed, a required key added, a regex tightened), copying it would
 * surface a confusing schema error during the principal's first boot.
 *
 * This test parses the on-disk file through `CortexConfigSchema.parse`
 * and asserts the schema accepts it without errors. Any future schema
 * change that breaks the example will fail here, forcing the example
 * to be updated in the same PR.
 *
 * The test does NOT spin up the runtime — it's a pure schema-level
 * gate. Boot-time wiring is covered by `cortex.capability-boot.test.ts`
 * and `cortex.review-consumer-boot.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { CortexConfigSchema } from "../common/types/cortex-config";

describe("cortex.yaml.example — first-install starter config (cortex#314)", () => {
  test("parses cleanly through CortexConfigSchema with zero errors", () => {
    // Resolve relative to the repo root. `import.meta.dir` points at
    // `src/__tests__/`; the example sits two levels up next to package.json.
    const examplePath = join(import.meta.dir, "..", "..", "cortex.yaml.example");
    const raw = readFileSync(examplePath, "utf-8");
    const yamlObj: unknown = parseYaml(raw);
    // `parse` throws on schema violations — the assertion is the absence
    // of a throw. We also assert the parse returns a populated config so
    // a future "everything optional" regression doesn't pass trivially.
    const parsed = CortexConfigSchema.parse(yamlObj);
    expect(parsed.principal.id).toBeDefined();
    expect(parsed.agents.length).toBeGreaterThan(0);
  });

  test("declares the 11 canonical code-review.* capability flavors echo provides", () => {
    // compass#96 F16 — the canonical review-flavor catalog is the 11 flavors
    // in REVIEW_FLAVORS (`src/common/types/review-flavors.ts`). The example MUST
    // declare all 11 in the top-level catalog (and reference all 11 from the
    // echo agent's runtime.capabilities[]) so a fresh principal copying the file
    // does not have to know the flavor list to wire capability-dispatch
    // end-to-end. `architecture` / `performance` / `ecosystem-compliance` are
    // LENSES inside FullReview, not flavors — they must be ABSENT.
    const examplePath = join(import.meta.dir, "..", "..", "cortex.yaml.example");
    const raw = readFileSync(examplePath, "utf-8");
    const yamlObj: unknown = parseYaml(raw);
    const parsed = CortexConfigSchema.parse(yamlObj);

    const catalogIds = new Set(parsed.capabilities.map((c) => c.id));
    const expected = [
      "code-review.generic",
      "code-review.typescript",
      "code-review.python",
      "code-review.rust",
      "code-review.go",
      "code-review.sql",
      "code-review.docs",
      "code-review.security",
      "code-review.confidentiality",
      "code-review.hardening",
      "code-review.skill-quality",
    ];
    for (const id of expected) {
      expect(catalogIds.has(id)).toBe(true);
    }

    // The dropped ids (lenses, not flavors) must NOT reappear.
    for (const phantom of [
      "code-review.documentation",
      "code-review.architecture",
      "code-review.performance",
      "code-review.ecosystem-compliance",
    ]) {
      expect(catalogIds.has(phantom)).toBe(false);
    }

    const echo = parsed.agents.find((a) => a.id === "echo");
    expect(echo).toBeDefined();
    const echoCaps = new Set(echo?.runtime?.capabilities ?? []);
    for (const id of expected) {
      expect(echoCaps.has(id)).toBe(true);
    }
  });
});
