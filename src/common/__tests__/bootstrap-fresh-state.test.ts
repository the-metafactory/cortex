/**
 * XDG wave-5 (cortex#2030) — FRESH-INSTALL state-bootstrap tests.
 *
 * The postinstall bootstrap ({@link bootstrapFreshStateDir}) establishes the
 * canonical state tree + completion marker on a GENUINELY FRESH box, and leaves
 * an UPGRADE box (legacy state present) completely untouched (the gated migration
 * owns that cutover). Hermetic scratch `$HOME`; `CORTEX_STATE_DIR` unset per test;
 * ZERO real-home access. Covers the issue ACs:
 *   - fresh box → canonical tree (+ logs/) + marker; resolvers return canonical;
 *     a `CORTEX_XDG_STRICT=1` resolve emits ZERO `xdg-fallback:` lines.
 *   - upgrade box (legacy grove state present) → NOTHING written, no marker,
 *     resolver still returns legacy.
 *   - idempotent re-install → already-complete, no throw, marker untouched.
 *   - the fresh-vs-upgrade discriminator ({@link legacyStateTreePresent}) fires on
 *     each legacy state signal, but NOT on a bare relay dir (config-class).
 *
 * All test/describe names contain "fresh state" for `bun test … -t`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bootstrapFreshStateDir,
  legacyStateTreePresent,
  STATE_MIGRATION_JOURNAL_NAME,
} from "../migrate-state-dir";
import {
  canonicalLogsDir,
  canonicalPidStateDir,
  cortexStateDir,
  legacyCortexLogsDir,
  legacyGroveLogsDir,
  legacyNetworkCacheDir,
  legacyPidStateDir,
  legacyRelayDir,
  resolveLogsDir,
  resolvePidStateDir,
  stateMigrationCompleted,
} from "../state-path";

const STAMP = "2026-07-15T00:00:00.000Z";

let home: string;
let savedEnv: string | undefined;
let savedStrict: string | undefined;

beforeEach(() => {
  savedEnv = process.env.CORTEX_STATE_DIR;
  savedStrict = process.env.CORTEX_XDG_STRICT;
  delete process.env.CORTEX_STATE_DIR;
  delete process.env.CORTEX_XDG_STRICT;
  home = mkdtempSync(join(tmpdir(), "xdg2030-fresh-"));
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORTEX_STATE_DIR;
  else process.env.CORTEX_STATE_DIR = savedEnv;
  if (savedStrict === undefined) delete process.env.CORTEX_XDG_STRICT;
  else process.env.CORTEX_XDG_STRICT = savedStrict;
  rmSync(home, { recursive: true, force: true });
});

const markerPath = (h: string) => join(cortexStateDir(h), STATE_MIGRATION_JOURNAL_NAME);

/** Run `fn` with strict mode on, capturing everything written to stderr. */
function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: unknown) => {
    buf += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

describe("fresh state — fresh box bootstrap (cortex#2030)", () => {
  test("fresh state: establishes canonical tree + logs/ + completion marker", () => {
    expect(stateMigrationCompleted(home)).toBe(false);

    const res = bootstrapFreshStateDir({ home }, STAMP);

    expect(res.outcome).toBe("bootstrapped");
    expect(res.canonical).toBe(cortexStateDir(home));
    expect(existsSync(cortexStateDir(home))).toBe(true);
    expect(existsSync(canonicalLogsDir(home))).toBe(true);
    expect(existsSync(markerPath(home))).toBe(true);
    expect(stateMigrationCompleted(home)).toBe(true);

    // The marker is a well-formed completion journal (empty carry on a fresh box).
    const journal = JSON.parse(readFileSync(markerPath(home), "utf8"));
    expect(journal.version).toBe(1);
    expect(journal.carried).toEqual([]);
    expect(journal.canonical).toBe(cortexStateDir(home));
    expect(journal.stampedAt).toBe(STAMP);
  });

  test("fresh state: resolvers return canonical + a strict resolve emits ZERO fallback lines", () => {
    bootstrapFreshStateDir({ home }, STAMP);

    process.env.CORTEX_XDG_STRICT = "1";
    let pid = "";
    let logs = "";
    const stderr = captureStderr(() => {
      pid = resolvePidStateDir(home);
      logs = resolveLogsDir(home);
    });

    expect(pid).toBe(cortexStateDir(home));
    expect(logs).toBe(canonicalLogsDir(home));
    expect(stderr).not.toContain("xdg-fallback:");
  });

  test("fresh state: writes nothing under any legacy tree (canonical only)", () => {
    bootstrapFreshStateDir({ home }, STAMP);
    expect(existsSync(legacyPidStateDir(home))).toBe(false);
    expect(existsSync(legacyGroveLogsDir(home))).toBe(false);
    expect(existsSync(legacyCortexLogsDir(home))).toBe(false);
    expect(existsSync(legacyNetworkCacheDir(home))).toBe(false);
  });

  test("fresh state: idempotent — a second run is already-complete, marker untouched", () => {
    const first = bootstrapFreshStateDir({ home }, STAMP);
    expect(first.outcome).toBe("bootstrapped");
    const before = readFileSync(markerPath(home), "utf8");

    const second = bootstrapFreshStateDir({ home }, "2026-09-09T00:00:00.000Z");
    expect(second.outcome).toBe("already-complete");
    // The marker was NOT rewritten (original stamp preserved).
    expect(readFileSync(markerPath(home), "utf8")).toBe(before);
  });
});

describe("fresh state — upgrade box is left untouched (cortex#2030 AC2)", () => {
  test("fresh state: legacy grove state present → no marker, resolver stays legacy", () => {
    // Simulate an upgrade box: a legacy grove state tree with a pidfile.
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    writeFileSync(join(legacyPidStateDir(home), "cortex.pid"), "4242\n");

    const res = bootstrapFreshStateDir({ home }, STAMP);

    expect(res.outcome).toBe("legacy-present");
    expect(existsSync(markerPath(home))).toBe(false);
    expect(stateMigrationCompleted(home)).toBe(false);
    // Pre-migration the resolver returns the legacy default, byte-identical.
    expect(resolvePidStateDir(home)).toBe(legacyPidStateDir(home));
  });

  test("fresh state: canonical state root is NOT created on an upgrade box", () => {
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    const res = bootstrapFreshStateDir({ home }, STAMP);
    expect(res.outcome).toBe("legacy-present");
    expect(existsSync(cortexStateDir(home))).toBe(false);
  });
});

describe("fresh state — occupancy belt refuses a live pidfile (cortex#2030 / #1932)", () => {
  test("fresh state: a LIVE pidfile in the canonical state dir → refuses, no marker", () => {
    // The 5 predicate paths are ALL absent (genuinely "fresh" by the predicate),
    // but a canonical-side pidfile — invisible to the legacy-path predicate — is
    // live. The occupancy belt must still block the marker.
    expect(legacyStateTreePresent(home)).toBe(false);
    mkdirSync(canonicalPidStateDir(home), { recursive: true });
    writeFileSync(join(canonicalPidStateDir(home), "cortex.pid"), "4242\n");
    const aliveFor4242 = (pid: number) => pid === 4242;

    const res = bootstrapFreshStateDir({ home }, STAMP, aliveFor4242);

    expect(res.outcome).toBe("occupied");
    expect(res.occupancy?.occupied).toBe(true);
    expect(res.occupancy?.refused.some((r) => r.reason === "live")).toBe(true);
    expect(existsSync(markerPath(home))).toBe(false);
    expect(stateMigrationCompleted(home)).toBe(false);
  });

  test("fresh state: an UNCLASSIFIABLE pidfile (unparseable) → refuses, no marker", () => {
    mkdirSync(canonicalPidStateDir(home), { recursive: true });
    writeFileSync(join(canonicalPidStateDir(home), "relay.pid"), "not-a-pid\n");
    const neverAlive = () => false;

    const res = bootstrapFreshStateDir({ home }, STAMP, neverAlive);

    expect(res.outcome).toBe("occupied");
    expect(res.occupancy?.refused.some((r) => r.reason === "unparseable")).toBe(true);
    expect(existsSync(markerPath(home))).toBe(false);
  });

  test("fresh state: a DEAD pidfile does not block the bootstrap", () => {
    mkdirSync(canonicalPidStateDir(home), { recursive: true });
    writeFileSync(join(canonicalPidStateDir(home), "cortex.pid"), "4242\n");
    const neverAlive = () => false;

    const res = bootstrapFreshStateDir({ home }, STAMP, neverAlive);

    expect(res.outcome).toBe("bootstrapped");
    expect(existsSync(markerPath(home))).toBe(true);
  });
});

describe("fresh state — legacyStateTreePresent discriminator (cortex#2030)", () => {
  test("fresh state: false on a genuinely empty scratch home", () => {
    expect(legacyStateTreePresent(home)).toBe(false);
  });

  for (const [label, make] of [
    ["grove state dir", (h: string) => mkdirSync(legacyPidStateDir(h), { recursive: true })],
    ["grove logs dir", (h: string) => mkdirSync(legacyGroveLogsDir(h), { recursive: true })],
    ["cortex logs dir", (h: string) => mkdirSync(legacyCortexLogsDir(h), { recursive: true })],
    ["network-cache dir", (h: string) => mkdirSync(legacyNetworkCacheDir(h), { recursive: true })],
    [
      "relay.pid file",
      (h: string) => {
        mkdirSync(legacyRelayDir(h), { recursive: true });
        writeFileSync(join(legacyRelayDir(h), "relay.pid"), "7\n");
      },
    ],
  ] as const) {
    test(`fresh state: true when a legacy ${label} is present`, () => {
      make(home);
      expect(legacyStateTreePresent(home)).toBe(true);
    });
  }

  test("fresh state: a BARE relay dir (config-class, no pidfile) is NOT a state signal", () => {
    // postinstall creates ~/.claude/relay for the relay POLICY on every install;
    // the dir alone must not be read as legacy state — only relay.pid is.
    mkdirSync(legacyRelayDir(home), { recursive: true });
    expect(legacyStateTreePresent(home)).toBe(false);
  });
});
