import { readFileSync, writeFileSync } from "node:fs";
import { gitShow, resolveBaseRef } from "./git";

/** Per-file counts a ratchet gate records: a file may not go up, and the baseline may not grow past base's. */
export type Baseline = Record<string, number>;

interface Comparison {
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

export function sortedCounts(counts: Baseline): Baseline {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function grownFiles(grown: string[]): Set<string> {
  return new Set(grown.map((line) => line.slice(0, line.lastIndexOf(":"))));
}

function readBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

function baseRefBaseline(baseRef: string, path: string): Baseline | undefined {
  const text = gitShow(baseRef, path);
  return text === undefined ? undefined : (JSON.parse(text) as Baseline);
}

/** One ratchet gate: its baseline file, the script that rewrites it, what it counts and how to fix a file that grew. */
export interface RatchetGate {
  baseline: string;
  script: string;
  baseRefEnv: string;
  unit: string;
  grownReport: (grown: string[]) => string;
  inflatedHint: string;
}

/** Runs a ratchet gate against `current` (or rewrites its baseline with `--write-baseline`) and returns the exit code. */
export function runRatchet(gate: RatchetGate, current: Baseline, argv: readonly string[]): number {
  if (argv.includes("--write-baseline")) {
    writeFileSync(gate.baseline, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`${gate.baseline}: ${total(current)} ${gate.unit} across ${Object.keys(current).length} files`);
    return 0;
  }
  const recorded = readBaseline(gate.baseline);
  const { grown, shrunk } = compare(recorded, current);
  const baseRef = resolveBaseRef(gate.baseRefEnv, gate.script);
  const base = baseRefBaseline(baseRef, gate.baseline);
  const inflated = base === undefined ? [] : inflatedAgainst(base, recorded);
  if (grown.length > 0) console.error(gate.grownReport(grown));
  if (shrunk.length > 0) {
    console.error(`Fewer ${gate.unit} than ${gate.baseline} records. Lock the gain in: bun scripts/${gate.script}.ts --write-baseline\n${shrunk.map((s) => `  ${s}`).join("\n")}`);
  }
  if (inflated.length > 0) {
    console.error(`${gate.baseline} records more ${gate.unit} than ${baseRef} does. ${gate.inflatedHint}\n${inflated.map((line) => `  ${line}`).join("\n")}`);
  }
  return grown.length > 0 || shrunk.length > 0 || inflated.length > 0 ? 1 : 0;
}
