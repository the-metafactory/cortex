import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FAILURE_SCENARIOS, formatFailureReport, runConformance, runFailureScenarios, type FailureReport, type ScenarioName } from "../../../../scripts/desk-adapter-conformance";
import { CONFORMANCE_PACKAGES_ROOT, FAILURE_PACKAGES, writeFailurePackages } from "./fixtures/conformance-build";

const ROOT = join(import.meta.dir, "../../../..");
const packageDir = (name: string): string => join(CONFORMANCE_PACKAGES_ROOT, name);
const scenarioOf = (report: FailureReport, name: ScenarioName) => report.scenarios.find(item => item.scenario === name);

function cli(args: readonly string[]): { exitCode: number | null; output: string } {
  const run = Bun.spawnSync({ cmd: ["bun", "scripts/desk-adapter-conformance.ts", ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

describe("every named failure scenario", () => {
  test("is reported on a package that cannot isolate a fault-free run", async () => {
    const report = await runFailureScenarios(packageDir("greenhouse"), { companionDir: packageDir("observatory") });
    expect(report.status).toBe("isolated");
    expect(report.scenarios.map(item => item.scenario)).toEqual([...FAILURE_SCENARIOS]);
    expect(report.scenarios.filter(item => item.verdict !== "isolated")).toEqual([]);
    expect(report.companion.status).toBe("conformant");
    expect(report.companion.adapterId).toBe("observatory");
    expect(report.networkRequests).toBe(0);
  });

  test("keeps the owner at one call, the operation uncertain and the release shut on each fault", async () => {
    const report = await runFailureScenarios(packageDir("observatory"));
    for (const name of ["owner-timeout", "owner-invalid-output", "owner-exit"] as const) {
      const stopped = scenarioOf(report, name);
      expect(stopped?.operation).toBe("uncertain");
      expect(stopped?.ownerCalls.dispatch).toBe(1);
      expect(stopped?.released).toBe(0);
    }
    expect(scenarioOf(report, "owner-success")?.operation).toBe("succeeded");
    expect(scenarioOf(report, "owner-success")?.ownerCalls.dispatch).toBe(1);
    expect(scenarioOf(report, "owner-success")?.released).toBe(0);
  });

  test("leaves one owner effect and one receipt for a duplicate delivery and a restart", async () => {
    const report = await runFailureScenarios(packageDir("greenhouse"));
    for (const name of ["duplicate-delivery", "restart-after-success"] as const) {
      expect(scenarioOf(report, name)?.verdict).toBe("isolated");
      expect(scenarioOf(report, name)?.ownerCalls.dispatch).toBe(1);
      expect(scenarioOf(report, name)?.operation).toBe("succeeded");
    }
  });

  test("reopens the store on a prepared attempt and keeps the recovered operation uncertain", async () => {
    const report = await runFailureScenarios(packageDir("greenhouse"));
    const crashed = scenarioOf(report, "crash-before-result");
    expect(crashed?.operation).toBe("uncertain");
    expect(crashed?.ownerCalls.dispatch).toBe(1);
    expect(crashed?.detail).toContain("not-dispatchable");
  });

  test("releases nothing after a connection is revoked in flight and keeps the write uncertain", async () => {
    const report = await runFailureScenarios(packageDir("observatory"));
    const read = scenarioOf(report, "revoked-query");
    const write = scenarioOf(report, "revoked-write");
    expect(read?.verdict).toBe("isolated");
    expect(read?.detail).toContain("denied");
    expect(read?.released).toBe(0);
    expect(write?.verdict).toBe("isolated");
    expect(write?.operation).toBe("uncertain");
    expect(write?.ownerCalls.dispatch).toBe(1);
    expect(write?.released).toBe(0);
    expect(write?.networkRequests).toBe(0);
  });

  test("makes no owner call for a package that declares only credential authentication", async () => {
    const report = await runFailureScenarios(packageDir("token-only"));
    expect(report.status).toBe("isolated");
    expect(scenarioOf(report, "owner-success")?.code).toBe("authentication_unsupported");
    expect(report.scenarios.every(item => item.ownerCalls.dispatch === 0)).toBe(true);
    expect(report.companion.status).toBe("not-run");
  });

  test("runs a read-only package without inventing an owner call", async () => {
    const report = await runFailureScenarios(packageDir("tideway"));
    expect(report.status).toBe("isolated");
    expect(report.scenarios.every(item => item.ownerCalls.dispatch === 0)).toBe(true);
    expect(scenarioOf(report, "owner-success")?.code).toBe("no_action_capability");
    expect(scenarioOf(report, "revoked-query")?.released).toBe(0);
  });
});

describe("a package that throws while loading", () => {
  test("is a named refusal, makes no owner call and leaves a second adapter available", async () => {
    const report = await runFailureScenarios(packageDir("broken-throws"), { companionDir: packageDir("observatory") });
    expect(report.status).toBe("isolated");
    expect(scenarioOf(report, "module-load")?.code).toBe("module_throwing");
    expect(report.scenarios.every(item => item.ownerCalls.dispatch === 0)).toBe(true);
    expect(report.scenarios.every(item => item.code === "module_throwing")).toBe(true);
    expect(report.companion.status).toBe("conformant");
    expect(await runConformance(packageDir("observatory"))).toMatchObject({ status: "conformant" });
  });
});

describe("a package that breaks isolation", () => {
  test("fails the harness and names each scenario it escaped from", async () => {
    const report = await runFailureScenarios(packageDir("unsafe-egress"), { companionDir: packageDir("greenhouse") });
    expect(report.status).toBe("failed");
    expect(report.code).toBe("network_egress");
    expect(scenarioOf(report, "owner-success")?.verdict).toBe("failed");
    expect(scenarioOf(report, "owner-success")?.networkRequests ?? 0).toBeGreaterThan(0);
    expect(scenarioOf(report, "module-load")?.verdict).toBe("isolated");
    expect(formatFailureReport(report)).toContain("owner-success");
  });
});

describe("the failure probe command", () => {
  test("prints every scenario and exits 0 for an isolated package", () => {
    const ran = cli([packageDir("greenhouse"), "--failures"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.output).toContain("ISOLATED");
    for (const name of FAILURE_SCENARIOS) expect(ran.output).toContain(name);
  });

  test("exits non-zero and names the scenario for a package that breaks isolation", () => {
    const ran = cli([packageDir("unsafe-egress"), "--failures"]);
    expect(ran.exitCode).toBe(1);
    expect(ran.output).toContain("FAILED network_egress");
    expect(ran.output).toMatch(/failed\s+owner-success\s+\[network_egress\]/);
  });
});

describe("the committed failure fixtures", () => {
  test("match what the generator writes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "desk-conformance-failure-fixture-"));
    try {
      writeFailurePackages(scratch);
      for (const name of Object.keys(FAILURE_PACKAGES)) {
        const committed = packageDir(name);
        const files = readdirSync(committed).sort();
        expect(files).toEqual(readdirSync(join(scratch, name)).sort());
        for (const file of files) expect(readFileSync(join(committed, file), "utf8")).toBe(readFileSync(join(scratch, name, file), "utf8"));
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
