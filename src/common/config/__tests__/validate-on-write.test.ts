/**
 * FS-7 (cortex#1839) — tests for the shared validate-on-write seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";

import {
  assertConfigLoads,
  formatConfigLoadError,
  validateConfigLoads,
} from "../validate-on-write";

/** A minimal cortex-shape config that loads cleanly. */
function validCortex(): Record<string, unknown> {
  return {
    principal: { id: "jc", displayName: "JC", discordId: "555555555555555555" },
    agents: [
      {
        id: "ivy",
        displayName: "Ivy",
        persona: "./personas/ivy.md",
        roles: [],
        trust: [],
        presence: {},
      },
    ],
    claude: {},
  };
}

describe("FS-7 validate-on-write — validateConfigLoads / assertConfigLoads", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fs7-validate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSingleFile(config: Record<string, unknown>): string {
    const path = join(dir, "cortex.yaml");
    // The single-file loader enforces chmod 600 — write fixtures 0600.
    writeFileSync(path, stringify(config), { mode: 0o600 });
    return path;
  }

  test("validateConfigLoads returns ok for a valid config", () => {
    const path = writeSingleFile(validCortex());
    const result = validateConfigLoads(path);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("validateConfigLoads returns precise field-pathed errors for an invalid config", () => {
    // Drop the required `persona` from the agent → CortexConfigSchema rejects.
    const bad = validCortex();
    (bad.agents as Record<string, unknown>[])[0]!.persona = undefined;
    delete (bad.agents as Record<string, unknown>[])[0]!.persona;
    const path = writeSingleFile(bad);
    const result = validateConfigLoads(path);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // The error names the offending field path (agents[0].persona).
    expect(result.errors.join("\n")).toContain("persona");
  });

  test("validateConfigLoads reports a missing config file (not a throw)", () => {
    const result = validateConfigLoads(join(dir, "does-not-exist.yaml"));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("assertConfigLoads is a no-op on a valid config", () => {
    const path = writeSingleFile(validCortex());
    expect(() => assertConfigLoads(path)).not.toThrow();
  });

  test("assertConfigLoads throws a precise multi-line error on an invalid config", () => {
    const bad = validCortex();
    delete (bad.agents as Record<string, unknown>[])[0]!.persona;
    const path = writeSingleFile(bad);
    expect(() => assertConfigLoads(path)).toThrow(/refusing to write/);
  });

  test("formatConfigLoadError stringifies a plain Error to its message", () => {
    expect(formatConfigLoadError(new Error("boom"))).toEqual(["boom"]);
  });
});
