import { type Baseline, grownFiles, type RatchetGate, runRatchet, sortedCounts } from "./lib/ratchet";

const BASELINE = "scripts/unused-exports-baseline.json";

interface Named {
  name: string;
}
interface KnipIssue {
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
  const gate: RatchetGate = {
    baseline: BASELINE,
    script: "check-unused-exports",
    baseRefEnv: "UNUSED_EXPORTS_BASE_REF",
    unit: "unused exports",
    grownReport: (grown) =>
      `Unused exports: these files export more that no other module imports than ${BASELINE} allows:\n${grown.map((g) => `  ${g}`).join("\n")}\n\n` +
      `Exported with no importer:\n${namesIn(issues, grownFiles(grown)).join("\n")}\n\n` +
      "Drop the `export` keyword, or the code if nothing uses it. An export no other module needs widens the surface the next change has to respect.",
    inflatedHint: "Remove the exports instead of raising the baseline:",
  };
  process.exit(runRatchet(gate, unusedPerFile(issues), process.argv));
}
