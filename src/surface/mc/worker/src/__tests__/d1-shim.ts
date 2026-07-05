/**
 * Shared D1 test shim — extracted from the duplicated copies in
 * `state-session-tree.test.ts` and `dashboard-snapshot-contract.test.ts`
 * (S6, #1520 review round 1).
 *
 * A minimal D1Database shim over bun:sqlite. Implements only the surface
 * the worker's D1 read/write paths use: prepare → bind → {first,all,run}.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKER_DIR = join(import.meta.dir, "..", "..");

export function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt: any = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async first() {
          // bun:sqlite's `.get()` returns `undefined` on no match; real D1
          // returns `null`. Coerce so callers checking `if (!row) ...`
          // (e.g. `getLatestAccountUsage`) see the same falsy-but-typed
          // value the production binding would give them.
          return db.query(sql).get(...(stmt._args as never[])) ?? null;
        },
        async all() {
          return { results: db.query(sql).all(...(stmt._args as never[])) };
        },
        async run() {
          const res = db.query(sql).run(...(stmt._args as never[]));
          return { meta: { changes: res.changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

export function loadSchema(db: Database): void {
  db.exec(readFileSync(join(WORKER_DIR, "schema.sql"), "utf8"));
}
