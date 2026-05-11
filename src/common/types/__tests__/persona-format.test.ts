/**
 * F-1 — Persona format specification.
 *
 * Verifies the version constant + the canonical schema doc.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { PERSONA_FORMAT_VERSION } from "../persona-format";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "persona-format.md");

describe("PERSONA_FORMAT_VERSION", () => {
  test("matches semver shape major.minor.patch", () => {
    expect(PERSONA_FORMAT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("is exactly the v1 release value", () => {
    expect(PERSONA_FORMAT_VERSION).toBe("1.0.0");
  });
});

describe("docs/persona-format.md", () => {
  test("exists at the expected path", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  describe("required sections", () => {
    const required = [
      "## Schema",
      "## Examples",
      "## Versioning",
      "## Error handling",
      "## Current version",
      "## Related docs",
    ];

    for (const heading of required) {
      test(`contains heading "${heading}"`, () => {
        const body = readFileSync(DOC_PATH, "utf-8");
        expect(body).toContain(heading);
      });
    }
  });

  test('"Current version" section names the same value as PERSONA_FORMAT_VERSION', () => {
    const body = readFileSync(DOC_PATH, "utf-8");
    // Locate the section + the next heading boundary.
    const sectionStart = body.indexOf("## Current version");
    expect(sectionStart).toBeGreaterThan(-1);
    const nextHeading = body.indexOf("\n## ", sectionStart + 1);
    const section =
      nextHeading > -1 ? body.slice(sectionStart, nextHeading) : body.slice(sectionStart);
    // The version constant string must appear verbatim in this section.
    expect(section).toContain(PERSONA_FORMAT_VERSION);
  });

  test("Current version section points at the source-of-truth file", () => {
    const body = readFileSync(DOC_PATH, "utf-8");
    const sectionStart = body.indexOf("## Current version");
    const nextHeading = body.indexOf("\n## ", sectionStart + 1);
    const section =
      nextHeading > -1 ? body.slice(sectionStart, nextHeading) : body.slice(sectionStart);
    expect(section).toContain("src/common/types/persona-format.ts");
  });
});
