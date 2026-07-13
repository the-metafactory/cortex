/**
 * XDG wave-5 (cortex#1902) AC4 — DATA migration-on-touch tests.
 *
 * Hermetic scratch `$HOME`; `CORTEX_DATA_DIR` unset per test. Proves the
 * copy-keep-source contract: the legacy db is carried to the canonical
 * metafactory tree, the SOURCE is intact after the move, sidecars travel with
 * it, canonical-wins (never clobber), and a re-run is idempotent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  carryDbSidecars,
  migrateDbOnTouch,
  migratePublishedBufferOnTouch,
  migrateStackDbOnTouch,
} from "../migrate-data-dir";
import {
  canonicalPublishedEventsDir,
  canonicalStackDbPath,
  legacyPublishedEventsDir,
  legacyStackDbPath,
} from "../data-path";

let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.CORTEX_DATA_DIR;
  delete process.env.CORTEX_DATA_DIR;
  home = mkdtempSync(join(tmpdir(), "xdg1902-mig-"));
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORTEX_DATA_DIR;
  else process.env.CORTEX_DATA_DIR = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

/** Create a small sqlite db with one row at `dbPath` (WAL mode by default). */
function makeDb(dbPath: string, marker: string, wal = true): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath, { create: true });
  if (wal) db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.run("INSERT INTO t (v) VALUES (?)", [marker]);
  db.close();
}

function readMarker(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT v FROM t LIMIT 1").get() as { v: string };
  db.close();
  return row.v;
}

/** True iff the db at `dbPath` opens and passes `PRAGMA integrity_check`. */
function integrityOk(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    db.close();
    return row?.integrity_check === "ok";
  } catch {
    return false;
  }
}

describe("migrateStackDbOnTouch — copy-keep-source", () => {
  test("carries a legacy per-stack db to the canonical metafactory tree, source kept", () => {
    const legacy = legacyStackDbPath("work", home);
    const canonical = canonicalStackDbPath("work", home);
    makeDb(legacy, "legacy-data");

    const resolved = migrateStackDbOnTouch("work", home);

    expect(resolved).toBe(canonical);
    expect(existsSync(canonical)).toBe(true);
    // SOURCE intact — never renamed or removed.
    expect(existsSync(legacy)).toBe(true);
    // Content carried faithfully.
    expect(readMarker(canonical)).toBe("legacy-data");
    expect(readMarker(legacy)).toBe("legacy-data");
  });

  test("idempotent — a second run is a no-op and does not clobber the canonical copy", () => {
    const legacy = legacyStackDbPath("work", home);
    const canonical = canonicalStackDbPath("work", home);
    makeDb(legacy, "v1");
    migrateStackDbOnTouch("work", home);

    // Mutate the canonical copy; then mutate the legacy source differently.
    const c = new Database(canonical);
    c.run("UPDATE t SET v = 'canonical-edited'");
    c.close();

    const resolved = migrateStackDbOnTouch("work", home); // re-run
    expect(resolved).toBe(canonical);
    // Canonical-wins: the re-run never overwrote the canonical copy from legacy.
    expect(readMarker(canonical)).toBe("canonical-edited");
  });

  test("nothing to carry — a fresh stack resolves to the canonical write target", () => {
    const resolved = migrateStackDbOnTouch("fresh", home);
    expect(resolved).toBe(canonicalStackDbPath("fresh", home));
    expect(existsSync(resolved)).toBe(false); // not created — just the path
  });
});

