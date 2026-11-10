import { expect, test } from "bun:test";
import { CANARY, CANARY_PATHS, CANARY_SINKS, canaryExitCode, canaryReport, captureLog, emptyCanarySinks, runCanaryProbe, scanCanary, type CanaryProbeResult } from "../canary-fixtures";

const cleanResult = (credentialHoldsCanary: boolean): CanaryProbeResult => ({
  covered: [...CANARY_SINKS], missing: [], findings: [], credentialWritten: true, credentialHoldsCanary,
  paths: [...CANARY_PATHS], entries: { log: 1, event: 1, receipt: 1, ui: 1, model: 1 },
});

test("the scan names the render target that holds the canary and never returns the value", () => {
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

test("the scan finds encoded and truncated forms of the canary", () => {
  const sinks = emptyCanarySinks();
  sinks.log.push(`encoded ${Buffer.from(CANARY).toString("base64")}`);
  sinks.event.push(`hex ${Buffer.from(CANARY).toString("hex")}`);
  sinks.receipt.push(`tail ${CANARY.slice(CANARY.lastIndexOf("-") + 1)}`);
  const findings = scanCanary(sinks);
  expect(findings.map(finding => finding.sink)).toEqual(["log", "event", "receipt"]);
  expect(findings.every(finding => finding.occurrences === 1)).toBe(true);
});

test("a captured Error keeps its message", () => {
  const log = captureLog();
  try { console.error(new Error(`desk-adapter-fixture: the credential ${CANARY} could not be used`)); }
  finally { log.restore(); }
  expect(log.lines.join("\n")).toContain(CANARY);
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

test("a leaking fixture adapter is detected through every captured render target", async () => {
  for (const sink of CANARY_SINKS) {
    const result = await runCanaryProbe({ leak: sink });
    expect(result.findings.map(finding => finding.sink)).toEqual([sink]);
    expect(canaryExitCode(result)).toBe(1);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    const lines = canaryReport(result, sink);
    expect(lines.some(line => line.stream === "err" && line.text.includes(sink))).toBe(true);
    expect(lines.map(line => line.text).join(" ")).not.toContain(CANARY);
  }
});

test("the report never shows a pass mark for an unverified credential", () => {
  const lines = canaryReport(cleanResult(false));
  expect(lines.some(line => line.stream === "out" && line.text.includes("credential"))).toBe(false);
  expect(canaryExitCode(cleanResult(false))).toBe(1);
  expect(canaryReport(cleanResult(true)).some(line => line.stream === "out" && line.text.includes("credential"))).toBe(true);
});

test("the report names an uncovered render target", () => {
  const lines = canaryReport({ ...cleanResult(true), covered: ["event", "receipt", "ui", "model"], missing: ["log"] });
  expect(lines.some(line => line.stream === "err" && line.text.includes("log") && line.text.includes("not covered"))).toBe(true);
  expect(canaryExitCode({ ...cleanResult(true), missing: ["log"] })).toBe(1);
});
