import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitShow, resolveBaseRef } from "./lib/git";

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
export type Baseline = Record<string, number>;

export function clonesPerFile(clones: Clone[]): Baseline {
  const counts: Baseline = {};
  for (const { firstFile, secondFile } of clones) {
    for (const name of new Set([firstFile.name, secondFile.name])) counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export interface Comparison {
  grown: string[];
  shrunk: string[];
}

export function compare(baseline: Baseline, current: Baseline): Comparison {
  const grown: string[] = [];
  const shrunk: string[] = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[file] ?? 0;
    const now = current[file] ?? 0;
    if (now > before) grown.push(`${file}: ${before} -> ${now}`);
    else if (now < before) shrunk.push(`${file}: ${before} -> ${now}`);
  }
  return { grown, shrunk };
}

export function total(baseline: Baseline): number {
  return Object.values(baseline).reduce((sum, n) => sum + n, 0);
}

/** Baseline entries raised above base: a file base already lists may not go up, and the total may not either. */
export function inflatedAgainst(base: Baseline, head: Baseline): string[] {
  const raised = Object.entries(head)
    .filter(([file, n]) => base[file] !== undefined && n > base[file])
    .map(([file, n]) => `${file}: ${String(base[file])} -> ${n}`);
  if (total(head) > total(base)) raised.push(`total: ${total(base)} -> ${total(head)}`);
  return raised;
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

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
}

function baseRefBaseline(baseRef: string): Baseline | undefined {
  const text = gitShow(baseRef, BASELINE);
  return text === undefined ? undefined : (JSON.parse(text) as Baseline);
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

  const { grown, shrunk } = compare(readBaseline(), current);
  const baseRef = resolveBaseRef("DUPLICATION_BASE_REF", "check-duplication");
  const base = baseRefBaseline(baseRef);
  const inflated = base === undefined ? [] : inflatedAgainst(base, readBaseline());

  if (grown.length > 0) {
    const files = new Set(grown.map((line) => line.slice(0, line.lastIndexOf(":"))));
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
