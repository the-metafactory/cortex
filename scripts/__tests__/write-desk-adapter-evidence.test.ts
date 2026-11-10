import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_DIR, EvidenceError, evidenceFileName, exampleEvidence, readDeskAdapterEvidence, validateEvidence, writeDeskAdapterEvidence } from "../write-desk-adapter-evidence";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function rejects(mutate: (summary: Record<string, unknown>) => void): void {
  const dir = tempDir();
  const summary = structuredClone(exampleEvidence()) as unknown as Record<string, unknown>;
  mutate(summary);
  expect(() => writeDeskAdapterEvidence(dir, summary)).toThrow(EvidenceError);
  expect(readdirSync(dir)).toEqual([]);
}

describe("writeDeskAdapterEvidence", () => {
  test("writes <binding>-<cutoverId>.json and reads it back", () => {
    const dir = tempDir();
    const path = writeDeskAdapterEvidence(dir, exampleEvidence());
    expect(path).toBe(join(dir, "example-binding-example-cutover.json"));
    expect(readDeskAdapterEvidence(path)).toEqual(exampleEvidence());
  });

  test("rejects fields outside the allowlist and writes nothing", () => {
    rejects(summary => { summary.note = "free text"; });
    rejects(summary => { (summary.timing as Record<string, unknown>).extra = 1; });
  });

  test("rejects free text and object values", () => {
    rejects(summary => { summary.binding = "Some free text here"; });
    rejects(summary => { summary.canary = { result: { nested: true } }; });
    rejects(summary => { (summary.readback as Record<string, unknown>).result = "it looked fine"; });
    rejects(summary => { (summary.readback as Record<string, unknown>).sha256 = "not-a-digest"; });
  });

  test("rejects email and platform ID shapes", () => {
    rejects(summary => { summary.creationTypes = ["someone@example.com"]; });
    rejects(summary => { summary.cutoverId = "cut-12345678901234567"; });
    rejects(summary => { summary.ciRunId = "12345678901234567"; });
  });

  test("rejects bad matrix rows", () => {
    rejects(summary => { summary.matrix = [{ row: "A15", result: "pass" }]; });
    rejects(summary => { summary.matrix = [{ row: "A1", result: "pass" }]; });
    rejects(summary => { summary.matrix = (summary.matrix as unknown[]).slice(1); });
    rejects(summary => { summary.matrix = [{ row: "A1", result: "pass" }, { row: "A1", result: "pass" }]; });
  });

  test("refuses to overwrite an existing summary", () => {
    const dir = tempDir();
    const path = writeDeskAdapterEvidence(dir, exampleEvidence());
    const before = readDeskAdapterEvidence(path);
    const changed = { ...exampleEvidence(), canary: { result: "fail" as const } };
    expect(() => writeDeskAdapterEvidence(dir, changed)).toThrow(/already exists/);
    expect(readDeskAdapterEvidence(path)).toEqual(before);
  });
});

describe("committed evidence directory", () => {
  test("each summary validates and is named for its binding and cutover", () => {
    for (const name of readdirSync(EVIDENCE_DIR).filter(file => file.endsWith(".json"))) {
      const evidence = readDeskAdapterEvidence(join(EVIDENCE_DIR, name));
      expect(name).toBe(evidenceFileName(evidence));
    }
  });
});

describe("cli", () => {
  test("--example exits 0 and a disallowed field exits nonzero", () => {
    const script = join(import.meta.dir, "../write-desk-adapter-evidence.ts");
    expect(Bun.spawnSync(["bun", script, "--example"]).exitCode).toBe(0);
    const dir = tempDir();
    const input = join(dir, "in.json");
    writeFileSync(input, JSON.stringify({ ...exampleEvidence(), extra: "x" }));
    const out = join(dir, "out");
    expect(Bun.spawnSync(["bun", script, "--input", input, "--dir", out]).exitCode).not.toBe(0);
    expect(validateEvidence(exampleEvidence()).schema).toBe("desk-adapter-evidence/1");
  });
});
