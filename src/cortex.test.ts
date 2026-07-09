/**
 * FS-7 / D-3 (cortex#1839) — tests for `resolveBootConfig`, the last-known-good
 * boot fallback. Covers the four ratified D-3 cases + the good-boot snapshot:
 *   - good boot → refreshes the snapshot, clears any degraded marker;
 *   - bad live + snapshot present → boots DEGRADED (marker written);
 *   - bad live + no snapshot → fail-hard (throws);
 *   - --strict + bad live (even with a snapshot) → fail-hard (throws).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { stringify } from "yaml";

import { resolveBootConfig } from "./cortex";
import { readLastGoodSnapshotPath } from "./common/config/last-good";
import { clearDegradedMarker, readDegradedMarker } from "./common/config/degraded-state";

function validCortex(): Record<string, unknown> {
  return {
    principal: { id: "jc", displayName: "JC", discordId: "555555555555555555" },
    agents: [
      { id: "ivy", displayName: "Ivy", persona: "./personas/ivy.md", roles: [], trust: [], presence: {} },
    ],
    claude: {},
  };
}

/** A cortex-shape config that fails schema validation (agent missing `persona`). */
function invalidCortex(): Record<string, unknown> {
  const c = validCortex();
  delete (c.agents as Record<string, unknown>[])[0]!.persona;
  return c;
}

const FIXED_NOW = "2026-07-10T00:00:00.000Z";

describe("FS-7 / D-3 — resolveBootConfig last-known-good fallback", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fs7-boot-"));
    // Per-test-unique pointer basename so the STATE_DIR degraded marker (keyed off
    // the config basename via pidFileFor) never collides across tests.
    configPath = join(dir, `${basename(dir)}.yaml`);
  });
  afterEach(() => {
    clearDegradedMarker(configPath);
    rmSync(dir, { recursive: true, force: true });
  });

  function write(config: Record<string, unknown>): void {
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
  }

  test("good boot returns no degraded, writes the last-good snapshot, clears any marker", () => {
    write(validCortex());
    const { loaded, degraded } = resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(degraded).toBeUndefined();
    expect(loaded.inlineAgents).toHaveLength(1);
    // Snapshot persisted; degraded marker absent.
    expect(readLastGoodSnapshotPath(configPath)).not.toBeNull();
    expect(readDegradedMarker(configPath)).toBeNull();
  });

  test("bad live config WITH a snapshot boots DEGRADED (marker written, snapshot loaded)", () => {
    // 1. Good boot → snapshot exists.
    write(validCortex());
    resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(readLastGoodSnapshotPath(configPath)).not.toBeNull();

    // 2. Break the live config, boot again → DEGRADED fallback.
    write(invalidCortex());
    const snapshotPath = readLastGoodSnapshotPath(configPath);
    expect(snapshotPath).not.toBeNull();
    const { loaded, degraded } = resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(degraded).toBeDefined();
    expect(degraded!.since).toBe(FIXED_NOW);
    expect(degraded!.snapshotPath).toBe(snapshotPath!);
    expect(degraded!.error).toContain("persona");
    // Booted on the (valid) snapshot — the agent is present.
    expect(loaded.inlineAgents).toHaveLength(1);
    // Marker persisted for `cortex status` / MC to read.
    const marker = readDegradedMarker(configPath);
    expect(marker).not.toBeNull();
    expect(marker!.snapshotPath).toBe(degraded!.snapshotPath);
  });

  test("bad live config with NO snapshot fails hard (throws)", () => {
    write(invalidCortex());
    expect(readLastGoodSnapshotPath(configPath)).toBeNull();
    expect(() => resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW })).toThrow(
      /no last-known-good snapshot/,
    );
    // No degraded marker written on a fail-hard.
    expect(readDegradedMarker(configPath)).toBeNull();
  });

  test("--strict disables the fallback: fails hard even WITH a snapshot present", () => {
    // Establish a snapshot via a good boot.
    write(validCortex());
    resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(readLastGoodSnapshotPath(configPath)).not.toBeNull();

    // Break it and boot --strict → fail hard, no fallback.
    write(invalidCortex());
    expect(() => resolveBootConfig(configPath, { strict: true, now: () => FIXED_NOW })).toThrow(
      /--strict is set/,
    );
  });

  test("good boot after a degraded boot clears the stale degraded marker", () => {
    // Snapshot + degraded marker.
    write(validCortex());
    resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    write(invalidCortex());
    resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(readDegradedMarker(configPath)).not.toBeNull();

    // Fix the live config → healthy boot clears the marker.
    write(validCortex());
    const { degraded } = resolveBootConfig(configPath, { strict: false, now: () => FIXED_NOW });
    expect(degraded).toBeUndefined();
    expect(readDegradedMarker(configPath)).toBeNull();
  });

  test("first boot with a bad config and no snapshot is unaffected by the snapshot dir existing empty", () => {
    // Guard against a false-positive: an empty .last-good dir must not look like a snapshot.
    write(invalidCortex());
    expect(existsSync(join(dir, ".last-good"))).toBe(false);
    expect(() => resolveBootConfig(configPath, { strict: false })).toThrow(/no last-known-good snapshot/);
  });
});
