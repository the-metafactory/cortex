import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBaseRef } from "./lib/git";
import { type Baseline, baseRefBaseline, compare, grownFiles, inflatedAgainst, readBaseline, sortedCounts, total } from "./lib/ratchet";

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
  const current = clonesPerFile(clones);

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`${BASELINE}: ${total(current)} clone sides across ${Object.keys(current).length} files`);
    process.exit(0);
  }

  const { grown, shrunk } = compare(readBaseline(BASELINE), current);
  const baseRef = resolveBaseRef("DUPLICATION_BASE_REF", "check-duplication");
  const base = baseRefBaseline(baseRef, BASELINE);
  const inflated = base === undefined ? [] : inflatedAgainst(base, readBaseline(BASELINE));

  if (grown.length > 0) {
    const files = grownFiles(grown);
    console.error(
      `Copied code: these files gained duplicated blocks against ${BASELINE}:\n${grown.map((g) => `  ${g}`).join("\n")}\n\n` +
        `The clones:\n${clonesTouching(clones, files).join("\n")}\n\n` +
        "Move the shared code to one module (a helper, a constant, a field on the owning type) and import it. " +
        "Two copies drift: one gets fixed, the other does not.",
    );
  }
  if (shrunk.length > 0) {
    console.error(
      `Fewer clones than ${BASELINE} records. Lock the gain in: bun scripts/check-duplication.ts --write-baseline\n` +
        shrunk.map((s) => `  ${s}`).join("\n"),
    );
  }
  if (inflated.length > 0) {
    console.error(
      `${BASELINE} records more clones than ${baseRef} does. Remove the copies instead of raising the baseline:\n` +
        inflated.map((line) => `  ${line}`).join("\n"),
    );
  }
  process.exit(grown.length > 0 || shrunk.length > 0 || inflated.length > 0 ? 1 : 0);
}
