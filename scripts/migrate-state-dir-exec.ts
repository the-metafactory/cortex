#!/usr/bin/env bun
/**
 * XDG wave-5 (cortex#2030) — fresh-install STATE bootstrap, execution entry.
 *
 * Thin CLI wrapper around {@link bootstrapFreshStateDir} in
 * `src/common/migrate-state-dir.ts` so the postinstall shell script can establish
 * the canonical state tree + the state-migration completion marker on a GENUINELY
 * FRESH box without duplicating the marker-writer logic in bash.
 *
 * Behaviour (fresh-vs-upgrade decision lives in the TS, never in bash):
 *   - FRESH box (no legacy `~/.config/{grove,cortex}` state tree, no `relay.pid`,
 *     no prior marker) → create `~/.local/state/metafactory/cortex/` (+ `logs/`)
 *     and write the completion marker so the completion-gated resolvers flip
 *     canonical everywhere (a `CORTEX_XDG_STRICT=1` boot then emits zero fallback
 *     lines). The marker is written by the migrator's OWN writer over an empty
 *     plan — NOT a second hand-rolled writer.
 *   - UPGRADE box (legacy state present) → write NOTHING; the gated migration
 *     (cortex#1903) owns that cutover. No marker (AC2).
 *   - Already-complete → idempotent no-op.
 *
 * Isolation: reads `$HOME` only through the bootstrap's injectable seam — a
 * scratch `$HOME` fully sandboxes it, so tests never touch a real home. Prints a
 * one-line summary; exits non-zero only if the (empty-plan) write throws.
 */
import { bootstrapFreshStateDir } from "../src/common/migrate-state-dir";

// `new Date()` is fine here (a real bun process, not a workflow sandbox); the
// timestamp is recorded in the completion journal for audit.
const stampedAt = new Date().toISOString();
const res = bootstrapFreshStateDir({}, stampedAt);

switch (res.outcome) {
  case "bootstrapped":
    console.log(
      `  ✓ fresh-install state bootstrap: canonical state tree + logs/ + completion marker → ${res.canonical}`,
    );
    break;
  case "already-complete":
    console.log(
      `  ⊘ state already canonical (completion marker present) → ${res.canonical}`,
    );
    break;
  case "legacy-present":
    console.log(
      "  ⊘ legacy state present (upgrade box) — leaving state untouched; the gated migration owns the cutover",
    );
    break;
}
