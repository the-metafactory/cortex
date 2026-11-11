import { expect, test } from "bun:test";
import { lastWorkerJson } from "../desk/worker-handoff-contract";

test("worker output reads a whole response or the final compact response after logs", () => {
  const answer = { state: "running", generation: 3 };
  expect(lastWorkerJson(JSON.stringify(answer))).toEqual(answer);
  expect(lastWorkerJson(`registered supervisor\n${JSON.stringify(answer)}\n`)).toEqual(answer);
});

test("worker output recovers the complete formatted response after logs with nested objects", () => {
  const answer = { state: "running", details: [{ process: { id: 42 } }], generation: 3 };
  expect(lastWorkerJson(`registered supervisor\n${JSON.stringify(answer, null, 2)}\n`)).toEqual(answer);
});

test("worker output ignores oversized log prefixes and refuses an oversized response", () => {
  const logs = "not JSON\n".repeat(20_000);
  expect(lastWorkerJson(`${logs}{"generation":3}\n`)).toEqual({ generation: 3 });
  expect(lastWorkerJson(logs)).toBeUndefined();
  expect(lastWorkerJson(JSON.stringify({ result: "x".repeat(70_000) }))).toBeUndefined();
});
