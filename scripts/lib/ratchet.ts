import { readFileSync } from "node:fs";
import { gitShow } from "./git";

/** Per-file counts a ratchet gate records: a file may not go up, and the baseline may not grow past base's. */
export type Baseline = Record<string, number>;

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

export function sortedCounts(counts: Baseline): Baseline {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function grownFiles(grown: string[]): Set<string> {
  return new Set(grown.map((line) => line.slice(0, line.lastIndexOf(":"))));
}

export function readBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function baseRefBaseline(baseRef: string, path: string): Baseline | undefined {
  const text = gitShow(baseRef, path);
  return text === undefined ? undefined : (JSON.parse(text) as Baseline);
}
