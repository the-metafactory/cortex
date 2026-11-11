#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFailureScenarios, formatFailureReport } from "./lib/desk-conformance/failures";
import { guardNetwork } from "./lib/desk-conformance/network";
import { formatReport } from "./lib/desk-conformance/report";
import type { ConformanceReport } from "./lib/desk-conformance/report";
import { executePackage } from "./lib/desk-conformance/run";

export { formatReport, type CapabilityReport, type ConformanceReport } from "./lib/desk-conformance/report";
export { FAILURE_SCENARIOS, formatFailureReport, runFailureScenarios, type FailureReport, type ScenarioName, type ScenarioReport } from "./lib/desk-conformance/failures";

const EXIT_CODES = { conformant: 0, refused: 1, "not-run": 2 } as const;

/** Drives one local Desk adapter package through the production Cortex runtime seams and reports each capability. */
export async function runConformance(packageDir: string, tempParent = tmpdir()): Promise<ConformanceReport> {
  const temp = await mkdtemp(join(tempParent, "desk-conformance-"));
  const guard = guardNetwork();
  try {
    const outcome = await executePackage(resolve(packageDir), temp);
    return { ...outcome, networkRequests: guard.count() };
  } finally {
    guard.release();
    await rm(temp, { recursive: true, force: true });
  }
}

interface Arguments { packageDir?: string; companionDir?: string; json: boolean; failures: boolean; unknown: string[] }

function parse(argv: readonly string[]): Arguments {
  const parsed: Arguments = { json: false, failures: false, unknown: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (argument === "--json") parsed.json = true;
    else if (argument === "--failures") parsed.failures = true;
    else if (argument === "--companion") parsed.companionDir = argv[++index];
    else if (argument.startsWith("--")) parsed.unknown.push(argument);
    else if (parsed.packageDir === undefined) parsed.packageDir = argument;
    else parsed.unknown.push(argument);
  }
  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  if (parsed.packageDir === undefined || parsed.unknown.length > 0) {
    console.error("usage: bun scripts/desk-adapter-conformance.ts <package-dir> [--json] [--failures [--companion <package-dir>]]");
    return 64;
  }
  if (parsed.failures) {
    const report = await runFailureScenarios(parsed.packageDir, parsed.companionDir === undefined ? {} : { companionDir: parsed.companionDir });
    console.log(parsed.json ? JSON.stringify(report, null, 2) : formatFailureReport(report));
    return report.status === "isolated" ? 0 : 1;
  }
  const report = await runConformance(parsed.packageDir);
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return EXIT_CODES[report.status];
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
