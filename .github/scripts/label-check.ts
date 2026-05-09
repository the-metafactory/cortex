#!/usr/bin/env bun
/**
 * label-check.ts — Verify that a GitHub repo has all required ecosystem labels.
 *
 * Usage: bun label-check.ts <org/repo>
 *
 * Exit code 0 = all labels present, 1 = missing labels.
 *
 * Vendored from `the-metafactory/compass:engine/ci/label-check.ts` (commit
 * df944b7, 2026-05-09 v0.8.3) into cortex as part of cortex#16 fix.
 *
 * Why vendored: compass is a private repo and cortex's CI workflow had no
 * cross-repo PAT, so the original `bun ../compass/engine/ci/run-all.ts`
 * invocation failed on every PR + main run since MIG-0 bootstrap. Vendoring
 * one ~40-LOC file with zero deps mirrors the precedent set by myelin
 * envelope schema vendoring at G-1100.B (cortex#11). Update this copy when
 * compass evolves the validator surface.
 */

const REQUIRED_LABELS = [
  "bug",
  "documentation",
  "feature",
  "infrastructure",
  "now",
  "next",
  "future",
  "handover",
];

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: bun label-check.ts <org/repo>");
  process.exit(1);
}

const proc = Bun.spawnSync([
  "gh",
  "label",
  "list",
  "--repo",
  repo,
  "--json",
  "name",
  "--limit",
  "100",
]);
if (proc.exitCode !== 0) {
  console.error(`Failed to list labels for ${repo}: ${proc.stderr.toString()}`);
  process.exit(1);
}

const labels: { name: string }[] = JSON.parse(proc.stdout.toString());
const labelNames = new Set(labels.map((l) => l.name));
const missing = REQUIRED_LABELS.filter((l) => !labelNames.has(l));

if (missing.length > 0) {
  console.error(`${repo} is missing ${missing.length} required label(s):`);
  for (const l of missing) {
    console.error(`  - ${l}`);
  }
  console.error(`\nFix with: bun standards/scripts/sync-labels.ts ${repo}`);
  process.exit(1);
} else {
  console.log(
    `${repo} has all ${REQUIRED_LABELS.length} required ecosystem labels.`,
  );
  process.exit(0);
}
