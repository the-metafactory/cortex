#!/usr/bin/env bun
import { CANARY_SINKS, canaryExitCode, canaryReport, canarySinkNames, runCanaryProbe, type CanarySink } from "../src/conversations/domain-adapters/canary-fixtures";

function leakOf(argv: readonly string[]): CanarySink | null {
  const index = argv.findIndex(arg => arg === "--leak" || arg.startsWith("--leak="));
  if (index < 0) return null;
  const raw = argv[index] === "--leak" ? argv[index + 1] : argv[index]?.slice("--leak=".length);
  if (raw === undefined || !canarySinkNames(raw)) throw new Error(`The leak argument must name one render target: ${CANARY_SINKS.join(", ")}.`);
  return raw;
}

export async function main(argv: readonly string[]): Promise<number> {
  const leak = leakOf(argv);
  const result = await runCanaryProbe({ leak });
  for (const line of canaryReport(result, leak)) {
    if (line.stream === "err") console.error(line.text);
    else console.log(line.text);
  }
  if (leak !== null) return result.findings.some(finding => finding.sink === leak) ? 1 : 2;
  return canaryExitCode(result);
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (error) {
    console.error(`Desk adapter canary probe could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
