import { expect, test } from "bun:test";
import { CANARY, CANARY_PATHS, CANARY_SINKS, canaryExitCode, main, runCanaryProbe, scanCanary } from "../../../../scripts/probe-desk-adapter-canary";
import { emptyCanarySinks } from "../canary-fixtures";

test("the scan names the sink that holds the canary and never returns the value", () => {
  expect(scanCanary(emptyCanarySinks())).toEqual([]);
  for (const sink of CANARY_SINKS) {
    const sinks = emptyCanarySinks();
    sinks[sink].push(`desk adapter trailer: ${CANARY}`);
    sinks[sink].push(CANARY);
    const findings = scanCanary(sinks);
    expect(findings).toEqual([{ sink, occurrences: 2 }]);
    expect(findings.some(finding => finding.sink !== sink)).toBe(false);
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  }
});

test("a canary in the credential reaches no log, event, receipt, UI response or model context", async () => {
  const result = await runCanaryProbe();
  expect(result.credentialWritten).toBe(true);
  expect(result.credentialHoldsCanary).toBe(true);
  expect(result.paths).toEqual([...CANARY_PATHS]);
  expect(result.covered).toEqual([...CANARY_SINKS]);
  expect(result.missing).toEqual([]);
  expect(result.findings).toEqual([]);
  expect(CANARY_SINKS.every(sink => result.entries[sink] > 0)).toBe(true);
  expect(canaryExitCode(result)).toBe(0);
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test("a fixture adapter that logs the canary exits nonzero and names the log sink", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    expect(await main(["--leak", "log"])).toBe(1);
  } finally {
    console.error = original;
  }
  expect(errors.some(line => line.includes("log") && line.includes("appeared"))).toBe(true);
  expect(errors.join("\n")).not.toContain(CANARY);
});

test("a leaking fixture is detected in every captured sink", async () => {
  for (const sink of CANARY_SINKS) {
    const result = await runCanaryProbe({ leak: sink });
    expect(result.findings).toEqual([{ sink, occurrences: 1 }]);
    expect(canaryExitCode(result)).toBe(1);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
});
