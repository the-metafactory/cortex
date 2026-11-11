#!/usr/bin/env bun
import { formatFailureReport, formatReport, runConformance, runFailureScenarios } from "../src/desk-adapter-sdk/conformance";

export * from "../src/desk-adapter-sdk/conformance";

const EXIT_CODES = { conformant: 0, refused: 1, "not-run": 2 } as const;

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
