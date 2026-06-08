/**
 * C-787 — migration 0003 (per-stack pubkey backfill).
 *
 * The migration is HOLD-aware: it will NOT be applied to prod in this task
 * (the prod registry deploy is held). These tests pin that applying it LATER to
 * the live registry is SAFE — it backfills the per-stack key from the root,
 * preserves any already-present key, no-ops on empty stacks, and is idempotent
 * — so `andreas/meta-factory` keeps verifying and the metafactory federation
 * does not regress.
 *
 * Runs the real SQL against `bun:sqlite` (D1 is SQLite under the hood; the JSON1
 * functions used — json_each / json_group_array / json_patch / json_object /
 * json_extract — are the same surface D1 exposes).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const ROOT = "ROOTpubkey00000000000000000000000000000000=";
const JC_ROOT = "OTHERpubkey0000000000000000000000000000000=";
const JC_STACK = "STACKpubkey0000000000000000000000000000000=";

let db: Database;

function seed(
  id: string,
  pubkey: string,
  stacks: { stack_id: string; stack_pubkey?: string; display_name?: string }[],
): void {
  db.run(
    `INSERT INTO principals (principal_id, principal_pubkey, stacks, capabilities, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, pubkey, JSON.stringify(stacks), "[]", "2026-01-01T00:00:00Z"],
  );
}

function stacksOf(id: string): { stack_id: string; stack_pubkey?: string; display_name?: string }[] {
  const row = db
    .query("SELECT stacks FROM principals WHERE principal_id = ?")
    .get(id) as { stacks: string };
  return JSON.parse(row.stacks) as { stack_id: string; stack_pubkey?: string; display_name?: string }[];
}

function applyMigration(): void {
  db.run(readFileSync(join(migrationsDir, "0003_per_stack_pubkeys.sql"), "utf8"));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(readFileSync(join(migrationsDir, "0001_init.sql"), "utf8"));
});

describe("migration 0003 — backfill", () => {
  test("a pre-C-787 single-stack principal gets stack_pubkey = the old principal_pubkey", () => {
    seed("andreas", ROOT, [{ stack_id: "andreas/meta-factory", display_name: "MF" }]);
    applyMigration();
    const [s] = stacksOf("andreas");
    expect(s!.stack_pubkey).toBe(ROOT);
    // Other fields are preserved.
    expect(s!.stack_id).toBe("andreas/meta-factory");
    expect(s!.display_name).toBe("MF");
  });

  test("a stack that ALREADY has a stack_pubkey is left untouched (no clobber)", () => {
    seed("jc", JC_ROOT, [{ stack_id: "jc/laptop", stack_pubkey: JC_STACK }]);
    applyMigration();
    expect(stacksOf("jc")).toEqual([{ stack_id: "jc/laptop", stack_pubkey: JC_STACK }]);
  });

  test("an empty stacks array stays empty", () => {
    seed("empty", "EMPTYpubkey0000000000000000000000000000000=", []);
    applyMigration();
    expect(stacksOf("empty")).toEqual([]);
  });

  test("idempotent — re-applying changes nothing", () => {
    seed("andreas", ROOT, [{ stack_id: "andreas/meta-factory" }]);
    applyMigration();
    const after1 = stacksOf("andreas");
    applyMigration();
    const after2 = stacksOf("andreas");
    expect(after2).toEqual(after1);
    expect(after2[0]!.stack_pubkey).toBe(ROOT);
  });

  test("a principal with a mix of keyed + unkeyed stacks backfills only the unkeyed", () => {
    seed("multi", ROOT, [
      { stack_id: "multi/a", stack_pubkey: JC_STACK },
      { stack_id: "multi/b" },
    ]);
    applyMigration();
    const byId = new Map(stacksOf("multi").map((s) => [s.stack_id, s.stack_pubkey]));
    expect(byId.get("multi/a")).toBe(JC_STACK); // kept
    expect(byId.get("multi/b")).toBe(ROOT); // backfilled from root
  });
});
