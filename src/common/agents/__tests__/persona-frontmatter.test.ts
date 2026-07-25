/**
 * cortex#2386 (EBH-7a) — unit tests for `loadPersonaAllowedTools`.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPersonaAllowedTools } from "../persona-frontmatter";

const dirs: string[] = [];
function tmpPersonaFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-persona-frontmatter-test-"));
  dirs.push(dir);
  const path = join(dir, "persona.md");
  writeFileSync(path, contents, "utf-8");
  return path;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadPersonaAllowedTools", () => {
  test("returns the declared allowedTools list", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: Pier\nallowedTools: [Read]\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toEqual(["Read"]);
  });

  test("returns an explicit empty array as a real declaration (not undefined)", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: Pylon\nallowedTools: []\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toEqual([]);
  });

  test("returns undefined when allowedTools is absent — NOT a declaration of nothing", () => {
    const path = tmpPersonaFile("---\ndisplayName: Echo\n---\n\nbody\n");
    expect(loadPersonaAllowedTools(path)).toBeUndefined();
  });

  test("returns undefined when the file has no frontmatter block", () => {
    const path = tmpPersonaFile("# Just prose\n\nNo frontmatter here.\n");
    expect(loadPersonaAllowedTools(path)).toBeUndefined();
  });

  test("returns undefined when the frontmatter is malformed YAML", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: [unterminated\nallowedTools: [Read]\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toBeUndefined();
  });

  test("returns undefined when allowedTools is not a string array", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: Weird\nallowedTools: 42\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toBeUndefined();
  });

  test("returns undefined when allowedTools contains a non-string entry", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: Weird\nallowedTools: [Read, 5]\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toBeUndefined();
  });

  test("returns undefined when the file does not exist", () => {
    expect(loadPersonaAllowedTools("/nonexistent/path/persona.md")).toBeUndefined();
  });

  test("multi-tool allowlist round-trips in declared order", () => {
    const path = tmpPersonaFile(
      "---\ndisplayName: Multi\nallowedTools: [Read, Grep, Glob]\n---\n\nbody\n",
    );
    expect(loadPersonaAllowedTools(path)).toEqual(["Read", "Grep", "Glob"]);
  });
});
