#!/usr/bin/env bun
/**
 * XDG wave-4 (cortex#1869) — config-dir move, execution entry.
 *
 * Thin CLI wrapper around the tested migrator in
 * `src/common/config/migrate-config-dir.ts` so the shell RESTART-op driver
 * (`scripts/migrate-config-dir.sh`) can perform the COPY step without
 * duplicating the merge-policy / atomic-write / journal logic in bash.
 *
 * Behaviour: plan the union of the two legacy trees (cortex-wins-on-dup, carry
 * grove-only, exclude state/data subtrees), then COPY each carried file into the
 * canonical `~/.config/metafactory/cortex` (or `$CORTEX_CONFIG_DIR`) atomically,
 * keeping every legacy source for rollback, and drop the journal. Idempotent:
 * re-running skips files already present canonical-side.
 *
 * Isolation: reads `$HOME` (or `$CORTEX_CONFIG_DIR`) only through the migrator's
 * injectable seam — a scratch `$HOME` fully sandboxes it, so tests never touch a
 * real home. Prints a one-line summary; exits non-zero if the copy throws.
 *
 * `--plan-only` prints the plan (counts) WITHOUT writing anything — a dry-run
 * the principal can inspect before the real cutover.
 */
import {
  executeConfigDirMigration,
  planConfigDirMigration,
} from "../src/common/config/migrate-config-dir";

const planOnly = process.argv.includes("--plan-only");
const plan = planConfigDirMigration();

const groveOnly = plan.moves.filter((m) => m.fromTree === "grove").length;
const shadowed = plan.moves.filter((m) => m.shadowedGrove !== undefined).length;

if (planOnly) {
  console.log(
    `  ▸ config-dir migration PLAN: ${plan.moves.length} file(s) to carry ` +
      `(${groveOnly} grove-only, ${shadowed} cortex-wins-on-dup), ` +
      `${plan.excluded.length} state/data path(s) excluded → ${plan.canonical}`,
  );
  process.exit(0);
}

// `new Date()` is fine here (this is a real bun process, not a workflow sandbox);
// the timestamp is recorded in the journal for audit.
const stampedAt = new Date().toISOString();
const journal = executeConfigDirMigration(plan, stampedAt);

const applied = journal.moves.filter((m) => m.applied).length;
const skipped = journal.moves.filter((m) => m.skippedExisting).length;
const carriedGrove = journal.moves.filter(
  (m) => m.fromTree === "grove" && m.applied,
).length;

console.log(
  `  ✓ config-dir migration: ${applied} carried ` +
    `(${carriedGrove} grove-only), ${skipped} already present, ` +
    `${journal.excluded.length} state/data path(s) excluded → ${journal.canonical}`,
);
