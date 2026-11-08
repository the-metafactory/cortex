import { createHash } from "node:crypto";
import { canonicalWire } from "./validation";
import type { WriterBinding, WriterCutoverSteps, WriterPlan } from "./writer-authority";

export function syntheticWriterPlan(binding: WriterBinding): WriterPlan {
  return { cutoverId: "synthetic-cutover", binding, implementation: { version: "1.0.0", sha256: createHash("sha256").update("synthetic-writer").digest("hex") }, inventoryRef: "synthetic-managed-inventory", entries: [{ kind: "launchd", label: "synthetic-retired", definition: "/synthetic/retired.plist", pids: [], connectionQualified: false }], knownCalls: [], sources: [] };
}
export function syntheticWriterSteps(): WriterCutoverSteps {
  const command = { argv: ["synthetic-supervisor", "checked"], exitCode: 0 as const, stdout: "stopped" };
  const watermark = { version: 1 as const, sourceHash: createHash("sha256").update(canonicalWire([])).digest("hex"), sources: [] };
  return {
    disable: () => Promise.resolve([command]), stop: () => Promise.resolve([command]), drain: () => Promise.resolve({ drained: [], uncertain: [] }),
    verify: record => Promise.resolve({ receiptRef: "synthetic-supervisor", inventoryRef: record.plan.inventoryRef, stoppedLabels: record.plan.entries.map(entry => entry.label), commands: [command], remainingPids: [], remainingJobs: [] }),
    import: () => Promise.resolve(watermark), watermark: () => Promise.resolve(watermark), prepare: () => Promise.resolve(), enable: () => Promise.resolve([command]),
  };
}
