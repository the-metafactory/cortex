import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { acquireHostLock } from "../conversations/lock";
import type { WriterRecord } from "../conversations/domain-adapters/operations/writer-authority";

const implementation = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const entry = z.object({ stack: z.string().min(1), implementation, epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), instanceId: z.string().min(1), receiptRef: z.string().nullable(), enabled: z.boolean(), retiredEntries: z.array(z.object({ kind: z.string(), label: z.string(), definition: z.string() }).strict()), retiredDigests: z.array(z.string()), minimumVersion: implementation.shape.version }).strict();
export const WriterManifestSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), entries: z.record(z.string(), entry) }).strict();
export type WriterManifest = z.infer<typeof WriterManifestSchema>;
export const executableDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export async function readWriterManifest(root: string): Promise<WriterManifest> { return WriterManifestSchema.parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))); }
export async function durableWriterFile(path: string, content: string, mode: number): Promise<void> {
  const staged = `${path}.${randomUUID()}.tmp`;
  const file = await open(staged, "wx", mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(staged, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
const versionParts = (version: string): number[] => version.split(".").map(Number);
export function writerVersionAtLeast(selected: string, floor: string): boolean {
  const a = versionParts(selected), b = versionParts(floor);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}
export class PersistentWriterManifest {
  constructor(readonly root: string) {}

  async set(record: WriterRecord, enabled: boolean): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = await acquireHostLock({ dir: this.root, stack: "writer-manifest", label: "writer-manifest", expectedLabel: "writer-manifest" });
    if (!lock.held) throw new Error(lock.reason);
    try {
      let manifest: WriterManifest;
      try { manifest = await readWriterManifest(this.root); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        manifest = { version: 1, revision: 0, entries: {} };
      }
      const prior = manifest.entries[record.bindingKey];
      const selected = record.plan.implementation;
      if (prior && (!writerVersionAtLeast(selected.version, prior.minimumVersion) || prior.retiredDigests.includes(selected.sha256) || record.epoch < prior.epoch || record.epoch === prior.epoch && record.instanceId !== prior.instanceId && enabled)) throw new Error("Mutation downgrade or stale epoch refused; reconcile explicitly without lowering the implementation floor.");
      if (enabled && (!record.receipt || !record.watermark || record.stage !== "enable")) throw new Error("Writer activation evidence is incomplete.");
      const retiredDigests = [...new Set([...(prior?.retiredDigests ?? []), ...record.retiredDigests, ...(prior && prior.implementation.sha256 !== selected.sha256 ? [prior.implementation.sha256] : [])])];
      manifest.entries[record.bindingKey] = { stack: record.plan.binding.stack, implementation: selected, minimumVersion: selected.version, retiredEntries: [...(prior?.retiredEntries ?? []), ...record.plan.entries.map(({ kind, label, definition }) => ({ kind, label, definition }))], retiredDigests, epoch: record.epoch, instanceId: record.instanceId, receiptRef: record.receipt?.receiptRef ?? null, enabled };
      manifest.revision++;
      await durableWriterFile(join(this.root, "manifest.json"), JSON.stringify(manifest), 0o600);
    } finally { await lock.release(); }
  }
}
