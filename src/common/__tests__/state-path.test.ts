/**
 * XDG wave-5 (cortex#1903) — STATE-dir resolver tests.
 *
 * Hermetic scratch `$HOME`; `CORTEX_STATE_DIR` / `XDG_STATE_HOME` /
 * `CORTEX_XDG_STRICT` unset per test. Proves canonical-first / legacy-fallback
 * precedence, the `$CORTEX_STATE_DIR` override (self-contained root, no legacy
 * probe), and `$XDG_STATE_HOME` honouring — for every state class the wave moves.
 * All paths derive from the injected `home`, so no real-home path is ever touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  canonicalLogsDir,
  canonicalNetworkCacheDir,
  canonicalPidStateDir,
  canonicalRelayDir,
  cortexStateDir,
  legacyCortexLogsDir,
  legacyGroveLogsDir,
  legacyNetworkCacheDir,
  legacyPidStateDir,
  legacyRelayDir,
  LOG_DIR_DEFAULT,
  resolveLogsDir,
  resolveNetworkCacheDir,
  resolvePidStateDir,
  resolveRelayDir,
  STATE_MIGRATION_JOURNAL_NAME,
  stateMigrationCompleted,
  xdgStateHome,
} from "../state-path";

/** Write the completion marker at the canonical root — the ONLY thing that flips
 *  the resolvers from legacy to canonical (#1903 pidfile-identity contract). */
function completeMigration(h: string): void {
  mkdirSync(cortexStateDir(h), { recursive: true });
  writeFileSync(join(cortexStateDir(h), STATE_MIGRATION_JOURNAL_NAME), "{}");
}

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CORTEX_STATE_DIR", "XDG_STATE_HOME", "CORTEX_XDG_STRICT"] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  home = mkdtempSync(join(tmpdir(), "xdg1903-path-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("state-path canonical roots", () => {
  test("cortexStateDir defaults to ~/.local/state/metafactory/cortex", () => {
    expect(cortexStateDir(home)).toBe(join(home, ".local", "state", "metafactory", "cortex"));
  });

  test("pidfiles live directly under the state root; logs/relay/cache are sub-dirs", () => {
    const root = cortexStateDir(home);
    expect(canonicalPidStateDir(home)).toBe(root);
    expect(canonicalLogsDir(home)).toBe(join(root, "logs"));
    expect(canonicalRelayDir(home)).toBe(join(root, "relay"));
    expect(canonicalNetworkCacheDir(home)).toBe(join(root, "network-cache"));
  });

  test("LOG_DIR_DEFAULT literal matches the canonical logs dir spelling", () => {
    expect(LOG_DIR_DEFAULT).toBe("~/.local/state/metafactory/cortex/logs");
  });
});

describe("$XDG_STATE_HOME override", () => {
  test("xdgStateHome honours $XDG_STATE_HOME verbatim, else ~/.local/state", () => {
    expect(xdgStateHome(home)).toBe(join(home, ".local", "state"));
    process.env.XDG_STATE_HOME = "/custom/xstate";
    expect(xdgStateHome(home)).toBe("/custom/xstate");
    expect(cortexStateDir(home)).toBe(join("/custom/xstate", "metafactory", "cortex"));
  });

  test("blank $XDG_STATE_HOME reads as unset (not /metafactory/cortex)", () => {
    process.env.XDG_STATE_HOME = "   ";
    expect(xdgStateHome(home)).toBe(join(home, ".local", "state"));
  });
});

describe("$CORTEX_STATE_DIR override — self-contained root, no legacy probe", () => {
  test("override wins over canonical AND legacy for every class", () => {
    process.env.CORTEX_STATE_DIR = "/ov/state";
    // Even with legacy trees present, the override short-circuits all fallback.
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    expect(cortexStateDir(home)).toBe("/ov/state");
    expect(resolvePidStateDir(home)).toBe("/ov/state");
    expect(resolveLogsDir(home)).toBe(join("/ov/state", "logs"));
    expect(resolveRelayDir(home)).toBe(join("/ov/state", "relay"));
    expect(resolveNetworkCacheDir(home)).toBe(join("/ov/state", "network-cache"));
  });

  test("blank $CORTEX_STATE_DIR reads as unset → canonical/legacy gating applies", () => {
    process.env.CORTEX_STATE_DIR = "  ";
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
  });
});

describe("completion-gated canonical flip (no override) — #1903 identity contract", () => {
  test("pid state dir: legacy grove is the pre-migration default; a BARE canonical dir does NOT flip it; the completion marker does", () => {
    // Nothing on disk → legacy grove default (stable write target + identity).
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
    // Legacy present, no marker → still legacy.
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
    // A BARE canonical dir WITHOUT the marker must NOT flip identity (the hazard
    // the completion gate exists to prevent — a sibling class created the root).
    mkdirSync(canonicalPidStateDir(home), { recursive: true });
    expect(stateMigrationCompleted(home)).toBe(false);
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
    // Completion marker present → canonical.
    completeMigration(home);
    expect(stateMigrationCompleted(home)).toBe(true);
    expect(resolvePidStateDir(home)).toBe(canonicalPidStateDir(home));
  });

  test("logs dir prefers grove over cortex pre-migration; flips to canonical only on the marker", () => {
    mkdirSync(legacyCortexLogsDir(home), { recursive: true });
    // Only cortex legacy present → cortex fallback.
    expect(resolveLogsDir(home)).toBe(legacyCortexLogsDir(home));
    // grove legacy also present → grove wins (first in precedence).
    mkdirSync(legacyGroveLogsDir(home), { recursive: true });
    expect(resolveLogsDir(home)).toBe(legacyGroveLogsDir(home));
    // A bare canonical logs dir without the marker does not flip.
    mkdirSync(canonicalLogsDir(home), { recursive: true });
    expect(resolveLogsDir(home)).toBe(legacyGroveLogsDir(home));
    // Completion marker → canonical.
    completeMigration(home);
    expect(resolveLogsDir(home)).toBe(canonicalLogsDir(home));
  });

  test("relay dir: legacy ~/.claude/relay pre-migration; canonical after the marker", () => {
    mkdirSync(legacyRelayDir(home), { recursive: true });
    expect(resolveRelayDir(home)).toBe(legacyRelayDir(home));
    completeMigration(home);
    expect(resolveRelayDir(home)).toBe(canonicalRelayDir(home));
  });

  test("network-cache: legacy ~/.config/cortex/network-cache pre-migration; canonical after the marker", () => {
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    expect(resolveNetworkCacheDir(home)).toBe(legacyNetworkCacheDir(home));
    completeMigration(home);
    expect(resolveNetworkCacheDir(home)).toBe(canonicalNetworkCacheDir(home));
  });

  test("fresh box (no legacy tree, no marker) → legacy grove default, NEVER canonical", () => {
    // The pre-migration default must be the legacy path even when nothing is on
    // disk yet, so pidfile identity is byte-stable from first boot until cutover.
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
    expect(resolveRelayDir(home)).toBe(legacyRelayDir(home));
    expect(resolveNetworkCacheDir(home)).toBe(legacyNetworkCacheDir(home));
  });
});
