import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { GATES } from "../check";

interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>;
}

const MINIMUM_BUN_JOB = "test-min-bun";
const workflow = parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as Workflow;
const jobRunLines = Object.entries(workflow.jobs).map(
  ([id, job]) => [id, (job.steps ?? []).flatMap((s) => (s.run ? [s.run.trim()] : []))] as const,
);
const runLines = jobRunLines.flatMap(([, lines]) => lines);
const CHECK_STEP = /^bun scripts\/check\.ts ([a-z-]+)$/;
const gateSteps = (lines: readonly string[]) => lines.flatMap((line) => CHECK_STEP.exec(line)?.[1] ?? []);

describe("CI runs exactly the gates `bun run check` runs", () => {
  test("every CI gate step names a gate, and every CI gate runs once, except the minimum-Bun job's test", () => {
    const ciGates = GATES.filter((g) => !g.localOnly).map((g) => g.name);
    const inCi = jobRunLines.filter(([id]) => id !== MINIMUM_BUN_JOB).flatMap(([, lines]) => gateSteps(lines));
    expect(inCi.slice().sort()).toEqual(ciGates.slice().sort());
    const minimumBunJob = jobRunLines.find(([id]) => id === MINIMUM_BUN_JOB);
    expect(gateSteps(minimumBunJob?.[1] ?? [])).toEqual(["test"]);
  });

  test("no CI step runs a gate's command directly, around scripts/check.ts", () => {
    const gateCommands = GATES.flatMap((g) => g.steps.map((argv) => argv.join(" ")));
    expect(runLines.filter((line) => gateCommands.includes(line))).toEqual([]);
  });
});
