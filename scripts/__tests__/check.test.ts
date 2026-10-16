import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { GATES } from "../check";

interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>;
}

const workflow = parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as Workflow;
const runLines = Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).flatMap((s) => (s.run ? [s.run.trim()] : [])));
const CHECK_STEP = /^bun scripts\/check\.ts ([a-z-]+)$/;

describe("CI runs exactly the gates `bun run check` runs", () => {
  test("every CI gate step names a gate, and every CI gate runs in CI", () => {
    const inCi = runLines.flatMap((line) => CHECK_STEP.exec(line)?.[1] ?? []);
    const ciGates = GATES.filter((g) => !g.localOnly).map((g) => g.name);
    expect(inCi.slice().sort()).toEqual(ciGates.slice().sort());
  });

  test("no CI step runs a gate's command directly, around scripts/check.ts", () => {
    const gateCommands = GATES.flatMap((g) => g.steps.map((argv) => argv.join(" ")));
    expect(runLines.filter((line) => gateCommands.includes(line))).toEqual([]);
  });
});
