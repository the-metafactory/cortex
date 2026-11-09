import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { sep } from "node:path";
import { resolveArcPackReposDir } from "../config/arc-pack-repos-dir";
import { errorText } from "../error-text";
import { ArcListOutputSchema, type ArcPackage } from "../types/plugin-manifest";

export interface ArcListRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ArcListRunner = () => Promise<ArcListRunResult>;

export async function defaultArcListRunner(): Promise<ArcListRunResult> {
  const proc = Bun.spawn(["arc", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export function defaultArcPackageRoot(): string {
  return resolveArcPackReposDir();
}

export type InventoryIssueStage = "arc_list" | "arc_list_parse" | "arc_list_schema";

export interface InventoryIssue {
  stage: InventoryIssueStage;
  reason: string;
}

export interface ArcPackageInventory {
  packages: ArcPackage[];
  issues: InventoryIssue[];
}

export async function readArcPackageInventory(runner: ArcListRunner): Promise<ArcPackageInventory> {
  let runResult: ArcListRunResult;
  try {
    runResult = await runner();
  } catch (error) {
    return { packages: [], issues: [{ stage: "arc_list", reason: `arc list --json failed to run: ${errorText(error)}` }] };
  }
  if (runResult.exitCode !== 0) {
    return { packages: [], issues: [{ stage: "arc_list", reason: `arc list --json exited ${runResult.exitCode}: ${runResult.stderr.slice(0, 500)}` }] };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(runResult.stdout);
  } catch (error) {
    return { packages: [], issues: [{ stage: "arc_list_parse", reason: `arc list --json produced invalid JSON: ${errorText(error)}` }] };
  }
  const parsed = ArcListOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      packages: [],
      issues: [{ stage: "arc_list_schema", reason: `arc list --json output did not match the expected {packages:[...]} shape: ${parsed.error.issues.map(issue => issue.message).join("; ")}` }],
    };
  }
  return { packages: [...parsed.data.packages].sort((left, right) => left.name.localeCompare(right.name)), issues: [] };
}

export type ContainmentResult = { ok: true; path: string } | { ok: false; stage: "unreadable" | "escape"; resolved: string; detail: string };

export function containedRealPath(realRoot: string, candidate: string): ContainmentResult {
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    return { ok: false, stage: "unreadable", resolved: candidate, detail: errorText(error) };
  }
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    return { ok: false, stage: "escape", resolved, detail: `resolved path is outside the trusted root "${realRoot}"` };
  }
  return { ok: true, path: resolved };
}

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256FileAsync(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}
