/**
 * XDG wave-5 (cortex#1902) — DATA-dir resolver tests.
 *
 * Hermetic: every path derives from a scratch `$HOME` under `os.tmpdir()`, and
 * `CORTEX_DATA_DIR` is unset per test so nothing resolves off the real home. The
 * resolvers are PURE (existence-gated `existsSync` only) — no copies here.
 *
 * Covers AC3 (both zod defaults point at the new data root; no divergence) plus
 * the canonical-first / legacy-fallback precedence every resolver shares.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  PUBLISHED_EVENTS_DIR_DEFAULT,
  canonicalPublishedEventsDir,
  cortexDataDir,
  resolveCursorPath,
  resolvePublishedEventsDir,
  resolveStackDbPath,
  resolveStandaloneDbPath,
} from "../data-path";
import { AgentConfigSchema } from "../types/config";
import { PathsConfigSchema } from "../types/cortex-config";

let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.CORTEX_DATA_DIR;
  delete process.env.CORTEX_DATA_DIR;
  home = mkdtempSync(join(tmpdir(), "xdg1902-data-"));
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORTEX_DATA_DIR;
  else process.env.CORTEX_DATA_DIR = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
};

describe("cortexDataDir", () => {
  test("defaults to ~/.local/share/metafactory/cortex", () => {
    expect(cortexDataDir(home)).toBe(join(home, ".local", "share", "metafactory", "cortex"));
  });
  test("CORTEX_DATA_DIR override wins verbatim", () => {
    process.env.CORTEX_DATA_DIR = "/scratch/data";
    expect(cortexDataDir(home)).toBe("/scratch/data");
  });
});

describe("resolveStackDbPath — canonical-first / legacy-fallback", () => {
  const canonical = (h: string, s: string) =>
    join(h, ".local", "share", "metafactory", "cortex", "mc", s, "mission-control.db");
  const legacy = (h: string, s: string) =>
    join(h, ".local", "share", "cortex", "mc", s, "mission-control.db");

  test("canonical when it exists", () => {
    touch(canonical(home, "work"));
    expect(resolveStackDbPath("work", home)).toBe(canonical(home, "work"));
  });
  test("legacy when only legacy exists", () => {
    touch(legacy(home, "work"));
    expect(resolveStackDbPath("work", home)).toBe(legacy(home, "work"));
  });
  test("canonical (write target) when neither exists", () => {
    expect(resolveStackDbPath("work", home)).toBe(canonical(home, "work"));
  });
  test("canonical wins even if BOTH exist", () => {
    touch(legacy(home, "work"));
    touch(canonical(home, "work"));
    expect(resolveStackDbPath("work", home)).toBe(canonical(home, "work"));
  });
  test("CORTEX_DATA_DIR override skips the legacy probe", () => {
    process.env.CORTEX_DATA_DIR = join(home, "override");
    // Even with a legacy db present, the override root is self-contained.
    touch(legacy(home, "work"));
    expect(resolveStackDbPath("work", home)).toBe(
      join(home, "override", "mc", "work", "mission-control.db"),
    );
  });
});

describe("resolveStandaloneDbPath / resolveCursorPath — legacy grove fallback", () => {
  test("standalone db falls back to legacy ~/.local/share/grove", () => {
    const legacy = join(home, ".local", "share", "grove", "mission-control.db");
    touch(legacy);
    expect(resolveStandaloneDbPath(home)).toBe(legacy);
  });
  test("cursor falls back to legacy ~/.local/share/grove", () => {
    const legacy = join(home, ".local", "share", "grove", "mc-hook-cursor.json");
    touch(legacy);
    expect(resolveCursorPath(home)).toBe(legacy);
  });
  test("both default to the metafactory root when nothing legacy exists", () => {
    expect(resolveStandaloneDbPath(home)).toBe(
      join(home, ".local", "share", "metafactory", "cortex", "mission-control.db"),
    );
    expect(resolveCursorPath(home)).toBe(
      join(home, ".local", "share", "metafactory", "cortex", "mc-hook-cursor.json"),
    );
  });
});

describe("resolvePublishedEventsDir — legacy ~/.claude fallback", () => {
  test("falls back to legacy ~/.claude/events/published", () => {
    const legacy = join(home, ".claude", "events", "published");
    touch(join(legacy, "keep")); // make the dir exist
    expect(resolvePublishedEventsDir(home)).toBe(legacy);
  });
  test("defaults to the metafactory data root when no legacy buffer exists", () => {
    expect(resolvePublishedEventsDir(home)).toBe(canonicalPublishedEventsDir(home));
  });
});

describe("AC3 — both zod defaults point at the new data root, no divergence", () => {
  test("PUBLISHED_EVENTS_DIR_DEFAULT is the metafactory data-root value", () => {
    expect(PUBLISHED_EVENTS_DIR_DEFAULT).toBe(
      "~/.local/share/metafactory/cortex/events/published",
    );
  });
  test("AgentConfigSchema.paths default == PathsConfigSchema default == the new root", () => {
    // Use the inner `paths` schema so this doesn't depend on the whole
    // AgentConfigSchema being parseable from `{}`.
    const agentDefault = AgentConfigSchema.shape.paths.parse({}).publishedEventsDir;
    const cortexDefault = PathsConfigSchema.parse({}).publishedEventsDir;
    expect(agentDefault).toBe(PUBLISHED_EVENTS_DIR_DEFAULT);
    expect(cortexDefault).toBe(PUBLISHED_EVENTS_DIR_DEFAULT);
    // The load-bearing "no divergence" assertion: the two schemas agree.
    expect(agentDefault).toBe(cortexDefault);
  });
});
