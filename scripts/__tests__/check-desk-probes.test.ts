import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_EXCLUSIONS, PROBE_PREFIX, PROBE_RUNS, PROBE_SUFFIX, printDeskProbeReport, runDeskProbes } from "../check-desk-probes";

const dirs: string[] = [];

function probeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "desk-probe-check-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OK = "process.stdout.write(\"ok\\n\");\nprocess.exit(0);\n";
const FAILS = "process.stderr.write(\"synthetic failure\\n\");\nprocess.exit(1);\n";
const MARKER = "import { writeFileSync } from \"node:fs\";\nwriteFileSync(process.env.DESK_PROBE_MARKER ?? \"\", process.env.HOME ?? \"\");\nprocess.exit(0);\n";
const REAL_HOME = "process.stderr.write(`home=${process.env.HOME ?? \"\"}\\n`);\nprocess.exit(process.env.HOME === process.env.DESK_PROBE_HOST_HOME ? 0 : 1);\n";

const HOME_SPY = "import { writeFileSync } from \"node:fs\";\nimport { basename } from \"node:path\";\nwriteFileSync(`${process.env.DESK_PROBE_MARKER ?? \"\"}.${basename(process.argv[1] ?? \"\")}`, process.env.HOME ?? \"\");\nprocess.exit(0);\n";

describe("runDeskProbes", () => {
  test("runs every listed probe and reports each result", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK });
    const report = await runDeskProbes({ dir, probes: ["probe-desk-ok.ts"], exclusions: [] });
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.problems).toEqual([]);
    expect(report.outcomes).toEqual([{ file: "probe-desk-ok.ts", status: "passed", exitCode: 0, stdout: "ok", stderr: "" }]);
  });

  test("runs each probe under a temporary home rather than this machine's home", async () => {
    const dir = probeDir({ "probe-desk-marker.ts": MARKER });
    const marker = join(dir, "marker.txt");
    process.env.DESK_PROBE_MARKER = marker;
    try {
      const report = await runDeskProbes({ dir, probes: ["probe-desk-marker.ts"], exclusions: [] });
      expect(report.ok).toBe(true);
      const home = readFileSync(marker, "utf8");
      expect(home).not.toBe(process.env.HOME);
      expect(home).not.toBe("");
    } finally {
      delete process.env.DESK_PROBE_MARKER;
    }
  });

  test("gives each probe its own temporary home rather than one home shared between them", async () => {
    const dir = probeDir({ "probe-desk-one.ts": HOME_SPY, "probe-desk-two.ts": HOME_SPY });
    const marker = join(dir, "homes");
    process.env.DESK_PROBE_MARKER = marker;
    try {
      const report = await runDeskProbes({ dir, probes: ["probe-desk-one.ts", "probe-desk-two.ts"], exclusions: [] });
      expect(report.ok).toBe(true);
      const homes = ["probe-desk-one.ts", "probe-desk-two.ts"].map((name) => readFileSync(`${marker}.${name}`, "utf8"));
      expect(homes[0]).not.toBe("");
      expect(homes[0]).not.toBe(homes[1]);
      expect(homes).not.toContain(process.env.HOME ?? "");
    } finally {
      delete process.env.DESK_PROBE_MARKER;
    }
  });

  test("fails the run when a probe fails", async () => {
    const dir = probeDir({ "probe-desk-fails.ts": FAILS });
    const report = await runDeskProbes({ dir, probes: ["probe-desk-fails.ts"], exclusions: [] });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.outcomes).toEqual([{ file: "probe-desk-fails.ts", status: "failed", exitCode: 1, stdout: "", stderr: "synthetic failure" }]);
  });

  test("fails the run and names a probe file that neither list names", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK, "probe-desk-extra.ts": OK });
    const report = await runDeskProbes({ dir, probes: ["probe-desk-ok.ts"], exclusions: [] });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.problems.some((problem) => problem.includes("probe-desk-extra.ts"))).toBe(true);
    expect(report.outcomes.map((outcome) => outcome.file)).toEqual(["probe-desk-ok.ts"]);
  });

  test("skips an excluded probe and reports its reason", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK, "probe-desk-excluded.ts": MARKER });
    const marker = join(dir, "marker.txt");
    process.env.DESK_PROBE_MARKER = marker;
    try {
      const report = await runDeskProbes({
        dir,
        probes: ["probe-desk-ok.ts"],
        exclusions: [{ file: "probe-desk-excluded.ts", reason: "needs a real stack" }],
      });
      expect(report.ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(report.outcomes.find((outcome) => outcome.file === "probe-desk-excluded.ts")).toMatchObject({ status: "excluded", reason: "needs a real stack" });
    } finally {
      delete process.env.DESK_PROBE_MARKER;
    }
  });

  test("fails the run when an exclusion carries no reason", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK, "probe-desk-excluded.ts": OK });
    const report = await runDeskProbes({
      dir,
      probes: ["probe-desk-ok.ts"],
      exclusions: [{ file: "probe-desk-excluded.ts", reason: "  " }],
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("probe-desk-excluded.ts"))).toBe(true);
  });

  test("fails the run when a named probe file does not exist", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK });
    const report = await runDeskProbes({ dir, probes: ["probe-desk-missing.ts"], exclusions: [] });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("probe-desk-missing.ts"))).toBe(true);
  });

  test("fails the run when a file is both run and excluded", async () => {
    const dir = probeDir({ "probe-desk-ok.ts": OK });
    const report = await runDeskProbes({
      dir,
      probes: ["probe-desk-ok.ts"],
      exclusions: [{ file: "probe-desk-ok.ts", reason: "needs a real stack" }],
    });
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes("probe-desk-ok.ts"))).toBe(true);
  });

  test("fails the run when a probe needs a real home and gets the temporary one", async () => {
    const dir = probeDir({ "probe-desk-real-home.ts": REAL_HOME });
    process.env.DESK_PROBE_HOST_HOME = process.env.HOME;
    try {
      const report = await runDeskProbes({ dir, probes: ["probe-desk-real-home.ts"], exclusions: [] });
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(1);
      const failed = report.outcomes.find((outcome) => outcome.file === "probe-desk-real-home.ts");
      expect(failed?.status).toBe("failed");
      expect(failed?.stderr).toContain("home=");
      expect(failed?.stderr).not.toContain(`home=${process.env.DESK_PROBE_HOST_HOME}`);
    } finally {
      delete process.env.DESK_PROBE_HOST_HOME;
    }
  });
});

