import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EVIDENCE_SCHEMA = "desk-adapter-evidence/1";
export const EVIDENCE_DIR = resolve(import.meta.dir, "../docs/evidence/desk-adapters");
export const MATRIX_ROWS = Array.from({ length: 14 }, (_, index) => `A${index + 1}`);

const RESULTS = ["pass", "fail"] as const;
type Result = (typeof RESULTS)[number];

export interface MatrixResult { row: string; result: Result }
export interface Readback { result: Result; sha256: string }
export interface DeskAdapterEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  commitSha: string;
  ciRunId: string;
  binding: string;
  cutoverId: string;
  matrix: MatrixResult[];
  creationTypes: string[];
  timing: { startedAt: string; finishedAt: string; durationMs: number };
  canary: { result: Result };
  readback?: Readback;
}

const TOP_KEYS = ["schema", "commitSha", "ciRunId", "binding", "cutoverId", "matrix", "creationTypes", "timing", "canary", "readback"];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LONG_DIGIT_RUN = /\d{16,}/;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+/;
const PLATFORM_ID_SHAPE = /\d{17,20}/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class EvidenceError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid desk-adapter evidence: ${problems.join("; ")}`);
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictKeys(value: Json, allowed: string[], path: string, problems: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${path}.${key} is not an allowed field`);
}

function slug(value: unknown, path: string, problems: string[]): void {
  if (typeof value !== "string" || !SLUG.test(value) || LONG_DIGIT_RUN.test(value)) problems.push(`${path} must be a short lowercase slug`);
}

function result(value: unknown, path: string, problems: string[]): void {
  if (!RESULTS.includes(value as Result)) problems.push(`${path} must be pass or fail`);
}

function recordAt(value: unknown, allowed: string[], path: string, problems: string[]): Json | undefined {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  strictKeys(value, allowed, path, problems);
  return value;
}

function scanShapes(value: unknown, path: string, problems: string[]): void {
  if (typeof value === "string") {
    if (EMAIL_SHAPE.test(value)) problems.push(`${path} has an email shape`);
    if (PLATFORM_ID_SHAPE.test(value)) problems.push(`${path} has a platform ID shape`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanShapes(item, `${path}[${index}]`, problems));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) scanShapes(item, `${path}.${key}`, problems);
  }
}

function validateMatrix(value: unknown, problems: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("matrix must be a non-empty array");
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `matrix[${index}]`;
    const item = recordAt(entry, ["row", "result"], path, problems);
    if (!item) return;
    if (typeof item.row !== "string" || !MATRIX_ROWS.includes(item.row)) problems.push(`${path}.row must be one of A1 to A14`);
    else if (seen.has(item.row)) problems.push(`${path}.row repeats ${item.row}`);
    else seen.add(item.row);
    result(item.result, `${path}.result`, problems);
  });
  for (const row of MATRIX_ROWS) if (!seen.has(row)) problems.push(`matrix is missing row ${row}`);
}

function validateTiming(value: unknown, problems: string[]): void {
  const timing = recordAt(value, ["startedAt", "finishedAt", "durationMs"], "timing", problems);
  if (!timing) return;
  for (const key of ["startedAt", "finishedAt"]) {
    const stamp = timing[key];
    if (typeof stamp !== "string" || !ISO_UTC.test(stamp) || Number.isNaN(Date.parse(stamp))) problems.push(`timing.${key} must be a UTC ISO timestamp`);
  }
  if (!Number.isInteger(timing.durationMs) || (timing.durationMs as number) < 0) problems.push("timing.durationMs must be a non-negative integer");
}

function validateReadback(value: unknown, problems: string[]): void {
  const readback = recordAt(value, ["result", "sha256"], "readback", problems);
  if (!readback) return;
  result(readback.result, "readback.result", problems);
  if (typeof readback.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(readback.sha256)) problems.push("readback.sha256 must be a lowercase SHA-256 digest");
}

