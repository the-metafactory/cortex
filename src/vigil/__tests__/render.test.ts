// glossary-ignore: run
import { expect, test } from "bun:test";
import type { VigilSubjectRow } from "../db";
import { createVigilRenderer } from "../render";

const goal = { subject_kind: "state", vocab: "goal", goal_id: "G1", stack: "default", ref: "G1" } as const;
const sensor = { subject_kind: "run", vocab: null, goal_id: "G1", stack: "default", ref: "daily-sweep" } as const;
const escalation = { subject_kind: "state", vocab: "escalation", goal_id: null, stack: "default", ref: "the-metafactory/soma#604" } as const;
const change = { from_value: "on-track", to_value: "off-track" };

test("renders the approved goal, goal-sensor and escalation formats", async () => {
  const lookedUp: string[] = [];
  const render = createVigilRenderer({ resolveGoalWording: (id) => { lookedUp.push(id); return "Example goal"; } });
  expect(await render(change, goal)).toBe("Vigil: goal Example goal — on-track → off-track");
  expect(await render({ from_value: "succeeded", to_value: "failed" }, sensor)).toBe("Vigil: daily-sweep (serves Example goal) — succeeded → failed");
  expect(await render({ from_value: "needs-principal", to_value: "overdue" }, escalation)).toBe("Vigil: escalation the-metafactory/soma#604 — needs-principal → overdue");
  expect(await render({ from_value: null, to_value: "overdue" }, escalation)).toBe("Vigil: escalation the-metafactory/soma#604 — overdue");
  expect(lookedUp).toEqual(["G1", "G1"]);
});

test("missing and null resolvers use IDs for goals and sensors", async () => {
  for (const render of [createVigilRenderer(), createVigilRenderer({ resolveGoalWording: () => null })]) {
    expect(await render(change, goal)).toBe("Vigil: goal G1 — on-track → off-track");
    expect(await render({ from_value: null, to_value: "failed" }, sensor)).toBe("Vigil: daily-sweep (serves G1) — failed");
    expect(await render(change, { ...goal, goal_id: null })).toBe("Vigil: goal G1 — on-track → off-track");
  }
});

test("wording is resolved anew at render time, with async resolvers supported", async () => {
  let wording = "Example goal";
  const render = createVigilRenderer({ resolveGoalWording: async () => wording });
  const original = structuredClone({ change, goal });
  expect(await render(change, goal)).toContain("goal Example goal");
  wording = "Updated goal";
  expect(await render(change, goal)).toContain("goal Updated goal");
  expect({ change, goal }).toEqual(original);
});

test("throwing and rejecting resolvers fall back and warn once per flush renderer", async () => {
  for (const resolveGoalWording of [
    () => { throw new Error("private goal wording"); },
    async () => { throw new Error("private goal wording"); },
  ]) {
    const warnings: string[] = [];
    const options = { resolveGoalWording, warn: (message: string) => { warnings.push(message); } };
    const render = createVigilRenderer(options);
    expect(await Promise.all([render(change, goal), render(change, goal)])).toEqual([
      "Vigil: goal G1 — on-track → off-track", "Vigil: goal G1 — on-track → off-track",
    ]);
    expect(await render({ from_value: null, to_value: "failed" }, sensor)).toContain("serves G1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("private goal wording");
    expect(await createVigilRenderer(options)(change, goal)).toContain("goal G1");
    expect(warnings).toHaveLength(2);
  }
});

test("non-goal subjects do not invoke wording resolution", async () => {
  const render = createVigilRenderer({ resolveGoalWording: () => { throw new Error("must not resolve"); }, warn: () => { throw new Error("must not warn"); } });
  for (const [subject, label] of [
    [{ ...sensor, goal_id: null }, "daily-sweep"],
    [{ ...escalation, vocab: "check", ref: "soma:harness" }, "check soma:harness"],
    [{ ...escalation, vocab: "unknown", ref: "unrecognised" }, "unknown unrecognised"],
  ] satisfies [Pick<VigilSubjectRow, "subject_kind" | "vocab" | "goal_id" | "ref" | "stack">, string][]) {
    expect(await render({ from_value: "failed", to_value: "succeeded" }, subject)).toBe(`Vigil: ${label} — failed → succeeded`);
  }
});
