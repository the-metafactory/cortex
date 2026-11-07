import { randomUUIDv7 } from "bun";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { spawnGit } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";

const Selection = z.object({ thread: z.string(), selected: z.boolean(), reason: z.string(), jobUuid: z.uuid().nullable(), provenanceFailure: z.string().optional(), jobId: z.number().nullable(), created: z.boolean().optional(), enqueue: z.enum(["not-requested", "pending", "confirmed", "uncertain"]) });
export const OverseerRun = z.object({ id: z.uuid(), startedAt: z.string(), endedAt: z.string().nullable(), status: z.enum(["running", "succeeded", "failed"]), failure: z.string().nullable(), schedule: z.object({ mode: z.enum(["watch", "manual"]), intervalMs: z.number().nullable(), pollMs: z.number().nullable(), enabledAtObservation: z.boolean().nullable() }).optional(), staleDays: z.number().optional(), selections: z.array(Selection), proposals: z.array(z.string()) });
export type OverseerRun = z.infer<typeof OverseerRun>;
export const newOverseerRun = (now: Date): OverseerRun => ({ id: randomUUIDv7(), startedAt: now.toISOString(), endedAt: null, status: "running", failure: null, selections: [], proposals: [] });

export async function auditDirectory(dir: string): Promise<string> {
  const result = await spawnGit(["rev-parse", "--path-format=absolute", "--git-path", "studio-overseer-runs"], dir);
  if (result.code !== 0) throw new Error("Studio overseer evidence storage is unavailable");
  return result.stdout.trim();
}

export async function saveOverseerRun(dir: string, run: OverseerRun): Promise<void> {
  const folder = await auditDirectory(dir);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await saveAuditFile(join(folder, `${run.id}.json`), OverseerRun.parse(run));
  for (const selection of run.selections) {
    if (!selection.created || !selection.jobUuid || selection.enqueue !== "confirmed") continue;
    const jobs = join(folder, "jobs");
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    await saveAuditFile(join(jobs, `${selection.jobUuid}.json`), { run: run.id, thread: selection.thread });
  }
}

async function saveAuditFile(path: string, value: object): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function readAuditFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > STUDIO_MAX_FILE_BYTES) throw new Error("Overseer evidence exceeds the read limit or is not a regular file");
    const bytes = Buffer.alloc(STUDIO_MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > STUDIO_MAX_FILE_BYTES) throw new Error("Overseer evidence exceeds the read limit");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export async function readOverseerRun(dir: string, id: string): Promise<OverseerRun> {
  return OverseerRun.parse(await readAuditFile(join(await auditDirectory(dir), `${z.uuid().parse(id)}.json`)));
}

export async function readOverseerOrigin(dir: string, thread: string, job: string): Promise<string | null> {
  const origin = z.object({ run: z.uuid(), thread: z.string() }).parse(await readAuditFile(join(await auditDirectory(dir), "jobs", `${z.uuid().parse(job)}.json`)));
  if (origin.thread !== thread) return null;
  const run = await readOverseerRun(dir, origin.run);
  return run.selections.some(row => row.thread === thread && row.jobUuid === job && row.created && row.enqueue === "confirmed") ? run.id : null;
}

export async function overseerRunIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(await auditDirectory(dir))).filter(name => z.uuid().safeParse(name.replace(/\.json$/, "")).success && name.endsWith(".json")).map(name => name.slice(0, -5)).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
