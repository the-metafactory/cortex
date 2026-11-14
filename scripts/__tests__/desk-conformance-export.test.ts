import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESK_ADAPTER_SDK_VERSION } from "../../src/desk-sdk/version";
import { CONFORMANCE_CONNECTION_ID, type ConformanceReport, type FailureReport } from "../../src/desk-adapter-sdk/conformance";
import { collect, probeConformanceExport } from "../probe-desk-conformance-export";
import { conformanceDomain, writeConformancePackage } from "../../src/conversations/domain-adapters/__tests__/fixtures/conformance-build";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "src/conversations/domain-adapters/__tests__/fixtures/conformance-packages");

async function cli(failures: boolean): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "scripts/desk-adapter-conformance.ts", join(FIXTURES, "greenhouse"), "--json", ...(failures ? ["--failures"] : [])], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const { exitCode, stdout } = await collect(child);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

const capabilitiesOf = ({ packageDir: _packageDir, ...report }: ConformanceReport) => report;
const failuresOf = ({ packageDir: _packageDir, companion: { packageDir: _companionDir, ...companion }, ...report }: FailureReport) => ({ ...report, companion });

test("a stalled conformance subprocess is killed and reports a bounded timeout", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "pipe" });
  const result = await collect(child, 25);
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain("timed out");
  expect(child.signalCode).toBe("SIGKILL");
});

test("an external package imports the export and gets the CLI capability and failure reports", async () => {
  const before = readdirSync(tmpdir()).filter(name => name.startsWith("desk-conformance-export-"));
  const [result, capabilities, failures] = await Promise.all([probeConformanceExport(), cli(false), cli(true)]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as { sdkVersion: string; capabilities: ConformanceReport; failures: FailureReport };
  expect(report.sdkVersion).toBe(DESK_ADAPTER_SDK_VERSION);
  expect(report.capabilities.packageDir.startsWith(ROOT)).toBe(false);
  expect(capabilitiesOf(report.capabilities)).toEqual(capabilitiesOf(capabilities as ConformanceReport));
  expect(failuresOf(report.failures)).toEqual(failuresOf(failures as FailureReport));
  expect(report.capabilities.networkRequests).toBe(0);
  expect(report.failures.networkRequests).toBe(0);
  expect(readdirSync(tmpdir()).filter(name => name.startsWith("desk-conformance-export-"))).toEqual(before);
}, 60_000);

test("the external Mail probe exits nonzero when the run is refused", async () => {
  const result = await probeConformanceExport(join(FIXTURES, "bad-annotation"), "run-mail.ts");
  expect(JSON.parse(result.stdout).capabilities.status).toBe("refused");
  expect(result.exitCode).toBe(1);
}, 60_000);

test("the external probe exits nonzero for a broken fixture and reports its refusal", async () => {
  const result = await probeConformanceExport(join(FIXTURES, "broken-format"));
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).capabilities).toMatchObject({ status: "refused", code: "unsupported_format", networkRequests: 0 });
}, 60_000);

test("an external Mail read package reads listed mail on two connections through the export", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-conformance-mail-"));
  try {
    const packageDir = writeConformancePackage(join(root, "mail-read"), conformanceDomain("tideway"), "mail-read").dir;
    const result = await probeConformanceExport(packageDir, "run-mail.ts");
    expect(result.exitCode).toBe(0);
    const { capabilities } = JSON.parse(result.stdout) as { capabilities: ConformanceReport };
    expect(capabilities.status).toBe("conformant");
    const answered = (capabilities.mailQueries ?? []).filter(query => query.connectionId !== CONFORMANCE_CONNECTION_ID).map(query => ({ connectionId: query.connectionId, verdict: query.verdict, dataPolicy: query.dataPolicy, objects: query.objects }));
    expect(answered).toEqual([
      { connectionId: "mail-fresh", verdict: "conformant", dataPolicy: "local", objects: [expect.objectContaining({ name: "Fresh subject one", note: "account fresh@example.invalid; fresh; peer read mail_read_unadmitted" })] },
      { connectionId: "mail-stale", verdict: "conformant", dataPolicy: "local", objects: [expect.objectContaining({ name: "Kept subject", note: "account stale@example.invalid; stale provider_failure; peer read mail_read_unadmitted" })] },
    ]);
    expect(capabilities.packageDir.startsWith(ROOT)).toBe(false);
    expect(capabilities.networkRequests).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("the Surface SDK stays at 1.3.0", () => {
  expect(readFileSync(join(ROOT, "src/surface-sdk/index.ts"), "utf8")).toContain('export const SURFACE_SDK_VERSION = "1.3.0";');
});
