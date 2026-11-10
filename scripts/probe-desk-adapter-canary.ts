#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY, CANARY_PATHS, CANARY_SINKS, openCanaryStack, type CanaryPath, type CanarySink, type CanarySinks } from "../src/conversations/domain-adapters/canary-fixtures";

export { CANARY, CANARY_PATHS, CANARY_SINKS };
export type { CanaryPath, CanarySink, CanarySinks };

export interface CanaryFinding {
  readonly sink: CanarySink;
  readonly occurrences: number;
}

export interface CanaryProbeResult {
  readonly covered: CanarySink[];
  readonly missing: CanarySink[];
  readonly findings: CanaryFinding[];
  readonly credentialWritten: boolean;
  readonly credentialHoldsCanary: boolean;
  readonly paths: CanaryPath[];
  readonly entries: Record<CanarySink, number>;
}

const occurrences = (entries: readonly string[], canary: string): number => entries.reduce((total, entry) => total + entry.split(canary).length - 1, 0);

export function scanCanary(sinks: CanarySinks, canary: string = CANARY): CanaryFinding[] {
  return CANARY_SINKS.flatMap(sink => {
    const matches = occurrences(sinks[sink], canary);
    return matches > 0 ? [{ sink, occurrences: matches }] : [];
  });
}

export interface CanaryProbeOptions {
  leak?: CanarySink | null;
  root?: string;
}

export async function runCanaryProbe(options: CanaryProbeOptions = {}): Promise<CanaryProbeResult> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "desk-adapter-canary-"));
  try {
    const stack = await openCanaryStack({ root: join(root, "stack"), leak: options.leak ?? null });
    try {
      return {
        covered: stack.covered,
        missing: stack.missing,
        findings: scanCanary(stack.sinks),
        credentialWritten: stack.credentialWritten,
        credentialHoldsCanary: stack.credentialHoldsCanary,
        paths: stack.paths,
        entries: stack.entries,
      };
    } finally {
      await stack.close();
    }
  } finally {
    if (options.root === undefined) await rm(root, { recursive: true, force: true });
  }
}

export const canaryExitCode = (result: CanaryProbeResult): number => result.credentialWritten && result.credentialHoldsCanary && result.missing.length === 0 && result.findings.length === 0 ? 0 : 1;

const isSink = (value: string): value is CanarySink => (CANARY_SINKS as readonly string[]).includes(value);

function leakOf(argv: readonly string[]): CanarySink | null {
  const index = argv.findIndex(arg => arg === "--leak" || arg.startsWith("--leak="));
  if (index < 0) return null;
  const raw = argv[index] === "--leak" ? argv[index + 1] : argv[index]?.slice("--leak=".length);
  if (raw === undefined || !isSink(raw)) throw new Error(`The leak argument must name one sink: ${CANARY_SINKS.join(", ")}.`);
  return raw;
}

export async function main(argv: readonly string[]): Promise<number> {
  const leak = leakOf(argv);
  const result = await runCanaryProbe({ leak });
  for (const sink of CANARY_SINKS) {
    if (result.missing.includes(sink)) console.error(`❌ ${sink}: not covered by the synthetic stack`);
    else if (result.findings.some(finding => finding.sink === sink)) console.error(`❌ ${sink}: the canary appeared in the ${sink} sink`);
    else console.log(`✅ ${sink}: scanned, the canary appeared nowhere`);
  }
  console.log(`✅ credential: the canary is installed in the fixture connection's secret store (${result.credentialHoldsCanary ? "verified" : "unverified"})`);
  if (leak !== null) {
    const detected = result.findings.some(finding => finding.sink === leak);
    console.error(detected
      ? `The leaking fixture adapter wrote the canary into the ${leak} sink, and the scan named that sink.`
      : `The leaking fixture adapter wrote the canary into the ${leak} sink, but the scan did not name it.`);
    return detected ? 1 : 2;
  }
  console.log(canaryExitCode(result) === 0
    ? "Desk adapter canary probe passed: query, draft, dispatch and failure paths ran against a canary credential, and no log, event, receipt, UI response or model context held the value. Synthetic temporary stack only."
    : "Desk adapter canary probe failed: see the named sinks above. The value is never printed.");
  return canaryExitCode(result);
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (error) {
    console.error(`Desk adapter canary probe could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
