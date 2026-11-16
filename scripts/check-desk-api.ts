import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_API_ROUTES } from "../src/desk-api/routes";
import { DESK_API_VERSION, deskContract } from "../src/desk-api/version";
import { gitShow, resolveBaseRef } from "./lib/git";

const DESK_API_SNAPSHOT = "src/desk-api/generated/desk-api-contract.json";

export interface DeskApiSnapshot {
  readonly version: string;
  readonly routes: readonly string[];
  readonly phraseCodes: readonly string[];
  readonly vocabulary: readonly string[];
}

const SEMVER = /^(\d+)\.(\d+)\.\d+$/;

function parts(version: string): [number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function vocabularyEntries(name: string, value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => `${name}: ${JSON.stringify(item)}`);
  if (value !== null && typeof value === "object") return Object.keys(value).map((key) => `${name}: ${key}`);
  return [`${name}: ${JSON.stringify(value)}`];
}

function currentSnapshot(): DeskApiSnapshot {
  const contract = deskContract();
  return {
    version: DESK_API_VERSION,
    routes: DESK_API_ROUTES.map(({ method, path }) => `${method} ${path}`).sort(),
    phraseCodes: [...contract.phraseCodes].sort(),
    vocabulary: Object.entries(contract.vocabularies).flatMap(([name, value]) => vocabularyEntries(name, value)).sort(),
  };
}

function difference(from: readonly string[], to: readonly string[]): string[] {
  const kept = new Set(to);
  return from.filter((entry) => !kept.has(entry));
}

const SECTIONS = ["routes", "phraseCodes", "vocabulary"] as const;

export function deskApiVersionProblems(base: DeskApiSnapshot, head: DeskApiSnapshot): string[] {
  const from = parts(base.version);
  const to = parts(head.version);
  if (!from || !to) return [`DESK_API_VERSION must be MAJOR.MINOR.PATCH; found ${base.version} on the base and ${head.version} here.`];
  const removed = SECTIONS.flatMap((section) => difference(base[section], head[section]).map((entry) => `${section}: ${entry}`));
  const added = SECTIONS.flatMap((section) => difference(head[section], base[section]).map((entry) => `${section}: ${entry}`));
  const majorBumped = to[0] > from[0];
  const minorBumped = majorBumped || (to[0] === from[0] && to[1] > from[1]);
  const problems: string[] = [];
  if (removed.length > 0 && !majorBumped) {
    problems.push(`The Desk API removed ${removed.join("; ")} but DESK_API_VERSION is ${head.version} (base ${base.version}). A major bump is required.`);
  }
  if (added.length > 0 && !minorBumped) {
    problems.push(`The Desk API added ${added.join("; ")} but DESK_API_VERSION is ${head.version} (base ${base.version}). A minor bump is required.`);
  }
  return problems;
}

if (import.meta.main) {
  const head = currentSnapshot();
  const rendered = `${JSON.stringify(head, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(DESK_API_SNAPSHOT), { recursive: true });
    writeFileSync(DESK_API_SNAPSHOT, rendered);
    process.stdout.write(`wrote ${DESK_API_SNAPSHOT}\n`);
    process.exit(0);
  }
  const problems: string[] = [];
  let committed: string | undefined;
  try {
    committed = readFileSync(DESK_API_SNAPSHOT, "utf8");
  } catch (_err) {
    committed = undefined;
  }
  if (committed !== rendered) problems.push(`${DESK_API_SNAPSHOT} is not in sync with DESK_API_ROUTES, DESK_PHRASE_CODES and the served vocabularies; run bun scripts/check-desk-api.ts --write and commit it.`);

  const baseRef = resolveBaseRef("DESK_API_BASE_REF", "desk api");
  const baseText = gitShow(baseRef, DESK_API_SNAPSHOT);
  if (baseText !== undefined) problems.push(...deskApiVersionProblems(JSON.parse(baseText) as DeskApiSnapshot, head));

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  process.stdout.write("✅ desk api routes, phrase codes and vocabularies match their version.\n");
}
