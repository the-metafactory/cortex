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
  migrateCursorOnTouch,
  migrateDbOnTouch,
  migratePublishedBufferOnTouch,
  migrateStackDbOnTouch,
} from "../migrate-data-dir";
import {
  canonicalCursorPath,
  canonicalPublishedEventsDir,
  canonicalStackDbPath,
  legacyCursorPath,
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
  test("checkpoints before copy so committed WAL data lands in the canonical db", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    // A WAL-mode db with committed data. migrateDbOnTouch runs
    // wal_checkpoint(TRUNCATE) on the source first, folding any -wal frames into
    // the main .db file, THEN copies it — so no committed transaction is lost.
    makeDb(legacy, "committed-in-wal");

    const res = migrateDbOnTouch(canonical, legacy);
    expect(res.migrated).toBe(true);
    // The canonical copy is a consistent, readable db carrying the data.
    expect(readMarker(canonical)).toBe("committed-in-wal");
    // Source db intact (never renamed/removed).
    expect(readMarker(legacy)).toBe("committed-in-wal");
  });

  test("carries any surviving -wal / -shm sidecars alongside the main db", () => {
    const legacy = join(home, "legacy", "mission-control.db");
    const canonical = join(home, "canon", "mission-control.db");
    // Rollback-journal db (wal=false): the internal checkpoint is a no-op that
    // leaves these stray sidecar files untouched, so the test isolates the
    // sidecar-CARRY behavior. (In production a real un-truncatable WAL is the
    // case these carries protect.)
    makeDb(legacy, "with-sidecars", false);
    // Sidecars present at copy time (a partial checkpoint under active readers
    // could leave un-folded frames here). They must travel WITH the db, and the
    // source copies must remain intact.
    writeFileSync(`${legacy}-wal`, "wal-bytes");
    writeFileSync(`${legacy}-shm`, "shm-bytes");

    const res = migrateDbOnTouch(canonical, legacy);
    expect(res.migrated).toBe(true);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(`${canonical}-wal`)).toBe(true);
    expect(existsSync(`${canonical}-shm`)).toBe(true);
    // Source sidecars intact (copy-keep-source).
    expect(existsSync(`${legacy}-wal`)).toBe(true);
    expect(existsSync(`${legacy}-shm`)).toBe(true);
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

describe("migrateCursorOnTouch — plain data file + guardrail B (position continuity)", () => {
  test("carries a legacy grove cursor to the canonical tree, source kept", () => {
    const legacy = join(home, ".local", "share", "grove", "mc-hook-cursor.json");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, '{"cursor":42}');

    const resolved = migrateCursorOnTouch(home);
    expect(resolved).toBe(
      join(home, ".local", "share", "metafactory", "cortex", "mc-hook-cursor.json"),
    );
    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved, "utf-8")).toBe('{"cursor":42}');
    expect(existsSync(legacy)).toBe(true); // source kept
  });

  test("guardrail B — MC resume position is PRESERVED across the move (offsets intact, no reset)", () => {
    // The cursor is Record<rawEventFilePath, byteOffset>. Its keys reference the
    // RAW buffer (`~/.claude/events/raw/…`), which does NOT move in #1902 — so
    // moving the cursor FILE (copy-keep-source) preserves the exact resume
    // position; MC neither re-ingests (dup events) nor skips.
    const legacy = legacyCursorPath(home);
    const canonical = canonicalCursorPath(home);
    const rawKey = join(home, ".claude", "events", "raw", "2026-07-13.jsonl");
    const cursor = { [rawKey]: 8192 };
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, JSON.stringify(cursor));

    migrateCursorOnTouch(home);

    const carried = JSON.parse(readFileSync(canonical, "utf-8")) as Record<string, number>;
    expect(carried[rawKey]).toBe(8192); // exact offset preserved — no reset
    // Key still references the (unmoved) raw buffer — no rewrite needed.
    expect(Object.keys(carried)).toEqual([rawKey]);
    expect(existsSync(legacy)).toBe(true); // source kept
  });
});
