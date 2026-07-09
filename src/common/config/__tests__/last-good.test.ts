/**
 * FS-7 / D-3 (cortex#1839) — tests for the last-known-good config snapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { stringify } from "yaml";

import { loadConfigWithAgents } from "../loader";
import {
  lastGoodDir,
  lastGoodSnapshotPath,
  readLastGoodSnapshotPath,
  writeLastGoodSnapshot,
} from "../last-good";

function validCortex(): Record<string, unknown> {
  return {
    principal: { id: "jc", displayName: "JC", discordId: "555555555555555555" },
    agents: [
      { id: "ivy", displayName: "Ivy", persona: "./personas/ivy.md", roles: [], trust: [], presence: {} },
    ],
    claude: {},
  };
}

describe("FS-7 / D-3 — last-good snapshot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fs7-lastgood-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSingleFile(config: Record<string, unknown>, name = "cortex.yaml"): string {
    const path = join(dir, name);
    writeFileSync(path, stringify(config), { mode: 0o600 });
    return path;
  }

  test("snapshot path is <config-dir>/.last-good/<basename>.snapshot", () => {
    const path = join(dir, "research.yaml");
    expect(lastGoodDir(path)).toBe(join(dir, ".last-good"));
    expect(lastGoodSnapshotPath(path)).toBe(join(dir, ".last-good", "research.snapshot"));
  });

  test("writeLastGoodSnapshot persists a 0600 snapshot that readLastGoodSnapshotPath finds", () => {
    const path = writeSingleFile(validCortex());
    expect(readLastGoodSnapshotPath(path)).toBeNull();

    const result = writeLastGoodSnapshot(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(existsSync(result.path)).toBe(true);
    expect(readLastGoodSnapshotPath(path)).toBe(result.path);
    // 0600 (owner rw only).
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    // Lives under .last-good/ keyed by the pointer basename.
    expect(dirname(result.path)).toBe(join(dir, ".last-good"));
    expect(basename(result.path)).toBe("cortex.snapshot");
  });

  test("the snapshot round-trips: loadConfigWithAgents accepts it", () => {
    const path = writeSingleFile(validCortex());
    const result = writeLastGoodSnapshot(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Reloading the snapshot through the daemon's validator must succeed — this
    // is exactly what the D-3 fallback does at boot.
    const loaded = loadConfigWithAgents(result.path);
    expect(loaded.inlineAgents).toHaveLength(1);
    expect(loaded.principal?.id).toBe("jc");
  });

  test("writeLastGoodSnapshot returns ok:false (never throws) when the pointer is missing", () => {
    const result = writeLastGoodSnapshot(join(dir, "nope.yaml"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