describe("migrateDbOnTouch — WAL safety", () => {
  test("checkpoints before copy so the canonical db is a VALID, self-consistent copy carrying the data", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    // A WAL-mode db with committed data. migrateDbOnTouch runs
    // wal_checkpoint(TRUNCATE) on the source first, folding any -wal frames into
    // the main .db file, THEN copies it — so no committed transaction is lost.
    // The invariant that MATTERS (platform-independent): after migration the
    // canonical db opens, reads the committed row, and passes integrity_check.
    // A checkpointed db needs NO -wal to be valid, so we assert validity — not
    // the presence of a sidecar SQLite may legitimately unlink on open (the old
    // Linux-non-deterministic assertion this replaces).
    makeDb(legacy, "committed-in-wal");

    const res = migrateDbOnTouch(canonical, legacy);
    expect(res.migrated).toBe(true);
    // The canonical copy is a consistent, readable db carrying the data.
    expect(readMarker(canonical)).toBe("committed-in-wal");
    expect(integrityOk(canonical)).toBe(true);
    // Source db intact (never renamed/removed) and still valid.
    expect(readMarker(legacy)).toBe("committed-in-wal");
    expect(integrityOk(legacy)).toBe(true);
  });

  test("carryDbSidecars carries real -wal / -shm files WITH the db (deterministic — no db-open)", () => {
    // Exercise the sidecar-copy LAYER directly with genuine sidecar files
    // present and NO intervening db-open/checkpoint. This is deterministic on
    // every platform: a db-open would let SQLite unlink a stray -wal for a
    // rollback-journal db (the Linux flake the old in-migrator assertion hit).
    // The real invariant: given sidecars on disk at copy time, they travel.
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    mkdirSync(join(legacy, ".."), { recursive: true });
    mkdirSync(join(canonical, ".."), { recursive: true });
    writeFileSync(legacy, "main-db-bytes");
    writeFileSync(`${legacy}-wal`, "wal-bytes"); // un-folded committed frames
    writeFileSync(`${legacy}-shm`, "shm-bytes");

    const carried = carryDbSidecars(canonical, legacy);
    expect(carried).toBe(2);
    expect(readFileSync(`${canonical}-wal`, "utf-8")).toBe("wal-bytes");
    expect(readFileSync(`${canonical}-shm`, "utf-8")).toBe("shm-bytes");
    // Source sidecars intact (copy-keep-source).
    expect(existsSync(`${legacy}-wal`)).toBe(true);
    expect(existsSync(`${legacy}-shm`)).toBe(true);
  });

  test("carryDbSidecars is a no-op (returns 0, never throws) when no sidecar exists", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    mkdirSync(join(canonical, ".."), { recursive: true });
    expect(carryDbSidecars(canonical, legacy)).toBe(0);
    expect(existsSync(`${canonical}-wal`)).toBe(false);
  });

  test("torn-copy hardening — a corrupt canonical is detected, removed, and re-copied on the next run (GAP-4)", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    // A source file that is NOT a valid SQLite db → the faithful copy yields a
    // canonical that FAILS integrity_check. Because idempotence gates on
    // existsSync(canonical), a torn copy would otherwise be preferred forever.
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, "this is not a sqlite database at all");

    const res1 = migrateDbOnTouch(canonical, legacy);
    // Detected corrupt → removed (source KEPT), reported not-migrated so the
    // next run retries rather than sticking to garbage.
    expect(res1.migrated).toBe(false);
    expect(existsSync(canonical)).toBe(false);
    expect(existsSync(legacy)).toBe(true); // source never removed

    // The source becomes a valid db (e.g. it was mid-write before) — the next
    // run re-copies and now lands a valid canonical.
    rmSync(legacy);
    makeDb(legacy, "recovered");
    const res2 = migrateDbOnTouch(canonical, legacy);
    expect(res2.migrated).toBe(true);
    expect(integrityOk(canonical)).toBe(true);
    expect(readMarker(canonical)).toBe("recovered");
  });

  test("canonical-wins — an existing canonical db is never overwritten", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    makeDb(legacy, "legacy");
    makeDb(canonical, "canonical");

    const res = migrateDbOnTouch(canonical, legacy);
    expect(res.migrated).toBe(false);
    expect(readMarker(canonical)).toBe("canonical");
  });
});

describe("migratePublishedBufferOnTouch — guardrail A (carry in-flight events)", () => {
  test("carries a published-but-not-yet-consumed event to the canonical dir, source kept", () => {
    const legacy = legacyPublishedEventsDir(home); // ~/.claude/events/published
    const canonical = canonicalPublishedEventsDir(home);
    mkdirSync(legacy, { recursive: true });
    const event = '{"id":"evt-1","type":"prompt"}\n';
    writeFileSync(join(legacy, "2026-07-13.jsonl"), event);

    const res = migratePublishedBufferOnTouch(home);
    expect(res.dir).toBe(canonical);
    expect(res.carried).toBe(1);
    // The in-flight event is readable from the canonical dir the consumer reads.
    expect(readFileSync(join(canonical, "2026-07-13.jsonl"), "utf-8")).toBe(event);
    // Source kept — never moved out from under the writer.
    expect(existsSync(join(legacy, "2026-07-13.jsonl"))).toBe(true);
  });

  test("idempotent — a second run carries nothing and never clobbers a carried file", () => {
    const legacy = legacyPublishedEventsDir(home);
    const canonical = canonicalPublishedEventsDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "a.jsonl"), "v1\n");
    migratePublishedBufferOnTouch(home);

    // A consumer/relay appended to the canonical copy after the first carry.
    writeFileSync(join(canonical, "a.jsonl"), "v1\nv2-canonical\n");
    const res = migratePublishedBufferOnTouch(home); // re-run
    expect(res.carried).toBe(0); // canonical-wins — nothing re-copied
    expect(readFileSync(join(canonical, "a.jsonl"), "utf-8")).toBe("v1\nv2-canonical\n");
  });

  test("no legacy buffer ⇒ no-op (fresh install)", () => {
    const res = migratePublishedBufferOnTouch(home);
    expect(res.carried).toBe(0);
    expect(res.dir).toBe(canonicalPublishedEventsDir(home));
  });
});

// NOTE: the `migrateCursorOnTouch` (G-25) tests were removed with the migrator
// itself (#1902 GAP-2). The grove standalone hook cursor is read ONLY by the
// retired-for-production standalone MC entry (`surface/mc/index.ts`, FS-8a #1822);
// the production EMBEDDED MC keeps its cursor beside its per-stack db and never
// touches the grove cursor. A copy-forward migrator for a path nothing writes in
// production is dead code — see the rationale block in `migrate-data-dir.ts`.
