import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_DIR, EvidenceError, evidenceFileName, exampleEvidence, readDeskAdapterEvidence, readEvidenceDirectory, validateEvidence, writeDeskAdapterEvidence } from "../write-desk-adapter-evidence";

const PLATFORM_ID_DIGITS = "1".repeat(17);

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
    rejects(summary => { summary.cutoverId = `cut-${PLATFORM_ID_DIGITS}`; });
    rejects(summary => { summary.ciRunId = PLATFORM_ID_DIGITS; });
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
  test("every committed file is a summary that validates and is named for its binding and cutover", () => {
    for (const evidence of readEvidenceDirectory(EVIDENCE_DIR)) {
      expect(evidenceFileName(readDeskAdapterEvidence(join(EVIDENCE_DIR, evidenceFileName(evidence))))).toBe(evidenceFileName(evidence));
    }
  });

  test("the directory check rejects a summary that fails validation", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "broken-cutover.json"), JSON.stringify({ ...exampleEvidence(), extra: "x" }));
    expect(() => readEvidenceDirectory(dir)).toThrow(EvidenceError);
  });

  test("the directory check rejects a summary stored under a name that is not its own", () => {
    const dir = tempDir();
    const path = writeDeskAdapterEvidence(dir, exampleEvidence());
    writeFileSync(join(dir, "other-cutover.json"), readFileSync(path));
    expect(() => readEvidenceDirectory(dir)).toThrow(/not named for/);
  });

  test("the directory check rejects a file that is neither a summary nor the readme", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "free text");
    expect(() => readEvidenceDirectory(dir)).toThrow(/not a desk-adapter summary/);
  });

  test("the directory check reads a written summary back", () => {
    const dir = tempDir();
    writeDeskAdapterEvidence(dir, exampleEvidence());
    writeFileSync(join(dir, "README.md"), "# readme\n");
    expect(readEvidenceDirectory(dir)).toEqual([exampleEvidence()]);
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
