/**
 * F-1 — Persona format specification.
 *
 * Verifies the version constant + the canonical schema doc.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { PERSONA_FORMAT_VERSION } from "../persona-format";

/**
 * Walk up from this test file to find the repo root marker (`package.json`).
 * Beats hardcoded `../../../../` which silently breaks if the test file ever
 * moves to a deeper directory (Echo N2 on cortex#61).
 */
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== "/" && dir !== "") {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`could not find package.json walking up from ${start}`);
}

const REPO_ROOT = findRepoRoot(import.meta.dir);
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

  test('"Current version" section binds the version to its TypeScript declaration', () => {
    const body = readFileSync(DOC_PATH, "utf-8");
    const sectionStart = body.indexOf("## Current version");
    expect(sectionStart).toBeGreaterThan(-1);
    const nextHeading = body.indexOf("\n## ", sectionStart + 1);
    const section =
      nextHeading > -1 ? body.slice(sectionStart, nextHeading) : body.slice(sectionStart);
    // Tightened from substring (.toContain) to a regex anchored on the
    // canonical TypeScript declaration shape (Echo N1 on cortex#61). A stale
    // version literal sitting in a code comment elsewhere can no longer
    // satisfy the guard.
    const pattern = new RegExp(`PERSONA_FORMAT_VERSION\\s*=\\s*"${PERSONA_FORMAT_VERSION}"`);
    expect(section).toMatch(pattern);
  });

  test("Current version section points at the source-of-truth file", () => {
    const body = readFileSync(DOC_PATH, "utf-8");
    const sectionStart = body.indexOf("## Current version");
    const nextHeading = body.indexOf("\n## ", sectionStart + 1);
    const section =
      nextHeading > -1 ? body.slice(sectionStart, nextHeading) : body.slice(sectionStart);
    expect(section).toContain("src/common/types/persona-format.ts");
  });

  test('"Versioning" Changelog table includes a row for the current version', () => {
    // Echo M1 on cortex#61 — drift guard expanded to also cover the
    // Versioning > Changelog table. The doc instructs maintainers to update
    // both Current version and Changelog in lockstep when bumping the
    // constant; before this guard, a bump that forgot Changelog stayed green.
    const body = readFileSync(DOC_PATH, "utf-8");
    const sectionStart = body.indexOf("## Versioning");
    expect(sectionStart).toBeGreaterThan(-1);
    const nextHeading = body.indexOf("\n## ", sectionStart + 1);
    const section =
      nextHeading > -1 ? body.slice(sectionStart, nextHeading) : body.slice(sectionStart);
    // Changelog row format: `| <version> | <date> | <description> |`. Match
    // a pipe-delimited row that opens with the canonical version literal.
    const rowPattern = new RegExp(`\\|\\s*${PERSONA_FORMAT_VERSION.replace(/\./g, "\\.")}\\s*\\|`);
    expect(section).toMatch(rowPattern);
  });
});
