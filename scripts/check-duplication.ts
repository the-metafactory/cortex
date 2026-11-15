import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Baseline, grownFiles, type RatchetGate, runRatchet, sortedCounts } from "./lib/ratchet";

export const BASELINE = "scripts/duplication-baseline.json";
const SCAN_ROOTS = ["src", "scripts"];
const IGNORE = ["**/node_modules/**", "**/generated/**", "**/vendor/**", "**/dist/**"];

interface CloneSide {
  name: string;
  start: number;
  end: number;
}
export interface Clone {
  firstFile: CloneSide;
  secondFile: CloneSide;
}
export function clonesPerFile(clones: Clone[]): Baseline {
  const counts: Baseline = {};
  for (const { firstFile, secondFile } of clones) {
    for (const name of new Set([firstFile.name, secondFile.name])) counts[name] = (counts[name] ?? 0) + 1;
  }
  return sortedCounts(counts);
}

function scan(): Clone[] {
  const out = mkdtempSync(join(tmpdir(), "cortex-jscpd-"));
  const run = Bun.spawnSync(
    ["bunx", "jscpd", "--silent", "--format", "typescript", "--reporters", "json", "--output", out, "--ignore", IGNORE.join(","), ...SCAN_ROOTS],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    if (run.exitCode !== 0) throw new Error(`jscpd failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
    return (JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")) as { duplicates: Clone[] }).duplicates;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function clonesTouching(clones: Clone[], files: Set<string>): string[] {
  return clones
    .filter(({ firstFile, secondFile }) => files.has(firstFile.name) || files.has(secondFile.name))
    .map(({ firstFile: a, secondFile: b }) => `  ${a.name}:${a.start}-${a.end}  ==  ${b.name}:${b.start}-${b.end}`);
}

if (import.meta.main) {
  const clones = scan();
  const gate: RatchetGate = {
    baseline: BASELINE,
    script: "check-duplication",
    baseRefEnv: "DUPLICATION_BASE_REF",
    unit: "clone sides",
    grownReport: (grown) =>
      `Copied code: these files gained duplicated blocks against ${BASELINE}:\n${grown.map((g) => `  ${g}`).join("\n")}\n\n` +
      `The clones:\n${clonesTouching(clones, grownFiles(grown)).join("\n")}\n\n` +
      "Move the shared code to one module (a helper, a constant, a field on the owning type) and import it. " +
      "Two copies drift: one gets fixed, the other does not.",
    inflatedHint: "Remove the copies instead of raising the baseline:",
  };
  process.exit(runRatchet(gate, clonesPerFile(clones), process.argv));
}