describe("printDeskProbeReport", () => {
  test("says why a probe was killed by the probe timeout", () => {
    const lines: string[] = [];
    printDeskProbeReport(
      {
        ok: false,
        exitCode: 1,
        problems: [],
        outcomes: [{ file: "probe-desk-slow.ts", status: "failed", exitCode: 137, reason: "killed after the 120000 ms probe timeout", stdout: "", stderr: "" }],
      },
      (line) => lines.push(line),
    );
    expect(lines).toContain("   killed after the 120000 ms probe timeout");
  });
});

describe("the real desk probe lists", () => {
  const scripts = join(import.meta.dir, "..");
  const files = readdirSync(scripts)
    .filter((name) => name.startsWith(PROBE_PREFIX) && name.endsWith(PROBE_SUFFIX))
    .sort();
  const excluded = PROBE_EXCLUSIONS.map(({ file }) => file).sort();

  test("name every probe file in either the run list or the exclusion list", () => {
    expect([...PROBE_RUNS, ...excluded].sort()).toEqual(files);
  });

  test("give every exclusion a reason", () => {
    expect(PROBE_EXCLUSIONS.filter(({ reason }) => reason.trim() === "")).toEqual([]);
  });

  test("keep a probe out of both lists", () => {
    expect(PROBE_RUNS.filter((name) => excluded.includes(name))).toEqual([]);
  });
});
