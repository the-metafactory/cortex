import { writeFileSync } from "node:fs";
import { resolveBaseRef } from "./lib/git";
import { type Baseline, baseRefBaseline, compare, grownFiles, inflatedAgainst, readBaseline, sortedCounts, total } from "./lib/ratchet";

export const BASELINE = "scripts/unused-exports-baseline.json";

interface Named {
  name: string;
}
export interface KnipIssue {
  file: string;
  exports: Named[];
  types: Named[];
}

export function unusedPerFile(issues: KnipIssue[]): Baseline {
  const counts: Baseline = {};
  for (const { file, exports, types } of issues) {
    const n = exports.length + types.length;
    if (n > 0) counts[file] = n;
  }
  return sortedCounts(counts);
}

function scan(): KnipIssue[] {
  const run = Bun.spawnSync(["bunx", "knip", "--include", "exports,types", "--reporter", "json", "--no-progress", "--no-exit-code"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`knip failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
  return (JSON.parse(run.stdout.toString()) as { issues: KnipIssue[] }).issues;
}

function namesIn(issues: KnipIssue[], files: Set<string>): string[] {
  return issues
    .filter(({ file }) => files.has(file))
    .flatMap(({ file, exports, types }) => [...exports, ...types].map(({ name }) => `  ${file}: ${name}`));
}

if (import.meta.main) {
  const issues = scan();
  const current = unusedPerFile(issues);

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`${BASELINE}: ${total(current)} unused exports across ${Object.keys(current).length} files`);
    process.exit(0);
  }

  const { grown, shrunk } = compare(readBaseline(BASELINE), current);
  const baseRef = resolveBaseRef("UNUSED_EXPORTS_BASE_REF", "check-unused-exports");
  const base = baseRefBaseline(baseRef, BASELINE);
  const inflated = base === undefined ? [] : inflatedAgainst(base, readBaseline(BASELINE));

  if (grown.length > 0) {
    console.error(
      `Unused exports: these files export more that no other module imports than ${BASELINE} allows:\n${grown.map((g) => `  ${g}`).join("\n")}\n\n` +
        `Exported with no importer:\n${namesIn(issues, grownFiles(grown)).join("\n")}\n\n` +
        "Drop the `export` keyword, or the code if nothing uses it. An export no other module needs widens the surface the next change has to respect.",
    );
  }
  if (shrunk.length > 0) {
    console.error(
      `Fewer unused exports than ${BASELINE} records. Lock the gain in: bun scripts/check-unused-exports.ts --write-baseline\n` +
        shrunk.map((s) => `  ${s}`).join("\n"),
    );
  }
  if (inflated.length > 0) {
    console.error(
      `${BASELINE} records more unused exports than ${baseRef} does. Remove the exports instead of raising the baseline:\n` +
        inflated.map((line) => `  ${line}`).join("\n"),
    );
  }
  process.exit(grown.length > 0 || shrunk.length > 0 || inflated.length > 0 ? 1 : 0);
}