export function validateEvidence(input: unknown): DeskAdapterEvidence {
  const problems: string[] = [];
  if (!isRecord(input)) throw new EvidenceError(["summary must be an object"]);
  strictKeys(input, TOP_KEYS, "summary", problems);
  if (input.schema !== EVIDENCE_SCHEMA) problems.push(`schema must be ${EVIDENCE_SCHEMA}`);
  if (typeof input.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(input.commitSha)) problems.push("commitSha must be a 40-character lowercase hex SHA");
  if (typeof input.ciRunId !== "string" || !/^\d{1,15}$/.test(input.ciRunId)) problems.push("ciRunId must be a numeric string of at most 15 digits");
  slug(input.binding, "binding", problems);
  slug(input.cutoverId, "cutoverId", problems);
  validateMatrix(input.matrix, problems);
  if (!Array.isArray(input.creationTypes) || input.creationTypes.length === 0) problems.push("creationTypes must be a non-empty array");
  else input.creationTypes.forEach((type, index) => slug(type, `creationTypes[${index}]`, problems));
  validateTiming(input.timing, problems);
  const canary = recordAt(input.canary, ["result"], "canary", problems);
  if (canary) result(canary.result, "canary.result", problems);
  if (input.readback !== undefined) validateReadback(input.readback, problems);
  scanShapes(input, "summary", problems);
  if (problems.length > 0) throw new EvidenceError(problems);
  return input as unknown as DeskAdapterEvidence;
}

export function evidenceFileName(evidence: Pick<DeskAdapterEvidence, "binding" | "cutoverId">): string {
  return `${evidence.binding}-${evidence.cutoverId}.json`;
}

export function readbackDigest(result: Result, canonicalBytes: string): Readback {
  return { result, sha256: createHash("sha256").update(canonicalBytes).digest("hex") };
}

export function writeDeskAdapterEvidence(directory: string, input: unknown): string {
  const evidence = validateEvidence(input);
  const target = join(directory, evidenceFileName(evidence));
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EvidenceError([`a summary already exists at ${target}`]);
    throw error;
  }
  return target;
}

export function readDeskAdapterEvidence(path: string): DeskAdapterEvidence {
  return validateEvidence(JSON.parse(readFileSync(path, "utf8")));
}

export function readEvidenceDirectory(directory: string): DeskAdapterEvidence[] {
  return readdirSync(directory).filter(name => name !== "README.md").sort().map(name => {
    if (!name.endsWith(".json")) throw new EvidenceError([`${name} is not a desk-adapter summary`]);
    const path = join(directory, name);
    const evidence = readDeskAdapterEvidence(path);
    if (evidenceFileName(evidence) !== name) throw new EvidenceError([`${name} is not named for ${evidenceFileName(evidence)}`]);
    return evidence;
  });
}

export function exampleEvidence(): DeskAdapterEvidence {
  return {
    schema: EVIDENCE_SCHEMA,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    ciRunId: "1234567890",
    binding: "example-binding",
    cutoverId: "example-cutover",
    matrix: MATRIX_ROWS.map(row => ({ row, result: "pass" as const })),
    creationTypes: ["example-type"],
    timing: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z", durationMs: 300000 },
    canary: { result: "pass" },
    readback: readbackDigest("pass", "synthetic readback"),
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function runExample(): void {
  const directory = mkdtempSync(join(tmpdir(), "desk-adapter-evidence-"));
  try {
    const path = writeDeskAdapterEvidence(directory, exampleEvidence());
    readDeskAdapterEvidence(path);
    process.stdout.write(`example summary written and read back: ${path}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runCli(args: string[]): number {
  try {
    if (args.includes("--example")) {
      runExample();
      return 0;
    }
    const inputPath = argValue(args, "--input");
    if (!inputPath) throw new EvidenceError(["pass --input <summary.json> or --example"]);
    const path = writeDeskAdapterEvidence(argValue(args, "--dir") ?? EVIDENCE_DIR, JSON.parse(readFileSync(inputPath, "utf8")));
    process.stdout.write(`${path}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(runCli(process.argv.slice(2)));
