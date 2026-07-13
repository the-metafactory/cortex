/**
 * XDG wave-4 (cortex#1869) — config DIRECTORY migrator tests.
 *
 * EVERY test runs against a scratch `$HOME` created under `os.tmpdir()`. The
 * migrator is only ever handed that scratch home; a leak-guard test asserts NO
 * path in a plan/journal escapes it, so the suite can never touch the real
 * `~/.config/{cortex,grove}` or the live daemon.
 *
 * Proves: grove-only carried · cortex-wins-on-dup · .bak + personas carried ·
 * state/data subtrees excluded · atomic-write + journal · rollback restores ·
 * source kept (never renamed) · secret mode preserved · zero real-home touch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EXCLUDED_TOP_DIRS,
  MIGRATION_JOURNAL_NAME,
  atomicWriteFile,
  executeConfigDirMigration,
  loadMigrationJournal,
  planConfigDirMigration,
  rollbackConfigDirMigration,
} from "../migrate-config-dir";

let home: string;
let savedConfigDirEnv: string | undefined;

const canonicalDir = () => join(home, ".config", "metafactory", "cortex");
const legacyCortexDir = () => join(home, ".config", "cortex");
const groveDir = () => join(home, ".config", "grove");

function write(root: string, rel: string, data: string, mode = 0o644) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data, { mode });
  chmodSync(p, mode); // umask-proof the fixture
}

beforeEach(() => {
  // A stray ambient CORTEX_CONFIG_DIR would redirect cortexConfigDir() off the
  // scratch home — unset it so every path derives from `home`.
  savedConfigDirEnv = process.env.CORTEX_CONFIG_DIR;
  delete process.env.CORTEX_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "xdg1869-home-"));
});
afterEach(() => {
  if (savedConfigDirEnv === undefined) delete process.env.CORTEX_CONFIG_DIR;
  else process.env.CORTEX_CONFIG_DIR = savedConfigDirEnv;
  rmSync(home, { recursive: true, force: true });
});

describe("planConfigDirMigration — merge policy (G-42)", () => {
  test("carries grove-ONLY files (never lost)", () => {
    write(groveDir(), "bot.yaml", "grove-bot");
    write(groveDir(), "secret.token", "SEKRIT", 0o600); // grove-only secret

    const plan = planConfigDirMigration({ home });
    const rels = plan.moves.map((m) => m.relPath).sort();
    expect(rels).toContain("bot.yaml");
    expect(rels).toContain("secret.token");
    expect(plan.moves.every((m) => m.fromTree === "grove")).toBe(true);
  });

  test("cortex-wins-on-dup: same relpath carries the cortex copy, records the shadowed grove copy", () => {
    write(legacyCortexDir(), "cli.yaml", "cortex-cli");
    write(groveDir(), "cli.yaml", "grove-cli");

    const plan = planConfigDirMigration({ home });
    const cli = plan.moves.find((m) => m.relPath === "cli.yaml");
    expect(cli).toBeDefined();
    expect(cli!.fromTree).toBe("cortex");
    expect(readFileSync(cli!.src, "utf-8")).toBe("cortex-cli");
    expect(cli!.shadowedGrove).toBe(join(groveDir(), "cli.yaml"));
    // Exactly ONE move for the duplicated path — no double-carry.
    expect(plan.moves.filter((m) => m.relPath === "cli.yaml")).toHaveLength(1);
  });

  test("carries .bak sidecars and personas/ (called out by the spec)", () => {
    write(legacyCortexDir(), "cortex.yaml", "cfg");
    write(legacyCortexDir(), "cortex.yaml.bak", "cfg-prev");
    write(legacyCortexDir(), "personas/echo.md", "you are echo");
    write(groveDir(), "personas/sage.md", "you are sage"); // grove-only persona

    const plan = planConfigDirMigration({ home });
    const rels = plan.moves.map((m) => m.relPath);
    expect(rels).toContain("cortex.yaml.bak");
    expect(rels).toContain(join("personas", "echo.md"));
    expect(rels).toContain(join("personas", "sage.md"));
  });

  test("EXCLUDES state/data-class subtrees (config-only scope; #1902/#1903)", () => {
    write(legacyCortexDir(), "cortex.yaml", "cfg");
    for (const top of EXCLUDED_TOP_DIRS) {
      write(legacyCortexDir(), join(top, "keep-me"), "state-bytes");
    }
    const plan = planConfigDirMigration({ home });
    const movedTops = new Set(plan.moves.map((m) => m.relPath.split("/")[0]));
    for (const top of EXCLUDED_TOP_DIRS) expect(movedTops.has(top)).toBe(false);
    // Config file still carried; every excluded top-dir recorded.
    expect(plan.moves.some((m) => m.relPath === "cortex.yaml")).toBe(true);
    const exclTops = new Set(plan.excluded.map((e) => e.relPath));
    for (const top of EXCLUDED_TOP_DIRS) expect(exclTops.has(top)).toBe(true);
  });
});

describe("executeConfigDirMigration — atomic copy + journal, source kept", () => {
  test("carries content to the canonical tree AND keeps the source (never renamed)", () => {
    write(groveDir(), "bot.yaml", "grove-bot");
    write(legacyCortexDir(), "cli.yaml", "cortex-cli");

    const journal = executeConfigDirMigration(planConfigDirMigration({ home }), "2026-07-13T00:00:00Z");

    // Destinations exist with the right bytes.
    expect(readFileSync(join(canonicalDir(), "bot.yaml"), "utf-8")).toBe("grove-bot");
    expect(readFileSync(join(canonicalDir(), "cli.yaml"), "utf-8")).toBe("cortex-cli");
    // SOURCES are still present — copy-keep-original, never rename.
    expect(existsSync(join(groveDir(), "bot.yaml"))).toBe(true);
    expect(existsSync(join(legacyCortexDir(), "cli.yaml"))).toBe(true);
    // Journal written at the canonical root, records both moves as applied.
    expect(journal.moves.every((m) => m.applied)).toBe(true);
    const onDisk = loadMigrationJournal({ home });
    expect(onDisk?.stampedAt).toBe("2026-07-13T00:00:00Z");
    expect(onDisk?.moves).toHaveLength(2);
  });

  test("preserves a 0600 secret mode across the carry (never widened)", () => {
    write(groveDir(), "cloud-credentials.txt", "TOKEN=redacted", 0o600);
    executeConfigDirMigration(planConfigDirMigration({ home }));
    const dest = join(canonicalDir(), "cloud-credentials.txt");
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  test("canonical-wins: an existing canonical copy is NOT clobbered (idempotent skip)", () => {
    write(legacyCortexDir(), "cli.yaml", "legacy");
    write(canonicalDir(), "cli.yaml", "already-canonical");

    const journal = executeConfigDirMigration(planConfigDirMigration({ home }));

    expect(readFileSync(join(canonicalDir(), "cli.yaml"), "utf-8")).toBe("already-canonical");
    const mv = journal.moves.find((m) => m.relPath === "cli.yaml");
    expect(mv?.skippedExisting).toBe(true);
    expect(mv?.applied).toBeUndefined();
  });

  test("a second execute is idempotent (re-skips already-carried files)", () => {
    write(groveDir(), "bot.yaml", "grove-bot");
    executeConfigDirMigration(planConfigDirMigration({ home }));
    const second = executeConfigDirMigration(planConfigDirMigration({ home }));
    expect(second.moves.every((m) => m.skippedExisting)).toBe(true);
  });
});

describe("rollbackConfigDirMigration — restores the pre-move state", () => {
  test("removes the canonical copies it wrote; legacy sources remain authoritative", () => {
    write(groveDir(), "bot.yaml", "grove-bot");
    write(legacyCortexDir(), "cli.yaml", "cortex-cli");
    const journal = executeConfigDirMigration(planConfigDirMigration({ home }));
    expect(existsSync(join(canonicalDir(), "bot.yaml"))).toBe(true);

    const removed = rollbackConfigDirMigration(journal);

    expect(removed).toBe(2);
    expect(existsSync(join(canonicalDir(), "bot.yaml"))).toBe(false);
    expect(existsSync(join(canonicalDir(), "cli.yaml"))).toBe(false);
    // Legacy trees untouched — the data is fully recoverable.
    expect(readFileSync(join(groveDir(), "bot.yaml"), "utf-8")).toBe("grove-bot");
    expect(readFileSync(join(legacyCortexDir(), "cli.yaml"), "utf-8")).toBe("cortex-cli");
    // Journal file removed.
    expect(existsSync(join(canonicalDir(), MIGRATION_JOURNAL_NAME))).toBe(false);
  });

  test("rollback leaves a pre-existing canonical file (skippedExisting) alone", () => {
    write(legacyCortexDir(), "cli.yaml", "legacy");
    write(canonicalDir(), "cli.yaml", "pre-existing");
    const journal = executeConfigDirMigration(planConfigDirMigration({ home }));

    rollbackConfigDirMigration(journal);

    // The file we did NOT write must survive rollback.
    expect(readFileSync(join(canonicalDir(), "cli.yaml"), "utf-8")).toBe("pre-existing");
  });
});

describe("atomicWriteFile — temp/fsync/rename primitive", () => {
  test("writes bytes + preserves mode, leaving no temp sidecar behind", () => {
    const dest = join(canonicalDir(), "sub", "f.yaml");
    atomicWriteFile(dest, Buffer.from("payload"), 0o600);
    expect(readFileSync(dest, "utf-8")).toBe("payload");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    // No leftover *.xdgtmp.* sidecar in the destination dir.
    const leftovers = readdirSync(join(canonicalDir(), "sub")).filter((n) => n.includes(".xdgtmp."));
    expect(leftovers).toEqual([]);
  });

  test("overwrites an existing destination atomically (rename-over)", () => {
    const dest = join(canonicalDir(), "f.yaml");
    atomicWriteFile(dest, Buffer.from("v1"), 0o644);
    atomicWriteFile(dest, Buffer.from("v2"), 0o644);
    expect(readFileSync(dest, "utf-8")).toBe("v2");
  });
});

describe("hermetic — zero real-home leakage", () => {
  test("every path in a plan + journal is contained within the scratch home", () => {
    write(groveDir(), "bot.yaml", "g");
    write(legacyCortexDir(), "state/live.pid", "123"); // excluded state file
    write(legacyCortexDir(), "cli.yaml", "c");
    const journal = executeConfigDirMigration(planConfigDirMigration({ home }));

    const allPaths = [
      journal.canonical,
      journal.legacyCortex,
      journal.grove,
      ...journal.moves.flatMap((m) => [m.src, m.dest, m.shadowedGrove ?? m.dest]),
    ];
    for (const p of allPaths) {
      expect(p.startsWith(home + "/") || p === home).toBe(true);
    }
    // The real home is NEVER a prefix of any planned path.
    const realHome = process.env.HOME ?? "/nonexistent-real-home";
    for (const p of allPaths) expect(p.startsWith(join(realHome, ".config"))).toBe(false);
  });
});
